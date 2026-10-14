// ENSAYO LOCAL del arnés gestionado. NO es evidencia de Supabase.
//
// Levanta un PostgreSQL 17 efímero que imita los roles de un proyecto Supabase
// (`postgres` sin superusuario con CREATEROLE y BYPASSRLS; `anon`,
// `authenticated`, `service_role`, `authenticator`), prepara el esquema con el
// MISMO código que run-managed.ts y ejecuta las pruebas de test/managed y de
// revocación en modo gestionado. Sirve para depurar el arnés antes de gastar
// tiempo del proyecto real. MANAGED-DATAAPI-001 se omite: necesita la Data API.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { prepareSchema } from './managed-schema.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoTmp = path.resolve(root, '..', '..', 'tmp', 'saas-phase0a1');
mkdirSync(repoTmp, { recursive: true });
const dataDir = path.join(repoTmp, `rehearsal-${Date.now()}`);
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const pass = () => randomBytes(18).toString('base64url');
const [bootPass, pgPass, apiPass] = [pass(), pass(), pass()];
const cluster = new EmbeddedPostgres({ databaseDir: dataDir, user: 'supabase_admin', password: bootPass, port, persistent: false,
  postgresFlags: ['-c', 'max_connections=60'], onLog: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg]', String(m).trim()); }, onError: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg!]', String(m).trim()); } });
const url = (u: string, p: string) => `postgres://${u}:${encodeURIComponent(p)}@127.0.0.1:${port}/postgres`;
let code = 1;
try {
  await cluster.initialise();
  await cluster.start();
  const boot = new pg.Client({ connectionString: url('supabase_admin', bootPass) });
  await boot.connect();
  await boot.query(`create role postgres login nosuperuser createrole createdb bypassrls password '${pgPass}'`);
  await boot.query('grant create on database postgres to postgres');
  await boot.query('create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls');
  await boot.query(`create role authenticator login noinherit password '${pass()}'; grant anon, authenticated, service_role to authenticator`);
  await boot.query('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role');
  await boot.end();

  const admin = new pg.Client({ connectionString: url('postgres', pgPass) });
  admin.on('error', () => undefined);
  await admin.connect();
  try { await prepareSchema(admin, apiPass); } finally { await admin.end(); }

  const env = {
    ...process.env,
    ADEX_PG_MODE: 'managed',
    ADEX_PG_SSL: 'disable',
    ADEX_PG_ADMIN_URL: url('postgres', pgPass),
    ADEX_PG_API_URL: url('adex_api', apiPass),
    ADEX_PG_API_SESSION_URL: url('adex_api', apiPass),
    ADEX_PG_DIRECT_API_URL: url('adex_api', apiPass),
  };
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete (env as Record<string, string | undefined>)[k];
  process.stdout.write('# ENSAYO LOCAL (no es evidencia de Supabase)\n');
  code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', '--test-timeout=60000', '--test-skip-pattern=DATAAPI',
      path.join('test', 'managed', 'managed.test.ts'), path.join('test', 'integration', 'revocation.test.ts')], { cwd: root, env, stdio: 'inherit' });
    child.on('close', (c) => resolve(c ?? 1));
  });
} finally {
  await cluster.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code);
