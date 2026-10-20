// RONDA 40 · Plataforma Owner ORIGINAL (CLEAN) en ADEX Online y PRIMER ACCESO (0021).
// Reglas que se comprueban:
//   · alta atómica de empresa + estado inicial + primer SuperAdmin (Brasil/BRL/São Paulo);
//   · historial administrativo con autor (alta, SuperAdmin, enlace, perfil, facturación,
//     cobros, rutas) y sin datos operativos;
//   · enlace de primer acceso: solo identidades exclusivas de la empresa, nunca de un Owner,
//     nunca para quien ya inició sesión; el token no se guarda ni se audita en claro;
//   · Owner sin acceso financiero ni membresías; revocación efectiva del Owner.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { companyId, identityOf, membershipId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';

const BR = { countryCode: 'BR', countryLabel: 'Brasil', currencyCode: 'BRL', timezone: 'America/Sao_Paulo' };

describe('Ronda 40 · Owner Online y primer acceso', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  const provider = createMemoryProvider();
  let owner: string;
  let nova: { companyId: string; saMembership: string; saIdentity: string };

  before(async () => {
    db = await createTestDb('owner_online', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
    owner = await issuer.issue('owner');
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  const events = async (cid: string) => (await db.admin.query<{ type: string; detail: string | null; actor: string | null }>(
    'select type, detail, actor_identity_id::text actor from adex_control.control_events where company_id = $1 order by at, id', [cid])).rows;

  test('OWO-001 · alta atómica: empresa Brasil/BRL/São Paulo activa + primer SuperAdmin, con historial y autor', async () => {
    const r = await control.call('POST', '/control/v1/companies', { token: owner, body: {
      name: 'Prueba Brasil R40', email: 'contato-r40@example.test', ...BR, taxId: '00.000.000/0001-00', contactName: 'Contato',
      billingMode: 'per_route', billingRate: 50, status: 'active', superAdmin: { email: 'sa-r40@example.test', displayName: 'SA Brasil' } } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'active');
    const sa = r.body['superAdmin'] as { membershipId: string; identity: string };
    assert.equal(sa.identity, 'new');
    const cid = r.body['companyId'] as string;
    const row = (await db.admin.query('select country_code, currency_code, timezone, status from adex.companies where id = $1', [cid])).rows[0];
    assert.deepEqual(row, { country_code: 'BR', currency_code: 'BRL', timezone: 'America/Sao_Paulo', status: 'activa' });
    const m = (await db.admin.query('select role, status, identity_id::text from adex.memberships where id = $1', [sa.membershipId])).rows[0];
    assert.equal(m.role, 'superadmin');
    nova = { companyId: cid, saMembership: sa.membershipId, saIdentity: m.identity_id };
    const ev = await events(cid);
    assert.deepEqual(ev.map((e) => e.type).sort(), ['COMPANY_ACTIVATED', 'COMPANY_CREATED', 'SUPERADMIN_ASSIGNED']);
    assert.ok(ev.every((e) => e.actor === identityOf('owner')), 'cada evento lleva al Owner como autor');
    // Sin capital ni saldos ficticios: la empresa nace vacía.
    const money = (await db.admin.query(`select (select count(*) from adex.capital_entries where company_id = $1)::int e,
      (select count(*) from adex.capital_accounts where company_id = $1)::int a, (select count(*) from adex.routes where company_id = $1)::int r`, [cid])).rows[0];
    assert.deepEqual(money, { e: 0, a: 0, r: 0 });
  });

  test('OWO-002 · si el SuperAdmin no es válido no queda empresa a medias; monedas no admitidas se rechazan', async () => {
    const before = (await db.admin.query('select count(*)::int n from adex.companies')).rows[0].n;
    const bad = await control.call('POST', '/control/v1/companies', { token: owner, body: { name: 'Mitad', email: 'mitad@example.test', ...BR,
      superAdmin: { email: 'no-es-correo', displayName: 'X' } } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const usd = await control.call('POST', '/control/v1/companies', { token: owner, body: { name: 'Dólar', email: 'usd@example.test', ...BR, currencyCode: 'USD' } });
    assert.ok(usd.status >= 400 && usd.status < 500, JSON.stringify(usd.body));
    const owner2 = await control.call('POST', '/control/v1/companies', { token: owner, body: { name: 'Owner SA', email: 'osa@example.test', ...BR,
      superAdmin: { email: 'owner@example.test', displayName: 'Yo' } } });
    assert.ok(owner2.status === 403 || owner2.status === 409, JSON.stringify(owner2.body));
    assert.equal((await db.admin.query('select count(*)::int n from adex.companies')).rows[0].n, before);
    assert.equal((await control.call('POST', '/control/v1/companies', { token: await issuer.issue('bruno'), body: { name: 'X', email: 'x@example.test', ...BR } })).status, 403);
  });

  test('OWO-003 · ficha: país/moneda/zona y SuperAdmins; nada operativo', async () => {
    const r = await control.call('GET', `/control/v1/companies/${nova.companyId}`, { token: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['company', 'events', 'locale', 'payments', 'superadmins']);
    assert.deepEqual(r.body['locale'], BR);
    const sas = r.body['superadmins'] as { id: string; email: string; linkAllowed: boolean }[];
    assert.deepEqual(sas.map((s) => [s.id, s.email, s.linkAllowed]), [[nova.saMembership, 'sa-r40@example.test', true]]);
    const text = JSON.stringify(r.body).toLowerCase();
    for (const k of ['client', 'loan', 'capital', 'balance', 'ledger', 'document', 'phone', 'address', 'tokenhash']) assert.ok(!text.includes(`"${k}`), k);
  });

  test('OWO-004 · enlace de primer acceso del SuperAdmin: emitido una vez por petición, auditado sin el token; nunca a quien ya entró', async () => {
    const p = `/control/v1/companies/${nova.companyId}/superadmins/${nova.saMembership}/access-link`;
    const r = await control.call('POST', p, { token: owner, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['status'], 'issued');
    const token = r.body['tokenHash'] as string;
    assert.match(token, /^[0-9a-f]{20,}$/);
    const ev = await events(nova.companyId);
    assert.equal(ev.at(-1)!.type, 'ACCESS_LINK_ISSUED');
    const dump = JSON.stringify((await db.admin.query(`select (select json_agg(e) from adex_control.control_events e) a,
      (select json_agg(o) from adex.operations o) b, (select json_agg(l) from adex.audit_log l) c`)).rows[0]);
    assert.ok(!dump.includes(token), 'el token no se guarda en ninguna tabla');
    // Quien ya inició sesión no recibe enlace (el Owner no puede fijar su contraseña).
    provider.signedIn.add(nova.saIdentity);
    const again = await control.call('POST', p, { token: owner, body: {} });
    assert.deepEqual([again.status, again.body], [200, { status: 'already_active' }]);
    provider.signedIn.delete(nova.saIdentity);
    assert.equal((await control.call('POST', p, { token: await issuer.issue('bruno'), body: {} })).status, 403);
    assert.equal((await control.call('POST', `/control/v1/companies/${companyId('c1')}/superadmins/${nova.saMembership}/access-link`, { token: owner, body: {} })).status, 404,
      'la membresía tiene que ser de ESA empresa');
    // Identidad compartida con otra empresa (bruno es SuperAdmin de c1): sin enlace.
    provider.ids.set('bruno@example.test', identityOf('bruno'));
    const shared = await control.call('POST', '/control/v1/companies', { token: owner, body: { name: 'Compartida', email: 'comp@example.test', ...BR,
      superAdmin: { email: 'bruno@example.test', displayName: 'Bruno' } } });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    assert.equal((shared.body['superAdmin'] as { identity: string }).identity, 'existing');
    const sharedLink = await control.call('POST', `/control/v1/companies/${shared.body['companyId']}/superadmins/${(shared.body['superAdmin'] as { membershipId: string }).membershipId}/access-link`,
      { token: owner, body: {} });
    assert.equal(sharedLink.status, 409);
    assert.equal(sharedLink.body['error'], 'IDENTITY_SHARED');
  });

  test('OWO-005 · ficha comercial (perfil), facturación y cobros quedan en el historial', async () => {
    const prof = await control.call('PUT', `/control/v1/companies/${nova.companyId}/profile`, { token: owner,
      body: { name: 'Prueba Brasil R40 (editada)', taxId: '11.111.111/0001-11', contactName: 'Contato 2', contactEmail: 'contato2-r40@example.test' } });
    assert.equal(prof.status, 200, JSON.stringify(prof.body));
    assert.equal(prof.body['name'], 'Prueba Brasil R40 (editada)');
    assert.equal((await db.admin.query('select name from adex.companies where id = $1', [nova.companyId])).rows[0].name, 'Prueba Brasil R40 (editada)');
    assert.equal((await control.call('PUT', `/control/v1/companies/${nova.companyId}/profile`, { token: owner, body: { name: '' } })).status, 400);
    await control.call('PUT', `/control/v1/companies/${nova.companyId}/billing`, { token: owner, body: { billingMode: 'fixed', billingRate: 99, paymentStatus: 'pending' } });
    const pay = await control.call('POST', `/control/v1/companies/${nova.companyId}/payments`, { token: owner, body: { period: '2026-10', amount: 99, expectedDate: '2026-10-31' } });
    await control.call('POST', `/control/v1/payments/${pay.body['id']}/status`, { token: owner, body: { status: 'paid', paidDate: '2026-10-20' } });
    const types = (await events(nova.companyId)).map((e) => e.type);
    for (const t of ['COMPANY_UPDATED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED']) assert.ok(types.includes(t), t);
    assert.equal(types.filter((t) => t === 'PAYMENT_REGISTERED').length, 2);
  });

  test('OWO-006 · el SuperAdmin opera su empresa: oficina, ruta (recuento y evento en el plano Owner), usuarios con enlace', async () => {
    const sa = await issuer.issue(nova.saIdentity);
    const call = (m: string, p: string, body?: unknown) => api.call(m, p, { token: sa, membership: nova.saMembership, body });
    const office = await call('POST', '/v1/offices', { name: 'Escritório Centro' });
    assert.equal(office.status, 201, JSON.stringify(office.body));
    const route = await call('POST', '/v1/routes', { name: 'Rota 1', interestRate: 20, freeRate: false, maxLoanMinor: 100_000, officeId: office.body['id'] });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    const cc = (await db.admin.query('select route_count, billable_route_count from adex_control.company_control where company_id = $1', [nova.companyId])).rows[0];
    assert.deepEqual(cc, { route_count: 1, billable_route_count: 1 });
    assert.ok((await events(nova.companyId)).some((e) => e.type === 'ROUTE_CREATED' && e.detail === null), 'ruta creada, sin datos de la ruta');
    const cob = await call('POST', '/v1/members', { email: 'cobrador-r40@example.test', role: 'cobrador', displayName: 'Cobrador R40', routeIds: [route.body['id']] });
    assert.equal(cob.status, 201, JSON.stringify(cob.body));
    assert.ok(!JSON.stringify(cob.body).toLowerCase().includes('token'), 'el alta no devuelve credenciales');
    const cobId = cob.body['membershipId'] as string;
    const link = await call('POST', `/v1/members/${cobId}/access-link`, {});
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(link.body['status'], 'issued');
    const audits = (await db.admin.query(`select action, entity_id from adex.audit_log where company_id = $1 and action = 'ISSUE_ACCESS_LINK'`, [nova.companyId])).rows;
    assert.deepEqual(audits, [{ action: 'ISSUE_ACCESS_LINK', entity_id: cobId }]);
    const dump = JSON.stringify((await db.admin.query('select json_agg(l) j from adex.audit_log l where company_id = $1', [nova.companyId])).rows[0]);
    assert.ok(!dump.includes(link.body['tokenHash'] as string));
    // El cobrador no puede emitir enlaces (ni para sí ni para el SuperAdmin).
    const cobIdentity = provider.ids.get('cobrador-r40@example.test')!;
    const cobTok = await issuer.issue(cobIdentity);
    assert.equal((await api.call('POST', `/v1/members/${nova.saMembership}/access-link`, { token: cobTok, membership: cobId, body: {} })).status, 403);
    // Otra empresa no puede emitir enlaces para miembros de esta.
    assert.ok([403, 404].includes((await api.call('POST', `/v1/members/${cobId}/access-link`, { token: await issuer.issue('bruno'), membership: membershipId('c1', 'bruno-sa'), body: {} })).status));
    // Ya activo → sin enlace; membresía desactivada (revocación) → sin enlace.
    provider.signedIn.add(cobIdentity);
    assert.deepEqual((await call('POST', `/v1/members/${cobId}/access-link`, {})).body, { status: 'already_active' });
    provider.signedIn.delete(cobIdentity);
    assert.equal((await call('POST', `/v1/members/${cobId}/deactivate`, {})).status, 200);
    assert.equal((await call('POST', `/v1/members/${cobId}/access-link`, {})).status, 409);
    assert.equal((await api.call('GET', '/v1/routes', { token: cobTok, membership: cobId })).status, 403, 'membresía revocada');
    // Persona que ya pertenece a OTRA empresa (ana, de c1/c2): sin enlace desde esta.
    provider.ids.set('ana@example.test', identityOf('ana'));
    const ana = await call('POST', '/v1/members', { email: 'ana@example.test', role: 'admin', displayName: 'Ana' });
    assert.equal(ana.status, 201, JSON.stringify(ana.body));
    const anaLink = await call('POST', `/v1/members/${ana.body['membershipId']}/access-link`, {});
    assert.deepEqual([anaLink.status, anaLink.body['error']], [409, 'IDENTITY_SHARED']);
  });

  test('OWO-007 · aislamiento: el Owner no tiene membresía ni lectura financiera de la empresa nueva', async () => {
    assert.deepEqual((await api.call('GET', '/v1/me/memberships', { token: owner })).body['memberships'], []);
    for (const p of ['/v1/routes', '/v1/clients', '/v1/capital/summary']) {
      assert.equal((await api.call('GET', p, { token: owner, membership: nova.saMembership })).status, 403, p);
    }
    for (const sub of ['clients', 'capital', 'members', 'routes', 'payments-of-clients']) {
      assert.equal((await control.call('GET', `/control/v1/companies/${nova.companyId}/${sub}`, { token: owner })).status, 404, sub);
    }
    // Un SuperAdmin de OTRA empresa no ve la empresa nueva.
    const other = await api.call('GET', '/v1/routes', { token: await issuer.issue('bruno'), membership: nova.saMembership });
    assert.equal(other.status, 403);
  });

  test('OWO-008 · Owners: lista, primer/último ingreso y revocación efectiva', async () => {
    const start = await control.call('POST', '/control/v1/session/start', { token: owner, body: {} });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const ops = await control.call('GET', '/control/v1/operators', { token: owner });
    assert.equal(ops.status, 200, JSON.stringify(ops.body));
    const me = (ops.body['operators'] as { email: string; self: boolean; lastLoginAt: string | null }[]).find((o) => o.self)!;
    assert.equal(me.email, 'owner@example.test');
    assert.ok(me.lastLoginAt);
    assert.equal((await control.call('GET', '/control/v1/operators', { token: await issuer.issue('bruno') })).status, 403);
    await db.admin.query(`update adex_control.platform_operators set status = 'inactivo' where identity_id = $1`, [identityOf('owner')]);
    try {
      const denied = await control.call('GET', '/control/v1/companies', { token: owner });
      assert.deepEqual([denied.status, denied.body['error']], [403, 'OPERATOR_REQUIRED']);
    } finally {
      await db.admin.query(`update adex_control.platform_operators set status = 'activo' where identity_id = $1`, [identityOf('owner')]);
    }
  });
});
