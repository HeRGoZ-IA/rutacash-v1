// FASE 1 · identidad central, contexto activo (DS-05), aislamiento, membresías y
// sesiones, de extremo a extremo: token → API → PostgreSQL (adex_api, RLS).
// Tokens del EMISOR LOCAL con formato Supabase (no es Supabase Auth; ver auth-real).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { capabilitiesOf } from '../../src/authz/cleanRules.ts';
import { ROLE_CAPABILITIES } from '@/lib/permissions';
import { companyId, identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';

const M = {
  brunoSa: membershipId('c1', 'bruno-sa'), anaAdmin: membershipId('c1', 'ana-admin'), anaCob: membershipId('c1', 'ana-cob'),
  gabiSec: membershipId('c1', 'gabi-sec'), fabioSocio: membershipId('c1', 'fabio-socio'), carlaSa: membershipId('c2', 'carla-sa'),
  hugoAdmin: membershipId('c2', 'hugo-admin'), anaSup: membershipId('c2', 'ana-sup'), elisaCob: membershipId('c2', 'elisa-cob'),
};

describe('Fase 1 · identidad, contexto y membresías por la API', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  before(async () => {
    db = await createTestDb('identity', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
  });
  after(async () => { await api.close(); await db.close(); });

  test('IDN-010 · el selector devuelve SOLO las membresías de la identidad, en todas sus empresas', async () => {
    const r = await api.call('GET', '/v1/me/memberships', { token: await issuer.issue('ana') });
    assert.equal(r.status, 200);
    const ms = r.body['memberships'] as { membershipId: string; role: string; company: { id: string; operable: boolean } }[];
    assert.deepEqual(ms.map((m) => m.membershipId).sort(), [M.anaAdmin, M.anaCob, M.anaSup].sort());
    assert.deepEqual([...new Set(ms.map((m) => m.company.id))].sort(), [companyId('c1'), companyId('c2')].sort());
    assert.ok(ms.every((m) => m.company.operable));
    assert.equal(JSON.stringify(r.body).includes('capabilit'), false, 'el selector no enumera permisos');
    const owner = await api.call('GET', '/v1/me/memberships', { token: await issuer.issue('owner') });
    assert.deepEqual(owner.body['memberships'], []);
  });

  test('IDN-011 · identidad sin aprovisionar, sin token o con token inválido → nada', async () => {
    const stranger = await issuer.issue('5d1e0b8a-7a4f-4f4e-9b3c-111111111111');
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: stranger })).body, { error: 'IDENTITY_NOT_PROVISIONED' });
    assert.equal((await api.call('GET', '/v1/context', { membership: M.brunoSa })).status, 401);
    assert.equal((await api.call('GET', '/v1/context', { token: await issuer.issueForged('bruno'), membership: M.brunoSa })).status, 401);
    assert.equal((await api.call('GET', '/v1/nada', { token: 'basura' })).status, 401, 'ruta desconocida: sin token válido no se revela nada');
  });

  test('IDN-020 · la empresa A no accede a la empresa B (membresía, ruta, miembros ni encabezados)', async () => {
    const carla = await issuer.issue('carla');
    assert.deepEqual((await api.call('GET', '/v1/context', { token: carla, membership: M.brunoSa })).body, { error: 'MEMBERSHIP_NOT_FOUND' });
    assert.equal((await api.call('GET', `/v1/routes/${routeId('c1', 1)}`, { token: carla, membership: M.carlaSa })).status, 404);
    const members = (await api.call('GET', '/v1/members', { token: carla, membership: M.carlaSa })).body['members'] as { membershipId: string }[];
    assert.ok(members.length >= 4);
    assert.ok(members.every((m) => !Object.values(M).slice(0, 5).includes(m.membershipId)), 'ningún miembro de c1');
    // Encabezados de empresa o rol inyectados: se ignoran.
    const spoof = await api.call('GET', '/v1/context', { token: carla, membership: M.carlaSa,
      headers: { 'x-adex-company': companyId('c1'), 'x-adex-role': 'owner' } });
    assert.equal((spoof.body['company'] as { id: string }).id, companyId('c2'));
    assert.equal(spoof.body['role'], 'superadmin');
    assert.equal((await api.call('POST', `/v1/members/${M.hugoAdmin}/deactivate`, { token: await issuer.issue('bruno'), membership: M.brunoSa, body: {} })).status, 404);
  });

  test('IDN-021 · DS-05: la misma persona con otra membresía ve y puede otra cosa; nunca la suma', async () => {
    const ana = await issuer.issue('ana');
    const routesOf = async (m: string) => ((await api.call('GET', '/v1/routes', { token: ana, membership: m })).body['routes'] as { id: string }[]).map((r) => r.id).sort();
    assert.deepEqual(await routesOf(M.anaCob), [routeId('c1', 1)]);
    assert.deepEqual(await routesOf(M.anaAdmin), [routeId('c1', 1), routeId('c1', 2)].sort());
    assert.deepEqual(await routesOf(M.anaSup), [routeId('c2', 1)]);
    assert.equal((await api.call('GET', '/v1/members', { token: ana, membership: M.anaCob })).status, 403, 'cobradora: sin user.viewAll');
    assert.equal((await api.call('GET', '/v1/members', { token: ana, membership: M.anaAdmin })).status, 200);
    assert.equal((await api.call('GET', `/v1/routes/${routeId('c1', 2)}`, { token: ana, membership: M.anaCob })).status, 404, 'ruta no autorizada');
  });

  test('IDN-022 · las capacidades salen del rol de CLEAN; los claims del token no conceden nada', async () => {
    const token = await issuer.issue('ana', { extra: { company_id: companyId('c2'), adex_role: 'superadmin', permissions: ['user.viewAll'], app_metadata: { role: 'superadmin' } } });
    const ctx = await api.call('GET', '/v1/context', { token, membership: M.anaCob });
    assert.equal(ctx.body['role'], 'cobrador');
    assert.deepEqual(ctx.body['capabilities'], capabilitiesOf('cobrador'));
    assert.deepEqual(capabilitiesOf('cobrador'), ROLE_CAPABILITIES.cobrador, 'misma matriz que CLEAN');
    assert.equal((await api.call('GET', '/v1/members', { token, membership: M.anaCob })).status, 403);
  });

  test('IDN-030 · alta de membresía: identidad del proveedor, rutas autorizadas y auditoría en la misma transacción', async () => {
    const bruno = await issuer.issue('bruno');
    const r = await api.call('POST', '/v1/members', { token: bruno, membership: M.brunoSa,
      body: { email: 'Nueva.Cobradora@Example.test', role: 'cobrador', displayName: 'Nueva Cobradora', routeIds: [routeId('c1', 2)] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const created = r.body as { membershipId: string; routeIds: string[]; email: string };
    assert.equal(created.email, 'nueva.cobradora@example.test');
    const sub = provider.ids.get('nueva.cobradora@example.test')!;
    const token = await issuer.issue(sub);
    const mine = (await api.call('GET', '/v1/me/memberships', { token })).body['memberships'] as { membershipId: string }[];
    assert.deepEqual(mine.map((m) => m.membershipId), [created.membershipId]);
    const routes = (await api.call('GET', '/v1/routes', { token, membership: created.membershipId })).body['routes'] as { id: string }[];
    assert.deepEqual(routes.map((x) => x.id), [routeId('c1', 2)]);
    const a = await db.admin.query(
      `select actor_identity_id, actor_role, actor_membership_id, txid is not null t from adex.audit_log where entity_id = $1 and action = 'CREATE_USER'`, [created.membershipId]);
    assert.deepEqual(a.rows, [{ actor_identity_id: identityOf('bruno'), actor_role: 'superadmin', actor_membership_id: M.brunoSa, t: true }]);
  });

  test('IDN-031 · jerarquía de CLEAN: el Administrador no crea SuperAdmin ni Administradores ni asigna rutas ajenas', async () => {
    const ana = await issuer.issue('ana');
    for (const role of ['superadmin', 'admin']) {
      const r = await api.call('POST', '/v1/members', { token: ana, membership: M.anaAdmin, body: { email: `x-${role}@example.test`, role, displayName: 'X' } });
      assert.equal(r.status, 403, role);
    }
    assert.equal((await api.call('POST', '/v1/members', { token: ana, membership: M.anaAdmin,
      body: { email: 'x-cob@example.test', role: 'cobrador', displayName: 'X', routeIds: [routeId('c1', 3)] } })).status, 403);
    assert.equal((await api.call('POST', '/v1/members', { token: ana, membership: M.anaAdmin,
      body: { email: 'x-cob@example.test', role: 'cobrador', displayName: 'X', routeIds: [routeId('c1', 1)] } })).status, 201);
    assert.equal((await api.call('POST', '/v1/members', { token: ana, membership: M.anaCob,
      body: { email: 'x-cob2@example.test', role: 'cobrador', displayName: 'X' } })).status, 403);
    assert.equal((await api.call('POST', '/v1/members', { token: ana, membership: M.anaAdmin,
      body: { email: 'x@example.test', role: 'cobrador', displayName: 'X', companyId: companyId('c2') } })).status, 400, 'campo desconocido');
  });

  test('IDN-032 · rutas de un Administrador: Fase 2 (responsable de capital); nunca en silencio', async () => {
    const bruno = await issuer.issue('bruno');
    assert.deepEqual((await api.call('PUT', `/v1/members/${M.anaAdmin}/routes`, { token: bruno, membership: M.brunoSa, body: { routeIds: [routeId('c1', 1)] } })).body,
      { error: 'REQUIRES_PHASE_2_CAPITAL_GUARD' });
    assert.equal((await api.call('POST', '/v1/members', { token: bruno, membership: M.brunoSa,
      body: { email: 'adm@example.test', role: 'admin', displayName: 'A', routeIds: [routeId('c1', 1)] } })).status, 409);
  });

  test('IDN-033 · membresía desactivada: el MISMO token deja de operar con ella; las demás siguen', async () => {
    const ana = await issuer.issue('ana');
    const bruno = await issuer.issue('bruno');
    assert.equal((await api.call('GET', '/v1/context', { token: ana, membership: M.anaCob })).status, 200);
    assert.equal((await api.call('POST', `/v1/members/${M.anaCob}/deactivate`, { token: bruno, membership: M.brunoSa, body: {} })).status, 200);
    assert.deepEqual((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaCob })).body, { error: 'MEMBERSHIP_INACTIVE' });
    assert.equal((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaAdmin })).status, 200);
    assert.equal((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaSup })).status, 200);
    const sel = (await api.call('GET', '/v1/me/memberships', { token: ana })).body['memberships'] as { membershipId: string; status: string }[];
    assert.equal(sel.find((m) => m.membershipId === M.anaCob)?.status, 'inactivo');
    assert.equal((await api.call('POST', `/v1/members/${M.anaCob}/reactivate`, { token: bruno, membership: M.brunoSa, body: {} })).status, 200);
    assert.equal((await api.call('GET', '/v1/routes', { token: ana, membership: M.anaCob })).status, 200);
  });

  test('IDN-034 · protección del último SuperAdmin (regla de CLEAN)', async () => {
    const bruno = await issuer.issue('bruno');
    assert.deepEqual((await api.call('POST', `/v1/members/${M.brunoSa}/deactivate`, { token: bruno, membership: M.brunoSa, body: {} })).body,
      { error: 'LAST_SUPERADMIN' });
  });

  test('IDN-035 · retirar una ruta corta el acceso a esa ruta en la siguiente petición', async () => {
    const gabi = await issuer.issue('gabi');
    assert.equal((await api.call('GET', `/v1/routes/${routeId('c1', 1)}`, { token: gabi, membership: M.gabiSec })).status, 200);
    const r = await api.call('PUT', `/v1/members/${M.gabiSec}/routes`, { token: await issuer.issue('bruno'), membership: M.brunoSa, body: { routeIds: [routeId('c1', 2)] } });
    assert.equal(r.status, 200);
    assert.equal((await api.call('GET', `/v1/routes/${routeId('c1', 1)}`, { token: gabi, membership: M.gabiSec })).status, 404);
    assert.equal((await api.call('GET', `/v1/routes/${routeId('c1', 2)}`, { token: gabi, membership: M.gabiSec })).status, 200);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where entity_id = $1 and action in ('ASSIGN_ROUTE', 'UNASSIGN_ROUTE')`, [M.gabiSec]), 2);
  });

  test('IDN-040 · cierre de sesión local: ese token deja de servir aunque siga firmado; otra sesión sigue', async () => {
    const t1 = await issuer.issue('elisa');
    const t2 = await issuer.issue('elisa');
    assert.equal((await api.call('POST', '/v1/session/logout', { token: t1, body: { scope: 'local' } })).status, 200);
    assert.deepEqual((await api.call('GET', '/v1/context', { token: t1, membership: M.elisaCob })).body, { error: 'SESSION_REVOKED' });
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: t1 })).body, { error: 'SESSION_REVOKED' });
    assert.equal((await api.call('GET', '/v1/context', { token: t2, membership: M.elisaCob })).status, 200);
    assert.deepEqual(provider.signOuts.at(-1), { scope: 'local' });
  });

  test('IDN-041 · cierre global: todas las sesiones anteriores se cortan; un inicio posterior funciona', async () => {
    const before1 = await issuer.issue('hugo');
    const before2 = await issuer.issue('hugo');
    assert.equal((await api.call('POST', '/v1/session/logout', { token: before1, body: { scope: 'global' } })).status, 200);
    for (const t of [before1, before2]) {
      assert.deepEqual((await api.call('GET', '/v1/context', { token: t, membership: M.hugoAdmin })).body, { error: 'SESSION_REVOKED' });
    }
    const later = await issuer.issue('hugo', { iat: Math.floor(Date.now() / 1000) + 2 });
    assert.equal((await api.call('GET', '/v1/context', { token: later, membership: M.hugoAdmin })).status, 200);
  });

  test('IDN-042 · persona desactivada (identidad) → ninguna de sus membresías opera', async () => {
    const fabio = await issuer.issue('fabio');
    await db.admin.query(`update adex.identities set status = 'disabled' where id = $1`, [identityOf('fabio')]);
    assert.deepEqual((await api.call('GET', '/v1/context', { token: fabio, membership: M.fabioSocio })).body, { error: 'IDENTITY_DISABLED' });
    await db.admin.query(`update adex.identities set status = 'active' where id = $1`, [identityOf('fabio')]);
    assert.equal((await api.call('GET', '/v1/context', { token: fabio, membership: M.fabioSocio })).status, 200);
  });

  test('IDN-043 · ningún error inesperado en el servidor durante la batería', () => {
    assert.deepEqual(api.errors, []);
  });
});
