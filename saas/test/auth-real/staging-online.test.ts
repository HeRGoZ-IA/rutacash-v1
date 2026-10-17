// ADEX ONLINE v1 contra ADEX-Staging REAL: tokens de Supabase Auth → servidor compuesto
// (CORS, límites) → `adex_api` y `adex_demo` por el pooler → PostgreSQL gestionado.
// Solo con `node scripts/staging.ts --test`; si no, SKIPPED.
//
// Datos 100 % sintéticos: un hueco Demo propio de la ejecución (`stg-<run>`), tres
// usuarios de Auth `@example.test` (operador, «propietario» y «socio» simulados) que se
// borran al terminar. Las empresas Demo creadas quedan RETIRADAS (historia inmutable).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyExecutor, createCompanyHandler } from '../../src/http/companyApi.ts';
import { createDemoHandler } from '../../src/http/demoApi.ts';
import { createDemoService } from '../../src/demo/service.ts';
import { createOnlineServer } from '../../src/server/app.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_DEMO_URL'] && env['ADEX_STAGING_ADMIN_URL'] && env['SUPABASE_URL']
  && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging (node scripts/staging.ts --test)';
const ORIGIN = 'https://adex-online.staging.example.test';
const evidenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tmp', 'adex-online-v1');

type Body = Record<string, unknown>;

