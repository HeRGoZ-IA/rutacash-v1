// Arranque del SERVICIO OWNER (panel Owner SaaS, Ronda 20). Proceso y despliegue
// PROPIOS, separados de la API de empresa:
//
//   node --import ./scripts/register-alias.mjs src/server/controlMain.ts
//
//   ADEX_CONTROL_DATABASE_URL  adex_control por el pooler de Supabase (obligatorio)
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (solo invitación del primer SuperAdmin)
//   ADEX_ALLOWED_ORIGINS, ADEX_PG_SSL_CA_FILE | ADEX_PG_SSL_CA_PEM, ADEX_TRUST_PROXY, PORT  (igual que start.ts)
//
// Separación exigida al arrancar (si algo falla, el proceso NO se levanta):
//   · NO acepta credenciales de la API de empresa ni de la Demo (ADEX_API_DATABASE_URL,
//     ADEX_DEMO_DATABASE_URL): este proceso no puede llegar a los datos de las empresas.
//   · La base debe confirmar que la sesión es el rol `adex_control` (sin USAGE sobre `adex`).
//   · Solo monta /control/v1/*, /healthz y /readyz: ni /v1/* ni /demo/v1/*.

import pg from '../db/pgTypes.ts';
import { createTokenVerifier } from '../auth/jwt.ts';
import { createSupabaseProvider } from '../auth/provider.ts';
import { createControlHandler } from '../http/controlApi.ts';
import { CONTROL_FEATURES, createOnlineServer } from './app.ts';
import { logError, readCommonConfig } from './start.ts';

export function readControlConfig(env: NodeJS.ProcessEnv) {
  for (const k of ['ADEX_API_DATABASE_URL', 'ADEX_DEMO_DATABASE_URL']) {
    if (env[k]?.trim()) throw new Error(`${k} must not be configured in the Owner service`);
  }
  const controlUrl = env['ADEX_CONTROL_DATABASE_URL']?.trim();
  if (!controlUrl) throw new Error('missing environment variable ADEX_CONTROL_DATABASE_URL');
  return { ...readCommonConfig(env), controlUrl };
}

/** La sesión de base de datos debe ser `adex_control` y no poder usar el esquema de las empresas. */
export async function assertControlRole(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ u: string; adex: boolean }>(`select current_user u, has_schema_privilege('adex', 'USAGE') adex`);
  if (r.rows[0]?.u !== 'adex_control') throw new Error('the Owner service must connect as adex_control');
  if (r.rows[0]?.adex) throw new Error('adex_control must not have USAGE on schema adex');
}

export async function startControl(env: NodeJS.ProcessEnv = process.env) {
  const cfg = readControlConfig(env);
  const pool = new pg.Pool({ connectionString: cfg.controlUrl, ssl: cfg.ssl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', logError);
  await assertControlRole(pool);
  const verifyToken = createTokenVerifier({ issuer: `${cfg.supabaseUrl}/auth/v1` });
  const provider = createSupabaseProvider({ url: cfg.supabaseUrl, publishableKey: cfg.publishableKey, secretKey: cfg.secretKey });
  const server = createOnlineServer({
    company: null, demo: null, control: createControlHandler({ pool, verifyToken, provider, onError: logError }), features: CONTROL_FEATURES,
    readinessPool: pool, allowedOrigins: cfg.origins, trustProxy: cfg.trustProxy, rateLimit: { perIpPerMinute: 120, perTokenPerMinute: 120 },
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve) => server.listen(cfg.port, '0.0.0.0', () => resolve()));
  process.stdout.write(`${JSON.stringify({ level: 'info', t: new Date().toISOString(), msg: 'adex-owner listening', port: cfg.port, origins: cfg.origins.length })}\n`);
  const stop = () => {
    server.close(() => { void pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
