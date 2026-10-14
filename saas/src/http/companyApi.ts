// API de EMPRESA (Fase 1: identidad, contexto, rutas y membresías). Sin framework.
//
//   Authorization: Bearer <token de acceso del proveedor de identidad>
//   X-Adex-Membership: <membresía con la que se opera>   (contexto explícito, DS-05)
//
// El cliente nunca envía empresa, rol ni rutas: se ignoran los encabezados ajenos y
// se rechaza cualquier campo de cuerpo desconocido. Todo con `adex_api` (sin BYPASSRLS).

import http from 'node:http';
import type pg from 'pg';
import { ApiError, fromPgError } from '../errors.ts';
import { withTransaction } from '../db/tx.ts';
import { bearer, type TokenVerifier } from '../auth/jwt.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import { listOwnMemberships, resolveContext, resolveIdentity, type ActiveContext } from '../authz/context.ts';
import { capabilitiesOf } from '../authz/cleanRules.ts';
import {
  createMember, getRoute, listMembers, listRoutes, logout, setMemberRoutes, setMemberStatus,
} from '../identity/service.ts';
import { readJson, scopeOf, send } from './common.ts';

export interface CompanyApiOptions {
  pool: pg.Pool;
  verifyToken: TokenVerifier;
  provider: IdentityProvider;
  lockTimeoutMs?: number;
  /** Solo pruebas: se ejecuta con el contexto resuelto y los bloqueos tomados. */
  afterContext?: (ctx: ActiveContext, path: string) => Promise<void>;
  onError?: (err: unknown) => void;
}

type Handler = (client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

interface Route { fields: readonly string[] | null; handler: Handler }

function contextView(ctx: ActiveContext) {
  return {
    identityId: ctx.claims.identityId, membershipId: ctx.membershipId, role: ctx.role, routeIds: ctx.routeIds,
    company: ctx.company, capabilities: capabilitiesOf(ctx.role),
  };
}

function route(method: string, path: string, provider: IdentityProvider): Route | null {
  const ok = (body: unknown) => ({ status: 200, body });
  if (method === 'GET' && path === '/v1/context') return { fields: null, handler: async (_c, ctx) => ok(contextView(ctx)) };
  if (method === 'POST' && path === '/v1/context/select') {
    return {
      fields: [],
      handler: async (c, ctx) => {
        // Telemetría estructural para el plano Owner (FIRST_LOGIN / LOGIN). Nada operativo.
        await c.query('select adex_control.record_company_login()');
        return ok(contextView(ctx));
      },
    };
  }
  if (method === 'GET' && path === '/v1/routes') return { fields: null, handler: async (c, ctx) => ok({ routes: await listRoutes(c, ctx) }) };
  let m = /^\/v1\/routes\/([^/]+)$/.exec(path);
  if (method === 'GET' && m) {
    const id = decodeURIComponent(m[1]!);
    return { fields: null, handler: async (c, ctx) => ok(await getRoute(c, ctx, id)) };
  }
  if (method === 'GET' && path === '/v1/members') return { fields: null, handler: async (c, ctx) => ok({ members: await listMembers(c, ctx) }) };
  if (method === 'POST' && path === '/v1/members') {
    return {
      fields: ['email', 'role', 'displayName', 'phone', 'routeIds'],
      handler: async (c, ctx, b) => ({ status: 201, body: await createMember(c, ctx, b, provider) }),
    };
  }
  m = /^\/v1\/members\/([^/]+)\/(deactivate|reactivate)$/.exec(path);
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]!);
    const status = m[2] === 'deactivate' ? 'inactivo' : 'activo';
    return { fields: [], handler: async (c, ctx) => ok(await setMemberStatus(c, ctx, id, status)) };
  }
  m = /^\/v1\/members\/([^/]+)\/routes$/.exec(path);
  if (method === 'PUT' && m) {
    const id = decodeURIComponent(m[1]!);
    return { fields: ['routeIds'], handler: async (c, ctx, b) => ok(await setMemberRoutes(c, ctx, id, b['routeIds'])) };
  }
  return null;
}

export function createCompanyApi(opts: CompanyApiOptions): http.Server {
  const txOpts = { lockTimeoutMs: opts.lockTimeoutMs };
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        // Ruta conocida o no: sin token válido no se revela nada.
        const token = bearer(req.headers['authorization']);
        const claims = await opts.verifyToken(token);

        if (method === 'GET' && url.pathname === '/v1/me/memberships') {
          const memberships = await withTransaction(opts.pool, (c) => listOwnMemberships(c, claims), txOpts);
          return send(res, 200, { identityId: claims.identityId, memberships });
        }
        if (method === 'POST' && url.pathname === '/v1/session/logout') {
          const scope = scopeOf(await readJson(req, ['scope']));
          await withTransaction(opts.pool, async (c) => {
            await resolveIdentity(c, claims);
            await logout(c, claims, scope);
          }, txOpts);
          // ADEX ya cortó la sesión; el proveedor es segundo paso y no la «desrevoca» si falla.
          let providerRevoked = true;
          try { await opts.provider.signOut(token, scope); } catch (e) { providerRevoked = false; opts.onError?.(e); }
          return send(res, 200, { revoked: true, scope, providerRevoked });
        }

        const r = route(method, url.pathname, opts.provider);
        if (!r) throw new ApiError(404, 'NOT_FOUND');
        const membershipHeader = req.headers['x-adex-membership'];
        if (typeof membershipHeader !== 'string' || membershipHeader.trim() === '') throw new ApiError(400, 'MEMBERSHIP_REQUIRED');
        const body = r.fields ? await readJson(req, r.fields) : {};
        const result = await withTransaction(opts.pool, async (c) => {
          const ctx = await resolveContext(c, claims, membershipHeader.trim());
          await opts.afterContext?.(ctx, url.pathname);
          return r.handler(c, ctx, body);
        }, txOpts);
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
