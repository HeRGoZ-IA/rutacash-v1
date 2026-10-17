// API de ADMINISTRACIÓN DE LA EMPRESA DEMO (ADEX Online v1). Plano separado: no hay
// `X-Adex-Membership` ni contexto de empresa; la autoridad es ser operador Demo activo
// (`adex_demo.operators`) con sesión no revocada. No es el Owner ni da acceso financiero.
//
//   GET  /demo/v1/slots/:slot                         estado, puestos, participantes, auditoría
//   POST /demo/v1/slots/:slot/create                  { name?, wait? }
//   POST /demo/v1/slots/:slot/reset                   { companyId, confirm (= companyId), name?, wait? }
//   POST /demo/v1/slots/:slot/delete                  { companyId, confirm }
//   POST /demo/v1/slots/:slot/abort                   { companyId, confirm }  (aprovisionamiento interrumpido)
//   PUT  /demo/v1/slots/:slot/participants/:seat      { email, displayName }  (invitación del proveedor)
//   POST /demo/v1/slots/:slot/participants/:seat/remove

import type http from 'node:http';
import { bearer, type TokenVerifier } from '../auth/jwt.ts';
import { ApiError, fromPgError } from '../errors.ts';
import type { DemoService } from '../demo/service.ts';
import { checkFields, readJsonObject, send } from './common.ts';

export interface DemoApiOptions {
  verifyToken: TokenVerifier;
  service: DemoService;
  onError?: (err: unknown) => void;
}

const SLOT = '([a-z][a-z0-9-]{1,30})';
const SEAT = '([a-z][a-z0-9-]{1,40})';

export function createDemoHandler(opts: DemoApiOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const claims = await opts.verifyToken(bearer(req.headers['authorization']));
      const p = url.pathname;
      const body = async (fields: string[]) => checkFields(await readJsonObject(req), fields);
      const wait = (b: Record<string, unknown>) => b['wait'] !== false;
      let m: RegExpExecArray | null;
      let out: { status: number; body: unknown };
      if (method === 'GET' && (m = new RegExp(`^/demo/v1/slots/${SLOT}$`).exec(p))) {
        out = { status: 200, body: await opts.service.status(claims, m[1]!) };
      } else if (method === 'POST' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/create$`).exec(p))) {
        const b = await body(['name', 'wait']);
        out = await opts.service.create(claims, m[1]!, b, wait(b));
      } else if (method === 'POST' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/reset$`).exec(p))) {
        const b = await body(['companyId', 'confirm', 'name', 'wait']);
        out = await opts.service.reset(claims, m[1]!, b, wait(b));
      } else if (method === 'POST' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/delete$`).exec(p))) {
        out = await opts.service.remove(claims, m[1]!, await body(['companyId', 'confirm']));
      } else if (method === 'POST' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/abort$`).exec(p))) {
        out = await opts.service.abort(claims, m[1]!, await body(['companyId', 'confirm']));
      } else if (method === 'PUT' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/participants/${SEAT}$`).exec(p))) {
        out = await opts.service.setParticipant(claims, m[1]!, m[2]!, await body(['email', 'displayName']));
      } else if (method === 'POST' && (m = new RegExp(`^/demo/v1/slots/${SLOT}/participants/${SEAT}/remove$`).exec(p))) {
        out = await opts.service.removeParticipant(claims, m[1]!, m[2]!);
      } else {
        throw new ApiError(404, 'NOT_FOUND');
      }
      send(res, out.status, out.body);
    } catch (err) {
      const e = err instanceof ApiError ? err : fromPgError(err);
      if (e) return send(res, e.status, { error: e.code });
      opts.onError?.(err);
      send(res, 500, { error: 'INTERNAL' });
    }
  };
}
