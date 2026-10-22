// FASE 5 · recaudos contra PostgreSQL real y la API. Reglas de CLEAN: solo efectivo,
// crédito activo y desembolsado, tope al saldo, cascada por cuota, quien tiene caja
// personal responde por lo que registra, el cobro no personal va a la bolsa del
// responsable (C1); anulación con asiento espejo solo si el receptor aún tiene el dinero;
// lo cerrado no cambia (D7). Verificación independiente con SQL propio.
//
// Importes en unidades menores (BRL): R$ 500 = 50_000.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { calculateCurrentInstallment, recalculateSaleFromPayments } from '@/services/installmentEngine';
import type { Installment, Payment } from '@/models/types';
import { companyId, identityOf, membershipId } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Fase 5 · recaudos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let adm: Caller;
  let bruno: Caller, ana: Caller, gabi: Caller, fabio: Caller;
  let $bruno: Money, $ana: Money, $anaCob: Money;
  let carlos: Person, dora: Person, xavier: Person, gil: Person;
  let rNo = '';   // ruta sin Cobrador: el cobro del Administrador va a su bolsa (C1)
  let rD7 = '';   // ruta aislada para los cierres (D7)
  let rAna = '';  // ruta de Ana cobradora (la misma persona que Ana administradora)
  let today = '';

  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const custody = (m: string, r = r1) => balance(db.admin, c1, 'custody', m, r);
  const portfolio = (r = r1) => balance(db.admin, c1, 'portfolio', null, r);
  const income = (r = r1) => balance(db.admin, c1, 'income', null, r);
  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const newClient = async (route: string, name: string) => {
    const r = await adm('POST', '/v1/clients', { routeId: route, name, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  /** Venta directa del Administrador responsable (sale de su bolsa): el crédito a cobrar. */
  const credit = async (route: string, amountMinor = 50_000, installmentsCount = 12, o: Body = {}) => {
    const r = await $ana('/v1/credits/direct', { routeId: route, clientId: await newClient(route, `Cliente ${randomUUID().slice(0, 6)}`), amountMinor, interestRate: 20,
      installmentsCount, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6], ...o });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const collect = (m: Money, saleId: string, amountMinor: number, extra: Body = {}, op?: string) => m('/v1/collections', { saleId, amountMinor, ...extra }, op);
  const sale = async (id: string) => (await db.admin.query('select status, balance_minor::int bal, finished_on::text fin from adex.sales where id = $1', [id])).rows[0];
  const insts = async (id: string) => (await db.admin.query('select number, amount_minor::int amt, paid_minor::int paid, balance_minor::int bal, status from adex.installments where sale_id = $1 order by number', [id])).rows;

  before(async () => {
    db = await createTestDb('collections', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    $anaCob = money(caller(api, issuer, 'ana', M.anaCob));
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    fabio = caller(api, issuer, 'fabio', M.fabioSec);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-col@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-col@example.test', 'supervisor', 'Dora', [r1]);
    xavier = await mk('xavier-col@example.test', 'admin', 'Xavier', [r1]);
    rNo = (await bruno('POST', '/v1/routes', { name: 'Ruta Sin Cobrador', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    rD7 = (await bruno('POST', '/v1/routes', { name: 'Ruta Cierres', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    const r2 = (await bruno('POST', '/v1/routes', { name: 'Ruta Gil', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    gil = await mk('gil-col@example.test', 'cobrador', 'Gil', [r2]);
    rAna = (await bruno('POST', '/v1/routes', { name: 'Ruta Ana', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    if ((await bruno('PUT', `/v1/members/${M.anaCob}/routes`, { routeIds: [rAna] })).status !== 200) throw new Error('rutas de Ana cobradora');
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('COL-001 · recaudo normal del Cobrador: cuota pagada, deuda baja, efectivo a SU custodia, capital e interés separados', async () => {
    const s = await credit(r1);
    const poolBefore = await pool(M.anaAdmin);
    const r = await collect(carlos.money, s, 5_000);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body['appliedMinor'], r.body['capped'], r.body['previousBalanceMinor'], r.body['newBalanceMinor'], r.body['collectorId'], r.body['receiver']],
      [5_000, false, 60_000, 55_000, carlos.membershipId, 'custody']);
    const pay = r.body['payment'] as Body;
    assert.deepEqual([pay['amountMinor'], pay['paymentType'], pay['state'], pay['paymentDate'], pay['principalMinor'], pay['interestMinor']],
      [5_000, 'efectivo', 'active', today, 4_167, 833]);
    assert.deepEqual((r.body['installments'] as Body[]).slice(0, 2).map((i) => [i['status'], i['balanceMinor']]), [['pagada', 0], ['pendiente', 5_000]]);
    assert.deepEqual((r.body['entries'] as Body[]).map((e) => (e['account'] as Body)['kind']), ['custody'], 'el Cobrador no ve cartera ni interés');
    assert.equal(await custody(carlos.membershipId), 5_000);
    assert.equal(await pool(M.anaAdmin), poolBefore, 'un cobro recibido por un trabajador NO sube la bolsa');
    assert.equal(await portfolio(), 50_000 - 4_167);
    assert.equal(await income(), -833);
    assert.deepEqual(await sale(s), { status: 'activa', bal: 55_000, fin: null });
    const audit = await db.admin.query(`select actor_role, metadata->>'collectorSource' src from adex.audit_log where action = 'REGISTER_PAYMENT' and entity_id = $1 and txid is not null`, [pay['id']]);
    assert.deepEqual(audit.rows, [{ actor_role: 'cobrador', src: 'actor' }]);
    assert.equal(await count(db.admin, `select 1 from adex.operations where operation_id = $1 and outcome = 'approved'`, [r.operationId]), 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('COL-002 · recaudo parcial: la cuota queda parcial y se completa con el siguiente abono', async () => {
    const s = await credit(r1);
    assert.equal((await collect(carlos.money, s, 5_000)).status, 201);
    const half = await collect(carlos.money, s, 2_500);
    assert.equal(half.status, 201);
    assert.deepEqual((half.body['payment'] as Body)['principalMinor'], 2_083);
    assert.deepEqual((await insts(s)).slice(0, 3).map((i) => [i.status, i.paid, i.bal]), [['pagada', 5_000, 0], ['parcial', 2_500, 2_500], ['pendiente', 0, 5_000]]);
    assert.equal((await collect(carlos.money, s, 2_500)).status, 201);
    assert.deepEqual((await insts(s)).slice(0, 3).map((i) => i.status), ['pagada', 'pagada', 'pendiente']);
    assert.equal((await sale(s)).bal, 50_000);
  });

  test('COL-003 · recaudo total: crédito finalizado con fecha sellada; cartera del crédito en 0 e interés completo', async () => {
    const s = await credit(r1);
    const [p0, i0] = [await portfolio(), await income()];
    for (const amt of [5_000, 2_500, 2_500]) assert.equal((await collect(carlos.money, s, amt)).status, 201);
    const last = await collect(carlos.money, s, 50_000);
    assert.equal(last.status, 201);
    assert.deepEqual([last.body['newBalanceMinor'], last.body['capped'], (last.body['credit'] as Body)['status']], [0, false, 'finalizada']);
    assert.deepEqual(await sale(s), { status: 'finalizada', bal: 0, fin: today });
    assert.ok((await insts(s)).every((i) => i.status === 'pagada' && i.bal === 0));
    const split = (await db.admin.query('select sum(principal_minor)::int p, sum(interest_minor)::int i from adex.payments where sale_id = $1', [s])).rows[0];
    assert.deepEqual(split, { p: 50_000, i: 10_000 }, 'capital exacto al saldar');
    assert.equal(await portfolio(), p0 - 50_000);
    assert.equal(await income(), i0 - 10_000);
    assert.equal((await collect(carlos.money, s, 1)).body['error'], 'CREDIT_NOT_ACTIVE', 'un crédito saldado no admite pagos');
  });

  test('COL-004 · recaudo superior al saldo: se aplica el saldo (sin crédito a favor) y se informa el tope', async () => {
    const s = await credit(r1);
    const before = await custody(carlos.membershipId);
    const r = await collect(carlos.money, s, 70_000);
    assert.equal(r.status, 201);
    assert.deepEqual([r.body['requestedMinor'], r.body['appliedMinor'], r.body['capped'], r.body['cappedMinor'], r.body['newBalanceMinor']], [70_000, 60_000, true, 10_000, 0]);
    assert.equal((r.body['payment'] as Body)['amountMinor'], 60_000, 'se guarda lo aplicado, nunca lo pedido');
    assert.equal(await custody(carlos.membershipId), before + 60_000, 'la custodia no se infla');
    assert.equal((await sale(s)).status, 'finalizada');
    const audit = (await db.admin.query(`select description from adex.audit_log where action = 'REGISTER_PAYMENT' and entity_id = $1`, [(r.body['payment'] as Body)['id']])).rows[0];
    assert.match(audit.description, /limitado al saldo/);
  });

  test('COL-005 · reintento con el MISMO operationId: misma respuesta, un solo pago', async () => {
    const s = await credit(r1);
    const op = randomUUID();
    const a = await collect(carlos.money, s, 5_000, {}, op);
    const b = await collect(carlos.money, s, 5_000, {}, op);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.deepEqual(b.body, a.body, 'el reintento devuelve el resultado guardado');
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1);
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where kind = 'COLLECTION' and sale_id = $1`, [s]), 1);
    assert.equal((await sale(s)).bal, 55_000);
    // Recuperación de una respuesta perdida: la operación se consulta por su id.
    const known = await carlos.call('GET', `/v1/operations/${op}`);
    assert.deepEqual([known.status, known.body['outcome'], known.body['httpStatus'], (known.body['result'] as Body)['paymentId']], [200, 'approved', 201, a.body['paymentId']]);
    assert.equal((await dora.call('GET', `/v1/operations/${op}`)).status, 404, 'solo la membresía que la ejecutó');
  });

  test('COL-006 · reintento con OTROS datos y el mismo id: 409, nada nuevo', async () => {
    const s = await credit(r1);
    const op = randomUUID();
    assert.equal((await collect(carlos.money, s, 5_000, {}, op)).status, 201);
    for (const [who, amt, sid] of [[carlos.money, 6_000, s], [carlos.money, 5_000, await credit(r1)], [dora.money, 5_000, s]] as const) {
      const r = await collect(who, sid, amt, {}, op);
      assert.deepEqual([r.status, r.body['error']], [409, 'OPERATION_ID_REUSED']);
    }
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1);
    assert.equal((await carlos.call('POST', '/v1/collections', { saleId: s, amountMinor: 5_000 })).body['error'], 'OPERATION_ID_REQUIRED', 'sin id no se cobra');
    for (const amountMinor of [0, -1, 12.5, '100', 2 ** 53]) assert.equal((await collect(carlos.money, s, amountMinor as number)).body['error'], 'INVALID_INPUT');
    assert.equal((await carlos.money('/v1/collections', { saleId: s, amountMinor: 1, paymentType: 'transferencia' })).body['error'], 'UNKNOWN_FIELD', 'solo efectivo: no hay campo de método');
  });

  test('COL-007 · recaudos sin permiso o con responsable inválido', async () => {
    const s = await credit(r1);
    assert.equal((await collect(money(fabio), s, 1_000)).status, 403, 'el Socio solo consulta');
    assert.equal((await collect(money(gabi), s, 1_000)).status, 403, 'la Secretaria no registra pagos (sin comandos financieros nuevos)');
    assert.equal((await collect(gil.money, s, 1_000)).status, 404, 'crédito de una ruta fuera de su alcance');
    assert.equal((await collect(carlos.money, s, 1_000, { collectorId: dora.membershipId })).body['error'], 'COLLECTOR_INVALID', 'quien cobra con caja personal responde por lo suyo');
    assert.equal((await collect($ana, s, 1_000, { collectorId: M.anaAdmin })).body['error'], 'COLLECTOR_INVALID', 'un Administrador no tiene caja personal');
    assert.equal((await collect($ana, s, 1_000, { collectorId: xavier.membershipId })).body['error'], 'COLLECTOR_INVALID');
    const before = await pool(M.anaAdmin);
    // Un solo Cobrador en la ruta (CLEAN: uno por ruta): se le atribuye sin ambigüedad.
    const auto = await collect($ana, s, 1_000);
    assert.deepEqual([auto.status, auto.body['receiver'], auto.body['collectorSource'], auto.body['collectorId']], [201, 'custody', 'single-route-collector', carlos.membershipId]);
    const ok = await collect($ana, s, 1_000, { collectorId: dora.membershipId });
    assert.deepEqual([ok.status, ok.body['receiver'], ok.body['collectorSource']], [201, 'custody', 'explicit']);
    assert.equal(await pool(M.anaAdmin), before, 'registrado por el Administrador, recibido por un trabajador: va a su custodia, nunca a la bolsa');
    // Segunda barrera: con un Cobrador activo en la ruta, el Administrador no puede quedarse el cobro.
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query('select adex.collection_post(gen_random_uuid(), $1, 1000, $2, null)', [s, M.anaAdmin]), { code: 'AX707' });
      await q.query('rollback to savepoint s');
      await assert.rejects(q.query('select adex.collection_post(gen_random_uuid(), $1, 1000, $2, null)', [s, gil.membershipId]), { code: 'AX708' });
    });
    assert.equal(((await db.admin.query('select created_by_membership_id c from adex.payments where id = $1', [(ok.body['payment'] as Body)['id']])).rows[0]).c, M.anaAdmin,
      'registrar ≠ responder: queda quién lo digitó');
    // Créditos que no admiten recaudos.
    const legacy = (await db.admin.query(`select id from adex.sales where company_id = $1 and route_id = $2 and ledger_operation_id is null and status = 'activa'
                                            and disbursement_status is distinct from 'pendiente' limit 1`, [c1, r1])).rows[0]?.id;
    if (legacy) assert.equal((await collect(carlos.money, legacy, 1_000)).body['error'], 'CREDIT_NOT_LEDGERED', 'crédito sin asiento de desembolso (sembrado)');
    assert.equal((await collect(carlos.money, 'no-existe', 1_000)).status, 404);
  });

  test('COL-008 · aislamiento entre empresas: ni API ni SQL cruzan; la API no escribe pagos directamente', async () => {
    const s = await credit(r1);
    const carla = money(caller(api, issuer, 'carla', M.carlaSa));
    assert.equal((await collect(carla, s, 1_000)).status, 404);
    assert.equal((await caller(api, issuer, 'carla', M.carlaSa)('GET', `/v1/collections?saleId=${s}`)).body['collections'] instanceof Array, true);
    assert.deepEqual((await caller(api, issuer, 'carla', M.carlaSa)('GET', `/v1/collections?saleId=${s}`)).body['collections'], []);
    // Ronda 67: con el Administrador de c2 (el SuperAdmin ya no tiene autoridad de cobro): el crédito de c1 no existe para él.
    await asApi(db.api, { identityId: identityOf('hugo'), membershipId: M.hugoAdmin, companyId: companyId('c2') }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query('select adex.collection_post(gen_random_uuid(), $1, 1000, $2, null)', [s, M.hugoAdmin]), { code: 'AX412' });
      await q.query('rollback to savepoint s');
      assert.equal(await count(q, 'select 1 from adex.payments where company_id = $1', [c1]), 0);
    });
    await asApi(db.api, { identityId: carlos.identityId, membershipId: carlos.membershipId, companyId: c1 }, async (q) => {
      for (const sql of [
        `insert into adex.payments (id, company_id, sale_id, client_id, route_id, collector_membership_id, amount_minor, payment_date, payment_type, sync_status, created_at)
           select 'x', company_id, id, client_id, route_id, '${carlos.membershipId}', 1, current_date, 'efectivo', 'synced', now() from adex.sales where id = '${s}'`,
        `update adex.installments set paid_minor = 0 where sale_id = '${s}'`,
        `update adex.sales set balance_minor = 0 where id = '${s}'`,
      ]) {
        await q.query('savepoint s');
        await assert.rejects(q.query(sql), { code: '42501' }, sql.slice(0, 40));
        await q.query('rollback to savepoint s');
      }
    });
    // Sin contexto o fuera de la API, la función no escribe.
    await assert.rejects(db.admin.query('select adex.collection_post(gen_random_uuid(), $1, 1000, $2, null)', [s, carlos.membershipId]), { code: '42501' });
  });

  test('COL-009 · ruta sin Cobrador: el cobro del Administrador va a la bolsa del responsable (C1); con trabajador, nunca', async () => {
    const s = await credit(rNo);
    const before = await pool(M.anaAdmin);
    const r = await collect($ana, s, 5_000);
    assert.deepEqual([r.status, r.body['receiver'], r.body['collectorSource']], [201, 'admin', 'legacy-actor']);
    assert.equal(await pool(M.anaAdmin), before + 5_000);
    const legs = await db.admin.query(`select a.kind, e.amount_minor::int amt from adex.capital_entries e join adex.capital_accounts a on a.id = e.account_id
                                        where e.operation_id = $1 order by e.leg`, [(r.body['payment'] as Body)['ledgerOperationId']]);
    assert.deepEqual(legs.rows, [{ kind: 'admin', amt: 5_000 }, { kind: 'portfolio', amt: -4_167 }, { kind: 'income', amt: -833 }]);
    // [MODIFICADO Ronda 67] Antes el SuperAdmin también cobraba (a la bolsa del responsable). Ahora su cartera es de consulta.
    assert.equal((await collect($bruno, s, 1_000)).status, 403);
  });

  test('COL-010 · historial y consultas por rol: cuotas y deuda actualizadas desde el servidor', async () => {
    const s = await credit(r1, 30_000, 6);
    assert.equal((await collect(carlos.money, s, 6_000)).status, 201);
    // Ronda 62 (exclusividad): con Carlos activo, el segundo cobro lo registra la oficina a su nombre.
    assert.equal((await $ana('/v1/collections', { saleId: s, amountMinor: 3_000, collectorId: carlos.membershipId })).status, 201);
    const mine = (await carlos.call('GET', `/v1/collections?saleId=${s}`)).body['collections'] as Body[];
    assert.equal(mine.length, 2, 'el Cobrador ve el historial del crédito de su ruta (payment.viewHistory)');
    assert.deepEqual(mine.map((p) => p['amountMinor']).sort(), [3_000, 6_000]);
    assert.equal(((await fabio('GET', `/v1/collections?saleId=${s}`)).body['collections'] as Body[]).length, 2, 'el Socio consulta');
    assert.equal((await gil.call('GET', `/v1/collections?saleId=${s}`)).body['collections'] instanceof Array, true);
    assert.deepEqual((await gil.call('GET', `/v1/collections?saleId=${s}`)).body['collections'], [], 'otra ruta');
    const detail = (await carlos.call('GET', `/v1/credits/${s}`)).body;
    assert.equal((detail['credit'] as Body)['balanceMinor'], 36_000 - 9_000);
    const one = await carlos.call('GET', `/v1/collections/${mine[0]!['id']}`);
    assert.equal(one.status, 200);
    assert.equal((await gil.call('GET', `/v1/collections/${mine[0]!['id']}`)).status, 404);
  });

  test('PAR-001 · paridad con el motor de CLEAN: cascada, saldo, estado y reparto tras abonos y anulaciones aleatorios', async () => {
    for (let round = 0; round < 6; round++) {
      const n = randomInt(1, 16);
      const amount = randomInt(10, 60) * 1_000 + randomInt(0, 999);
      const s = await credit(r1, amount, n);
      const live: { id: string; valor: number; createdAt: string }[] = [];
      for (let k = 0; k < 7; k++) {
        const bal = (await sale(s)).bal as number;
        if (bal <= 0) break;
        const reverse = live.length > 0 && randomInt(0, 4) === 0;
        if (reverse) {
          const target = live.splice(randomInt(0, live.length), 1)[0]!;
          const r = await $ana(`/v1/collections/${target.id}/reverse`, { reason: 'Paridad' });
          assert.equal(r.status, 201, JSON.stringify(r.body));
        } else {
          const r = await collect(carlos.money, s, randomInt(1, Math.ceil(bal * 0.7) + 2_000));
          assert.equal(r.status, 201, JSON.stringify(r.body));
          live.push({ id: r.body['paymentId'] as string, valor: r.body['appliedMinor'] as number, createdAt: new Date().toISOString() });
        }
        // CLEAN recalcula desde las cuotas originales y los pagos vigentes.
        const rows = await insts(s);
        const original: Installment[] = rows.map((i) => ({ id: String(i.number), saleId: s, numero: i.number, fechaVencimiento: '2999-01-01', valor: i.amt, pagado: 0, saldo: i.amt, status: 'pendiente', diasMora: 0 }));
        const clean = recalculateSaleFromPayments(original, live.map((p, idx) => ({ id: `p${idx}`, valor: p.valor, createdAt: p.createdAt } as Payment)));
        for (const i of rows) {
          const c = clean.find((x) => x.numero === i.number)!;
          assert.deepEqual([i.paid, i.bal], [c.pagado, c.saldo], `ronda ${round} cuota ${i.number}`);
          if (i.amt > 0) assert.equal(i.status, c.status, `ronda ${round} estado cuota ${i.number}`);
        }
        const st = await sale(s);
        assert.equal(st.bal, clean.reduce((t, x) => t + x.saldo, 0));
        assert.equal(st.status, st.bal <= 0 ? 'finalizada' : 'activa');
        if (rows.every((i) => i.amt > 0)) assert.equal(calculateCurrentInstallment(clean)?.numero ?? null, rows.find((i) => i.status !== 'pagada')?.number ?? null);
      }
    }
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
  });

  test('REV-001 · anulación autorizada: asiento espejo, original anulado, crédito reabierto y custodia descontada', async () => {
    const s = await credit(r1, 10_000, 2);
    const a = await collect(carlos.money, s, 6_000);
    const b = await collect(carlos.money, s, 6_000);
    assert.equal((await sale(s)).status, 'finalizada');
    const [cash, p0, i0] = [await custody(carlos.membershipId), await portfolio(), await income()];
    const pay = (a.body['payment'] as Body)['id'] as string;
    const r = await $ana(`/v1/collections/${pay}/reverse`, { reason: 'Pago duplicado' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rev = r.body['reversal'] as Body;
    assert.deepEqual([rev['amountMinor'], rev['state'], rev['reversesPaymentId'], rev['collectorId'], rev['createdBy'], rev['paymentDate']],
      [-6_000, 'reversal', pay, carlos.membershipId, M.anaAdmin, today]);
    assert.deepEqual([(r.body['original'] as Body)['state'], (r.body['original'] as Body)['reversalPaymentId']], ['reversed', rev['id']]);
    assert.deepEqual(await sale(s), { status: 'activa', bal: 6_000, fin: null }, 'el crédito se reabre y la fecha sellada se limpia');
    assert.deepEqual((await insts(s)).map((i) => [i.status, i.bal]), [['pagada', 0], ['pendiente', 6_000]]);
    assert.equal(await custody(carlos.membershipId), cash - 6_000, 'sale de quien recibió el dinero');
    // Lo reconocido vuelve a la proporción del total neto pagado (6.000 de 12.000).
    const split = (await db.admin.query('select sum(principal_minor)::int p from adex.payments where sale_id = $1', [s])).rows[0].p;
    assert.equal(split, 5_000);
    assert.equal(await portfolio(), p0 + 5_000);
    assert.equal(await income(), i0 + 1_000);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'ANNUL_PAYMENT' and entity_id = $1 and txid is not null`, [pay]), 1);
    assert.equal((await $ana(`/v1/collections/${pay}/reverse`, { reason: 'Otra vez' })).body['error'], 'ALREADY_REVERSED');
    assert.equal((await $ana(`/v1/collections/${rev['id']}/reverse`, { reason: 'Anular la anulación' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    // La anulación genérica de capital no se usa para recaudos (recalcula el crédito por su comando).
    const op = (b.body['payment'] as Body)['ledgerOperationId'] as string;
    assert.equal((await $ana(`/v1/capital/operations/${op}/reverse`, { reason: 'Por la vía genérica' })).body['error'], 'REVERSAL_NOT_ALLOWED');
    await asApi(db.api, { identityId: identityOf('ana'), membershipId: M.anaAdmin, companyId: c1 }, async (q) => {
      await q.query('savepoint s');
      await assert.rejects(q.query(`select * from adex.capital_post(gen_random_uuid(), 'REVERSAL', null, 'x', p_reverses => $1)`, [op]), { code: 'AX411' });
      await q.query('rollback to savepoint s');
    });
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('REV-002 · anulación denegada: sin rol, por la propia persona o con el dinero ya usado', async () => {
    const s = await credit(r1);
    const pay = ((await collect(carlos.money, s, 5_000)).body['payment'] as Body)['id'] as string;
    for (const [who, name] of [[carlos.money, 'Cobrador'], [dora.money, 'Supervisor'], [money(gabi), 'Secretaria'], [money(fabio), 'Socio']] as const) {
      assert.equal((await who(`/v1/collections/${pay}/reverse`, { reason: 'Sin permiso' })).status, 403, name);
    }
    assert.equal((await gil.money(`/v1/collections/${pay}/reverse`, { reason: 'Otra ruta' })).status, 404);
    assert.equal((await money(caller(api, issuer, 'carla', M.carlaSa))(`/v1/collections/${pay}/reverse`, { reason: 'Otra empresa' })).status, 404);
    assert.equal((await $ana(`/v1/collections/${pay}/reverse`, {})).body['error'], 'INVALID_INPUT', 'motivo obligatorio');
    // Ana cobradora cobra; Ana administradora (la MISMA persona) no puede anularlo (DS-05).
    const own = ((await collect($anaCob, await credit(rAna), 1_000)).body['payment'] as Body)['id'] as string;
    assert.equal((await $ana(`/v1/collections/${own}/reverse`, { reason: 'Propio' })).body['error'], 'SELF_REDUCTION_FORBIDDEN');
    // [MODIFICADO Ronda 67] El SuperAdmin ya no anula pagos (403); otra persona con autoridad sobre la ruta sí.
    assert.equal((await $bruno(`/v1/collections/${own}/reverse`, { reason: 'Otra persona' })).status, 403);
    await db.admin.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3) on conflict do nothing', [c1, xavier.membershipId, rAna]);
    const byOther = await xavier.money(`/v1/collections/${own}/reverse`, { reason: 'Otra persona' });
    assert.equal(byOther.status, 201, JSON.stringify(byOther.body));
    // Dinero ya entregado a la bolsa: no se devuelve un dinero que ya no está en sus manos.
    const left = await custody(carlos.membershipId);
    assert.equal((await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: left, reason: 'Entrega del día' })).status, 201);
    const r = await $ana(`/v1/collections/${pay}/reverse`, { reason: 'Ya entregado' });
    assert.deepEqual([r.status, r.body], [409, { error: 'FUNDS_ALREADY_USED' }]);
    assert.equal(((await db.admin.query('select state from adex.payments where id = $1', [pay])).rows[0]).state, 'active', 'nada cambió');
    // Pago sembrado (sin asiento): no se corrige por esta vía.
    const legacy = (await db.admin.query(`select id from adex.payments where company_id = $1 and ledger_operation_id is null and state = 'active' limit 1`, [c1])).rows[0]?.id;
    if (legacy) assert.equal((await $bruno(`/v1/collections/${legacy}/reverse`, { reason: 'Sembrado' })).body['error'], 'NOT_CORRECTABLE_HERE');
  });

  test('REV-003 · periodos cerrados (D7): sin pagos nuevos; la anulación de un pago de semana cerrada va a hoy; sin periodo abierto, nada', async () => {
    const tz = async (zone: string) => { await db.admin.query('update adex.companies set timezone = $2 where id = $1', [c1, zone]); };
    const close = async (from: string, to: string) => db.admin.query(
      `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
       values ($1, $2, $3, $4::date, $5::date, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [randomUUID(), c1, rD7, from, to]);
    try {
      await tz('Pacific/Kiritimati');
      const day = (await db.admin.query(`select (now() at time zone 'Pacific/Kiritimati')::date::text d`)).rows[0].d;
      const saved = today;
      today = day;
      const s = await credit(rD7);
      today = saved;
      const p1 = ((await collect($ana, s, 5_000)).body['payment'] as Body)['id'] as string;
      const p2 = ((await collect($ana, s, 5_000)).body['payment'] as Body)['id'] as string;
      await close(day, day);
      assert.equal((await collect($ana, s, 1_000)).body['error'], 'PERIOD_CLOSED', 'la semana de hoy está cerrada');
      assert.equal((await $ana(`/v1/collections/${p1}/reverse`, { reason: 'Sin periodo abierto' })).body['error'], 'PERIOD_CLOSED', 'hoy también cerrado: no se inventa otra fecha');
      // Otro «hoy» (zona horaria de la empresa): el día del pago sigue cerrado, hoy está abierto.
      await tz('Pacific/Pago_Pago');
      const now = (await db.admin.query(`select (now() at time zone 'Pacific/Pago_Pago')::date::text d`)).rows[0].d;
      assert.notEqual(now, day);
      const before = (await db.admin.query('select count(*)::int n from adex.weekly_settlements where route_id = $1', [rD7])).rows[0].n;
      const r = await $ana(`/v1/collections/${p1}/reverse`, { reason: 'Corrección tras el cierre' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((r.body['reversal'] as Body)['paymentDate'], now, 'la anulación entra en el periodo abierto');
      assert.equal(((await db.admin.query('select payment_date::text d from adex.payments where id = $1', [p1])).rows[0]).d, day, 'el original no cambia');
      assert.equal((await db.admin.query('select count(*)::int n from adex.weekly_settlements where route_id = $1', [rD7])).rows[0].n, before);
      assert.equal((await xavier.money(`/v1/collections/${p2}/reverse`, { reason: 'Admin sin la ruta' })).status, 404);
      await close(now, now);
      assert.equal((await $ana(`/v1/collections/${p2}/reverse`, { reason: 'Todo cerrado' })).body['error'], 'PERIOD_CLOSED');
      assert.equal((await $ana('/v1/expenses', { scope: 'ruta', routeId: rD7, categoryId: (await db.admin.query(`select id from adex.expense_categories where company_id = $1 limit 1`, [c1])).rows[0].id, amountMinor: 100 })).body['error'], 'PERIOD_CLOSED');
    } finally {
      await tz('America/Sao_Paulo');
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('COL-099 · conciliación API = SQL independiente y sin errores inesperados', async () => {
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    for (const name of ['portfolio-matches-credits', 'credits-match-installments-and-payments', 'payments-have-ledger-entry', 'negative-custody-only-by-worker-expense']) {
      assert.ok((rec['checks'] as Body[]).some((c) => c['name'] === name), name);
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(api.errors, []);
    void membershipId;
  });
});
