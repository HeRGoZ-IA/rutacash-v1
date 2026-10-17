// FASE 5 · recaudos y gastos contra ADEX-Staging REAL: tokens reales de Supabase Auth →
// API de empresa → `adex_api` por el pooler → PostgreSQL gestionado con RLS. Solo con
// `node scripts/staging.ts --test` (y 0013 aplicada con autorización); si no, SKIPPED.
//
// Datos 100 % sintéticos: empresa sintética nueva por ejecución (BRL), una ruta, clientes
// ficticios y dos personas reales de Auth (responsable y cobrador). Nada de CLEAN.

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
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging con 0013 (node scripts/staging.ts --test)';

type Body = Record<string, unknown>;

describe('Fase 5 · recaudos y gastos en ADEX-Staging (Auth real + PostgreSQL gestionado)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const company = `stg-p5-${run}`;
  const route = `stg-p5-${run}-r1`;
  const m = { sa: `stg-p5-${run}-sa`, admin: `stg-p5-${run}-admin`, cob: `stg-p5-${run}-cob` };
  const people = { boss: { email: `staging-p5-boss-${run}@example.test`, id: '', token: '' }, worker: { email: `staging-p5-worker-${run}@example.test`, id: '', token: '' } };
  const password = randomBytes(18).toString('base64url');
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let base = '';
  let today = '';
  let category = '';
  let server: ReturnType<typeof createCompanyApi>;
  const errors: unknown[] = [];
  let clientSeq = 0;

  before(async () => {
    for (const p of Object.values(people)) {
      const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: p.email, password, email_confirm: true }) });
      assert.ok(r.ok, `crear usuario sintético: ${r.status}`);
      p.id = ((await r.json()) as { id: string }).id;
    }
    const ssl = { rejectUnauthorized: false };
    apiPool = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 12 });
    adminPool = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 3 });
    for (const [name, pool] of [['admin', adminPool], ['api', apiPool]] as const) pool.on('error', (e) => console.error(`[pool ${name}]`, e.message));
    const c = await adminPool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, created_at, updated_at)
                     values ($1, $2, $3, 'operativo', 'activa', 'BR', 'Brasil', 'BRL', 'America/Sao_Paulo', now(), now())`,
        [company, `Staging Fase 5 ${run}`, `stg-p5-${run}@example.test`]);
      for (const p of Object.values(people)) await c.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [p.id, p.email]);
      await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at) values
                       ($1, $4, $5, 'superadmin', 'activo', 'P5 SA', now(), now()),
                       ($2, $4, $5, 'admin', 'activo', 'P5 Responsable', now(), now()),
                       ($3, $4, $6, 'cobrador', 'activo', 'P5 Cobrador', now(), now())`, [m.sa, m.admin, m.cob, company, people.boss.id, people.worker.id]);
      await c.query(`insert into adex.routes (id, company_id, name, code, interest_rate, free_rate, max_loan_minor, initial_capital_minor, legacy_capital_actual_minor,
                       collector_membership_id, capital_controller_membership_id, capital_controller_since, status, created_at, updated_at)
                     values ($1, $2, 'Ruta Staging P5', 'RT-001', 20, false, 500000, 0, 0, $3, $4, now(), 'activa', now(), now())`, [route, company, m.cob, m.admin]);
      await c.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3), ($1, $4, $3)', [company, m.admin, route, m.cob]);
      category = `stg-p5-${run}-cat`;
      await c.query(`insert into adex.expense_categories (id, company_id, name, active) values ($1, $2, 'Combustible', true)`, [category, company]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    today = (await adminPool.query<{ d: string }>(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0]!.d;
    server = createCompanyApi({
      pool: apiPool,
      verifyToken: createTokenVerifier({ issuer: `${url}/auth/v1` }),
      provider: createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret }),
      onError: (e) => { errors.push(e); console.error('[api 500]', (e as Error).message); },
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    for (const p of Object.values(people)) p.token = (await auth.signInWithPassword(p.email, password)).accessToken;
  });
  after(async () => {
    server?.close();
    for (const p of Object.values(people)) if (p.id) await fetch(`${url}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: adminHeaders });
    await apiPool?.end();
    await adminPool?.end();
  });

  const call = async (who: 'boss' | 'worker', method: string, path: string, membership: string, body?: unknown, op?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${people[who].token}`, 'x-adex-membership': membership };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (op) headers['x-adex-operation-id'] = op;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Body };
  };
  const money = (who: 'boss' | 'worker', path: string, membership: string, body: Body, op = randomUUID()) => call(who, 'POST', path, membership, body, op);
  const bal = async (kind: string, membership: string | null, r: string | null) => Number((await adminPool.query<{ b: string }>(
    `select coalesce((select balance_minor from adex.capital_accounts where company_id = $1 and kind = $2 and membership_id is not distinct from $3
                         and route_id is not distinct from $4), 0)::text b`, [company, kind, membership, r])).rows[0]!.b);
  /** Crédito directo del responsable (desde su bolsa) a un cliente ficticio. */
  const credit = async (amountMinor: number, installmentsCount = 10) => {
    const doc = String(10_000_000_000 + Number.parseInt(randomBytes(4).toString('hex'), 16) % 89_999_999_999);
    const cl = await call('boss', 'POST', '/v1/clients', m.sa, { routeId: route, name: `Cliente ficticio ${++clientSeq}`, documentType: 'CPF', document: doc,
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const r = await money('boss', '/v1/credits/direct', m.admin, { routeId: route, clientId: cl.body['id'], amountMinor, interestRate: 20, installmentsCount,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body['credit'] as Body)['id'] as string;
  };

  test('STG-P5-001 · 0013 aplicada en gestionado: recaudos y gastos solo por funciones; la API no escribe dinero', async () => {
    const f = await adminPool.query<{ proname: string; definer: boolean; owner: string }>(
      `select p.proname, p.prosecdef definer, r.rolname owner from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.proname in ('collection_post', 'collection_reverse', 'expense_post', 'expense_reverse', 'expense_refund') order by 1`);
    assert.equal(f.rows.length, 5);
    assert.ok(f.rows.every((x) => x.definer && x.owner === 'adex_owner'));
    const w = await adminPool.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where grantee = 'adex_api' and table_schema = 'adex'
          and table_name in ('payments', 'expenses', 'sales', 'installments') and privilege_type <> 'SELECT'`);
    assert.equal(w.rows[0]!.n, 0);
  });

  test('STG-P5-002 · recaudo con tokens reales: cuota, custodia del Cobrador, tope al saldo y anulación por el responsable', async () => {
    assert.equal((await money('boss', '/v1/capital/company/deposits', m.sa, { amountMinor: 2_000_000, reason: 'Capital sintético staging' })).status, 201);
    assert.equal((await money('boss', '/v1/capital/allocations', m.sa, { adminId: m.admin, amountMinor: 1_000_000, reason: 'Bolsa del responsable' })).status, 201);
    const s = await credit(50_000);
    const r = await money('worker', '/v1/collections', m.cob, { saleId: s, amountMinor: 6_000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body['appliedMinor'], r.body['newBalanceMinor'], r.body['receiver']], [6_000, 54_000, 'custody']);
    assert.equal(await bal('custody', m.cob, route), 6_000);
    const capped = await money('worker', '/v1/collections', m.cob, { saleId: s, amountMinor: 99_000 });
    assert.deepEqual([capped.body['appliedMinor'], capped.body['capped']], [54_000, true]);
    const pay = (r.body['payment'] as Body)['id'];
    const rev = await money('boss', `/v1/collections/${pay}/reverse`, m.admin, { reason: 'Prueba de anulación' });
    assert.equal(rev.status, 201, JSON.stringify(rev.body));
    assert.equal(await bal('custody', m.cob, route), 54_000);
    assert.equal((await money('worker', `/v1/collections/${pay}/reverse`, m.cob, { reason: 'Propio' })).status, 403);
  });

  test('STG-P5-003 · concurrencia por el pooler: dos cobros sobre el mismo saldo y el mismo id repetido', async () => {
    const s = await credit(20_000, 4);   // total 24.000
    const both = await Promise.all([0, 1].map(() => money('worker', '/v1/collections', m.cob, { saleId: s, amountMinor: 15_000 })));
    assert.deepEqual(both.map((x) => x.status), [201, 201], JSON.stringify(both.map((x) => x.body)));
    assert.deepEqual(both.map((x) => x.body['appliedMinor']).sort(), [15_000, 9_000]);
    const s2 = await credit(10_000, 2);
    const op = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () => money('worker', '/v1/collections', m.cob, { saleId: s2, amountMinor: 1_000 }, op)));
    assert.ok(same.every((x) => x.status === 201));
    const n = await adminPool.query<{ n: number }>('select count(*)::int n from adex.payments where company_id = $1 and sale_id = $2', [company, s2]);
    assert.equal(n.rows[0]!.n, 1);
  });

  test('STG-P5-004 · gasto del trabajador: puede dejar la custodia negativa y ese negativo no se devuelve', async () => {
    const cash = await bal('custody', m.cob, route);
    const e = await money('worker', '/v1/expenses', m.cob, { scope: 'trabajador', routeId: route, workerId: m.cob, categoryId: category, amountMinor: cash + 3_000, description: 'Combustible' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.equal(await bal('custody', m.cob, route), -3_000);
    assert.equal((await money('boss', '/v1/capital/returns', m.admin, { routeId: route, workerId: m.cob, amountMinor: 1, reason: 'Negativo' })).body['error'], 'INSUFFICIENT_FUNDS');
  });

  test('STG-P5-005 · gastos administrativos simultáneos sobre la misma bolsa: uno pasa, el otro sin fondos', async () => {
    const left = await bal('admin', m.admin, null);
    const amountMinor = Math.floor(left * 0.7);
    const res = await Promise.all([0, 1].map(() => money('boss', '/v1/expenses', m.admin, { scope: 'empresa', categoryId: category, amountMinor, description: 'Concurrente',
      fundingSource: 'admin', fundingAdminId: m.admin })));
    assert.deepEqual(res.map((x) => x.status).sort(), [201, 409], JSON.stringify(res.map((x) => x.body)));
    assert.equal(await bal('admin', m.admin, null), left - amountMinor);
  });

  test('STG-P5-006 · conciliación en gestionado (API y SQL): libro cuadrado, cartera y gastos coherentes', async () => {
    const rec = (await call('boss', 'GET', '/v1/capital/reconciliation', m.sa)).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
    const total = await adminPool.query<{ t: string }>('select coalesce(sum(balance_minor), 0)::text t from adex.capital_accounts where company_id = $1', [company]);
    assert.equal(total.rows[0]!.t, '0');
  });

  test('STG-P5-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(errors, []);
  });
});
