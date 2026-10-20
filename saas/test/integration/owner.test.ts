// FASE 1 · plano de control Owner integrado con la identidad central (DS-17,
// aprobada 2026-10-14: mismo PostgreSQL, plano separado). Ser Owner:
//   · no da acceso a cartera, caja, clientes ni movimientos (ni por la API ni por SQL);
//   · no es una membresía y no permite entrar en una empresa (sin impersonación);
//   · sí permite gestionar empresas, su estado comercial y su primer SuperAdmin.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { COMPANY_CONTROL_FIELDS } from '../../src/control/service.ts';
import { companyId, identityOf, membershipId } from '../../db/seeds/synthetic.ts';
import { createTestDb, defaultSession, type TestDb } from '../helpers/db.ts';
import {
  createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer,
} from '../helpers/auth.ts';

describe('Fase 1 · plano de control Owner', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();
  before(async () => {
    db = await createTestDb('owner', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  test('OWN-001 · el Owner ve las empresas solo con campos estructurales y comerciales', async () => {
    const r = await control.call('GET', '/control/v1/companies', { token: await issuer.issue('owner') });
    assert.equal(r.status, 200);
    const companies = r.body['companies'] as Record<string, unknown>[];
    assert.equal(companies.length, 3);
    for (const c of companies) assert.deepEqual(Object.keys(c).sort(), [...COMPANY_CONTROL_FIELDS].sort());
    for (const p of ['bruno', 'carla', 'ana']) {
      assert.deepEqual((await control.call('GET', '/control/v1/companies', { token: await issuer.issue(p) })).body, { error: 'OPERATOR_REQUIRED' }, p);
    }
  });

  test('OWN-002 · el rol del plano de control no puede leer NADA del esquema de las empresas', async () => {
    const c = await db.control.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.session_id', $2, true), set_config('adex.token_iat', $3, true)`,
        [identityOf('owner'), defaultSession(identityOf('owner')), String(Math.floor(Date.now() / 1000))]);
      assert.equal((await c.query('select adex_control.operator_status() s')).rows[0].s, 'ok');
      for (const t of ['sales', 'payments', 'clients', 'capital_ledger', 'cash_settlements', 'memberships', 'identities', 'routes', 'companies']) {
        await c.query('savepoint s');
        await assert.rejects(c.query(`select * from adex.${t} limit 1`), { code: '42501' }, t);
        await c.query('rollback to savepoint s');
      }
      const priv = await c.query(`select has_schema_privilege('adex', 'USAGE') u`);
      assert.equal(priv.rows[0].u, false);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  test('OWN-003 · sin impersonación: el token del Owner no opera en ninguna empresa', async () => {
    const owner = await issuer.issue('owner');
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: owner })).body['memberships'], []);
    for (const m of [membershipId('c1', 'bruno-sa'), membershipId('c2', 'carla-sa')]) {
      assert.deepEqual((await api.call('GET', '/v1/context', { token: owner, membership: m })).body, { error: 'MEMBERSHIP_NOT_FOUND' });
      assert.equal((await api.call('GET', '/v1/members', { token: owner, membership: m })).status, 403);
    }
    assert.equal((await control.call('GET', `/control/v1/companies/${companyId('c1')}/sales`, { token: owner })).status, 404, 'no existe ruta operativa');
  });

  test('OWN-004 · alta de empresa y de su primer SuperAdmin; el Owner no se da membresía a sí mismo', async () => {
    const owner = await issuer.issue('owner');
    const created = await control.call('POST', '/control/v1/companies', { token: owner, body: {
      name: 'Delta Cobros', email: 'delta@example.test', countryCode: 'BR', countryLabel: 'Brasil', currencyCode: 'BRL',
      timezone: 'America/Sao_Paulo', billingMode: 'per_route', billingRate: 39.9 } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const cid = created.body['companyId'] as string;
    assert.equal(created.body['status'], 'trial');
    const sa = await control.call('POST', `/control/v1/companies/${cid}/superadmins`, { token: owner, body: { email: 'delta-sa@example.test', displayName: 'SA Delta' } });
    assert.equal(sa.status, 201);
    assert.deepEqual(Object.keys(sa.body), ['membershipId', 'identity']);
    const saToken = await issuer.issue(provider.ids.get('delta-sa@example.test')!);
    const ctx = await api.call('POST', '/v1/context/select', { token: saToken, membership: sa.body['membershipId'] as string, body: {} });
    assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body['role'], 'superadmin');
    // El Owner intenta darse una membresía en la empresa: rechazado.
    provider.ids.set('owner@example.test', identityOf('owner'));
    assert.equal((await control.call('POST', `/control/v1/companies/${cid}/superadmins`, { token: owner, body: { email: 'owner@example.test', displayName: 'Yo' } })).status, 403);
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: owner })).body['memberships'], []);
    const ev = await db.admin.query(`select type from adex_control.control_events where company_id = $1 order by at`, [cid]);
    assert.deepEqual(ev.rows.map((x) => x.type), ['COMPANY_CREATED', 'SUPERADMIN_ASSIGNED', 'FIRST_LOGIN']);
  });

  test('OWN-005 · DS-17: billableRouteCount lo calcula el servidor (rutas en estado activa)', async () => {
    const r = await control.call('POST', `/control/v1/companies/${companyId('c1')}/route-counts`, { token: await issuer.issue('owner'), body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body['routeCount'], 3);
    assert.equal(r.body['billableRouteCount'], 2);
    assert.equal((await control.call('POST', `/control/v1/companies/${companyId('c1')}/route-counts`, { token: await issuer.issue('bruno'), body: {} })).status, 403);
  });

  test('OWN-006 · telemetría de acceso: la selección de contexto registra LOGIN sin datos operativos', async () => {
    const before = await db.admin.query(`select first_login_at, last_login_at from adex_control.company_control where company_id = $1`, [companyId('c1')]);
    const r = await api.call('POST', '/v1/context/select', { token: await issuer.issue('bruno'), membership: membershipId('c1', 'bruno-sa'), body: {} });
    assert.equal(r.status, 200);
    const after = await db.admin.query(`select first_login_at, last_login_at from adex_control.company_control where company_id = $1`, [companyId('c1')]);
    assert.equal(after.rows[0].first_login_at.toISOString(), before.rows[0].first_login_at.toISOString(), 'primer acceso inmutable');
    assert.ok(after.rows[0].last_login_at > before.rows[0].last_login_at);
    const ev = await db.admin.query(`select type, detail from adex_control.control_events where company_id = $1 order by at desc limit 1`, [companyId('c1')]);
    assert.deepEqual(ev.rows[0], { type: 'LOGIN', detail: null });
  });

  test('OWN-007 · el cierre de sesión del Owner usa el mismo registro de revocación', async () => {
    const owner = await issuer.issue('owner');
    assert.equal((await control.call('POST', '/control/v1/session/logout', { token: owner, body: { scope: 'local' } })).status, 200);
    assert.deepEqual((await control.call('GET', '/control/v1/companies', { token: owner })).body, { error: 'SESSION_REVOKED' });
    assert.equal((await control.call('GET', '/control/v1/companies', { token: await issuer.issue('owner') })).status, 200);
  });

  test('OWN-008 · sin errores inesperados', () => {
    assert.deepEqual(api.errors, []);
    assert.deepEqual(control.errors, []);
  });
});
