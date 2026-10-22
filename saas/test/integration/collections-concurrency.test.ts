// FASE 5 · concurrencia, interrupciones y recuperación de recaudos y gastos con clientes
// PARALELOS reales contra PostgreSQL. Ninguna carrera cobra dos veces, gasta dos veces
// el mismo disponible, deja la custodia negativa por otra vía que un gasto del
// trabajador ni interbloquea. Verificación independiente con SQL propio.

import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { companyId } from '../../db/seeds/synthetic.ts';
import { count, createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';
import { M, caller, parallel, type Caller } from '../helpers/phase2.ts';
import { CLEAN, balance, money, newPerson, reconcile, type Money, type Person } from '../helpers/phase3.ts';

type Body = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Fase 5 · concurrencia de recaudos y gastos', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  const provider = createMemoryProvider();
  const c1 = companyId('c1');
  let r1 = '';
  let cat = '';
  let adm: Caller;
  let bruno: Caller;
  let $bruno: Money, $ana: Money;
  let carlos: Person, dora: Person, olga: Person;
  let rs = '';
  let today = '';

  const custody = (m: string) => balance(db.admin, c1, 'custody', m, r1);
  const pool = (m: string) => balance(db.admin, c1, 'admin', m);
  const credit = async (amountMinor = 50_000, installmentsCount = 10, route = r1) => {
    const client = (await adm('POST', '/v1/clients', { routeId: route, name: `Cliente ${randomUUID().slice(0, 6)}`, documentType: 'CPF',
      document: String(randomInt(10_000_000_000, 99_999_999_999)), phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' })).body['id'];
    const r = await $ana('/v1/credits/direct', { routeId: route, clientId: client, amountMinor, interestRate: 20, installmentsCount, frequency: 'diaria',
      startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };
  const collect = (m: Money, saleId: string, amountMinor: number, op?: string) => m('/v1/collections', { saleId, amountMinor }, op);
  const paidOf = async (s: string) => Number((await db.admin.query('select coalesce(sum(amount_minor), 0)::int p from adex.payments where sale_id = $1', [s])).rows[0].p);

  before(async () => {
    db = await createTestDb('collconc', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, provider);
    r1 = (await db.admin.query(`select id from adex.routes where company_id = $1 and name = 'Ruta 1'`, [c1])).rows[0].id;
    cat = (await db.admin.query(`select id from adex.expense_categories where company_id = $1 and name = 'Combustible'`, [c1])).rows[0].id;
    bruno = caller(api, issuer, 'bruno', M.brunoSa); $bruno = money(bruno);
    // Ronda 67: el SuperAdmin ya no registra clientes (cartera de solo lectura); los prepara la Administradora.
    adm = caller(api, issuer, 'ana', M.anaAdmin);
    $ana = money(caller(api, issuer, 'ana', M.anaAdmin));
    today = (await db.admin.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
    const mk = (email: string, role: string, displayName: string, routeIds: string[]) => newPerson(api, issuer, provider.ids, bruno, { email, role, displayName, routeIds });
    carlos = await mk('carlos-cc5@example.test', 'cobrador', 'Carlos', [r1]);
    // Ronda 62 (exclusividad): con Carlos activo en r1, la Supervisora solo cobra en una ruta SIN
    // Cobrador activo (rs). En r1, el segundo cobro concurrente lo registra la oficina a nombre de Carlos.
    rs = (await bruno('POST', '/v1/routes', { name: 'Ruta Supervisora CC5', interestRate: 20, freeRate: false, maxLoanMinor: 0, adminIds: [M.anaAdmin] })).body['id'] as string;
    dora = await mk('dora-cc5@example.test', 'supervisor', 'Dora', [r1, rs]);
    olga = await mk('olga-cc5@example.test', 'admin', 'Olga', []);
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 9_000_000, reason: 'Capital sintético' }],
      ['/v1/capital/allocations', { adminId: M.anaAdmin, amountMinor: 5_000_000, reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: olga.membershipId, amountMinor: 100_000, reason: 'Bolsa de Olga' }],
    ] as const) if ((await $bruno(path, body)).status !== 201) throw new Error(path);
  });
  after(async () => { await api.close(); await db.close(); });

  test('CC5-001 · dos recaudos simultáneos sobre el mismo saldo: el segundo se topa; nunca se cobra de más', async () => {
    for (let round = 0; round < 4; round++) {
      const s = await credit(50_000, 10);   // total 60.000
      const [a, b] = await Promise.all([collect(carlos.money, s, 40_000), $ana('/v1/collections', { saleId: s, amountMinor: 40_000, collectorId: carlos.membershipId })]);
      assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify([a.body, b.body]));
      assert.deepEqual([a.body['appliedMinor'], b.body['appliedMinor']].sort(), [20_000, 40_000], 'el que llega segundo ve el saldo nuevo');
      assert.equal([a, b].filter((x) => x.body['capped'] === true).length, 1);
      assert.equal(await paidOf(s), 60_000);
      const st = (await db.admin.query('select status, balance_minor::int b from adex.sales where id = $1', [s])).rows[0];
      assert.deepEqual(st, { status: 'finalizada', b: 0 });
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
  });

  test('CC5-002 · el saldo completo cobrado 8 veces a la vez (ids distintos): un solo cobro', async () => {
    const s = await credit(20_000, 4);
    const before = await custody(carlos.membershipId);
    const res = await parallel(8, () => collect(carlos.money, s, 24_000));
    assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.body['error'] ?? r.status)));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body['error'] === 'CREDIT_NOT_ACTIVE'));
    assert.equal(await paidOf(s), 24_000);
    assert.equal(await custody(carlos.membershipId), before + 24_000);
  });

  test('CC5-003 · el MISMO operationId 6 veces a la vez: una operación, la misma respuesta', async () => {
    const s = await credit();
    const op = randomUUID();
    const res = await parallel(6, () => collect(carlos.money, s, 5_000, op));
    assert.ok(res.every((r) => r.status === 201), JSON.stringify(res.map((r) => r.status)));
    assert.equal(new Set(res.map((r) => r.body['paymentId'])).size, 1);
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1);
    assert.equal(await count(db.admin, `select 1 from adex.capital_operations where operation_id = $1`, [op]), 1);
  });

  test('CC5-004 · dos gastos administrativos simultáneos sobre el mismo disponible: uno pasa, el otro sin fondos', async () => {
    for (let round = 0; round < 3; round++) {
      const left = await pool(olga.membershipId);
      const amountMinor = Math.floor(left * 0.7);
      const res = await Promise.all([0, 1].map(() => $bruno('/v1/expenses', { scope: 'empresa', categoryId: cat, amountMinor, description: 'Concurrente',
        fundingSource: 'admin', fundingAdminId: olga.membershipId })));
      assert.deepEqual(res.map((r) => r.status).sort(), [201, 409], JSON.stringify(res.map((r) => r.body)));
      assert.equal(res.find((r) => r.status === 409)!.body['error'], 'INSUFFICIENT_FUNDS');
      assert.equal(await pool(olga.membershipId), left - amountMinor);
    }
    assert.ok(await pool(olga.membershipId) >= 0);
  });

  test('CC5-005 · gasto del trabajador contra devolución simultánea de la misma custodia: el negativo solo por el gasto', async () => {
    for (let round = 0; round < 4; round++) {
      const start = await custody(carlos.membershipId);
      if (start < 10_000) assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 10_000 - start, reason: 'Base' })).status, 201);
      const base = await custody(carlos.membershipId);
      const [exp, ret] = await Promise.all([
        carlos.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 8_000, description: 'Combustible' }),
        $ana('/v1/capital/returns', { routeId: r1, workerId: carlos.membershipId, amountMinor: 8_000, reason: 'Entrega del día' }),
      ]);
      assert.equal(exp.status, 201, 'el gasto del trabajador no tiene tope');
      const end = await custody(carlos.membershipId);
      if (ret.status === 201) assert.equal(end, base - 16_000, 'la devolución llegó antes; el gasto deja el negativo');
      else { assert.equal(ret.body['error'], 'INSUFFICIENT_FUNDS'); assert.equal(end, base - 8_000); }
      if (end < 0) assert.equal((await $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: -end, reason: 'Repone' })).status, 201);
    }
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN, 'ninguna pata no-gasto dejó la custodia bajo cero');
  });

  test('CC5-006 · operación interrumpida antes del COMMIT: ni pago, ni cuotas, ni asiento, ni auditoría, ni idempotencia; el reintento cobra una vez', async () => {
    const failing = await startCompanyApi(db, issuer, provider, {
      beforeCommit: async (_c, path) => { if (path === '/v1/collections' || path === '/v1/expenses') throw new Error('fallo simulado tras escribir'); },
    });
    try {
      const s = await credit();
      const snap = async () => ({
        pays: await count(db.admin, 'select 1 from adex.payments'), ops: await count(db.admin, 'select 1 from adex.capital_operations'),
        audit: await count(db.admin, 'select 1 from adex.audit_log'), idem: await count(db.admin, 'select 1 from adex.operations'),
        exp: await count(db.admin, 'select 1 from adex.expenses'), cash: await custody(carlos.membershipId),
        inst: (await db.admin.query('select string_agg(balance_minor::text, \',\' order by number) b from adex.installments where sale_id = $1', [s])).rows[0].b,
        sale: (await db.admin.query('select balance_minor::int b from adex.sales where id = $1', [s])).rows[0].b,
      });
      const before = await snap();
      const op = randomUUID();
      const failCarlos = money(caller(failing, issuer, carlos.identityId, carlos.membershipId));
      const r = await collect(failCarlos, s, 5_000, op);
      assert.deepEqual([r.status, r.body], [500, { error: 'INTERNAL' }]);
      const e = await failCarlos('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 1_000 });
      assert.equal(e.status, 500);
      assert.deepEqual(await snap(), before, 'todo o nada');
      assert.equal((await carlos.call('GET', `/v1/operations/${op}`)).status, 404, 'el cliente sabe que NO se confirmó');
      const again = await collect(carlos.money, s, 5_000, op);
      assert.equal(again.status, 201, 'repetir con el mismo id es seguro');
      assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1);
    } finally { await failing.close(); }
  });

  test('CC5-007 · respuesta perdida después del COMMIT: se recupera por el id; repetir no duplica', async () => {
    const s = await credit();
    const op = randomUUID();
    const token = await issuer.issue(carlos.identityId);
    const body = JSON.stringify({ saleId: s, amountMinor: 5_000 });
    // La respuesta se pierde: el cliente corta la conexión en cuanto envió el comando.
    await new Promise<void>((resolve) => {
      const req = http.request(`${api.base}/v1/collections`, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'x-adex-membership': carlos.membershipId, 'x-adex-operation-id': op,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
      req.on('error', () => resolve());
      req.end(body, () => setTimeout(() => { req.destroy(); resolve(); }, 2));
    });
    // El cliente no sabe si se confirmó: repite con el MISMO id (nunca con uno nuevo).
    const retry = await collect(carlos.money, s, 5_000, op);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    const known = await carlos.call('GET', `/v1/operations/${op}`);
    assert.deepEqual([known.status, known.body['outcome'], known.body['httpStatus']], [200, 'approved', 201]);
    assert.deepEqual(known.body['result'], retry.body, 'el resultado guardado es la respuesta completa');
    assert.deepEqual((await collect(carlos.money, s, 5_000, op)).body, retry.body);
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1, 'un solo cobro');
    assert.equal(await count(db.admin, 'select 1 from adex.operations where operation_id = $1', [op]), 1);
  });

  test('CC5-008 · revocación (desactivar al Cobrador) mientras cobra: espera; después ya no opera', async () => {
    const eva = await newPerson(api, issuer, provider.ids, bruno, { email: 'eva-cc5@example.test', role: 'supervisor', displayName: 'Eva', routeIds: [rs] });
    const s = await credit(50_000, 10, rs);
    let release!: () => void;
    let arrived!: () => void;
    let pausedOnce = false;
    const reached = new Promise<void>((r) => { arrived = r; });
    const paused = await startCompanyApi(db, issuer, provider, {
      afterContext: async (ctx, path) => {
        if (path === '/v1/collections' && ctx.membershipId === eva.membershipId && !pausedOnce) { pausedOnce = true; arrived(); await new Promise<void>((r) => { release = r; }); }
      },
    });
    try {
      const p = collect(money(caller(paused, issuer, eva.identityId, eva.membershipId)), s, 5_000);
      await reached;
      const revoke = bruno('POST', `/v1/members/${eva.membershipId}/deactivate`, {});
      await sleep(300);
      release();
      assert.equal((await p).status, 201, 'autorizada cuando empezó: la revocación esperó (REVOKE-004)');
      assert.equal((await revoke).status, 200);
    } finally { await paused.close(); }
    const after = await collect(eva.money, s, 5_000);
    assert.deepEqual([after.status, after.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
    const exp = await eva.money('/v1/expenses', { scope: 'trabajador', routeId: rs, workerId: eva.membershipId, categoryId: cat, amountMinor: 100 });
    assert.equal(exp.status, 403);
    assert.equal(await count(db.admin, 'select 1 from adex.payments where sale_id = $1', [s]), 1);
  });

  test('CC5-009 · anulación de un cobro contra devolución simultánea del mismo efectivo: nunca ambas', async () => {
    for (let round = 0; round < 4; round++) {
      // Dora queda con exactamente el efectivo de un cobro.
      const left = await balance(db.admin, c1, 'custody', dora.membershipId, rs);
      if (left > 0) assert.equal((await $ana('/v1/capital/returns', { routeId: rs, workerId: dora.membershipId, amountMinor: left, reason: 'Vacía' })).status, 201);
      const s = await credit(50_000, 10, rs);
      const pay = ((await collect(dora.money, s, 6_000)).body['payment'] as Body)['id'] as string;
      const [rev, ret] = await Promise.all([
        $ana(`/v1/collections/${pay}/reverse`, { reason: 'Anulación concurrente' }),
        $ana('/v1/capital/returns', { routeId: rs, workerId: dora.membershipId, amountMinor: 6_000, reason: 'Devolución concurrente' }),
      ]);
      assert.deepEqual([rev.status, ret.status].sort(), [201, 409], JSON.stringify([rev.body, ret.body]));
      assert.equal(await balance(db.admin, c1, 'custody', dora.membershipId, rs), 0, 'el mismo dinero no sale dos veces');
    }
  });

  test('CC5-010 · dos anulaciones simultáneas del mismo cobro: una sola', async () => {
    const s = await credit();
    const pay = ((await collect(carlos.money, s, 5_000)).body['payment'] as Body)['id'] as string;
    const res = await parallel(5, () => $ana(`/v1/collections/${pay}/reverse`, { reason: 'Carrera' }));
    assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => r.body['error'] ?? r.status)));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.body['error'] === 'ALREADY_REVERSED'));
    assert.equal(await count(db.admin, 'select 1 from adex.payments where reverses_payment_id = $1', [pay]), 1);
  });

  test('CC5-011 · ráfaga mixta (cobros, gastos, entregas, devoluciones, anulaciones): 0 interbloqueos y conciliación exacta', async () => {
    const sales = await Promise.all([1, 2, 3].map(() => credit(60_000, 12)));
    const supSales = await Promise.all([1, 2, 3].map(() => credit(60_000, 12, rs)));
    const deadlocks = async () => Number((await db.admin.query('select deadlocks::text d from pg_stat_database where datname = current_database()')).rows[0].d);
    const d0 = await deadlocks();
    const jobs = Array.from({ length: 36 }, (_, i) => async () => {
      const s = sales[i % 3]!;
      switch (i % 6) {
        case 0: return collect(carlos.money, s, 3_000);
        case 1: return collect(dora.money, supSales[i % 3]!, 2_000);
        case 2: return carlos.money('/v1/expenses', { scope: 'trabajador', routeId: r1, workerId: carlos.membershipId, categoryId: cat, amountMinor: 700 });
        case 3: return $ana('/v1/capital/deliveries', { routeId: r1, workerId: carlos.membershipId, amountMinor: 1_500, reason: 'Base' });
        case 4: return $ana('/v1/capital/returns', { routeId: rs, workerId: dora.membershipId, amountMinor: 500, reason: 'Devolución' });
        default: return $ana('/v1/expenses', { scope: 'ruta', routeId: r1, categoryId: cat, amountMinor: 300, description: 'Ruta' });
      }
    });
    const res = await Promise.all(jobs.map((j) => j()));
    assert.ok(res.every((r) => r.status === 201 || (r.status === 409 && ['INSUFFICIENT_FUNDS', 'CREDIT_NOT_ACTIVE'].includes(r.body['error'] as string))),
      JSON.stringify(res.filter((r) => r.status !== 201).map((r) => r.body)));
    const pays = (await db.admin.query(`select id from adex.payments where sale_id = any($1) and state = 'active' order by created_at limit 4`, [[...sales, ...supSales]])).rows.map((x) => x.id);
    const revs = await Promise.all(pays.map((p) => $ana(`/v1/collections/${p}/reverse`, { reason: 'Ráfaga' })));
    assert.ok(revs.every((r) => r.status === 201 || r.body['error'] === 'FUNDS_ALREADY_USED'), JSON.stringify(revs.map((r) => r.body['error'] ?? r.status)));
    // Las estadísticas de PostgreSQL se publican con retraso (hasta ~10 s).
    await sleep(11_000);
    assert.equal(await deadlocks(), d0, 'sin interbloqueos (withTransaction los reintentaría en silencio)');
    const rec = (await bruno('GET', '/v1/capital/reconciliation')).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    assert.deepEqual(await reconcile(db.admin, c1), CLEAN);
    assert.deepEqual(api.errors, []);
  });
});
