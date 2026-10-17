// Pruebas con PostgreSQL REAL: levanta el clúster local (roles estilo Supabase),
// crea `adex_template` aplicando las migraciones versionadas con el administrador
// sin superusuario, y ejecuta test/contracts + test/integration (+ test/auth-real,
// que queda SKIPPED sin staging). Cada archivo trabaja en su propia copia.
//
// Evidencia completa en RutaCash/tmp/saas-phase01/evidence/.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/db/migrate.ts';
import { startLocalCluster, tmpRoot } from './local-cluster.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(tmpRoot, 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const started = Date.now();
const cluster = await startLocalCluster('tests');
let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void cluster.stop().finally(() => process.exit(130)); });
}
try {
  const admin = new pg.Client({ connectionString: cluster.adminUrl() });
  await admin.connect();
  await admin.query('create database adex_template');
  await admin.end();
  const tpl = new pg.Client({ connectionString: cluster.adminUrl('adex_template') });
  await tpl.connect();
  const result = await migrate(tpl, { api: cluster.passwords.api, control: cluster.passwords.control, demo: cluster.passwords.demo });
  await tpl.end();

  const env = {
    ...process.env,
    ADEX_PG_PORT: String(cluster.port),
    ADEX_PG_ADMIN_PASS: cluster.passwords.admin,
    ADEX_PG_API_PASS: cluster.passwords.api,
    ADEX_PG_CONTROL_PASS: cluster.passwords.control,
    ADEX_PG_DEMO_PASS: cluster.passwords.demo,
    ADEX_PG_VERSION: cluster.version,
  };
  const logPath = path.join(evidenceDir, `db-tests-${stamp}.log`);
  const log = createWriteStream(logPath);
  const header = `# ADEX SaaS · pruebas con PostgreSQL real\n# ${cluster.version}\n# migraciones: ${result.applied.join(', ')}\n# inicio ${new Date().toISOString()}\n`;
  process.stdout.write(header);
  log.write(header);

  const files = ['contracts', 'integration', 'auth-real'].flatMap((dir) =>
    readdirSync(path.join(root, 'test', dir)).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('test', dir, f)));
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith('-'));
  const extra = args.filter((a) => a.startsWith('-'));
  const selected = only.length ? files.filter((f) => only.some((o) => path.basename(f).startsWith(o))) : files;
  exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', '--test', '--test-reporter=spec',
      '--test-concurrency=1', '--test-timeout=120000', ...extra, ...selected], { cwd: root, env });
    child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const footer = `# fin ${new Date().toISOString()} · ${(Date.now() - started) / 1000}s · exit ${exitCode}\n# evidencia: ${logPath}\n`;
  process.stdout.write(footer);
  log.end(footer);
} finally {
  await cluster.stop();
}
process.exit(exitCode);
