// Levanta un PostgreSQL 17 REAL y efímero (binarios oficiales empaquetados por
// `embedded-postgres`, sin instalación global ni servicio de Windows), aplica el
// esquema con el rol propietario y ejecuta las pruebas de integración.
//
// - Datos del clúster en RutaCash/tmp/saas-phase0a/ (se borran al terminar).
// - Contraseñas aleatorias por ejecución: no hay secretos en el repositorio.
// - Evidencia (salida completa) en RutaCash/tmp/saas-phase0a/evidence/.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repoTmp = path.resolve(root, '..', '..', 'tmp', 'saas-phase0a');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(repoTmp, `pgdata-${stamp}`);
const evidenceDir = path.join(repoTmp, 'evidence');
mkdirSync(evidenceDir, { recursive: true });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const secret = () => randomBytes(18).toString('base64url');
const port = await freePort();
const superPass = secret();
const ownerPass = secret();
const apiPass = secret();

const cluster = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: superPass,
  port,
  persistent: false,
  // Varias conexiones simultáneas reales; deadlock_timeout corto para la prueba de interbloqueo.
  postgresFlags: ['-c', 'max_connections=60', '-c', 'deadlock_timeout=200ms'],
  onLog: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg]', String(m).trim()); },
  onError: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg!]', String(m).trim()); },
});

const url = (user: string, pass: string, db: string) => `postgres://${user}:${encodeURIComponent(pass)}@127.0.0.1:${port}/${db}`;
let exitCode = 1;
// Si el proceso se interrumpe, no dejar un PostgreSQL huérfano.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void cluster.stop().catch(() => undefined).finally(() => { rmSync(dataDir, { recursive: true, force: true }); process.exit(130); }); });
}
const started = Date.now();

try {
  await cluster.initialise();
  await cluster.start();

  const admin = new pg.Client({ connectionString: url('postgres', superPass, 'postgres') });
  await admin.connect();
  const version = (await admin.query('select version()')).rows[0].version as string;
  // Roles: propietario del esquema y rol de la API. Ninguno es superusuario ni BYPASSRLS.
  await admin.query(`create role adex_owner login nosuperuser nobypassrls nocreatedb nocreaterole password '${ownerPass}'`);
  await admin.query(`create role adex_api   login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password '${apiPass}'`);
  await admin.query('create database adex_template owner adex_owner');
  await admin.end();

  const tpl = new pg.Client({ connectionString: url('adex_owner', ownerPass, 'adex_template') });
  await tpl.connect();
  for (const file of readdirSync(path.join(root, 'sql')).filter((f) => f.endsWith('.sql')).sort()) {
    await tpl.query(readFileSync(path.join(root, 'sql', file), 'utf8'));
  }
  await tpl.end();

  // Catálogo de referencia: lo siembra el superusuario (FORCE RLS impide escribir incluso al propietario).
  const seedTpl = new pg.Client({ connectionString: url('postgres', superPass, 'adex_template') });
  await seedTpl.connect();
  await seedTpl.query(`insert into adex.currencies (code, minor_units) values ('BRL', 2), ('COP', 2)`);
  await seedTpl.end();

  const env = {
    ...process.env,
    ADEX_PG_PORT: String(port),
    ADEX_PG_SUPER_URL: url('postgres', superPass, 'postgres'),
    ADEX_PG_SUPER_PASS: superPass,
    ADEX_PG_API_PASS: apiPass,
    ADEX_PG_OWNER_PASS: ownerPass,
    ADEX_PG_VERSION: version,
  };

  const logPath = path.join(evidenceDir, `integration-${stamp}.log`);
  const log = createWriteStream(logPath);
  const header = `# ADEX Fase 0A · integración\n# ${version}\n# inicio ${new Date().toISOString()}\n`;
  process.stdout.write(header);
  log.write(header);

  // Las pruebas reales de Supabase Auth se incluyen: sin credenciales quedan SKIPPED (NO EJECUTADAS).
  const files = ['integration', 'auth-real'].flatMap((dir) =>
    readdirSync(path.join(root, 'test', dir)).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('test', dir, f)));
  // Argumentos: nombres de archivo (p. ej. finance) para ejecutar solo esos; el resto se pasa a node --test.
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith('-'));
  const extra = args.filter((a) => a.startsWith('-'));
  const selected = only.length ? files.filter((f) => only.some((o) => path.basename(f).startsWith(o))) : files;
  exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', '--test-timeout=60000', ...extra, ...selected], { cwd: root, env });
    child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const footer = `# fin ${new Date().toISOString()} · ${(Date.now() - started) / 1000}s · exit ${exitCode}\n# evidencia: ${logPath}\n`;
  process.stdout.write(footer);
  log.end(footer);
} finally {
  await cluster.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
