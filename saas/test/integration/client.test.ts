// FASE 1 · «ninguna contraseña en el cliente» (puerta del plan) en MODO SERVIDOR, de
// extremo a extremo: cliente → proveedor (simulado) → API real → PostgreSQL real.
// Tras iniciar sesión, elegir contexto, cambiar de contexto y cerrar sesión, se
// busca la contraseña en TODA la memoria de la sesión y en TODAS las bases IndexedDB.

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { AdexServerSession, AuthError, type AuthClient, type TokenSet } from '../../src/client/serverSession.ts';
import { IndexedDbSessionStore } from '../../src/client/sessionStore.ts';
import { identityOf, membershipId, routeId } from '../../db/seeds/synthetic.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { createLocalIssuer, createMemoryProvider, startCompanyApi, type LocalIssuer, type TestServer } from '../helpers/auth.ts';

const PASSWORD = 'Contraseña-Única-9f3e!';

/** Proveedor simulado: la contraseña vive SOLO aquí (lado proveedor), nunca en el cliente. */
function fakeAuth(issuer: LocalIssuer, passwords: Map<string, { password: string; sub: string }>): AuthClient {
  return {
    async signInWithPassword(email, password): Promise<TokenSet> {
      const u = passwords.get(email);
      if (!u || u.password !== password) throw new AuthError('INVALID_CREDENTIALS');
      return { accessToken: await issuer.issue(u.sub), refreshToken: `refresh-${u.sub}`, expiresAt: Math.floor(Date.now() / 1000) + 3600, identityId: u.sub };
    },
    async refresh() { throw new AuthError('NOT_USED'); },
    async recover() { /* el proveedor envía el enlace; nada que guardar */ },
  };
}

async function dumpIndexedDb(): Promise<string> {
  const out: unknown[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const store of [...db.objectStoreNames]) {
      const tx = db.transaction(store, 'readonly');
      const all = await new Promise<unknown[]>((res) => { const r = tx.objectStore(store).getAll(); r.onsuccess = () => res(r.result); });
      out.push({ name, store, all });
    }
    db.close();
  }
  return JSON.stringify(out);
}

describe('Fase 1 · cliente en modo servidor sin contraseñas', () => {
  let db: TestDb;
  let issuer: LocalIssuer;
  let api: TestServer;
  before(async () => {
    db = await createTestDb('client', { seed: true });
    issuer = await createLocalIssuer();
    api = await startCompanyApi(db, issuer, createMemoryProvider());
  });
  after(async () => { await api.close(); await db.close(); });

  test('CLI-010 · login → selector → contexto → cambio → logout: la contraseña no queda en memoria ni en IndexedDB', async () => {
    // fetch que encamina al servidor de prueba usando `api.call` (mismas peticiones HTTP reales).
    const f = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const h = new Headers(init.headers);
      const r = await api.call(init.method ?? 'GET', path, {
        token: h.get('authorization')?.slice(7), membership: h.get('x-adex-membership') ?? undefined,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const passwords = new Map([['ana@example.test', { password: PASSWORD, sub: identityOf('ana') }]]);
    const store = new IndexedDbSessionStore();
    const session = new AdexServerSession({ auth: fakeAuth(issuer, passwords), store, apiBase: 'http://adex.test', fetchImpl: f });

    await assert.rejects(session.login('ana@example.test', 'otra'), AuthError);
    const decision = await session.login('ana@example.test', PASSWORD);
    assert.equal(decision.kind, 'choose', 'Ana tiene 3 membresías: elegir es obligatorio');
    assert.equal(session.activeMembershipId, null);

    await session.select(membershipId('c1', 'ana-cob'));
    const routes = (await session.get('/v1/routes'))['routes'] as { id: string }[];
    assert.deepEqual(routes.map((r) => r.id), [routeId('c1', 1)]);
    assert.equal(session.cachedKeys().length, 1);

    await session.select(membershipId('c2', 'ana-sup'));
    assert.deepEqual(session.cachedKeys(), [], 'cambiar de contexto vacía la caché del anterior');
    const routes2 = (await session.get('/v1/routes'))['routes'] as { id: string }[];
    assert.deepEqual(routes2.map((r) => r.id), [routeId('c2', 1)]);

    const memory = inspect(session, { depth: Infinity, showHidden: true });
    const idb = await dumpIndexedDb();
    for (const [where, text] of [['memoria', memory], ['IndexedDB', idb]] as const) {
      assert.ok(!text.includes(PASSWORD), `${where} contiene la contraseña`);
      // Clave independiente (no el nombre del método `signInWithPassword` del proveedor).
      assert.doesNotMatch(text, /(^|[^A-Za-z])"?(password|passwd|pwd)"?\s*[:=]/im, `${where} contiene una clave de contraseña`);
    }
    assert.ok(idb.includes('accessToken'), 'la sesión sí está guardada (solo tokens)');

    const token = (await store.load())!.accessToken;
    await session.logout('local');
    assert.equal(await store.load(), null);
    assert.ok(!(await dumpIndexedDb()).includes(token), 'tras cerrar sesión no queda el token');
    assert.deepEqual((await api.call('GET', '/v1/context', { token, membership: membershipId('c2', 'ana-sup') })).body, { error: 'SESSION_REVOKED' });
  });
});
