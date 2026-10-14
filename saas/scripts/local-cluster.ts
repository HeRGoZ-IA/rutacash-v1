// PostgreSQL 17 REAL y efímero (binarios de `embedded-postgres`) que IMITA los roles
// de un proyecto Supabase: `postgres` sin superusuario (CREATEROLE, CREATEDB,
// BYPASSRLS) y los roles de la Data API `anon`, `authenticated`, `service_role` y
// `authenticator`. Así las migraciones y las pruebas se ejercitan con los mismos
// privilegios que tendrá ADEX-Staging. NO es Supabase: sin Supavisor, PostgREST ni Auth.
//
// Datos en RutaCash/tmp/saas-phase01/ (se borran al parar). Contraseñas aleatorias
// por ejecución: no hay secretos en el repositorio.

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const tmpRoot = path.join(repoRoot, 'tmp', 'saas-phase01');

export interface LocalCluster {
  port: number;
  version: string;
  /** Administrador estilo Supabase (`postgres`, sin superusuario). */
  adminUrl(db?: string): string;
  /** Superusuario de arranque (solo para crear bases de prueba). */
  bootUrl(db?: string): string;
  passwords: { admin: string; api: string; control: string };
  roleUrl(role: 'adex_api' | 'adex_control', db?: string): string;
  stop(): Promise<void>;
}

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

export const randomSecret = () => randomBytes(18).toString('base64url');

export async function startLocalCluster(label: string): Promise<LocalCluster> {
  mkdirSync(tmpRoot, { recursive: true });
  const dataDir = path.join(tmpRoot, `pgdata-${label}-${Date.now()}`);
  const port = await freePort();
  const boot = randomSecret();
  const passwords = { admin: randomSecret(), api: randomSecret(), control: randomSecret() };
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'supabase_admin',
    password: boot,
    port,
    persistent: false,
    // Como Supabase: UTF-8 (en Windows initdb tomaría WIN1252).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=80', '-c', 'deadlock_timeout=200ms'],
    onLog: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg]', String(m).trim()); },
    onError: (m: unknown) => { if (process.env['ADEX_PG_DEBUG']) console.error('[pg!]', String(m).trim()); },
  });
  const url = (user: string, pass: string, db = 'postgres') => `postgres://${user}:${encodeURIComponent(pass)}@127.0.0.1:${port}/${db}`;
  const stop = async () => {
    await cluster.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await cluster.initialise();
    await cluster.start();
    const c = new pg.Client({ connectionString: url('supabase_admin', boot) });
    await c.connect();
    const version = (await c.query('select version()')).rows[0].version as string;
    await c.query(`create role postgres login nosuperuser createrole createdb bypassrls password '${passwords.admin}'`);
    await c.query('grant create on database postgres to postgres');
    await c.query('create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls');
    await c.query(`create role authenticator login noinherit password '${randomSecret()}'; grant anon, authenticated, service_role to authenticator`);
    await c.query('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role');
    await c.end();
    return {
      port,
      version,
      passwords,
      adminUrl: (db) => url('postgres', passwords.admin, db),
      bootUrl: (db) => url('supabase_admin', boot, db),
      roleUrl: (role, db) => url(role, role === 'adex_api' ? passwords.api : passwords.control, db),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
