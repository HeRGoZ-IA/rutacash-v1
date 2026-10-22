// FASE 2 · estructura y catálogo contra ADEX-Staging REAL: token de Supabase Auth
// real → API de empresa (este proceso) → `adex_api` por el pooler de transacciones →
// PostgreSQL gestionado con RLS. DS-10 y DS-11 con concurrencia, responsable de
// capital (AX101), aislamiento e idempotencia. Se ejecuta SOLO con
// `node scripts/staging.ts --test`; sin esas variables queda SKIPPED (BLOQUEADA /
// NO EJECUTADA). Datos sintéticos; cada ejecución usa nombres y documentos nuevos.

import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyApi } from '../../src/http/companyApi.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';
import { companyId, membershipId, routeId, uid } from '../../db/seeds/synthetic.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['ADEX_STAGING_ADMIN_URL'] && env['SUPABASE_URL'] && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging (node scripts/staging.ts --test)';

describe('Fase 2 · estructura y catálogo en ADEX-Staging (Auth real + PostgreSQL gestionado)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const adminHeaders = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const run = randomBytes(3).toString('hex');
  const email = `staging-p2-${run}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const c3 = companyId('c3');
  const saMembership = randomUUID();
  const cobMembership = randomUUID();
  let userId = '';
  let token = '';
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let base = '';
  let server: ReturnType<typeof createCompanyApi>;
  const errors: unknown[] = [];

  before(async () => {
    const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }) });
    assert.ok(r.ok, `crear usuario sintético: ${r.status}`);
    userId = ((await r.json()) as { id: string }).id;
    const ssl = { rejectUnauthorized: false };
    apiPool = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 10 });
    adminPool = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 3 });
    for (const [name, pool] of [['admin', adminPool], ['api', apiPool]] as const) pool.on('error', (e) => console.error(`[pool ${name}]`, e.message));
    // Una persona con DOS membresías en la empresa sintética c3 (DS-05): SuperAdmin y Cobradora de r2.
    await adminPool.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [userId, email]);
    await adminPool.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                           values ($1, $2, $3, 'superadmin', 'activo', 'Staging P2 SA', now(), now()),
                                  ($4, $2, $3, 'cobrador', 'activo', 'Staging P2 Cob', now(), now())`, [saMembership, c3, userId, cobMembership]);
    await adminPool.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [c3, cobMembership, routeId('c3', 2)]);
    server = createCompanyApi({
      pool: apiPool,
      verifyToken: createTokenVerifier({ issuer: `${url}/auth/v1` }),
      provider: createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret }),
      onError: (e) => { errors.push(e); console.error('[api 500]', (e as Error).message); },
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = (await createSupabaseAuthClient({ url, publishableKey: publishable }).signInWithPassword(email, password)).accessToken;
  });
  after(async () => {
    server?.close();
    if (userId) await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders });
    await apiPool?.end();
    await adminPool?.end();
  });

  const call = async (method: string, path: string, m: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-adex-membership': m, ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const client = (doc: string, name = 'Cliente Staging') => ({ routeId: routeId('c3', 1), name, documentType: 'CC', document: doc,
    phonePrimary: '1', addressPrimary: 'a', addressSecondary: 'b', business: 'Negocio sintético' });
  const doc = () => String(randomInt(1_000_000_000, 9_999_999_999));

  test('STG-P2-001 · migración 0007 aplicada en gestionado: unicidad DS-10, guardas DS-11 y restricción del responsable', async () => {
    const objs = await adminPool.query<{ n: number }>(
      `select ((select count(*) from pg_indexes where schemaname = 'adex' and indexname = 'clients_document_key')
             + (select count(*) from pg_trigger where tgname in ('clients_protected_delete', 'routes_protected_delete', 'memberships_protected_delete',
                                                                'routes_controller_valid', 'membership_routes_controller_valid', 'memberships_controller_valid')))::int n`);
    assert.equal(objs.rows[0]!.n, 7);
  });

  test('STG-P2-002 · DS-10 con token real: duplicado rechazado, otro tipo permitido y alta concurrente → una sola', async () => {
    const d = doc();
    assert.equal((await call('POST', '/v1/clients', saMembership, client(d))).status, 201);
    assert.equal((await call('POST', '/v1/clients', saMembership, client(`${d.slice(0, 3)}.${d.slice(3)}`))).body['error'], 'DOCUMENT_DUPLICATE');
    assert.equal((await call('POST', '/v1/clients', saMembership, { ...client(d), documentType: 'NIT' })).status, 201, 'otro tipo de documento');
    const race = doc();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/v1/clients', saMembership, client(race, `Carrera ${i}`))));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409]);
    const n = await adminPool.query<{ n: number }>(`select count(*)::int n from adex.clients where company_id = $1 and document_normalized = $2`, [c3, race]);
    assert.equal(n.rows[0]!.n, 1);
  });

  test('STG-P2-003 · DS-11: con historia, rechazado (también para el administrador de la base); sin historia, borrado auditado', async () => {
    const r = await call('POST', `/v1/clients/${uid('c3:client:1')}/delete`, saMembership, {});
    assert.equal(r.body['error'], 'HAS_HISTORY');
    await assert.rejects(adminPool.query('delete from adex.routes where id = $1', [routeId('c3', 1)]), { code: '2BP01' });
    const fresh = (await call('POST', '/v1/clients', saMembership, client(doc()))).body['id'] as string;
    assert.equal((await call('POST', `/v1/clients/${fresh}/delete`, saMembership, {})).status, 200);
    const a = await adminPool.query<{ n: number }>(`select count(*)::int n from adex.audit_log where action = 'DELETE_CLIENT' and entity_id = $1 and txid is not null`, [fresh]);
    assert.equal(a.rows[0]!.n, 1);
  });

  test('STG-P2-004 · responsable de capital: PostgreSQL gestionado rechaza al COMMIT un responsable inválido (AX101)', async () => {
    const irene = membershipId('c3', 'irene-admin');
    const c = await adminPool.connect();
    try {
      await c.query('begin');
      const ctl = await c.query<{ id: string }>('select id from adex.routes where company_id = $1 and capital_controller_membership_id = $2 limit 1', [c3, irene]);
      assert.ok(ctl.rows[0], 'irene controla alguna ruta de c3');
      await c.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [irene, ctl.rows[0]!.id]);
      await assert.rejects(c.query('commit'), { code: 'AX101' });
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  test('STG-P2-005 · permisos y alcance con la otra membresía de la MISMA persona (DS-05)', async () => {
    assert.equal((await call('POST', '/v1/offices', cobMembership, { name: `Cob ${run}` })).status, 403);
    assert.equal((await call('POST', '/v1/clients', cobMembership, client(doc()))).status, 403, 'r1 no está en su alcance');
    // r2 sí está en su alcance (pasa la autorización), pero su Oficina está inactiva en la semilla.
    assert.equal((await call('POST', '/v1/clients', cobMembership, { ...client(doc()), routeId: routeId('c3', 2) })).body['error'], 'ROUTE_NOT_OPERATIONAL');
    assert.equal((await call('POST', '/v1/offices', saMembership, { name: `SA ${run}` })).status, 201);
  });

  test('STG-P2-006 · aislamiento: la empresa c3 no alcanza datos de c1 por URL ni por referencias', async () => {
    assert.equal((await call('GET', `/v1/offices/${uid('c1:office:1')}`, saMembership)).status, 404);
    assert.equal((await call('PATCH', `/v1/routes/${routeId('c1', 1)}`, saMembership, { name: 'Robada' })).status, 404);
    assert.equal((await call('GET', `/v1/clients/${uid('c1:client:1')}`, saMembership)).status, 404);
    assert.equal((await call('POST', '/v1/clients', saMembership, { ...client(doc()), routeId: routeId('c1', 1) })).status, 404);
    const name = await adminPool.query<{ name: string }>('select name from adex.routes where id = $1', [routeId('c1', 1)]);
    assert.notEqual(name.rows[0]!.name, 'Robada');
  });

  test('STG-P2-007 · idempotencia por el pooler: el mismo X-Adex-Operation-Id en paralelo crea UNA Oficina', async () => {
    const op = randomUUID();
    const body = { name: `Idempotente ${run}` };
    const rs = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/v1/offices', saMembership, body, { 'x-adex-operation-id': op })));
    assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(new Set(rs.map((r) => r.body['id'])).size, 1);
    const n = await adminPool.query<{ n: number }>('select count(*)::int n from adex.offices where company_id = $1 and name = $2', [c3, body.name]);
    assert.equal(n.rows[0]!.n, 1);
  });

  test('STG-P2-099 · sin errores inesperados en la API', () => {
    assert.deepEqual(errors, []);
  });
});
