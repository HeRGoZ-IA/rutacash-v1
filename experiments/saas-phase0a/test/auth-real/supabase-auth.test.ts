// [supabase-auth] Pruebas contra un Supabase Auth REAL.
//
// Requieren (nunca en Git; ver .env.example y scripts/run-managed.ts):
//   SUPABASE_URL                https://<ref>.supabase.co del proyecto experimental autorizado
//   SUPABASE_ANON_KEY           clave pública (publishable `sb_publishable_…` o anon legada)
//   SUPABASE_SERVICE_ROLE_KEY   clave administrativa (secret `sb_secret_…` o service_role legada): SOLO este
//                               arnés la usa, para crear y borrar usuarios sintéticos. Jamás llega a la API.
//
// Si faltan, las pruebas se marcan SKIPPED = NO EJECUTADAS. No se sustituyen por simulaciones.
// AUTH-REAL-004 necesita además PostgreSQL: local (npm run test:integration) o el
// gestionado del mismo proyecto (npm run test:managed).
//
// El verificador de la API se configura SIN secreto HS256: solo acepta tokens
// asimétricos verificables con el JWKS público del proyecto.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT, decodeJwt, decodeProtectedHeader, generateKeyPair, type JWTPayload } from 'jose';
import { createSupabaseJwtVerifier, type TokenVerifier } from '../../src/auth/supabaseJwt.ts';
import { balanceOf, count, createTestDb, pgAvailable, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';

const URL_ = process.env['SUPABASE_URL']?.replace(/\/$/, '');
const ANON = process.env['SUPABASE_ANON_KEY'];
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const missing = !URL_ || !ANON || !SERVICE;
const SKIP = missing ? 'NO EJECUTADA: faltan SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (sin proyecto Supabase autorizado configurado)' : false;
const ISSUER = `${URL_}/auth/v1`;

const created: string[] = [];
let verifier: TokenVerifier;

// Las claves nuevas (sb_…) van solo en `apikey`; las legadas (JWT) también en Authorization.
const adminHeaders = (): Record<string, string> =>
  (SERVICE as string).startsWith('sb_') ? { apikey: SERVICE as string } : { apikey: SERVICE as string, authorization: `Bearer ${SERVICE}` };

async function adminCreateUser(email: string, password: string): Promise<string> {
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...adminHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.equal(r.status, 200, `crear usuario sintético → ${r.status}`);
  const id = ((await r.json()) as { id: string }).id;
  created.push(id);
  return id;
}

interface Session { status: number; accessToken?: string; refreshToken?: string; errorCode?: string }
async function signIn(email: string, password: string): Promise<Session> {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON as string, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await r.json()) as { access_token?: string; refresh_token?: string; error_code?: string; code?: string };
  return { status: r.status, accessToken: body.access_token, refreshToken: body.refresh_token, errorCode: body.error_code ?? body.code };
}
async function refresh(refreshToken: string): Promise<number> {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON as string, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  await r.body?.cancel();
  return r.status;
}
async function logout(accessToken: string, scope: 'local' | 'global'): Promise<number> {
  const r = await fetch(`${URL_}/auth/v1/logout?scope=${scope}`, { method: 'POST', headers: { apikey: ANON as string, authorization: `Bearer ${accessToken}` } });
  await r.body?.cancel();
  return r.status;
}
const rejects = async (token: string, v: TokenVerifier = verifier) => {
  try { await v(token); return false; } catch { return true; }
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

before(() => {
  if (missing) return;
  verifier = createSupabaseJwtVerifier({ issuer: ISSUER }); // sin hs256Secret: HS256 se rechaza
});

after(async () => {
  for (const id of created) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders() });
  }
});

const password = `Synthetic-${randomUUID()}`;
const emailA = `adex-0a1-a-${randomUUID().slice(0, 8)}@example.test`;
const emailB = `adex-0a1-b-${randomUUID().slice(0, 8)}@example.test`;
let idA = '';

