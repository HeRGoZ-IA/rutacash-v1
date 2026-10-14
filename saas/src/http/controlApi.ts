// API del plano de control OWNER (DS-17). Servidor y pool PROPIOS, conectados como
// `adex_control`. Misma identidad central y mismo registro de revocación de sesiones
// que la API de empresa, pero ser Owner NO es una membresía: aquí no existe
// `X-Adex-Membership`, ni lectura operativa, ni forma de entrar en una empresa.

import http from 'node:http';
import type pg from 'pg';
import { ApiError, fromPgError } from '../errors.ts';
import { withTransaction } from '../db/tx.ts';
import { bearer, type TokenVerifier } from '../auth/jwt.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import {
  addSuperadmin, createCompany, listCompanies, operatorLogout, refreshRouteCounts, resolveOperator, setCompanyStatus,
} from '../control/service.ts';
import { readJson, scopeOf, send } from './common.ts';

export interface ControlApiOptions {
  /** Pool conectado como `adex_control`. */
  pool: pg.Pool;
  verifyToken: TokenVerifier;
  provider: IdentityProvider;
  onError?: (err: unknown) => void;
}

const COMPANY_FIELDS = ['name', 'email', 'plan', 'countryCode', 'countryLabel', 'currencyCode', 'timezone', 'taxId', 'contactName', 'billingMode', 'billingRate'];

export function createControlApi(opts: ControlApiOptions): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const token = bearer(req.headers['authorization']);
        const claims = await opts.verifyToken(token);
        const p = url.pathname;
        const one = /^\/control\/v1\/companies\/([^/]+)\/(superadmins|status|route-counts)$/.exec(p);

        let fields: string[] | null = null;
        let handler: ((c: pg.PoolClient, b: Record<string, unknown>) => Promise<{ status: number; body: unknown }>) | null = null;
        if (method === 'GET' && p === '/control/v1/companies') {
          handler = async (c) => ({ status: 200, body: { companies: await listCompanies(c) } });
        } else if (method === 'POST' && p === '/control/v1/companies') {
          fields = COMPANY_FIELDS;
          handler = async (c, b) => ({ status: 201, body: await createCompany(c, b) });
        } else if (method === 'POST' && one) {
          const id = decodeURIComponent(one[1]!);
          if (one[2] === 'superadmins') { fields = ['email', 'displayName']; handler = async (c, b) => ({ status: 201, body: await addSuperadmin(c, id, b, opts.provider) }); }
          if (one[2] === 'status') { fields = ['status', 'detail']; handler = async (c, b) => ({ status: 200, body: await setCompanyStatus(c, id, b) }); }
          if (one[2] === 'route-counts') { fields = []; handler = async (c) => ({ status: 200, body: await refreshRouteCounts(c, id) }); }
        } else if (method === 'POST' && p === '/control/v1/session/logout') {
          fields = ['scope'];
          handler = async (c, b) => { await operatorLogout(c, scopeOf(b)); return { status: 200, body: { revoked: true } }; };
        }
        if (!handler) throw new ApiError(404, 'NOT_FOUND');
        const body = fields ? await readJson(req, fields) : {};
        const h = handler;
        const result = await withTransaction(opts.pool, async (c) => {
          await resolveOperator(c, claims);
          return h(c, body);
        });
        if (p === '/control/v1/session/logout') {
          try { await opts.provider.signOut(token, scopeOf(body)); } catch (e) { opts.onError?.(e); }
        }
        send(res, result.status, result.body);
      } catch (err) {
        const e = err instanceof ApiError ? err : fromPgError(err);
        if (e) return send(res, e.status, { error: e.code });
        opts.onError?.(err);
        send(res, 500, { error: 'INTERNAL' });
      }
    })();
  });
}
