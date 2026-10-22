// RONDA 65 (corregida en 65-C1) · desembolsos sin conexión del Cobrador (0027); clientes y solicitudes
// NO se registran sin conexión (decisión del propietario). Contra PostgreSQL real y la API. El dispositivo envía lo capturado sin internet con los MISMOS
// comandos y el mismo id de operación; el servidor decide con el estado VIGENTE (membresía,
// ruta, solicitud, custodia, periodo) y nunca fuerza un saldo. Datos 100 % sintéticos.
//
// Reglas que se verifican sin cambiarlas: el Cobrador no vende directo (lo suyo es una
// SOLICITUD que aprueba otra persona); entrega sin conexión solo lo YA aprobado, con su efectivo
// en custodia; el crédito nace una vez con su asiento; la cartera es de la ruta.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;

describe('Ronda 65-C1 · desembolsos sin conexión; clientes y solicitudes solo en línea', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let r2 = '';
  let adm: Caller;
  let bruno: Caller, gabi: Caller, carla: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, gil: Person;
  let today = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const off = (h = 1) => ({ capturedAt: hoursAgo(h) });
  const clientBody = (route = r1, document = cpf(), name = `Cliente ${randomUUID().slice(0, 6)}`) =>
    ({ routeId: route, name, documentType: 'CPF', document, phonePrimary: '1', addressPrimary: 'Rua A', addressSecondary: 'Rua B' });
  const cond = (o: Body = {}) => ({ amountMinor: 50_000, interestRate: 20, installmentsCount: 12, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6], ...o });
  const custody = (m: string, r = r1) => balance(db.admin, c1, 'custody', m, r);
  const portfolio = (r = r1) => balance(db.admin, c1, 'portfolio', null, r);
  const captureOf = async (op: string) => (await db.admin.query('select kind, entity_id, route_id, membership_id, device_captured_at from adex.offline_captures where operation_id = $1', [op])).rows;
  const opCount = (op: string) => count(db.admin, 'select 1 from adex.operations where operation_id = $1', [op]);
  const salesOfRequest = (req: string) => count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]);
  const disbursementsOf = (req: string) => count(db.admin, `select 1 from adex.capital_operations where sale_request_id = $1 and kind = 'LOAN_DISBURSEMENT'`, [req]);
  const deliver = async (who: Person, amountMinor: number, route = r1) => {
    const r = await $ana('/v1/capital/deliveries', { routeId: route, workerId: who.membershipId, amountMinor, reason: 'Base sintética' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  };
  /** Cliente (en línea, por la oficina) + solicitud del Cobrador aprobada por la Secretaria. */
  const approved = async (who: Person, o: Body = {}, route = r1) => {
    const cl = await adm('POST', '/v1/clients', clientBody(route));
    if (cl.status !== 201) throw new Error(JSON.stringify(cl.body));
    const req = await who.money('/v1/credit-requests', { routeId: route, clientId: cl.body['id'], ...cond(o) });
    if (req.status !== 201) throw new Error(JSON.stringify(req.body));
    const ok = await gabi('POST', `/v1/credit-requests/${req.body['id']}/approve`, {});
    if (ok.status !== 200) throw new Error(JSON.stringify(ok.body));
    return { clientId: cl.body['id'] as string, requestId: req.body['id'] as string, amount: Number(req.body['amountMinor']) };
  };
  // El dispositivo guarda el cuerpo UNA vez (hora de captura incluida) y reenvía siempre el mismo.
  const bodies = new Map<string, Body>();
  const disburseOffline = (who: Person, req: string, op = randomUUID(), h = 1) => {
    if (!bodies.has(op)) bodies.set(op, { offline: off(h) });
    return who.money(`/v1/credit-requests/${req}/disburse`, bodies.get(op)!, op);
  };

  before(async () => {
    db = await createTestDb('offline_sales', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    carla = caller(api, issuer, 'carla', M.carlaSa);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    // Ruta propia de la prueba para Gil y Dora (la r2 del seed no admite operaciones nuevas).
    r2 = (await bruno('POST', '/v1/routes', { name: 'Ruta Gil OFS', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    carlos = await mk('carlos-ofs@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-ofs@example.test', 'supervisor', 'Dora', [r2]);
    gil = await mk('gil-ofs@example.test', 'cobrador', 'Gil', [r2]);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('OFS-001 · 65-C1: el alta de cliente y la solicitud NO admiten captura sin conexión (ningún rol); nada se escribe', async () => {
    const known = await adm('POST', '/v1/clients', clientBody());
    for (const [who, label] of [[carlos.money, 'Cobrador'], [dora.money, 'Supervisor'], [money(bruno), 'SuperAdmin']] as const) {
      const body = { ...clientBody(), offline: off() };
      const op = randomUUID();
      const c = await who('/v1/clients', body, op);
      assert.deepEqual([c.status, c.body['error']], [400, 'UNKNOWN_FIELD'], `${label}: alta de cliente`);
      assert.equal(await count(db.admin, 'select 1 from adex.clients where document = $1', [body.document]), 0);
      assert.equal(await opCount(op), 0, 'el rechazo no consume el id');
    }
    const op = randomUUID();
    const reqs0 = await count(db.admin, 'select 1 from adex.sale_requests where client_id = $1', [known.body['id']]);
    const r = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: known.body['id'], ...cond(), offline: off() }, op);
    assert.deepEqual([r.status, r.body['error']], [400, 'UNKNOWN_FIELD'], 'solicitud');
    assert.equal(await count(db.admin, 'select 1 from adex.sale_requests where client_id = $1', [known.body['id']]), reqs0);
    assert.equal(await opCount(op), 0);
    // Tampoco la venta directa (nunca la tuvo el Cobrador).
    assert.equal((await carlos.money('/v1/credits/direct', { routeId: r1, clientId: known.body['id'], ...cond(), offline: off() })).status, 400);
    assert.equal((await captureOf(op)).length, 0);
    assert.equal(await count(db.admin, `select 1 from adex.offline_captures where kind not in ('payment', 'visit', 'expense', 'disbursement')`), 0);
  });

  test('OFS-002 · en línea, el Cobrador conserva sus permisos: alta de cliente y solicitud PENDIENTE (sin aprobación propia); reglas sin cambios', async () => {
    const cl = await carlos.money('/v1/clients', clientBody());
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const req = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond() });
    assert.deepEqual([req.status, req.body['status'], req.body['requestedBy']], [201, 'pending', carlos.membershipId]);
    assert.equal((await carlos.call('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 403, 'nadie aprueba lo suyo');
    assert.equal((await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond({ amountMinor: 10_000 }) })).status, 409, 'una pendiente por cliente');
    const ten = await adm('POST', '/v1/clients', clientBody());
    assert.equal((await carlos.money('/v1/credit-requests', { routeId: r1, clientId: ten.body['id'], ...cond({ interestRate: 10 }) })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    assert.equal((await carlos.money('/v1/clients', clientBody(r1, String(cl.body['document']).replace(/\D/g, '')))).body['error'], 'DOCUMENT_DUPLICATE');
    assert.equal((await carlos.money('/v1/credits/direct', { routeId: r1, clientId: ten.body['id'], ...cond() })).status, 403, 'sin venta directa');
  });

  test('OFS-003 · desembolso sin conexión: solo el Cobrador y siempre con id de operación', async () => {
    const a = await approved(carlos, { amountMinor: 1_000 });
    assert.equal((await money(bruno)(`/v1/credit-requests/${a.requestId}/disburse`, { offline: off() })).body['error'], 'OFFLINE_NOT_ALLOWED');
    assert.equal((await carlos.call('POST', `/v1/credit-requests/${a.requestId}/disburse`, { offline: off() })).body['error'], 'OPERATION_ID_REQUIRED');
    assert.equal((await carlos.money(`/v1/credit-requests/${a.requestId}/disburse`, { offline: { capturedAt: 'ayer' } })).status, 400);
    assert.equal(await salesOfRequest(a.requestId), 0);
  });

  test('OFS-006 · desembolso sin conexión con efectivo en custodia: crédito UNA vez, sale de su custodia, cartera de la ruta', async () => {
    await deliver(carlos, 100_000);
    const a = await approved(carlos);
    const [cust0, port0] = [await custody(carlos.membershipId), await portfolio()];
    const op = randomUUID();
    const r = await disburseOffline(carlos, a.requestId, op, 5);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const credit = r.body['credit'] as Body;
    assert.deepEqual([credit['routeId'], credit['clientId'], credit['createdBy'], credit['disbursedBy'], credit['saleRequestId'], credit['disbursementDate']],
      [r1, a.clientId, carlos.membershipId, carlos.membershipId, a.requestId, today], 'fecha contable = la de la empresa al confirmarse');
    assert.equal(await custody(carlos.membershipId), cust0 - a.amount, 'sale de SU efectivo');
    assert.equal(await portfolio(), port0 + a.amount, 'la cartera es de la ruta');
    const [cap] = await captureOf(op);
    assert.deepEqual([cap.kind, cap.entity_id, cap.route_id, cap.membership_id], ['disbursement', credit['id'], r1, carlos.membershipId]);
    // Respuesta perdida: se consulta el id y se reenvía igual → el mismo crédito, sin otro asiento.
    assert.equal((await carlos.call('GET', `/v1/operations/${op}`)).body['outcome'], 'approved');
    const again = await disburseOffline(carlos, a.requestId, op, 5);
    assert.deepEqual([again.status, (again.body['credit'] as Body)['id']], [201, credit['id']]);
    // Otro id para lo mismo (nunca lo hace el dispositivo): la solicitud ya no es desembolsable.
    assert.equal((await disburseOffline(carlos, a.requestId)).body['error'], 'REQUEST_NOT_DISBURSABLE');
    assert.deepEqual([await salesOfRequest(a.requestId), await disbursementsOf(a.requestId)], [1, 1]);
    assert.equal(await custody(carlos.membershipId), cust0 - a.amount);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-007 · sin efectivo suficiente al sincronizar: 409 y nada escrito; el MISMO registro entra cuando hay fondos', async () => {
    const have = await custody(carlos.membershipId);
    const a = await approved(carlos, { amountMinor: have + 20_000 });
    const op = randomUUID();
    const r = await disburseOffline(carlos, a.requestId, op);
    assert.deepEqual([r.status, r.body['error']], [409, 'INSUFFICIENT_FUNDS']);
    assert.deepEqual([await salesOfRequest(a.requestId), await disbursementsOf(a.requestId), await opCount(op)], [0, 0, 0]);
    assert.equal(await custody(carlos.membershipId), have, 'sin saldo negativo ni parcial');
    assert.equal((await db.admin.query('select status from adex.sale_requests where id = $1', [a.requestId])).rows[0].status, 'approved');
    // Resolución con los mecanismos existentes: la oficina le entrega efectivo; el mismo id entra una vez.
    await deliver(carlos, 20_000);
    const retry = await disburseOffline(carlos, a.requestId, op);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(await custody(carlos.membershipId), 0);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-008 · doble consumo: dos desembolsos que juntos superan la custodia → uno entra y el otro no (también a la vez)', async () => {
    await deliver(carlos, 100_000);
    const a = await approved(carlos, { amountMinor: 60_000 });
    const b = await approved(carlos, { amountMinor: 70_000 });
    const r = await Promise.all([disburseOffline(carlos, a.requestId), disburseOffline(carlos, b.requestId)]);
    const statuses = r.map((x) => x.status).sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify(r.map((x) => x.body)));
    assert.equal(r.find((x) => x.status === 409)!.body['error'], 'INSUFFICIENT_FUNDS');
    const left = await custody(carlos.membershipId);
    assert.ok(left === 40_000 || left === 30_000, `custodia ${left}`);
    assert.ok(left >= 0);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-009 · cambios en el servidor mientras estaba sin conexión: solicitud cancelada o ruta inactiva → rechazo sin dinero', async () => {
    await deliver(carlos, 100_000);
    const cancelled = await approved(carlos, { amountMinor: 10_000 });
    assert.equal((await caller(api, issuer, 'ana', M.anaAdmin)('POST', `/v1/credit-requests/${cancelled.requestId}/cancel`, { reason: 'No se entrega' })).status, 200);
    const c0 = await custody(carlos.membershipId);
    assert.equal((await disburseOffline(carlos, cancelled.requestId)).body['error'], 'REQUEST_NOT_DISBURSABLE');
    const inactive = await approved(carlos, { amountMinor: 10_000 });
    const st = await bruno('POST', `/v1/routes/${r1}/status`, { status: 'inactiva' });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    try {
      const r = await disburseOffline(carlos, inactive.requestId);
      assert.equal(r.status, 409, JSON.stringify(r.body));
    } finally {
      assert.equal((await bruno('POST', `/v1/routes/${r1}/status`, { status: 'activa' })).status, 200);
    }
    assert.equal(await custody(carlos.membershipId), c0);
    assert.deepEqual([await salesOfRequest(cancelled.requestId), await salesOfRequest(inactive.requestId)], [0, 0]);
  });

  test('OFS-010 · Cobrador bloqueado antes de sincronizar: el desembolso pendiente se rechaza sin escribir nada; reactivado, entra una vez', async () => {
    await deliver(carlos, 50_000);
    const a = await approved(carlos, { amountMinor: 10_000 });
    const op = randomUUID();
    const c0 = await custody(carlos.membershipId);
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`, {})).status, 200);
    try {
      const r = await disburseOffline(carlos, a.requestId, op);
      assert.deepEqual([r.status, r.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
      assert.equal(await opCount(op), 0);
      assert.equal(await salesOfRequest(a.requestId), 0);
      assert.equal(await custody(carlos.membershipId), c0);
    } finally {
      assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/reactivate`, {})).status, 200);
    }
    assert.equal((await disburseOffline(carlos, a.requestId, op)).status, 201);
    assert.equal(await salesOfRequest(a.requestId), 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-011 · ruta quitada al Cobrador: su desembolso pendiente no se aplica', async () => {
    await deliver(gil, 30_000, r2);
    const cl = await adm('POST', '/v1/clients', clientBody(r2));
    const req = await gil.money('/v1/credit-requests', { routeId: r2, clientId: cl.body['id'], ...cond({ amountMinor: 10_000 }) });
    // Aprueba la Administradora de esa ruta (otra persona).
    assert.equal((await caller(api, issuer, 'ana', M.anaAdmin)('POST', `/v1/credit-requests/${req.body['id']}/approve`, {})).status, 200);
    assert.equal((await bruno('PUT', `/v1/members/${gil.membershipId}/routes`, { routeIds: [] })).status, 200);
    try {
      const r = await disburseOffline(gil, req.body['id'] as string);
      assert.ok([403, 404].includes(r.status), JSON.stringify(r.body));
      assert.equal(await salesOfRequest(req.body['id'] as string), 0);
    } finally {
      assert.equal((await bruno('PUT', `/v1/members/${gil.membershipId}/routes`, { routeIds: [r2] })).status, 200);
    }
  });

  test('OFS-012 · aislamiento: un id de otra empresa no existe; otra empresa no ve las capturas', async () => {
    const a = await approved(carlos, { amountMinor: 1_000 });
    // SuperAdmin de otra empresa: la solicitud no existe para ella.
    const r = await money(carla)(`/v1/credit-requests/${a.requestId}/disburse`, {});
    assert.equal(r.status, 404);
    assert.equal((await carla('GET', `/v1/credit-requests/${a.requestId}`)).status, 404);
    // Las capturas de c1 no son legibles por la API (solo inserción) ni aparecen en c2.
    assert.equal(await count(db.admin, `select 1 from adex.offline_captures where company_id = $1`, [companyId('c2')]), 0);
  });

  test('OFS-013 · la cartera es de la ruta: venta de la oficina para la ruta del Cobrador sale de la bolsa del responsable', async () => {
    const cl = await adm('POST', '/v1/clients', clientBody());
    const c0 = await custody(carlos.membershipId);
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: cl.body['id'], ...cond({ amountMinor: 20_000 }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const credit = r.body['credit'] as Body;
    assert.deepEqual([credit['routeId'], credit['createdBy'], credit['disbursedBy'], credit['disbursedByCollectorId']], [r1, M.anaAdmin, M.anaAdmin, null]);
    assert.equal(await custody(carlos.membershipId), c0, 'no se crea custodia ficticia del Cobrador');
    // El Cobrador de la ruta la ve y la cobra (responsable de la cartera de su ruta).
    const mine = await carlos.call('GET', `/v1/credits?routeId=${r1}`);
    assert.ok((mine.body['credits'] as Body[]).some((x) => x['id'] === credit['id']));
    assert.equal((await carlos.money('/v1/collections', { saleId: credit['id'], amountMinor: 1_000, offline: off() })).status, 201);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-014 · un desembolso en línea del Cobrador no cambia: mismo cuerpo vacío, mismo resultado', async () => {
    await deliver(carlos, 10_000);
    const a = await approved(carlos, { amountMinor: 5_000 });
    const r = await carlos.money(`/v1/credit-requests/${a.requestId}/disburse`, {});
    assert.equal(r.status, 201);
    assert.equal(r.body['offline'], undefined, 'en línea no lleva marca de captura');
    assert.equal((await captureOf(r.operationId)).length, 0);
    assert.equal((await carlos.money(`/v1/credit-requests/${a.requestId}/disburse`, { otro: 1 })).body['error'], 'UNKNOWN_FIELD');
  });
});
