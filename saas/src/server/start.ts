// Arranque de ADEX ONLINE v1 (contenedor de Render, DigitalOcean App Platform o local).
//
//   node --import ./scripts/register-alias.mjs src/server/main.ts
//
// Toda la configuración llega por variables de entorno (secretos del proveedor de
// alojamiento; NUNCA en el repositorio). Ver docs/ADEX_ONLINE_RENDER.md.
//
//   PORT                       puerto HTTP (Render: 10000; App Platform lo fija; por defecto 8080)
//   ADEX_API_DATABASE_URL      adex_api por el pooler de transacciones de Supabase (obligatorio)
//   ADEX_DEMO_DATABASE_URL     adex_demo (opcional: sin ella, /demo/v1 no existe)
//   ADEX_DEMO_SCENARIO         demo-v1 (por defecto) | demo-v2-6m (seis meses de historia)
//   SUPABASE_URL               https://<ref>.supabase.co (emisor de tokens y JWKS)
//   SUPABASE_PUBLISHABLE_KEY   cierre de sesión en el proveedor
//   SUPABASE_SECRET_KEY        SOLO invitaciones (alta sin contraseña); nunca llega al navegador ni a PostgreSQL
//   ADEX_ALLOWED_ORIGINS       orígenes exactos del frontend, separados por comas
//   ADEX_PG_SSL_CA_FILE        ruta del certificado raíz de Supabase (Render: archivo secreto en /etc/secrets/…)
//   ADEX_PG_SSL_CA_PEM         o el certificado en línea (PEM). Uno de los dos es obligatorio salvo ADEX_PG_SSL_INSECURE=1
//   ADEX_TRUST_PROXY=1         IP del cliente desde X-Forwarded-For (detrás del balanceador)
//   ADEX_API_POOL_MAX          conexiones a la base (por defecto 8)
//   ADEX_RATE_PER_IP / ADEX_RATE_PER_TOKEN   peticiones por minuto (por defecto 300 / 240)

import { readFileSync } from 'node:fs';
import pg from '../db/pgTypes.ts';
import { createTokenVerifier } from '../auth/jwt.ts';
import { createSupabaseProvider } from '../auth/provider.ts';
import { createCompanyExecutor, createCompanyHandler } from '../http/companyApi.ts';
import { createDemoHandler } from '../http/demoApi.ts';
import { createDemoService } from '../demo/service.ts';
import { API_FEATURES, createOnlineServer } from './app.ts';
import { adminTransfersReady, capitalRequestsReady, offlineCollectorReady, offlineDisbursementsReady, paymentLocationsReady, routeMapReady, creditRectificationReady, rectificationPaymentsReady, routeBaseReady, singleSessionReady, generalExpensesReady, adminAuthorityReady } from '../collections/location.ts';

/** Configuración común a los dos servicios (empresa y Owner): TLS, CORS, proveedor, límites. */
export function readCommonConfig(env: NodeJS.ProcessEnv) {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`missing environment variable ${k}`);
    return v;
  };
  const insecure = env['ADEX_PG_SSL_INSECURE'] === '1';
  const caFile = env['ADEX_PG_SSL_CA_FILE']?.trim();
  let ca = env['ADEX_PG_SSL_CA_PEM']?.replace(/\\n/g, '\n');
  if (caFile) {
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch {
      throw new Error('ADEX_PG_SSL_CA_FILE cannot be read');
    }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('ADEX_PG_SSL_CA_FILE is not a PEM certificate');
  }
  if (!ca && !insecure) throw new Error('ADEX_PG_SSL_CA_FILE or ADEX_PG_SSL_CA_PEM is required (or ADEX_PG_SSL_INSECURE=1 for a non-production trial)');
  const origins = need('ADEX_ALLOWED_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean);
  for (const o of origins) if (!/^https?:\/\/[^/\s*]+$/.test(o)) throw new Error(`invalid origin ${o}`);
  return {
    port: Number(env['PORT'] ?? 8080),
    supabaseUrl: need('SUPABASE_URL').replace(/\/$/, ''),
    publishableKey: need('SUPABASE_PUBLISHABLE_KEY'),
    secretKey: need('SUPABASE_SECRET_KEY'),
    origins,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    trustProxy: env['ADEX_TRUST_PROXY'] === '1',
    poolMax: Math.min(Math.max(Number(env['ADEX_API_POOL_MAX'] ?? 8) || 8, 2), 20),
    rateLimit: { perIpPerMinute: Number(env['ADEX_RATE_PER_IP'] ?? 300) || 300, perTokenPerMinute: Number(env['ADEX_RATE_PER_TOKEN'] ?? 240) || 240 },
  };
}

export function readConfig(env: NodeJS.ProcessEnv) {
  const apiUrl = env['ADEX_API_DATABASE_URL']?.trim();
  if (!apiUrl) throw new Error('missing environment variable ADEX_API_DATABASE_URL');
  if (env['ADEX_CONTROL_DATABASE_URL']?.trim()) throw new Error('ADEX_CONTROL_DATABASE_URL belongs to the Owner service, not to this one');
  return { ...readCommonConfig(env), apiUrl, demoUrl: env['ADEX_DEMO_DATABASE_URL']?.trim() || null };
}

