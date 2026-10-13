// [supabase-auth] Pruebas contra un Supabase Auth REAL.
//
// Requieren (nunca en Git):
//   SUPABASE_URL                p. ej. http://127.0.0.1:54321 (supabase start) o un proyecto autorizado
//   SUPABASE_ANON_KEY           clave pública (anon / publishable)
//   SUPABASE_SERVICE_ROLE_KEY   clave administrativa: SOLO este arnés la usa, para crear y borrar usuarios
//                               sintéticos. Jamás llega a un cliente ni a la API.
//   SUPABASE_JWT_SECRET         opcional, solo si el proyecto firma con la clave legada HS256
//
// Si faltan, las pruebas se marcan SKIPPED = NO EJECUTADAS. No se sustituyen por simulaciones.
// Si además hay PostgreSQL (npm run test:integration), se ejecuta el flujo extremo a extremo
// token real → API → membresía en PostgreSQL.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSupabaseJwtVerifier, type TokenVerifier } from '../../src/auth/supabaseJwt.ts';
import { createTestDb, pgAvailable, type TestDb } from '../helpers/db.ts';
import { startApi, type TestApi } from '../helpers/api.ts';

const URL_ = process.env['SUPABASE_URL']?.replace(/\/$/, '');
const ANON = process.env['SUPABASE_ANON_KEY'];
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const missing = !URL_ || !ANON || !SERVICE;
const SKIP = missing ? 'NO EJECUTADA: faltan SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (sin Docker ni proyecto autorizado)' : false;

const created: string[] = [];
let verifier: TokenVerifier;

async function adminCreateUser(email: string, password: string): Promise<string> {
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE as string, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const id = ((await r.json()) as { id: string }).id;
  created.push(id);
  return id;
}

async function signIn(email: string, password: string): Promise<{ status: number; accessToken?: string }> {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON as string, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await r.json()) as { access_token?: string };
  return { status: r.status, accessToken: body.access_token };
}

before(() => {
  if (missing) return;
  verifier = createSupabaseJwtVerifier({ issuer: `${URL_}/auth/v1`, hs256Secret: process.env['SUPABASE_JWT_SECRET'] });
});

after(async () => {
  for (const id of created) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE as string, authorization: `Bearer ${SERVICE}` } });
  }
});

const password = `Synthetic-${randomUUID()}`;
const emailA = `adex-0a-a-${randomUUID().slice(0, 8)}@example.test`;
const emailB = `adex-0a-b-${randomUUID().slice(0, 8)}@example.test`;

test('AUTH-REAL-001 [supabase-auth] identidad única: dos sesiones del mismo usuario → mismo sub', { skip: SKIP }, async () => {
  const id = await adminCreateUser(emailA, password);
  const s1 = await signIn(emailA, password);
  const s2 = await signIn(emailA, password);
  assert.equal(s1.status, 200);
  const v1 = await verifier(s1.accessToken as string);
  const v2 = await verifier(s2.accessToken as string);
  assert.equal(v1.identityId, id);
  assert.equal(v2.identityId, id);
  assert.notEqual(v1.sessionId, v2.sessionId, 'dos sesiones, una identidad');
  const idB = await adminCreateUser(emailB, password);
  assert.equal((await verifier((await signIn(emailB, password)).accessToken as string)).identityId, idB);
  assert.notEqual(idB, id);
});

test('AUTH-REAL-002 [supabase-auth] credenciales erróneas no producen token', { skip: SKIP }, async () => {
  const r = await signIn(emailA, 'wrong-password');
  assert.notEqual(r.status, 200);
  assert.equal(r.accessToken, undefined);
});

test('AUTH-REAL-003 [supabase-auth] cierre de sesión: Supabase lo revoca, la verificación local no lo ve hasta exp', { skip: SKIP }, async () => {
  const s = await signIn(emailA, password);
  const token = s.accessToken as string;
  const out = await fetch(`${URL_}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: ANON as string, authorization: `Bearer ${token}` } });
  assert.ok(out.status === 204 || out.status === 200, `logout ${out.status}`);
  const user = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON as string, authorization: `Bearer ${token}` } });
  assert.notEqual(user.status, 200, 'el servidor de Auth ya no acepta la sesión');
  // La firma sigue siendo válida: por eso la autoridad de permisos es la membresía en PostgreSQL.
  assert.ok((await verifier(token)).identityId);
});

test('AUTH-REAL-004 [supabase-auth+pg+api] token real → membresía en PostgreSQL → revocación', { skip: SKIP || (!pgAvailable() && 'NO EJECUTADA: requiere también PostgreSQL (npm run test:integration)') }, async () => {
  const db: TestDb = await createTestDb('authreal');
  let api: TestApi | null = null;
  try {
    const email = `adex-0a-e2e-${randomUUID().slice(0, 8)}@example.test`;
    const id = await adminCreateUser(email, password);
    const company = randomUUID();
    const membership = randomUUID();
    await db.superPool.query(`insert into adex.companies (id, name, country_code, currency_code, timezone) values ($1, 'Sintética E2E', 'BR', 'BRL', 'America/Sao_Paulo')`, [company]);
    await db.superPool.query('insert into adex.identities (id, email) values ($1, $2)', [id, email]);
    await db.superPool.query(`insert into adex.memberships (id, identity_id, company_id, role, scope) values ($1, $2, $3, 'admin', 'company')`, [membership, id, company]);
    api = await startApi(db.apiPool, verifier);
    const token = (await signIn(email, password)).accessToken as string;
    assert.equal((await api.call('GET', '/v1/context', { token, membership })).status, 200);
    await db.superPool.query(`update adex.memberships set status = 'inactive' where id = $1`, [membership]);
    assert.equal((await api.call('GET', '/v1/context', { token, membership })).body['error'], 'MEMBERSHIP_INACTIVE');
  } finally {
    await api?.close();
    await db.close();
  }
});
