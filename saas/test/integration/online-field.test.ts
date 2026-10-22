// ADEX ONLINE · capa operativa de CLEAN (Cobrador y Supervisor) contra PostgreSQL real:
// visitas sin pago (0015), cuotas en bloque por ruta y páginas por fecha y cursor de
// recaudos y gastos. Verificación independiente con SQL propio.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('ADEX Online · capa operativa', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let r2 = '';
  let adm: Caller;
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, gil: Person, sec: Person;
  let today = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (route: string) => {
    const r = await adm('POST', '/v1/clients', { routeId: route, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const credit = async (route: string, installmentsCount = 10) => {
    const r = await $ana('/v1/credits/direct', { routeId: route, clientId: await newClient(route), amountMinor: 50_000, interestRate: 20,
      installmentsCount, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const visit = (who: Person, body: Body, op = randomUUID()) => who.call('POST', '/v1/no-payment-visits', body, { 'x-adex-operation-id': op });

  before(async () => {
    db = await createTestDb('onlinefield', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-of@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    r2 = (await bruno('POST', '/v1/routes', { name: 'Ruta Gil OF', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    gil = await newPerson(api, issuer, provider.ids, bruno, { email: 'gil-of@example.test', role: 'cobrador', displayName: 'Gil', routeIds: [r2] });
    sec = await newPerson(api, issuer, provider.ids, bruno, { email: 'sec-of@example.test', role: 'secretario', displayName: 'Sara Secretaria', routeIds: [r1] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('OF-001 · visita sin pago del Cobrador: fecha de la empresa, sin dinero, auditada e idempotente', async () => {
    const s = await credit(r1);
    const op = randomUUID();
    const r = await visit(carlos, { saleId: s, reason: 'promesa_pago', promisedPaymentDate: today, note: 'Vuelve mañana' }, op);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body['reason'], r.body['visitDate'], r.body['collectorId'], r.body['routeId'], r.body['promisedPaymentDate']],
      ['promesa_pago', today, carlos.membershipId, r1, today]);
    const again = await visit(carlos, { saleId: s, reason: 'promesa_pago', promisedPaymentDate: today, note: 'Vuelve mañana' }, op);
    assert.equal(again.status, 201);
    assert.equal(again.body['id'], r.body['id'], 'mismo id de operación → misma visita');
    assert.equal(await count(db.admin, 'select 1 from adex.no_payment_visits where sale_id = $1', [s]), 1);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'REGISTER_NO_PAYMENT_VISIT' and entity_id = $1`, [r.body['id']]), 1);
    const list = await carlos.call('GET', `/v1/no-payment-visits?saleId=${s}`);
    assert.deepEqual((list.body['visits'] as Body[]).map((v) => v['id']), [r.body['id']]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN, 'una visita no toca el libro');
  });

  test('OF-002 · visita: motivo inválido, ruta ajena y venta sin desembolsar se rechazan; sin UPDATE ni DELETE', async () => {
    const s = await credit(r1);
    assert.equal((await visit(carlos, { saleId: s, reason: 'inventado' })).status, 400);
    const ajena = await visit(gil, { saleId: s, reason: 'no_estaba' });
    assert.ok([403, 404].includes(ajena.status), `ruta ajena: ${ajena.status}`);
    const req = await carlos.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient(r1), amountMinor: 30_000, interestRate: 20,
      installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] }, { 'x-adex-operation-id': randomUUID() });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    await assert.rejects(db.admin.query(`update adex.no_payment_visits set note = 'x' where company_id = $1`, [c1]));
    await assert.rejects(db.admin.query(`delete from adex.no_payment_visits where company_id = $1`, [c1]));
    // Un Socio (sin `payment.register`) no registra visitas.
    const fabio = caller(api, issuer, 'fabio', M.fabioSec);
    const r = await fabio('POST', '/v1/no-payment-visits', { saleId: s, reason: 'no_estaba' }, { 'x-adex-operation-id': randomUUID() });
    assert.ok([403, 404].includes(r.status), `socio: ${r.status}`);
  });

  test('OF-003 · cuotas en bloque por ruta = cuotas de cada crédito; exige filtro; respeta el alcance', async () => {
    const a = await credit(r1, 5);
    const b = await credit(r1, 7);
    const bulk = await bruno('GET', `/v1/installments?routeId=${r1}`);
    assert.equal(bulk.status, 200);
    const rows = bulk.body['installments'] as Body[];
    for (const id of [a, b]) {
      const one = (await bruno('GET', `/v1/credits/${id}`)).body['installments'] as Body[];
      assert.deepEqual(rows.filter((i) => i['saleId'] === id).map((i) => [i['number'], i['dueDate'], i['amountMinor'], i['balanceMinor'], i['status']]),
        one.map((i) => [i['number'], i['dueDate'], i['amountMinor'], i['balanceMinor'], i['status']]));
    }
    assert.equal((await bruno('GET', '/v1/installments')).status, 400);
    const other = await gil.call('GET', `/v1/installments?routeId=${r1}`);
    assert.ok(other.status === 403 || (other.body['installments'] as Body[]).length === 0, 'un Cobrador de otra ruta no ve sus cuotas');
  });

  test('OF-004 · recaudos por página: cursor sin huecos ni repetidos y filtro por fecha', async () => {
    const s = await credit(r1, 30);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 600 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push((r.body['payment'] as Body)['id'] as string);
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q: string = `/v1/collections?saleId=${s}&limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const page = (await bruno('GET', q)).body['collections'] as Body[];
      seen.push(...page.map((p) => p['id'] as string));
      if (page.length < 3) break;
      const last = page[page.length - 1]!;
      before = `${last['createdAt']}|${last['id']}`;
    }
    assert.equal(seen.length, 7);
    assert.deepEqual([...seen].sort(), [...ids].sort());
    assert.equal(((await bruno('GET', `/v1/collections?saleId=${s}&from=${today}&to=${today}`)).body['collections'] as Body[]).length, 7);
    assert.equal(((await bruno('GET', `/v1/collections?saleId=${s}&to=2000-01-01`)).body['collections'] as Body[]).length, 0);
    assert.equal((await bruno('GET', `/v1/collections?before=nope`)).status, 400);
    assert.equal(((await bruno('GET', `/v1/expenses?from=${today}`)).status), 200);
  });

  const payState = async (id: string) => (await db.admin.query('select state, amount_minor::int amt, payment_date::text d, corrected_by_payment_id cb, correction_of_payment_id co, collector_membership_id c from adex.payments where id = $1', [id])).rows[0];
  const custodyOf = async (m: string) => Number((await db.admin.query(`select coalesce(sum(balance_minor), 0)::bigint b from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3`, [c1, m, r1])).rows[0].b);

  test('OF-005 · corrección (Secretaria, periodo abierto): reversión + reemplazo atómicos, mismo responsable, custodia por la diferencia, auditada', async () => {
    const s = await credit(r1, 20);
    const pay = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
    assert.equal(pay.status, 201);
    const pid = (pay.body['payment'] as Body)['id'] as string;
    const c0 = await custodyOf(carlos.membershipId);
    // Sin `payment.reverse` ni `payment.register`, la Secretaria NO anula por la vía directa…
    assert.equal((await sec.money(`/v1/collections/${pid}/reverse`, { reason: 'Intento directo' })).status, 403);
    // …pero SÍ corrige (`payment.correct`): un solo comando.
    const op = randomUUID();
    const r = await sec.money(`/v1/collections/${pid}/correct`, { newAmountMinor: 4_000, reason: 'Valor mal digitado' }, op);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await sec.money(`/v1/collections/${pid}/correct`, { newAmountMinor: 4_000, reason: 'Valor mal digitado' }, op);
    assert.equal(again.body['correctedPaymentId'], r.body['correctedPaymentId'], 'mismo id → misma corrección');
    const orig = await payState(pid);
    const fixed = await payState(r.body['correctedPaymentId'] as string);
    assert.deepEqual([orig.state, orig.cb], ['reversed', r.body['correctedPaymentId']]);
    assert.deepEqual([fixed.state ?? 'active', fixed.amt, fixed.co, fixed.c], ['active', 4_000, pid, carlos.membershipId]);
    assert.equal(await custodyOf(carlos.membershipId), c0 - 1_000, 'la custodia del Cobrador baja solo la diferencia');
    assert.equal(await count(db.admin, `select 1 from adex.payments where sale_id = $1`, [s]), 3, 'original, reversión y reemplazo');
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'CORRECT_PAYMENT' and entity_id = $1`, [pid]), 1);
    assert.equal((await sec.money(`/v1/collections/${pid}/correct`, { newAmountMinor: 3_000, reason: 'Otra vez' })).body['error'], 'ALREADY_REVERSED');
    assert.equal((await sec.money(`/v1/collections/${r.body['correctedPaymentId']}/correct`, { newAmountMinor: 0, reason: 'Cero' })).status, 400);
    assert.ok([403, 404].includes((await gil.money(`/v1/collections/${r.body['correctedPaymentId']}/correct`, { newAmountMinor: 3_000, reason: 'Ruta ajena' })).status));
    assert.equal(await count(db.admin, 'select 1 from adex.correction_steps'), 0, 'el permiso de un solo uso no sobrevive a la transacción');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OF-006 · periodo cerrado: la Secretaria pide ajuste (una pendiente por pago); el Administrador aprueba (corrige) o rechaza', async () => {
    const s = await credit(r1, 20);
    const pids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const pay = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
      assert.equal(pay.status, 201);
      pids.push((pay.body['payment'] as Body)['id'] as string);
    }
    // Fixture: esos cobros ocurrieron el 1 de octubre y esa semana está cerrada (como F6-H).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role adex_owner');
      for (const t of ['capital_operations', 'payments']) await c.query(`alter table adex.${t} disable trigger user`);
      await c.query(`update adex.payments set payment_date = '2026-10-01' where id = any($1)`, [pids]);
      await c.query(`update adex.capital_operations set entry_date = '2026-10-01' where payment_id = any($1)`, [pids]);
      for (const t of ['capital_operations', 'payments']) await c.query(`alter table adex.${t} enable trigger user`);
      await c.query('commit');
    } finally { c.release(); }
    const close = await $ana('/v1/periods/close', { routeId: r1, weekStart: '2026-09-28', weekEnd: '2026-10-03' });
    assert.equal(close.status, 201, JSON.stringify(close.body));
    // Corrección directa de la Secretaria: no en periodo cerrado.
    assert.equal((await sec.money(`/v1/collections/${pids[0]}/correct`, { newAmountMinor: 4_500, reason: 'Valor mal digitado' })).body['error'], 'ADJUSTMENT_REQUIRED');
    const req = await sec.money('/v1/payment-adjustments', { paymentId: pids[0], newAmountMinor: 4_500, reason: 'Valor mal digitado' });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.deepEqual([req.body['status'], req.body['originalAmountMinor'], req.body['originalDate']], ['pending', 5_000, '2026-10-01']);
    assert.equal((await sec.money('/v1/payment-adjustments', { paymentId: pids[0], newAmountMinor: 4_000, reason: 'Duplicada' })).status, 409, 'una pendiente por pago');
    // La Secretaria no aprueba.
    assert.equal((await sec.money(`/v1/payment-adjustments/${req.body['id']}/approve`, {})).status, 403);
    const ana = caller(api, issuer, 'ana', M.anaAdmin);
    const list = (await ana('GET', '/v1/payment-adjustments?status=pending')).body['adjustments'] as Body[];
    assert.ok(list.some((a) => a['id'] === req.body['id']));
    const ap = await $ana(`/v1/payment-adjustments/${req.body['id']}/approve`, {});
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const done = ap.body['request'] as Body;
    assert.deepEqual([done['status'], done['reviewedBy'], typeof done['resultingPaymentId']], ['approved', M.anaAdmin, 'string']);
    const rev = await payState((ap.body['correction'] as Body)['reversalPaymentId'] as string);
    assert.equal(rev.d, today, 'semana cerrada: la reversión va a hoy (D7)');
    assert.equal((await $ana(`/v1/payment-adjustments/${req.body['id']}/approve`, {})).body['error'], 'REQUEST_STATE_INVALID');
    // Rechazo: el pago no cambia.
    const req2 = await sec.money('/v1/payment-adjustments', { paymentId: pids[1], newAmountMinor: 1_000, reason: 'Revisar' });
    assert.equal(req2.status, 201);
    assert.equal((await ana('POST', `/v1/payment-adjustments/${req2.body['id']}/reject`, { reason: 'no' })).status, 400, 'motivo mínimo');
    const rj = await ana('POST', `/v1/payment-adjustments/${req2.body['id']}/reject`, { reason: 'El cobro era correcto' });
    assert.equal(rj.status, 200, JSON.stringify(rj.body));
    assert.equal(rj.body['status'], 'rejected');
    assert.equal((await payState(pids[1])).state ?? 'active', 'active');
    await assert.rejects(db.admin.query(`update adex.payment_adjustment_requests set new_amount_minor = 1 where id = $1`, [req2.body['id']]));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
