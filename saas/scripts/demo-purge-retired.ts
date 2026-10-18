// Purga DEFINITIVA de empresas Demo RETIRADAS en ADEX-Staging (Ronda 20, autorizada por
// el propietario el 2026-10-18). Herramienta administrativa de un solo uso, NO una función
// de la aplicación: ni la API ni ningún rol de aplicación pueden borrar datos.
//
//   node --import ./scripts/register-alias.mjs scripts/demo-purge-retired.ts --expect 15            (ensayo: ROLLBACK)
//   node --import ./scripts/register-alias.mjs scripts/demo-purge-retired.ts --expect 15 --commit
//
// Alcance cerrado: solo empresas `is_demo AND retired_at IS NOT NULL AND status='suspendida'`
// con ciclo de vida `retired|failed`, ninguna apuntada por un hueco Demo. Las guardas de
// inmutabilidad (triggers) se desactivan y restauran DENTRO DE UNA ÚNICA TRANSACCIÓN como
// dueño de las tablas: ninguna otra sesión llega a verlas desactivadas (ALTER TABLE toma
// el bloqueo exclusivo hasta el final). Antes de confirmar se exige:
//   · cero filas de las empresas purgadas en todas las tablas con `company_id`;
//   · huella idéntica (antes/después) de TODAS las filas de las demás empresas;
//   · todas las restricciones diferidas satisfechas y los triggers restaurados igual.
// Se conserva la auditoría administrativa externa (`adex_demo.events`, solo se añade).
// También se retiran los huecos de prueba `stg-*` vacíos y las asignaciones de personas
// de prueba (configuración Demo, sin datos financieros).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../src/db/pgTypes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'hyqaufsagtsucztjfjvc';
const fail = (m: string): never => { console.error(`BLOQUEADO: ${m}`); process.exit(2); };

const envFile = path.join(root, '.env.staging');
if (!existsSync(envFile)) fail('falta saas/.env.staging');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1]!, m[2]!.trim()]));
if (env['ADEX_STAGING_PROJECT_REF'] !== STAGING_REF) fail('solo se admite ADEX-Staging');
const expectIdx = process.argv.indexOf('--expect');
const expected = expectIdx > 0 ? Number(process.argv[expectIdx + 1]) : NaN;
if (!Number.isInteger(expected) || expected < 1) fail('indique --expect <n> (número exacto de Demos retiradas)');
const commit = process.argv.includes('--commit');

