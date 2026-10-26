// FASE 6 · cuadres y cierres en ADEX-Staging (PostgreSQL gestionado + Supabase Auth reales).
// Tokens reales → API de empresa en un proceso de prueba AISLADO (nunca la API publicada) →
// `adex_api` por el pooler → PostgreSQL con RLS. Sin URL de staging: SKIPPED.
//
// Datos 100 % sintéticos: dos empresas nuevas por ejecución (`stg-f6-*`; A en COP con
// America/Bogota), personas `@example.test` que se borran de Auth al terminar. Ni la Empresa
// Demo ni CLEAN se tocan. Para el periodo cerrado (H) solo se cambia la zona horaria de la
// empresa sintética de esta ejecución (sin re-fechar asientos ni tocar tablas compartidas).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyApi } from '../../src/http/companyApi.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_ADMIN_URL'] && env['SUPABASE_URL'] && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging con 0014';

type Body = Record<string, unknown>;
type Who = 'sa' | 'ana' | 'cobA' | 'cobB' | 'sup' | 'xavier' | 'carla';
const $ = (pesos: number) => pesos * 100;

describe('Fase 6 · cuadres y cierres (ADEX-Staging)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const A = `stg-f6-${run}-a`;
  const B = `stg-f6-${run}-b`;
  const r = { a: `${A}-ra`, b: `${A}-rb`, c: `${A}-rc`, d: `${A}-rd`, e: `${A}-re`, f: `${A}-rf`, g: `${A}-rg`, h: `${A}-rh`, own: `${A}-rown` };
  const m = { sa: `${A}-sa`, ana: `${A}-ana`, anaCob: `${A}-anacob`, cobA: `${A}-coba`, cobB: `${A}-cobb`, sup: `${A}-sup`, x: `${A}-xavier`, bSa: `${B}-sa` };
  const people: Record<Who, { email: string; id: string; token: string }> = Object.fromEntries(
    (['sa', 'ana', 'cobA', 'cobB', 'sup', 'xavier', 'carla'] as const).map((w) => [w, { email: `staging-f6-${w.toLowerCase()}-${run}@example.test`, id: '', token: '' }])) as never;
  const password = randomBytes(18).toString('base64url');
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let server: ReturnType<typeof createCompanyApi>;
  let base = '';
  let today = '';
  let clientSeq = 0;
  const errors: unknown[] = [];

  before(async () => {
    for (const p of Object.values(people)) {
      const res = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: p.email, password, email_confirm: true }) });
      assert.ok(res.ok, `crear usuario sintético: ${res.status}`);
      p.id = ((await res.json()) as { id: string }).id;
    }
    const ssl = { rejectUnauthorized: false };
    apiPool = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 12 });
    adminPool = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 3 });
    for (const [name, pool] of [['admin', adminPool], ['api', apiPool]] as const) pool.on('error', (e) => console.error(`[pool ${name}]`, e.message));
    const c = await adminPool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, created_at, updated_at)
                     values ($1, $2, $3, 'operativo', 'activa', 'CO', 'Colombia', 'COP', 'America/Bogota', now(), now()),
                            ($4, $5, $6, 'operativo', 'activa', 'BR', 'Brasil', 'BRL', 'America/Sao_Paulo', now(), now())`,
        [A, `Staging F6 A ${run}`, `stg-f6-${run}-a@example.test`, B, `Staging F6 B ${run}`, `stg-f6-${run}-b@example.test`]);
      for (const p of Object.values(people)) await c.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [p.id, p.email]);
      const mem = [
        [m.sa, A, 'sa', 'superadmin', 'F6 SuperAdmin'], [m.ana, A, 'ana', 'admin', 'F6 Ana Responsable'], [m.anaCob, A, 'ana', 'cobrador', 'F6 Ana Cobradora'],
        [m.cobA, A, 'cobA', 'cobrador', 'F6 Cobrador A'], [m.cobB, A, 'cobB', 'cobrador', 'F6 Cobrador B'], [m.sup, A, 'sup', 'supervisor', 'F6 Supervisora'],
        [m.x, A, 'xavier', 'admin', 'F6 Xavier'], [m.bSa, B, 'carla', 'superadmin', 'F6 Carla SuperAdmin B'],
      ] as const;
      for (const [id, co, who, role, name] of mem) {
        await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                       values ($1, $2, $3, $4, 'activo', $5, now(), now())`, [id, co, people[who].id, role, name]);
      }
      const routes: [string, string, string | null][] = [[r.a, 'RT-001', m.cobA], [r.b, 'RT-002', m.cobA], [r.c, 'RT-003', m.cobA], [r.d, 'RT-004', m.cobA],
        [r.e, 'RT-005', m.cobA], [r.f, 'RT-006', m.cobA], [r.g, 'RT-007', m.cobA], [r.h, 'RT-008', m.cobA], [r.own, 'RT-009', m.anaCob]];
      for (const [id, code, collector] of routes) {
        await c.query(`insert into adex.routes (id, company_id, name, code, interest_rate, free_rate, max_loan_minor, initial_capital_minor, legacy_capital_actual_minor,
                         collector_membership_id, capital_controller_membership_id, capital_controller_since, status, created_at, updated_at)
                       values ($1, $2, $3, $4, 20, false, 0, 0, 0, $5, $6, now(), 'activa', now(), now())`, [id, A, `Ruta F6 ${code}`, code, collector, m.ana]);
      }
      const assigned: [string, string][] = [
        ...Object.values(r).map((x) => [m.ana, x] as [string, string]),
        ...[r.a, r.b, r.c, r.d, r.e, r.f, r.g, r.h].map((x) => [m.cobA, x] as [string, string]),
        [m.cobB, r.e], [m.sup, r.e], [m.sup, r.a], [m.x, r.a], [m.anaCob, r.own],
      ];
      for (const [mm, rr] of assigned) await c.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [A, mm, rr]);
      await c.query(`insert into adex.expense_categories (id, company_id, name, active) values ($1, $2, 'Combustible', true)`, [`${A}-cat`, A]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    today = (await adminPool.query<{ d: string }>(`select (now() at time zone 'America/Bogota')::date::text d`)).rows[0]!.d;
    server = createCompanyApi({
      pool: apiPool, verifyToken: createTokenVerifier({ issuer: `${url}/auth/v1` }),
      provider: createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret }),
      onError: (e) => { errors.push(e); console.error('[api 500]', (e as Error).message); },
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    for (const p of Object.values(people)) p.token = (await auth.signInWithPassword(p.email, password)).accessToken;
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: $(50_000_000), reason: 'Capital sintético F6' }],
      ['/v1/capital/allocations', { adminId: m.ana, amountMinor: $(30_000_000), reason: 'Bolsa de Ana' }],
    ] as const) assert.equal((await money('sa', path, m.sa, body)).status, 201, path);
  });
  after(async () => {
    server?.close();
    for (const p of Object.values(people)) if (p.id) await fetch(`${url}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: adminHeaders });
    await apiPool?.end();
    await adminPool?.end();
  });

  async function call(who: Who, method: string, path: string, membership: string, body?: unknown, op?: string) {
    const h: Record<string, string> = { authorization: `Bearer ${people[who].token}`, 'x-adex-membership': membership };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (op) h['x-adex-operation-id'] = op;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Body };
  }
  const money = (who: Who, path: string, membership: string, body: Body, op: string = randomUUID()) => call(who, 'POST', path, membership, body, op);
  const bal = async (co: string, kind: string, membership: string | null, route: string | null) => Number((await adminPool.query<{ b: string }>(
    `select coalesce((select balance_minor from adex.capital_accounts where company_id = $1 and kind = $2 and membership_id is not distinct from $3
                         and route_id is not distinct from $4), 0)::text b`, [co, kind, membership, route])).rows[0]!.b);
  const carried = async (mm: string, route: string) => Number((await adminPool.query<{ c: string }>(
    `select coalesce((select carried_minor from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 and route_id = $3), 0)::text c`, [A, mm, route])).rows[0]!.c);
  const custody = (mm: string, route: string) => bal(A, 'custody', mm, route);
  const pool = (mm: string) => bal(A, 'admin', mm, null);
  const deliver = async (route: string, worker: string, amountMinor: number) =>
    assert.equal((await money('ana', '/v1/capital/deliveries', m.ana, { routeId: route, workerId: worker, amountMinor, reason: 'Base' })).status, 201);
  const preview = async (who: Who, membership: string, route: string, worker: string) => {
    const res = await call(who, 'GET', `/v1/settlements/preview?routeId=${route}&workerId=${worker}`, membership);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const settle = (who: Who, membership: string, route: string, worker: string, delivered: number, p: Body, reason?: string, op?: string) =>
    money(who, '/v1/settlements', membership, { routeId: route, workerId: worker, deliveredMinor: delivered, expectedSeenMinor: p['expectedPositionMinor'],
      previousSettlementId: p['previousSettlementId'] ?? null, ...(reason ? { reason } : {}) }, op);
  async function credit(route: string, amountMinor = $(2_000_000)) {
    const doc = String(1_000_000 + Number.parseInt(randomBytes(3).toString('hex'), 16) % 8_999_999);
    const cl = await call('sa', 'POST', '/v1/clients', m.sa, { routeId: route, name: `Cliente ficticio F6 ${++clientSeq}`, documentType: 'CC', document: doc,
      phonePrimary: '3000000000', addressPrimary: 'Calle 1', addressSecondary: 'Barrio', business: 'Negocio sintético' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const res = await money('ana', '/v1/credits/direct', m.ana, { routeId: route, clientId: cl.body['id'], amountMinor, interestRate: 20, installmentsCount: 10,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body['credit'] as Body)['id'] as string;
  }
  const collect = async (saleId: string, amountMinor: number) =>
    assert.equal((await money('cobA', '/v1/collections', m.cobA, { saleId, amountMinor })).status, 201);
  async function reconciled() {
    const rec = await call('sa', 'GET', '/v1/capital/reconciliation', m.sa);
    assert.equal(rec.status, 200);
    assert.deepEqual((rec.body['checks'] as Body[]).filter((x) => !x['ok']), [], 'conciliación sin diferencias');
    const t = Number((await adminPool.query<{ t: string }>('select coalesce(sum(balance_minor), 0)::text t from adex.capital_accounts where company_id = $1', [A])).rows[0]!.t);
    assert.equal(t, 0, 'Σ saldos = 0');
  }

  test('STG-F6-A/D · cuadre exacto y entregas parciales: esperado del servidor, devoluciones contadas una sola vez', async () => {
    await deliver(r.a, m.cobA, $(300_000));
    await collect(await credit(r.a), $(200_000));
    const p = await preview('ana', m.ana, r.a, m.cobA);
    assert.equal(p['expectedPositionMinor'], $(500_000));
    const before = await pool(m.ana);
    const s = await settle('ana', m.ana, r.a, m.cobA, $(500_000), p);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.deepEqual([(s.body['settlement'] as Body)['result'], await pool(m.ana) - before, await custody(m.cobA, r.a)], ['exacto', $(500_000), 0]);
    // D: +500 +300 −400 +200 −100
    await deliver(r.d, m.cobA, $(500_000));
    const sale = await credit(r.d);
    await collect(sale, $(300_000));
    assert.equal((await money('ana', '/v1/capital/returns', m.ana, { routeId: r.d, workerId: m.cobA, amountMinor: $(400_000), reason: 'Entrega parcial' })).status, 201);
    await collect(sale, $(200_000));
    assert.equal((await money('ana', '/v1/capital/returns', m.ana, { routeId: r.d, workerId: m.cobA, amountMinor: $(100_000), reason: 'Entrega parcial' })).status, 201);
    const pd = await preview('ana', m.ana, r.d, m.cobA);
    assert.equal(pd['expectedPositionMinor'], $(500_000));
    assert.equal((await settle('ana', m.ana, r.d, m.cobA, $(500_000), pd)).status, 201);
    assert.equal(await custody(m.cobA, r.d), 0);
    await reconciled();
  });

  test('STG-F6-B/C · faltante arrastrado no gastable y sin doble descuento; sobrante en control, no capital', async () => {
    await deliver(r.b, m.cobA, $(500_000));
    const before = await pool(m.ana);
    const s1 = await settle('ana', m.ana, r.b, m.cobA, $(450_000), await preview('ana', m.ana, r.b, m.cobA), 'Faltaron billetes al contar');
    assert.equal(s1.status, 201, JSON.stringify(s1.body));
    assert.deepEqual([await pool(m.ana) - before, await custody(m.cobA, r.b), await carried(m.cobA, r.b)], [$(450_000), $(50_000), $(50_000)]);
    assert.equal((await money('ana', '/v1/capital/returns', m.ana, { routeId: r.b, workerId: m.cobA, amountMinor: $(1), reason: 'Arrastre' })).body['error'], 'INSUFFICIENT_FUNDS');
    await deliver(r.b, m.cobA, $(100_000));
    const p2 = await preview('ana', m.ana, r.b, m.cobA);
    assert.deepEqual([p2['expectedPositionMinor'], p2['availableMinor']], [$(150_000), $(100_000)]);
    const s2 = await settle('ana', m.ana, r.b, m.cobA, $(150_000), p2);
    assert.deepEqual([(s2.body['settlement'] as Body)['result'], await carried(m.cobA, r.b)], ['exacto', 0]);
    await deliver(r.c, m.cobA, $(500_000));
    const c = await settle('ana', m.ana, r.c, m.cobA, $(530_000), await preview('ana', m.ana, r.c, m.cobA), 'Entregó billetes de más');
    assert.deepEqual([(c.body['settlement'] as Body)['surplusMinor'], await bal(A, 'suspense', m.ana, r.c), await bal(A, 'unidentified', null, r.c)],
      [$(30_000), $(30_000), -$(30_000)]);
    await reconciled();
  });

  test('STG-F6-E/F · varios trabajadores independientes (consolidado 750.000); negativo por gasto conciliado sin devolución ficticia', async () => {
    await deliver(r.e, m.cobA, $(400_000));
    await deliver(r.e, m.cobB, $(250_000));
    await deliver(r.e, m.sup, $(100_000));
    const w = await call('ana', 'GET', `/v1/settlements/workers?routeId=${r.e}`, m.ana);
    assert.equal(w.body['routeTotalPositionMinor'], $(750_000));
    const sa = await settle('sup', m.sup, r.e, m.cobA, $(350_000), await preview('sup', m.sup, r.e, m.cobA), 'Faltante en campo');
    assert.equal(sa.status, 201, JSON.stringify(sa.body));
    assert.deepEqual([await custody(m.cobB, r.e), await custody(m.sup, r.e)], [$(250_000), $(100_000)], 'el faltante de A no toca a los demás');
    assert.equal((await settle('sup', m.sup, r.e, m.sup, $(100_000), await preview('ana', m.ana, r.e, m.sup))).body['error'], 'SELF_SETTLEMENT_FORBIDDEN');
    await deliver(r.f, m.cobA, $(20_000));
    assert.equal((await money('cobA', '/v1/expenses', m.cobA, { scope: 'trabajador', routeId: r.f, workerId: m.cobA, categoryId: `${A}-cat`, amountMinor: $(50_000), description: 'Repuesto' })).status, 201);
    const pf = await preview('ana', m.ana, r.f, m.cobA);
    assert.deepEqual([pf['expectedPositionMinor'], pf['expectedCashMinor'], pf['availableMinor']], [-$(30_000), 0, 0]);
    const before = await pool(m.ana);
    const sf = await settle('ana', m.ana, r.f, m.cobA, 0, pf);
    assert.deepEqual([(sf.body['settlement'] as Body)['returnedToPoolMinor'], await pool(m.ana), await custody(m.cobA, r.f)], [0, before, -$(30_000)]);
    await deliver(r.f, m.cobA, $(100_000));
    assert.equal((await preview('ana', m.ana, r.f, m.cobA))['expectedPositionMinor'], $(70_000), 'continuidad al ciclo siguiente');
    await reconciled();
  });

  test('STG-F6-G · recaudo concurrente y dos cuadres simultáneos: cifras obsoletas rechazadas, un solo cuadre, cada cobro en un ciclo', async () => {
    await deliver(r.g, m.cobA, $(400_000));
    const sale = await credit(r.g);
    await collect(sale, $(100_000));
    const seen = await preview('ana', m.ana, r.g, m.cobA);
    await collect(sale, $(100_000));
    const stale = await settle('ana', m.ana, r.g, m.cobA, $(500_000), seen);
    assert.deepEqual([stale.status, stale.body['error']], [409, 'SETTLEMENT_STALE']);
    const fresh = await preview('ana', m.ana, r.g, m.cobA);
    assert.equal(fresh['expectedPositionMinor'], $(600_000));
    const two = await Promise.all([settle('ana', m.ana, r.g, m.cobA, $(600_000), fresh), settle('sa', m.sa, r.g, m.cobA, $(600_000), fresh)]);
    assert.deepEqual(two.map((x) => x.status).sort(), [201, 409]);
    const op = randomUUID();
    await deliver(r.g, m.cobA, $(1_000));
    const p = await preview('ana', m.ana, r.g, m.cobA);
    const same = await Promise.all([settle('ana', m.ana, r.g, m.cobA, $(1_000), p, undefined, op), settle('ana', m.ana, r.g, m.cobA, $(1_000), p, undefined, op)]);
    assert.deepEqual(same.map((x) => x.status), [201, 201]);
    assert.equal((same[0]!.body['settlement'] as Body)['id'], (same[1]!.body['settlement'] as Body)['id']);
    assert.equal((await call('ana', 'GET', `/v1/operations/${op}`, m.ana)).body['outcome'], 'approved');
    await reconciled();
  });

  test('STG-F6-SEC · DS-05, otra empresa, Owner y Cobrador: sin acceso indebido ni cifras en los rechazos', async () => {
    await deliver(r.own, m.anaCob, $(5_000));
    const p = await preview('sa', m.sa, r.own, m.anaCob);
    const self = await settle('ana', m.ana, r.own, m.anaCob, $(5_000), p);
    assert.deepEqual([self.status, self.body['error']], [403, 'SELF_SETTLEMENT_FORBIDDEN']);
    assert.equal((await settle('xavier', m.x, r.a, m.cobA, 0, await preview('ana', m.ana, r.a, m.cobA))).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    assert.equal((await settle('cobA', m.cobA, r.a, m.cobA, 0, p)).status, 403);
    assert.equal((await settle('carla', m.bSa, r.a, m.cobA, 0, p)).status, 404, 'otra empresa: indistinguible de inexistente');
    assert.equal(((await call('carla', 'GET', '/v1/settlements', m.bSa)).body['settlements'] as Body[]).length, 0);
    const mine = (await call('cobA', 'GET', '/v1/settlements', m.cobA)).body['settlements'] as Body[];
    assert.ok(mine.length > 0 && mine.every((s) => s['workerId'] === m.cobA));
    assert.equal((await call('cobA', 'GET', `/v1/periods?routeId=${r.a}`, m.cobA)).status, 403);
    // RLS directa: el Cobrador, con su contexto, no ve cuadres ajenos ni cuentas de control.
    const c = await apiPool.connect();
    try {
      await c.query('begin read only');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [people.cobA.id, m.cobA, A, randomUUID(), String(Math.floor(Date.now() / 1000))]);
      assert.equal(Number((await c.query(`select count(*) n from adex.custody_settlements where worker_membership_id <> $1`, [m.cobA])).rows[0].n), 0);
      assert.equal(Number((await c.query(`select count(*) n from adex.capital_accounts where kind in ('suspense', 'unidentified', 'admin')`)).rows[0].n), 0);
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
  });

  test('STG-F6-H/DS4 · periodo terminado según la zona de la empresa; cierre archivado; ajuste posterior en periodo abierto, enlazado', async () => {
    const tz = (zone: string) => adminPool.query('update adex.companies set timezone = $2 where id = $1', [A, zone]);
    await tz('Pacific/Pago_Pago');
    await deliver(r.h, m.cobA, $(300_000));
    const exp = await money('cobA', '/v1/expenses', m.cobA, { scope: 'trabajador', routeId: r.h, workerId: m.cobA, categoryId: `${A}-cat`, amountMinor: $(20_000), description: 'Gasolina' });
    assert.equal(exp.status, 201);
    const day = (await call('sa', 'GET', '/v1/periods/calendar', m.sa)).body['businessDate'] as string;
    const close = (who: Who, mm: string) => money(who, '/v1/periods/close', mm, { routeId: r.h, weekStart: day, weekEnd: day, note: 'Cierre de prueba' });
    // 0038: el periodo puede terminar hoy, no mañana (en Pago Pago).
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const early = await money('ana', '/v1/periods/close', m.ana, { routeId: r.h, weekStart: day, weekEnd: next, note: 'Cierre de prueba' });
    assert.equal(early.body['error'], 'PERIOD_NOT_ENDED', 'en Pago Pago ese periodo no ha terminado');
    await tz('Pacific/Kiritimati');
    assert.equal((await close('cobA', m.cobA)).status, 403);
    const both = await Promise.all([close('ana', m.ana), close('sa', m.sa)]);
    assert.deepEqual(both.map((x) => x.status).sort(), [201, 409], 'un solo cierre');
    const ok = both.find((x) => x.status === 201)!;
    const cust = (ok.body['figures'] as Body)['custody'] as Body;
    assert.deepEqual([cust['deliveriesMinor'], cust['workerExpensesMinor'], cust['closingMinor']], [$(300_000), $(20_000), $(280_000)]);
    const rev = await money('ana', `/v1/expenses/${(exp.body['expense'] as Body)['id']}/reverse`, m.ana, { reason: 'Gasto duplicado' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    const now = (await call('sa', 'GET', '/v1/periods/calendar', m.sa)).body['businessDate'];
    const op = (await adminPool.query(`select entry_date::text d from adex.capital_operations where company_id = $1 and expense_id = $2`, [A, (rev.body['reversal'] as Body)['id']])).rows[0];
    assert.equal(op.d, now, 'el ajuste va al periodo abierto');
    const archived = (await call('ana', 'GET', `/v1/periods/${ok.body['closureId']}`, m.ana)).body;
    assert.deepEqual((archived['figures'] as Body)['custody'], cust, 'el cierre histórico no cambia');
    await tz('America/Bogota');
    await reconciled();
    assert.equal(errors.length, 0, 'sin errores 500');
  });
});
