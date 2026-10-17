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
import { createOnlineServer } from './app.ts';

export function readConfig(env: NodeJS.ProcessEnv) {
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
    apiUrl: need('ADEX_API_DATABASE_URL'),
    demoUrl: env['ADEX_DEMO_DATABASE_URL']?.trim() || null,
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

/** Error sin datos: código y tipo, nunca mensajes con valores ni tokens. */
function logError(err: unknown) {
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
      service: createDemoService({ pool: demoPool, execute: createCompanyExecutor(companyOpts), provider, onError: logError }) })
    : null;
  const server = createOnlineServer({
    company: createCompanyHandler(companyOpts), demo, readinessPool: apiPool, allowedOrigins: cfg.origins, trustProxy: cfg.trustProxy, rateLimit: cfg.rateLimit,
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
