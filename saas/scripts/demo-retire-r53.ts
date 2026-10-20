// Retirada DEFINITIVA de la Empresa Demo Online (Ronda 53, autorizada por el propietario el
// 2026-10-20: «eliminar la empresa DEMO Online actual, sus datos sintéticos y su acceso
// público»). Herramienta administrativa de un solo uso sobre ADEX-Staging; NO es una función
// de la aplicación. Basada en demo-purge-retired.ts (Ronda 20), con estas diferencias:
//   · objetivo: TODAS las empresas registradas en `adex_demo.companies` (la vigente y las
//     retiradas o fallidas, todas «Empresa Demo ADEX»); ninguna otra empresa;
//   · el hueco Demo queda vacío (`principal` → empty) y sin participantes: la Demo se puede
//     volver a crear en el futuro con el escenario vigente (sin Socio);
//   · antes de borrar se escribe una COPIA RECUPERABLE (JSON comprimido, fuera del repositorio)
//     de cada fila afectada;
//   · `--auth` (paso aparte, después de confirmar el borrado) retira de Supabase Auth las
//     cuentas de ACCESO PÚBLICO a la Demo (demo.{superadmin,admin,cobrador,supervisor,socio,
//     secretario}@example.test). La cuenta operadora (demo.operador) se conserva: es la que
//     permite recrear la Demo y no da acceso a ninguna empresa.
//
//   node --import ./scripts/register-alias.mjs scripts/demo-retire-r53.ts --expect 8             (ensayo: ROLLBACK)
//   node --import ./scripts/register-alias.mjs scripts/demo-retire-r53.ts --expect 8 --commit
//   node --import ./scripts/register-alias.mjs scripts/demo-retire-r53.ts --auth [--commit]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from '../src/db/pgTypes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'hyqaufsagtsucztjfjvc';
const PUBLIC_DEMO_ACCOUNTS = ['superadmin', 'admin', 'cobrador', 'supervisor', 'socio', 'secretario'].map((r) => `demo.${r}@example.test`);
const fail = (m: string): never => { console.error(`BLOQUEADO: ${m}`); process.exit(2); };

const envFile = path.join(root, '.env.staging');
if (!existsSync(envFile)) fail('falta saas/.env.staging');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1]!, m[2]!.trim()]));
if (env['ADEX_STAGING_PROJECT_REF'] !== STAGING_REF) fail('solo se admite ADEX-Staging');
const commit = process.argv.includes('--commit');

// ---------- Paso 2: cuentas de acceso público en Supabase Auth ----------
if (process.argv.includes('--auth')) {
  const base = env['SUPABASE_URL'] ?? fail('falta SUPABASE_URL');
  const key = env['SUPABASE_SECRET_KEY'] ?? fail('falta SUPABASE_SECRET_KEY');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const list = await fetch(`${base}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!list.ok) fail(`Auth respondió ${list.status}`);
  const users = ((await list.json()) as { users: { id: string; email: string }[] }).users;
  const targets = users.filter((u) => PUBLIC_DEMO_ACCOUNTS.includes(u.email));
  console.log(`cuentas de acceso público Demo encontradas: ${targets.map((u) => u.email).join(', ') || 'ninguna'}`);
  if (users.some((u) => u.email === 'demo.operador@example.test')) console.log('se conserva demo.operador@example.test (recrear la Demo)');
  if (!commit) { console.log('ENSAYO: nada se borró. Repita con --auth --commit.'); process.exit(0); }
  for (const u of targets) {
    const r = await fetch(`${base}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers });
    console.log(`${u.email}: ${r.ok ? 'retirada' : `ERROR ${r.status}`}`);
    if (!r.ok) process.exitCode = 1;
  }
  process.exit();
}

