// FASE 3 · capital centralizado y custodia contra PostgreSQL real y la API HTTP:
// Empresa → bolsa del Administrador → custodia del trabajador por ruta, sin caja de
// ruta. Cada paso se verifica con SQL propio (no con la API): saldos, patas,
// conservación y ausencia de escrituras ajenas (ventas, deuda, caja de ruta).
//
// Importes en unidades menores. BRL (c1): R$ 1.000 = 100_000. COP (c2).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, membershipId, routeId, uid } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const opOf = (r: { body: Body }) => r.body['operation'] as Body;

describe('Fase 3 · comandos de capital y custodia', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const c2 = companyId('c2');
  const r1 = routeId('c1', 1);
  const r2 = routeId('c1', 2);
  let bruno: Caller, ana: Caller, carla: Caller, hugo: Caller, anaSup: Caller;
  let $bruno: Money, $ana: Money, $carla: Money, $hugo: Money, $anaSup: Money;
  let carlos: Person, dora: Person, eva: Person, fede: Person, gil: Person, xavier: Person;
  let r5 = '', r6 = '';

  const custody = (m: string, r: string, company = c1) => balance(db.admin, company, 'custody', m, r);
  const pool = (m: string, company = c1) => balance(db.admin, company, 'admin', m);

  before(async () => {
    db = await createTestDb('capital', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    carla = caller(api, issuer, 'carla', M.carlaSa); $carla = money(carla);
    hugo = caller(api, issuer, 'hugo', M.hugoAdmin); $hugo = money(hugo);
    anaSup = caller(api, issuer, 'ana', M.anaSup); $anaSup = money(anaSup);
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) =>
      newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    // Regla vigente de CLEAN (`setCobradorRoutes`): UN Cobrador por ruta; el segundo
    // trabajador con caja personal de una ruta es un Supervisor.
    carlos = await mk('carlos-p3@example.test', 'cobrador', 'Carlos Cobrador', [r1]);   // reemplaza a Ana (cobradora) en r1
    dora = await mk('dora-p3@example.test', 'supervisor', 'Dora Supervisora', [r1]);
    xavier = await mk('xavier-p3@example.test', 'admin', 'Xavier Admin', [r1]);
    gil = await mk('gil-p3@example.test', 'cobrador', 'Gil Cobrador', [r2]);
    // Ruta 5 (responsable: Ana) y ruta 6 (responsable: Xavier; Ana también asignada), sin Oficina: operativas.
    r5 = (await bruno('POST', '/v1/routes', { name: 'Ruta Cinco', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [M.anaAdmin] })).body['id'] as string;
    r6 = (await bruno('POST', '/v1/routes', { name: 'Ruta Seis', interestRate: 20, freeRate: false, maxLoanMinor: 500_000, adminIds: [xavier.membershipId, M.anaAdmin] })).body['id'] as string;
    // Ana cobradora pasa a la ruta 5, cuyo responsable de capital es Ana administradora (DS-05: misma persona).
    const moved = await bruno('PUT', `/v1/members/${M.anaCob}/routes`, { routeIds: [r5] });
    if (moved.status !== 200) throw new Error(`rutas de Ana cobradora: ${JSON.stringify(moved.body)}`);
    eva = await mk('eva-p3@example.test', 'supervisor', 'Eva Supervisora', [r5]);
    fede = await mk('fede-p3@example.test', 'cobrador', 'Fede Cobrador', [r6]);
  });
  after(async () => { await api.close(); await db.close(); });

  test('CAP3-001 · depósito de la empresa y asignación a bolsas: el dinero solo cambia de cuenta', async () => {
    const d = await $bruno('/v1/capital/company/deposits', { amountMinor: 2_000_000, reason: 'Capital inicial sintético' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual([opOf(d)['kind'], opOf(d)['currencyCode'], opOf(d)['amountMinor']], ['COMPANY_DEPOSIT', 'BRL', 2_000_000]);
    const today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    assert.equal(opOf(d)['entryDate'], today, 'fecha contable en la zona horaria de la empresa');
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Bolsa de Ana' })).status, 201);
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: xavier.membershipId, amountMinor: 200_000, reason: 'Bolsa de Xavier' })).status, 201);
    assert.equal(await balance(db.admin, c1, 'company', null), 800_000);
    assert.equal(await pool(M.anaAdmin), 1_000_000);
    assert.equal(await pool(xavier.membershipId), 200_000);
    assert.equal(await balance(db.admin, c1, 'external', null), -2_000_000);
    const sa = (await bruno('GET', '/v1/capital/summary')).body;
    assert.deepEqual(sa['company'], { availableMinor: 800_000, externalNetInMinor: 2_000_000, partnerContributionsMinor: 0, adminPoolsMinor: 1_200_000, custodyMinor: 0, portfolioMinor: 0 });
    const own = (await ana('GET', '/v1/capital/summary')).body;
    assert.equal(own['company'], undefined, 'el Administrador no ve la empresa');
    assert.deepEqual((own['admins'] as Body[]).map((a) => [a['adminId'], a['availableMinor'], a['allocatedNetMinor']]), [[M.anaAdmin, 1_000_000, 1_000_000]]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CAP3-002 · entrega anticipada de R$ 1.000: baja la bolsa, sube la custodia; sin préstamo ni deuda', async () => {
    const before = {
      sales: await count(db.admin, 'select 1 from adex.sales where company_id = $1', [c1]),
      requests: (await db.admin.query('select id, status, sale_id from adex.sale_requests where company_id = $1 order by id', [c1])).rows,
      installments: await count(db.admin, 'select 1 from adex.installments where company_id = $1', [c1]),
      payments: await count(db.admin, 'select 1 from adex.payments where company_id = $1', [c1]),
      legacy: await count(db.admin, `select 1 from adex.capital_movements where company_id = $1 union all select 1 from adex.withdrawals where company_id = $1
                                     union all select 1 from adex.cash_custody_movements where company_id = $1`, [c1]),
    };
    const r = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 100_000, reason: 'Anticipo para las ventas del día' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([opOf(r)['kind'], opOf(r)['adminId'], opOf(r)['workerId'], opOf(r)['saleRequestId']], ['WORKER_DELIVERY', M.anaAdmin, carlos.membershipId, null]);
    assert.deepEqual((r.body['entries'] as Body[]).map((e) => [(e['account'] as Body)['kind'], e['amountMinor'], e['balanceAfterMinor']]),
      [['admin', -100_000, 900_000], ['custody', 100_000, 100_000]]);
    // Referencia opcional a una solicitud de ESTA ruta: no la toca ni crea venta.
    const req = uid('c1:request:2');
    const withReq = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 50_000, reason: 'Completar la venta solicitada', saleRequestId: req });
    assert.equal(withReq.status, 201, JSON.stringify(withReq.body));
    assert.equal(opOf(withReq)['saleRequestId'], req);
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Solicitud de otra ruta', saleRequestId: uid('c1:request:3') })).body['error'], 'NOT_FOUND');
    assert.deepEqual({
      sales: await count(db.admin, 'select 1 from adex.sales where company_id = $1', [c1]),
      requests: (await db.admin.query('select id, status, sale_id from adex.sale_requests where company_id = $1 order by id', [c1])).rows,
      installments: await count(db.admin, 'select 1 from adex.installments where company_id = $1', [c1]),
      payments: await count(db.admin, 'select 1 from adex.payments where company_id = $1', [c1]),
      legacy: await count(db.admin, `select 1 from adex.capital_movements where company_id = $1 union all select 1 from adex.withdrawals where company_id = $1
                                     union all select 1 from adex.cash_custody_movements where company_id = $1`, [c1]),
    }, before, 'ni venta, ni deuda, ni solicitud modificada, ni caja de ruta');
    assert.equal(await custody(carlos.membershipId, r1), 150_000);
    assert.equal(await pool(M.anaAdmin), 850_000);
    // Auditoría en la MISMA transacción que la operación.
    const a = await db.admin.query(
      `select a.action, a.actor_role, a.route_id from adex.audit_log a join adex.capital_operations o on o.id = a.entity_id and o.txid = a.txid
        where a.entity_id = $1`, [opOf(r)['id']]);
    assert.deepEqual(a.rows, [{ action: 'CENTRAL_CAPITAL_DELIVERED', actor_role: 'admin', route_id: r1 }]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CAP3-003 · entrega completa o parcial: el importe lo decide el Administrador', async () => {
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 30_000, reason: 'Solo la diferencia' })).status, 201);
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 1, reason: 'Un centavo' })).status, 201);
    assert.equal(await custody(dora.membershipId, r1), 30_001);
    assert.equal(await pool(M.anaAdmin), 819_999);
  });

  test('CAP3-004 · devolución a la bolsa: autoridad `settle`; nunca la propia, tampoco con otra membresía', async () => {
    const r = await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 40_000, reason: 'Devuelve lo que no usó' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await custody(carlos.membershipId, r1), 110_000);
    assert.equal(await pool(M.anaAdmin), 859_999);
    assert.equal((await carlos.money('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Me devuelvo' })).status, 403);
    const over = await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 110_001, reason: 'Más de lo que tiene' });
    assert.deepEqual([over.status, over.body], [409, { error: 'INSUFFICIENT_FUNDS' }], 'sin cifras en el error');
    // Ana (Administradora) entrega a Ana (Cobradora): es otra membresía, pero la MISMA persona
    // no puede registrar la devolución de su propio efectivo. Otra persona sí.
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r5, workerId: M.anaCob, amountMinor: 10_000, reason: 'Base de Ana cobradora' })).status, 201);
    assert.equal((await $ana('/v1/capital/returns', { routeId: r5, workerId: M.anaCob, amountMinor: 10_000, reason: 'Autodevolución' })).body['error'], 'SELF_REDUCTION_FORBIDDEN');
    assert.equal((await $bruno('/v1/capital/returns', { routeId: r5, workerId: M.anaCob, amountMinor: 10_000, reason: 'Recibida por el SuperAdmin' })).status, 201);
    assert.equal(await custody(M.anaCob, r5), 0);
    assert.equal(await pool(M.anaAdmin), 859_999, 'la devolución va a la bolsa del responsable');
  });

  test('CAP3-005 · Supervisor (c2, COP): recibe devoluciones y traspasa en su ruta; no entrega capital ni reduce lo suyo', async () => {
    const c2r1 = routeId('c2', 1);
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 5_000_000_00, reason: 'Capital sintético COP' })).status, 201);
    assert.equal((await $carla('/v1/capital/allocations', { adminId: M.hugoAdmin, amountMinor: 2_000_000_00, reason: 'Bolsa de Hugo' })).status, 201);
    const d = await $hugo('/v1/capital/deliveries', { routeId: c2r1, workerId: M.elisaCob, amountMinor: 500_000_00, reason: 'Base del día' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal(opOf(d)['currencyCode'], 'COP');
    assert.equal((await $anaSup('/v1/capital/returns', { routeId: c2r1, workerId: M.elisaCob, amountMinor: 100_000_00, reason: 'Recibe en campo' })).status, 201);
    assert.equal((await $anaSup('/v1/capital/deliveries', { routeId: c2r1, workerId: M.elisaCob, amountMinor: 1, reason: 'Supervisor entrega' })).status, 403);
    assert.equal((await $hugo('/v1/capital/deliveries', { routeId: c2r1, workerId: M.anaSup, amountMinor: 50_000_00, reason: 'Base del Supervisor' })).status, 201);
    assert.equal((await $anaSup('/v1/capital/returns', { routeId: c2r1, workerId: M.anaSup, amountMinor: 1, reason: 'Propia' })).body['error'], 'SELF_REDUCTION_FORBIDDEN');
    assert.equal((await $anaSup('/v1/capital/worker-transfers', { routeId: c2r1, fromWorkerId: M.anaSup, toWorkerId: M.elisaCob, amountMinor: 1, reason: 'Propia' })).body['error'], 'SELF_REDUCTION_FORBIDDEN');
    assert.equal((await $anaSup('/v1/capital/worker-transfers', { routeId: c2r1, fromWorkerId: M.elisaCob, toWorkerId: M.anaSup, amountMinor: 20_000_00, reason: 'Elisa entrega al Supervisor' })).status, 201);
    assert.equal(await custody(M.elisaCob, c2r1, c2), 380_000_00);
    assert.equal(await custody(M.anaSup, c2r1, c2), 70_000_00);
    assert.equal(await pool(M.hugoAdmin, c2), 1_550_000_00);
    assert.deepEqual(await reconcile(db.admin, c2), CLEAN);
  });

  test('CAP3-006 · fondos insuficientes: ningún sobregiro de empresa, bolsa ni custodia (y sin cifras)', async () => {
    for (const [r, label] of [
      [await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 800_001, reason: 'Más que la empresa' }), 'asignación'],
      [await $bruno('/v1/capital/company/withdrawals', { amountMinor: 800_001, reason: 'Más que la empresa' }), 'retiro'],
      [await $bruno('/v1/capital/admin-returns', { adminId: M.anaAdmin, amountMinor: 860_000, reason: 'Lo que está en custodia no vuelve' }), 'devolución de bolsa'],
      [await xavier.money('/v1/capital/deliveries', { routeId: r6, workerId: fede.membershipId, amountMinor: 200_001, reason: 'Más que su bolsa' }), 'entrega'],
    ] as const) {
      assert.deepEqual([r.status, r.body], [409, { error: 'INSUFFICIENT_FUNDS' }], label);
    }
    assert.equal(await balance(db.admin, c1, 'company', null), 800_000);
    assert.equal(await pool(xavier.membershipId), 200_000);
  });

  test('CAP3-007 · autoridad: solo el responsable entrega; roles sin capital y personas no elegibles se rechazan', async () => {
    const deliver = (m: Money, routeId: string, workerId: string) => m('/v1/capital/deliveries', { routeId, workerId, amountMinor: 1_000, reason: 'Intento' });
    assert.equal((await deliver(xavier.money, r1, carlos.membershipId)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'Admin asignado que no es responsable');
    assert.equal((await deliver($bruno, r1, carlos.membershipId)).body['error'], 'CAPITAL_AUTHORITY_REQUIRED', 'el SuperAdmin asigna a bolsas, no entrega');
    for (const [who, label] of [[carlos.money, 'cobrador'], [money(caller(api, issuer, 'gabi', M.gabiSec)), 'secretaria'], [money(caller(api, issuer, 'fabio', M.fabioSocio)), 'socio']] as const) {
      assert.equal((await deliver(who, r1, dora.membershipId)).status, 403, label);
    }
    assert.equal((await carlos.call('GET', '/v1/capital/summary')).status, 403);
    assert.equal((await deliver($ana, r5, carlos.membershipId)).body['error'], 'CUSTODIAN_INVALID', 'no asignado a la ruta');
    assert.equal((await deliver($ana, r1, xavier.membershipId)).body['error'], 'CUSTODIAN_INVALID', 'un Administrador no tiene caja personal');
    assert.equal((await deliver($ana, r2, gil.membershipId)).body['error'], 'ROUTE_NOT_OPERATIONAL', 'Oficina inactiva');
    assert.equal((await deliver($ana, routeId('c2', 1), M.elisaCob)).body['error'], 'NOT_FOUND', 'ruta de otra empresa');
    assert.equal((await deliver($ana, routeId('c1', 3), carlos.membershipId)).body['error'], 'NOT_FOUND', 'ruta fuera de su alcance');
    assert.equal(await pool(M.anaAdmin), 859_999, 'ningún intento escribió');
  });

  test('CAP3-008 · traspaso entre trabajadores de la MISMA ruta: no toca bolsas; solo efectivo en manos', async () => {
    const r = await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 20_000, reason: 'Carlos entrega a Dora' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await custody(carlos.membershipId, r1), 90_000);
    assert.equal(await custody(dora.membershipId, r1), 50_001);
    assert.equal(await pool(M.anaAdmin), 859_999);
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: dora.membershipId, toWorkerId: dora.membershipId, amountMinor: 1, reason: 'A sí misma' })).body['error'], 'INVALID_INPUT');
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: eva.membershipId, amountMinor: 1, reason: 'Otra ruta' })).body['error'], 'CUSTODIAN_INVALID');
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 90_001, reason: 'Más de lo que tiene' })).body['error'], 'FUNDS_ALREADY_USED');
    assert.equal((await carlos.money('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 1, reason: 'Unilateral' })).status, 403);
  });

  test('CAP3-009 · reasignación entre rutas del mismo responsable: una operación, dos atribuciones; D2 bloqueada', async () => {
    const r = await $ana('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: r5, fromWorkerId: carlos.membershipId, toWorkerId: eva.membershipId, amountMinor: 15_000, reason: 'Ruta Cinco necesita base' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual((r.body['entries'] as Body[]).map((e) => [(e['account'] as Body)['kind'], (e['account'] as Body)['routeId'], e['amountMinor']]),
      [['custody', r1, -15_000], ['admin', null, 15_000], ['admin', null, -15_000], ['custody', r5, 15_000]]);
    assert.equal(await custody(carlos.membershipId, r1), 75_000);
    assert.equal(await custody(eva.membershipId, r5), 15_000);
    assert.equal(await pool(M.anaAdmin), 859_999, 'la bolsa solo es tránsito');
    const d2 = await $ana('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: r6, fromWorkerId: carlos.membershipId, toWorkerId: fede.membershipId, amountMinor: 1, reason: 'Otro responsable' });
    assert.deepEqual([d2.status, d2.body['error']], [409, 'DECISION_PENDING_D2']);
    // El Cobrador no se reasigna dinero: la ruta destino ni siquiera existe para él (404).
    assert.equal((await carlos.money('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: r5, fromWorkerId: carlos.membershipId, toWorkerId: eva.membershipId, amountMinor: 1, reason: 'Yo mismo' })).status, 404);
    assert.equal(await custody(carlos.membershipId, r1), 75_000, 'nada se movió');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CAP3-010 · aporte de socio: entra a la bolsa del responsable, nunca a una ruta; contabilizado una sola vez', async () => {
    const r = await $ana('/v1/capital/partner-contributions', { partnerId: M.fabioSocio, routeId: r1, amountMinor: 300_000, reason: 'Aporte de Fabio para la ruta 1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await pool(M.anaAdmin), 1_159_999);
    assert.equal(await balance(db.admin, c1, 'partner', M.fabioSocio), -300_000);
    assert.equal(await balance(db.admin, c1, 'company', null), 800_000, 'no es capital de la empresa');
    assert.equal(await count(db.admin, `select 1 from adex.partner_cash_movements where company_id = $1 and created_at > now() - interval '1 hour'`, [c1]), 0, 'Caja socios (D1) intacta');
    const sa = (await bruno('GET', '/v1/capital/summary')).body['company'] as Body;
    assert.equal(sa['partnerContributionsMinor'], 300_000);
    assert.equal((await $bruno('/v1/capital/partner-contributions', { partnerId: M.fabioSocio, routeId: r1, amountMinor: 1, reason: 'El SuperAdmin no recibe' })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    assert.equal((await $ana('/v1/capital/partner-contributions', { partnerId: carlos.membershipId, routeId: r1, amountMinor: 1, reason: 'No es socio' })).body['error'], 'NOT_FOUND');
    // El socio ve su aporte y la custodia de sus rutas (`cashbox.viewRoute`), nunca una bolsa.
    const fabio = caller(api, issuer, 'fabio', M.fabioSocio);
    const seen = (await fabio('GET', '/v1/capital/operations')).body['operations'] as Body[];
    assert.ok(seen.some((o) => o['id'] === opOf(r)['id']));
    assert.ok(seen.every((o) => o['id'] === opOf(r)['id'] || ([r1, r2].includes(o['routeId'] as string) && o['kind'] !== 'PARTNER_CONTRIBUTION')), 'nada fuera de sus rutas');
    const entries = (await fabio('GET', `/v1/capital/operations/${opOf(r)['id']}`)).body['entries'] as Body[];
    assert.deepEqual(entries.map((e) => (e['account'] as Body)['kind']), ['partner'], 'el socio no ve el saldo de la bolsa');
    for (const o of seen.filter((x) => x['kind'] === 'WORKER_DELIVERY')) {
      const legs = (await fabio('GET', `/v1/capital/operations/${o['id']}`)).body['entries'] as Body[];
      assert.deepEqual(legs.map((e) => (e['account'] as Body)['kind']), ['custody'], 'de una entrega, solo la custodia');
    }
    const rev = await $ana(`/v1/capital/operations/${opOf(r)['id']}/reverse`, { reason: 'Aporte registrado por error' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.equal(await balance(db.admin, c1, 'partner', M.fabioSocio), 0);
    assert.equal(await pool(M.anaAdmin), 859_999);
  });

  test('CAP3-011 · anulaciones: asiento espejo; nunca sobre capital consumido, dos veces, ni que cree dinero', async () => {
    const d1 = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 50_000, reason: 'Entrega equivocada' });
    const original = (await db.admin.query('select * from adex.capital_operations where id = $1', [opOf(d1)['id']])).rows[0];
    const rev = await $ana(`/v1/capital/operations/${opOf(d1)['id']}/reverse`, { reason: 'Se entregó por error' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.deepEqual([opOf(rev)['kind'], opOf(rev)['reversesKind'], opOf(rev)['amountMinor']], ['REVERSAL', 'WORKER_DELIVERY', 50_000]);
    assert.deepEqual((await db.admin.query('select * from adex.capital_operations where id = $1', [opOf(d1)['id']])).rows[0], original, 'la original no cambia');
    assert.equal(await custody(dora.membershipId, r1), 50_001);
    assert.equal(await pool(M.anaAdmin), 859_999);
    assert.equal((await $ana(`/v1/capital/operations/${opOf(d1)['id']}/reverse`, { reason: 'Otra vez' })).body['error'], 'ALREADY_REVERSED');
    assert.equal((await $ana(`/v1/capital/operations/${opOf(rev)['id']}/reverse`, { reason: 'Anular la anulación' })).body['error'], 'REVERSAL_NOT_ALLOWED');

    // Capital ya utilizado: Dora traspasa casi todo; la entrega ya no se puede anular.
    const d2 = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 40_000, reason: 'Base adicional' });
    assert.equal((await $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: dora.membershipId, toWorkerId: carlos.membershipId, amountMinor: 60_000, reason: 'Dora entrega a Carlos' })).status, 201);
    assert.equal((await $ana(`/v1/capital/operations/${opOf(d2)['id']}/reverse`, { reason: 'Tarde' })).body['error'], 'FUNDS_ALREADY_USED');

    // Retiro de la empresa: «anularlo» reintroduciría dinero.
    const w = await $bruno('/v1/capital/company/withdrawals', { amountMinor: 10_000, reason: 'Retiro sintético' });
    assert.equal((await $bruno(`/v1/capital/operations/${opOf(w)['id']}/reverse`, { reason: 'Revertir retiro' })).body['error'], 'REVERSAL_NOT_ALLOWED');

    // Asignación cuyo capital ya salió de la bolsa: no vuelve a la empresa.
    const x = await xavier.money('/v1/capital/deliveries', { routeId: r6, workerId: fede.membershipId, amountMinor: 150_000, reason: 'Base Ruta Seis' });
    assert.equal(x.status, 201);
    const alloc = (await db.admin.query(`select id from adex.capital_operations where kind = 'ADMIN_ALLOCATION' and admin_membership_id = $1`, [xavier.membershipId])).rows[0].id as string;
    assert.equal((await $bruno(`/v1/capital/operations/${alloc}/reverse`, { reason: 'Asignación duplicada' })).body['error'], 'INSUFFICIENT_FUNDS');

    // Autoridad `correct`: responsable o SuperAdmin; otro Administrador, no.
    const d3 = await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 5_000, reason: 'Para anular' });
    assert.equal((await xavier.money(`/v1/capital/operations/${opOf(d3)['id']}/reverse`, { reason: 'No soy responsable' })).status, 403);
    assert.equal((await $bruno(`/v1/capital/operations/${opOf(d3)['id']}/reverse`, { reason: 'Corrige el SuperAdmin' })).status, 201);

    // Anular una devolución y una reasignación.
    const ret = (await db.admin.query(`select id from adex.capital_operations where kind = 'WORKER_RETURN' and worker_membership_id = $1`, [carlos.membershipId])).rows[0].id as string;
    assert.equal((await $ana(`/v1/capital/operations/${ret}/reverse`, { reason: 'La devolución no ocurrió' })).status, 201);
    const re = (await db.admin.query(`select id from adex.capital_operations where kind = 'ROUTE_REASSIGNMENT'`)).rows[0].id as string;
    assert.equal((await $ana(`/v1/capital/operations/${re}/reverse`, { reason: 'Reasignación equivocada' })).status, 201);
    assert.equal(await custody(eva.membershipId, r5), 0);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CAP3-012 · idempotencia HTTP: obligatoria, sin duplicados, misma clave con otros datos rechazada', async () => {
    const body = { routeId: r1, workerId: carlos.membershipId, amountMinor: 7_000, reason: 'Reintento de red' };
    assert.equal((await ana('POST', '/v1/capital/deliveries', body)).body['error'], 'OPERATION_ID_REQUIRED');
    assert.equal((await ana('POST', '/v1/capital/deliveries', body, { 'x-adex-operation-id': 'no-es-uuid' })).body['error'], 'INVALID_OPERATION_ID');
    const id = randomUUID();
    const before = await pool(M.anaAdmin);
    const a = await $ana('/v1/capital/deliveries', body, id);
    const b = await $ana('/v1/capital/deliveries', body, id);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.deepEqual(b.body, a.body, 'el reintento devuelve lo ya guardado');
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1 and operation_id = $2', [c1, id]), 1);
    assert.equal(await pool(M.anaAdmin), before - 7_000, 'una sola vez');
    assert.equal((await $ana('/v1/capital/deliveries', { ...body, amountMinor: 7_001 }, id)).body['error'], 'OPERATION_ID_REUSED');
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 1, reason: 'Misma clave, otra persona' }, id)).body['error'], 'OPERATION_ID_REUSED');
    // La clave es por empresa: otra empresa no colisiona ni ve nada.
    assert.equal((await $carla('/v1/capital/company/deposits', { amountMinor: 1, reason: 'Misma clave en c2' }, id)).status, 201);
  });

  test('CAP3-013 · entradas: enteros en unidades menores, motivo obligatorio y campos conocidos', async () => {
    for (const amountMinor of [12.5, '100', 0, -5, 2 ** 53, null]) {
      assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor, reason: 'Importe inválido' })).body['error'], 'INVALID_INPUT', String(amountMinor));
    }
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 100 })).body['error'], 'INVALID_INPUT');
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 100, reason: 'ab' })).body['error'], 'INVALID_INPUT');
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 100, reason: 'Moneda', currency: 'USD' })).body['error'], 'UNKNOWN_FIELD');
    const currencies = (await db.admin.query(
      `select distinct o.company_id = c.id and o.currency_code = c.currency_code ok from adex.capital_operations o join adex.companies c on c.id = o.company_id`)).rows;
    assert.deepEqual(currencies, [{ ok: true }], 'cada operación en la moneda de SU empresa');
  });

  test('CAP3-014 · sin caja de ruta: ni capital inicial, ni cuenta de ruta, ni escrituras en la caja heredada', async () => {
    assert.equal((await bruno('POST', '/v1/routes', { name: 'Con capital', interestRate: 20, freeRate: false, maxLoanMinor: 1, initialCapitalMinor: 1_000 })).body['error'], 'ROUTE_INITIAL_CAPITAL_NOT_ALLOWED');
    const kinds = (await db.admin.query('select distinct kind from adex.capital_accounts order by 1')).rows.map((r) => r.kind);
    assert.ok(kinds.every((k) => ['admin', 'company', 'custody', 'external', 'partner'].includes(k)), kinds.join());
    await assert.rejects(db.admin.query(`insert into adex.capital_accounts (id, company_id, kind, route_id) values ('acc-ruta', $1, 'route', $2)`, [c1, r1]), { code: '23514' });
    await assert.rejects(db.admin.query(`insert into adex.capital_accounts (id, company_id, kind, route_id) values ('acc-ruta', $1, 'company', $2)`, [c1, r1]), { code: '23514' });
    assert.equal(await count(db.admin, `select 1 from adex.capital_movements where created_at > now() - interval '1 day'
                                        union all select 1 from adex.withdrawals where created_at > now() - interval '1 day'
                                        union all select 1 from adex.cash_custody_movements where created_at > now() - interval '1 day'`), 0);
  });

  test('CAP3-015 · cambio de responsable: la custodia queda con la ruta y responde la bolsa del nuevo; sin fuga de permisos', async () => {
    const base = Number((await db.admin.query(`select coalesce(sum(balance_minor), 0)::text b from adex.capital_accounts where kind = 'custody' and route_id = $1`, [r1])).rows[0].b);
    const anaBefore = await pool(M.anaAdmin);
    const ch = await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: xavier.membershipId, reason: 'Reorganización Fase 3' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const ev = await db.admin.query('select base_at_change_minor::int b from adex.route_capital_controller_events where id = $1', [(ch.body['event'] as Body)['eventId']]);
    assert.equal(ev.rows[0].b, base, 'Base de la ruta (Σ custodias) al cambiar');
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1, reason: 'Ya no es responsable' })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    const xBefore = await pool(xavier.membershipId);
    assert.equal((await xavier.money('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000, reason: 'Recibe el nuevo responsable' })).status, 201);
    assert.equal(await pool(xavier.membershipId), xBefore + 10_000);
    assert.equal(await pool(M.anaAdmin), anaBefore, 'la bolsa anterior no cambia');
    const own = (await ana('GET', '/v1/capital/summary')).body['admins'] as Body[];
    const anaRoutes = Number((await db.admin.query(
      `select coalesce(sum(a.balance_minor), 0)::text b from adex.capital_accounts a join adex.routes r on r.id = a.route_id
        where a.kind = 'custody' and r.capital_controller_membership_id = $1`, [M.anaAdmin])).rows[0].b);
    assert.deepEqual(own.map((a) => [a['adminId'], a['custodyUnderResponsibilityMinor']]), [[M.anaAdmin, anaRoutes]],
      'Ana responde solo por la custodia de sus rutas y no ve la bolsa de Xavier');
    assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Vuelve a Ana' })).status, 200);
  });

  test('CAP3-016 · periodo cerrado (D7): ningún asiento entra en una semana cerrada', async () => {
    const today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d as string;
    await db.admin.query(
      `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
         loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
       values ($1, $2, $3, $4::date - 1, $4::date + 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [randomUUID(), c1, r5, today]);
    assert.equal((await $ana('/v1/capital/deliveries', { routeId: r5, workerId: eva.membershipId, amountMinor: 1, reason: 'Semana cerrada' })).body['error'], 'PERIOD_CLOSED');
    assert.equal((await $ana('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: r5, fromWorkerId: carlos.membershipId, toWorkerId: eva.membershipId, amountMinor: 1, reason: 'Hacia semana cerrada' })).body['error'], 'PERIOD_CLOSED');
  });

  test('CAP3-017 · conciliación reproducible: API y SQL independiente coinciden; una manipulación se detecta', async () => {
    const api1 = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(api1['ok'], true, JSON.stringify(api1));
    assert.equal((await ana('GET', '/v1/capital/reconciliation')).status, 403);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(await reconcile(db.admin, c2), CLEAN);
    // Manipulación directa por el administrador de la base (fuera de la API): se detecta.
    const acc = (await db.admin.query(`select id from adex.capital_accounts where company_id = $1 and kind = 'company'`, [c1])).rows[0].id;
    await db.admin.query('update adex.capital_accounts set balance_minor = balance_minor + 1, version = version + 1 where id = $1', [acc]);
    const bad = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(bad['ok'], false);
    assert.deepEqual((bad['checks'] as Body[]).filter((c) => !c['ok']).map((c) => c['name']), ['positions-match-ledger', 'capital-conserved']);
    await db.admin.query('update adex.capital_accounts set balance_minor = balance_minor - 1, version = version + 1 where id = $1', [acc]);
    assert.equal((await bruno('GET', '/v1/capital/reconciliation')).body['ok'], true);
  });

  test('CAP3-018 · inmutabilidad: operaciones y patas no se modifican ni borran; la identidad de una cuenta es fija', async () => {
    for (const sql of [
      `update adex.capital_operations set amount_minor = 1`,
      `delete from adex.capital_operations`,
      `update adex.capital_entries set amount_minor = 1`,
      `delete from adex.capital_entries`,
      `truncate adex.capital_entries`,
      `delete from adex.capital_accounts`,
      `update adex.capital_accounts set kind = 'company', membership_id = null, route_id = null, version = version + 1 where kind = 'custody'`,
      `update adex.capital_accounts set balance_minor = 0 where kind = 'admin'`,
    ]) {
      await assert.rejects(db.admin.query(sql), (e: { code?: string }) => ['42501', '23514'].includes(e.code ?? ''), sql);
    }
    // Una operación sin patas, o desequilibrada, no llega a confirmarse.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query(`insert into adex.capital_operations (id, company_id, operation_id, kind, amount_minor, currency_code, reason, entry_date,
                       actor_membership_id, actor_identity_id, actor_role, txid)
                     select 'op-huerfana', $1, gen_random_uuid(), 'COMPANY_DEPOSIT', 1, 'BRL', 'sin patas', current_date, m.id, i.id, 'superadmin', txid_current()
                       from adex.memberships m join adex.identities i on i.id = m.identity_id where m.id = $2`, [c1, M.brunoSa]);
      await assert.rejects(c.query('commit'), { code: 'AX420' });
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where id = 'op-huerfana'`), 0);
  });
});
