import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createApp } from '../../src/http/server.ts';
import type { TokenVerifier } from '../../src/auth/supabaseJwt.ts';
import type { LedgerHooks } from '../../src/ledger/service.ts';

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CallOptions {
  token?: string;
  membership?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TestApi {
  base: string;
  call(method: string, path: string, opts?: CallOptions): Promise<ApiResponse>;
  errors: unknown[];
  close(): Promise<void>;
}

export async function startApi(pool: pg.Pool, verifyToken: TokenVerifier, ledgerHooks?: LedgerHooks): Promise<TestApi> {
  const errors: unknown[] = [];
  const server = createApp({ pool, verifyToken, ledgerHooks, onError: (e) => errors.push(e) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  server.unref(); // si una prueba falla sin desmontar, el proceso igualmente termina
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    errors,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
      if (opts.membership) headers['x-adex-membership'] = opts.membership;
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      // Cada llamada es una petición HTTP independiente (keep-alive desactivado).
      headers['connection'] = 'close';
      const res = await fetch(base + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