test('AUTH-REAL-001 [supabase-auth] identidad única, JWT asimétrico real y validación por JWKS', { skip: SKIP }, async (t) => {
  idA = await adminCreateUser(emailA, password);
  const s1 = await signIn(emailA, password);
  const s2 = await signIn(emailA, password);
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  const token = s1.accessToken as string;

  const header = decodeProtectedHeader(token);
  t.diagnostic(`alg=${header.alg} kid=${String(header.kid ?? '').slice(0, 8)}… typ=${header.typ}`);
  assert.ok(header.alg === 'ES256' || header.alg === 'RS256',
    `el proyecto firma con ${header.alg}: sin claves asimétricas el criterio JWKS NO se supera`);
  assert.ok(typeof header.kid === 'string' && header.kid.length > 0, 'kid presente');

  const jwksRes = await fetch(`${ISSUER}/.well-known/jwks.json`);
  assert.equal(jwksRes.status, 200);
  const jwks = (await jwksRes.json()) as { keys: Array<Record<string, unknown>> };
  const key = jwks.keys.find((k) => k['kid'] === header.kid);
  assert.ok(key, 'el kid del token está publicado en el JWKS oficial');
  t.diagnostic(`JWKS: ${jwks.keys.length} clave(s) pública(s): ${jwks.keys.map((k) => `${String(k['alg'])}/${String(k['kty'])}`).join(', ')}`);
  for (const k of jwks.keys) for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) assert.ok(!(priv in k), `el JWKS no publica material privado (${priv})`);

  const claims = decodeJwt(token);
  t.diagnostic(`claims: ${Object.keys(claims).sort().join(', ')}`);
  t.diagnostic(`vida del token: ${(claims.exp as number) - (claims.iat as number)} s`);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, 'authenticated');
  assert.equal(claims['role'], 'authenticated');
  assert.equal(claims.sub, idA);
  assert.ok((claims.exp as number) > Math.floor(Date.now() / 1000));
  // Ningún claim de permisos de ADEX: la autoridad es la membresía en PostgreSQL.
  for (const k of ['company_id', 'membership_id', 'memberships', 'permissions', 'adex_role']) assert.ok(!(k in claims), `sin claim ${k}`);
  const appMeta = (claims['app_metadata'] ?? {}) as Record<string, unknown>;
  assert.deepEqual(Object.keys(appMeta).filter((k) => !['provider', 'providers'].includes(k)), [], 'app_metadata sin datos de autorización');

  const v1 = await verifier(token);
  const v2 = await verifier(s2.accessToken as string);
  assert.equal(v1.identityId, idA, 'sub verificado = auth.users.id');
  assert.equal(v2.identityId, idA, 'sub estable entre sesiones');
  assert.notEqual(v1.sessionId, v2.sessionId, 'dos sesiones, una identidad');
  const idB = await adminCreateUser(emailB, password);
  assert.equal((await verifier((await signIn(emailB, password)).accessToken as string)).identityId, idB);
  assert.notEqual(idB, idA);
});

test('AUTH-REAL-002 [supabase-auth] credenciales y tokens inválidos no dan acceso', { skip: SKIP }, async (t) => {
  if (!idA) idA = await adminCreateUser(emailA, password);
  const wrong = await signIn(emailA, 'wrong-password');
  const ghost = await signIn(`adex-0a1-ghost-${randomUUID().slice(0, 8)}@example.test`, password);
  t.diagnostic(`contraseña errónea → ${wrong.status} ${wrong.errorCode ?? ''} · usuario inexistente → ${ghost.status} ${ghost.errorCode ?? ''}`);
  for (const r of [wrong, ghost]) {
    assert.notEqual(r.status, 200);
    assert.equal(r.accessToken, undefined);
  }
  assert.equal(wrong.status, ghost.status, 'misma respuesta: no permite enumerar usuarios');

  const good = (await signIn(emailA, password)).accessToken as string;
  const [h, p, s] = good.split('.') as [string, string, string];
  const payload = decodeJwt(good);
  const header = decodeProtectedHeader(good);
  const forgedForeignKey = await new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'ES256', kid: header.kid as string, typ: 'JWT' })
    .sign((await generateKeyPair('ES256')).privateKey);
  const hsForged = await new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new TextEncoder().encode(ANON as string));
  const cases: Array<[string, string]> = [
    ['basura', 'not-a-jwt'],
    ['payload alterado (otro sub) con la firma original', `${h}.${b64({ ...payload, sub: randomUUID() })}.${s}`],
    ['payload alterado (role service_role)', `${h}.${b64({ ...payload, role: 'service_role' })}.${s}`],
    ['firma con otra clave y el mismo kid', forgedForeignKey],
    ['HS256 firmado con la clave publicable', hsForged],
    ['alg none', `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`],
  ];
  const pool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1 }); // nunca se usa: se rechaza antes
  const api = await startApi(pool, verifier);
  try {
    for (const [label, tok] of cases) {
      assert.ok(await rejects(tok), `verificador rechaza: ${label}`);
      const r = await api.call('GET', '/v1/me/memberships', { token: tok });
      assert.equal(r.status, 401, `API rechaza: ${label}`);
    }
    assert.equal((await api.call('GET', '/v1/me/memberships')).status, 401, 'sin token');
  } finally {
    await api.close();
    await pool.end();
  }

  // Expiración determinista: el MISMO token real, evaluado con el reloj después de exp.
  const expired = createSupabaseJwtVerifier({ issuer: ISSUER, now: () => new Date(((payload.exp as number) + 60) * 1000) });
  const fresh = createSupabaseJwtVerifier({ issuer: ISSUER, now: () => new Date(((payload.iat as number) + 1) * 1000) });
  assert.ok(await rejects(good, expired), 'token real expirado (reloj en exp + 60 s) → rechazado');
  assert.ok(!(await rejects(good, fresh)), 'control: el mismo token dentro de su vigencia → aceptado');
  // Emisor y audiencia ajenos.
  assert.ok(await rejects(good, createSupabaseJwtVerifier({ issuer: 'https://otro.supabase.co/auth/v1', jwksUrl: `${ISSUER}/.well-known/jwks.json` })), 'iss ajeno');
  assert.ok(await rejects(good, createSupabaseJwtVerifier({ issuer: ISSUER, audience: 'otra-audiencia' })), 'aud ajena');
});

