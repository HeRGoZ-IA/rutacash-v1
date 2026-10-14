// Fase 0A.1 · Ejecuta la POC contra el proyecto Supabase EXPERIMENTAL autorizado.
//
//   npm run test:managed              # verifica el proyecto, prepara el esquema y ejecuta las pruebas
//   npm run test:managed -- --check   # solo verificaciones (ninguna escritura)
//   npm run test:managed -- --teardown  # borra el esquema adex, los roles y los usuarios sintéticos
//
// Credenciales: SOLO en experiments/saas-phase0a/.env.managed (ignorado por Git)
// o en variables de entorno. Nombres en .env.example. Nada se imprime sin redactar.
//
// Controles ANTES de cualquier SQL (si uno falla, no se ejecuta nada):
//   1. SUPABASE_URL apunta exactamente al proyecto ADEX_POC_PROJECT_REF.
//   2. Nombre, región y plan Free verificados por la Management API (token de solo
//      lectura del propietario) o, en su defecto, declarados por el propietario
//      en ADEX_POC_OWNER_ATTESTATION = "free:<ref>:<región>".
//   3. Supabase Auth solo contiene usuarios sintéticos (@example.test).
//   4. El esquema public no tiene tablas y `adex` no existe o lleva la marca de esta POC.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SCHEMA_MARK, dropSchema, prepareSchema, schemaMark } from './managed-schema.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const evidenceDir = path.resolve(root, '..', '..', 'tmp', 'saas-phase0a1', 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const EXPECTED_NAME = 'ADEX-SaaS-POC-0A1';
const SYNTHETIC_DOMAIN = '@example.test';

const envFile = path.join(root, '.env.managed');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const testArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const mode = args.has('--teardown') ? 'teardown' : args.has('--check') ? 'check' : 'run';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) fail(`falta ${name} (ver .env.example)`);
  return v as string;
}
function fail(msg: string): never {
  console.error(`BLOQUEADO: ${msg}`);
  process.exit(2);
}

const ref = need('ADEX_POC_PROJECT_REF');
if (!/^[a-z0-9]{20}$/.test(ref)) fail('ADEX_POC_PROJECT_REF no tiene formato de referencia de proyecto');
const supabaseUrl = need('SUPABASE_URL').replace(/\/$/, '');
const publishable = process.env['SUPABASE_PUBLISHABLE_KEY']?.trim() || need('SUPABASE_ANON_KEY');
const secretKey = process.env['SUPABASE_SECRET_KEY']?.trim() || need('SUPABASE_SERVICE_ROLE_KEY');
const dbPassword = need('SUPABASE_DB_PASSWORD');
const poolerHost = need('SUPABASE_POOLER_HOST');
const caPath = process.env['ADEX_PG_SSL_CA']?.trim();
const caPem = caPath ? readFileSync(caPath, 'utf8') : undefined;
const apiPassword = randomBytes(24).toString('base64url'); // nueva en cada ejecución; nunca se guarda

// ---------- Evidencia redactada ----------
const secrets = [publishable, secretKey, dbPassword, apiPassword, process.env['SUPABASE_ACCESS_TOKEN'] ?? '']
  .filter((s) => s.length >= 8);
function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('<redactado>');
  return out
    .replace(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, '<jwt redactado>')
    .replace(/sb_(secret|publishable)_[\w-]+/g, 'sb_$1_<redactado>')
    .replace(/sbp_[\w]+/g, 'sbp_<redactado>')
    .replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redactado>');
}
const logPath = path.join(evidenceDir, `managed-${mode}-${stamp}.log`);
const log = createWriteStream(logPath);
const out = (s: string) => { const r = redact(s); process.stdout.write(r); log.write(r); };
const note = (s: string) => out(`${s}\n`);

// ---------- 1. El URL corresponde al proyecto ----------
if (new URL(supabaseUrl).host !== `${ref}.supabase.co`) fail('SUPABASE_URL no corresponde a ADEX_POC_PROJECT_REF');
note(`# ADEX Fase 0A.1 · ${mode} · ${new Date().toISOString()}`);
note(`proyecto: ${ref}`);

