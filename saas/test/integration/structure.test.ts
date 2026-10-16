// FASE 2 · estructura: empresa, Oficinas, rutas, categorías de gasto, idempotencia y
// aislamiento, de extremo a extremo: token → API → PostgreSQL (adex_api, RLS).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { companyId, routeId, uid } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, startControlApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';

describe('Fase 2 · estructura de empresa, Oficinas, rutas y categorías', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let control: TestServer;
  let bruno: Caller, ana: Caller, anaCob: Caller, fabio: Caller, carla: Caller;
  const provider = createMemoryProvider();
  before(async () => {
    db = await createTestDb('structure', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    control = await startControlApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
    ana = caller(api, issuer, 'ana', M.anaAdmin);
    anaCob = caller(api, issuer, 'ana', M.anaCob);
    fabio = caller(api, issuer, 'fabio', M.fabioSocio);
    carla = caller(api, issuer, 'carla', M.carlaSa);
  });
  after(async () => { await api.close(); await control.close(); await db.close(); });

  test('STR-001 · empresa: SuperAdmin y Administrador editan datos de contacto; estado, plan, país y moneda no', async () => {
    const r = await bruno('PATCH', '/v1/company', { phone: '+55 11 0000-0000', contactName: 'Responsable Nuevo', email: 'Nuevo@Example.test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['email'], 'nuevo@example.test');
    assert.equal(r.body['countryCode'], 'BR');
    assert.equal((await ana('PATCH', '/v1/company', { city: 'São Paulo' })).status, 200);
    assert.equal((await fabio('PATCH', '/v1/company', { city: 'X' })).status, 403);
    assert.equal((await anaCob('GET', '/v1/company')).status, 403);
    for (const field of ['status', 'plan', 'countryCode', 'currencyCode', 'timezone', 'expiresOn']) {
      assert.equal((await bruno('PATCH', '/v1/company', { [field]: 'x' })).body['error'], 'UNKNOWN_FIELD', field);
    }
    const a = await db.admin.query(`select actor_role, before_data, after_data from adex.audit_log where action = 'UPDATE_TENANT' and company_id = $1 order by created_at`, [companyId('c1')]);
    assert.equal(a.rowCount, 2);
    assert.deepEqual(a.rows[1].after_data, { city: 'São Paulo' });
    const c2 = await db.admin.query('select phone from adex.companies where id = $1', [companyId('c2')]);
    assert.notEqual(c2.rows[0].phone, '+55 11 0000-0000', 'la otra empresa no cambia');
  });

  test('STR-010 · Oficinas: alta, nombre y código únicos por empresa (sin mayúsculas ni espacios), también en paralelo', async () => {
    const created = await bruno('POST', '/v1/offices', { name: 'Oficina Sur', code: 'OF-S' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await ana('POST', '/v1/offices', { name: '  oficina sur ' })).body['error'], 'OFFICE_NAME_DUPLICATE');
    assert.equal((await ana('POST', '/v1/offices', { name: 'Otra', code: 'of-s' })).body['error'], 'OFFICE_CODE_DUPLICATE');
    assert.equal((await carla('POST', '/v1/offices', { name: 'Oficina Sur', code: 'OF-S' })).status, 201, 'otra empresa: permitido');
    assert.equal((await anaCob('POST', '/v1/offices', { name: 'X' })).status, 403);
    const race = await parallel(8, () => bruno('POST', '/v1/offices', { name: 'Oficina Carrera' }));
    assert.deepEqual(race.map((x) => x.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409]);
    assert.equal(await count(db.admin, `select 1 from adex.offices where company_id = $1 and lower(name) = 'oficina carrera'`, [companyId('c1')]), 1);
    const upd = await ana('PATCH', `/v1/offices/${created.body['id']}`, { name: 'Oficina Sur 2' });
    assert.equal(upd.body['name'], 'Oficina Sur 2');
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where entity_id = $1 and action in ('CREATE_OFFICE', 'UPDATE_OFFICE') and txid is not null`, [created.body['id']]), 2);
  });

  test('STR-011 · Oficina inactiva: bloquea operaciones NUEVAS de sus rutas; borrar nunca borra rutas', async () => {
    const office = (await bruno('POST', '/v1/offices', { name: 'Oficina Temporal' })).body;
    const route = (await bruno('POST', '/v1/routes', { name: 'Ruta Temporal', interestRate: 20, freeRate: false, maxLoanMinor: 100000, officeId: office['id'] })).body;
    assert.equal((await bruno('POST', `/v1/offices/${office['id']}/status`, { status: 'inactiva' })).status, 200);
    const client = await bruno('POST', '/v1/clients', { routeId: route['id'], name: 'X', documentType: 'CPF', document: '111.444.777-35',
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    assert.equal(client.body['error'], 'ROUTE_NOT_OPERATIONAL');
    assert.equal((await bruno('GET', `/v1/routes/${route['id']}`)).status, 200, 'la consulta sigue');
    assert.equal((await bruno('POST', `/v1/offices/${office['id']}/delete`, {})).body['error'], 'OFFICE_HAS_ROUTES');
    const del = await bruno('POST', `/v1/offices/${office['id']}/delete`, { detachRoutes: true });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(del.body['detached'], [route['id']]);
    const r = await db.admin.query('select office_id from adex.routes where id = $1', [route['id']]);
    assert.equal(r.rows[0].office_id, null, 'la ruta queda Sin Oficina, no se borra');
    assert.equal((await bruno('POST', `/v1/offices/${uid('c1:office:1')}/delete`, { detachRoutes: false })).body['error'], 'OFFICE_HAS_ROUTES');
  });

  test('STR-020 · alta de ruta: opcionales libres; el Administrador queda autoasignado y es el primer responsable de capital', async () => {
    const sa = await bruno('POST', '/v1/routes', { name: 'Ruta Libre', interestRate: 20, freeRate: false, maxLoanMinor: 200000 });
    assert.equal(sa.status, 201, JSON.stringify(sa.body));
    assert.match(sa.body['code'] as string, /^RT-\d{3}$/);
    assert.equal(sa.body['capitalControllerId'], null);
    assert.deepEqual(sa.body['memberIds'], []);
    const audit = await db.admin.query(`select route_id, description from adex.audit_log where action = 'CREATE_ROUTE' and entity_id = $1`, [sa.body['id']]);
    assert.equal(audit.rows[0].route_id, null, 'el ciclo de vida estructural no convierte la ruta en historia');
    assert.match(audit.rows[0].description, /SIN Administrador ni Cobrador/);

    const byAdmin = await ana('POST', '/v1/routes', { name: 'Ruta de Ana', interestRate: 10, freeRate: true, maxLoanMinor: 50000, collectorId: M.anaCob });
    assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.body));
    assert.deepEqual((byAdmin.body['memberIds'] as string[]).sort(), [M.anaAdmin, M.anaCob].sort());
    assert.equal(byAdmin.body['capitalControllerId'], M.anaAdmin);
    assert.equal(byAdmin.body['collectorId'], M.anaCob);
    const ev = byAdmin.body['controllerEvents'] as { kind: string; capitalTransferredMinor: number }[];
    assert.deepEqual(ev.map((e) => [e.kind, e.capitalTransferredMinor]), [['FIRST_ADMIN', 0]]);
    assert.equal((await ana('GET', `/v1/routes/${byAdmin.body['id']}`)).status, 200, 'la ve en la siguiente petición');
  });

  test('STR-021 · alta de ruta: capital inicial, Oficina ajena, Cobrador inactivo, Administrador ajeno y roles sin permiso → rechazos', async () => {
    const base = { name: 'R', interestRate: 20, freeRate: false, maxLoanMinor: 1000 };
    assert.equal((await bruno('POST', '/v1/routes', { ...base, initialCapitalMinor: 1000 })).body['error'], 'ROUTE_INITIAL_CAPITAL_NOT_ALLOWED');
    assert.equal((await bruno('POST', '/v1/routes', { ...base, officeId: uid('c2:office:1') })).body['error'], 'OFFICE_NOT_FOUND');
    assert.equal((await bruno('POST', '/v1/routes', { ...base, collectorId: M.ivanHist })).body['error'], 'INVALID_COLLECTOR');
    assert.equal((await bruno('POST', '/v1/routes', { ...base, collectorId: M.elisaCob })).body['error'], 'INVALID_COLLECTOR', 'Cobrador de otra empresa');
    assert.equal((await bruno('POST', '/v1/routes', { ...base, adminIds: [M.hugoAdmin] })).body['error'], 'INVALID_ADMIN');
    const newAdmin = await bruno('POST', '/v1/members', { email: 'admin-dos@example.test', role: 'admin', displayName: 'Admin Dos' });
    assert.equal((await ana('POST', '/v1/routes', { ...base, adminIds: [newAdmin.body['membershipId']] })).status, 403, 'el Administrador no asigna a otro Administrador');
    for (const who of [anaCob, fabio]) assert.equal((await who('POST', '/v1/routes', base)).status, 403);
    assert.equal((await bruno('POST', '/v1/routes', { ...base, interestRate: -1 })).status, 400);
    assert.equal((await bruno('POST', '/v1/routes', { ...base, maxLoanMinor: 10.5 })).status, 400, 'importe con decimales: rechazado, no redondeado');
    const codes = await parallel(5, (i) => bruno('POST', '/v1/routes', { ...base, name: `Paralela ${i}` }));
    assert.ok(codes.every((x) => x.status === 201));
    assert.equal(new Set(codes.map((x) => x.body['code'])).size, 5, 'códigos distintos con altas simultáneas');
  });

  test('STR-022 · edición transaccional: datos, Oficina, Cobrador responsable y asignaciones en una sola operación', async () => {
    const route = (await bruno('POST', '/v1/routes', { name: 'Ruta Editable', interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body;
    const sup = await bruno('POST', '/v1/members', { email: 'cob-nuevo@example.test', role: 'cobrador', displayName: 'Cob Nuevo' });
    const r = await bruno('PATCH', `/v1/routes/${route['id']}`, { name: 'Ruta Editada', officeId: uid('c1:office:1'), collectorId: sup.body['membershipId'],
      memberIds: [sup.body['membershipId'], M.gabiSec] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['name'], 'Ruta Editada');
    assert.equal(r.body['collectorId'], sup.body['membershipId']);
    assert.deepEqual((r.body['added'] as string[]).sort(), [sup.body['membershipId'] as string, M.gabiSec].sort());
    // Cobrador responsable sin asignar o que no es Cobrador → nada se guarda.
    const bad = await bruno('PATCH', `/v1/routes/${route['id']}`, { name: 'No', collectorId: M.gabiSec, memberIds: [M.gabiSec] });
    assert.equal(bad.body['error'], 'INVALID_COLLECTOR');
    assert.equal((await db.admin.query('select name from adex.routes where id = $1', [route['id']])).rows[0].name, 'Ruta Editada');
    const unassign = await bruno('PATCH', `/v1/routes/${route['id']}`, { collectorId: null, memberIds: [] });
    assert.deepEqual((unassign.body['removed'] as string[]).sort(), [sup.body['membershipId'] as string, M.gabiSec].sort());
    // Fuera del alcance o sin permiso.
    assert.equal((await ana('PATCH', `/v1/routes/${routeId('c1', 3)}`, { name: 'X' })).status, 404, 'ruta no autorizada = inexistente');
    assert.equal((await anaCob('PATCH', `/v1/routes/${routeId('c1', 1)}`, { name: 'X' })).status, 403);
    assert.equal((await bruno('PATCH', `/v1/routes/${route['id']}`, { memberIds: [M.ivanHist] })).body['error'], 'MEMBER_INACTIVE');
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where entity_id = $1 and action = 'UPDATE_ROUTE' and route_id is null`, [route['id']]), 2);
  });

  test('STR-023 · estado de ruta y billableRouteCount (DS-17) calculado en el servidor', async () => {
    const owner = await issuer.issue('owner');
    const before = (await control.call('POST', `/control/v1/companies/${companyId('c1')}/route-counts`, { token: owner, body: {} })).body;
    const route = (await bruno('POST', '/v1/routes', { name: 'Ruta Facturable', interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body;
    const mid = (await control.call('POST', `/control/v1/companies/${companyId('c1')}/route-counts`, { token: owner, body: {} })).body;
    assert.equal(mid['billableRouteCount'], (before['billableRouteCount'] as number) + 1);
    assert.equal((await bruno('POST', `/v1/routes/${route['id']}/status`, { status: 'inactiva' })).status, 200);
    const end = (await control.call('POST', `/control/v1/companies/${companyId('c1')}/route-counts`, { token: owner, body: {} })).body;
    assert.equal(end['billableRouteCount'], before['billableRouteCount']);
    assert.equal(end['routeCount'], (before['routeCount'] as number) + 1);
    assert.equal((await fabio('POST', `/v1/routes/${routeId('c1', 1)}/status`, { status: 'inactiva' })).status, 403);
  });

  test('STR-030 · categorías: nombre único sin mayúsculas, en paralelo; con gastos no se borran; sin gastos sí', async () => {
    const list = (await anaCob('GET', '/v1/expense-categories')).body['categories'] as { name: string }[];
    assert.deepEqual(list.map((c) => c.name).sort(), ['Combustible', 'Papelería']);
    assert.equal((await ana('POST', '/v1/expense-categories', { name: ' combustible ' })).body['error'], 'CATEGORY_NAME_DUPLICATE');
    const race = await parallel(6, () => bruno('POST', '/v1/expense-categories', { name: 'Peajes' }));
    assert.deepEqual(race.map((x) => x.status).sort(), [201, 409, 409, 409, 409, 409]);
    const peajes = race.find((x) => x.status === 201)!.body;
    assert.equal((await ana('PATCH', `/v1/expense-categories/${peajes['id']}`, { active: false })).body['active'], false);
    assert.equal((await anaCob('POST', '/v1/expense-categories', { name: 'X' })).status, 403);
    const used = await bruno('POST', `/v1/expense-categories/${uid('c1:cat:fuel')}/delete`, {});
    assert.equal(used.body['error'], 'HAS_HISTORY');
    assert.deepEqual((used.body['details'] as { references: string[] }).references, ['expenses.category_id']);
    assert.equal((await bruno('POST', `/v1/expense-categories/${peajes['id']}/delete`, {})).status, 200);
    assert.equal((await carla('PATCH', `/v1/expense-categories/${uid('c1:cat:fuel')}`, { name: 'Robada' })).status, 404);
  });

  test('CAT-001 · las categorías predeterminadas nacen con la empresa (mismos nombres que CLEAN)', async () => {
    const owner = await issuer.issue('owner');
    const created = await control.call('POST', '/control/v1/companies', { token: owner, body: {
      name: 'Épsilon Cobros', email: 'epsilon@example.test', countryCode: 'CO', countryLabel: 'Colombia', currencyCode: 'COP',
      timezone: 'America/Bogota', billingMode: 'per_route', billingRate: 10 } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const names = (await db.admin.query('select name from adex.expense_categories where company_id = $1 order by name', [created.body['companyId']])).rows.map((r) => r.name);
    // El módulo de CLEAN arrastra Dexie: se lee la constante del fuente, sin copiarla.
    const src = readFileSync(new URL('../../../src/lib/expenseCategoryDefaults.ts', import.meta.url), 'utf8');
    const clean = [...(/DEFAULT_EXPENSE_CATEGORY_NAMES = \[([^\]]*)\]/.exec(src)![1]!.matchAll(/'([^']+)'/g))].map((m) => m[1]!);
    assert.equal(clean.length, 7);
    assert.deepEqual([...names].sort(), [...clean].sort());
  });

  test('STR-040 · idempotencia: mismo X-Adex-Operation-Id → un solo efecto y la misma respuesta; otro cuerpo → 409', async () => {
    const op = randomUUID();
    const body = { name: 'Oficina Idempotente' };
    const results = await parallel(5, () => bruno('POST', '/v1/offices', body, { 'x-adex-operation-id': op }));
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.body)));
    assert.equal(new Set(results.map((r) => r.body['id'])).size, 1);
    assert.equal(await count(db.admin, `select 1 from adex.offices where name = 'Oficina Idempotente'`), 1);
    assert.equal((await bruno('POST', '/v1/offices', { name: 'Otra cosa' }, { 'x-adex-operation-id': op })).body['error'], 'OPERATION_ID_REUSED');
    assert.equal((await ana('POST', '/v1/offices', body, { 'x-adex-operation-id': op })).body['error'], 'OPERATION_ID_REUSED', 'otra membresía');
    assert.equal((await bruno('PATCH', `/v1/routes/${routeId('c1', 1)}`, { name: 'x' }, { 'x-adex-operation-id': randomUUID() })).body['error'], 'INVALID_OPERATION_ID');
  });

  test('STR-050 · aislamiento: ningún comando de estructura alcanza otra empresa, ni por URL ni por referencias del cuerpo', async () => {
    const c1Office = uid('c1:office:1');
    assert.equal((await carla('GET', `/v1/offices/${c1Office}`)).status, 404);
    assert.equal((await carla('PATCH', `/v1/offices/${c1Office}`, { name: 'Robada' })).status, 404);
    assert.equal((await carla('POST', `/v1/offices/${c1Office}/delete`, { detachRoutes: true })).status, 404);
    assert.equal((await carla('PATCH', `/v1/routes/${routeId('c1', 1)}`, { name: 'Robada' })).status, 404);
    assert.equal((await carla('POST', `/v1/routes/${routeId('c1', 1)}/delete`, {})).status, 404);
    assert.equal((await carla('PATCH', `/v1/routes/${routeId('c2', 1)}`, { officeId: c1Office })).body['error'], 'OFFICE_NOT_FOUND');
    assert.equal((await carla('PATCH', `/v1/routes/${routeId('c2', 1)}`, { memberIds: [M.anaCob] })).status, 403);
    assert.equal((await carla('POST', '/v1/offices/assign-routes', { officeId: uid('c2:office:1'), routeIds: [routeId('c1', 1)] })).status, 404);
    const names = (await db.admin.query(`select name from adex.offices where id = $1`, [c1Office])).rows[0].name;
    assert.equal(names, 'Oficina Centro');
    // Segunda barrera: aunque la API fallara, RLS no deja escribir en otra empresa.
    const c = await db.api.connect();
    try {
      await c.query('begin');
      const { defaultSession } = await import('../helpers/db.ts');
      const { identityOf } = await import('../../db/seeds/synthetic.ts');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [identityOf('carla'), M.carlaSa, companyId('c2'), defaultSession(identityOf('carla')), String(Math.floor(Date.now() / 1000))]);
      const u = await c.query(`update adex.offices set name = 'Robada' where id = $1`, [c1Office]);
      assert.equal(u.rowCount, 0, 'RLS: fila invisible');
      await assert.rejects(c.query(`insert into adex.offices (id, company_id, name, status, created_at, updated_at) values ('x', $1, 'x', 'activa', now(), now())`, [companyId('c1')]), { code: '42501' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  test('STR-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
    assert.deepEqual(control.errors, []);
  });
});
