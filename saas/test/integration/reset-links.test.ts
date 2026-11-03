// 3.20 · ENLACE DE RESTABLECIMIENTO de contraseña para usuarios activos (decisión 2.3.4 opción B;
// detalles del propietario 2026-11-03). Reglas que se comprueban:
//   · lo emite quien gestiona al usuario, también si ya inició sesión (a diferencia del de primer acceso);
//   · el Administrador solo para perfiles inferiores, nunca para otro Administrador ni para el SuperAdmin;
//   · al SuperAdmin solo se lo emite el Owner, con evento propio en su historial (0041);
//   · mismas barreras que el de primer acceso: identidad exclusiva, membresía activa, misma empresa;
//   · el token no se guarda ni se audita en claro; la auditoría tiene su propia acción;
//   · al canjearlo, /activar cierra TODAS las sesiones de la persona (logout global con la sesión temporal).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, membershipId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';

describe('3.20 · enlace de restablecimiento de contraseña', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();

  before(async () => {
    db = await createTestDb('reset_links', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  const as = async (person: string, company: 'c1' | 'c2' | 'c3', member: string) => {
    const token = await issuer.issue(person);
    const membership = membershipId(company, member);
    return (target: string) => api.call('POST', `/v1/members/${target}/reset-link`, { token, membership, body: {} });
  };

  test('RST-001 · el SuperAdmin lo emite para un usuario que ya inició sesión; auditado sin el token', async () => {
    provider.signedIn.add(identityOf('gabi'));
    const gabi = membershipId('c1', 'gabi-sec');
    const first = await (await as('bruno', 'c1', 'bruno-sa'))(gabi);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body['status'], 'issued');
    const token = first.body['tokenHash'] as string;
    assert.match(token, /^[0-9a-f]{20,}$/);
    // El de primer acceso sigue negándose a quien ya entró: son dos enlaces distintos.
    const access = await api.call('POST', `/v1/members/${gabi}/access-link`, { token: await issuer.issue('bruno'), membership: membershipId('c1', 'bruno-sa'), body: {} });
    assert.deepEqual(access.body, { status: 'already_active' });
    const audits = (await db.admin.query(`select action, entity_id, actor_role from adex.audit_log where company_id = $1 and action like 'ISSUE_%'`, [companyId('c1')])).rows;
    assert.deepEqual(audits, [{ action: 'ISSUE_RESET_LINK', entity_id: gabi, actor_role: 'superadmin' }]);
    const dump = JSON.stringify((await db.admin.query(`select (select json_agg(l) from adex.audit_log l) a, (select json_agg(o) from adex.operations o) b`)).rows[0]);
    assert.ok(!dump.includes(token), 'el token no se guarda en ninguna tabla');
  });

  test('RST-002 · quién puede: Administrador solo hacia abajo; al SuperAdmin solo el Owner', async () => {
    const ana = await as('ana', 'c1', 'ana-admin');
    const fabio = await ana(membershipId('c1', 'fabio-sec'));
    assert.deepEqual([fabio.status, fabio.body['status']], [200, 'issued'], JSON.stringify(fabio.body));
    const otherAdmin = await ana(membershipId('c1', 'ana-admin'));
    assert.deepEqual([otherAdmin.status, otherAdmin.body['error']], [403, 'PERMISSION_DENIED'], 'un Administrador no lo emite para un Administrador');
    const toSa = await ana(membershipId('c1', 'bruno-sa'));
    assert.deepEqual([toSa.status, toSa.body['error']], [403, 'RESET_BY_OWNER_ONLY']);
    const saToSa = await (await as('bruno', 'c1', 'bruno-sa'))(membershipId('c1', 'bruno-sa'));
    assert.deepEqual([saToSa.status, saToSa.body['error']], [403, 'RESET_BY_OWNER_ONLY'], 'ni el propio SuperAdmin');
    // El SuperAdmin sí lo emite para un Administrador (identidad exclusiva de su empresa).
    const irene = await (await as('diego', 'c3', 'diego-sa'))(membershipId('c3', 'irene-admin'));
    assert.deepEqual([irene.status, irene.body['status']], [200, 'issued'], JSON.stringify(irene.body));
    // Un Secretario no emite enlaces.
    assert.equal((await (await as('gabi', 'c1', 'gabi-sec'))(membershipId('c1', 'fabio-sec'))).status, 403);
    // Otra empresa no los emite para miembros de esta.
    assert.ok([403, 404].includes((await (await as('carla', 'c2', 'carla-sa'))(membershipId('c1', 'gabi-sec'))).status));
    // Identidad compartida con otra empresa (ana está en c1 y c2) o membresía inactiva: no.
    const shared = await (await as('bruno', 'c1', 'bruno-sa'))(membershipId('c1', 'ana-cob'));
    assert.deepEqual([shared.status, shared.body['error']], [409, 'IDENTITY_SHARED']);
    const inactive = await (await as('bruno', 'c1', 'bruno-sa'))(membershipId('c1', 'ivan-hist'));
    assert.equal(inactive.status, 409, JSON.stringify(inactive.body));
  });

  test('RST-003 · el Owner lo emite para el SuperAdmin con evento propio (0041)', async () => {
    const owner = await issuer.issue('owner');
    provider.signedIn.add(identityOf('bruno'));
    const p = `/control/v1/companies/${companyId('c1')}/superadmins/${membershipId('c1', 'bruno-sa')}/reset-link`;
    const r = await control.call('POST', p, { token: owner, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'issued');
    const ev = (await db.admin.query<{ type: string; detail: string }>(
      'select type, detail from adex_control.control_events where company_id = $1 order by at desc, id limit 1', [companyId('c1')])).rows[0];
    assert.equal(ev?.type, 'RESET_LINK_ISSUED');
    assert.ok(!JSON.stringify(ev).includes(r.body['tokenHash'] as string));
    assert.equal((await control.call('POST', p, { token: await issuer.issue('bruno'), body: {} })).status, 403, 'solo un Owner');
    assert.equal((await control.call('POST', `/control/v1/companies/${companyId('c2')}/superadmins/${membershipId('c1', 'bruno-sa')}/reset-link`,
      { token: owner, body: {} })).status, 404, 'la membresía tiene que ser de ESA empresa');
  });

  test('RST-004 · al canjearlo se cierran todas las sesiones de la persona', async () => {
    const gabi = membershipId('c1', 'gabi-sec');
    const now = Math.floor(Date.now() / 1000);
    const old = await issuer.issue('gabi', { iat: now - 120 });
    // La persona había iniciado sesión (SOC-01: esa es su sesión vigente).
    assert.equal((await api.call('POST', '/v1/session/claim', { token: old, body: {} })).status, 200);
    assert.equal((await api.call('GET', '/v1/routes', { token: old, membership: gabi })).status, 200, 'sesión abierta antes del cambio');
    // /activar: con la sesión temporal del enlace, tras fijar la contraseña, se reclama y se cierra todo.
    const temp = await issuer.issue('gabi', { iat: now });
    const lone = await api.call('POST', '/v1/session/logout', { token: temp, body: { scope: 'global' } });
    assert.equal(lone.status, 401, 'sin reclamarla, la sesión temporal no es la vigente (por eso /activar la reclama antes)');
    assert.equal((await api.call('POST', '/v1/session/claim', { token: temp, body: {} })).status, 200);
    const out = await api.call('POST', '/v1/session/logout', { token: temp, body: { scope: 'global' } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body['scope'], 'global');
    assert.equal((await api.call('GET', '/v1/routes', { token: old, membership: gabi })).status, 401, 'la sesión anterior quedó cerrada');
    assert.equal((await api.call('GET', '/v1/routes', { token: temp, membership: gabi })).status, 401, 'también la temporal');
    // Con la contraseña nueva, la persona vuelve a entrar.
    const fresh = await issuer.issue('gabi', { iat: now + 2 });
    assert.equal((await api.call('POST', '/v1/session/claim', { token: fresh, body: {} })).status, 200, 'entrar por /login reclama la sesión nueva');
    assert.equal((await api.call('GET', '/v1/routes', { token: fresh, membership: gabi })).status, 200);
  });
});