// ---------- 2. Nombre, región, organización y plan ----------
interface Verified { name: string; region: string; org: string; plan: string; how: string; dbVersion?: string; authJwtExp?: number; signupDisabled?: boolean; exposedSchemas?: string; signingKeys?: string }
async function mgmt<T>(p: string): Promise<{ status: number; body: T | null }> {
  const r = await fetch(`https://api.supabase.com${p}`, { headers: { authorization: `Bearer ${process.env['SUPABASE_ACCESS_TOKEN']}` } });
  return { status: r.status, body: r.ok ? ((await r.json()) as T) : null };
}
async function verifyProject(): Promise<Verified> {
  if (process.env['SUPABASE_ACCESS_TOKEN']) {
    const p = await mgmt<{ id: string; name: string; region: string; organization_id: string; status: string; database?: { version?: string } }>(`/v1/projects/${ref}`);
    if (!p.body) fail(`Management API /v1/projects/${ref} → ${p.status}`);
    if (p.body.name !== EXPECTED_NAME) fail(`el proyecto se llama "${p.body.name}", no "${EXPECTED_NAME}"`);
    // Un token limitado al proyecto (recomendado) no puede leer la organización: el plan lo declara entonces
    // el propietario, y la región declarada debe coincidir con la que devuelve la API.
    const o = await mgmt<{ id: string; name: string; plan?: string }>(`/v1/organizations/${p.body.organization_id}`);
    let orgName: string;
    let plan: string;
    let how = 'Management API';
    if (o.body) {
      if (o.body.plan !== 'free') fail(`la organización no está en plan Free (plan=${o.body.plan ?? 'desconocido'})`);
      orgName = o.body.name;
      plan = 'free';
    } else {
      const att = /^free:([a-z0-9]{20}):([a-z0-9-]+)$/.exec(process.env['ADEX_POC_OWNER_ATTESTATION']?.trim() ?? '');
      if (!att) fail(`Management API /v1/organizations → ${o.status} (token limitado al proyecto): falta ADEX_POC_OWNER_ATTESTATION="free:<ref>:<región>" para el plan`);
      if (att[1] !== ref) fail('la declaración del propietario no corresponde a este proyecto');
      if (att[2] !== p.body.region) fail(`la región declarada (${att[2]}) no coincide con la de la API (${p.body.region})`);
      orgName = `${p.body.organization_id} (sin lectura de la organización)`;
      plan = 'free (declarado por el propietario; la organización no es legible con un token de proyecto)';
      how = 'Management API (nombre, región, configuración) + declaración del propietario (plan)';
    }
    const all = await mgmt<Array<{ id: string; name: string; organization_id: string }>>('/v1/projects');
    const visible = all.body ?? [];
    const siblings = visible.filter((x) => x.organization_id === p.body!.organization_id);
    const pocs = visible.filter((x) => x.name === EXPECTED_NAME);
    if (all.body && pocs.length !== 1) fail(`hay ${pocs.length} proyectos llamados ${EXPECTED_NAME}; se autoriza exactamente uno`);
    const auth = await mgmt<{ jwt_exp?: number; disable_signup?: boolean }>(`/v1/projects/${ref}/config/auth`);
    const rest = await mgmt<{ db_schema?: string }>(`/v1/projects/${ref}/postgrest`);
    const keys = await mgmt<{ keys?: Array<{ id: string; algorithm: string; status: string }> } | Array<{ id: string; algorithm: string; status: string }>>(`/v1/projects/${ref}/config/auth/signing-keys`);
    const keyList = Array.isArray(keys.body) ? keys.body : keys.body?.keys;
    note(`organización: ${orgName} · proyectos visibles para el token: ${all.body ? siblings.length : `no legible (${all.status})`}`);
    return {
      name: p.body.name, region: p.body.region, org: orgName, plan, how,
      dbVersion: p.body.database?.version, authJwtExp: auth.body?.jwt_exp, signupDisabled: auth.body?.disable_signup,
      exposedSchemas: rest.body?.db_schema,
      signingKeys: keyList ? keyList.map((k) => `${k.algorithm}:${k.status}`).join(', ') : `no disponible (${keys.status})`,
    };
  }
  const att = process.env['ADEX_POC_OWNER_ATTESTATION']?.trim() ?? '';
  const m = /^free:([a-z0-9]{20}):([a-z0-9-]+)$/.exec(att);
  if (!m || m[1] !== ref) fail('sin SUPABASE_ACCESS_TOKEN hace falta ADEX_POC_OWNER_ATTESTATION="free:<ref>:<región>" del propietario');
  return { name: `${EXPECTED_NAME} (declarado)`, region: m[2] as string, org: '(declarada)', plan: 'free (declarado por el propietario)', how: 'declaración del propietario' };
}
const project = await verifyProject();
note(`nombre: ${project.name} · región: ${project.region} · plan: ${project.plan} · verificado por: ${project.how}`);
if (project.dbVersion) note(`versión de base (Management API): ${project.dbVersion}`);
if (project.authJwtExp !== undefined) note(`Auth: jwt_exp=${project.authJwtExp}s · registro público deshabilitado=${project.signupDisabled}`);
if (project.exposedSchemas !== undefined) note(`Data API: esquemas expuestos = ${project.exposedSchemas}`);
if (project.signingKeys) note(`claves de firma JWT: ${project.signingKeys}`);
if (project.exposedSchemas?.split(',').map((s) => s.trim()).includes('adex')) fail('el esquema adex está expuesto en la Data API');

// ---------- 3. Auth solo con usuarios sintéticos ----------
const adminHeaders: Record<string, string> = secretKey.startsWith('sb_')
  ? { apikey: secretKey }
  : { apikey: secretKey, authorization: `Bearer ${secretKey}` };
