// ADEX Online v1 · arnés de pruebas: servidor compuesto (API de empresa + administración
// Demo) sobre una base de prueba, emisor local de tokens y proveedor en memoria.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createCompanyExecutor, createCompanyHandler, type CompanyApiOptions } from '../../src/http/companyApi.ts';
import { createDemoHandler } from '../../src/http/demoApi.ts';
import { createDemoService, type DemoServiceOptions } from '../../src/demo/service.ts';
import { createOnlineServer } from '../../src/server/app.ts';
import { createLocalIssuer, createMemoryProvider, type LocalIssuer } from './auth.ts';
import type { TestDb } from './db.ts';

export const ORIGIN = 'https://adex-online.example.test';

export interface Res { status: number; body: Record<string, unknown>; headers: Headers }

export interface Online {
  base: string;
  issuer: LocalIssuer;
  provider: ReturnType<typeof createMemoryProvider>;
  errors: unknown[];
  logs: Record<string, unknown>[];
  service: ReturnType<typeof createDemoService>;
  call(method: string, path: string, o?: { token?: string; membership?: string; body?: unknown; op?: string; headers?: Record<string, string> }): Promise<Res>;
  close(): Promise<void>;
}

export async function startOnline(db: TestDb, extra: {
  company?: Partial<Pick<CompanyApiOptions, 'afterContext' | 'beforeCommit' | 'lockTimeoutMs'>>;
  demo?: Partial<Pick<DemoServiceOptions, 'onScenarioStep'>>;
  rateLimit?: { perIpPerMinute?: number; perTokenPerMinute?: number };
} = {}): Promise<Online> {
  const issuer = await createLocalIssuer();
  const provider = createMemoryProvider();
  const errors: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const companyOpts: CompanyApiOptions = { pool: db.api, verifyToken: issuer.verifier, provider, onError: (e) => errors.push(e), ...(extra.company ?? {}) };
  // El escenario usa su PROPIO ejecutor sin ganchos de prueba (los ganchos son para las personas).
  const service = createDemoService({ pool: db.demo, provider, onError: (e) => errors.push(e), ...(extra.demo ?? {}),
    execute: createCompanyExecutor({ pool: db.api, verifyToken: issuer.verifier, provider, onError: (e) => errors.push(e) }) });
  const server: http.Server = createOnlineServer({
    company: createCompanyHandler(companyOpts),
    demo: createDemoHandler({ verifyToken: issuer.verifier, service, onError: (e) => errors.push(e) }),
    readinessPool: db.api, allowedOrigins: [ORIGIN], rateLimit: extra.rateLimit ?? { perIpPerMinute: 100_000, perTokenPerMinute: 100_000 },
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, issuer, provider, errors, logs, service,
    async call(method, path, o = {}) {
      const headers: Record<string, string> = { connection: 'close', ...(o.headers ?? {}) };
      if (o.token) headers['authorization'] = `Bearer ${o.token}`;
      if (o.membership) headers['x-adex-membership'] = o.membership;
      if (o.op) headers['x-adex-operation-id'] = o.op;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Persona invitada (identidad del proveedor en memoria) con un token propio. */
export async function person(online: Online, email: string) {
  const { identityId } = await online.provider.ensureIdentity(email);
  return { email, identityId, token: await online.issuer.issue(identityId) };
}

/** Alta de un operador Demo: SOLO el administrador de la base (nunca la API). */
export async function grantDemoOperator(db: TestDb, identityId: string, email: string) {
  await db.admin.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [identityId, email]);
  await db.admin.query(`insert into adex_demo.operators (identity_id, note) values ($1, 'prueba') on conflict do nothing`, [identityId]);
}

export const op = () => randomUUID();
