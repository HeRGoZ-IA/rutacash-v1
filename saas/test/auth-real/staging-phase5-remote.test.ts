// FASE 5 · cobertura remota que la suite STG-P5 no ejercía en Supabase gestionado (Ronda 9):
// anulaciones F5-D02, reintegros D12, recuperación de operaciones inciertas y aislamiento
// multiempresa propio de la Fase 5. Tokens reales de Supabase Auth → API de empresa en un
// proceso de prueba AISLADO (nunca la API publicada) → `adex_api` por el pooler →
// PostgreSQL de ADEX-Staging con RLS. Sin URL de staging: SKIPPED.
//
// Datos 100 % sintéticos: dos empresas nuevas por ejecución (`stg-r9-*`, BRL), personas
// `@example.test` que se borran de Auth al terminar. Ni la Empresa Demo ni CLEAN se tocan.
// Los cierres semanales (D7) se crean SOLO en la empresa sintética de esta ejecución.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyApi, type CompanyApiOptions } from '../../src/http/companyApi.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_ADMIN_URL'] && env['SUPABASE_URL'] && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging con 0013';

type Body = Record<string, unknown>;
type Who = 'sa' | 'ana' | 'worker' | 'xavier' | 'carla' | 'owner';

describe('Fase 5 · cobertura remota F5-D02, D12, operaciones inciertas y aislamiento (ADEX-Staging)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const A = `stg-r9-${run}-a`;
  const B = `stg-r9-${run}-b`;
  const r = { r1: `${A}-r1`, r2: `${A}-r2`, r3: `${A}-r3`, r4: `${A}-r4` };
  const m = {
    sa: `${A}-sa`, ana: `${A}-ana`, anaCob: `${A}-anacob`, cob: `${A}-cob`, x: `${A}-xavier`, carlaSup: `${A}-carlasup`,
    bSa: `${B}-sa`,
  };
  const people: Record<Who, { email: string; id: string; token: string }> = Object.fromEntries(
    (['sa', 'ana', 'worker', 'xavier', 'carla', 'owner'] as const).map((w) => [w, { email: `staging-r9-${w}-${run}@example.test`, id: '', token: '' }])) as never;
  const password = randomBytes(18).toString('base64url');
  const cat = { a: `${A}-cat`, b: `${B}-cat` };
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let apiOpts: CompanyApiOptions;
  let server: ReturnType<typeof createCompanyApi>;
  let base = '';
  let today = '';
  const errors: unknown[] = [];
  let clientSeq = 0;
  const servers: { close: () => void }[] = [];

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
      for (const [id, label] of [[A, 'A'], [B, 'B']] as const) {
        await c.query(`insert into adex.companies (id, name, email, plan, status, country_code, country_label, currency_code, timezone, created_at, updated_at)
                       values ($1, $2, $3, 'operativo', 'activa', 'BR', 'Brasil', 'BRL', 'America/Sao_Paulo', now(), now())`,
          [id, `Staging Ronda 9 ${label} ${run}`, `stg-r9-${run}-${label.toLowerCase()}@example.test`]);
      }
      for (const p of Object.values(people)) await c.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [p.id, p.email]);
      const mem = [
        [m.sa, A, 'sa', 'superadmin', 'R9 SuperAdmin'], [m.ana, A, 'ana', 'admin', 'R9 Ana Responsable'], [m.anaCob, A, 'ana', 'cobrador', 'R9 Ana Cobradora'],
        [m.cob, A, 'worker', 'cobrador', 'R9 Cobrador'], [m.x, A, 'xavier', 'admin', 'R9 Xavier'], [m.carlaSup, A, 'carla', 'supervisor', 'R9 Carla Supervisora'],
        [m.bSa, B, 'carla', 'superadmin', 'R9 Carla SuperAdmin B'],
      ] as const;
      for (const [id, co, who, role, name] of mem) {
        await c.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                       values ($1, $2, $3, $4, 'activo', $5, now(), now())`, [id, co, people[who].id, role, name]);
      }
      const routes = [[r.r1, 'RT-001', m.cob], [r.r2, 'RT-002', m.anaCob], [r.r3, 'RT-003', null], [r.r4, 'RT-004', null]] as const;
      for (const [id, code, collector] of routes) {
        await c.query(`insert into adex.routes (id, company_id, name, code, interest_rate, free_rate, max_loan_minor, initial_capital_minor, legacy_capital_actual_minor,
                         collector_membership_id, capital_controller_membership_id, capital_controller_since, status, created_at, updated_at)
                       values ($1, $2, $3, $4, 20, false, 500000, 0, 0, $5, $6, now(), 'activa', now(), now())`, [id, A, `Ruta R9 ${code}`, code, collector, m.ana]);
      }
      const assigned = [[m.ana, r.r1], [m.ana, r.r2], [m.ana, r.r3], [m.ana, r.r4], [m.cob, r.r1], [m.anaCob, r.r2], [m.x, r.r1], [m.x, r.r4], [m.carlaSup, r.r1]];
      for (const [mm, rr] of assigned) await c.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [A, mm, rr]);
      await c.query(`insert into adex.expense_categories (id, company_id, name, active) values ($1, $2, 'Combustible', true), ($3, $4, 'Arriendo', true)`, [cat.a, A, cat.b, B]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    today = (await adminPool.query<{ d: string }>(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0]!.d;
    apiOpts = {
      pool: apiPool,
      verifyToken: createTokenVerifier({ issuer: `${url}/auth/v1` }),
      provider: createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret }),
      onError: (e) => { errors.push(e); console.error('[api 500]', (e as Error).message); },
    };
    server = createCompanyApi(apiOpts);
    base = await listen(server);
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    for (const p of Object.values(people)) p.token = (await auth.signInWithPassword(p.email, password)).accessToken;

    // Capital sintético: empresa → bolsas (Ana y Xavier) → custodias (cobrador r1 y Ana cobradora r2).
    for (const [path, body] of [
      ['/v1/capital/company/deposits', { amountMinor: 3_000_000, reason: 'Capital sintético Ronda 9' }],
      ['/v1/capital/allocations', { adminId: m.ana, amountMinor: 1_500_000, reason: 'Bolsa de Ana' }],
      ['/v1/capital/allocations', { adminId: m.x, amountMinor: 200_000, reason: 'Bolsa de Xavier' }],
    ] as const) assert.equal((await money('sa', path, m.sa, body)).status, 201, path);
    for (const [route, worker] of [[r.r1, m.cob], [r.r2, m.anaCob]] as const) {
      const d = await money('ana', '/v1/capital/deliveries', m.ana, { routeId: route, workerId: worker, amountMinor: 50_000, reason: 'Base' });
      assert.equal(d.status, 201, JSON.stringify(d.body));
    }
    assert.equal((await money('carla', '/v1/capital/company/deposits', m.bSa, { amountMinor: 100_000, reason: 'Capital sintético B' })).status, 201);
  });
  after(async () => {
    server?.close();
    for (const s of servers) s.close();
    for (const p of Object.values(people)) if (p.id) await fetch(`${url}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: adminHeaders });
    await apiPool?.end();
    await adminPool?.end();
  });

  async function listen(s: net.Server): Promise<string> {
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const headersOf = (who: Who, membership: string, op?: string, json = false) => {
    const h: Record<string, string> = { authorization: `Bearer ${people[who].token}`, 'x-adex-membership': membership };
    if (json) h['content-type'] = 'application/json';
    if (op) h['x-adex-operation-id'] = op;
    return h;
  };
  async function call(who: Who, method: string, path: string, membership: string, body?: unknown, op?: string, at = base) {
    const res = await fetch(at + path, { method, headers: headersOf(who, membership, op, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Body };
  }
  function money(who: Who, path: string, membership: string, body: Body, op: string = randomUUID(), at = base) { return call(who, 'POST', path, membership, body, op, at); }
  const get = (who: Who, path: string, membership: string) => call(who, 'GET', path, membership);
  const bal = async (co: string, kind: string, membership: string | null, route: string | null) => Number((await adminPool.query<{ b: string }>(
    `select coalesce((select balance_minor from adex.capital_accounts where company_id = $1 and kind = $2 and membership_id is not distinct from $3
                         and route_id is not distinct from $4), 0)::text b`, [co, kind, membership, route])).rows[0]!.b);
  const custody = (mm: string, route: string) => bal(A, 'custody', mm, route);
  const pool = (mm: string) => bal(A, 'admin', mm, null);
  const count = async (sql: string, params: unknown[]) => (await adminPool.query<{ n: number }>(`select count(*)::int n from (${sql}) x`, params)).rows[0]!.n;
  const spend = (who: Who, membership: string, body: Body, op?: string) => money(who, '/v1/expenses', membership, { categoryId: cat.a, description: 'Gasto R9', ...body }, op);
  const workerExp = (who: Who, membership: string, workerId: string, amountMinor: number, routeId = r.r1) => spend(who, membership, { scope: 'trabajador', routeId, workerId, amountMinor });
  const reverse = (who: Who, membership: string, id: string, op?: string, reason = 'Registro equivocado') => money(who, `/v1/expenses/${id}/reverse`, membership, { reason }, op);
  const refund = (who: Who, membership: string, id: string, amountMinor: number, op?: string, reason = 'Reintegro parcial') =>
    money(who, `/v1/expenses/${id}/refunds`, membership, { amountMinor, reason }, op);
  const idOf = (res: { status: number; body: Body }) => { assert.equal(res.status, 201, JSON.stringify(res.body)); return (res.body['expense'] as Body)['id'] as string; };
  /** RLS directa con `adex_api` y el contexto indicado (transacción de solo lectura). */
  async function asApiRead<T>(ctx: { identity: string; membership: string; company: string }, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await apiPool.connect();
    try {
      await c.query('begin read only');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
        [ctx.identity, ctx.membership, ctx.company, randomUUID(), String(Math.floor(Date.now() / 1000))]);
      return await fn(c);
    } finally { await c.query('rollback').catch(() => undefined); c.release(); }
  }
  async function credit(amountMinor: number, installmentsCount = 10) {
    const doc = String(10_000_000_000 + Number.parseInt(randomBytes(4).toString('hex'), 16) % 89_999_999_999);
    const cl = await call('sa', 'POST', '/v1/clients', m.sa, { routeId: r.r1, name: `Cliente ficticio R9 ${++clientSeq}`, documentType: 'CPF', document: doc,
      phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
    assert.equal(cl.status, 201, JSON.stringify(cl.body));
    const res = await money('ana', '/v1/credits/direct', m.ana, { routeId: r.r1, clientId: cl.body['id'], amountMinor, interestRate: 20, installmentsCount,
      frequency: 'diaria', startDate: today, paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body['credit'] as Body)['id'] as string;
  }
  /** Proxy que entrega la petición y CORTA la conexión al primer byte de respuesta (que la API solo emite tras el COMMIT). */
  async function lossyProxy(target: string) {
    const port = Number(new URL(target).port);
    const srv = net.createServer((sock) => {
      const up = net.connect(port, '127.0.0.1');
      sock.on('error', () => undefined); up.on('error', () => undefined);
      sock.pipe(up);
      up.once('data', () => { sock.destroy(); up.destroy(); });
    });
    servers.push(srv);
    return listen(srv);
  }
  const opRow = async (co: string, op: string) => (await adminPool.query<{ outcome: string; http_status: number; result: Body }>(
    'select outcome, http_status, result from adex.operations where company_id = $1 and operation_id = $2', [co, op])).rows[0];

  // ======================= F5-D02 · anulaciones =======================

  test('R9-D02-1 · el Administrador responsable anula un gasto de trabajador registrado por otra identidad: espejo, historia intacta, auditoría', async () => {
    const e = idOf(await workerExp('worker', m.cob, m.cob, 3_000));
    const [cash, acc] = [await custody(m.cob, r.r1), await bal(A, 'expense', null, r.r1)];
    const res = await reverse('ana', m.ana, e);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rev = res.body['reversal'] as Body, orig = res.body['original'] as Body;
    assert.deepEqual([rev['amountMinor'], rev['state'], rev['reversesId'], rev['workerId'], rev['registeredBy'], rev['expenseDate']], [-3_000, 'anulacion', e, m.cob, m.ana, today]);
    assert.deepEqual([orig['state'], orig['amountMinor'], orig['registeredBy']], ['anulado', 3_000, m.cob]);
    assert.equal(await custody(m.cob, r.r1), cash + 3_000);
    assert.equal(await bal(A, 'expense', null, r.r1), acc - 3_000);
    const op = (await adminPool.query('select kind, reverses_kind, actor_role from adex.capital_operations where company_id = $1 and expense_id = $2', [A, rev['id']])).rows[0];
    assert.deepEqual([op.kind, op.reverses_kind, op.actor_role], ['REVERSAL', 'WORKER_EXPENSE', 'admin']);
    const audit = (await adminPool.query(`select reason, metadata->>'registeredBy' reg, metadata->>'periodClosed' closed from adex.audit_log
                                           where company_id = $1 and action = 'MOVEMENT_REVERSED' and entity_id = $2 and txid is not null`, [A, e])).rows;
    assert.deepEqual(audit, [{ reason: 'Registro equivocado', reg: m.cob, closed: 'false' }]);
    assert.equal((await reverse('ana', m.ana, e)).body['error'], 'ALREADY_REVERSED');
    assert.equal((await reverse('sa', m.sa, rev['id'] as string)).body['error'], 'REVERSAL_NOT_ALLOWED');
  });

  test('R9-D02-2 · la misma identidad no anula lo que registró usando otra membresía (API y segunda barrera SQL)', async () => {
    const own = idOf(await workerExp('ana', m.anaCob, m.anaCob, 500, r.r2));   // Ana como Cobradora de r2
    const cash = await custody(m.anaCob, r.r2);
    const res = await reverse('ana', m.ana, own);                              // Ana como Administradora responsable de r2
    assert.deepEqual([res.status, res.body['error']], [403, 'SELF_CORRECTION_FORBIDDEN']);
    // Segunda barrera por persona en PostgreSQL (la transacción se revierte; nada se confirma).
    const c = await apiPool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
                            set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`, [people.ana.id, m.ana, A, randomUUID(), String(Math.floor(Date.now() / 1000))]);
      await assert.rejects(c.query('select adex.expense_reverse(gen_random_uuid(), $1, $2)', [own, 'Por SQL directo']), { code: 'AX717' });
    } finally { await c.query('rollback'); c.release(); }
    assert.equal(await custody(m.anaCob, r.r2), cash);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, own]), 0);
    assert.equal((await reverse('sa', m.sa, own)).status, 201, 'otra persona autorizada (SuperAdmin) sí');
  });

  test('R9-D02-3 · el SuperAdmin anula un gasto de ruta: el importe vuelve a la bolsa que lo pagó', async () => {
    const before = await pool(m.ana);
    const e = idOf(await spend('ana', m.ana, { scope: 'ruta', routeId: r.r1, amountMinor: 4_000 }));
    assert.equal(await pool(m.ana), before - 4_000);
    const res = await reverse('sa', m.sa, e);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await pool(m.ana), before);
    const op = (await adminPool.query('select reverses_kind, actor_role from adex.capital_operations where company_id = $1 and expense_id = $2', [A, (res.body['reversal'] as Body)['id']])).rows[0];
    assert.deepEqual([op.reverses_kind, op.actor_role], ['ROUTE_EXPENSE', 'superadmin']);
  });

  test('R9-D02-4 · Administrador no responsable, Cobrador y Supervisora no anulan; nada cambia', async () => {
    const e = idOf(await workerExp('worker', m.cob, m.cob, 200));
    const cash = await custody(m.cob, r.r1);
    assert.deepEqual([(await reverse('xavier', m.x, e)).body['error']], ['CAPITAL_AUTHORITY_REQUIRED'], 'Administrador asignado a r1, no responsable');
    assert.equal((await reverse('worker', m.cob, e)).status, 403, 'Cobrador (ni el suyo)');
    assert.equal((await reverse('carla', m.carlaSup, e)).status, 403, 'Supervisora');
    assert.equal(await custody(m.cob, r.r1), cash);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, e]), 0);
  });

  test('R9-D02-5 · gasto de una semana cerrada (D7): ajuste compensatorio en el periodo abierto; el cierre intacto; con hoy cerrado, nada', async () => {
    const tz = (zone: string) => adminPool.query('update adex.companies set timezone = $2 where id = $1', [A, zone]);
    try {
      await tz('Pacific/Kiritimati');
      const day = (await adminPool.query<{ d: string }>(`select (now() at time zone 'Pacific/Kiritimati')::date::text d`)).rows[0]!.d;
      const e1 = idOf(await spend('ana', m.ana, { scope: 'ruta', routeId: r.r3, amountMinor: 800 }));
      const week = randomUUID();
      await adminPool.query(
        `insert into adex.weekly_settlements (id, company_id, route_id, week_start, week_end, opening_balance_minor, capital_in_minor, collections_minor,
           loans_disbursed_minor, expenses_minor, transfers_in_minor, transfers_out_minor, withdrawals_minor, closing_balance_minor, created_at, status, closed_at, version)
         values ($1, $2, $3, $4::date, $4::date, 0, 0, 0, 0, 800, 0, 0, 0, 0, now(), 'cerrada', now(), 1)`, [week, A, r.r3, day]);
      const closedRow = async () => (await adminPool.query('select * from adex.weekly_settlements where id = $1', [week])).rows[0];
      const sealed = JSON.stringify(await closedRow());
      assert.equal((await reverse('sa', m.sa, e1)).body['error'], 'PERIOD_CLOSED', 'hoy también cerrado: ni otra fecha ni reapertura');
      await tz('Pacific/Pago_Pago');
      const now = (await adminPool.query<{ d: string }>(`select (now() at time zone 'Pacific/Pago_Pago')::date::text d`)).rows[0]!.d;
      assert.notEqual(now, day);
      const before = await pool(m.ana);
      const res = await reverse('sa', m.sa, e1, undefined, 'Corrección tras el cierre');
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((res.body['reversal'] as Body)['expenseDate'], now, 'el ajuste va al periodo abierto');
      assert.equal((await adminPool.query<{ d: string }>('select expense_date::text d from adex.expenses where id = $1 and company_id = $2', [e1, A])).rows[0]!.d, day, 'el original conserva su fecha');
      assert.equal(JSON.stringify(await closedRow()), sealed, 'el cierre no se modifica');
      assert.equal(await count('select 1 from adex.weekly_settlements where company_id = $1', [A]), 1, 'sin reapertura ni cierres nuevos');
      assert.equal(await pool(m.ana), before + 800, 'vuelve a la bolsa que pagó');
      const meta = (await adminPool.query(`select metadata->>'periodClosed' c, metadata->>'originalDate' d from adex.audit_log where company_id = $1 and action = 'MOVEMENT_REVERSED' and entity_id = $2`, [A, e1])).rows[0];
      assert.deepEqual(meta, { c: 'true', d: day });
    } finally {
      await tz('America/Sao_Paulo');
    }
  });

  test('R9-D02-6 · custodia negativa del trabajador: la anulación la restaura exactamente, sin tocar otras cuentas', async () => {
    const start = await custody(m.cob, r.r1);
    const other = { ana: await pool(m.ana), x: await pool(m.x), anaCob: await custody(m.anaCob, r.r2) };
    const e = idOf(await workerExp('worker', m.cob, m.cob, start + 2_500));
    assert.equal(await custody(m.cob, r.r1), -2_500);
    assert.equal((await reverse('ana', m.ana, e)).status, 201);
    assert.equal(await custody(m.cob, r.r1), start);
    assert.deepEqual({ ana: await pool(m.ana), x: await pool(m.x), anaCob: await custody(m.anaCob, r.r2) }, other);
  });

  test('R9-D02-7 · gasto de ruta revertido tras cambiar el responsable: acredita EXACTAMENTE la bolsa pagadora original', async () => {
    const e = idOf(await spend('ana', m.ana, { scope: 'ruta', routeId: r.r4, amountMinor: 7_000 }));
    const anaAfter = await pool(m.ana);
    const ch = await call('sa', 'PUT', `/v1/routes/${r.r4}/capital-controller`, m.sa, { membershipId: m.x, reason: 'Reorganización sintética' });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const xBefore = await pool(m.x);
    const res = await reverse('sa', m.sa, e);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await pool(m.ana), anaAfter + 7_000, 'vuelve a la bolsa de Ana, que pagó');
    assert.equal(await pool(m.x), xBefore, 'la bolsa del nuevo responsable no cambia');
    const legs = (await adminPool.query<{ kind: string; membership_id: string | null; amount: string }>(
      `select a.kind, a.membership_id, e.amount_minor::text amount from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
        where e.company_id = $1 and e.operation_id = (select ledger_operation_id from adex.expenses where company_id = $1 and id = $2) order by e.leg`, [A, (res.body['reversal'] as Body)['id']])).rows;
    assert.deepEqual(legs.map((l) => [l.kind, l.membership_id, l.amount]).sort(), [['admin', m.ana, '7000'], ['expense', null, '-7000']].sort());
  });

  test('R9-D02-8 · cinco anulaciones simultáneas por el pooler: una sola afectación financiera', async () => {
    const e = idOf(await workerExp('worker', m.cob, m.cob, 900));
    const cash = await custody(m.cob, r.r1);
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? reverse('sa', m.sa, e) : reverse('ana', m.ana, e))));
    assert.equal(res.filter((x) => x.status === 201).length, 1, JSON.stringify(res.map((x) => x.body['error'] ?? x.status)));
    assert.ok(res.filter((x) => x.status !== 201).every((x) => x.body['error'] === 'ALREADY_REVERSED'), JSON.stringify(res.map((x) => x.body)));
    assert.equal(await custody(m.cob, r.r1), cash + 900);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, e]), 1);
  });

  test('R9-D02-9 · reintento con el mismo identificador: misma respuesta, ninguna duplicación; mismo id con otros datos → 409', async () => {
    const e = idOf(await workerExp('worker', m.cob, m.cob, 300));
    const cash = await custody(m.cob, r.r1);
    const op = randomUUID();
    const same = await Promise.all(Array.from({ length: 4 }, () => reverse('ana', m.ana, e, op)));
    assert.ok(same.every((x) => x.status === 201), JSON.stringify(same.map((x) => x.body)));
    for (const x of same) assert.deepEqual(x.body, same[0]!.body);
    const again = await reverse('ana', m.ana, e, op);
    assert.deepEqual([again.status, again.body], [201, same[0]!.body], 'reintento posterior');
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, e]), 1);
    assert.equal(await custody(m.cob, r.r1), cash + 300);
    const e3 = idOf(await workerExp('worker', m.cob, m.cob, 100));
    assert.equal((await reverse('ana', m.ana, e3, op)).body['error'], 'OPERATION_ID_REUSED');
    assert.equal((await reverse('ana', m.ana, e, op, 'Otro motivo')).body['error'], 'OPERATION_ID_REUSED');
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, e3]), 0);
  });

  // ======================= D12 · reintegros de gastos de bolsa =======================

  test('R9-D12-1 · gasto administrativo de bolsa, reintegro parcial, límite, reintento idempotente y libro', async () => {
    const start = await pool(m.ana);
    const e = idOf(await spend('ana', m.ana, { scope: 'empresa', amountMinor: 10_000, description: 'Arriendo oficina', fundingSource: 'admin', fundingAdminId: m.ana }));
    assert.equal(await pool(m.ana), start - 10_000);
    const op = randomUUID();
    const r1 = await refund('ana', m.ana, e, 3_000, op);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.deepEqual([r1.body['remainingMinor'], (r1.body['refund'] as Body)['state'], (r1.body['refund'] as Body)['refundsExpenseId']], [7_000, 'reintegro', e]);
    assert.equal(await pool(m.ana), start - 7_000);
    const retry = await refund('ana', m.ana, e, 3_000, op);
    assert.deepEqual([retry.status, retry.body], [201, r1.body], 'reintento idempotente: misma respuesta');
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and refunds_expense_id = $2', [A, e]), 1);
    assert.equal(await pool(m.ana), start - 7_000, 'sin segundo abono');
    assert.equal((await refund('ana', m.ana, e, 3_000, op, 'Otro motivo')).body['error'], 'OPERATION_ID_REUSED');
    assert.equal((await refund('ana', m.ana, e, 7_001)).body['error'], 'REFUND_EXCEEDS_EXPENSE');
    assert.equal((await reverse('ana', m.ana, e)).body['error'], 'EXPENSE_HAS_REFUNDS', 'con reintegros se reintegra el resto, no se anula');
    const rest = await refund('sa', m.sa, e, 7_000, undefined, 'Reintegro del resto por el SuperAdmin');
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(rest.body['remainingMinor'], 0);
    assert.equal((await refund('ana', m.ana, e, 1)).body['error'], 'REFUND_EXCEEDS_EXPENSE');
    assert.equal(await pool(m.ana), start, 'el reintegro total devuelve exactamente lo gastado a la bolsa pagadora');
    const audits = await count(`select 1 from adex.audit_log where company_id = $1 and action = 'EXPENSE_REFUNDED' and entity_id = $2 and txid is not null`, [A, e]);
    assert.equal(audits, 2, 'un registro de auditoría por reintegro real');
  });

  test('R9-D12-2 · reintegro rechazado: Administrador de otra bolsa, Cobrador, otra empresa, gasto de trabajador; bolsa de empresa (D10)', async () => {
    const e = idOf(await spend('ana', m.ana, { scope: 'empresa', amountMinor: 5_000, description: 'Papelería', fundingSource: 'admin', fundingAdminId: m.ana }));
    const before = await pool(m.ana);
    // La bolsa de otro ni siquiera se ve (RLS `expenses_ctx`), igual que en la suite local EXP-009.
    assert.equal((await refund('xavier', m.x, e, 1_000)).status, 404, 'Administrador de otra bolsa');
    assert.equal((await refund('worker', m.cob, e, 1_000)).status, 404, 'Cobrador');
    assert.equal((await refund('carla', m.carlaSup, e, 1_000)).status, 404, 'Supervisora de la empresa');
    assert.equal((await refund('carla', m.bSa, e, 1_000)).status, 404, 'SuperAdmin de otra empresa');
    assert.equal((await spend('ana', m.ana, { scope: 'empresa', amountMinor: 100, description: 'Bolsa ajena', fundingSource: 'admin', fundingAdminId: m.x })).body['error'],
      'POOL_NOT_ALLOWED', 'nadie paga con la bolsa de otro Administrador');
    assert.equal(await pool(m.ana), before);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and refunds_expense_id = $2', [A, e]), 0);
    const w = idOf(await workerExp('worker', m.cob, m.cob, 400));
    assert.equal((await refund('ana', m.ana, w, 100)).body['error'], 'REFUND_NOT_ALLOWED', 'solo los gastos de bolsa tienen reintegros');
    // D10: el SuperAdmin paga con la bolsa de la empresa y la reintegra parcialmente.
    const companyBefore = await bal(A, 'company', null, null);
    const ce = idOf(await spend('sa', m.sa, { scope: 'empresa', amountMinor: 2_000, description: 'Servicios', fundingSource: 'empresa' }));
    const cr = await refund('sa', m.sa, ce, 500);
    assert.equal(cr.status, 201, JSON.stringify(cr.body));
    assert.equal(await bal(A, 'company', null, null), companyBefore - 1_500);
    assert.equal((await refund('ana', m.ana, ce, 100)).status, 404, 'un Administrador no ve ni corrige la bolsa de la empresa');
  });

  // ======================= Operaciones inciertas =======================

  test('R9-UNC-1 · recaudo confirmado cuya respuesta se pierde: se recupera por su id y no hay segundo recaudo', async () => {
    const sale = await credit(30_000, 6);
    const proxy = await lossyProxy(base);
    const op = randomUUID();
    const cash = await custody(m.cob, r.r1);
    const body = { saleId: sale, amountMinor: 4_000 };
    await assert.rejects(money('worker', '/v1/collections', m.cob, body, op, proxy), 'el cliente no recibe la respuesta');
    const row = await opRow(A, op);
    assert.deepEqual([row?.outcome, row?.http_status], ['approved', 201], 'confirmado en PostgreSQL');
    assert.equal(await custody(m.cob, r.r1), cash + 4_000);
    const known = await get('worker', `/v1/operations/${op}`, m.cob);
    assert.deepEqual([known.status, known.body['outcome'], known.body['httpStatus'], known.body['kind']], [200, 'approved', 201, 'collections.register']);
    assert.equal((await get('ana', `/v1/operations/${op}`, m.ana)).status, 404, 'la operación solo la consulta su membresía');
    const retry = await money('worker', '/v1/collections', m.cob, body, op);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body, known.body['result'], 'el reintento devuelve el resultado guardado');
    assert.equal(await count('select 1 from adex.payments where company_id = $1 and sale_id = $2', [A, sale]), 1);
    assert.equal(await count('select 1 from adex.capital_operations where company_id = $1 and operation_id = $2', [A, op]), 1);
    assert.equal(await count(`select 1 from adex.audit_log where company_id = $1 and metadata->>'operationId' = $2`, [A, op]), 1);
    assert.equal(await custody(m.cob, r.r1), cash + 4_000, 'sin segundo recaudo');
    assert.equal((await money('worker', '/v1/collections', m.cob, { saleId: sale, amountMinor: 4_001 }, op)).body['error'], 'OPERATION_ID_REUSED');
  });

  test('R9-UNC-2 · fallo antes del COMMIT en un proceso aislado: nada persiste, la consulta da 404 y el reintento cobra una vez', async () => {
    const sale = await credit(20_000, 4);
    const localErrors: unknown[] = [];
    const failing = createCompanyApi({ ...apiOpts, onError: (e) => localErrors.push(e),
      beforeCommit: async (_c, path) => { if (path === '/v1/collections' || path === '/v1/expenses') throw new Error('fallo simulado antes del COMMIT'); } });
    servers.push(failing);
    const at = await listen(failing);
    const cash = await custody(m.cob, r.r1);
    const op = randomUUID();
    const res = await money('worker', '/v1/collections', m.cob, { saleId: sale, amountMinor: 2_500 }, op, at);
    assert.deepEqual([res.status, res.body], [500, { error: 'INTERNAL' }]);
    assert.equal(await opRow(A, op), undefined);
    assert.equal(await count('select 1 from adex.payments where company_id = $1 and sale_id = $2', [A, sale]), 0);
    assert.equal(await custody(m.cob, r.r1), cash);
    assert.equal((await get('worker', `/v1/operations/${op}`, m.cob)).status, 404, 'no confirmado: repetir con el mismo id es seguro');
    const retry = await money('worker', '/v1/collections', m.cob, { saleId: sale, amountMinor: 2_500 }, op);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(await count('select 1 from adex.payments where company_id = $1 and sale_id = $2', [A, sale]), 1);
    assert.equal(await custody(m.cob, r.r1), cash + 2_500);
    assert.equal(localErrors.length, 1, 'el único 500 es el simulado');
  });

  test('R9-UNC-3 · gasto confirmado con respuesta incierta: recuperación sin duplicación; saldos y auditoría conservados', async () => {
    const proxy = await lossyProxy(base);
    const op = randomUUID();
    const cash = await custody(m.cob, r.r1);
    const before = await count('select 1 from adex.expenses where company_id = $1', [A]);
    const body = { scope: 'trabajador', routeId: r.r1, workerId: m.cob, categoryId: cat.a, amountMinor: 1_200, description: 'Gasto incierto' };
    await assert.rejects(money('worker', '/v1/expenses', m.cob, body, op, proxy));
    assert.equal((await opRow(A, op))?.outcome, 'approved');
    const known = await get('worker', `/v1/operations/${op}`, m.cob);
    assert.deepEqual([known.status, known.body['outcome'], known.body['httpStatus']], [200, 'approved', 201]);
    const retry = await money('worker', '/v1/expenses', m.cob, body, op);
    assert.deepEqual([retry.status, retry.body], [201, known.body['result']]);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1', [A]), before + 1);
    assert.equal(await count('select 1 from adex.capital_operations where company_id = $1 and operation_id = $2', [A, op]), 1);
    assert.equal(await count(`select 1 from adex.audit_log where company_id = $1 and action = 'CREATE_EXPENSE' and metadata->>'operationId' = $2`, [A, op]), 1);
    assert.equal(await custody(m.cob, r.r1), cash - 1_200);
    // Anulación con respuesta perdida: tampoco se duplica.
    const e = ((retry.body['expense'] as Body)['id']) as string;
    const op2 = randomUUID();
    await assert.rejects(money('ana', `/v1/expenses/${e}/reverse`, m.ana, { reason: 'Respuesta perdida' }, op2, proxy));
    const again = await reverse('ana', m.ana, e, op2, 'Respuesta perdida');
    assert.equal(again.status, 201);
    assert.equal(await count('select 1 from adex.expenses where company_id = $1 and reverses_id = $2', [A, e]), 1);
    assert.equal(await custody(m.cob, r.r1), cash);
  });

  // ======================= Aislamiento multiempresa (Fase 5) =======================

  test('R9-ISO-1 · otra empresa no consulta recaudos, gastos, operaciones ni auditoría ajenos (API y RLS)', async () => {
    const sale = await credit(10_000, 2);
    const colOp = randomUUID();
    const col = await money('worker', '/v1/collections', m.cob, { saleId: sale, amountMinor: 1_000 }, colOp);
    assert.equal(col.status, 201);
    const pay = (col.body['payment'] as Body)['id'] as string;
    const e = idOf(await workerExp('worker', m.cob, m.cob, 150));
    // API con la membresía de B.
    assert.equal((await get('carla', `/v1/collections/${pay}`, m.bSa)).status, 404);
    assert.equal((await get('carla', `/v1/expenses/${e}`, m.bSa)).status, 404);
    const listB = await get('carla', '/v1/collections', m.bSa);
    assert.equal(listB.status, 200);
    assert.equal((listB.body['collections'] as Body[]).length, 0);
    assert.ok(((await get('carla', '/v1/expenses', m.bSa)).body['expenses'] as Body[]).every((x) => !String(x['id']).includes(A)));
    assert.deepEqual((await get('carla', `/v1/collections?saleId=${sale}`, m.bSa)).body['collections'], []);
    assert.equal((await get('carla', `/v1/operations/${colOp}`, m.bSa)).status, 404, 'operación ajena');
    // RLS directa: contexto válido de B, filas de A → nada.
    const n = await asApiRead({ identity: people.carla.id, membership: m.bSa, company: B }, async (c) => Object.fromEntries(await Promise.all(
      ['payments', 'expenses', 'audit_log', 'capital_operations', 'capital_accounts', 'operations', 'sales'].map(async (t) =>
        [t, (await c.query<{ n: number }>(`select count(*)::int n from adex.${t} where company_id = $1`, [A])).rows[0]!.n] as const))));
    assert.deepEqual(n, { payments: 0, expenses: 0, audit_log: 0, capital_operations: 0, capital_accounts: 0, operations: 0, sales: 0 });
    // Contexto forjado (empresa A con la membresía de B): inválido → nada visible.
    const forged = await asApiRead({ identity: people.carla.id, membership: m.bSa, company: A }, async (c) =>
      (await c.query<{ n: number }>('select (select count(*) from adex.payments) + (select count(*) from adex.expenses) + (select count(*) from adex.audit_log) n')).rows[0]!.n);
    assert.equal(Number(forged), 0);
    // Contrapartida: el SuperAdmin de A sí ve su auditoría financiera.
    const own = await asApiRead({ identity: people.sa.id, membership: m.sa, company: A }, async (c) =>
      (await c.query<{ n: number }>(`select count(*)::int n from adex.audit_log where company_id = $1 and action in ('CREATE_EXPENSE', 'MOVEMENT_REVERSED', 'EXPENSE_REFUNDED')`, [A])).rows[0]!.n);
    assert.ok(own > 0);
  });

  test('R9-ISO-2 · otra empresa no registra ni anula gastos ajenos; Owner sin autoridad financiera; el contexto activo decide', async () => {
    const e = idOf(await workerExp('worker', m.cob, m.cob, 175));
    const before = { expA: await count('select 1 from adex.expenses where company_id = $1', [A]), cash: await custody(m.cob, r.r1) };
    // Membresía de B contra objetos de A.
    assert.equal((await spend('carla', m.bSa, { scope: 'trabajador', routeId: r.r1, workerId: m.cob, amountMinor: 100 })).status, 404, 'ruta ajena');
    assert.equal((await spend('carla', m.bSa, { scope: 'empresa', amountMinor: 100, description: 'Categoría ajena', fundingSource: 'empresa', categoryId: cat.a })).body['error'], 'CATEGORY_INVALID');
    assert.equal((await reverse('carla', m.bSa, e)).status, 404, 'anular gasto ajeno');
    // Membresía de otra identidad: rechazada.
    assert.equal((await reverse('carla', m.sa, e)).status, 403, 'membresía que no es suya');
    // La misma persona en A como Supervisora: sin autoridad para anular, ni gastos de ruta ni de empresa
    // (cargar un gasto al trabajador de SU ruta sí es nivel `settle` de CLEAN: permissions.ts y EXP-004 local).
    assert.equal((await reverse('carla', m.carlaSup, e)).status, 403);
    assert.equal((await spend('carla', m.carlaSup, { scope: 'ruta', routeId: r.r1, amountMinor: 100 })).body['error'], 'CAPITAL_AUTHORITY_REQUIRED');
    assert.equal((await spend('carla', m.carlaSup, { scope: 'empresa', amountMinor: 100, description: 'Supervisora', fundingSource: 'empresa' })).status, 403);
    // Owner (identidad sin membresías): nada en la API de empresa.
    for (const mm of [m.sa, m.ana]) assert.equal((await reverse('owner', mm, e)).status, 403, 'Owner');
    assert.equal((await get('owner', '/v1/expenses', m.sa)).status, 403);
    assert.deepEqual({ expA: await count('select 1 from adex.expenses where company_id = $1', [A]), cash: await custody(m.cob, r.r1) }, before);
    // Contrapartida: con SU contexto de SuperAdmin en B, Carla opera en B.
    const b = await money('carla', '/v1/expenses', m.bSa, { scope: 'empresa', categoryId: cat.b, amountMinor: 1_000, description: 'Arriendo B', fundingSource: 'empresa' });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal((await reverse('carla', m.bSa, (b.body['expense'] as Body)['id'] as string)).status, 201);
    assert.equal(await bal(B, 'company', null, null), 100_000);
  });

  test('R9-ISO-3 · revocaciones efectivas: la membresía desactivada deja de operar y de ver (API y RLS); la otra membresía sigue', async () => {
    assert.equal((await get('xavier', '/v1/expenses', m.x)).status, 200);
    // Xavier es responsable de r4 desde R9-D02-7: la responsabilidad vuelve a Ana antes de la baja.
    const back = await call('sa', 'PUT', `/v1/routes/${r.r4}/capital-controller`, m.sa, { membershipId: m.ana, reason: 'Fin de la reorganización sintética' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const off = await call('sa', 'POST', `/v1/members/${m.x}/deactivate`, m.sa, {});
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const list = await get('xavier', '/v1/expenses', m.x);
    assert.deepEqual([list.status, list.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
    const post = await spend('xavier', m.x, { scope: 'empresa', amountMinor: 100, description: 'Tras revocar', fundingSource: 'admin', fundingAdminId: m.x });
    assert.deepEqual([post.status, post.body['error']], [403, 'MEMBERSHIP_INACTIVE']);
    const seen = await asApiRead({ identity: people.xavier.id, membership: m.x, company: A }, async (c) =>
      (await c.query<{ n: number }>('select (select count(*) from adex.expenses) + (select count(*) from adex.capital_accounts) + (select count(*) from adex.payments) n')).rows[0]!.n);
    assert.equal(Number(seen), 0, 'RLS: contexto revocado no ve filas');
    await asApiRead({ identity: people.xavier.id, membership: m.x, company: A }, async (c) => {
      await assert.rejects(c.query(`select adex.expense_post(gen_random_uuid(), 'empresa', null, null, $1, 100, 'x', null, 'admin', $2)`, [cat.a, m.x]), { code: '42501' });
    });
    // Revocar la membresía de Carla en A no afecta a su membresía en B (DS-05).
    assert.equal((await call('sa', 'POST', `/v1/members/${m.carlaSup}/deactivate`, m.sa, {})).status, 200);
    assert.equal((await get('carla', '/v1/expenses', m.carlaSup)).body['error'], 'MEMBERSHIP_INACTIVE');
    assert.equal((await get('carla', '/v1/expenses', m.bSa)).status, 200);
  });

  // ======================= Conciliación =======================

  test('R9-REC · conciliación de ambas empresas (API y SQL): libro cuadrado, bolsas no negativas, operaciones con asientos', async () => {
    for (const [who, mm, co] of [['sa', m.sa, A], ['carla', m.bSa, B]] as const) {
      const rec = (await get(who, '/v1/capital/reconciliation', mm)).body;
      assert.equal(rec['ok'], true, JSON.stringify(rec));
      const q = (await adminPool.query<{ total: string; unbalanced: number; mismatch: number; negpool: number }>(
        `select (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1)::text total,
                (select count(*)::int from (select 1 from adex.capital_entries where company_id = $1 group by operation_id having sum(amount_minor) <> 0) x) unbalanced,
                (select count(*)::int from adex.capital_accounts a left join (select account_id, sum(amount_minor) s from adex.capital_entries where company_id = $1 group by 1) e
                    on e.account_id = a.id where a.company_id = $1 and a.balance_minor <> coalesce(e.s, 0)) mismatch,
                (select count(*)::int from adex.capital_accounts where company_id = $1 and kind in ('company', 'admin') and balance_minor < 0) negpool`, [co])).rows[0]!;
      assert.deepEqual(q, { total: '0', unbalanced: 0, mismatch: 0, negpool: 0 }, co);
    }
    const reversals = await count(`select 1 from adex.expenses where company_id = $1 and reverses_id is not null`, [A]);
    const audited = await count(`select 1 from adex.audit_log where company_id = $1 and action = 'MOVEMENT_REVERSED' and entity_type = 'expense' and txid is not null`, [A]);
    assert.equal(audited, reversals, 'cada anulación de gasto tiene su auditoría en la misma transacción');
  });

  test('R9-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(errors, []);
  });
});
