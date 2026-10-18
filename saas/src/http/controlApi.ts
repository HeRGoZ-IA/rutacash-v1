// API del plano de control OWNER (DS-17). Servidor y pool PROPIOS, conectados como
// `adex_control`. Misma identidad central y mismo registro de revocación de sesiones
// que la API de empresa, pero ser Owner NO es una membresía: aquí no existe
// `X-Adex-Membership`, ni lectura operativa, ni forma de entrar en una empresa.
//
//   GET  /control/v1/me                                perfil del Owner de la sesión
//   GET  /control/v1/companies                         fichas de control (sin datos operativos)
//   POST /control/v1/companies                         alta de empresa
//   GET  /control/v1/companies/:id                     ficha + historial + cobros SaaS
//   POST /control/v1/companies/:id/superadmins         primer SuperAdmin (invitación del proveedor)
//   POST /control/v1/companies/:id/status              trial | active | suspended
//   POST /control/v1/companies/:id/route-counts        recuento de rutas (lo calcula el servidor)
//   PUT  /control/v1/companies/:id/billing             condiciones de facturación SaaS
//   POST /control/v1/companies/:id/payments            cobro de ADEX a la empresa
//   GET  /control/v1/payments                          todos los cobros SaaS
//   POST /control/v1/payments/:id/status               estado de un cobro SaaS
//   POST /control/v1/session/logout

import http from 'node:http';
import type pg from 'pg';
import { ApiError, fromPgError } from '../errors.ts';
import { withTransaction, type SessionClaims } from '../db/tx.ts';
import { bearer, type TokenVerifier } from '../auth/jwt.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import {
  addSuperadmin, companyDetail, createCompany, listCompanies, listPayments, operatorLogout, operatorProfile, refreshRouteCounts,
  registerPayment, resolveOperator, setCompanyStatus, setPaymentStatus, updateBilling,
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
type Handler = (c: pg.PoolClient, b: Record<string, unknown>, claims: SessionClaims) => Promise<{ status: number; body: unknown }>;

/** Manejador HTTP de la API Owner (montable en el servicio Owner, ver server/controlStart.ts). */
export function createControlHandler(opts: ControlApiOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const token = bearer(req.headers['authorization']);
      const claims = await opts.verifyToken(token);
      const p = url.pathname;
      const one = /^\/control\/v1\/companies\/([^/]+)(?:\/(superadmins|status|route-counts|billing|payments))?$/.exec(p);
      const payment = /^\/control\/v1\/payments\/([^/]+)\/status$/.exec(p);

      let fields: string[] | null = null;
      let handler: Handler | null = null;
      if (method === 'GET' && p === '/control/v1/me') {
        handler = async (c, _b, cl) => ({ status: 200, body: await operatorProfile(c, cl) });
      } else if (method === 'GET' && p === '/control/v1/companies') {
        handler = async (c) => ({ status: 200, body: { companies: await listCompanies(c) } });
      } else if (method === 'POST' && p === '/control/v1/companies') {
        fields = COMPANY_FIELDS;
        handler = async (c, b) => ({ status: 201, body: await createCompany(c, b) });
      } else if (method === 'GET' && p === '/control/v1/payments') {
        handler = async (c) => ({ status: 200, body: { payments: await listPayments(c) } });
      } else if (one) {
        const id = decodeURIComponent(one[1]!);
        const sub = one[2];
        if (method === 'GET' && !sub) handler = async (c) => ({ status: 200, body: await companyDetail(c, id) });
        if (method === 'POST' && sub === 'superadmins') { fields = ['email', 'displayName']; handler = async (c, b) => ({ status: 201, body: await addSuperadmin(c, id, b, opts.provider) }); }
        if (method === 'POST' && sub === 'status') { fields = ['status', 'detail']; handler = async (c, b) => ({ status: 200, body: await setCompanyStatus(c, id, b) }); }
        if (method === 'POST' && sub === 'route-counts') { fields = []; handler = async (c) => ({ status: 200, body: await refreshRouteCounts(c, id) }); }
        if (method === 'PUT' && sub === 'billing') { fields = ['billingMode', 'billingRate', 'nextBillingDate', 'paymentStatus']; handler = async (c, b) => ({ status: 200, body: await updateBilling(c, id, b) }); }
        if (method === 'POST' && sub === 'payments') { fields = ['period', 'amount', 'expectedDate', 'status', 'paidDate', 'note']; handler = async (c, b) => ({ status: 201, body: await registerPayment(c, id, b) }); }
      } else if (method === 'POST' && payment) {
        const id = decodeURIComponent(payment[1]!);
        fields = ['status', 'paidDate'];
        handler = async (c, b) => ({ status: 200, body: await setPaymentStatus(c, id, b) });
      } else if (method === 'POST' && p === '/control/v1/session/logout') {
        fields = ['scope'];
        handler = async (c, b) => { await operatorLogout(c, scopeOf(b)); return { status: 200, body: { revoked: true } }; };
      }
      if (!handler) throw new ApiError(404, 'NOT_FOUND');
      const body = fields ? await readJson(req, fields) : {};
      const h = handler;
      const result = await withTransaction(opts.pool, async (c) => {
        await resolveOperator(c, claims);
        return h(c, body, claims);
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
  };
}

/** Servidor HTTP mínimo con solo la API Owner (pruebas). */
export function createControlApi(opts: ControlApiOptions): http.Server {
  const handle = createControlHandler(opts);
  return http.createServer((req, res) => { void handle(req, res); });
}
