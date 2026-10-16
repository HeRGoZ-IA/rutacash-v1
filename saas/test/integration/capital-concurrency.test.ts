// FASE 3 · concurrencia e idempotencia con clientes PARALELOS reales contra la API y
// transacciones intercaladas a mano sobre PostgreSQL (riesgos R2, R4 y R5 del plan).
// Tras cada ráfaga: ningún saldo negativo, ningún movimiento incompleto y conservación.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, defaultSession, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const opOf = (r: { body: Body }) => r.body['operation'] as Body;

/** Transacción ABIERTA como `adex_api` con el contexto de una membresía (sin COMMIT). */
async function openApiTx(pool: pg.Pool, identityId: string, membershipId: string, companyId: string): Promise<pg.PoolClient> {
  const c = await pool.connect();
  await c.query('begin');
  await c.query(
    `select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
    [identityId, membershipId, companyId, defaultSession(identityId), String(Math.floor(Date.now() / 1000))]);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Fase 3 · concurrencia, idempotencia y atomicidad del capital', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let bruno: Caller, ana: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, eva: Person, xavier: Person;
  let r5 = '';

  const custody = (m: string, r: string) => balance(db.admin, c1, 'custody', m, r);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const deliver = (workerId: string, amountMinor: number, operationId?: string, routeId = r1) =>
    $ana('/v1/capital/deliveries', { routeId, workerId, amountMinor, reason: 'Ráfaga concurrente' }, operationId);

  before(async () => {
    db = await createTestDb('capitalconc', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    ana = caller(api, issuer, 'ana', M.anaAdmin); $ana = money(ana);
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-cc@example.test', 'cobrador', 'Carlos', [r1]);
    dora = await mk('dora-cc@example.test', 'supervisor', 'Dora', [r1]);
    xavier = await mk('xavier-cc@example.test', 'admin', 'Xavier', [r1]);
    r5 = (await bruno('POST', '/v1/routes', { name: 'Ruta Cinco', interestRate: 20, freeRate: false, maxLoanMinor: 1, adminIds: [M.anaAdmin] })).body['id'] as string;
    eva = await mk('eva-cc@example.test', 'supervisor', 'Eva', [r5]);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 10_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 100_000, reason: 'Bolsa pequeña de Ana' }],
    ] as const) {
      const r = await $bruno(path, body);
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    }
  });
  after(async () => { await api.close(); await db.close(); });

  test('CONC3-001 · entregas simultáneas que superan la bolsa: nunca doble consumo', async () => {
    const res = await parallel(10, () => deliver(carlos.membershipId, 30_000));
    const statuses = res.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(res.filter((r) => r.status === 409).every((r) => r.body['error'] === 'INSUFFICIENT_FUNDS'));
    assert.equal(await pool(M.anaAdmin), 10_000);
    assert.equal(await custody(carlos.membershipId, r1), 90_000);
    assert.deepEqual(api.errors, []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CONC3-002 · el mismo reintento lanzado 8 veces a la vez: una sola operación, la misma respuesta', async () => {
    const id = randomUUID();
    const res = await parallel(8, () => deliver(carlos.membershipId, 1_000, id));
    assert.deepEqual(res.map((r) => r.status), Array(8).fill(201));
    for (const r of res) assert.deepEqual(r.body, res[0]!.body);
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1 and operation_id = $2', [c1, id]), 1);
    assert.equal(await pool(M.anaAdmin), 9_000);
  });

  test('CONC3-003 · la misma clave con parámetros distintos, a la vez: una gana y las demás se rechazan', async () => {
    const id = randomUUID();
    const res = await parallel(8, (i) => deliver(carlos.membershipId, 100 + i, id));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body['error'] === 'OPERATION_ID_REUSED'), JSON.stringify(res.map((r) => r.body)));
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where company_id = $1 and operation_id = $2', [c1, id]), 1);
  });

  test('CONC3-004 · anulación y devolución simultáneas sobre la misma custodia: nunca ambas si no hay fondos (5 rondas)', async () => {
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 1_000_000, reason: 'Más bolsa' })).status, 201);
    for (let round = 0; round < 5; round++) {
      const left = await custody(dora.membershipId, r1);
      if (left > 0) assert.equal((await $ana('/v1/capital/returns', { routeId: r1, workerId: dora.membershipId, amountMinor: left, reason: 'Vaciar' })).status, 201);
      const d = await deliver(dora.membershipId, 50_000);
      const [rev, ret] = await Promise.all([
        $ana(`/v1/capital/operations/${opOf(d)['id']}/reverse`, { reason: 'Anulación concurrente' }),
        $ana('/v1/capital/returns', { routeId: r1, workerId: dora.membershipId, amountMinor: 30_000, reason: 'Devolución concurrente' }),
      ]);
      const ok = [rev, ret].filter((r) => r.status === 201).length;
      assert.equal(ok, 1, `ronda ${round}: ${rev.status}/${ret.status} ${JSON.stringify([rev.body, ret.body])}`);
      assert.ok((await custody(dora.membershipId, r1)) >= 0);
    }
    assert.deepEqual(api.errors, []);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CONC3-005 · seis anulaciones simultáneas de la misma entrega: una sola', async () => {
    const d = await deliver(carlos.membershipId, 5_000);
    const res = await parallel(6, () => $ana(`/v1/capital/operations/${opOf(d)['id']}/reverse`, { reason: 'Anulación repetida' }));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body['error'] === 'ALREADY_REVERSED'), JSON.stringify(res.map((r) => r.body)));
    assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where reverses_operation_id = $1', [opOf(d)['id']]), 1);
  });

  test('CONC3-006 · ráfaga cruzada (traspasos A↔B y reasignaciones r1↔r5): sin interbloqueos y con conservación', async () => {
    assert.equal((await deliver(dora.membershipId, 200_000)).status, 201);
    assert.equal((await deliver(eva.membershipId, 200_000, undefined, r5)).status, 201);
    const total = async () => (await custody(carlos.membershipId, r1)) + (await custody(dora.membershipId, r1)) + (await custody(eva.membershipId, r5)) + (await pool(M.anaAdmin));
    const before = await total();
    // La API reintenta un interbloqueo (40P01) en silencio: se mide el contador REAL de
    // PostgreSQL para demostrar que el orden global de bloqueos no los produce.
    // Una sesión inactiva publica sus estadísticas como mucho a los 10 s (PGSTAT_IDLE_INTERVAL).
    const deadlocks = async (waitMs: number) => {
      await sleep(waitMs);
      await db.admin.query('select pg_stat_clear_snapshot()');
      return Number((await db.admin.query('select deadlocks::text n from pg_stat_database where datname = current_database()')).rows[0].n);
    };
    const deadlocksBefore = await deadlocks(11_000);
    const ops: (() => Promise<{ status: number }>)[] = [];
    for (let i = 0; i < 6; i++) {
      ops.push(() => $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: carlos.membershipId, toWorkerId: dora.membershipId, amountMinor: 7_000, reason: 'A→B' }));
      ops.push(() => $ana('/v1/capital/worker-transfers', { routeId: r1, fromWorkerId: dora.membershipId, toWorkerId: carlos.membershipId, amountMinor: 9_000, reason: 'B→A' }));
      ops.push(() => $ana('/v1/capital/route-reassignments', { fromRouteId: r1, toRouteId: r5, fromWorkerId: dora.membershipId, toWorkerId: eva.membershipId, amountMinor: 11_000, reason: 'r1→r5' }));
      ops.push(() => $ana('/v1/capital/route-reassignments', { fromRouteId: r5, toRouteId: r1, fromWorkerId: eva.membershipId, toWorkerId: carlos.membershipId, amountMinor: 13_000, reason: 'r5→r1' }));
    }
    const res = await Promise.all(ops.map((f) => f()));
    assert.ok(res.every((r) => [201, 409].includes(r.status)), JSON.stringify(res.map((r) => r.status)));
    assert.ok(res.filter((r) => r.status === 201).length >= 12, 'la mayoría con fondos');
    assert.deepEqual(api.errors, [], 'ningún 500 (interbloqueo agotado)');
    assert.equal(await deadlocks(11_000), deadlocksBefore, 'cero interbloqueos en PostgreSQL');
    assert.equal(await total(), before, 'la ráfaga no crea ni destruye dinero');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CONC3-007 · R5: cambio de responsable concurrente con una entrega (dos órdenes, transacciones intercaladas)', async () => {
    // a) El cambio llega primero y retiene la fila de la ruta: la entrega espera, relee
    //    al responsable y se rechaza (la bolsa de Ana ya no responde por r1).
    const admin = await db.admin.connect();
    await admin.query('begin');
    await admin.query('select id from adex.routes where id = $1 for update', [r1]);
    await admin.query('update adex.routes set capital_controller_membership_id = $2, updated_at = now() where id = $1', [r1, xavier.membershipId]);
    const tx = await openApiTx(db.api, identityOf('ana'), M.anaAdmin, c1);
    const pending = tx.query(`select id from adex.capital_post(gen_random_uuid(), 'WORKER_DELIVERY', 1000, 'Durante el cambio', $1, $2)`, [r1, carlos.membershipId]);
    pending.catch(() => undefined);
    await sleep(400);
    await admin.query('commit');
    admin.release();
    await assert.rejects(pending, { code: 'AX402' });
    await tx.query('rollback'); tx.release();

    // b) La entrega llega primero: el cambio espera a que confirme; la entrega se hizo con
    //    el responsable vigente en ese instante (Xavier) y su bolsa pagó.
    assert.equal((await $bruno('/v1/capital/allocations', { adminId: xavier.membershipId, amountMinor: 20_000, reason: 'Bolsa de Xavier' })).status, 201);
    const tx2 = await openApiTx(db.api, xavier.identityId, xavier.membershipId, c1);
    await tx2.query(`select id from adex.capital_post(gen_random_uuid(), 'WORKER_DELIVERY', 2000, 'Antes del cambio', $1, $2)`, [r1, carlos.membershipId]);
    const admin2 = await db.admin.connect();
    const change = admin2.query(`update adex.routes set capital_controller_membership_id = $2, updated_at = now() where id = $1`, [r1, M.anaAdmin]);
    await sleep(300);
    const waiting = await db.admin.query('select count(*)::int n from pg_locks where not granted');
    assert.ok(waiting.rows[0].n >= 1, 'el cambio de responsable espera a la entrega');
    await tx2.query('commit'); tx2.release();
    await change; admin2.release();
    assert.equal(await pool(xavier.membershipId), 18_000);
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CONC3-008 · fallo intermedio antes del COMMIT: nada queda escrito (ni operación, ni patas, ni saldos, ni auditoría)', async () => {
    const failing = await startCompanyApi(db, issuer, provider, {
      beforeCommit: async (_ctx, path) => { if (path === '/v1/capital/deliveries') throw new Error('fallo simulado después de escribir'); },
    });
    try {
      const snapshot = async () => ({
        ops: await count(db.admin, 'select 1 from adex.capital_operations'),
        entries: await count(db.admin, 'select 1 from adex.capital_entries'),
        audit: await count(db.admin, 'select 1 from adex.audit_log'),
        idem: await count(db.admin, 'select 1 from adex.operations'),
        pool: await pool(M.anaAdmin), carlos: await custody(carlos.membershipId, r1),
      });
      const before = await snapshot();
      const r = await money(caller(failing, issuer, 'ana', M.anaAdmin))('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 3_000, reason: 'Fallará' });
      assert.deepEqual([r.status, r.body], [500, { error: 'INTERNAL' }]);
      assert.equal(failing.errors.length, 1);
      assert.deepEqual(await snapshot(), before);
      assert.equal(await count(db.admin, 'select 1 from adex.capital_operations where operation_id = $1', [r.operationId]), 0);
    } finally { await failing.close(); }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CONC3-009 · cambios de responsabilidad o del custodio mientras la operación espera: se decide con el estado nuevo', async () => {
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((r) => { arrived = r; });
    const paused = await startCompanyApi(db, issuer, provider, {
      afterContext: async (_ctx, path) => {
        if (path !== '/v1/capital/deliveries') return;
        arrived();
        await new Promise<void>((r) => { release = r; });
      },
    });
    try {
      const $paused = money(caller(paused, issuer, 'ana', M.anaAdmin));
      // a) El SuperAdmin cambia el responsable mientras la entrega de Ana espera.
      const p1 = $paused('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_000, reason: 'En espera' });
      await reached;
      assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: xavier.membershipId, reason: 'Cambio durante la espera' })).status, 200);
      release();
      assert.equal((await p1).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
      assert.equal((await bruno('PUT', `/v1/routes/${r1}/capital-controller`, { membershipId: M.anaAdmin, reason: 'Vuelve a Ana' })).status, 200);
    } finally { await paused.close(); }
    const paused2 = await startCompanyApi(db, issuer, provider, {
      afterContext: async (_ctx, path) => { if (path === '/v1/capital/deliveries') await sleep(300); },
    });
    try {
      // b) El custodio se desactiva mientras la entrega espera.
      const p2 = money(caller(paused2, issuer, 'ana', M.anaAdmin))('/v1/capital/deliveries', { routeId: r1, workerId: dora.membershipId, amountMinor: 1_000, reason: 'En espera' });
      await sleep(50);
      assert.equal((await bruno('POST', `/v1/members/${dora.membershipId}/deactivate`)).status, 200);
      assert.equal((await p2).body['error'], 'CUSTODIAN_INVALID');
    } finally { await paused2.close(); }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });
});
