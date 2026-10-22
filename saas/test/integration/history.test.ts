// FASE 2 · DS-11: clientes, trabajadores (membresías) y rutas con historia NO se
// borran físicamente, ni por la API, ni por el SuperAdmin, ni por el administrador de
// la base; sin historia, solo con autorización, validación y auditoría. También bajo
// concurrencia.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { companyId, identityOf, routeId, uid } from '../../db/seeds/synthetic.ts';
import { asApi, count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, type Caller } from '../helpers/phase2.ts';

const newClient = (route: string, doc: string) => ({
  routeId: route, name: 'Sin historia', documentType: 'CPF', document: doc, phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b',
});

describe('Fase 2 · DS-11 historia protegida', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  let adm: Caller;
  let bruno: Caller, ana: Caller, anaCob: Caller;
  const c1 = companyId('c1');
  const brunoCtx = { identityId: identityOf('bruno'), membershipId: M.brunoSa, companyId: c1 };
  before(async () => {
    db = await createTestDb('history', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
    bruno = caller(api, issuer, 'bruno', M.brunoSa);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    ana = caller(api, issuer, 'ana', M.anaAdmin);
    anaCob = caller(api, issuer, 'ana', M.anaCob);
  });
  after(async () => { await api.close(); await db.close(); });

  const refsOf = (r: { body: Record<string, unknown> }) => ((r.body['details'] as { references?: string[] } | undefined)?.references ?? []);

  // [MODIFICADO Ronda 67] El SuperAdmin ya no borra clientes (403); el rechazo por historia lo recibe la Administradora.
  test('DS11-001 · cliente con préstamo histórico: borrado rechazado (API, Administrador y administrador de la base)', async () => {
    const id = uid('c1:client:1');
    assert.equal((await bruno('POST', `/v1/clients/${id}/delete`, {})).status, 403, 'Ronda 67: el SuperAdmin no borra clientes');
    const r = await ana('POST', `/v1/clients/${id}/delete`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body['error'], 'HAS_HISTORY');
    for (const ref of ['sales.client_id', 'payments.client_id', 'sale_requests.client_id']) assert.ok(refsOf(r).includes(ref), ref);
    assert.equal((await ana('POST', `/v1/clients/${id}/delete`, {})).body['error'], 'HAS_HISTORY');
    await assert.rejects(db.admin.query('delete from adex.clients where id = $1', [id]), { code: '2BP01' });
    assert.equal(await count(db.admin, 'select 1 from adex.clients where id = $1', [id]), 1);
  });

  test('DS11-002 · trabajador con movimientos anteriores: borrado rechazado', async () => {
    const r = await bruno('POST', `/v1/members/${M.anaCob}/delete`, {});
    assert.equal(r.body['error'], 'HAS_HISTORY');
    for (const ref of ['payments.collector_membership_id', 'expenses.collector_membership_id', 'membership_routes.membership_id']) {
      assert.ok(refsOf(r).includes(ref), `${ref} in ${refsOf(r).join(',')}`);
    }
    await assert.rejects(db.admin.query('delete from adex.memberships where id = $1', [M.anaCob]), { code: '2BP01' });
    // Membresía histórica sin identidad (inactiva): también tiene historia.
    assert.equal((await bruno('POST', `/v1/members/${M.ivanHist}/delete`, {})).body['error'], 'HAS_HISTORY');
  });

  test('DS11-003 · ruta con capital o cartera histórica: borrado rechazado; el Administrador no borra rutas', async () => {
    const r = await bruno('POST', `/v1/routes/${routeId('c1', 1)}/delete`, {});
    assert.equal(r.body['error'], 'HAS_HISTORY');
    for (const ref of ['capital_movements.route_id', 'sales.route_id', 'clients.route_id', 'cash_settlements.route_id']) assert.ok(refsOf(r).includes(ref), ref);
    assert.equal((await ana('POST', `/v1/routes/${routeId('c1', 1)}/delete`, {})).status, 403);
    await assert.rejects(db.admin.query('delete from adex.routes where id = $1', [routeId('c1', 2)]), { code: '2BP01' });
  });

  test('DS11-004 · sin historia ni referencias protegidas: borrado permitido, solo al rol autorizado y auditado', async () => {
    const client = (await anaCob('POST', '/v1/clients', newClient(routeId('c1', 1), '529.982.247-25'))).body;
    assert.equal((await anaCob('POST', `/v1/clients/${client['id']}/delete`, {})).status, 403, 'el Cobrador no borra');
    const del = await ana('POST', `/v1/clients/${client['id']}/delete`, {});
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const a = await db.admin.query(`select actor_role, route_id, before_data->>'documentNormalized' doc, txid is not null t from adex.audit_log where action = 'DELETE_CLIENT' and entity_id = $1`, [client['id']]);
    assert.deepEqual(a.rows, [{ actor_role: 'admin', route_id: null, doc: '52998224725', t: true }]);

    const route = (await bruno('POST', '/v1/routes', { name: 'Ruta Efímera', interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body;
    assert.equal((await bruno('POST', `/v1/routes/${route['id']}/delete`, {})).status, 200);
    assert.equal(await count(db.admin, `select 1 from adex.audit_log where action = 'DELETE_ROUTE' and entity_id = $1`, [route['id']]), 1);
    // Una ruta con asignaciones o responsable de capital ya tiene historia.
    const byAdmin = (await ana('POST', '/v1/routes', { name: 'Ruta con responsable', interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body;
    const r2 = await bruno('POST', `/v1/routes/${byAdmin['id']}/delete`, {});
    assert.equal(r2.body['error'], 'HAS_HISTORY');
    assert.ok(refsOf(r2).includes('route_capital_controller_events.route_id'));

    const member = (await bruno('POST', '/v1/members', { email: 'efimero@example.test', role: 'secretario', displayName: 'Efímero' })).body;
    assert.equal((await ana('POST', `/v1/members/${member['membershipId']}/delete`, {})).status, 403, 'solo el SuperAdmin');
    assert.equal((await bruno('POST', `/v1/members/${M.brunoSa}/delete`, {})).body['error'], 'CANNOT_DELETE_SELF');
    assert.equal((await bruno('POST', `/v1/members/${member['membershipId']}/delete`, {})).status, 200);
    assert.equal(await count(db.admin, 'select 1 from adex.identities where email = $1', ['efimero@example.test']), 1, 'la identidad de la persona no se toca');
    // Con una decisión auditada sobre ella (desactivación), ya tiene historia.
    const other = (await bruno('POST', '/v1/members', { email: 'otro@example.test', role: 'secretario', displayName: 'Otro' })).body;
    await bruno('POST', `/v1/members/${other['membershipId']}/deactivate`, {});
    assert.deepEqual(refsOf(await bruno('POST', `/v1/members/${other['membershipId']}/delete`, {})), ['audit_log.entity_id']);
  });

  test('DS11-005 · una entidad inactiva no recibe operaciones nuevas incompatibles con su estado', async () => {
    assert.equal((await bruno('PUT', `/v1/members/${M.ivanHist}/routes`, { routeIds: [routeId('c1', 1)] })).body['error'], 'MEMBER_INACTIVE');
    assert.equal((await bruno('PATCH', `/v1/routes/${routeId('c1', 1)}`, { collectorId: M.ivanHist, memberIds: [M.ivanHist] })).status, 400);
    await asApi(db.api, brunoCtx, async (q) => {
      await assert.rejects(q.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [c1, M.ivanHist, routeId('c1', 1)]),
        { code: '42501' });
    });
    await assert.rejects(db.admin.query('update adex.routes set collector_membership_id = $1 where id = $2', [M.ivanHist, routeId('c1', 1)]), { code: 'AX302' });
    // Ronda 67: el alta la intenta la Administradora; se le autoriza la ruta 3 (inactiva) para probar su ESTADO.
    await db.admin.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3) on conflict do nothing', [c1, M.anaAdmin, routeId('c1', 3)]);
    assert.equal((await adm('POST', '/v1/clients', newClient(routeId('c1', 3), '168.995.350-09'))).body['error'], 'ROUTE_NOT_OPERATIONAL');
  });

  test('DS11-006 · ni el SuperAdmin directamente en la base: sin borrado masivo, sin cascada, sin TRUNCATE', async () => {
    const before = await count(db.admin, 'select 1 from adex.clients where company_id = $1', [c1]);
    await asApi(db.api, brunoCtx, async (q) => {
      for (const sql of ['delete from adex.clients where company_id = $1', 'delete from adex.routes where company_id = $1', 'delete from adex.memberships where company_id = $1 and id <> $2']) {
        await q.query('savepoint s');
        // Ronda 67: sobre clientes, el SuperAdmin ya no tiene política de borrado: la base no le deja ver filas que borrar.
        if (sql.startsWith('delete from adex.clients')) assert.equal((await q.query(sql, [c1])).rowCount, 0, sql);
        else await assert.rejects(q.query(sql, sql.includes('$2') ? [c1, M.brunoSa] : [c1]), { code: '2BP01' }, sql);
        await q.query('rollback to savepoint s');
      }
      for (const t of ['clients', 'routes', 'memberships', 'offices', 'expense_categories']) {
        await q.query('savepoint s');
        await assert.rejects(q.query(`truncate adex.${t} cascade`), { code: '42501' }, t);
        await q.query('rollback to savepoint s');
      }
    });
    for (const t of ['clients', 'routes', 'memberships']) await assert.rejects(db.admin.query(`truncate adex.${t} cascade`), { code: '42501' }, t);
    assert.equal(await count(db.admin, 'select 1 from adex.clients where company_id = $1', [c1]), before);
  });

  test('DS11-007 · concurrencia: un borrado y una referencia nueva nunca dejan huérfanos ni borran historia', async () => {
    const insertRequest = (q: pg.ClientBase, clientId: string) => q.query(
      `insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
                                       installments_count, installment_value_minor, frequency, start_date, status, requested_at)
       values ($1, $2, $3, $4, $5, 1000, 20, 1200, 12, 100, 'diaria', '2026-10-20', 'pending', now())`,
      [`req-${clientId}`, c1, clientId, routeId('c1', 1), M.anaCob]);
    // (a) La referencia llega primero (sin confirmar) y el borrado espera: al confirmarse, el borrado ve la historia.
    const a = (await adm('POST', '/v1/clients', newClient(routeId('c1', 1), '390.533.447-05'))).body['id'] as string;
    const tx = new pg.Client({ connectionString: db.url('postgres') });
    await tx.connect();
    try {
      await tx.query('begin');
      await insertRequest(tx, a);
      const deletion = ana('POST', `/v1/clients/${a}/delete`, {});
      await new Promise((r) => setTimeout(r, 300));
      await tx.query('commit');
      const r = await deletion;
      assert.equal(r.body['error'], 'HAS_HISTORY', JSON.stringify(r.body));
    } finally {
      await tx.end();
    }
    assert.equal(await count(db.admin, 'select 1 from adex.clients where id = $1', [a]), 1);
    // (b) El borrado llega primero (sin confirmar) y la referencia espera: al confirmarse, la referencia falla.
    const b = (await adm('POST', '/v1/clients', newClient(routeId('c1', 1), '714.602.380-01'))).body['id'] as string;
    const del = new pg.Client({ connectionString: db.url('postgres') });
    const ref = new pg.Client({ connectionString: db.url('postgres') });
    await Promise.all([del.connect(), ref.connect()]);
    try {
      await del.query('begin');
      await del.query('delete from adex.clients where id = $1', [b]);
      await ref.query('begin');
      const pending = insertRequest(ref, b).then(() => 'inserted', (e: { code?: string }) => e.code);
      await new Promise((r) => setTimeout(r, 300));
      await del.query('commit');
      assert.equal(await pending, '23503', 'la referencia a un cliente ya borrado falla');
      await ref.query('rollback');
    } finally {
      await Promise.all([del.end(), ref.end()]);
    }
    // (c) API contra API: borrar una ruta mientras se asigna a alguien. Nunca ambas cosas.
    for (let i = 0; i < 6; i++) {
      const route = (await bruno('POST', '/v1/routes', { name: `Carrera ${i}`, interestRate: 20, freeRate: false, maxLoanMinor: 1000 })).body['id'] as string;
      const [d, s] = await Promise.all([
        bruno('POST', `/v1/routes/${route}/delete`, {}),
        bruno('PUT', `/v1/members/${M.gabiSec}/routes`, { routeIds: [routeId('c1', 1), route] }),
      ]);
      assert.notEqual(d.status === 200 && s.status === 200, true, `trial ${i}: delete ${d.status}, assign ${s.status}`);
      assert.ok(d.status === 200 || s.status === 200, `trial ${i}: una de las dos gana`);
      const exists = await count(db.admin, 'select 1 from adex.routes where id = $1', [route]);
      const assigned = await count(db.admin, 'select 1 from adex.membership_routes where route_id = $1', [route]);
      assert.equal(exists, d.status === 200 ? 0 : 1);
      assert.equal(assigned, s.status === 200 ? 1 : 0);
      if (s.status === 200) await bruno('PUT', `/v1/members/${M.gabiSec}/routes`, { routeIds: [routeId('c1', 1)] });
    }
  });

  test('DS11-099 · sin errores inesperados en el servidor', () => {
    assert.deepEqual(api.errors, []);
  });
});
