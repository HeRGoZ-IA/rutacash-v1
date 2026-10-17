// Reconstrucción completa DESDE GIT: PostgreSQL vacío → migraciones versionadas →
// semillas sintéticas deterministas → recuento por tabla y huella de los datos.
// Ejecutarlo dos veces debe imprimir la MISMA huella. No deja nada encendido.
//
//   npm run db:rebuild

import { createHash } from 'node:crypto';
import pg from '../src/db/pgTypes.ts';
import { migrate } from '../src/db/migrate.ts';
import { importSnapshot } from '../src/model/adapter.ts';
import { syntheticDataset } from '../db/seeds/synthetic.ts';
import { startLocalCluster } from './local-cluster.ts';

const cluster = await startLocalCluster('rebuild');
let code = 1;
try {
  const boot = new pg.Client({ connectionString: cluster.adminUrl() });
  await boot.connect();
  await boot.query('create database adex_staging_local');
  await boot.end();
  const c = new pg.Client({ connectionString: cluster.adminUrl('adex_staging_local') });
  await c.connect();
  const m = await migrate(c, { api: cluster.passwords.api, control: cluster.passwords.control, demo: cluster.passwords.demo });
  const { snapshot, options } = syntheticDataset();
  await importSnapshot(c, snapshot, options);
  console.log(`# ${cluster.version}`);
  console.log(`# migraciones aplicadas: ${m.applied.join(', ')}`);
  const tables = (await c.query<{ t: string }>(
    `select schemaname || '.' || tablename t from pg_tables where schemaname in ('adex', 'adex_control') order by 1`)).rows;
  const h = createHash('sha256');
  for (const { t } of tables) {
    const rows = await c.query(`select row_to_json(x)::text j from ${t} x order by 1`);
    h.update(t).update(JSON.stringify(rows.rows));
    console.log(`${t.padEnd(42)} ${String(rows.rowCount).padStart(4)}`);
  }
  console.log(`# huella de datos: ${h.digest('hex')}`);
  await c.end();
  code = 0;
} finally {
  await cluster.stop();
}
process.exit(code);