/** Error sin datos: código y tipo, nunca mensajes con valores ni tokens. */
export function logError(err: unknown) {
  const e = err as { code?: string; name?: string; constraint?: string };
  process.stderr.write(`${JSON.stringify({ level: 'error', t: new Date().toISOString(), name: e?.name ?? 'Error', code: e?.code ?? null, constraint: e?.constraint ?? null })}\n`);
}

export async function start(env: NodeJS.ProcessEnv = process.env) {
  const cfg = readConfig(env);
  const apiPool = new pg.Pool({ connectionString: cfg.apiUrl, ssl: cfg.ssl, max: cfg.poolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  const demoPool = cfg.demoUrl ? new pg.Pool({ connectionString: cfg.demoUrl, ssl: cfg.ssl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 }) : null;
  for (const p of [apiPool, demoPool]) p?.on('error', logError);
  const verifyToken = createTokenVerifier({ issuer: `${cfg.supabaseUrl}/auth/v1` });
  const provider = createSupabaseProvider({ url: cfg.supabaseUrl, publishableKey: cfg.publishableKey, secretKey: cfg.secretKey });
  const companyOpts = { pool: apiPool, verifyToken, provider, onError: logError };
  const demo = demoPool
    ? createDemoHandler({ verifyToken, onError: logError,
      service: createDemoService({ pool: demoPool, execute: createCompanyExecutor(companyOpts), provider, onError: logError,
        // Escenario de las Demos que cree o reinicie ESTE servicio (por defecto demo-v1).
        scenario: env['ADEX_DEMO_SCENARIO'] === 'demo-v2-6m' ? 'demo-v2-6m' : 'demo-v1' }) })
    : null;
  // Ronda 48: `payment-location-v1` solo si 0022 está aplicada; Ronda 53: `admin-transfers-v1` solo
  // si 0023 lo está. La puerta de Vercel exige ambas: el frontend nunca va por delante del esquema.
  const missing = new Set<string>();
  if (!(await paymentLocationsReady(apiPool))) missing.add('payment-location-v1');
  if (!(await adminTransfersReady(apiPool))) missing.add('admin-transfers-v1');
  // Ronda 59: entregas voluntarias y solicitudes solo con 0025 aplicada.
  if (!(await capitalRequestsReady(apiPool))) missing.add('capital-requests-v1');
  // Ronda 62: modo sin conexión del Cobrador solo con 0026 aplicada.
  if (!(await offlineCollectorReady(apiPool))) missing.add('offline-collector-v1');
  // Ronda 65: desembolsos sin conexión solo con 0027 aplicada.
  if (!(await offlineDisbursementsReady(apiPool))) missing.add('offline-disbursements-v1');
  // Ronda 67: mapa del Administrador y SuperAdmin de solo lectura solo con 0028 y 0029 aplicadas.
  if (!(await routeMapReady(apiPool))) missing.add('route-map-v1');
  // Ronda 73: parcelas en la autorización y rectificación de créditos solo con 0030 aplicada.
  if (!(await creditRectificationReady(apiPool))) missing.add('credit-rectification-v1');
  // Ronda 73: una sola sesión activa por identidad solo con 0031 aplicada.
  if (!(await singleSessionReady(apiPool))) missing.add('single-session-v1');
  // Bloque A post-R73: rectificación con pagos y reaplicación solo con 0032 aplicada.
  if (!(await rectificationPaymentsReady(apiPool))) missing.add('rectification-payments-v1');
  // R74 Base por Ruta: solo con 0034 aplicada (no forma parte de la puerta de Vercel todavía).
  if (!(await routeBaseReady(apiPool))) missing.add('route-base-v1');
  // R74 (0035, D74-O4F): gastos generales financiados y reembolsos a Administradores (fuera de la puerta de Vercel).
  if (!(await generalExpensesReady(apiPool))) missing.add('general-expenses-v1');
  // R74 (0036): conciliación de diferencias y diagnóstico de desactivación de Administradores.
  if (!(await adminAuthorityReady(apiPool))) missing.add('admin-authority-v1');
  const features = API_FEATURES.filter((f) => !missing.has(f));
  const server = createOnlineServer({
    company: createCompanyHandler(companyOpts), demo, readinessPool: apiPool, allowedOrigins: cfg.origins, trustProxy: cfg.trustProxy, rateLimit: cfg.rateLimit,
    features,
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve) => server.listen(cfg.port, '0.0.0.0', () => resolve()));
  process.stdout.write(`${JSON.stringify({ level: 'info', t: new Date().toISOString(), msg: 'adex-online listening', port: cfg.port, demo: Boolean(demo), origins: cfg.origins.length })}\n`);
  const stop = () => {
    server.close(() => { void Promise.all([apiPool.end(), demoPool?.end()]).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
