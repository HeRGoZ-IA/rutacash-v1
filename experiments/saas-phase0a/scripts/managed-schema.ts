// Preparación del esquema `adex` en un PostgreSQL gestionado, conectado como el
// administrador del proyecto (en Supabase, `postgres`: no superusuario). La usan
// run-managed.ts (proyecto real) y rehearse-managed.ts (ensayo local del arnés).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SCHEMA_MARK = 'ADEX-SaaS-POC-0A1 · esquema experimental · datos sinteticos';

/** Marca del esquema `adex` existente: null si no existe. */
export async function schemaMark(admin: pg.Client): Promise<string | null | undefined> {
  const r = (await admin.query(`select obj_description(oid, 'pg_namespace') c from pg_namespace where nspname = 'adex'`)).rows[0] as { c: string | null } | undefined;
  return r ? r.c : undefined;
}

/**
 * Rehace el esquema (solo si no existe o lleva la marca de esta POC) y fija una
 * contraseña NUEVA para adex_api. `apiPassword` debe ser base64url (ALTER ROLE no admite parámetros).
 */
export async function prepareSchema(admin: pg.Client, apiPassword: string): Promise<void> {
  if (!/^[\w-]{24,}$/.test(apiPassword)) throw new Error('apiPassword must be base64url');
  const mark = await schemaMark(admin);
  if (mark !== undefined && mark !== SCHEMA_MARK) throw new Error('schema adex exists and is not owned by this POC');
  if (mark !== undefined) await admin.query('drop schema adex cascade');
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'adex_owner') then
      create role adex_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'adex_api') then
      create role adex_api login nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
    end if;
  end $$`);
  // Sin superusuario, ALTER ROLE no puede ni mencionar SUPERUSER/BYPASSRLS (PostgreSQL 16+): los atributos se
  // fijan en CREATE ROLE y se comprueban después (MANAGED-ROLE-001). Aquí solo login, límite y contraseña nueva.
  await admin.query(`alter role adex_api with login connection limit 20 password '${apiPassword}'`);
  const attrs = (await admin.query(`select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = 'adex_api'`)).rows[0];
  if (attrs.rolsuper || attrs.rolbypassrls || attrs.rolinherit) throw new Error('adex_api exists with privileged attributes');
  await admin.query('grant adex_owner to current_user');
  await admin.query('create schema adex authorization adex_owner');
  await admin.query(`comment on schema adex is '${SCHEMA_MARK}'`);
  await admin.query('set role adex_owner');
  try {
    for (const file of readdirSync(path.join(root, 'sql')).filter((f) => f.endsWith('.sql')).sort()) {
      // El esquema ya lo creó el administrador con el propietario correcto.
      await admin.query(readFileSync(path.join(root, 'sql', file), 'utf8').replace(/^create schema adex;$/m, ''));
    }
  } finally {
    await admin.query('reset role');
  }
  // Con FORCE RLS ni el propietario escribe el catálogo; el administrador lo siembra si tiene BYPASSRLS.
  await admin.query(`insert into adex.currencies (code, minor_units) values ('BRL', 2), ('COP', 2)`);
}

export async function dropSchema(admin: pg.Client): Promise<void> {
  const mark = await schemaMark(admin);
  if (mark !== undefined && mark !== SCHEMA_MARK) throw new Error('schema adex exists and is not owned by this POC');
  if (mark !== undefined) await admin.query('drop schema adex cascade');
  for (const role of ['adex_api', 'adex_owner']) {
    if (!(await admin.query('select 1 from pg_roles where rolname = $1', [role])).rowCount) continue;
    if (role === 'adex_owner') await admin.query('revoke adex_owner from current_user');
    await admin.query(`drop role ${role}`);
  }
}
