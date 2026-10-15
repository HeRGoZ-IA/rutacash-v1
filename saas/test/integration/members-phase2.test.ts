// FASE 2 · trabajadores (membresías): datos de contacto, Cobrador responsable
// (`setCobradorRoutes`), asignación desde una Oficina y DS-05 (el rol no se edita).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { routeId, uid } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';

describe('Fase 2 · trabajadores y asignaciones', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let bruno: Caller, ana: Caller, anaCob: Caller;
  before(async () => {
    db = await createTestDb('members2', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
    ana = caller(api, issuer, 'ana', M.anaAdmin);
    anaCob = caller(api, issuer, 'ana', M.anaCob);
  });
  after(async () => { await api.close(); await db.close(); });

  test('MEM-001 · datos de contacto con jerarquía de CLEAN; el rol no se edita (DS-05: otra membresía)', async () => {
    const r = await ana('PATCH', `/v1/members/${M.gabiSec}`, { displayName: 'Gabi Secretaria', phone: '+55 1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body['displayName'], 'Gabi Secretaria');
    assert.equal((await ana('PATCH', `/v1/members/${M.brunoSa}`, { displayName: 'X' })).status, 403, 'el Administrador no gestiona al SuperAdmin');
    assert.equal((await anaCob('PATCH', `/v1/members/${M.gabiSec}`, { displayName: 'X' })).status, 403);
    assert.equal((await bruno('PATCH', `/v1/members/${M.gabiSec}`, { role: 'admin' })).body['error'], 'UNKNOWN_FIELD');
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'UPDATE_USER' and entity_id = $1`, [M.gabiSec]), 1);
  });

  test('MEM-002 · Cobrador responsable: la ruta añadida lo hace responsable (gana la más reciente) y la retirada lo libera', async () => {
    const x = (await bruno('POST', '/v1/members', { email: 'cob-x@example.test', role: 'cobrador', displayName: 'Cob X' })).body['membershipId'] as string;
    const r1 = routeId('c1', 1);
    assert.equal((await db.admin.query('select collector_membership_id c from adex.routes where id = $1', [r1])).rows[0].c, M.anaCob);
    assert.equal((await ana('PUT', `/v1/members/${x}/routes`, { routeIds: [r1] })).status, 200);
    assert.equal((await db.admin.query('select collector_membership_id c from adex.routes where id = $1', [r1])).rows[0].c, x);
    assert.equal(await count(db.admin, 'select 1 from adex.membership_routes where membership_id = $1 and route_id = $2', [M.anaCob, r1]), 0,
      'el Cobrador anterior pierde la ruta (setCobradorRoutes)');
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'UNASSIGN_ROUTE' and entity_id = $1 and route_id = $2`, [M.anaCob, r1]), 1);
    assert.equal((await anaCob('GET', `/v1/routes/${r1}`)).status, 404, 'revocado en la siguiente petición');
    assert.equal((await ana('PUT', `/v1/members/${x}/routes`, { routeIds: [] })).status, 200);
    assert.equal((await db.admin.query('select collector_membership_id c from adex.routes where id = $1', [r1])).rows[0].c, null);
  });

  test('MEM-003 · asignación desde una Oficina: solo cambian las rutas de esa Oficina', async () => {
    const office1 = uid('c1:office:1');
    const r = await bruno('PUT', `/v1/members/${M.fabioSocio}/office-routes`, { officeId: office1, selectedRouteIds: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body['routeIds'], [routeId('c1', 2)], 'conserva r2 (Oficina Norte)');
    const back = await bruno('PUT', `/v1/members/${M.fabioSocio}/office-routes`, { officeId: office1, selectedRouteIds: [routeId('c1', 1), routeId('c1', 2)] });
    assert.deepEqual((back.body['routeIds'] as string[]).sort(), [routeId('c1', 1), routeId('c1', 2)].sort(), 'r2 no es de la Oficina: se ignora en la selección');
    assert.equal((await anaCob('PUT', `/v1/members/${M.fabioSocio}/office-routes`, { officeId: office1, selectedRouteIds: [] })).status, 403);
    assert.equal((await bruno('PUT', `/v1/members/${M.fabioSocio}/office-routes`, { officeId: uid('c2:office:1'), selectedRouteIds: [] })).body['error'], 'OFFICE_NOT_FOUND');
  });

  test('MEM-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
