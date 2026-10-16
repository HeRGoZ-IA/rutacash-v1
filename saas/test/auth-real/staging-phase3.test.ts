// FASE 3 · capital centralizado y custodia contra ADEX-Staging REAL: tokens de Supabase
// Auth reales → API de empresa (este proceso) → `adex_api` por el pooler de
// transacciones → PostgreSQL gestionado con RLS. Se ejecuta SOLO con
// `node scripts/staging.ts --test`; sin esas variables queda SKIPPED.
//
// Datos 100 % sintéticos: cada ejecución crea su PROPIA empresa sintética (BRL), con
// una ruta, dos personas reales de Auth (responsable y cobrador) y saldos exactos.
// Nada de CLEAN se importa. Al terminar se borran los usuarios de Auth; las filas
// sintéticas se conservan (historia financiera inmutable, DS-11).

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

describe('Fase 3 · capital y custodia en ADEX-Staging (Auth real + PostgreSQL gestionado)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const company = `stg-p3-${run}`;
  const route = `stg-p3-${run}-r1`;
  const m = { sa: `stg-p3-${run}-sa`, admin: `stg-p3-${run}-admin`, cob: `stg-p3-${run}-cob` };
  const people = { boss: { email: `staging-p3-boss-${run}@example.test`, id: '', token: '' }, worker: { email: `staging-p3-worker-${run}@example.test`, id: '', token: '' } };
  const password = randomBytes(18).toString('base64url');
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let base = '';
  let server: ReturnType<typeof createCompanyApi>;
  const errors: unknown[] = [];

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
    // Empresa sintética NUEVA (BR · BRL), una ruta sin Oficina y tres membresías:
    // el responsable tiene SuperAdmin + Administrador (DS-05); el cobrador es otra persona.
    const c = await adminPool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, created_at, updated_at)
                     values ($1, $2, $3, 'operativo', 'activa', 'BR', 'Brasil', 'BRL', 'America/Sao_Paulo', now(), now())`,
        [company, `Staging Fase 3 ${run}`, `stg-p3-${run}@example.test`]);
      for (const p of Object.values(people)) await c.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [p.id, p.email]);
      await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at) values
                       ($1, $4, $5, 'superadmin', 'activo', 'P3 SA', now(), now()),
                       ($2, $4, $5, 'admin', 'activo', 'P3 Responsable', now(), now()),
                       ($3, $4, $6, 'cobrador', 'activo', 'P3 Cobrador', now(), now())`, [m.sa, m.admin, m.cob, company, people.boss.id, people.worker.id]);
      await c.query(`insert into adex.routes (id, company_id, name, code, interest_rate, free_rate, max_loan_minor, initial_capital_minor, legacy_capital_actual_minor,
                       collector_membership_id, capital_controller_membership_id, capital_controller_since, status, created_at, updated_at)
                     values ($1, $2, 'Ruta Staging P3', 'RT-001', 20, false, 500000, 0, 0, $3, $4, now(), 'activa', now(), now())`, [route, company, m.cob, m.admin]);
      await c.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3), ($1, $4, $3)', [company, m.admin, route, m.cob]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
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
  const bal = async (kind: string, membership: string | null, r: string | null = null) => Number((await adminPool.query<{ b: string }>(
    `select coalesce((select balance_minor from adex.capital_accounts where company_id = $1 and kind = $2 and membership_id is not distinct from $3
                         and route_id is not distinct from $4), 0)::text b`, [company, kind, membership, r])).rows[0]!.b);

  test('STG-P3-001 · 0009 aplicada en gestionado: libro de doble entrada, función única de escritura y sin escritura directa', async () => {
    const t = await adminPool.query<{ n: number }>(`select count(*)::int n from pg_tables where schemaname = 'adex' and tablename in ('capital_accounts', 'capital_operations', 'capital_entries')`);
    assert.equal(t.rows[0]!.n, 3);
    const f = await adminPool.query<{ definer: boolean; owner: string }>(
      `select p.prosecdef definer, r.rolname owner from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'capital_post'`);
    assert.deepEqual(f.rows, [{ definer: true, owner: 'adex_owner' }]);
    const w = await adminPool.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where grantee = 'adex_api' and table_schema = 'adex'
          and table_name like 'capital\\_%' and table_name not in ('capital_ledger', 'capital_movements') and privilege_type <> 'SELECT'`);
    assert.equal(w.rows[0]!.n, 0);
  });

  test('STG-P3-002 · flujo completo con tokens reales: depósito, asignación, entrega de R$ 1.000 sin préstamo, devolución y anulación', async () => {
    assert.equal((await money('boss', '/v1/capital/company/deposits', m.sa, { amountMinor: 1_000_000, reason: 'Capital sintético staging' })).status, 201);
    assert.equal((await money('boss', '/v1/capital/allocations', m.sa, { adminId: m.admin, amountMinor: 600_000, reason: 'Bolsa del responsable' })).status, 201);
    const d = await money('boss', '/v1/capital/deliveries', m.admin, { routeId: route, workerId: m.cob, amountMinor: 100_000, reason: 'Anticipo del día' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.equal((d.body['operation'] as Body)['currencyCode'], 'BRL');
    assert.equal((await adminPool.query<{ n: number }>('select count(*)::int n from adex.sales where company_id = $1', [company])).rows[0]!.n, 0, 'sin préstamo');
    assert.equal((await money('boss', '/v1/capital/returns', m.admin, { routeId: route, workerId: m.cob, amountMinor: 40_000, reason: 'Devuelve el sobrante' })).status, 201);
    const d2 = await money('boss', '/v1/capital/deliveries', m.admin, { routeId: route, workerId: m.cob, amountMinor: 10_000, reason: 'Entrega equivocada' });
    assert.equal((await money('boss', `/v1/capital/operations/${(d2.body['operation'] as Body)['id']}/reverse`, m.admin, { reason: 'Se anula' })).status, 201);
    assert.deepEqual([await bal('company', null), await bal('admin', m.admin), await bal('custody', m.cob, route)], [400_000, 540_000, 60_000]);
    const r = (await call('boss', 'GET', '/v1/capital/reconciliation', m.sa)).body;
    assert.equal(r['ok'], true, JSON.stringify(r));
  });

  test('STG-P3-003 · concurrencia por el pooler: entregas simultáneas sin doble consumo y reintento idéntico sin duplicar', async () => {
    const poolBefore = await bal('admin', m.admin);
    const amount = 100_000;
    const rs = await Promise.all(Array.from({ length: 8 }, () =>
      money('boss', '/v1/capital/deliveries', m.admin, { routeId: route, workerId: m.cob, amountMinor: amount, reason: 'Ráfaga staging' })));
    const ok = rs.filter((x) => x.status === 201).length;
    assert.equal(ok, Math.floor(poolBefore / amount), JSON.stringify(rs.map((x) => x.status)));
    assert.ok(rs.filter((x) => x.status !== 201).every((x) => x.body['error'] === 'INSUFFICIENT_FUNDS'));
    assert.equal(await bal('admin', m.admin), poolBefore - ok * amount);
    assert.ok((await bal('admin', m.admin)) >= 0);
    const op = randomUUID();
    await money('boss', '/v1/capital/returns', m.admin, { routeId: route, workerId: m.cob, amountMinor: 50_000, reason: 'Para reintentar' });
    const same = await Promise.all(Array.from({ length: 4 }, () =>
      money('boss', '/v1/capital/deliveries', m.admin, { routeId: route, workerId: m.cob, amountMinor: 25_000, reason: 'Reintento' }, op)));
    assert.ok(same.every((x) => x.status === 201), JSON.stringify(same.map((x) => x.status)));
    const n = await adminPool.query<{ n: number }>('select count(*)::int n from adex.capital_operations where company_id = $1 and operation_id = $2', [company, op]);
    assert.equal(n.rows[0]!.n, 1);
  });

  test('STG-P3-004 · el Cobrador (otra persona, token real) solo ve su custodia; nunca la bolsa', async () => {
    assert.equal((await call('worker', 'GET', '/v1/capital/summary', m.cob)).status, 403);
    const pos = (await call('worker', 'GET', '/v1/capital/custody', m.cob)).body['positions'] as Body[];
    assert.deepEqual(pos.map((p) => [p['workerId'], p['balanceMinor']]), [[m.cob, await bal('custody', m.cob, route)]]);
    const ops = (await call('worker', 'GET', '/v1/capital/operations', m.cob)).body['operations'] as Body[];
    assert.ok(ops.length > 0 && ops.every((o) => o['workerId'] === m.cob));
    const legs = (await call('worker', 'GET', `/v1/capital/operations/${ops[0]!['id']}`, m.cob)).body['entries'] as Body[];
    assert.ok(legs.every((e) => (e['account'] as Body)['kind'] === 'custody'), 'sin la pata de la bolsa');
    assert.equal((await money('worker', '/v1/capital/returns', m.cob, { routeId: route, workerId: m.cob, amountMinor: 1, reason: 'Me devuelvo' })).status, 403);
    // El responsable no recibe la devolución de su propio efectivo con otra membresía: aquí es OTRA persona, así que procede.
    assert.equal((await money('boss', '/v1/capital/returns', m.admin, { routeId: route, workerId: m.cob, amountMinor: 1, reason: 'Recibe el responsable' })).status, 201);
  });

  test('STG-P3-005 · aislamiento en el PostgreSQL gestionado: otra empresa no ve nada, ni con el id de una operación', async () => {
    const opId = (await adminPool.query<{ id: string }>('select id from adex.capital_operations where company_id = $1 limit 1', [company])).rows[0]!.id;
    const c = await apiPool.connect();
    try {
      await c.query('begin');
      // Contexto VÁLIDO de otra empresa (SuperAdmin sintético de c1), fijado como lo hace la API.
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [identityOf('bruno'), membershipId('c1', 'bruno-sa'), companyId('c1'), randomUUID(), String(Math.floor(Date.now() / 1000))]);
      for (const t of ['capital_accounts', 'capital_operations', 'capital_entries']) {
        const n = await c.query<{ n: number }>(`select count(*)::int n from adex.${t} where company_id = $1`, [company]);
        assert.equal(n.rows[0]!.n, 0, t);
      }
      await assert.rejects(c.query(`select adex.capital_post(gen_random_uuid(), 'REVERSAL', null, 'Ajena', null, null, null, null, null, null, $1)`, [opId]), { code: 'AX412' });
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
    assert.equal((await call('boss', 'GET', `/v1/capital/operations/${opId}`, m.sa)).status, 200, 'su propia empresa sí');
  });

  test('STG-P3-006 · sin escritura monetaria directa por el pooler; ni el administrador de la base usa la función', async () => {
    const c = await apiPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [people.boss.id, m.sa, company, randomUUID(), String(Math.floor(Date.now() / 1000))]);
      await assert.rejects(c.query(`update adex.capital_accounts set balance_minor = balance_minor + 1, version = version + 1`), { code: '42501' });
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
    await assert.rejects(adminPool.query(`select adex.capital_post(gen_random_uuid(), 'COMPANY_DEPOSIT', 1, 'Directo')`), { code: '42501' });
  });

  test('STG-P3-007 · conciliación independiente (SQL) en gestionado: saldos = Σ patas, operaciones cuadradas, conservación', async () => {
    const r = await adminPool.query<{ mismatched: number; unbalanced: number; overdrawn: number; total: string }>(
      `select (select count(*) from adex.capital_accounts a where a.company_id = $1
                 and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e where e.company_id = a.company_id and e.account_id = a.id), 0))::int mismatched,
              (select count(*) from adex.capital_operations o where o.company_id = $1
                 and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e where e.company_id = o.company_id and e.operation_id = o.id))::int unbalanced,
              (select count(*) from adex.capital_accounts where company_id = $1 and kind not in ('external', 'partner') and balance_minor < 0)::int overdrawn,
              (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1)::text total`, [company]);
    assert.deepEqual(r.rows[0], { mismatched: 0, unbalanced: 0, overdrawn: 0, total: '0' });
    const kinds = (await adminPool.query<{ kind: string }>('select distinct kind from adex.capital_accounts where company_id = $1 order by 1', [company])).rows.map((x) => x.kind);
    assert.deepEqual(kinds, ['admin', 'company', 'custody', 'external'], 'sin caja de ruta');
  });

  test('STG-P3-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(errors, []);
  });
});
