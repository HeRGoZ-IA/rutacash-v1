// Migraciones versionadas y reproducibles (criterio de cierre de la Fase 0).
//
// Se ejecutan conectados como el ADMINISTRADOR del proyecto (en Supabase, `postgres`:
// sin superusuario, con CREATEROLE y BYPASSRLS; en local, el mismo papel imitado).
//   1. Roles: `adex_owner` (sin login, dueño de los esquemas), `adex_api` (API de
//      empresa) y `adex_control` (API del plano Owner). Ninguno es superusuario ni
//      BYPASSRLS. Los atributos solo se fijan en CREATE ROLE: en PostgreSQL 16+ un
//      administrador sin superusuario no puede ni mencionarlos en ALTER ROLE (0A.1).
//   2. Esquemas `adex` y `adex_control` con `authorization adex_owner`.
//   3. Cada archivo de `db/migrations` en SU transacción con `set local role
//      adex_owner`, registrado en `adex_meta.schema_migrations` con su SHA-256. Un
//      archivo ya aplicado cuyo contenido cambie detiene el proceso: el historial es
//      inmutable y se corrige con una migración nueva.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(dir, f), 'utf8');
      return { version: f.slice(0, 4), name: f, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface RolePasswords {
  /** base64url (ALTER ROLE no admite parámetros). */
  api: string;
  control: string;
}

const PASSWORD_RE = /^[\w-]{24,}$/;

const ROLES = [
  { name: 'adex_owner', create: 'create role adex_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit' },
  { name: 'adex_api', create: 'create role adex_api login nosuperuser nobypassrls nocreatedb nocreaterole noinherit' },
  { name: 'adex_control', create: 'create role adex_control login nosuperuser nobypassrls nocreatedb nocreaterole noinherit' },
] as const;

export async function ensureRoles(admin: pg.Client, passwords: RolePasswords): Promise<void> {
  for (const p of [passwords.api, passwords.control]) {
    if (!PASSWORD_RE.test(p)) throw new Error('role passwords must be base64url, ≥ 24 chars');
  }
  for (const r of ROLES) {
    const exists = (await admin.query('select 1 from pg_roles where rolname = $1', [r.name])).rowCount;
    if (!exists) await admin.query(r.create);
  }
  await admin.query(`alter role adex_api with login connection limit 40 password '${passwords.api}'`);
  await admin.query(`alter role adex_control with login connection limit 10 password '${passwords.control}'`);
  const bad = await admin.query<{ rolname: string }>(
    `select rolname from pg_roles
      where rolname in ('adex_owner', 'adex_api', 'adex_control')
        and (rolsuper or rolbypassrls or rolinherit or rolcreaterole or rolcreatedb)`,
  );
  if (bad.rowCount) throw new Error(`roles with privileged attributes: ${bad.rows.map((r) => r.rolname).join(', ')}`);
  // Ningún rol de aplicación pertenece a otro (sin herencia de privilegios).
  const memberOf = await admin.query(
    `select r.rolname from pg_auth_members am join pg_roles r on r.oid = am.member
      where r.rolname in ('adex_api', 'adex_control')`,
  );
  if (memberOf.rowCount) throw new Error('application roles must not be members of other roles');
  await admin.query('grant adex_owner to current_user');
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(admin: pg.Client, passwords: RolePasswords, files = readMigrations()): Promise<MigrationResult> {
  await ensureRoles(admin, passwords);
  await admin.query('create schema if not exists adex_meta');
  await admin.query('revoke all on schema adex_meta from public');
  await admin.query(`create table if not exists adex_meta.schema_migrations (
    version    char(4) primary key,
    name       text not null,
    checksum   char(64) not null,
    applied_at timestamptz not null default now())`);
  for (const schema of ['adex', 'adex_control']) {
    const exists = (await admin.query('select 1 from pg_namespace where nspname = $1', [schema])).rowCount;
    if (!exists) await admin.query(`create schema ${schema} authorization adex_owner`);
  }

  const done = new Map(
    (await admin.query<{ version: string; checksum: string }>('select version, checksum from adex_meta.schema_migrations')).rows
      .map((r) => [r.version, r.checksum]),
  );
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const m of files) {
    const prev = done.get(m.version);
    if (prev) {
      if (prev !== m.checksum) throw new Error(`migration ${m.name} changed after being applied (checksum mismatch)`);
      result.skipped.push(m.name);
      continue;
    }
    await admin.query('begin');
    try {
      await admin.query('set local role adex_owner');
      await admin.query(m.sql);
      await admin.query('reset role');
      await admin.query('insert into adex_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)', [m.version, m.name, m.checksum]);
      await admin.query('commit');
    } catch (err) {
      await admin.query('rollback').catch(() => undefined);
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
    result.applied.push(m.name);
  }
  return result;
}
