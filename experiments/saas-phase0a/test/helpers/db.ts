// Cada archivo de integración trabaja en su PROPIA base (copia de adex_template)
// dentro del PostgreSQL real levantado por scripts/run-integration.ts.

import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestDb {
  name: string;
  /** Superusuario: SOLO para sembrar y verificar. Ignora RLS. Nunca lo usa la API. */
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
  return Boolean(process.env['ADEX_PG_SUPER_URL']);
}

export async function createTestDb(label: string): Promise<TestDb> {
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
