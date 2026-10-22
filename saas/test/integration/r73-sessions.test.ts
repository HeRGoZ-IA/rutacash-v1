// RONDA 73 · SOC-01: una sola sesión activa por identidad (0031), contra PostgreSQL real y las dos
// APIs (empresa y Owner). Datos 100 % sintéticos.
//   · iniciar sesión en otro dispositivo revoca la anterior (también renovando su token);
//   · cambiar de empresa o rol NO es una sesión nueva (DS-05);
//   · una sesión desplazada no vuelve; dos inicios simultáneos dejan UNA vigente;
//   · una captura sin conexión enviada con la sesión desplazada se rechaza y no escribe nada;
//   · identidades que nunca reclamaron: sin cambios; el Owner, igual que la empresa.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, type Caller } from '../helpers/phase2.ts';
import { money, newPerson } from '../helpers/phase3.ts';

describe('Ronda 73 · una sola sesión activa por identidad', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);

  const device = async (who: string, sessionId = randomUUID(), iat?: number) => ({ sessionId, token: await issuer.issue(who, { sessionId, ...(iat ? { iat } : {}) }) });
  const ctx = (token: string, membership: string) => api.call('GET', '/v1/context', { token, membership });
  const claim = (token: string) => api.call('POST', '/v1/session/claim', { token, body: {} });

  before(async () => {
    db = await createTestDb('r73sessions', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
  });
  after(async () => { await api?.close(); await control?.close(); await db?.close(); });

  test('R73-SES-001 · iniciar sesión en un segundo dispositivo revoca el primero; el servidor rechaza sus operaciones', async () => {
    const a = await device('gabi');
    assert.equal((await claim(a.token)).status, 200);
    assert.equal((await ctx(a.token, M.gabiSec)).status, 200);
    const b = await device('gabi');
    const r = await claim(b.token);
    assert.deepEqual([r.status, r.body['claimed'], r.body['revokedPrevious']], [200, true, true]);
    assert.deepEqual([(await ctx(a.token, M.gabiSec)).status, (await ctx(a.token, M.gabiSec)).body['error']], [401, 'SESSION_REVOKED']);
    assert.equal((await ctx(b.token, M.gabiSec)).status, 200, 'el nuevo dispositivo opera');
    assert.deepEqual((await db.admin.query('select reason from adex.revoked_sessions where session_id = $1', [a.sessionId])).rows, [{ reason: 'superseded' }]);
    // Renovar el token del dispositivo viejo (misma sesión, iat nuevo) no lo revive; tampoco «reclamar» con él.
    const renewed = await device('gabi', a.sessionId, Math.floor(Date.now() / 1000) + 5);
    assert.equal((await ctx(renewed.token, M.gabiSec)).status, 401);
    assert.equal((await claim(renewed.token)).status, 401, 'una sesión desplazada no vuelve');
    assert.equal((await ctx(b.token, M.gabiSec)).status, 200);
  });

  test('R73-SES-002 · cambiar de empresa o rol NO es una sesión nueva (DS-05): todas las membresías de la sesión vigente operan', async () => {
    const s = await device('ana');
    assert.equal((await claim(s.token)).status, 200);
    for (const m of [M.anaAdmin, M.anaCob, M.anaSup]) {
      const r = await api.call('POST', '/v1/context/select', { token: s.token, membership: m, body: {} });
      assert.ok([200, 403].includes(r.status), `${m}: ${r.status}`);
      assert.notEqual(r.body['error'], 'SESSION_REVOKED');
    }
    assert.equal((await ctx(s.token, M.anaAdmin)).status, 200);
  });

  test('R73-SES-003 · identidades que nunca reclamaron: sin cambios (varias sesiones siguen válidas)', async () => {
    const x = await device('fabio');
    const y = await device('fabio');
    assert.equal((await ctx(x.token, M.fabioSec)).status, 200);
    assert.equal((await ctx(y.token, M.fabioSec)).status, 200);
    // El primer inicio explícito deja solo esa: la otra cae aunque nunca reclamara.
    assert.equal((await claim(y.token)).status, 200);
    assert.equal((await ctx(x.token, M.fabioSec)).status, 401);
    assert.equal((await ctx(y.token, M.fabioSec)).status, 200);
  });

  test('R73-SES-004 · dos inicios de sesión simultáneos: queda UNA sesión vigente', async () => {
    const ds = await Promise.all([device('bruno'), device('bruno'), device('bruno')]);
    const res = await Promise.all(ds.map((d) => claim(d.token)));
    assert.ok(res.every((r) => r.status === 200 || r.status === 401), res.map((r) => r.status).join(','));
    const ok = (await Promise.all(ds.map((d) => ctx(d.token, M.brunoSa)))).filter((r) => r.status === 200).length;
    assert.equal(ok, 1);
    const active = (await db.admin.query('select session_id::text s from adex.identity_active_sessions where identity_id = $1', [identityOf('bruno')])).rows;
    assert.equal(active.length, 1);
    assert.ok(ds.some((d) => d.sessionId === active[0].s));
  });

  test('R73-SES-005 · Cobrador: la captura sin conexión enviada con la sesión desplazada se rechaza y no escribe nada', async () => {
    // Bruno y Ana ya reclamaron sesión en pruebas anteriores: se usan sus sesiones VIGENTES (nuevas y reclamadas).
    const b2 = await device('bruno');
    assert.equal((await claim(b2.token)).status, 200);
    const a2 = await device('ana');
    assert.equal((await claim(a2.token)).status, 200);
    const as = (token: string, membership: string): Caller => (method, path, body, headers) => api.call(method, path, { token, membership, body: body ?? (method === 'GET' ? undefined : {}), headers });
    const w = await newPerson(api, issuer, provider.ids, as(b2.token, M.brunoSa), { email: 'r73-ses-w@example.test', role: 'cobrador', displayName: 'Cobrador Ses', routeIds: [r1] });
    const ana = money(as(a2.token, M.anaAdmin));
    const today = (await db.admin.query(`select adex.company_today($1)::text d`, [c1])).rows[0].d;
    const $b = (path: string, body: unknown) => api.call('POST', path, { token: b2.token, membership: M.brunoSa, body, headers: { 'x-adex-operation-id': randomUUID() } });
    assert.equal((await $b('/v1/capital/company/deposits', { amountMinor: 1_000_000, reason: 'Capital sintético' })).status, 201);
    assert.equal((await $b('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 500_000, reason: 'Bolsa' })).status, 201);
    assert.equal((await ana('/v1/capital/deliveries', { routeId: r1, workerId: w.membershipId, amountMinor: 100_000, reason: 'Base' })).status, 201);
    const cl = (await api.call('POST', '/v1/clients', { token: a2.token, membership: M.anaAdmin, body: { routeId: r1, name: 'Cliente Ses', documentType: 'CPF',
      document: String(randomInt(10_000_000_000, 99_999_999_999)), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Bar' } })).body['id'];
    const sale = await api.call('POST', '/v1/credits/direct', { token: a2.token, membership: M.anaAdmin, headers: { 'x-adex-operation-id': randomUUID() },
      body: { routeId: r1, clientId: cl, amountMinor: 10_000, interestRate: 20, installmentsCount: 20, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] } });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = (sale.body['credit'] as Record<string, unknown>)['id'];
    // Teléfono viejo (sesión A) captura un cobro sin conexión; entretanto el Cobrador inicia sesión en otro (B).
    const phoneA = await device(w.identityId);
    assert.equal((await claim(phoneA.token)).status, 200);
    const phoneB = await device(w.identityId);
    assert.equal((await claim(phoneB.token)).status, 200);
    const before = await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [saleId]);
    const op = randomUUID();
    const sync = await api.call('POST', '/v1/collections', { token: phoneA.token, membership: w.membershipId, headers: { 'x-adex-operation-id': op },
      body: { saleId, amountMinor: 600, offline: { deviceCapturedAt: new Date().toISOString(), knownBalanceMinor: 12_000 } } });
    assert.deepEqual([sync.status, sync.body['error']], [401, 'SESSION_REVOKED']);
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [saleId]), before, 'nada aplicado con la sesión inválida');
    assert.equal(await count(db.admin, 'select 1 from adex.offline_captures where operation_id = $1', [op]), 0);
  });

  test('R73-SES-006 · Owner: iniciar sesión en otro dispositivo revoca la sesión anterior en la API Owner', async () => {
    const o1 = await device('owner');
    const st = await control.call('POST', '/control/v1/session/start', { token: o1.token, body: {} });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal((await control.call('GET', '/control/v1/me', { token: o1.token })).status, 200);
    const o2 = await device('owner');
    assert.equal((await control.call('POST', '/control/v1/session/start', { token: o2.token, body: {} })).status, 200);
    assert.equal((await control.call('GET', '/control/v1/me', { token: o1.token })).status, 401);
    assert.equal((await control.call('GET', '/control/v1/me', { token: o2.token })).status, 200);
    assert.equal((await control.call('GET', '/control/v1/companies', { token: o1.token })).status, 401, 'tampoco lee empresas');
  });
});
