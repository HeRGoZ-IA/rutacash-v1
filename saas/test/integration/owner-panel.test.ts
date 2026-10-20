// RONDA 20 · panel Owner SaaS: API Owner ampliada (perfil, ficha, facturación SaaS) y
// SERVICIO Owner separado. Reglas que se comprueban:
//   · el Owner solo ve datos estructurales y comerciales; nada operativo ni financiero
//     de las empresas, y nunca entra en una empresa;
//   · los cobros SaaS son hechos de ADEX con su cliente (adex_control.saas_payments);
//   · el servicio Owner corre aparte, solo como `adex_control`, y no monta /v1 ni /demo/v1.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { companyId, membershipId } from '../../db/seeds/synthetic.ts';
import { createControlHandler } from '../../src/http/controlApi.ts';
import { CONTROL_FEATURES, createOnlineServer } from '../../src/server/app.ts';
import { assertControlRole, readControlConfig } from '../../src/server/controlStart.ts';
import { readConfig } from '../../src/server/start.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';

const OPERATIONAL = ['sales', 'payments', 'clients', 'capital', 'cash', 'routes', 'members', 'expenses', 'collections', 'settlements'];

describe('Ronda 20 · panel Owner SaaS', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();
  before(async () => {
    db = await createTestDb('owner_panel', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  test('OWP-001 · perfil del Owner; cualquier miembro de empresa recibe OPERATOR_REQUIRED', async () => {
    const me = await control.call('GET', '/control/v1/me', { token: await issuer.issue('owner') });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.deepEqual(Object.keys(me.body).sort(), ['displayName', 'role', 'since']);
    assert.equal(me.body['role'], 'owner');
    for (const p of ['bruno', 'carla', 'ana']) {
      assert.deepEqual((await control.call('GET', '/control/v1/me', { token: await issuer.issue(p) })).body, { error: 'OPERATOR_REQUIRED' }, p);
    }
  });

  test('OWP-002 · ficha de empresa: control + historial + cobros, sin nada operativo', async () => {
    const r = await control.call('GET', `/control/v1/companies/${companyId('c1')}`, { token: await issuer.issue('owner') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['company', 'events', 'locale', 'payments', 'superadmins']);
    const text = JSON.stringify(r.body).toLowerCase();
    for (const k of ['client', 'loan', 'capital', 'balance', 'ledger', 'membership', 'document', 'phone', 'address']) assert.ok(!text.includes(`"${k}`), k);
    assert.equal((await control.call('GET', '/control/v1/companies/no-existe', { token: await issuer.issue('owner') })).status, 404);
    for (const sub of OPERATIONAL) {
      assert.equal((await control.call('GET', `/control/v1/companies/${companyId('c1')}/${sub}`, { token: await issuer.issue('owner') })).status, 404, sub);
    }
    assert.equal((await control.call('GET', `/control/v1/companies/${companyId('c1')}`, { token: await issuer.issue('bruno') })).status, 403);
  });

  test('OWP-003 · facturación SaaS: condiciones validadas; solo el Owner', async () => {
    const owner = await issuer.issue('owner');
    const path = `/control/v1/companies/${companyId('c2')}/billing`;
    const ok = await control.call('PUT', path, { token: owner, body: { billingMode: 'fixed', billingRate: 149.9, nextBillingDate: '2026-11-05', paymentStatus: 'pending' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body['billingMode'], 'fixed');
    assert.equal(ok.body['billingRate'], 149.9);
    assert.equal(ok.body['nextBillingDate'], '2026-11-05');
    for (const bad of [{ billingMode: 'gratis', billingRate: 1, paymentStatus: 'pending' }, { billingMode: 'fixed', billingRate: -1, paymentStatus: 'pending' },
      { billingMode: 'fixed', billingRate: 1.234, paymentStatus: 'pending' }, { billingMode: 'fixed', billingRate: 1, paymentStatus: 'pending', nextBillingDate: '2026-13-01' }]) {
      assert.equal((await control.call('PUT', path, { token: owner, body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await control.call('PUT', path, { token: owner, body: { billingMode: 'fixed', billingRate: 1, paymentStatus: 'pending', extra: 1 } })).status, 400);
    assert.equal((await control.call('PUT', path, { token: await issuer.issue('carla'), body: { billingMode: 'fixed', billingRate: 1, paymentStatus: 'pending' } })).status, 403);
  });

  test('OWP-004 · cobros SaaS: alta, listado y cambio de estado (pagado exige fecha)', async () => {
    const owner = await issuer.issue('owner');
    const created = await control.call('POST', `/control/v1/companies/${companyId('c1')}/payments`, { token: owner,
      body: { period: '2026-10', amount: 99.5, expectedDate: '2026-10-31', note: 'Mensualidad octubre' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body['status'], 'pending');
    const id = created.body['id'] as string;
    assert.equal((await control.call('POST', `/control/v1/payments/${id}/status`, { token: owner, body: { status: 'paid' } })).status, 400);
    const paid = await control.call('POST', `/control/v1/payments/${id}/status`, { token: owner, body: { status: 'paid', paidDate: '2026-10-30' } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body['paidDate'], '2026-10-30');
    const list = await control.call('GET', '/control/v1/payments', { token: owner });
    assert.ok((list.body['payments'] as { id: string; companyName: string }[]).some((p) => p.id === id && p.companyName));
    const detail = await control.call('GET', `/control/v1/companies/${companyId('c1')}`, { token: owner });
    assert.ok((detail.body['payments'] as { id: string }[]).some((p) => p.id === id));
    for (const bad of [{ period: '2026-13', amount: 1, expectedDate: '2026-10-01' }, { period: '2026-10', amount: 0, expectedDate: '2026-10-01' },
      { period: '2026-10', amount: 1 }, { period: '2026-10', amount: 1, expectedDate: '2026-10-01', status: 'paid' }]) {
      assert.equal((await control.call('POST', `/control/v1/companies/${companyId('c1')}/payments`, { token: owner, body: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await control.call('GET', '/control/v1/payments', { token: await issuer.issue('bruno') })).status, 403);
    assert.equal((await control.call('POST', `/control/v1/payments/no-existe/status`, { token: owner, body: { status: 'overdue' } })).status, 404);
  });

  test('OWP-005 · los cobros SaaS no tocan el dinero de las empresas', async () => {
    const fp = async () => (await db.admin.query(`select
      (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from adex.capital_entries x) a,
      (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from adex.payments x) b,
      (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from adex.capital_accounts x) c`)).rows[0];
    const before = await fp();
    await control.call('POST', `/control/v1/companies/${companyId('c2')}/payments`, { token: await issuer.issue('owner'),
      body: { period: '2026-11', amount: 10, expectedDate: '2026-11-30' } });
    assert.deepEqual(await fp(), before);
  });

  test('OWP-006 · el Owner sigue sin membresías ni acceso a empresas tras usar el panel', async () => {
    const owner = await issuer.issue('owner');
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: owner })).body['memberships'], []);
    assert.equal((await api.call('GET', '/v1/clients', { token: owner, membership: membershipId('c1', 'bruno-sa') })).status, 403);
  });

  test('OWP-007 · servicio Owner separado: solo /control/v1, /healthz y /readyz', async () => {
    const server = createOnlineServer({ company: null, demo: null, features: CONTROL_FEATURES, readinessPool: db.control, allowedOrigins: ['https://adex-online.example'],
      control: createControlHandler({ pool: db.control, verifyToken: issuer.verifier, provider }) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const owner = await issuer.issue('owner');
      const get = (p: string, token = owner, membership?: string) => fetch(base + p, { headers: { authorization: `Bearer ${token}`, connection: 'close', ...(membership ? { 'x-adex-membership': membership } : {}) } });
      assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok', features: [...CONTROL_FEATURES] });
      assert.equal((await get('/readyz')).status, 200);
      assert.equal((await get('/control/v1/companies')).status, 200);
      const bruno = await issuer.issue('bruno');
      assert.equal((await get('/v1/clients', bruno, membershipId('c1', 'bruno-sa'))).status, 404, 'la API de empresa no existe en el servicio Owner');
      assert.equal((await get('/v1/me/memberships', bruno)).status, 404);
      assert.equal((await get('/demo/v1/slots/principal')).status, 404);
      const cors = await fetch(`${base}/control/v1/companies`, { headers: { origin: 'https://otro.example', authorization: `Bearer ${owner}` } });
      assert.equal(cors.status, 403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    assert.throws(() => createOnlineServer({ company: async () => undefined, demo: null, control: async () => undefined, readinessPool: db.control, allowedOrigins: [] }),
      /own service/);
  });

  test('OWP-008 · configuración: cada servicio rechaza las credenciales del otro; el rol se comprueba en la base', async () => {
    const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_SECRET_KEY: 's', ADEX_ALLOWED_ORIGINS: 'https://a.example', ADEX_PG_SSL_INSECURE: '1' };
    assert.throws(() => readControlConfig({ ...base, ADEX_CONTROL_DATABASE_URL: 'postgres://c', ADEX_API_DATABASE_URL: 'postgres://a' }), /must not be configured/);
    assert.throws(() => readControlConfig({ ...base, ADEX_CONTROL_DATABASE_URL: 'postgres://c', ADEX_DEMO_DATABASE_URL: 'postgres://d' }), /must not be configured/);
    assert.throws(() => readControlConfig(base), /ADEX_CONTROL_DATABASE_URL/);
    assert.equal(readControlConfig({ ...base, ADEX_CONTROL_DATABASE_URL: 'postgres://c' }).controlUrl, 'postgres://c');
    assert.throws(() => readConfig({ ...base, ADEX_API_DATABASE_URL: 'postgres://a', ADEX_CONTROL_DATABASE_URL: 'postgres://c' }), /Owner service/);
    await assertControlRole(db.control);
    for (const role of ['adex_api', 'adex_demo'] as const) {
      const pool = new pg.Pool({ connectionString: db.url(role), max: 1 });
      try { await assert.rejects(assertControlRole(pool), /adex_control/, role); } finally { await pool.end(); }
    }
  });

  test('OWP-010 · suspender, leer la ficha y reactivar (prueba / activa)', async () => {
    const owner = await issuer.issue('owner');
    const created = await control.call('POST', '/control/v1/companies', { token: owner, body: {
      name: 'Épsilon Cobros', email: 'epsilon@example.test', countryCode: 'CO', countryLabel: 'Colombia', currencyCode: 'COP', timezone: 'America/Bogota' } });
    const cid = created.body['companyId'] as string;
    const suspended = await control.call('POST', `/control/v1/companies/${cid}/status`, { token: owner, body: { status: 'suspended' } });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    const detail = await control.call('GET', `/control/v1/companies/${cid}`, { token: owner });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const trial = await control.call('POST', `/control/v1/companies/${cid}/status`, { token: owner, body: { status: 'trial' } });
    assert.equal(trial.status, 200, JSON.stringify(trial.body));
    const active = await control.call('POST', `/control/v1/companies/${cid}/status`, { token: owner, body: { status: 'active' } });
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.deepEqual((await control.call('GET', `/control/v1/companies/${cid}`, { token: owner })).body['events'] && true, true);
  });

  test('OWP-009 · sin errores inesperados', () => {
    assert.deepEqual(api.errors, []);
    assert.deepEqual(control.errors, []);
  });
});