test('AUTH-REAL-003 [supabase-auth] cierre de sesión: Supabase revoca la sesión; el JWT ya emitido sigue verificando hasta exp', { skip: SKIP }, async (t) => {
  if (!idA) idA = await adminCreateUser(emailA, password);
  await t.test('scope=local: refresh token revocado, access token criptográficamente válido', async () => {
    const s = await signIn(emailA, password);
    const token = s.accessToken as string;
    const out = await logout(token, 'local');
    assert.ok(out === 204 || out === 200, `logout ${out}`);
    const rf = await refresh(s.refreshToken as string);
    t.diagnostic(`refresh tras logout → ${rf}`);
    assert.ok(rf >= 400, 'Supabase garantiza: la sesión no se puede renovar');
    const user = await fetch(`${ISSUER}/user`, { headers: { apikey: ANON as string, authorization: `Bearer ${token}` } });
    await user.body?.cancel();
    t.diagnostic(`GET /auth/v1/user con el access token tras logout → ${user.status} (consulta con estado en el servidor de Auth)`);
    assert.ok((await verifier(token)).identityId, 'verificación local por JWKS: el token sigue siendo válido hasta exp');
  });
  await t.test('scope=global: cierra también las otras sesiones de la identidad', async () => {
    const s1 = await signIn(emailA, password);
    const s2 = await signIn(emailA, password);
    assert.ok([200, 204].includes(await logout(s1.accessToken as string, 'global')));
    assert.ok((await refresh(s2.refreshToken as string)) >= 400, 'la otra sesión tampoco se renueva');
    assert.ok((await verifier(s2.accessToken as string)).identityId, 'pero su access token sigue verificando hasta exp');
  });
});

