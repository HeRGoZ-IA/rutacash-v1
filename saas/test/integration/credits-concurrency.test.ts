// FASE 4 · concurrencia e idempotencia de solicitudes y desembolsos con clientes
// PARALELOS reales y transacciones intercaladas sobre PostgreSQL. Ninguna carrera
// produce doble préstamo, doble uso del efectivo ni autorizaciones inconsistentes.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { companyId, identityOf, routeId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, defaultSession, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openApiTx(pool: pg.Pool, identityId: string, membershipId: string, company: string): Promise<pg.PoolClient> {
  const c = await pool.connect();
  await c.query('begin');
  await c.query(
    `select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
    [identityId, membershipId, company, defaultSession(identityId), String(Math.floor(Date.now() / 1000))]);
  return c;
}

describe('Fase 4 · concurrencia de créditos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  const r1 = routeId('c1', 1);
  let bruno: Caller, gabi: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, xavier: Person;
  let today = '';

  const custody = (m: string) => balance(db.admin, c1, 'custody', m, r1);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const newClient = async (name: string) => {
    const r = await bruno('POST', '/v1/clients', { routeId: r1, name, documentType: 'CPF', document: String(randomInt(10_000_000_000, 99_999_999_999)),
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  /** Solicitud del Cobrador aprobada por la Secretaria. */
  const approved = async (amountMinor: number, approve = true) => {
    const r = await carlos.call('POST', '/v1/credit-requests', { routeId: r1, clientId: await newClient(`Cliente ${randomUUID().slice(0, 6)}`), amountMinor, interestRate: 20,
      installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    if (approve && (await gabi('POST', `/v1/credit-requests/${r.body['id']}/approve`, {})).status !== 200) throw new Error('approve');
    return r.body['id'] as string;
  };
  const disburse = (m: Money, id: string, op?: string) => m(`/v1/credit-requests/${id}/disburse`, {}, op);
  const deliver = (worker: string, amountMinor: number) => $ana('/v1/capital/deliveries', { routeId: r1, workerId: worker, amountMinor, reason: 'Base' });

  before(async () => {
    db = await createTestDb('creditsconc', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    gabi = caller(api, issuer, 'gabi', M.gabiSec);
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds: [r1] });
    carlos = await mk('carlos-cc4@example.test', 'cobrador', 'Carlos');
    dora = await mk('dora-cc4@example.test', 'supervisor', 'Dora');
    xavier = await mk('xavier-cc4@example.test', 'admin', 'Xavier');
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 5_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 2_000_000, reason: 'Bolsa de Ana' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('CC4-001 · el mismo préstamo desembolsado 8 veces a la vez (ids distintos): un crédito, un asiento', async () => {
    assert.equal((await deliver(carlos.membershipId, 300_000)).status, 201);
    const req = await approved(50_000);
    const res = await parallel(8, () => disburse(carlos.money, req));
    assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.status)));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body['error'] === 'REQUEST_NOT_DISBURSABLE'), JSON.stringify(res.map((r) => r.body)));
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]), 1);
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where kind = 'LOAN_DISBURSEMENT' and sale_request_id = $1`, [req]), 1);
    assert.equal(await custody(carlos.membershipId), 250_000);
    assert.deepEqual(api.errors, []);
  });

  test('CC4-002 · el mismo reintento (mismo X-Adex-Operation-Id) 6 veces a la vez: la misma respuesta, un crédito', async () => {
    const req = await approved(20_000);
    const op = randomUUID();
    const res = await parallel(6, () => disburse(carlos.money, req, op));
    assert.deepEqual(res.map((r) => r.status), Array(6).fill(201));
    for (const r of res) assert.deepEqual(r.body, res[0]!.body);
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]), 1);
    const other = await approved(20_000);
    assert.equal((await disburse(carlos.money, other, op)).body['error'], 'OPERATION_ID_REUSED', 'misma clave con otra solicitud');
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [other]), 0);
  });

  test('CC4-003 · dos préstamos distintos compiten por el mismo efectivo: nunca ambos sin fondos', async () => {
    for (let round = 0; round < 4; round++) {
      const left = await custody(carlos.membershipId);
      if (left > 0) assert.equal((await $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: left, reason: 'Vaciar' })).status, 201);
      assert.equal((await deliver(carlos.membershipId, 80_000)).status, 201);
      const [a, b] = [await approved(50_000), await approved(50_000)];
      const res = await Promise.all([disburse(carlos.money, a), disburse(carlos.money, b)]);
      assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], `ronda ${round}: ${JSON.stringify(res.map((r) => r.body))}`);
      assert.equal(res.find((r) => r.status === 409)!.body['error'], 'INSUFFICIENT_FUNDS');
      assert.equal(await custody(carlos.membershipId), 30_000);
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CC4-004 · aprobación y rechazo simultáneos: una sola decisión', async () => {
    for (let round = 0; round < 4; round++) {
      const req = await approved(10_000, false);
      const [ap, rj] = await Promise.all([
        gabi('POST', `/v1/credit-requests/${req}/approve`, {}),
        dora.call('POST', `/v1/credit-requests/${req}/reject`, { reason: 'Rechazo concurrente' }),
      ]);
      assert.deepEqual([ap.status, rj.status].sort(), [200, 409], `ronda ${round}: ${JSON.stringify([ap.body, rj.body])}`);
      const st = (await db.admin.query('select status from adex.sale_requests where id = $1', [req])).rows[0].status;
      assert.equal(st, ap.status === 200 ? 'approved' : 'rejected');
    }
  });

  test('CC4-005 · desembolso contra cancelación simultánea: o crédito o cancelada, nunca ambas', async () => {
    const left = await custody(carlos.membershipId);
    if (left < 200_000) assert.equal((await deliver(carlos.membershipId, 200_000)).status, 201);
    for (let round = 0; round < 4; round++) {
      const req = await approved(10_000);
      const [d, c] = await Promise.all([
        disburse(carlos.money, req),
        caller(api, issuer, 'ana', M.anaAdmin)('POST', `/v1/credit-requests/${req}/cancel`, { reason: 'Cancelación concurrente' }),
      ]);
      const st = (await db.admin.query('select status from adex.sale_requests where id = $1', [req])).rows[0].status;
      const sales = await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]);
      assert.ok((d.status === 201 && c.status === 409 && st === 'disbursed' && sales === 1) || (c.status === 200 && d.status === 409 && st === 'cancelled' && sales === 0),
        `ronda ${round}: ${d.status}/${c.status} ${st} ${sales}`);
    }
  });

  test('CC4-006 · R5: cambio de responsable mientras un desembolso administrativo espera la ruta → se rechaza', async () => {
    const req = await approved(10_000);
    const admin = await db.admin.connect();
    await admin.query('begin');
    await admin.query('select id from adex.routes where id = $1 for update', [r1]);
    await admin.query('update adex.routes set capital_controller_membership_id = $2 where id = $1', [r1, xavier.membershipId]);
    const tx = await openApiTx(db.api, identityOf('ana'), M.anaAdmin, c1);
    const row = (await db.admin.query('select client_id, payment_days from adex.sale_requests where id = $1', [req])).rows[0];
    const pending = tx.query(`select * from adex.credit_disburse(gen_random_uuid(), $1, $2, $3, 10000, 20, 10, 'diaria', $4::date, $5, '[]', 'Durante el cambio')`,
      [req, r1, row.client_id, today, row.payment_days]);
    pending.catch(() => undefined);
    await sleep(400);
    await admin.query('commit'); admin.release();
    await assert.rejects(pending, { code: 'AX402' });
    await tx.query('rollback'); tx.release();
    await db.admin.query('update adex.routes set capital_controller_membership_id = $2 where id = $1', [r1, M.anaAdmin]);
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [req]), 0);
  });

  test('CC4-007 · fallo intermedio antes del COMMIT: ni crédito, ni cuotas, ni asiento, ni cambio de estado', async () => {
    const failing = await startCompanyApi(db, issuer, provider, {
      beforeCommit: async (_c, path) => { if (path.endsWith('/disburse')) throw new Error('fallo simulado tras escribir'); },
    });
    try {
      const req = await approved(10_000);
      const snap = async () => ({
        sales: await count(db.admin, 'select 1 from adex.sales'), inst: await count(db.admin, 'select 1 from adex.installments'),
        ops: await count(db.admin, 'select 1 from adex.capital_operations'), audit: await count(db.admin, 'select 1 from adex.audit_log'),
        status: (await db.admin.query('select status from adex.sale_requests where id = $1', [req])).rows[0].status, cash: await custody(carlos.membershipId),
      });
      const before = await snap();
      const r = await money(caller(failing, issuer, carlos.identityId, carlos.membershipId))(`/v1/credit-requests/${req}/disburse`, {});
      assert.deepEqual([r.status, r.body], [500, { error: 'INTERNAL' }]);
      assert.deepEqual(await snap(), before);
    } finally { await failing.close(); }
  });

  test('CC4-008 · revocación (retirar la ruta al Cobrador) mientras desembolsa: espera; después ya no opera', async () => {
    const req = await approved(10_000);
    const next = await approved(10_000);
    let release!: () => void;
    let arrived!: () => void;
    let paused1 = false;
    const reached = new Promise<void>((r) => { arrived = r; });
    const paused = await startCompanyApi(db, issuer, provider, {
      // Solo la PRIMERA vez: un reintento (40P01) no debe volver a quedar en pausa.
      afterContext: async (_c, path) => { if (path.endsWith('/disburse') && !paused1) { paused1 = true; arrived(); await new Promise<void>((r) => { release = r; }); } },
    });
    try {
      const p = money(caller(paused, issuer, carlos.identityId, carlos.membershipId))(`/v1/credit-requests/${req}/disburse`, {});
      await reached;
      const revoke = bruno('PUT', `/v1/members/${carlos.membershipId}/routes`, { routeIds: [] });
      await sleep(300);
      release();
      assert.equal((await p).status, 201, 'autorizado cuando empezó: la revocación esperó (REVOKE-004)');
      assert.equal((await revoke).status, 200);
    } finally { await paused.close(); }
    assert.equal((await disburse(carlos.money, next)).status, 404, 'tras la revocación la ruta ya no existe para él');
    assert.equal(await count(db.admin, 'select 1 from adex.sales where sale_request_id = $1', [next]), 0);
  });

  test('CC4-009 · identificadores coincidentes entre empresas: sin cruces', async () => {
    const op = randomUUID();
    const req = (await db.admin.query(`select id from adex.sale_requests where company_id = $1 and status = 'approved' limit 1`, [c1])).rows[0]?.id
      ?? await approved(10_000);
    const carla = money(caller(api, issuer, 'carla', M.carlaSa));
    assert.equal((await carla(`/v1/credit-requests/${req}/disburse`, {}, op)).status, 404);
    assert.equal((await $bruno('/v1/capital/company/deposits', { amountMinor: 1, reason: 'Misma clave, otra empresa' }, op)).status, 201,
      'la clave de c2 no bloquea a c1 (y viceversa)');
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(await reconcile(db.admin, companyId('c2')), CLEAN);
    assert.deepEqual(api.errors, []);
  });
});
