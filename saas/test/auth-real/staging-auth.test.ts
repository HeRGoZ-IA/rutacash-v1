// FASE 1 · Supabase Auth REAL en ADEX-Staging. Se ejecuta SOLO con
// `node scripts/staging.ts --test` (controles previos superados). Sin esas variables
// queda SKIPPED con el motivo: BLOQUEADA / NO EJECUTADA. Nunca se presenta como
// superada sin ejecutarse.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { createTokenVerifier } from '../../src/auth/jwt.ts';
import { createSupabaseProvider } from '../../src/auth/provider.ts';
import { createCompanyApi } from '../../src/http/companyApi.ts';
import { createSupabaseAuthClient } from '../../src/client/serverSession.ts';
import { companyId, membershipId } from '../../db/seeds/synthetic.ts';

const env = process.env;
const ready = Boolean(env['ADEX_STAGING_API_URL'] && env['SUPABASE_URL'] && env['SUPABASE_SECRET_KEY'] && env['SUPABASE_PUBLISHABLE_KEY']);
const SKIP = ready ? false : 'BLOQUEADA / NO EJECUTADA: requiere ADEX-Staging (node scripts/staging.ts --test)';

describe('Fase 1 · Supabase Auth real (ADEX-Staging)', { skip: SKIP }, () => {
  const url = env['SUPABASE_URL'] ?? '';
  const secret = env['SUPABASE_SECRET_KEY'] ?? '';
  const publishable = env['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  const admin = { apikey: secret, authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const email = `staging-${randomBytes(4).toString('hex')}@example.test`;
  const password = randomBytes(18).toString('base64url');
  let userId = '';
  let apiPool: pg.Pool;
  let adminPool: pg.Pool;
  let base = '';
  let server: ReturnType<typeof createCompanyApi>;
  const membership = randomUUID();

  before(async () => {
    const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) });
    assert.ok(r.ok, `crear usuario sintético: ${r.status}`);
    userId = ((await r.json()) as { id: string }).id;
    const ssl = { rejectUnauthorized: false };
    apiPool = new pg.Pool({ connectionString: env['ADEX_STAGING_API_URL'], ssl, max: 5 });
    adminPool = new pg.Pool({ connectionString: env['ADEX_STAGING_ADMIN_URL'], ssl, max: 2 });
    await adminPool.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [userId, email]);
    await adminPool.query(`insert into adex.memberships (id, company_id, identity_id, role, status, display_name, created_at, updated_at)
                           values ($1, $2, $3, 'cobrador', 'activo', 'Staging', now(), now())`, [membership, companyId('c2'), userId]);
    server = createCompanyApi({
      pool: apiPool,
      verifyToken: createTokenVerifier({ issuer: `${url}/auth/v1` }),
      provider: createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret }),
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server?.close();
    // Los datos de staging son sintéticos y se conservan; el usuario de prueba se borra.
    if (userId) await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: admin });
    await apiPool?.end();
    await adminPool?.end();
  });

  const call = async (method: string, path: string, token: string, m?: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (m) headers['x-adex-membership'] = m;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  test('AUTH-STG-001 · inicio de sesión real: ES256 + JWKS, sin claims de autoridad', async () => {
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    const t = await auth.signInWithPassword(email, password);
    const header = JSON.parse(Buffer.from(t.accessToken.split('.')[0]!, 'base64url').toString()) as { alg: string };
    assert.equal(header.alg, 'ES256');
    const v = await createTokenVerifier({ issuer: `${url}/auth/v1` })(t.accessToken);
    assert.equal(v.identityId, userId);
    const claims = JSON.parse(Buffer.from(t.accessToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    for (const k of ['company_id', 'membership_id', 'permissions', 'adex_role']) assert.equal(k in claims, false, k);
  });

  test('AUTH-STG-002 · token real → API → membresía; cierre de sesión ADEX corta el MISMO token', async () => {
    const auth = createSupabaseAuthClient({ url, publishableKey: publishable });
    const t = await auth.signInWithPassword(email, password);
    const mine = await call('GET', '/v1/me/memberships', t.accessToken);
    assert.equal(mine.status, 200);
    assert.equal((await call('POST', '/v1/context/select', t.accessToken, membership, {})).status, 200);
    assert.equal((await call('GET', '/v1/context', t.accessToken, membershipId('c2', 'carla-sa'))).status, 403);
    assert.equal((await call('POST', '/v1/session/logout', t.accessToken, undefined, { scope: 'local' })).status, 200);
    assert.deepEqual((await call('GET', '/v1/context', t.accessToken, membership)).body, { error: 'SESSION_REVOKED' });
    await assert.rejects(auth.refresh(t.refreshToken), 'el proveedor tampoco renueva la sesión');
  });

  test('AUTH-STG-003 · recuperación de acceso: misma respuesta exista o no el correo', async () => {
    const statuses: number[] = [];
    for (const e of [email, `no-existe-${randomBytes(3).toString('hex')}@example.test`]) {
      const r = await fetch(`${url}/auth/v1/recover`, { method: 'POST', headers: { apikey: publishable, 'content-type': 'application/json' }, body: JSON.stringify({ email: e }) });
      statuses.push(r.status);
    }
    assert.equal(statuses[0], statuses[1]);
  });

  test('AUTH-STG-004 · aprovisionamiento por el proveedor: alta sin contraseña y reutilización del sub existente', async () => {
    const provider = createSupabaseProvider({ url, publishableKey: publishable, secretKey: secret });
    const again = await provider.ensureIdentity(email);
    assert.deepEqual(again, { identityId: userId, created: false });
    const fresh = `staging-new-${randomBytes(3).toString('hex')}@example.test`;
    const created = await provider.ensureIdentity(fresh);
    assert.equal(created.created, true);
    await fetch(`${url}/auth/v1/admin/users/${created.identityId}`, { method: 'DELETE', headers: admin });
  });
});
