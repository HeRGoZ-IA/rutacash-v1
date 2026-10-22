// RONDA 48 · ubicación del cobro (0022) contra PostgreSQL real y la API.
// La ubicación es evidencia complementaria y dato NO confiable: nunca bloquea un abono
// legítimo, nunca se inventa, viaja en el mismo comando idempotente y queda aislada por
// empresa, sin lectura por la API ni por el plano Owner. Datos 100 % sintéticos.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';
import { money, newPerson, type Money, type Person } from '../helpers/phase3.ts';
import { parseLocation, paymentLocationsReady } from '../../src/collections/location.ts';

type Body = Record<string, unknown>;

describe('Ronda 48 · ubicación del cobro', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let adm: Caller;
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person;
  let today = '';

  const cpf = () => String(randomInt(10_000_000_000, 99_999_999_999));
  const credit = async () => {
    const cl = await adm('POST', '/v1/clients', { routeId: r1, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF', document: cpf(), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (cl.status !== 201) throw new Error(JSON.stringify(cl.body));
    const r = await $ana('/v1/credits/direct', { routeId: r1, clientId: cl.body['id'], amountMinor: 50_000, interestRate: 20,
      installmentsCount: 12, frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const locationOf = async (paymentId: string) =>
    (await db.admin.query(`select status, lat, lng, accuracy_m, device_captured_at, reason, captured_by_membership_id m, route_id
                             from adex.payment_locations where payment_id = $1`, [paymentId])).rows;
  const paymentsOf = (sale: string) => count(db.admin, 'select 1 from adex.payments where sale_id = $1', [sale]);
  const nowIso = () => new Date().toISOString();

  before(async () => {
    db = await createTestDb('collections_location', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds: [r1] });
    carlos = await mk('carlos-loc@example.test', 'cobrador', 'Carlos');
    dora = await mk('dora-loc@example.test', 'supervisor', 'Dora');
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 3_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('LOC-001 · ubicación real: se guarda con el abono, la confirma el servidor y la auditoría lleva solo el estado', async () => {
    const s = await credit();
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000,
      location: { status: 'captured', lat: -23.55052, lng: -46.633308, accuracyM: 18, capturedAt: nowIso() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body['location'], { status: 'captured' });
    const paymentId = r.body['paymentId'] as string;
    const [row] = await locationOf(paymentId);
    assert.deepEqual([row.status, row.lat, row.lng, row.accuracy_m, row.m, row.route_id, row.reason], ['captured', -23.55052, -46.633308, 18, carlos.membershipId, r1, null]);
    assert.ok(row.device_captured_at instanceof Date);
    const audit = (await db.admin.query(`select metadata from adex.audit_log where action = 'REGISTER_PAYMENT' and entity_id = $1`, [paymentId])).rows[0].metadata;
    assert.equal(audit.locationStatus, 'captured');
    assert.ok(!JSON.stringify(audit).includes('-23.55'), 'las coordenadas no se copian a la auditoría');
  });

  test('LOC-002 · permiso denegado, GPS ausente, tiempo agotado y sitio sin soporte: el abono pasa y se guarda la causa, sin coordenadas', async () => {
    for (const status of ['denied', 'unavailable', 'timeout', 'unsupported'] as const) {
      const s = await credit();
      const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000, location: { status, reason: `motivo ${status}` } });
      assert.equal(r.status, 201, `${status}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body['location'], { status });
      const [row] = await locationOf(r.body['paymentId'] as string);
      assert.deepEqual([row.status, row.lat, row.lng, row.accuracy_m, row.reason], [status, null, null, null, `motivo ${status}`]);
      assert.equal(await paymentsOf(s), 1);
    }
  });

  test('LOC-003 · lecturas imposibles o malformadas: el abono pasa y la ubicación queda «invalid», sin coordenadas', async () => {
    const malas: unknown[] = [
      { status: 'captured', lat: 200, lng: 10 },
      { status: 'captured', lat: 0, lng: 0 },
      { status: 'captured', lat: '4.6', lng: -74 },
      { status: 'denied', lat: 4.6, lng: -74.1 },
      { status: 'teletransporte' },
      { status: 'captured', lat: 4.6, lng: -74.1, extra: 1 },
      'en la calle 10',
      null,
    ];
    for (const location of malas) {
      const s = await credit();
      const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000, location });
      assert.equal(r.status, 201, `${JSON.stringify(location)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body['location'], { status: 'invalid' }, JSON.stringify(location));
      const [row] = await locationOf(r.body['paymentId'] as string);
      assert.deepEqual([row.status, row.lat, row.lng], ['invalid', null, null]);
      assert.ok(typeof row.reason === 'string' && row.reason.length > 0);
    }
  });

  test('LOC-004 · sin campo `location` (frontend anterior): el abono pasa y no se crea fila', async () => {
    const s = await credit();
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
    assert.equal(r.status, 201);
    assert.equal(r.body['location'], null);
    assert.deepEqual(await locationOf(r.body['paymentId'] as string), []);
  });

  test('LOC-005 · reintento idempotente (mismo id y mismo cuerpo): un solo abono y una sola ubicación', async () => {
    const s = await credit();
    const op = randomUUID();
    const body = { saleId: s, amountMinor: 5_000, location: { status: 'captured', lat: 4.711, lng: -74.0721, accuracyM: 30, capturedAt: nowIso() } };
    const a = await carlos.money('/v1/collections', body, op);
    const b = await carlos.money('/v1/collections', body, op);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(b.body['paymentId'], a.body['paymentId']);
    assert.equal(await paymentsOf(s), 1);
    assert.equal(await count(db.admin, 'select 1 from adex.payment_locations where payment_id = $1', [a.body['paymentId']]), 1);
    // Mismo id con OTRA ubicación: se rechaza (no se reescribe la evidencia).
    const c = await carlos.money('/v1/collections', { ...body, location: { status: 'denied' } }, op);
    assert.deepEqual([c.status, c.body['error']], [409, 'OPERATION_ID_REUSED']);
    assert.equal(await paymentsOf(s), 1);
  });

  test('LOC-006 · reintentos en paralelo con el mismo id: un abono y una ubicación', async () => {
    const s = await credit();
    const op = randomUUID();
    const body = { saleId: s, amountMinor: 5_000, location: { status: 'timeout' } };
    const rs = await Promise.all(Array.from({ length: 5 }, () => carlos.money('/v1/collections', body, op)));
    assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(new Set(rs.map((r) => r.body['paymentId'])).size, 1);
    assert.equal(await paymentsOf(s), 1);
    assert.equal(await count(db.admin, 'select 1 from adex.payment_locations l join adex.payments p on p.id = l.payment_id where p.sale_id = $1', [s]), 1);
  });

  test('LOC-007 · un fallo al guardar la ubicación NO revierte el abono legítimo', async () => {
    const s = await credit();
    await db.admin.query('revoke insert on adex.payment_locations from adex_api');
    try {
      const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000, location: { status: 'captured', lat: 4.7, lng: -74.07 } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body['location'], { status: 'not_stored' });
      assert.equal(await paymentsOf(s), 1);
      assert.deepEqual(await locationOf(r.body['paymentId'] as string), []);
      const audit = (await db.admin.query(`select metadata->>'locationStatus' st from adex.audit_log where action = 'REGISTER_PAYMENT' and entity_id = $1`, [r.body['paymentId']])).rows;
      assert.deepEqual(audit, [{ st: 'not_stored' }]);
    } finally {
      await db.admin.query(`grant insert (company_id, payment_id, route_id, captured_by_membership_id, status, lat, lng, accuracy_m,
                              device_captured_at, reason, received_at) on adex.payment_locations to adex_api`);
    }
  });

  test('LOC-008 · otra empresa no puede registrar ni adjuntar ubicación a un abono ajeno', async () => {
    const s = await credit();
    const elisa = money(caller(api, issuer, 'elisa', M.elisaCob));
    const r = await elisa('/v1/collections', { saleId: s, amountMinor: 5_000, location: { status: 'captured', lat: 4.7, lng: -74.07 } });
    assert.equal(r.status, 404);
    assert.equal(await paymentsOf(s), 0);
    // Directo en SQL con el contexto de c2: la RLS impide escribir en c1.
    const own = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
    const paymentId = own.body['paymentId'] as string;
    await assert.rejects(asApi(db.api, { identityId: identityOf('elisa'), membershipId: M.elisaCob, companyId: companyId('c2') }, (c) =>
      c.query(`insert into adex.payment_locations (company_id, payment_id, route_id, captured_by_membership_id, status, received_at)
               values ($1, $2, $3, $4, 'denied', now())`, [c1, paymentId, r1, M.elisaCob])));
    assert.deepEqual(await locationOf(paymentId), []);
  });

  test('LOC-009 · nadie más de la empresa puede adjuntar ubicación a un abono que no registró', async () => {
    const s = await credit();
    const own = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000 });
    const paymentId = own.body['paymentId'] as string;
    await assert.rejects(asApi(db.api, { identityId: (await db.admin.query('select identity_id from adex.memberships where id = $1', [dora.membershipId])).rows[0].identity_id, membershipId: dora.membershipId, companyId: c1 }, (c) =>
      c.query(`insert into adex.payment_locations (company_id, payment_id, route_id, captured_by_membership_id, status, lat, lng, received_at)
               values ($1, $2, $3, $4, 'captured', 4.7, -74.07, now())`, [c1, paymentId, r1, dora.membershipId])), /AX801|payment location/);
    assert.deepEqual(await locationOf(paymentId), []);
  });

  // [MODIFICADO Ronda 67] Antes nadie leía coordenadas. Decisión del propietario (mapa): el Administrador las lee en
  // sus rutas (política `payment_locations_read`, `map.view`; ver route-map.test.ts MAP-008). El Owner, nunca.
  test('LOC-010 · lectura solo por la política del mapa; el plano Owner no puede consultar coordenadas; la historia no se modifica', async () => {
    const privs = (await db.admin.query(`select has_table_privilege('adex_api', 'adex.payment_locations', 'select') api,
                                                has_table_privilege('adex_control', 'adex.payment_locations', 'select') ctl,
                                                has_table_privilege('adex_demo', 'adex.payment_locations', 'select') demo,
                                                has_table_privilege('adex_api', 'adex.payment_locations', 'update') upd`)).rows[0];
    assert.deepEqual(privs, { api: true, ctl: false, demo: false, upd: false });
    const policies = (await db.admin.query(`select policyname, cmd from pg_policies where schemaname = 'adex' and tablename = 'payment_locations' order by 1`)).rows;
    assert.deepEqual(policies.map((p) => `${p.policyname}:${p.cmd}`), ['payment_locations_insert:INSERT', 'payment_locations_read:SELECT']);
    const s = await credit();
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000, location: { status: 'denied' } });
    await assert.rejects(db.admin.query(`update adex.payment_locations set status = 'captured' where payment_id = $1`, [r.body['paymentId']]), /not allowed/);
    await assert.rejects(db.admin.query(`delete from adex.payment_locations where payment_id = $1`, [r.body['paymentId']]), /not allowed/);
    const rls = (await db.admin.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'adex.payment_locations'::regclass`)).rows[0];
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  });

  test('LOC-011 · reloj del teléfono desfasado: se conservan las coordenadas reales, no su hora, y se anota el motivo', async () => {
    const s = await credit();
    const r = await carlos.money('/v1/collections', { saleId: s, amountMinor: 5_000, location: { status: 'captured', lat: 4.7, lng: -74.07, accuracyM: 12, capturedAt: '2020-01-01T00:00:00Z' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body['location'], { status: 'captured' });
    const [row] = await locationOf(r.body['paymentId'] as string);
    assert.deepEqual([row.status, row.lat, row.lng, row.accuracy_m, row.device_captured_at, row.reason], ['captured', 4.7, -74.07, 12, null, 'hora del dispositivo desfasada; no se guarda']);
  });

  test('LOC-012 · /healthz anuncia payment-location-v1 solo si 0022 está aplicada', async () => {
    assert.equal(await paymentLocationsReady(db.api), true);
  });

  test('LOC-013 · parseLocation: la hora del dispositivo solo se toma dentro de una ventana razonable', () => {
    const now = new Date('2026-10-20T15:00:00Z');
    const ok = parseLocation({ status: 'captured', lat: 4.7, lng: -74.07, capturedAt: '2026-10-20T14:50:00Z' }, now);
    assert.equal(ok?.status, 'captured');
    for (const at of ['2026-10-20T14:40:00Z', '2026-10-20T15:05:00Z']) {
      const x = parseLocation({ status: 'captured', lat: 4.7, lng: -74.07, capturedAt: at }, now)
      assert.deepEqual([x?.status, x?.lat, x?.capturedAt, Boolean(x?.reason)], ['captured', 4.7, null, true], at);
    }
    assert.equal(parseLocation({ status: 'captured', lat: 4.7, lng: -74.07, capturedAt: 'ayer' }, now)?.status, 'invalid');
    assert.equal(parseLocation(undefined, now), null);
  });
});
