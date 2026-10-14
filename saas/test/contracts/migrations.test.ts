// PUERTA DE LA FASE 0: «esquema reproducible desde Git» y «datos sintéticos
// deterministas». Una base vacía + las migraciones versionadas = el mismo esquema,
// siempre; las semillas producen exactamente los mismos datos; un archivo ya
// aplicado no puede cambiar en silencio.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from '../../src/db/pgTypes.ts';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../../src/db/migrate.ts';
import { importSnapshot } from '../../src/model/adapter.ts';
import { syntheticDataset } from '../../db/seeds/synthetic.ts';

const port = process.env['ADEX_PG_PORT'];
const adminPass = process.env['ADEX_PG_ADMIN_PASS'] ?? '';
const passwords = { api: process.env['ADEX_PG_API_PASS'] ?? '', control: process.env['ADEX_PG_CONTROL_PASS'] ?? '' };
const url = (db: string) => `postgres://postgres:${encodeURIComponent(adminPass)}@127.0.0.1:${port}/${db}`;

async function freshDb(): Promise<{ name: string; client: pg.Client }> {
  const name = `t_mig_${randomBytes(3).toString('hex')}`;
  const boot = new pg.Client({ connectionString: url('postgres') });
  await boot.connect();
  await boot.query(`create database ${name}`);
  await boot.end();
  const client = new pg.Client({ connectionString: url(name) });
  await client.connect();
  return { name, client };
}

/** Huella del esquema: columnas, restricciones, índices, políticas, disparadores, funciones y privilegios. */
async function schemaFingerprint(c: pg.Client): Promise<string> {
  const parts = await Promise.all([
    c.query(`select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
              where table_schema in ('adex', 'adex_control') order by 1, 2, 3`),
    c.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint
              where connamespace in ('adex'::regnamespace, 'adex_control'::regnamespace) order by 1, 2`),
    c.query(`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ('adex', 'adex_control') order by 1, 2, 3`),
    c.query(`select schemaname, tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
              where schemaname in ('adex', 'adex_control') order by 1, 2, 3`),
    c.query(`select tgrelid::regclass::text t, tgname, pg_get_triggerdef(oid) d from pg_trigger
              where not tgisinternal and tgrelid::regclass::text ~ '^adex' order by 1, 2`),
    c.query(`select n.nspname, p.proname, pg_get_functiondef(p.oid) d, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('adex', 'adex_control') order by 1, 2, 3`),
    c.query(`select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants
              where table_schema in ('adex', 'adex_control') order by 1, 2, 3, 4`),
    c.query(`select version, name, checksum from adex_meta.schema_migrations order by 1`),
  ]);
  return createHash('sha256').update(JSON.stringify(parts.map((p) => p.rows))).digest('hex');
}

async function dataFingerprint(c: pg.Client): Promise<string> {
  const tables = (await c.query<{ t: string }>(
    `select schemaname || '.' || tablename t from pg_tables where schemaname in ('adex', 'adex_control') order by 1`)).rows;
  const h = createHash('sha256');
  for (const { t } of tables) {
    const rows = await c.query(`select row_to_json(x)::text j from ${t} x order by 1`);
    h.update(t).update(JSON.stringify(rows.rows));
  }
  return h.digest('hex');
}

describe('Fase 0 · migraciones reproducibles y semillas deterministas', () => {
  let a: { name: string; client: pg.Client };
  let b: { name: string; client: pg.Client };
  before(async () => { a = await freshDb(); b = await freshDb(); });
  after(async () => { await a.client.end(); await b.client.end(); });

  test('MIG-001 · base vacía → migraciones aplicadas en orden; repetir no aplica nada', async () => {
    const first = await migrate(a.client, passwords);
    assert.deepEqual(first.applied, readMigrations().map((m) => m.name));
    const second = await migrate(a.client, passwords);
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, first.applied.length);
  });

  test('MIG-002 · dos bases construidas desde Git tienen exactamente el mismo esquema', async () => {
    await migrate(b.client, passwords);
    assert.equal(await schemaFingerprint(a.client), await schemaFingerprint(b.client));
  });

  test('MIG-003 · un archivo ya aplicado que cambia detiene el proceso (historial inmutable)', async () => {
    const files = readMigrations();
    files[1] = { ...files[1]!, checksum: createHash('sha256').update(files[1]!.sql + '\n-- cambio').digest('hex') };
    await assert.rejects(migrate(a.client, passwords, files), /checksum mismatch/);
  });

  test('MIG-004 · las semillas sintéticas producen datos idénticos en cada reconstrucción', async () => {
    for (const x of [a, b]) {
      const { snapshot, options } = syntheticDataset();
      await importSnapshot(x.client, snapshot, options);
    }
    const fa = await dataFingerprint(a.client);
    assert.equal(fa, await dataFingerprint(b.client));
    assert.ok((await a.client.query('select count(*)::int n from adex.payments')).rows[0].n > 0);
  });

  test('MIG-005 · ni migraciones ni semillas contienen datos reales ni secretos', () => {
    const { snapshot } = syntheticDataset();
    const emails = JSON.stringify(snapshot).match(/[\w.+-]+@[\w.-]+/g) ?? [];
    assert.ok(emails.length > 10);
    for (const e of emails) assert.match(e, /@example\.test$/, `non-synthetic email ${e}`);
    for (const m of readMigrations()) {
      assert.doesNotMatch(m.sql, /password\s+'[^']+'/i, `${m.name} embeds a password`);
      assert.doesNotMatch(m.sql, /@(?!example\.test)[a-z0-9-]+\.[a-z]{2,}/i, `${m.name} embeds an address`);
    }
    assert.ok(readFileSync(path.join(MIGRATIONS_DIR, '0001_core_tenancy.sql'), 'utf8').length > 0);
  });
});