test('AUTH-REAL-004 [supabase-auth+pg+api] token real → API → membresía en PostgreSQL → revocación', { skip: SKIP || (!pgAvailable() && 'NO EJECUTADA: requiere también PostgreSQL (npm run test:integration o test:managed)') }, async (t) => {
  const db: TestDb = await createTestDb('authreal');
  let api: TestApi | null = null;
  try {
    const email = `adex-0a1-e2e-${randomUUID().slice(0, 8)}@example.test`;
    const id = await adminCreateUser(email, password);
    const [br, co, routeBr] = [randomUUID(), randomUUID(), randomUUID()];
    const [mAdminBr, mCobBr, mSupCo] = [randomUUID(), randomUUID(), randomUUID()];
    const [accBr, accBrRoute, accCo] = [randomUUID(), randomUUID(), randomUUID()];
    const q = (sql: string, params: unknown[]) => db.superPool.query(sql, params);
    await q(`insert into adex.companies (id, name, country_code, currency_code, timezone) values
             ($1, 'Sintética E2E BR', 'BR', 'BRL', 'America/Sao_Paulo'), ($2, 'Sintética E2E CO', 'CO', 'COP', 'America/Bogota')`, [br, co]);
    await q(`insert into adex.routes (id, company_id, name) values ($1, $2, 'Rota E2E')`, [routeBr, br]);
    await q('insert into adex.identities (id, email) values ($1, $2)', [id, email]);
    await q(`insert into adex.memberships (id, identity_id, company_id, role, scope) values
             ($1, $4, $5, 'admin', 'company'), ($2, $4, $5, 'cobrador', 'routes'), ($3, $4, $6, 'supervisor', 'company')`, [mAdminBr, mCobBr, mSupCo, id, br, co]);
    await q(`insert into adex.membership_routes (membership_id, company_id, route_id) values ($1, $2, $3)`, [mCobBr, br, routeBr]);
    await q(`insert into adex.accounts (id, company_id, route_id, name, balance_minor) values
             ($1, $4, null, 'Caixa E2E', 500000), ($2, $4, $5, 'Rota E2E', 500000), ($3, $6, null, 'Caja E2E', 500000)`, [accBr, accBrRoute, accCo, br, routeBr, co]);

    api = await startApi(db.apiPool, verifier);
    const session = await signIn(email, password);
    const token = session.accessToken as string;
    const effects = async () => ({
      br: await balanceOf(db.superPool, accBr), co: await balanceOf(db.superPool, accCo),
      movements: await count(db.superPool, 'select 1 from adex.movements where account_id = any($1)', [[accBr, accBrRoute, accCo]]),
      audits: await count(db.superPool, 'select 1 from adex.audit_log where entity_id = any($1)', [[accBr, accBrRoute, accCo]]),
    });
    const withdraw = (m: string, acc: string) =>
      (api as TestApi).call('POST', `/v1/accounts/${acc}/withdrawals`, { token, membership: m, body: { operationId: randomUUID(), amount: '100.00' } });

    await t.test('identidad real con tres membresías independientes (DS-05)', async () => {
      const me = await (api as TestApi).call('GET', '/v1/me/memberships', { token });
      assert.equal(me.status, 200);
      assert.equal(me.body['identityId'], id, 'la identidad sale del sub verificado');
      assert.equal((me.body['memberships'] as unknown[]).length, 3);
      const ctx = await (api as TestApi).call('GET', '/v1/context', { token, membership: mAdminBr });
      assert.deepEqual([ctx.status, ctx.body['role'], (ctx.body['company'] as { id: string }).id], [200, 'admin', br], 'empresa y rol leídos de PostgreSQL');
    });
    await t.test('cada petición usa UNA membresía; sin acumulación', async () => {
      assert.equal((await withdraw(mAdminBr, accBr)).status, 201, 'admin BR retira de la caja BR');
      assert.equal((await withdraw(mCobBr, accBr)).status, 404, 'cobradora BR (solo su ruta) no alcanza la caja BR');
      assert.equal((await withdraw(mSupCo, accCo)).body['error'], 'PERMISSION_DENIED', 'supervisora CO no retira');
      assert.equal((await withdraw(mAdminBr, accCo)).status, 404, 'admin BR no alcanza CO');
      const a = await db.superPool.query('select identity_id, company_id, membership_id, role from adex.audit_log where entity_id = $1', [accBr]);
      assert.deepEqual(a.rows, [{ identity_id: id, company_id: br, membership_id: mAdminBr, role: 'admin' }], 'auditoría con el contexto exacto');
    });
    await t.test('cierre de sesión en Supabase: el JWT ya emitido sigue aceptado por la API hasta exp', async () => {
      assert.ok([200, 204].includes(await logout(token, 'local')));
      const ctx = await (api as TestApi).call('GET', '/v1/context', { token, membership: mAdminBr });
      assert.equal(ctx.status, 200, 'la revocación de sesión de Supabase NO llega a la API con verificación local');
    });
    await t.test('membresía desactivada: el mismo JWT ya no opera y no hay efectos financieros', async () => {
      const before = await effects();
      await q(`update adex.memberships set status = 'inactive' where id = $1`, [mAdminBr]);
      const r = await withdraw(mAdminBr, accBr);
      assert.equal(r.status, 403);
      assert.equal(r.body['error'], 'MEMBERSHIP_INACTIVE');
      assert.equal((await (api as TestApi).call('GET', `/v1/accounts/${accBr}`, { token, membership: mAdminBr })).body['error'], 'MEMBERSHIP_INACTIVE');
      assert.deepEqual(await effects(), before, 'cero efectos');
      const other = await (api as TestApi).call('GET', `/v1/accounts/${accBrRoute}`, { token, membership: mCobBr });
      assert.equal(other.status, 200, 'las demás membresías siguen siendo independientes');
    });
  } finally {
    await api?.close();
    await db.close();
  }
});
