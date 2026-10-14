// Local (scripts/run-integration.ts): cada archivo trabaja en su PROPIA base
// (copia de adex_template) dentro de un PostgreSQL real efímero.
//
// Gestionado (scripts/run-managed.ts, ADEX_PG_MODE=managed): una sola base, la
// del proyecto Supabase experimental. Las pruebas que la usan crean sus propios
// datos con identificadores aleatorios y no dependen de una base vacía.

import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestDb {
  name: string;
  /**
   * Local: superusuario. Gestionado: rol `postgres` de Supabase (no superusuario;
   * BYPASSRLS según el proveedor). SOLO para sembrar y verificar. Nunca lo usa la API.
   */
  superPool: pg.Pool;
  /** Rol de la API: sujeto a RLS. */
  apiPool: pg.Pool;
  apiUrl: string;
  close(): Promise<void>;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing: run integration tests with "npm run test:integration" (real PostgreSQL required)`);
  return v;
}

export function pgAvailable(): boolean {
  return Boolean(process.env['ADEX_PG_SUPER_URL']) || managedMode();
}

export function managedMode(): boolean {
  return process.env['ADEX_PG_MODE'] === 'managed';
}

// En el pooler en modo transacción cada consulta puede ir a otro backend: las
// pruebas no deben depender de estado de sesión fuera de una transacción.
/**
 * TLS hacia Supabase. Con ADEX_PG_SSL_CA (certificado raíz que publica el panel
 * del proyecto) se verifica el servidor; sin él, la conexión va cifrada pero sin
 * verificar el certificado (limitación registrada en la evidencia).
 */
export function managedSsl(): pg.ConnectionConfig['ssl'] {
  if (process.env['ADEX_PG_SSL'] === 'disable') return false; // solo el ensayo local (rehearse-managed.ts)
  const ca = process.env['ADEX_PG_SSL_CA_PEM'];
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

function managedDb(): TestDb {
  const apiUrl = required('ADEX_PG_API_URL');
  const ssl = managedSsl();
  const superPool = new pg.Pool({ connectionString: required('ADEX_PG_ADMIN_URL'), ssl, max: 3, allowExitOnIdle: true });
  const apiPool = new pg.Pool({ connectionString: apiUrl, ssl, max: 12, allowExitOnIdle: true });
  return {
    name: 'postgres',
    superPool,
    apiPool,
    apiUrl,
    async close() {
      await apiPool.end();
      await superPool.end();
    },
  };
}

export async function createTestDb(label: string): Promise<TestDb> {
  if (managedMode()) return managedDb();
  const port = required('ADEX_PG_PORT');
  const superPass = required('ADEX_PG_SUPER_PASS');
  const apiPass = required('ADEX_PG_API_PASS');
  const name = `t_${label}_${randomBytes(3).toString('hex')}`.toLowerCase();

  const admin = new pg.Client({ connectionString: required('ADEX_PG_SUPER_URL') });
  await admin.connect();
  await admin.query(`create database ${name} template adex_template owner adex_owner`);
  await admin.end();

  const u = (user: string, pass: string) => `postgres://${user}:${encodeURIComponent(pass)}@127.0.0.1:${port}/${name}`;
  const superPool = new pg.Pool({ connectionString: u('postgres', superPass), max: 5, allowExitOnIdle: true });
  const apiUrl = u('adex_api', apiPass);
  const apiPool = new pg.Pool({ connectionString: apiUrl, max: 25, allowExitOnIdle: true });
  return {
    name,
    superPool,
    apiPool,
    apiUrl,
    async close() {
      await apiPool.end();
      await superPool.end();
    },
  };
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query<{ n: string }>(`select count(*)::text as n from (${sql}) q`, params);
  return Number((r.rows[0] as { n: string }).n);
}

export async function balanceOf(pool: pg.Pool, accountId: string): Promise<bigint> {
  const r = await pool.query<{ b: string }>('select balance_minor::text as b from adex.accounts where id = $1', [accountId]);
  return BigInt((r.rows[0] as { b: string }).b);
}