describe('ADEX Online v1 en ADEX-Staging (Auth real + PostgreSQL gestionado)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const slot = `stg-${run}`;
  const password = randomBytes(18).toString('base64url');
  const people = {
    operator: { email: `staging-onl-operator-${run}@example.test`, id: '', token: '' },
    owner: { email: `staging-onl-owner-${run}@example.test`, id: '', token: '' },
    partner: { email: `staging-onl-partner-${run}@example.test`, id: '', token: '' },
  };
  let apiPool: pg.Pool;
  let demoPool: pg.Pool;
  let adminPool: pg.Pool;
  let server: ReturnType<typeof createOnlineServer>;
  let base = '';
  let demoId = '';
  const companies: string[] = [];
  const errors: unknown[] = [];
  const timings: Record<string, number[]> = {};

  const call = async (who: keyof typeof people | null, method: string, p: string, o: { membership?: string; body?: unknown; op?: string } = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (who) headers['authorization'] = `Bearer ${people[who].token}`;
    if (o.membership) headers['x-adex-membership'] = o.membership;
    if (o.op) headers['x-adex-operation-id'] = o.op;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    const r = await fetch(base + p, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    const key = `${method} ${p.replace(/[0-9a-f-]{36}/g, ':id').split('?')[0]}`;
    (timings[key] ??= []).push(performance.now() - t0);
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Body, headers: r.headers };
  };
  const demoMembership = async (who: 'owner' | 'partner', role: string) => {
    const ms = (await call(who, 'GET', '/v1/me/memberships')).body['memberships'] as Body[];
    const m = ms.find((x) => (x['company'] as Body)['isDemo'] === true && (x['company'] as Body)['id'] === demoId && x['role'] === role);
    assert.ok(m, `${who} ${role} in live demo`);
    return m['membershipId'] as string;
  };

  before(async () => {
    for (const p of Object.values(people)) {
      const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: p.email, password, email_confirm: true }) });
      assert.ok(r.ok, `crear usuario sintético: ${r.status}`);
      p.id = ((await r.json()) as { id: string }).id;
    }
    const ssl = { rejectUnauthorized: false };
    apiPool = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 8 });
    demoPool = new pg.Pool({ connectionString: env['ADEX_STAGING_DEMO_URL'], ssl, max: 2 });
    adminPool = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 2 });
    for (const [name, pool] of [['api', apiPool], ['demo', demoPool], ['admin', adminPool]] as const) pool.on('error', (e) => console.error(`[pool ${name}]`, e.message));
    // Operador Demo: SOLO por el administrador de la base.
    await adminPool.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [people.operator.id, people.operator.email]);
    await adminPool.query(`insert into adex_demo.operators (identity_id, note) values ($1, 'staging-online')`, [people.operator.id]);
    const verifyToken = createTokenVerifier({ issuer: `${url}/auth/v1` });
    const provider = createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret });
    const onError = (e: unknown) => { errors.push(e); console.error('[api 500]', (e as Error).message); };
    const companyOpts = { pool: apiPool, verifyToken, provider, onError };
    server = createOnlineServer({
      company: createCompanyHandler(companyOpts),
      demo: createDemoHandler({ verifyToken, onError, service: createDemoService({ pool: demoPool, provider, onError, execute: createCompanyExecutor(companyOpts) }) }),
      readinessPool: apiPool, allowedOrigins: [ORIGIN], log: () => undefined,
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    for (const p of Object.values(people)) p.token = (await auth.signInWithPassword(p.email, password)).accessToken;
  });

  after(async () => {
    // Deja la Demo de esta ejecución retirada (nunca una Demo viva huérfana).
    if (demoId) await call('operator', 'POST', `/demo/v1/slots/${slot}/delete`, { body: { companyId: demoId, confirm: demoId } }).catch(() => undefined);
    await adminPool?.query(`update adex_demo.operators set status = 'inactivo', updated_at = now() where identity_id = $1`, [people.operator.id]).catch(() => undefined);
    server?.close();
    for (const p of Object.values(people)) if (p.id) await fetch(`${url}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: adminHeaders });
    mkdirSync(evidenceDir, { recursive: true });
    const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => {
      const s = [...v].sort((a, b) => a - b);
      return [k, { n: s.length, p50: Math.round(s[Math.floor(s.length / 2)]!), max: Math.round(s[s.length - 1]!) }];
    }));
    writeFileSync(path.join(evidenceDir, `staging-online-${run}.json`), JSON.stringify({ run, slot, companies, timings: summary }, null, 2));
    await Promise.all([apiPool?.end(), demoPool?.end(), adminPool?.end()]);
  });

  test('STG-ONL-001 · 0011 en gestionado; registro público deshabilitado; plano Demo cerrado a la API de empresa', async () => {
    const applied = await adminPool.query<{ version: string }>(`select version from adex_meta.schema_migrations where version = '0011'`);
    assert.equal(applied.rowCount, 1);
    const f = await adminPool.query<{ n: number }>(
      `select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
        where n.nspname = 'adex_demo' and p.prosecdef and r.rolname = 'adex_owner'`);
    assert.ok(f.rows[0]!.n >= 10);
    await assert.rejects(apiPool.query(`select adex_demo.status('principal')`), /permission denied/);
    await assert.rejects(demoPool.query('select id from adex.companies limit 1'), /permission denied/);
    const settings = (await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishable } })).json()) as Body;
    assert.equal(settings['disable_signup'], true, 'public sign-up must be disabled');
    const signup = await fetch(`${url}/auth/v1/signup`, { method: 'POST', headers: { apikey: publishable, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `signup-${run}@example.test`, password }) });
    assert.ok(!signup.ok, `sign-up rejected (${signup.status})`);
    const notOperator = await call('owner', 'GET', `/demo/v1/slots/${slot}`);
    assert.equal(notOperator.body['error'], 'DEMO_OPERATOR_REQUIRED');
  });

  test('STG-ONL-002 · participantes invitados por el proveedor y creación de la Demo con el motor real', async () => {
    for (const [seat, who, name] of [['admin-centro', 'owner', 'Propietario (sim)'], ['superadmin-invitado', 'owner', 'Propietario (sim)'],
      ['cobrador-centro', 'partner', 'Socio (sim)'], ['supervisor-centro', 'partner', 'Socio (sim)']] as const) {
      const r = await call('operator', 'PUT', `/demo/v1/slots/${slot}/participants/${seat}`, { body: { email: people[who].email, displayName: name } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const r = await call('operator', 'POST', `/demo/v1/slots/${slot}/create`, { body: { name: `Empresa Demo staging ${run}` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    demoId = r.body['companyId'] as string;
    companies.push(demoId);
    const st = (await call('operator', 'GET', `/demo/v1/slots/${slot}`)).body;
    assert.equal(st['state'], 'active');
    const created = (st['events'] as Body[]).find((e) => e['action'] === 'CREATE' && e['outcome'] === 'succeeded')!;
    assert.equal(((created['detail'] as Body)['reconciliation'] as Body)['ok'], true);
  });

  test('STG-ONL-003 · dos sesiones reales: entrega → custodia → solicitud → aprobación → desembolso, mismos registros', async () => {
    const admin = await demoMembership('owner', 'admin');
    const sa = await demoMembership('owner', 'superadmin');
    const cob = await demoMembership('partner', 'cobrador');
    const sup = await demoMembership('partner', 'supervisor');
    const centro = ((await call('owner', 'GET', '/v1/routes', { membership: admin })).body['routes'] as Body[]).find((x) => String(x['name']).startsWith('Ruta Centro'))!;
    assert.equal((await call('owner', 'POST', '/v1/capital/deliveries', { membership: admin, op: randomUUID(),
      body: { routeId: centro['id'], workerId: cob, amountMinor: 200_000, reason: 'Capital del día (staging)' } })).status, 201);
    const custody = (await call('partner', 'GET', '/v1/capital/custody', { membership: cob })).body['positions'] as Body[];
    assert.deepEqual(custody.map((p) => p['balanceMinor']), [200_000]);
    assert.equal((await call('partner', 'GET', '/v1/capital/summary', { membership: cob })).status, 403);
    const client = ((await call('partner', 'GET', '/v1/clients', { membership: cob })).body['clients'] as Body[]).find((c) => c['name'] === 'Gisele Muestra Pinto')!;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const req = await call('partner', 'POST', '/v1/credit-requests', { membership: cob, op: randomUUID(), body: { routeId: centro['id'], clientId: client['id'],
      amountMinor: 90_000, interestRate: 20, installmentsCount: 15, frequency: 'diaria', startDate: today, paymentDays: [1, 2, 3, 4, 5, 6] } });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await call('partner', 'POST', `/v1/credit-requests/${req.body['id']}/approve`, { membership: sup, body: {} })).body['error'], 'SELF_APPROVAL_FORBIDDEN');
    assert.equal((await call('owner', 'POST', `/v1/credit-requests/${req.body['id']}/approve`, { membership: admin, body: { notes: 'ok' } })).status, 200);
    const op = randomUUID();
    const d = await call('partner', 'POST', `/v1/credit-requests/${req.body['id']}/disburse`, { membership: cob, op, body: {} });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const recovered = await call('partner', 'GET', `/v1/operations/${op}`, { membership: cob });
    assert.deepEqual(recovered.body['result'], d.body);
    const a = (await call('owner', 'GET', `/v1/credit-requests/${req.body['id']}`, { membership: admin })).body;
    const b = (await call('partner', 'GET', `/v1/credit-requests/${req.body['id']}`, { membership: cob })).body;
    assert.deepEqual([a['status'], b['status'], a['saleId']], ['disbursed', 'disbursed', b['saleId']]);
    assert.equal(((await call('owner', 'GET', '/v1/capital/reconciliation', { membership: sa })).body)['ok'], true);
    assert.equal(d.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(errors, []);
  });

  test('STG-ONL-004 · reiniciar ×2, eliminar y recrear en gestionado: contextos viejos rechazados, libros cuadrados', async () => {
    for (let i = 0; i < 2; i++) {
      const oldAdmin = await demoMembership('owner', 'admin');
      const r = await call('operator', 'POST', `/demo/v1/slots/${slot}/reset`, { body: { companyId: demoId, confirm: demoId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await call('owner', 'GET', '/v1/routes', { membership: oldAdmin })).status, 403);
      demoId = r.body['companyId'] as string;
      companies.push(demoId);
    }
    const del = await call('operator', 'POST', `/demo/v1/slots/${slot}/delete`, { body: { companyId: demoId, confirm: demoId } });
    assert.equal(del.status, 200);
    const again = await call('operator', 'POST', `/demo/v1/slots/${slot}/create`, { body: {} });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    demoId = again.body['companyId'] as string;
    companies.push(demoId);
    for (const id of companies) {
      const q = await adminPool.query<{ s: string; bad: number }>(
        `select coalesce(sum(a.balance_minor), 0)::text s,
                (select count(*)::int from adex.capital_accounts x where x.company_id = $1 and x.balance_minor <> coalesce(
                   (select sum(e.amount_minor) from adex.capital_entries e where e.company_id = x.company_id and e.account_id = x.id), 0)) bad
           from adex.capital_accounts a where a.company_id = $1`, [id]);
      assert.deepEqual([q.rows[0]!.s, q.rows[0]!.bad], ['0', 0], `ledger of ${id}`);
    }
    const live = await adminPool.query<{ n: number }>(
      'select count(*)::int n from adex.companies c join adex_demo.companies d on d.company_id = c.id where d.slot = $1 and c.retired_at is null', [slot]);
    assert.equal(live.rows[0]!.n, 1);
    const events = (await call('operator', 'GET', `/demo/v1/slots/${slot}`)).body['events'] as Body[];
    assert.ok(events.filter((e) => e['action'] === 'RESET' && e['outcome'] === 'succeeded').length === 2);
  });

  test('STG-ONL-005 · latencia medida desde este equipo (referencia para el alojamiento)', async () => {
    const sa = await demoMembership('owner', 'superadmin');
    const rtt: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await adminPool.query('select 1');
      rtt.push(performance.now() - t0);
    }
    for (let i = 0; i < 5; i++) {
      await call('owner', 'GET', '/v1/credit-requests?status=pending', { membership: sa });
      await call('owner', 'GET', '/v1/capital/summary', { membership: sa });
    }
    rtt.sort((a, b) => a - b);
    timings['pg select 1 (RTT)'] = rtt;
    assert.ok(rtt[5]! > 0);
  });
});
