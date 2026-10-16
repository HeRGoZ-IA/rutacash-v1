// FASE 4 · créditos (solicitud → autorización → desembolso) contra ADEX-Staging REAL:
// tokens reales de Supabase Auth → API de empresa → `adex_api` por el pooler → PostgreSQL
// gestionado con RLS. Solo con `node scripts/staging.ts --test`; si no, SKIPPED.
//
// Datos 100 % sintéticos: empresa sintética nueva por ejecución (BRL), una ruta, un
// cliente ficticio y dos personas reales de Auth (responsable y cobrador). Nada de CLEAN.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyApi } from '../../src/http/companyApi.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';
import { companyId, identityOf, membershipId } from '../../db/seeds/synthetic.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_ADMIN_URL'] && env['SUPABASE_URL'] && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging (node scripts/staging.ts --test)';

type Body = Record<string, unknown>;

describe('Fase 4 · créditos en ADEX-Staging (Auth real + PostgreSQL gestionado)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const company = `stg-p4-${run}`;
  const route = `stg-p4-${run}-r1`;
  const m = { sa: `stg-p4-${run}-sa`, admin: `stg-p4-${run}-admin`, cob: `stg-p4-${run}-cob` };
  const people = { boss: { email: `staging-p4-boss-${run}@example.test`, id: '', token: '' }, worker: { email: `staging-p4-worker-${run}@example.test`, id: '', token: '' } };
  const password = randomBytes(18).toString('base64url');
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let base = '';
  let today = '';
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
        [company, `Staging Fase 4 ${run}`, `stg-p4-${run}@example.test`]);
      for (const p of Object.values(people)) await c.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [p.id, p.email]);
      await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at) values
                       ($1, $4, $5, 'superadmin', 'activo', 'P4 SA', now(), now()),
                       ($2, $4, $5, 'admin', 'activo', 'P4 Responsable', now(), now()),
                       ($3, $4, $6, 'cobrador', 'activo', 'P4 Cobrador', now(), now())`, [m.sa, m.admin, m.cob, company, people.boss.id, people.worker.id]);
      await c.query(`insert into adex.routes (id, company_id, name, code, interest_rate, free_rate, max_loan_minor, initial_capital_minor, legacy_capital_actual_minor,
                       collector_membership_id, capital_controller_membership_id, capital_controller_since, status, created_at, updated_at)
                     values ($1, $2, 'Ruta Staging P4', 'RT-001', 20, false, 500000, 0, 0, $3, $4, now(), 'activa', now(), now())`, [route, company, m.cob, m.admin]);
      await c.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3), ($1, $4, $3)', [company, m.admin, route, m.cob]);
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
  /** Cliente ficticio de la ruta (alta por la API, documento sintético). */
  const newClient = async () => {
    const doc = String(10_000_000_000 + Number.parseInt(randomBytes(4).toString('hex'), 16) % 89_999_999_999);
    const r = await call('boss', 'POST', '/v1/clients', m.sa, { routeId: route, name: `Cliente ficticio ${++clientSeq}`, documentType: 'CPF', document: doc,
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body['id'] as string;
  };
  const approvedRequest = async (amountMinor: number) => {
    const r = await call('worker', 'POST', '/v1/credit-requests', m.cob, { routeId: route, clientId: await newClient(), amountMinor, interestRate: 20,
      installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await call('boss', 'POST', `/v1/credit-requests/${r.body['id']}/approve`, m.admin, {})).status, 200);
    return r.body['id'] as string;
  };

  test('STG-P4-001 · 0010 aplicada en gestionado: créditos solo por la función de desembolso', async () => {
    const f = await adminPool.query<{ definer: boolean; owner: string }>(
      `select p.prosecdef definer, r.rolname owner from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'credit_disburse'`);
    assert.deepEqual(f.rows, [{ definer: true, owner: 'adex_owner' }]);
    const w = await adminPool.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where grantee = 'adex_api' and table_schema = 'adex'
          and table_name in ('sales', 'installments') and privilege_type <> 'SELECT'`);
    assert.equal(w.rows[0]!.n, 0);
  });

  test('STG-P4-002 · flujo completo con tokens reales: anticipo sin deuda, solicitud al 20 %, aprobación al 10 %, desembolso desde la custodia', async () => {
    assert.equal((await money('boss', '/v1/capital/company/deposits', m.sa, { amountMinor: 1_000_000, reason: 'Capital sintético staging' })).status, 201);
    assert.equal((await money('boss', '/v1/capital/allocations', m.sa, { adminId: m.admin, amountMinor: 600_000, reason: 'Bolsa del responsable' })).status, 201);
    assert.equal((await money('boss', '/v1/capital/deliveries', m.admin, { routeId: route, workerId: m.cob, amountMinor: 100_000, reason: 'Anticipo del día' })).status, 201);
    assert.equal((await adminPool.query<{ n: number }>('select count(*)::int n from adex.sales where company_id = $1', [company])).rows[0]!.n, 0, 'el anticipo no es deuda');
    const cl = await newClient();
    assert.equal((await call('worker', 'POST', '/v1/credit-requests', m.cob, { routeId: route, clientId: cl, amountMinor: 50_000, interestRate: 10,
      installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] })).body['error'], 'INTEREST_RATE_NOT_ALLOWED');
    const req = await call('worker', 'POST', '/v1/credit-requests', m.cob, { routeId: route, clientId: cl, amountMinor: 50_000, interestRate: 20,
      installmentsCount: 10, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
    assert.equal(req.status, 201);
    const ap = await call('boss', 'POST', `/v1/credit-requests/${req.body['id']}/approve`, m.admin, { interestRate: 10 });
    assert.deepEqual([ap.status, ap.body['totalAmountMinor']], [200, 55_000]);
    const d = await money('worker', `/v1/credit-requests/${req.body['id']}/disburse`, m.cob, {});
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const credit = d.body['credit'] as Body;
    assert.deepEqual([credit['disbursementStatus'], credit['totalValueMinor'], (d.body['installments'] as Body[]).length], ['desembolsado', 55_000, 10]);
    assert.deepEqual([await bal('custody', m.cob, route), await bal('admin', m.admin, null), await bal('portfolio', null, route)], [50_000, 500_000, 50_000]);
    const rec = (await call('boss', 'GET', '/v1/capital/reconciliation', m.sa)).body;
    assert.equal(rec['ok'], true, JSON.stringify(rec));
  });

  test('STG-P4-003 · concurrencia por el pooler: doble desembolso, reintento idéntico y competencia por el efectivo', async () => {
    const req = await approvedRequest(10_000);
    const rs = await Promise.all(Array.from({ length: 6 }, () => money('worker', `/v1/credit-requests/${req}/disburse`, m.cob, {})));
    assert.equal(rs.filter((x) => x.status === 201).length, 1, JSON.stringify(rs.map((x) => x.status)));
    assert.ok(rs.filter((x) => x.status !== 201).every((x) => x.body['error'] === 'REQUEST_NOT_DISBURSABLE'));
    const again = await approvedRequest(5_000);
    const op = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () => money('worker', `/v1/credit-requests/${again}/disburse`, m.cob, {}, op)));
    assert.ok(same.every((x) => x.status === 201), JSON.stringify(same.map((x) => x.status)));
    const n = await adminPool.query<{ n: number }>('select count(*)::int n from adex.sales where company_id = $1 and sale_request_id = $2', [company, again]);
    assert.equal(n.rows[0]!.n, 1);
    // Custodia restante: 50.000 − 10.000 − 5.000 = 35.000; dos de 30.000 compiten.
    const [a, b] = [await approvedRequest(30_000), await approvedRequest(30_000)];
    const race = await Promise.all([a, b].map((id) => money('worker', `/v1/credit-requests/${id}/disburse`, m.cob, {})));
    assert.deepEqual(race.map((x) => x.status).sort(), [201, 409]);
    assert.equal(race.find((x) => x.status === 409)!.body['error'], 'INSUFFICIENT_FUNDS');
    assert.equal(await bal('custody', m.cob, route), 5_000);
  });

  test('STG-P4-004 · autorizaciones con personas reales: nadie aprueba lo suyo; el Cobrador no aprueba', async () => {
    const own = await call('boss', 'POST', '/v1/credit-requests', m.admin, { routeId: route, clientId: await newClient(), amountMinor: 1_000, interestRate: 20,
      installmentsCount: 1, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] });
    assert.equal(own.status, 201);
    assert.equal((await call('boss', 'POST', `/v1/credit-requests/${own.body['id']}/approve`, m.sa, {})).body['error'], 'SELF_APPROVAL_FORBIDDEN',
      'SuperAdmin y Administrador son la misma persona');
    // El Cobrador solo ve sus propias solicitudes (RLS): la ajena ni siquiera existe para él.
    assert.equal((await call('worker', 'POST', `/v1/credit-requests/${own.body['id']}/approve`, m.cob, {})).status, 404);
  });

  test('STG-P4-005 · aislamiento en gestionado: otra empresa no ve créditos ni puede usar la función', async () => {
    const c = await apiPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [identityOf('bruno'), membershipId('c1', 'bruno-sa'), companyId('c1'), randomUUID(), String(Math.floor(Date.now() / 1000))]);
      for (const t of ['sales', 'installments', 'sale_requests']) {
        const n = await c.query<{ n: number }>(`select count(*)::int n from adex.${t} where company_id = $1`, [company]);
        assert.equal(n.rows[0]!.n, 0, t);
      }
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
    await assert.rejects(adminPool.query(`select * from adex.credit_disburse(gen_random_uuid(), null, $1, 'x', 1, 20, 1, 'diaria', current_date, '{1}', '[]', 'x')`, [route]),
      { code: '42501' });
  });

  test('STG-P4-006 · conciliación independiente en gestionado: libro cuadrado y cartera = créditos desembolsados', async () => {
    const r = await adminPool.query<{ mismatched: number; unbalanced: number; total: string; portfolio: string; credits: string; unmatched: number }>(
      `select (select count(*) from adex.capital_accounts a where a.company_id = $1
                 and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e where e.company_id = a.company_id and e.account_id = a.id), 0))::int mismatched,
              (select count(*) from adex.capital_operations o where o.company_id = $1
                 and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e where e.company_id = o.company_id and e.operation_id = o.id))::int unbalanced,
              (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1)::text total,
              (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1 and kind = 'portfolio')::text portfolio,
              (select coalesce(sum(sale_value_minor), 0) from adex.sales where company_id = $1 and ledger_operation_id is not null)::text credits,
              (select count(*) from adex.capital_operations o where o.company_id = $1 and o.kind = 'LOAN_DISBURSEMENT'
                 and not exists (select 1 from adex.sales s where s.company_id = o.company_id and s.ledger_operation_id = o.id and s.sale_value_minor = o.amount_minor))::int unmatched`,
      [company]);
    const x = r.rows[0]!;
    assert.deepEqual([x.mismatched, x.unbalanced, x.total, x.unmatched], [0, 0, '0', 0]);
    assert.equal(x.portfolio, x.credits);
  });

  test('STG-P4-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(errors, []);
  });
});
