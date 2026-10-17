// Cada archivo de prueba trabaja en su PROPIA base (copia de `adex_template`, ya
// migrada) dentro del PostgreSQL real que levanta scripts/run-db-tests.ts.
//   admin   → `postgres` estilo Supabase (sin superusuario, BYPASSRLS): SOLO siembra y verifica.
//   api     → `adex_api` (sujeto a RLS): el que usa la API de empresa.
//   control → `adex_control`: el que usa la API del plano Owner.
//   demo    → `adex_demo`: administración de la Empresa Demo (ADEX Online).

import { randomBytes } from 'node:crypto';
import pg from '../../src/db/pgTypes.ts';
import { importSnapshot } from '../../src/model/adapter.ts';
import { syntheticDataset } from '../../db/seeds/synthetic.ts';

export interface TestDb {
  name: string;
  admin: pg.Pool;
  api: pg.Pool;
  control: pg.Pool;
  demo: pg.Pool;
  url(role: 'postgres' | 'adex_api' | 'adex_control' | 'adex_demo'): string;
  close(): Promise<void>;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing: run with "npm run test:db" (real PostgreSQL required)`);
  return v;
}

export function pgAvailable(): boolean {
  return Boolean(process.env['ADEX_PG_PORT']);
}

export async function createTestDb(label: string, opts: { seed?: boolean } = {}): Promise<TestDb> {
  const port = required('ADEX_PG_PORT');
  const pass = { postgres: required('ADEX_PG_ADMIN_PASS'), adex_api: required('ADEX_PG_API_PASS'), adex_control: required('ADEX_PG_CONTROL_PASS'), adex_demo: required('ADEX_PG_DEMO_PASS') };
  const name = `t_${label}_${randomBytes(3).toString('hex')}`.toLowerCase();
  const url = (role: keyof typeof pass, db = name) => `postgres://${role}:${encodeURIComponent(pass[role])}@127.0.0.1:${port}/${db}`;
  const boot = new pg.Client({ connectionString: url('postgres', 'postgres') });
  await boot.connect();
  await boot.query(`create database ${name} template adex_template`);
  await boot.end();
  const admin = new pg.Pool({ connectionString: url('postgres'), max: 5, allowExitOnIdle: true });
  const api = new pg.Pool({ connectionString: url('adex_api'), max: 25, allowExitOnIdle: true });
  const control = new pg.Pool({ connectionString: url('adex_control'), max: 5, allowExitOnIdle: true });
  const demo = new pg.Pool({ connectionString: url('adex_demo'), max: 4, allowExitOnIdle: true });
  if (opts.seed) {
    const c = await admin.connect();
    try {
      const { snapshot, options } = syntheticDataset();
      await importSnapshot(c, snapshot, options);
    } finally {
      c.release();
    }
  }
  return {
    name, admin, api, control, demo,
    url: (role) => url(role),
    async close() {
      await Promise.all([api.end(), control.end(), demo.end(), admin.end()]);
    },
  };
}

export interface DbContext {
  identityId?: string;
  membershipId?: string;
  companyId?: string;
  /** Sesión del token (Fase 1). Por defecto, una sesión fija por identidad. */
  sessionId?: string | null;
  /** `iat` del token en segundos. Por defecto, ahora. */
  iat?: number | null;
}

/** Ejecuta `fn` como `adex_api` con el contexto RLS fijado SOLO para esa transacción. */
export async function asApi<T>(
  pool: pg.Pool,
  ctx: DbContext,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const session = ctx.sessionId === undefined ? (ctx.identityId ? defaultSession(ctx.identityId) : '') : (ctx.sessionId ?? '');
    const iat = ctx.iat === undefined ? Math.floor(Date.now() / 1000) : ctx.iat;
    await c.query(
      `select set_config('adex.identity_id', $1, true), set_config('adex.membership_id', $2, true), set_config('adex.company_id', $3, true),
              set_config('adex.session_id', $4, true), set_config('adex.token_iat', $5, true)`,
      [ctx.identityId ?? '', ctx.membershipId ?? '', ctx.companyId ?? '', session, iat === null ? '' : String(iat)],
    );
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Sesión determinista por identidad (formato UUID). */
export function defaultSession(identityId: string): string {
  return `${identityId.slice(0, 24)}5e55${identityId.slice(28)}`;
}

export async function count(q: pg.ClientBase | pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await q.query<{ n: string }>(`select count(*)::text as n from (${sql}) q`, params);
  return Number(r.rows[0]!.n);
}