async function listUsers(): Promise<Array<{ id: string; email?: string }>> {
  const r = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=200`, { headers: adminHeaders });
  if (!r.ok) fail(`Auth admin /users → ${r.status}`);
  return ((await r.json()) as { users: Array<{ id: string; email?: string }> }).users;
}
const users = await listUsers();
const foreign = users.filter((u) => !(u.email ?? '').endsWith(SYNTHETIC_DOMAIN));
if (foreign.length) fail(`Supabase Auth tiene ${foreign.length} usuario(s) no sintéticos: no es el proyecto experimental vacío`);
note(`Auth: ${users.length} usuario(s), todos sintéticos (${SYNTHETIC_DOMAIN})`);

// ---------- 4. Base de datos: proyecto vacío o con la marca de esta POC ----------
const ssl = caPem ? { ca: caPem, rejectUnauthorized: true } : { rejectUnauthorized: false };
note(`TLS: ${caPem ? 'verificando el certificado con la CA del proyecto' : 'cifrado SIN verificación de certificado (falta ADEX_PG_SSL_CA)'}`);
const enc = encodeURIComponent;
const adminUrl = `postgres://postgres.${ref}:${enc(dbPassword)}@${poolerHost}:5432/postgres`;
const apiTxUrl = `postgres://adex_api.${ref}:${enc(apiPassword)}@${poolerHost}:6543/postgres`;
const apiSessionUrl = `postgres://adex_api.${ref}:${enc(apiPassword)}@${poolerHost}:5432/postgres`;

const admin = new pg.Client({ connectionString: adminUrl, ssl });
await admin.connect();
const info = (await admin.query(`select version() v, current_user u, current_database() d,
  (select row(rolsuper, rolbypassrls, rolcreaterole)::text from pg_roles where rolname = current_user) attrs`)).rows[0];
note(`PostgreSQL: ${info.v}`);
note(`conexión administrativa: usuario ${info.u} · base ${info.d} · (super, bypassrls, createrole) = ${info.attrs} · pooler de sesión (IPv4)`);
const publicTables = Number((await admin.query(`select count(*)::int n from pg_tables where schemaname = 'public'`)).rows[0].n);
const mark = await schemaMark(admin);
if (publicTables > 0) fail(`el esquema public tiene ${publicTables} tabla(s): no es un proyecto experimental vacío`);
if (mark !== undefined && mark !== SCHEMA_MARK) fail('existe un esquema adex que no pertenece a esta POC');
note(`base: public sin tablas · esquema adex ${mark ? 'existente con la marca de la POC' : 'inexistente'}`);

const exit = async (code: number) => { await admin.end().catch(() => undefined); log.end(); process.exit(code); };

if (mode === 'check') {
  note('modo --check: verificaciones superadas, sin escrituras');
  await exit(0);
}

if (mode === 'teardown') {
  await dropSchema(admin);
  let deleted = 0;
  for (const u of await listUsers()) {
    if ((u.email ?? '').endsWith(SYNTHETIC_DOMAIN)) {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: adminHeaders });
      if (r.ok) deleted++;
    }
  }
  note(`teardown: esquema adex ${mark ? 'eliminado' : 'no existía'} · roles eliminados · ${deleted} usuario(s) sintético(s) eliminados`);
  await exit(0);
}

// ---------- Preparación (se rehace en cada ejecución; contraseña de adex_api nueva) ----------
try {
  await prepareSchema(admin, apiPassword);
} catch (e) {
  fail(`preparación del esquema: ${(e as { code?: string }).code ?? ''} ${redact((e as Error).message)}`);
}
note('esquema adex aplicado (001_schema.sql, 002_rls.sql) por adex_owner; catálogo sembrado por postgres');
await admin.end();

// ---------- Pruebas ----------
const env = {
  ...process.env,
  ADEX_PG_MODE: 'managed',
  ADEX_PG_ADMIN_URL: adminUrl,
  ADEX_PG_API_URL: apiTxUrl,
  ADEX_PG_API_SESSION_URL: apiSessionUrl,
  ADEX_PG_DIRECT_HOST: `db.${ref}.supabase.co`,
  ADEX_PG_DIRECT_API_URL: `postgres://adex_api:${enc(apiPassword)}@db.${ref}.supabase.co:5432/postgres`,
  ADEX_PG_SSL_CA_PEM: caPem ?? '',
  ADEX_PG_VERSION: String(info.v),
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: publishable,
  SUPABASE_SERVICE_ROLE_KEY: secretKey,
};
const files = [
  ...readdirSync(path.join(root, 'test', 'managed')).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('test', 'managed', f)),
  path.join('test', 'integration', 'revocation.test.ts'),
  ...readdirSync(path.join(root, 'test', 'auth-real')).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('test', 'auth-real', f)),
];
const selected = testArgs.length ? files.filter((f) => testArgs.some((o) => path.basename(f).startsWith(o))) : files;
const started = Date.now();
const code = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', '--test-timeout=120000', ...selected], { cwd: root, env });
  child.stdout.on('data', (d) => out(String(d)));
  child.stderr.on('data', (d) => out(String(d)));
  child.on('close', (c) => resolve(c ?? 1));
});
note(`# fin ${new Date().toISOString()} · ${(Date.now() - started) / 1000}s · exit ${code}`);
note(`# evidencia (redactada): ${logPath}`);
log.end();
process.exit(code);