// ---------- Paso 1: empresas Demo ----------
const expectIdx = process.argv.indexOf('--expect');
const expected = expectIdx > 0 ? Number(process.argv[expectIdx + 1]) : NaN;
if (!Number.isInteger(expected) || expected < 1) fail('indique --expect <n> (número exacto de empresas Demo)');
const ca = path.join(os.homedir(), 'Downloads', 'prod-ca-2021.crt');
const ssl = existsSync(ca) ? { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } : fail('falta el certificado de Supabase (Downloads/prod-ca-2021.crt)');
const c = new pg.Client({ host: env['SUPABASE_POOLER_HOST'], port: 5432, user: `postgres.${STAGING_REF}`, password: env['SUPABASE_DB_PASSWORD'], database: 'postgres', ssl });
await c.connect();
const q = async <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) => (await c.query<T>(sql, p)).rows;
const ident = (t: string) => t.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.');

try {
  await c.query('begin');
  await c.query("set local lock_timeout = '20s'");
  await c.query("set local statement_timeout = '10min'");

  // 1. Objetivos: EXACTAMENTE las empresas del registro Demo.
  const targets = await q<{ id: string; name: string; is_demo: boolean }>(`
    select c.id, c.name, c.is_demo from adex.companies c join adex_demo.companies d on d.company_id = c.id order by c.created_at`);
  const ids = targets.map((t) => t.id);
  if (targets.length !== expected) fail(`hay ${targets.length} empresas Demo, se esperaban ${expected}`);
  if (targets.some((t) => !t.is_demo || t.name !== 'Empresa Demo ADEX')) fail('alguna empresa del registro Demo no es una Demo');
  const strays = await q(`select id from adex.companies where is_demo and id <> all($1::text[])`, [ids]);
  if (strays.length) fail(`${strays.length} empresa(s) marcadas Demo fuera del registro: revisar a mano`);
  console.log(`empresas Demo a retirar: ${targets.length}`);

  // 2. Tablas con company_id (salvo la auditoría externa) y orden por FKs no diferibles.
  const tables = (await q<{ t: string }>(`
    select n.nspname || '.' || r.relname t from pg_class r join pg_namespace n on n.oid = r.relnamespace
     where r.relkind = 'r' and n.nspname in ('adex', 'adex_control', 'adex_demo')
       and exists (select 1 from pg_attribute a where a.attrelid = r.oid and a.attname = 'company_id' and not a.attisdropped)
       and (n.nspname || '.' || r.relname) <> 'adex_demo.events'`)).map((r) => r.t);
  const all = [...tables, 'adex.companies'];
  const edges = await q<{ src: string; dst: string }>(`
    select sn.nspname || '.' || s.relname src, dn.nspname || '.' || d.relname dst from pg_constraint k
      join pg_class s on s.oid = k.conrelid join pg_namespace sn on sn.oid = s.relnamespace
      join pg_class d on d.oid = k.confrelid join pg_namespace dn on dn.oid = d.relnamespace
     where k.contype = 'f' and not k.condeferrable and k.conrelid <> k.confrelid`);
  const order: string[] = [];
  const pending = new Set(all);
  while (pending.size) {
    const ready = [...pending].filter((t) => !edges.some((e) => e.dst === t && [...pending].some((p) => p !== t && p === e.src)));
    if (!ready.length) fail(`ciclo de FKs no diferibles entre: ${[...pending].join(', ')}`);
    for (const t of ready) { order.push(t); pending.delete(t); }
  }

  // Identidades de la Demo: marcadores sintéticos y personas asignadas con cuenta demo.* de acceso público.
  const candidates = (await q<{ id: string }>(`
    select distinct x.id::text id from (
      select placeholder_identity_id id from adex_demo.seats where company_id = any($1::text[])
      union select identity_id from adex_demo.seats where company_id = any($1::text[])
      union select identity_id from adex_demo.participants) x
      join adex.identities i on i.id = x.id
     where i.email = any($2::text[]) or i.email like 'demo-%@example.test'`, [ids, PUBLIC_DEMO_ACCOUNTS])).map((r) => r.id);

  // 3. COPIA RECUPERABLE de todo lo que se va a borrar.
  const backup: Record<string, unknown[]> = {};
  for (const t of all) {
    const col = t === 'adex.companies' ? 'id' : 'company_id';
    const rows = await q(`select * from ${ident(t)} where ${col}::text = any($1::text[])`, [ids]);
    if (rows.length) backup[t] = rows;
  }
  backup['adex_demo.slots'] = await q(`select * from adex_demo.slots where company_id = any($1::text[]) or pending_company_id = any($1::text[])`, [ids]);
  backup['adex_demo.participants'] = await q(`select * from adex_demo.participants`);
  backup['adex.identities'] = await q(`select * from adex.identities where id::text = any($1::text[])`, [candidates]);
  const dir = path.join(os.homedir(), 'ADEX_PRIVADO', 'respaldos');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `r53-demo-online-${new Date().toISOString().replace(/[:.]/g, '-')}${commit ? '' : '-ensayo'}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify({ round: 53, companies: targets, rows: backup }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  console.log(`copia recuperable: ${file} (${Object.values(backup).reduce((s, r) => s + r.length, 0)} filas)`);

  // 4. Huella de TODO lo que NO se borra.
  const fingerprint = async () => {
    const out: Record<string, string> = {};
    for (const t of tables) {
      // Seats y registro: se borran enteros. Slots: el hueco de la Demo se vacía a propósito (se comprueba aparte).
      if (t === 'adex_demo.seats' || t === 'adex_demo.companies' || t === 'adex_demo.slots') continue;
      const r = await q<{ n: string; h: string | null }>(`select count(*) n, md5(string_agg(x::text, '|' order by x::text)) h
        from ${ident(t)} x where x.company_id is null or x.company_id::text <> all($1::text[])`, [ids]);
      out[t] = `${r[0]!.n}:${r[0]!.h}`;
    }
    for (const [t, where, p] of [['adex.companies', 'where x.id::text <> all($1::text[])', [ids]], ['adex.identities', 'where x.id::text <> all($1::text[])', [candidates]],
      ['adex_demo.slots', 'where x.slot <> all($1::text[])', [demoSlots]], ['adex_demo.events', '', []], ['adex_demo.operators', '', []], ['adex_control.platform_operators', '', []]] as const) {
      const r = await q<{ n: string; h: string | null }>(`select count(*) n, md5(string_agg(x::text, '|' order by x::text)) h from ${ident(t)} x ${where}`, [...p]);
      out[t] = `${r[0]!.n}:${r[0]!.h}`;
    }
    return out;
  };
  const demoSlots = (await q<{ slot: string }>('select slot from adex_demo.slots where company_id = any($1::text[]) or pending_company_id = any($1::text[])', [ids])).map((r) => r.slot);
  const before = await fingerprint();

  // 5. Guardas desactivadas SOLO en esta transacción (como dueño); borrado como administrador (ignora RLS).
  await c.query('set local role adex_owner');
  const triggers = await q<{ t: string; tg: string; en: string }>(`
    select n.nspname || '.' || r.relname t, tg.tgname tg, tg.tgenabled::text en from pg_trigger tg
      join pg_class r on r.oid = tg.tgrelid join pg_namespace n on n.oid = r.relnamespace
     where not tg.tgisinternal and (n.nspname || '.' || r.relname) = any($1::text[]) and tg.tgenabled <> 'D'`, [[...all, 'adex.identities', 'adex_demo.slots', 'adex_demo.participants']]);
  for (const x of triggers) await c.query(`alter table ${ident(x.t)} disable trigger "${x.tg}"`);
  await c.query('reset role');
  const bypass = (await q<{ b: boolean }>('select rolbypassrls b from pg_roles where rolname = current_user'))[0]?.b;
  if (!bypass) fail('el administrador no ignora RLS: el borrado y sus comprobaciones no serían fiables');
  await c.query('set constraints all deferred');
  // El hueco deja de apuntar a la Demo (queda vacío) y sin participantes.
  const slots = await c.query(`update adex_demo.slots set state = 'empty', company_id = null, pending_company_id = null, updated_at = now()
    where company_id = any($1::text[]) or pending_company_id = any($1::text[])`, [ids]);
  const deleted: Record<string, number> = { 'adex_demo.slots(vaciados)': slots.rowCount ?? 0 };
  deleted['adex_demo.participants'] = (await c.query('delete from adex_demo.participants')).rowCount ?? 0;
  for (const t of order) {
    const col = t === 'adex.companies' ? 'id' : 'company_id';
    const r = await c.query(`delete from ${ident(t)} where ${col}::text = any($1::text[])`, [ids]);
    if (r.rowCount) deleted[t] = r.rowCount;
  }
  deleted['adex.identities'] = (await c.query(`
    delete from adex.identities i where i.id::text = any($1::text[])
       and not exists (select 1 from adex.memberships m where m.identity_id = i.id)
       and not exists (select 1 from adex_demo.seats s where s.identity_id = i.id or s.placeholder_identity_id = i.id)
       and not exists (select 1 from adex_demo.operators o where o.identity_id = i.id)
       and not exists (select 1 from adex_control.platform_operators o where o.identity_id = i.id)
       and not exists (select 1 from adex.revoked_sessions r where r.identity_id = i.id)
       and not exists (select 1 from adex.audit_log a where a.actor_identity_id = i.id)
       and not exists (select 1 from adex.capital_operations o where o.actor_identity_id = i.id)`, [candidates])).rowCount ?? 0;
  await c.query('set constraints all immediate');
  await c.query('set local role adex_owner');
  for (const x of triggers) await c.query(`alter table ${ident(x.t)} enable ${x.en === 'A' ? 'always ' : x.en === 'R' ? 'replica ' : ''}trigger "${x.tg}"`);
  await c.query('reset role');

  // 6. Comprobaciones antes de confirmar.
  const restored = await q<{ t: string; tg: string; en: string }>(`
    select n.nspname || '.' || r.relname t, tg.tgname tg, tg.tgenabled::text en from pg_trigger tg
      join pg_class r on r.oid = tg.tgrelid join pg_namespace n on n.oid = r.relnamespace
     where not tg.tgisinternal and (n.nspname || '.' || r.relname) = any($1::text[]) and tg.tgenabled <> 'D'`, [[...all, 'adex.identities', 'adex_demo.slots', 'adex_demo.participants']]);
  const key = (xs: { t: string; tg: string; en: string }[]) => xs.map((x) => `${x.t}.${x.tg}=${x.en}`).sort().join(',');
  if (key(restored) !== key(triggers)) fail('los triggers no quedaron como estaban');
  for (const t of all) {
    const col = t === 'adex.companies' ? 'id' : 'company_id';
    const n = (await q<{ n: string }>(`select count(*) n from ${ident(t)} where ${col}::text = any($1::text[])`, [ids]))[0]!.n;
    if (n !== '0') fail(`quedan ${n} filas de las Demos en ${t}`);
  }
  const after = await fingerprint();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  if (changed.length) fail(`cambió algo fuera del alcance: ${changed.join(', ')}`);
  const left = (await q<{ n: string }>(`select count(*) n from adex.memberships where role = 'socio'`))[0]!.n;

  console.log(JSON.stringify({ retiredCompanies: targets.length, deleted, triggersRestored: triggers.length, othersUnchanged: Object.keys(before).length,
    socioMembershipsOutsideDemo: Number(left) }, null, 2));
  if (commit) { await c.query('commit'); console.log('CONFIRMADO (commit).'); }
  else { await c.query('rollback'); console.log('ENSAYO: nada se ha confirmado (rollback). Repita con --commit.'); }
} catch (err) {
  await c.query('rollback').catch(() => undefined);
  console.error('ERROR, revertido:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await c.end();
}
