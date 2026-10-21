// RONDA 65 · sin conexión del Cobrador: clientes, solicitudes de crédito y desembolsos (0027),
// contra PostgreSQL real y la API. El dispositivo envía lo capturado sin internet con los MISMOS
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

describe('Ronda 65 · clientes, solicitudes y desembolsos sin conexión', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let r2 = '';
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
    const cl = await bruno('POST', '/v1/clients', clientBody(route));
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

  test('OFS-001 · cliente sin conexión: se registra con la regla de siempre, guarda la captura y un reintento no lo duplica', async () => {
    const body = { ...clientBody(), offline: off(3) };
    const op = randomUUID();
    const r = await carlos.money('/v1/clients', body, op);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body['routeId'], r1);
    assert.equal(r.body['status'], 'activo');
    assert.deepEqual(r.body['offline'], { deviceCapturedAt: new Date(body.offline.capturedAt).toISOString() });
    const [cap] = await captureOf(op);
    assert.deepEqual([cap.kind, cap.entity_id, cap.route_id, cap.membership_id], ['client', r.body['id'], r1, carlos.membershipId]);
    // Reintento (respuesta perdida): mismo id y mismo cuerpo → el MISMO cliente, sin otro registro.
    const again = await carlos.money('/v1/clients', body, op);
    assert.deepEqual([again.status, again.body['id']], [201, r.body['id']]);
    assert.equal(await count(db.admin, 'select 1 from adex.clients where document = $1', [body.document]), 1);
    assert.equal((await carlos.call('GET', `/v1/operations/${op}`)).body['outcome'], 'approved');
    // Mismo id con otro cuerpo: nunca se reaprovecha para otra cosa.
    assert.equal((await carlos.money('/v1/clients', { ...body, name: 'Otro' }, op)).body['error'], 'OPERATION_ID_REUSED');
    const audit = (await db.admin.query(`select metadata from adex.audit_log where action = 'CREATE_CLIENT' and entity_id = $1`, [r.body['id']])).rows[0].metadata;
    assert.equal(audit.operationId, op);
    assert.equal(audit.offline.stored, 'stored');
  });

  test('OFS-002 · documento ya registrado: 409 sin duplicar ni tocar el cliente existente; el id no se consume', async () => {
    const doc = cpf();
    const first = await bruno('POST', '/v1/clients', clientBody(r1, doc, 'Original'));
    assert.equal(first.status, 201);
    const before = (await db.admin.query('select * from adex.clients where id = $1', [first.body['id']])).rows[0];
    const op = randomUUID();
    // Mismo número con otra forma de escribirlo (normalización de CLEAN).
    const variant = `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`;
    const r = await carlos.money('/v1/clients', { ...clientBody(r1, variant, 'Duplicado'), offline: off() }, op);
    assert.deepEqual([r.status, r.body['error']], [409, 'DOCUMENT_DUPLICATE']);
    assert.equal(await opCount(op), 0, 'el rechazo no consume el id');
    assert.equal((await captureOf(op)).length, 0);
    const now = (await db.admin.query('select * from adex.clients where id = $1', [first.body['id']])).rows[0];
    assert.deepEqual(now, before, 'el cliente existente no cambia');
  });

  test('OFS-003 · solo el Cobrador captura sin conexión, siempre con id de operación y en SU ruta', async () => {
    const body = { ...clientBody(r2), offline: off() };
    assert.equal((await money(bruno)('/v1/clients', body)).body['error'], 'OFFLINE_NOT_ALLOWED', 'SuperAdmin');
    assert.equal((await dora.money('/v1/clients', body)).body['error'], 'OFFLINE_NOT_ALLOWED', 'Supervisor');
    assert.equal((await gil.call('POST', '/v1/clients', body)).body['error'], 'OPERATION_ID_REQUIRED', 'sin id no hay evidencia');
    const foreign = await carlos.money('/v1/clients', body);
    assert.equal(foreign.status, 403, 'ruta no autorizada');
    assert.equal(await count(db.admin, 'select 1 from adex.clients where document = $1', [body.document]), 0);
    // Forma inválida de `offline`.
    assert.equal((await gil.money('/v1/clients', { ...clientBody(r2), offline: { capturedAt: 'ayer' } })).status, 400);
  });

  test('OFS-004 · cliente nuevo → solicitud sin conexión: queda PENDIENTE de aprobación, de la ruta y del Cobrador; sin dinero', async () => {
    const opClient = randomUUID();
    const cl = await carlos.money('/v1/clients', { ...clientBody(), offline: off(2) }, opClient);
    assert.equal(cl.status, 201);
    const opReq = randomUUID();
    const body = { routeId: r1, clientId: cl.body['id'], ...cond(), offline: off(2) };
    const ops0 = await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1', [c1]);
    const r = await carlos.money('/v1/credit-requests', body, opReq);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body['status'], r.body['routeId'], r.body['clientId'], r.body['requestedBy']], ['pending', r1, cl.body['id'], carlos.membershipId]);
    assert.equal(r.body['approved'], null, 'sin conexión nada se aprueba');
    const [cap] = await captureOf(opReq);
    assert.deepEqual([cap.kind, cap.entity_id, cap.membership_id], ['credit_request', r.body['id'], carlos.membershipId]);
    // Reintento idéntico: la MISMA solicitud.
    const again = await carlos.money('/v1/credit-requests', body, opReq);
    assert.deepEqual([again.status, again.body['id']], [201, r.body['id']]);
    assert.equal(await count(db.admin, 'select 1 from adex.sale_requests where client_id = $1', [cl.body['id']]), 1);
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1', [c1]), ops0, 'una solicitud no mueve dinero');
    // Nadie aprueba lo suyo; tampoco sin conexión.
    assert.equal((await carlos.call('POST', `/v1/credit-requests/${r.body['id']}/approve`, {})).status, 403);
    // Sin aprobar, entregar el dinero no es posible.
    const d = await disburseOffline(carlos, r.body['id'] as string);
    assert.deepEqual([d.status, d.body['error']], [409, 'REQUEST_NOT_DISBURSABLE']);
  });

  test('OFS-005 · reglas de la solicitud sin cambios: tasa del Cobrador, segunda solicitud del mismo cliente, cliente de otra ruta', async () => {
    const cl = await bruno('POST', '/v1/clients', clientBody());
    const ten = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond({ interestRate: 10 }), offline: off() });
    assert.deepEqual([ten.status, ten.body['error']], [400, 'INTEREST_RATE_NOT_ALLOWED']);
    const ok = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond(), offline: off() });
    assert.equal(ok.status, 201);
    const second = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: cl.body['id'], ...cond({ amountMinor: 10_000 }), offline: off() });
    assert.equal(second.status, 409, 'una sola solicitud pendiente por cliente');
    const other = await bruno('POST', '/v1/clients', clientBody(r2));
    assert.equal((await carlos.money('/v1/credit-requests', { routeId: r1, clientId: other.body['id'], ...cond(), offline: off() })).status, 404);
    // Fecha de inicio anterior a la fecha de la empresa al sincronizar: rechazada (regla vigente).
    const old = await bruno('POST', '/v1/clients', clientBody());
    const past = await carlos.money('/v1/credit-requests', { routeId: r1, clientId: old.body['id'], ...cond({ startDate: '2020-01-02' }), offline: off() });
    assert.deepEqual([past.status, past.body['error']], [400, 'INVALID_CONDITIONS']);
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
      const c = await carlos.money('/v1/clients', { ...clientBody(), offline: off() });
      assert.deepEqual([c.status, c.body['error']], [409, 'ROUTE_NOT_OPERATIONAL']);
    } finally {
      assert.equal((await bruno('POST', `/v1/routes/${r1}/status`, { status: 'activa' })).status, 200);
    }
    assert.equal(await custody(carlos.membershipId), c0);
    assert.deepEqual([await salesOfRequest(cancelled.requestId), await salesOfRequest(inactive.requestId)], [0, 0]);
  });

  test('OFS-010 · Cobrador bloqueado antes de sincronizar: cliente, solicitud y desembolso pendientes se rechazan sin escribir nada', async () => {
    await deliver(carlos, 50_000);
    const a = await approved(carlos, { amountMinor: 10_000 });
    const known = await bruno('POST', '/v1/clients', clientBody());
    const pend = { client: { ...clientBody(), offline: off() }, request: { routeId: r1, clientId: known.body['id'], ...cond(), offline: off() } };
    const ops = { client: randomUUID(), request: randomUUID(), disburse: randomUUID() };
    const c0 = await custody(carlos.membershipId);
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`, {})).status, 200);
    try {
      for (const r of [await carlos.money('/v1/clients', pend.client, ops.client), await carlos.money('/v1/credit-requests', pend.request, ops.request),
        await disburseOffline(carlos, a.requestId, ops.disburse)]) {
        assert.deepEqual([r.status, r.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
      }
      assert.deepEqual([await opCount(ops.client), await opCount(ops.request), await opCount(ops.disburse)], [0, 0, 0]);
      assert.equal(await count(db.admin, 'select 1 from adex.clients where document = $1', [pend.client.document]), 0);
      assert.equal(await salesOfRequest(a.requestId), 0);
      assert.equal(await custody(carlos.membershipId), c0);
    } finally {
      assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/reactivate`, {})).status, 200);
    }
    // Reactivado (decisión de la oficina), los MISMOS registros entran una vez.
    assert.equal((await carlos.money('/v1/clients', pend.client, ops.client)).status, 201);
    assert.equal((await disburseOffline(carlos, a.requestId, ops.disburse)).status, 201);
    assert.equal(await salesOfRequest(a.requestId), 1);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFS-011 · ruta quitada al Cobrador: su desembolso pendiente no se aplica', async () => {
    await deliver(gil, 30_000, r2);
    const cl = await bruno('POST', '/v1/clients', clientBody(r2));
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
    const cl = await bruno('POST', '/v1/clients', clientBody());
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
