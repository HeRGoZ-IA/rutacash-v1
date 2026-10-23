// Intervención post-R73 · bloque A contra PostgreSQL real y la API (datos 100 % sintéticos).
//   · A1: venta cuyos pagos se anularon todos → se corrige; los pagos de referencia se REAPLICAN
//     (mismo efectivo, misma cuenta, misma fecha) sin duplicar nada (reproducción sintética del
//     caso de pruebas «Undel»: R$ 600 al 20 % en 10 parcelas, abonos de R$ 60 y R$ 132; tasa
//     correcta 10 %). El caso real de BlueLine NO se toca.
//   · A2: venta con pagos vigentes → se corrige conservando los pagos; la diferencia de
//     imputación capital/interés es una reclasificación sin efectivo; el siguiente recaudo imputa
//     sobre lo ajustado.
//   · Bloqueos: sobrepago, ajuste de pago pendiente, periodo cerrado, cuadre (solo si cambia el
//     capital), custodio cambiado, reaplicación tras un cuadre, roles.
//   · Reintentos, concurrencia, conciliación del SuperAdmin (incluida la nueva de interés) y SQL propio.
//
// Importes en unidades menores (BRL): R$ 600 = 60_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Bloque A post-R73 · rectificación de ventas con pagos registrados (0032)', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let ana: Caller, $ana: Money, gabi: Caller, bruno: Caller, $bruno: Money;
  let today = '';
  let n = 0;

  const custody = (m: string) => balance(db.admin, c1, 'custody', m, r1);
  const portfolio = () => balance(db.admin, c1, 'portfolio', null, r1);
  const income = () => balance(db.admin, c1, 'income', null, r1);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (name: string) => {
    const r = await ana('POST', '/v1/clients', { routeId: r1, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  // Caso de referencia: R$ 600, 20 %, 10 parcelas diarias.
  const cond = (o: Body = {}) => ({ amountMinor: 60_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
  const worker = async () => {
    n += 1;
    return newPerson(api, issuer, provider.ids, bruno, { email: `r74-w${n}@example.test`, role: 'cobrador', displayName: `COBRADOR ${n}`, routeIds: [r1] });
  };
  const fund = async (w: Person, amountMinor: number) =>
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: w.membershipId, amountMinor, reason: 'Base sintética' })).status, 201);
  const sale = async (w: Person, o: Body = {}) => {
    const req = await w.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient(`UNDEL SINTÉTICO ${randomUUID().slice(0, 4)}`), ...cond(o) });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    const d = await w.money(`/v1/credit-requests/${req.body['id']}/disburse`, {});
    assert.equal(d.status, 201, JSON.stringify(d.body));
    return (d.body['credit'] as Body)['id'] as string;
  };
  const collect = async (w: Person, saleId: string, amountMinor: number) => {
    const r = await w.money('/v1/collections', { saleId, amountMinor });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['payment'] as Body)['id'] as string;
  };
  const reverse = async (paymentId: string) => {
    const r = await $ana(`/v1/collections/${paymentId}/reverse`, { reason: 'Condiciones mal registradas' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const rectify = (saleId: string, o: Body, op?: string) => $ana(`/v1/credits/${saleId}/rectify`, {
    ...cond(), expectedRectifications: 0, reason: 'La tasa correcta de la operación es 10 %', evidence: 'Registro de referencia del sistema anterior', offlineChecked: true, ...o,
  }, op);
  const check = async (saleId: string) => {
    const r = await ana('GET', `/v1/credits/${saleId}/rectification-check`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const saleRow = async (id: string) => (await db.admin.query<{ total: number; balance: number; status: string; reclass: number; value: number }>(
    `select total_value_minor::int total, balance_minor::int balance, status, principal_reclassified_minor::int reclass, sale_value_minor::int value
       from adex.sales where id = $1`, [id])).rows[0]!;
  const installments = async (id: string) => (await db.admin.query<{ number: number; amount: number; paid: number; status: string }>(
    `select number, amount_minor::int amount, paid_minor::int paid, status from adex.installments where sale_id = $1 order by number`, [id])).rows;
  const paymentsOf = async (id: string) => (await db.admin.query(
    `select id, amount_minor::int amount, state, payment_date::text d, principal_minor::int pr, interest_minor::int it, ledger_operation_id, reapplies_payment_id
       from adex.payments where sale_id = $1 order by created_at, id`, [id])).rows;
  const opsOf = async (id: string, kind: string) => (await db.admin.query<{ id: string; amount: number; entry_date: string }>(
    `select id, amount_minor::int amount, entry_date::text from adex.capital_operations where sale_id = $1 and kind = $2 order by created_at`, [id, kind])).rows;
  const legsOf = async (opId: string) => (await db.admin.query<{ kind: string; amount: number }>(
    `select a.kind, e.amount_minor::int amount from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.operation_id = $1 order by e.leg`, [opId])).rows;
  const ledgerChecks = async () => {
    const r = await bruno('GET', '/v1/capital/reconciliation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = (r.body['checks'] as Body[]).filter((c) => !c['ok']);
    assert.deepEqual(failed, [], 'conciliación del SuperAdmin sin fallos');
    assert.ok((r.body['checks'] as Body[]).some((c) => c['name'] === 'income-matches-interest'), 'incluye la comprobación nueva de interés');
  };
  /** Conciliación independiente por SQL del crédito: cuotas, saldo e imputación acumulada. */
  const independent = async (id: string) => {
    const r = (await db.admin.query(
      `select s.total_value_minor::bigint t, s.balance_minor::bigint b, s.sale_value_minor::bigint v, s.principal_reclassified_minor::bigint rc,
              (select coalesce(sum(amount_minor), 0) from adex.payments where sale_id = s.id)::bigint paid,
              (select coalesce(sum(principal_minor), 0) from adex.payments where sale_id = s.id)::bigint pr,
              (select coalesce(sum(balance_minor), 0) from adex.installments where sale_id = s.id)::bigint ib,
              (select coalesce(sum(amount_minor), 0) from adex.installments where sale_id = s.id and status <> 'sustituida')::bigint ia
         from adex.sales s where s.id = $1`, [id])).rows[0];
    const t = Number(r.t), paid = Number(r.paid);
    assert.equal(Number(r.ia), t, 'Σ cuotas vigentes = total');
    assert.equal(Number(r.b), t - paid, 'saldo = total − pagado neto');
    assert.equal(Number(r.ib), Number(r.b), 'Σ saldos de cuotas = saldo');
    assert.equal(Number(r.pr) + Number(r.rc), Math.round((paid * Number(r.v)) / t), 'capital reconocido = round(pagado × capital / total)');
  };

  before(async () => {
    db = await createTestDb('r74rect', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api?.close(); await db?.close(); });

  // ---------------- A1 ----------------

  test('R74-A1-001 · caso de referencia: pagos anulados → corrección 20 % → 10 % → reaplicación de los abonos sin duplicar', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    assert.deepEqual([(await saleRow(id)).total, (await installments(id))[0]!.amount], [72_000, 7_200], 'R$ 600 al 20 %: total R$ 720, parcela R$ 72');
    const p60 = await collect(w, id, 6_000);
    const p132 = await collect(w, id, 13_200);
    const custodyWithPayments = await custody(w.membershipId);
    await reverse(p60); await reverse(p132);
    assert.equal(await custody(w.membershipId), custodyWithPayments - 19_200, 'la anulación retiró el efectivo de la custodia');

    const chk = await check(id);
    assert.deepEqual(chk['blockers'], [], JSON.stringify(chk));
    assert.deepEqual([(chk['payments'] as Body)['active'], (chk['payments'] as Body)['reversed'], (chk['payments'] as Body)['netPaidMinor']], [0, 2, 0],
      'el diálogo ve dos pagos anulados y pagado neto 0');

    const portfolioBefore = await portfolio(); const incomeBefore = await income();
    const r = await rectify(id, { interestRate: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rect = r.body['rectification'] as Body;
    assert.deepEqual([rect['deltaMinor'], rect['netPaidMinor'], rect['principalReclassMinor'], rect['reclassOperationId']], [0, 0, 0, null], 'sin dinero ni reclasificación');
    assert.deepEqual([(await saleRow(id)).total, (await saleRow(id)).balance], [66_000, 66_000], 'R$ 660 al 10 %');
    assert.ok((await installments(id)).every((i) => i.amount === 6_600), 'parcela R$ 66');
    assert.deepEqual([await portfolio(), await income()], [portfolioBefore, incomeBefore], 'cartera e interés intactos');
    assert.equal((await paymentsOf(id)).length, 4, 'originales y anulaciones se conservan');

    // Reaplicación de los dos abonos de referencia: mismo efectivo, misma custodia, misma fecha.
    for (const p of [p60, p132]) {
      const c = await ana('GET', `/v1/collections/${p}/reapply-check`);
      assert.deepEqual([c.status, c.body['blockers']], [200, []], JSON.stringify(c.body));
      const ra = await $ana(`/v1/collections/${p}/reapply`, { reason: 'Abono real del cliente anulado para corregir la tasa' });
      assert.equal(ra.status, 201, JSON.stringify(ra.body));
      assert.equal((ra.body['payment'] as Body)['reappliesPaymentId'], p);
      assert.equal((ra.body['payment'] as Body)['paymentDate'], today, 'fecha del abono original');
    }
    assert.equal(await custody(w.membershipId), custodyWithPayments, 'la custodia vuelve a tener exactamente el efectivo cobrado');
    const s = await saleRow(id);
    assert.deepEqual([s.total, s.balance], [66_000, 46_800], 'pagado R$ 192 sobre R$ 660');
    assert.deepEqual((await installments(id)).slice(0, 3).map((i) => [i.paid, i.status]), [[6_600, 'pagada'], [6_600, 'pagada'], [6_000, 'parcial']]);
    const again = await $ana(`/v1/collections/${p60}/reapply`, { reason: 'Segundo intento de reaplicar el mismo abono' });
    assert.equal(again.body['error'], 'PAYMENT_NOT_REAPPLICABLE', 'un pago anulado se reaplica una sola vez');
    await independent(id);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  // ---------------- A2 ----------------

  test('R74-A2-001 · pagos vigentes, 20 % → 10 %: pagos intactos, reclasificación sin efectivo y siguiente recaudo sobre lo ajustado', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 6_000); await collect(w, id, 13_200);
    const paymentsBefore = JSON.stringify(await paymentsOf(id));
    const cust = await custody(w.membershipId); const port = await portfolio(); const inc = await income();
    const chk = await check(id);
    assert.deepEqual([chk['blockers'], (chk['payments'] as Body)['active'], (chk['payments'] as Body)['principalRecognizedMinor'], chk['minTotalMinor']],
      [[], 2, 16_000, 19_200], 'capital reconocido al 20 %: 19.200 × 600/720 = 16.000');
    const r = await rectify(id, { interestRate: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rect = r.body['rectification'] as Body;
    // round(19.200 × 600/660) = 17.455 → reclasifica 1.455 de interés a capital.
    assert.deepEqual([rect['deltaMinor'], rect['netPaidMinor'], rect['principalReclassMinor']], [0, 19_200, 1_455]);
    assert.equal(JSON.stringify(await paymentsOf(id)), paymentsBefore, 'cada pago (importe, fecha, imputación original) se conserva');
    const [op] = await opsOf(id, 'PRINCIPAL_RECLASSIFICATION');
    assert.deepEqual([op!.amount, op!.entry_date], [1_455, today], 'operación de hoy');
    assert.deepEqual(await legsOf(op!.id), [{ kind: 'portfolio', amount: -1_455 }, { kind: 'income', amount: 1_455 }], 'solo cartera e interés');
    assert.equal(await custody(w.membershipId), cust, 'ninguna cuenta de efectivo cambia');
    assert.deepEqual([await portfolio(), await income()], [port - 1_455, inc + 1_455]);
    const s = await saleRow(id);
    assert.deepEqual([s.total, s.balance, s.reclass], [66_000, 46_800, 1_455]);
    // Siguiente recaudo: imputación sobre lo ajustado (round(25.800 × 600/660) − 17.455 = 6.000).
    const p3 = await collect(w, id, 6_600);
    const p3row = (await paymentsOf(id)).find((p) => p.id === p3)!;
    assert.deepEqual([p3row.pr, p3row.it], [6_000, 600], 'sin doble reconocimiento de capital');
    // Las cifras del periodo: capital cobrado + interés cobrado = recaudos.
    const fig = (await db.admin.query(`select adex.route_period_figures($1, $2, $3::date, $3::date) f`, [c1, r1, today])).rows[0].f;
    assert.equal(fig.credit.principalCollectedMinor + fig.credit.interestCollectedMinor,
      Number((await db.admin.query(`select coalesce(sum(amount_minor), 0) s from adex.capital_operations where company_id = $1 and route_id = $2
             and entry_date = $3 and coalesce(reverses_kind, kind) = 'COLLECTION' and kind = 'COLLECTION'`, [c1, r1, today])).rows[0].s)
      - Number((await db.admin.query(`select coalesce(sum(amount_minor), 0) s from adex.capital_operations where company_id = $1 and route_id = $2
             and entry_date = $3 and kind = 'REVERSAL' and reverses_kind = 'COLLECTION'`, [c1, r1, today])).rows[0].s));
    assert.ok(fig.credit.principalReclassifiedMinor >= 1_455, 'la reclasificación se informa aparte');
    // Anular un pago ANTERIOR a la rectificación también queda conciliado.
    await reverse((await paymentsOf(id))[0]!.id as string);
    await independent(id);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R74-A2-002 · cambios de parcelas con pagos: reducir (sustituidas sin pagos) y aumentar, con el pagado neto en cascada', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 10_000);
    let r = await rectify(id, { installmentsCount: 6 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let inst = await installments(id);
    assert.deepEqual(inst.filter((i) => i.status === 'sustituida').map((i) => [i.number, i.paid]), [[7, 0], [8, 0], [9, 0], [10, 0]]);
    assert.deepEqual(inst.slice(0, 2).map((i) => [i.amount, i.paid, i.status]), [[12_000, 10_000, 'parcial'], [12_000, 0, 'pendiente']]);
    assert.equal((r.body['rectification'] as Body)['principalReclassMinor'], 0, 'misma tasa: misma imputación');
    r = await rectify(id, { installmentsCount: 12, expectedRectifications: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    inst = await installments(id);
    assert.equal(inst.length, 12, 'se reactivan las mismas filas y se añaden las nuevas');
    assert.equal(inst[0]!.paid, 6_000);
    assert.equal(inst[1]!.paid, 4_000);
    await independent(id);
    await ledgerChecks();
  });

  test('R74-A2-003 · cambio de capital con pagos: ajuste del desembolso (SOC-09) + reclasificación, todo conciliado', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 12_000);
    const cust = await custody(w.membershipId);
    const r = await rectify(id, { amountMinor: 50_000, interestRate: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rect = r.body['rectification'] as Body;
    // Antes: 12.000 × 600/720 = 10.000. Después: round(12.000 × 500/550) = 10.909 → +909.
    assert.deepEqual([rect['deltaMinor'], rect['principalReclassMinor']], [-10_000, 909]);
    assert.equal(await custody(w.membershipId), cust + 10_000, 'el efectivo que nunca salió vuelve a la custodia que pagó');
    assert.deepEqual([(await saleRow(id)).total, (await saleRow(id)).balance], [55_000, 43_000]);
    await independent(id);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  // ---------------- Bloqueos ----------------

  test('R74-A-BLK-001 · sobrepago: el total corregido no baja de lo ya pagado (sin efecto)', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 50_000);
    const before = JSON.stringify([await saleRow(id), await installments(id), await paymentsOf(id)]);
    const r = await rectify(id, { amountMinor: 40_000, interestRate: 10 });
    assert.deepEqual([r.status, r.body['error']], [409, 'OVERPAYMENT']);
    assert.equal(JSON.stringify([await saleRow(id), await installments(id), await paymentsOf(id)]), before);
    assert.equal((await check(id))['minTotalMinor'], 50_000);
  });

  test('R74-A-BLK-002 · desembolso en un cuadre: la tasa se corrige (sin efectivo); el capital, no', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 7_200);
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${w.membershipId}`)).body;
    assert.equal((await $ana('/v1/settlements', { routeId: r1, workerId: w.membershipId, deliveredMinor: p['expectedPositionMinor'],
      expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null })).status, 201);
    const chk = await check(id);
    assert.deepEqual([chk['blockers'], chk['capitalBlockers'], chk['maxIncreaseMinor']], [[], ['DISBURSEMENT_SETTLED'], 0]);
    assert.equal((await rectify(id, { amountMinor: 55_000 })).body['error'], 'DISBURSEMENT_SETTLED');
    const ok = await rectify(id, { interestRate: 10 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await independent(id);
    await ledgerChecks();
  });

  test('R74-A-BLK-003 · periodo cerrado y ajuste de pago pendiente: bloqueados y explicados', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    const p1 = await collect(w, id, 5_000);
    const pay = (await db.admin.query('select * from adex.payments where id = $1', [p1])).rows[0];
    await db.admin.query(
      `insert into adex.payment_adjustment_requests (id, company_id, route_id, payment_id, client_id, sale_id, requested_by_membership_id, requested_by_role,
         requested_at, original_amount_minor, original_date, reason, new_amount_minor, new_date, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'secretario', now(), 5000, $8, 'Ajuste sintético', 4000, $8, 'pending')`,
      [randomUUID(), c1, r1, p1, pay.client_id, id, M.gabiSec, today]);
    assert.ok(((await check(id))['blockers'] as string[]).includes('PAYMENT_ADJUSTMENT_PENDING'));
    assert.equal((await rectify(id, { interestRate: 10 })).body['error'], 'PAYMENT_ADJUSTMENT_PENDING');

    const w2 = await worker(); await fund(w2, 100_000);
    const id2 = await sale(w2);
    const wk = randomUUID();
    await db.admin.query(
      `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
       values ($1, $2, $3, $4::date, $4::date, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [wk, c1, r1, today]);
    try {
      assert.ok(((await check(id2))['blockers'] as string[]).includes('PERIOD_CLOSED'));
      assert.equal((await rectify(id2, { interestRate: 10 })).body['error'], 'PERIOD_CLOSED');
    } finally {
      // Un cierre nunca se borra: se reabre (transición permitida por guard_closure).
      await db.admin.query(`update adex.weekly_settlements set status = 'reabierta', reopened_at = now(), reopen_reason = 'Fin de la prueba sintética' where id = $1`, [wk]);
    }
  });

  test('R74-A-BLK-004 · reaplicación: bloqueada si la anulación ya entró en un cuadre, si el pago fue corregido y por rol', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    const p1 = await collect(w, id, 5_000);
    await reverse(p1);
    const p = (await ana('GET', `/v1/settlements/preview?routeId=${r1}&workerId=${w.membershipId}`)).body;
    assert.equal((await $ana('/v1/settlements', { routeId: r1, workerId: w.membershipId, deliveredMinor: p['expectedPositionMinor'],
      expectedSeenMinor: p['expectedPositionMinor'], previousSettlementId: p['previousSettlementId'] ?? null })).status, 201);
    assert.deepEqual((await ana('GET', `/v1/collections/${p1}/reapply-check`)).body['blockers'], ['REVERSAL_SETTLED']);
    assert.equal((await $ana(`/v1/collections/${p1}/reapply`, { reason: 'Intento tras el cuadre del cobrador' })).body['error'], 'REVERSAL_SETTLED');

    const p2 = await collect(w, id, 3_000);
    const corr = await $ana(`/v1/collections/${p2}/correct`, { newAmountMinor: 2_000, reason: 'Importe digitado mal' });
    assert.equal(corr.status, 201, JSON.stringify(corr.body));
    assert.equal((await $ana(`/v1/collections/${p2}/reapply`, { reason: 'Reaplicar un pago ya corregido' })).body['error'], 'PAYMENT_NOT_REAPPLICABLE');

    const p3 = await collect(w, id, 1_000);
    await reverse(p3);
    assert.equal((await money(bruno)(`/v1/collections/${p3}/reapply`, { reason: 'El SuperAdmin no mueve dinero' })).status, 403);
    assert.equal((await w.money(`/v1/collections/${p3}/reapply`, { reason: 'El cobrador no reaplica anulaciones' })).status, 403);
    assert.equal((await $ana(`/v1/collections/${p3}/reapply`, { reason: 'corta' })).status, 400, 'motivo de al menos 10 caracteres');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R74-A-BLK-005 · custodio cambiado: la tasa se corrige; el capital y la reaplicación hacia esa custodia, no', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    const p1 = await collect(w, id, 4_000);
    await reverse(p1);
    await db.admin.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [w.membershipId, r1]);
    const chk = await check(id);
    assert.deepEqual(chk['capitalBlockers'], ['CUSTODIAN_CHANGED']);
    assert.ok(((await ana('GET', `/v1/collections/${p1}/reapply-check`)).body['blockers'] as string[]).includes('CUSTODIAN_CHANGED'));
    assert.equal((await rectify(id, { amountMinor: 50_000 })).body['error'], 'CUSTODIAN_CHANGED');
    assert.equal((await rectify(id, { interestRate: 10 })).status, 200);
  });

  // ---------------- Reintentos y concurrencia ----------------

  test('R74-A-CON-001 · reintentos idempotentes y concurrencia (rectificación ∥ recaudo, rectificación ∥ rectificación)', async () => {
    const w = await worker(); await fund(w, 200_000);
    const id = await sale(w);
    await collect(w, id, 7_200);
    const op = randomUUID();
    const a = await rectify(id, { interestRate: 10 }, op);
    const b = await rectify(id, { interestRate: 10 }, op);
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body, 'el reintento devuelve la misma respuesta');
    assert.equal((await opsOf(id, 'PRINCIPAL_RECLASSIFICATION')).length, 1, 'una sola reclasificación');

    const both = await Promise.all([rectify(id, { interestRate: 20, expectedRectifications: 1 }), rectify(id, { installmentsCount: 8, expectedRectifications: 1 })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], 'una gana; la otra debe recargar');

    const id2 = await sale(w);
    await collect(w, id2, 7_200);
    const mixed = await Promise.all([rectify(id2, { interestRate: 10 }), w.money('/v1/collections', { saleId: id2, amountMinor: 6_600 })]);
    assert.ok(mixed.every((x) => x.status === 200 || x.status === 201), JSON.stringify(mixed.map((x) => x.body)));
    await independent(id); await independent(id2);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    await ledgerChecks();
  });

  test('R74-A-SEC-001 · solo el Administrador; la reclasificación no se anula por la vía genérica', async () => {
    const w = await worker(); await fund(w, 100_000);
    const id = await sale(w);
    await collect(w, id, 7_200);
    assert.equal((await gabi('GET', `/v1/credits/${id}/rectification-check`)).status, 403);
    assert.equal((await money(bruno)(`/v1/credits/${id}/rectify`, { ...cond({ interestRate: 10 }), expectedRectifications: 0, reason: 'SuperAdmin no corrige', evidence: 'Sin autoridad financiera', offlineChecked: true })).status, 403);
    const r = await rectify(id, { interestRate: 10 });
    const rop = (r.body['rectification'] as Body)['reclassOperationId'] as string;
    assert.equal((await $ana(`/v1/capital/operations/${rop}/reverse`, { reason: 'Intento de anulación' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    const hist = (await ana('GET', `/v1/credits/${id}/rectifications`)).body['rectifications'] as Body[];
    assert.deepEqual([hist.length, hist[0]!['netPaidMinor'], hist[0]!['principalReclassMinor']], [1, 7_200, 545]);
  });
});
