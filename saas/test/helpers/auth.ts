// EMISOR LOCAL con el formato de Supabase Auth (ES256 + JWKS, `session_id`, `iat`)
// y PROVEEDOR DE IDENTIDAD EN MEMORIA.
//
// ATENCIÓN: esto NO es Supabase Auth. Ejercita la verificación de la API, la
// revocación ADEX y la autorización por membresía sin servicios externos. La
// evidencia contra Supabase real la da test/auth-real (BLOQUEADA sin ADEX-Staging).

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK } from 'jose';
import { createTokenVerifier, type TokenVerifier } from '../../src/auth/jwt.ts';
import type { IdentityProvider } from '../../src/auth/provider.ts';
import { createCompanyApi, type CompanyApiOptions } from '../../src/http/companyApi.ts';
import { createControlApi } from '../../src/http/controlApi.ts';
import type { ActiveContext } from '../../src/authz/context.ts';
import { identityOf, type Person } from '../../db/seeds/synthetic.ts';
import type { TestDb } from './db.ts';

export const LOCAL_ISSUER = 'http://127.0.0.1:54321/auth/v1';

export interface IssueOptions {
  expSec?: number;
  iat?: number;
  sessionId?: string;
  iss?: string;
  aud?: string;
  role?: string;
  alg?: 'ES256';
  extra?: Record<string, unknown>;
  omit?: string[];
}

export interface LocalIssuer {
  jwks: JSONWebKeySet;
  verifier: TokenVerifier;
  /** Token para una identidad (uuid) o persona sintética. */
  issue(subject: string, o?: IssueOptions): Promise<string>;
  /** Firmado con OTRA clave y el mismo `kid`. */
  issueForged(subject: string): Promise<string>;
}

export async function createLocalIssuer(): Promise<LocalIssuer> {
  const kid = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const other = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const sign = (key: CryptoKey, subject: string, o: IssueOptions = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const iat = o.iat ?? now;
    const claims: Record<string, unknown> = {
      role: o.role ?? 'authenticated', session_id: o.sessionId ?? randomUUID(), aal: 'aal1', email: `${subject}@example.test`, ...(o.extra ?? {}),
    };
    for (const k of o.omit ?? []) delete claims[k];
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).setSubject(subject)
      .setIssuer(o.iss ?? LOCAL_ISSUER).setAudience(o.aud ?? 'authenticated').setExpirationTime(iat + (o.expSec ?? 3600));
    if (!(o.omit ?? []).includes('iat')) jwt = jwt.setIssuedAt(iat);
    return jwt.sign(key);
  };
  return {
    jwks,
    verifier: createTokenVerifier({ issuer: LOCAL_ISSUER, jwks }),
    issue: (s, o) => sign(privateKey as CryptoKey, PEOPLE_SET.has(s) ? identityOf(s as Person) : s, o),
    issueForged: (s) => sign(other.privateKey as CryptoKey, PEOPLE_SET.has(s) ? identityOf(s as Person) : s),
  };
}

const PEOPLE_SET = new Set<string>(['ana', 'bruno', 'carla', 'diego', 'elisa', 'fabio', 'gabi', 'hugo', 'irene', 'owner']);

/** Proveedor en memoria: un `sub` estable por correo; registra los cierres de sesión. */
export function createMemoryProvider(): IdentityProvider & { signOuts: { scope: string }[]; ids: Map<string, string>; signedIn: Set<string>; links: string[] } {
  const ids = new Map<string, string>();
  const signOuts: { scope: string }[] = [];
  /** Identidades que ya iniciaron sesión (el proveedor real lo sabe por `last_sign_in_at`). */
  const signedIn = new Set<string>();
  const links: string[] = [];
  return {
    ids,
    signOuts,
    signedIn,
    links,
    async issueAccessLink(identityId) {
      if (signedIn.has(identityId)) return { status: 'already_active' };
      const tokenHash = randomUUID().replaceAll('-', '');
      links.push(identityId);
      return { status: 'issued', tokenHash };
    },
    async ensureIdentity(email) {
      const e = email.trim().toLowerCase();
      const existing = ids.get(e);
      if (existing) return { identityId: existing, created: false };
      const id = randomUUID();
      ids.set(e, id);
      return { identityId: id, created: true };
    },
    async signOut(_token, scope) {
      signOuts.push({ scope });
    },
  };
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface TestServer {
  /** URL base (`http://127.0.0.1:<puerto>`) para peticiones crudas. */
  base: string;
  call(method: string, path: string, o?: { token?: string; membership?: string; body?: unknown; headers?: Record<string, string> }): Promise<ApiResponse>;
  errors: unknown[];
  close(): Promise<void>;
}

async function serve(server: http.Server, errors: unknown[]): Promise<TestServer> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    errors,
    async call(method, path, o = {}) {
      const headers: Record<string, string> = { connection: 'close', ...(o.headers ?? {}) };
      if (o.token) headers['authorization'] = `Bearer ${o.token}`;
      if (o.membership) headers['x-adex-membership'] = o.membership;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export async function startCompanyApi(db: TestDb, issuer: LocalIssuer, provider: IdentityProvider,
  extra: Partial<Pick<CompanyApiOptions, 'afterContext' | 'beforeCommit' | 'lockTimeoutMs'>> = {}): Promise<TestServer> {
  const errors: unknown[] = [];
  return serve(createCompanyApi({ pool: db.api, verifyToken: issuer.verifier, provider, onError: (e) => errors.push(e), ...extra }), errors);
}

export async function startControlApi(db: TestDb, issuer: LocalIssuer, provider: IdentityProvider): Promise<TestServer> {
  const errors: unknown[] = [];
  return serve(createControlApi({ pool: db.control, verifyToken: issuer.verifier, provider, onError: (e) => errors.push(e) }), errors);
}

export type { ActiveContext };
