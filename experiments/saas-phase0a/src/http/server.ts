// API HTTP experimental (node:http, sin framework). No se despliega.
//
//   Authorization: Bearer <token de acceso de Supabase Auth>
//   X-Adex-Membership: <id de la membresía con la que se opera>
//
// El cliente NO envía empresa, rol ni rutas: se ignoran los encabezados ajenos y
// se rechaza cualquier campo de cuerpo desconocido.

import http from 'node:http';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { withTransaction } from '../db/tx.ts';
import type { TokenVerifier } from '../auth/supabaseJwt.ts';
import { listOwnMemberships, resolveContext, type ActiveContext } from '../authz/context.ts';
import { executeLedgerCommand, getAccount, listAccounts, type CommandResult, type LedgerHooks } from '../ledger/service.ts';

export interface AppOptions {
  pool: pg.Pool;
  verifyToken: TokenVerifier;
  /** Solo pruebas. */
  ledgerHooks?: LedgerHooks;
  onError?: (err: unknown) => void;
}

const MAX_BODY = 16 * 1024;
const COMMAND_FIELDS = new Set(['operationId', 'amount']);

type Handler = (client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) => Promise<CommandResult>;

function route(method: string, path: string, hooks: LedgerHooks): { needsBody: boolean; handler: Handler } | null {
  if (method === 'GET' && path === '/v1/context') {
    return {
      needsBody: false,
      handler: async (_c, ctx) => ({
        status: 200,
        body: {
          identityId: ctx.identityId,
          membershipId: ctx.membershipId,
          role: ctx.role,
          scope: ctx.scope,
          routeIds: ctx.routeIds,
          company: ctx.company,
        },
      }),
    };
  }
  if (method === 'GET' && path === '/v1/accounts') {
    return { needsBody: false, handler: async (c, ctx) => ({ status: 200, body: { accounts: await listAccounts(c, ctx) } }) };
  }
  const one = /^\/v1\/accounts\/([^/]+)$/.exec(path);
  if (method === 'GET' && one) {
    const id = decodeURIComponent(one[1] as string);
    return { needsBody: false, handler: async (c, ctx) => ({ status: 200, body: await getAccount(c, ctx, id) }) };
  }
  const cmd = /^\/v1\/accounts\/([^/]+)\/(withdrawals|deposits)$/.exec(path);
  if (method === 'POST' && cmd) {
    const accountId = decodeURIComponent(cmd[1] as string);
    const kind = cmd[2] === 'deposits' ? 'deposit' : 'withdrawal';
    return {
      needsBody: true,
      handler: (c, ctx, body) => executeLedgerCommand(c, ctx, { kind, accountId, operationId: body['operationId'], amount: body['amount'] }, hooks),
    };
  }
  return null;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError(400, 'INVALID_JSON');
  for (const key of Object.keys(parsed)) {
    if (!COMMAND_FIELDS.has(key)) throw new ApiError(400, 'UNKNOWN_FIELD', `field "${key}" is not accepted`);
  }
  return parsed as Record<string, unknown>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

export function createApp(opts: AppOptions): http.Server {
  const hooks = opts.ledgerHooks ?? {};
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';

        const auth = req.headers['authorization'];
        const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        // Ruta conocida o no, sin token válido no se revela nada.
        if (!token) throw new ApiError(401, 'MISSING_TOKEN');
        const identity = await opts.verifyToken(token);

        if (method === 'GET' && url.pathname === '/v1/me/memberships') {
          const memberships = await withTransaction(opts.pool, (c) => listOwnMemberships(c, identity.identityId));
          return send(res, 200, { identityId: identity.identityId, memberships });
        }

        const r = route(method, url.pathname, hooks);
        if (!r) throw new ApiError(404, 'NOT_FOUND');

        const membershipHeader = req.headers['x-adex-membership'];
        if (typeof membershipHeader !== 'string' || membershipHeader === '') throw new ApiError(400, 'MEMBERSHIP_REQUIRED');
        const body = r.needsBody ? await readJson(req) : {};

        const result = await withTransaction(opts.pool, async (client) => {
          const ctx = await resolveContext(client, identity.identityId, membershipHeader.trim());
          return r.handler(client, ctx, body);
        });
        send(res, result.status, result.body);
      } catch (err) {
        if (err instanceof ApiError) return send(res, err.status, { error: err.code });
        opts.onError?.(err);
        send(res, 500, { error: 'INTERNAL' });
      }
    })();
  });
}