const ssl = env['ADEX_PG_SSL_CA'] ? { ca: readFileSync(env['ADEX_PG_SSL_CA'], 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
const c = new pg.Client({ connectionString: `postgres://postgres.${STAGING_REF}:${encodeURIComponent(env['SUPABASE_DB_PASSWORD'] ?? '')}@${env['SUPABASE_POOLER_HOST']}:5432/postgres`, ssl });
await c.connect();
const q = async <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) => (await c.query<T>(sql, p)).rows;
const ident = (t: string) => t.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.');

try {
  await c.query('begin');
  await c.query("set local lock_timeout = '20s'");

  // 1. Objetivos: SOLO Demos retiradas.
  const targets = await q<{ id: string; name: string }>(`
    select c.id, c.name from adex.companies c join adex_demo.companies d on d.company_id = c.id
     where c.is_demo and c.retired_at is not null and c.status = 'suspendida' and d.state in ('retired', 'failed')
       and not exists (select 1 from adex_demo.slots s where s.company_id = c.id or s.pending_company_id = c.id)
     order by c.created_at`);
  const ids = targets.map((t) => t.id);
  const strays = await q(`select id from adex.companies where is_demo and retired_at is not null and id <> all($1::text[])`, [ids]);
  if (strays.length) fail(`${strays.length} Demo(s) retirada(s) fuera del criterio: revisar a mano`);
  if (targets.length !== expected) fail(`hay ${targets.length} Demos retiradas, se esperaban ${expected}`);
  if (targets.some((t) => !/^Empresa Demo/.test(t.name))) fail('alguna Demo retirada no tiene nombre de Demo');
  console.log(`Demos retiradas a purgar: ${targets.length}`);

  // 2. Tablas con company_id (salvo la auditoría externa) y orden por FKs NO diferibles.
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
  const name = (t: string) => t;
  const order: string[] = [];
  const pending = new Set(all);
  while (pending.size) {
    // Una tabla se borra cuando ninguna tabla pendiente la referencia (hijos primero).
    const ready = [...pending].filter((t) => !edges.some((e) => e.dst === name(t) && e.src !== e.dst && [...pending].some((p) => p !== t && name(p) === e.src)));
    if (!ready.length) fail(`ciclo de FKs no diferibles entre: ${[...pending].join(', ')}`);
    for (const t of ready) { order.push(t); pending.delete(t); }
  }

  // 3. Huella de TODO lo que NO se purga.
  const fingerprint = async () => {
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await q<{ n: string; h: string | null }>(`select count(*) n, md5(string_agg(x::text, '|' order by x::text)) h
        from ${ident(t)} x where (x.company_id is null or x.company_id::text <> all($1::text[]))
        ${t === 'adex_demo.slots' ? "and x.slot not like 'stg-%'" : ''}`, [ids]);
      out[t] = `${r[0]!.n}:${r[0]!.h}`;
    }
    for (const t of ['adex.companies', 'adex.identities', 'adex_demo.events', 'adex_demo.operators', 'adex_control.platform_operators', 'adex.revoked_sessions']) {
      const where = t === 'adex.companies' ? 'where x.id::text <> all($1::text[])' : t === 'adex.identities' ? 'where x.id::text <> all($1::text[])' : '';
      const p = t === 'adex.companies' ? [ids] : t === 'adex.identities' ? [candidates] : [];
      const r = await q<{ n: string; h: string | null }>(`select count(*) n, md5(string_agg(x::text, '|' order by x::text)) h from ${ident(t)} x ${where}`, p);
      out[t] = `${r[0]!.n}:${r[0]!.h}`;
    }
    return out;
  };
  // Identidades SINTÉTICAS de esas Demos (puestos sin persona): se borran si nada más las usa.
  const candidates = (await q<{ id: string }>(`select distinct placeholder_identity_id::text id from adex_demo.seats where company_id = any($1::text[])`, [ids])).map((r) => r.id);
  const before = await fingerprint();

  // 4. Guardas desactivadas SOLO en esta transacción, como dueño de las tablas.
  await c.query('set local role adex_owner');
  const triggers = await q<{ t: string; tg: string; en: string }>(`
    select n.nspname || '.' || r.relname t, tg.tgname tg, tg.tgenabled::text en from pg_trigger tg
      join pg_class r on r.oid = tg.tgrelid join pg_namespace n on n.oid = r.relnamespace
     where not tg.tgisinternal and (n.nspname || '.' || r.relname) = any($1::text[]) and tg.tgenabled <> 'D'`, [all]);
  for (const x of triggers) await c.query(`alter table ${ident(x.t)} disable trigger "${x.tg}"`);
  // Las tablas tienen FORCE ROW LEVEL SECURITY: como dueño un DELETE quedaría filtrado en
  // silencio. Borrar y comprobar se hace con el administrador, que ignora RLS (se exige).
  await c.query('reset role');
  const bypass = (await q<{ b: boolean }>('select rolbypassrls b from pg_roles where rolname = current_user'))[0]?.b;
  if (!bypass) fail('el administrador no ignora RLS: el borrado y sus comprobaciones no serían fiables');
  await c.query('set constraints all deferred');
  const deleted: Record<string, number> = {};
  for (const t of order) {
    const col = t === 'adex.companies' ? 'id' : 'company_id';
    if (process.env.PURGE_TRACE) console.log("delete", t);
    const r = await c.query(`delete from ${ident(t)} where ${col}::text = any($1::text[])`, [ids]);
    if (r.rowCount) deleted[t] = r.rowCount;
  }
  // Configuración Demo de prueba: huecos stg-* vacíos y asignaciones de personas de prueba.
  deleted['adex_demo.participants'] = (await c.query(`delete from adex_demo.participants`)).rowCount ?? 0;
  deleted['adex_demo.slots(stg-*)'] = (await c.query(`delete from adex_demo.slots where slot like 'stg-%' and state = 'empty'
    and not exists (select 1 from adex_demo.companies d where d.slot = slots.slot)`)).rowCount ?? 0;
  const ident_del = await c.query(`
    delete from adex.identities i where i.id::text = any($1::text[])
       and not exists (select 1 from adex.memberships m where m.identity_id = i.id)
       and not exists (select 1 from adex_demo.seats s where s.identity_id = i.id or s.placeholder_identity_id = i.id)
       and not exists (select 1 from adex_demo.operators o where o.identity_id = i.id)
       and not exists (select 1 from adex_control.platform_operators o where o.identity_id = i.id)
       and not exists (select 1 from adex.revoked_sessions r where r.identity_id = i.id)
       and not exists (select 1 from adex.audit_log a where a.actor_identity_id = i.id)
       and not exists (select 1 from adex.capital_operations o where o.actor_identity_id = i.id)
       and not exists (select 1 from adex.custody_settlements s where s.closed_by_identity_id = i.id)
       and not exists (select 1 from adex.period_closures p where p.closed_by_identity_id = i.id)`, [candidates]);
  deleted['adex.identities(sintéticas)'] = ident_del.rowCount ?? 0;
  await c.query('set constraints all immediate');   // toda FK diferida se comprueba AQUÍ
  await c.query('set local role adex_owner');
  for (const x of triggers) await c.query(`alter table ${ident(x.t)} enable ${x.en === 'A' ? 'always ' : x.en === 'R' ? 'replica ' : ''}trigger "${x.tg}"`);
  await c.query('reset role');

  // 5. Comprobaciones antes de confirmar.
  const restored = await q<{ t: string; tg: string; en: string }>(`
    select n.nspname || '.' || r.relname t, tg.tgname tg, tg.tgenabled::text en from pg_trigger tg
      join pg_class r on r.oid = tg.tgrelid join pg_namespace n on n.oid = r.relnamespace
     where not tg.tgisinternal and (n.nspname || '.' || r.relname) = any($1::text[]) and tg.tgenabled <> 'D'`, [all]);
  const key = (xs: { t: string; tg: string; en: string }[]) => xs.map((x) => `${x.t}.${x.tg}=${x.en}`).sort().join(',');
  if (key(restored) !== key(triggers)) fail('los triggers no quedaron como estaban');
  for (const t of all) {
    const col = t === 'adex.companies' ? 'id' : 'company_id';
    const n = (await q<{ n: string }>(`select count(*) n from ${ident(t)} where ${col}::text = any($1::text[])`, [ids]))[0]!.n;
    if (n !== '0') fail(`quedan ${n} filas de Demos purgadas en ${t}`);
  }
  const after = await fingerprint();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k] && !['adex_demo.operators'].includes(k));
  // Las identidades sintéticas purgadas están excluidas de la huella; el resto debe ser idéntico.
  if (changed.length) fail(`cambió algo fuera del alcance: ${changed.join(', ')}`);

  console.log(JSON.stringify({ purgedCompanies: targets.length, deleted, triggersRestored: triggers.length, othersUnchanged: Object.keys(before).length }, null, 2));
  if (commit) { await c.query('commit'); console.log('CONFIRMADO (commit).'); }
  else { await c.query('rollback'); console.log('ENSAYO: nada se ha confirmado (rollback). Repita con --commit.'); }
} catch (err) {
  await c.query('rollback').catch(() => undefined);
  console.error('ERROR, revertido:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await c.end();
}
