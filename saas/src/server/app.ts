// Servidor HTTP de ADEX ONLINE v1: un solo proceso Node (un contenedor) con
//   /v1/*        API de empresa (pool `adex_api`)
//   /demo/v1/*   administración de la Empresa Demo (pool `adex_demo`)
//   /healthz     vida del proceso (sin base de datos)
//   /readyz      la base responde (sin datos)
// La API del plano Owner (/control/v1/*) NO se monta aquí: vive en su PROPIO servicio
// (server/controlStart.ts), con su propio proceso y SOLO credenciales `adex_control`;
// ese servicio usa esta misma capa común con `company` y `demo` nulos.
//
// Capa común a todo: CORS SOLO para los orígenes configurados, cabeceras de seguridad
// (HSTS lo pone el código: App Platform no lo añade), límite de peticiones por IP y por
// token, identificador de petición y un registro por petición SIN tokens, cuerpos,
// correos ni parámetros de consulta.

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type pg from 'pg';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/**
 * Módulos que ESTA versión de la API sirve, publicados en /healthz (sin datos ni secretos).
 * El frontend solo se construye en Vercel cuando la API publicada declara lo que necesita
 * (`online/scripts/deploy-gate.mjs`): así un push nunca adelanta el frontend a la API.
 */
export const API_FEATURES: readonly string[] = ['collections-v1', 'settlements-v1', 'clean-online-v1', 'changes-v1', 'access-links-v1', 'payment-location-v1',
  'admin-transfers-v1', 'capital-requests-v1', 'offline-collector-v1', 'offline-disbursements-v1', 'route-map-v1',
  'credit-rectification-v1', 'movements-v1', 'single-session-v1', 'rectification-payments-v1', 'movements-v2',
  // R74 Base por Ruta (0034): solo si 0034 está aplicada (start.ts). NO está en la puerta de Vercel todavía.
  'route-base-v1',
  // R74 (0035, D74-O4F): gastos generales con aportes de rutas o dinero propio y reembolsos. Fuera de la puerta de Vercel.
  'general-expenses-v1'];

/** Módulos del servicio Owner (servicio aparte, ver controlStart.ts). */
// Ronda 54: `owner-email-v1` (cambio del correo del SuperAdmin) solo si 0024 está aplicada (controlStart.ts).
export const CONTROL_FEATURES: readonly string[] = ['owner-v1', 'owner-clean-v1', 'owner-email-v1'];

export interface OnlineServerOptions {
  company: Handler | null;
  demo: Handler | null;
  /** Solo en el servicio Owner. Nunca junto a `company` o `demo`. */
  control?: Handler | null;
  /** Lo que declara /healthz (por defecto, los módulos de la API de empresa). */
  features?: readonly string[];
  /** Pool para /readyz (`select 1`). */
  readinessPool: pg.Pool;
  /** Orígenes exactos admitidos (p. ej. https://adex-online.example). Nunca «*». */
  allowedOrigins: readonly string[];
  /** Peticiones por minuto por IP (por defecto 300) y por token (por defecto 240). */
  rateLimit?: { perIpPerMinute?: number; perTokenPerMinute?: number };
  /** Detrás de un proxy de confianza (App Platform): IP del cliente en X-Forwarded-For. */
  trustProxy?: boolean;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

const ALLOWED_HEADERS = 'authorization, content-type, x-adex-membership, x-adex-operation-id';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, OPTIONS';

/** Ventana fija de 60 s por clave. Memoria acotada: se purga al cambiar de ventana. */
export function createRateLimiter(limit: number, now: () => number = Date.now) {
  let window = Math.floor(now() / 60_000);
  let counts = new Map<string, number>();
  return (key: string): boolean => {
    const w = Math.floor(now() / 60_000);
    if (w !== window) { window = w; counts = new Map(); }
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= limit;
  };
}

/** Plantilla de la ruta para el registro: sin identificadores ni datos. */
export function routeTemplate(path: string): string {
  return path.split('?')[0]!.split('/').map((seg) => (/^[0-9a-f-]{8,}$/i.test(seg) || /\d/.test(seg) && seg.length > 12 ? ':id' : seg)).join('/');
}

export function createOnlineServer(opts: OnlineServerOptions): http.Server {
  const now = opts.now ?? Date.now;
  const byIp = createRateLimiter(opts.rateLimit?.perIpPerMinute ?? 300, now);
  const byToken = createRateLimiter(opts.rateLimit?.perTokenPerMinute ?? 240, now);
  const origins = new Set(opts.allowedOrigins.map((o) => o.replace(/\/$/, '')));
  if (origins.has('*')) throw new Error('CORS: wildcard origin is not allowed');
  if (opts.control && (opts.company || opts.demo)) throw new Error('the Owner API must run in its own service');
  const features = opts.features ?? API_FEATURES;
  const log = opts.log ?? ((l) => process.stdout.write(`${JSON.stringify(l)}\n`));

  return http.createServer((req, res) => {
    const started = now();
    const requestId = randomUUID();
    const path = (req.url ?? '/').split('?')[0]!;
    res.setHeader('x-request-id', requestId);
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('vary', 'Origin');
    res.on('finish', () => log({ t: new Date(started).toISOString(), id: requestId, m: req.method, r: routeTemplate(path), s: res.statusCode, ms: now() - started }));

    const origin = req.headers['origin'];
    const originOk = typeof origin === 'string' && origins.has(origin);
    if (originOk) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-expose-headers', 'x-request-id');
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const reject = (status: number, error: string) => json(status, { error });

    if (req.method === 'OPTIONS') {
      if (!originOk) return reject(403, 'ORIGIN_NOT_ALLOWED');
      res.writeHead(204, { 'access-control-allow-methods': ALLOWED_METHODS, 'access-control-allow-headers': ALLOWED_HEADERS, 'access-control-max-age': '600' });
      return res.end();
    }
    // Un navegador de otro origen no recibe respuesta legible (sin ACAO) y además se
    // rechaza: nada se ejecuta en nombre de una página ajena.
    if (typeof origin === 'string' && !originOk) return reject(403, 'ORIGIN_NOT_ALLOWED');

    if (path === '/healthz' && req.method === 'GET') return json(200, { status: 'ok', features });
    const forwarded = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    if (!byIp(ip)) return reject(429, 'RATE_LIMITED');
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.length > 16) {
      // Clave del límite: huella del token (el token nunca se guarda ni se registra).
      if (!byToken(createHash('sha256').update(auth).digest('hex').slice(0, 32))) return reject(429, 'RATE_LIMITED');
    }

    void (async () => {
      try {
        if (path === '/readyz' && req.method === 'GET') {
          await opts.readinessPool.query('select 1');
          return json(200, { status: 'ready' });
        }
        if (path.startsWith('/demo/v1/')) {
          if (!opts.demo) return reject(404, 'NOT_FOUND');
          return await opts.demo(req, res);
        }
        if (path.startsWith('/control/v1/')) {
          if (!opts.control) return reject(404, 'NOT_FOUND');
          return await opts.control(req, res);
        }
        if (path.startsWith('/v1/')) {
          if (!opts.company) return reject(404, 'NOT_FOUND');
          return await opts.company(req, res);
        }
        reject(404, 'NOT_FOUND');
      } catch {
        if (!res.headersSent) reject(503, 'UNAVAILABLE');
      }
    })();
  });
}
