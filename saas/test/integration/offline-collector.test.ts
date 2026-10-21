// RONDA 62 · modo sin conexión del Cobrador (0026) contra PostgreSQL real y la API.
// El dispositivo envía lo capturado sin internet con los MISMOS comandos y el mismo id de
// operación; el servidor decide con el estado VIGENTE (membresía, ruta, crédito) y nunca
// reescribe importes. Datos 100 % sintéticos.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';
import { parseOffline } from '../../src/offline/capture.ts';

type Body = Record<string, unknown>;

describe('Ronda 62 · modo sin conexión del Cobrador', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let r2 = '';
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, gil: Person;
  let today = '';
  let category = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const credit = async (route = r1, amountMinor = 50_000) => {
    const cl = await bruno('POST', '/v1/clients', { routeId: route, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (cl.status !== 201) throw new Error(JSON.stringify(cl.body));
    const r = await $ana('/v1/credits/direct', { routeId: route, clientId: cl.body['id'], amountMinor, interestRate: 20,
      installmentsCount: 12, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const balanceOf = async (sale: string) => Number((await db.admin.query('select balance_minor from adex.sales where id = $1', [sale])).rows[0].balance_minor);
  const paymentsOf = (sale: string) => count(db.admin, 'select 1 from adex.payments where sale_id = $1', [sale]);
  const captureOf = async (op: string) => (await db.admin.query('select kind, entity_id, route_id, membership_id, device_captured_at, known_balance_minor, note from adex.offline_captures where operation_id = $1', [op])).rows;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const visit = (who: Person, body: Body, op = randomUUID()) => who.call('POST', '/v1/no-payment-visits', body, { 'x-adex-operation-id': op });

  before(async () => {
    db = await createTestDb('offline_collector', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    carlos = await newPerson(api, issuer, provider.ids, bruno, { email: 'carlos-off@example.test', role: 'cobrador', displayName: 'Carlos', routeIds: [r1] });
    dora = await newPerson(api, issuer, provider.ids, bruno, { email: 'dora-off@example.test', role: 'supervisor', displayName: 'Dora', routeIds: [r1] });
    r2 = (await bruno('POST', '/v1/routes', { name: 'Ruta Gil OFF', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    gil = await newPerson(api, issuer, provider.ids, bruno, { email: 'gil-off@example.test', role: 'cobrador', displayName: 'Gil', routeIds: [r2] });
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
    const cats = await bruno('GET', '/v1/expense-categories');
    category = ((cats.body['categories'] as Body[]).find((c) => c['active'] !== false) ?? {})['id'] as string;
    if (!category) {
      const c = await $bruno('/v1/expense-categories', { name: 'Combustible' });
      category = c.body['id'] as string;
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('OFF-001 · abono capturado hace 6 h sin conexión: se registra HOY, guarda la hora del dispositivo y la ubicación de la captura', async () => {
    const s = await credit();
    const before = await balanceOf(s);
    const captured = hoursAgo(6);
    const body = { saleId: s, amountMinor: 5_000, offline: { capturedAt: captured, knownBalanceMinor: before },
      location: { status: 'captured', lat: -23.55052, lng: -46.633308, accuracyM: 20, capturedAt: captured } };
    const r = await carlos.money('/v1/collections', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body['appliedMinor'], 5_000);
    assert.equal(r.body['capped'], false);
    assert.equal(r.body['paymentDate'], today, 'la fecha contable es la de la empresa al confirmarse');
    assert.deepEqual(r.body['offline'], { deviceCapturedAt: new Date(captured).toISOString() });
    assert.deepEqual(r.body['location'], { status: 'captured' }, 'la hora GPS se compara con la de la captura, no con la de llegada');
    const [cap] = await captureOf(r.operationId);
    assert.deepEqual([cap.kind, cap.entity_id, cap.route_id, cap.membership_id, Number(cap.known_balance_minor), cap.note],
      ['payment', r.body['paymentId'], r1, carlos.membershipId, before, null]);
    assert.equal((cap.device_captured_at as Date).toISOString(), new Date(captured).toISOString());
    const loc = (await db.admin.query('select status, device_captured_at from adex.payment_locations where payment_id = $1', [r.body['paymentId']])).rows[0];
    assert.equal(loc.status, 'captured');
    assert.equal((loc.device_captured_at as Date).toISOString(), new Date(captured).toISOString());
    const audit = (await db.admin.query(`select metadata from adex.audit_log where action = 'REGISTER_PAYMENT' and entity_id = $1`, [r.body['paymentId']])).rows[0].metadata;
    assert.equal(audit.offline.deviceCapturedAt, new Date(captured).toISOString());
    assert.equal(audit.offline.balanceAtSync, before);
    assert.equal(await balanceOf(s), before - 5_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFF-002 · un abono sin conexión que ya no cabe en el saldo se RECHAZA para revisión: nunca se topa ni se reescribe', async () => {
    const s = await credit();
    const total = await balanceOf(s);
    // La oficina (Administradora) cobra casi todo mientras el Cobrador estaba sin conexión.
    const office = await $ana('/v1/collections', { saleId: s, amountMinor: total - 1_000, collectorId: carlos.membershipId });
    assert.equal(office.status, 201, JSON.stringify(office.body));
    const op = randomUUID();
    const body = { saleId: s, amountMinor: 5_000, offline: { capturedAt: hoursAgo(2), knownBalanceMinor: total } };
    const r = await carlos.money('/v1/collections', body, op);
    assert.deepEqual([r.status, r.body['error']], [409, 'OFFLINE_AMOUNT_EXCEEDS_BALANCE']);
    assert.deepEqual(r.body['details'], { balanceMinor: 1_000, requestedMinor: 5_000 });
    assert.equal(await paymentsOf(s), 1, 'solo el abono de la oficina');
    assert.equal(await count(db.admin, 'select 1 from adex.operations where operation_id = $1', [op]), 0, 'el rechazo no consume el id');
    assert.equal((await carlos.call('GET', `/v1/operations/${op}`)).status, 404);
    // El mismo abono reenviado (mismo id y cuerpo) recibe la misma respuesta: no hay registro parcial.
    const again = await carlos.money('/v1/collections', body, op);
    assert.deepEqual([again.status, again.body['error']], [409, 'OFFLINE_AMOUNT_EXCEEDS_BALANCE']);
    // En línea, el mismo importe sí se topa (comportamiento vigente, sin cambios).
    const online = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
    assert.deepEqual([online.status, online.body['capped'], online.body['appliedMinor']], [201, true, 1_000]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFF-003 · reintentos, doble envío simultáneo y respuesta perdida: exactamente un abono', async () => {
    const s = await credit();
    const op = randomUUID();
    const body = { saleId: s, amountMinor: 4_000, offline: { capturedAt: hoursAgo(1) }, location: { status: 'denied', reason: 'permiso denegado' } };
    const rs = await Promise.all(Array.from({ length: 5 }, () => carlos.money('/v1/collections', body, op)));
    assert.ok(rs.every((x) => x.status === 201), JSON.stringify(rs.map((x) => x.status)));
    assert.equal(new Set(rs.map((x) => x.body['paymentId'])).size, 1);
    assert.equal(await paymentsOf(s), 1);
    // «Respuesta perdida»: el dispositivo consulta por el id antes de reenviar.
    const known = await carlos.call('GET', `/v1/operations/${op}`);
    assert.equal(known.status, 200);
    assert.equal((known.body['result'] as Body)['paymentId'], rs[0]!.body['paymentId']);
    const later = await carlos.money('/v1/collections', body, op);
    assert.equal(later.body['paymentId'], rs[0]!.body['paymentId']);
    assert.equal(await paymentsOf(s), 1);
    assert.equal(await count(db.admin, 'select 1 from adex.offline_captures where operation_id = $1', [op]), 1);
    // El mismo id con otro cuerpo (otra hora de captura) es otra operación: se rechaza.
    const other = await carlos.money('/v1/collections', { ...body, offline: { capturedAt: hoursAgo(3) } }, op);
    assert.deepEqual([other.status, other.body['error']], [409, 'OPERATION_ID_REUSED']);
    assert.equal(await paymentsOf(s), 1);
  });

  test('OFF-004 · visita sin pago sin conexión: no crea abono, no toca saldo ni libro, guarda la captura; idempotente', async () => {
    const s = await credit();
    const before = await balanceOf(s);
    const opsBefore = await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1', [c1]);
    const op = randomUUID();
    const body = { saleId: s, reason: 'no_estaba', note: 'Cerrado', offline: { capturedAt: hoursAgo(4) } };
    const a = await visit(carlos, body, op);
    const b = await visit(carlos, body, op);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.body['id'], a.body['id']);
    assert.equal(a.body['visitDate'], today);
    assert.equal(await count(db.admin, 'select 1 from adex.no_payment_visits where sale_id = $1', [s]), 1);
    assert.equal(await paymentsOf(s), 0);
    assert.equal(await balanceOf(s), before);
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1', [c1]), opsBefore);
    const [cap] = await captureOf(op);
    assert.deepEqual([cap.kind, cap.entity_id, cap.membership_id], ['visit', a.body['id'], carlos.membershipId]);
    const list = await carlos.call('GET', `/v1/no-payment-visits?saleId=${s}`);
    assert.deepEqual((list.body['visits'] as Body[]).map((v) => v['id']), [a.body['id']]);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFF-005 · gasto propio sin conexión: lo paga su custodia (puede quedar negativa), guarda la captura; solo gastos propios', async () => {
    const custody0 = await balance(db.admin, c1, 'custody', carlos.membershipId, r1);
    const body = { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: category, amountMinor: 900_000,
      description: 'Combustible', offline: { capturedAt: hoursAgo(5) } };
    const r = await carlos.money('/v1/expenses', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await balance(db.admin, c1, 'custody', carlos.membershipId, r1), custody0 - 900_000);
    assert.ok(custody0 - 900_000 < 0, 'el gasto del trabajador puede dejar su posición negativa (73209ce)');
    const [cap] = await captureOf(r.operationId);
    assert.deepEqual([cap.kind, cap.entity_id], ['expense', (r.body['expense'] as Body)['id']]);
    const again = await carlos.money('/v1/expenses', body, r.operationId);
    assert.equal((again.body['expense'] as Body)['id'], (r.body['expense'] as Body)['id']);
    // Sin conexión no se registran gastos de ruta ni a cargo de otra persona.
    const ruta = await carlos.money('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: category, amountMinor: 100, offline: { capturedAt: hoursAgo(1) } });
    assert.equal(ruta.status, 400);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFF-006 · bloqueo posterior: Cobrador desactivado antes de sincronizar → nada se registra; reactivado → se registra una vez', async () => {
    const s = await credit();
    const op = randomUUID();
    const body = { saleId: s, amountMinor: 3_000, offline: { capturedAt: hoursAgo(3) } };
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`, {})).status, 200);
    const r = await carlos.money('/v1/collections', body, op);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body['error'], 'MEMBERSHIP_INACTIVE');
    assert.equal(await paymentsOf(s), 0);
    const v = await visit(carlos, { saleId: s, reason: 'sin_dinero', offline: { capturedAt: hoursAgo(3) } });
    assert.equal(v.status, 403);
    assert.equal((await carlos.call('POST', '/v1/offline/key', {})).status, 403, 'bloqueado: no obtiene la llave del dispositivo');
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/reactivate`, {})).status, 200);
    const ok = await carlos.money('/v1/collections', body, op);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await paymentsOf(s), 1);
  });

  test('OFF-007 · cambio de responsable: con la ruta quitada (o dada a otro Cobrador), sus pendientes no se registran', async () => {
    const s = await credit(r2);
    const body = { saleId: s, amountMinor: 2_000, offline: { capturedAt: hoursAgo(2) } };
    // Gil tenía r2; la oficina se la quita.
    assert.equal((await bruno('PUT', `/v1/members/${gil.membershipId}/routes`, { routeIds: [] })).status, 200);
    const r = await gil.money('/v1/collections', body);
    assert.ok([403, 404].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(await paymentsOf(s), 0);
    const v = await visit(gil, { saleId: s, reason: 'no_estaba', offline: { capturedAt: hoursAgo(2) } });
    assert.ok([403, 404].includes(v.status));
    const e = await gil.money('/v1/expenses', { scope: 'trabajador', routeId: r2, workerId: gil.membershipId, categoryId: category, amountMinor: 100, offline: { capturedAt: hoursAgo(2) } });
    assert.ok([403, 404].includes(e.status), `${e.status}`);
    assert.equal((await bruno('PUT', `/v1/members/${gil.membershipId}/routes`, { routeIds: [r2] })).status, 200);
  });

  test('OFF-008 · cambios de la oficina: crédito liquidado → abono y visita rechazados; ruta inactiva → rechazados (también la visita)', async () => {
    const s = await credit();
    const total = await balanceOf(s);
    assert.equal((await $ana('/v1/collections', { saleId: s, amountMinor: total, collectorId: carlos.membershipId })).status, 201);
    const p = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, offline: { capturedAt: hoursAgo(1) } });
    assert.equal(p.status, 409);
    assert.ok(['CREDIT_NOT_ACTIVE', 'CREDIT_NO_BALANCE', 'OFFLINE_AMOUNT_EXCEEDS_BALANCE'].includes(String(p.body['error'])), String(p.body['error']));
    const v = await visit(carlos, { saleId: s, reason: 'no_estaba', offline: { capturedAt: hoursAgo(1) } });
    assert.deepEqual([v.status, v.body['error']], [409, 'CREDIT_NOT_ACTIVE']);

    const s2 = await credit();
    assert.equal((await bruno('POST', `/v1/routes/${r1}/status`, { status: 'inactiva' })).status, 200);
    try {
      const p2 = await carlos.money('/v1/collections', { saleId: s2, amountMinor: 1_000, offline: { capturedAt: hoursAgo(1) } });
      assert.deepEqual([p2.status, p2.body['error']], [409, 'ROUTE_NOT_OPERATIONAL']);
      // Ronda 62: la visita también exige ruta operativa (antes se admitía en una ruta inactiva).
      const v2 = await visit(carlos, { saleId: s2, reason: 'no_estaba' });
      assert.deepEqual([v2.status, v2.body['error']], [409, 'ROUTE_NOT_OPERATIONAL']);
      assert.equal(await paymentsOf(s2), 0);
    } finally {
      assert.equal((await bruno('POST', `/v1/routes/${r1}/status`, { status: 'activa' })).status, 200);
    }
  });

  test('OFF-009 · solo el Cobrador opera sin conexión: Supervisor y Administrador reciben OFFLINE_NOT_ALLOWED', async () => {
    const s = await credit();
    const sup = await dora.money('/v1/collections', { saleId: s, amountMinor: 1_000, offline: { capturedAt: hoursAgo(1) } });
    assert.equal(sup.status, 409, 'Dora choca antes con la exclusividad de la ruta');
    const adm = await $ana('/v1/collections', { saleId: s, amountMinor: 1_000, collectorId: carlos.membershipId, offline: { capturedAt: hoursAgo(1) } });
    assert.deepEqual([adm.status, adm.body['error']], [403, 'OFFLINE_NOT_ALLOWED']);
    const admKey = await caller(api, issuer, 'ana', M.anaAdmin)('POST', '/v1/offline/key', {});
    assert.equal(admKey.status, 403);
    assert.equal(await paymentsOf(s), 0);
  });

  test('OFF-010 · exclusividad: el Supervisor no cobra ni visita en una ruta con Cobrador activo; tras bloquearlo, sí', async () => {
    const s = await credit();
    const p = await dora.money('/v1/collections', { saleId: s, amountMinor: 1_000 });
    assert.deepEqual([p.status, p.body['error']], [409, 'ROUTE_HAS_ACTIVE_COLLECTOR']);
    const v = await visit(dora, { saleId: s, reason: 'no_estaba' });
    assert.deepEqual([v.status, v.body['error']], [409, 'ROUTE_HAS_ACTIVE_COLLECTOR']);
    assert.equal(await paymentsOf(s), 0);
    // La oficina sigue registrando cobros a nombre del Cobrador (operación de oficina).
    assert.equal((await $ana('/v1/collections', { saleId: s, amountMinor: 1_000, collectorId: carlos.membershipId })).status, 201);
    // Bloqueo previo del Cobrador → el Supervisor lo sustituye.
    assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/deactivate`, {})).status, 200);
    try {
      const p2 = await dora.money('/v1/collections', { saleId: s, amountMinor: 1_000 });
      assert.equal(p2.status, 201, JSON.stringify(p2.body));
      const v2 = await visit(dora, { saleId: s, reason: 'sin_dinero' });
      assert.equal(v2.status, 201, JSON.stringify(v2.body));
    } finally {
      assert.equal((await bruno('POST', `/v1/members/${carlos.membershipId}/reactivate`, {})).status, 200);
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('OFF-011 · llave del dispositivo: 32 bytes, estable por membresía, distinta entre Cobradores, sin lectura directa', async () => {
    const a = await carlos.call('POST', '/v1/offline/key', {});
    const b = await carlos.call('POST', '/v1/offline/key', {});
    const g = await gil.call('POST', '/v1/offline/key', {});
    assert.deepEqual([a.status, b.status, g.status], [200, 200, 200]);
    assert.equal(Buffer.from(String(a.body['key']), 'base64').length, 32);
    assert.equal(a.body['key'], b.body['key']);
    assert.notEqual(a.body['key'], g.body['key']);
    // Ni la API (adex_api) ni otra membresía leen la tabla directamente.
    await assert.rejects(db.api.query('select key from adex.offline_keys'));
    assert.equal((await dora.call('POST', '/v1/offline/key', {})).status, 403);
  });

  test('OFF-012 · forma de `offline`: inválida → 400 sin registrar nada; reloj del dispositivo fuera de rango → se registra sin su hora', async () => {
    const s = await credit();
    for (const offline of [null, 'ayer', {}, { capturedAt: 'no-es-fecha' }, { capturedAt: hoursAgo(1), extra: 1 }, { capturedAt: hoursAgo(1), knownBalanceMinor: -5 }]) {
      const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, offline });
      assert.equal(r.status, 400, JSON.stringify(offline));
    }
    assert.equal(await paymentsOf(s), 0);
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 1_000, offline: { capturedAt: future } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((r.body['offline'] as Body)['deviceCapturedAt'], null);
    const [cap] = await captureOf(r.operationId);
    assert.equal(cap.device_captured_at, null);
    assert.match(String(cap.note), /fuera de rango/);
    assert.equal(parseOffline(undefined), null);
  });

  test('OFF-013 · evidencia append-only: sin UPDATE ni DELETE; aislada por empresa', async () => {
    await assert.rejects(db.admin.query(`update adex.offline_captures set note = 'x' where company_id = $1`, [c1]));
    await assert.rejects(db.admin.query(`delete from adex.offline_captures where company_id = $1`, [c1]));
    const other = caller(api, issuer, 'carla', M.carlaSa);
    const r = await other('GET', `/v1/no-payment-visits`);
    assert.ok(r.status === 403 || (r.body['visits'] as Body[]).every((v) => v['routeId'] !== r1));
  });
});
