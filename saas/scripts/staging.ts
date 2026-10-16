// Arnés de ADEX-Staging (DS-02 limitado a staging: Supabase Free, sa-east-1, datos
// SINTÉTICOS). Antes de cualquier SQL se detiene con BLOQUEADO si algo no cuadra.
//
//   node scripts/staging.ts --check     → solo comprobaciones, sin escrituras
//   node scripts/staging.ts --migrate   → migraciones + semillas sintéticas
//   node scripts/staging.ts --test      → test/auth-real (Auth real + RLS gestionada)
//
// Variables en saas/.env.staging (ignorado por Git; ver .env.example). NUNCA se usa
// el proyecto de la POC (ADEX-SaaS-POC-0A1) ni recursos de otros productos.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../src/db/pgTypes.ts';
import { migrate, readMigrations } from '../src/db/migrate.ts';
import { importSnapshot } from '../src/model/adapter.ts';
import { syntheticDataset } from '../db/seeds/synthetic.ts';
import { randomSecret } from './local-cluster.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POC_REF = 'bfjvkczbjtuqgsqnwfvy';   // ADEX-SaaS-POC-0A1 (docs/SAAS_FASE_0A1_RESULTADOS.md §R.1)
const EXPECTED_NAME = 'ADEX-Staging';
const REGION = 'sa-east-1';

function blocked(reason: string): never {
  console.error(`BLOQUEADO: ${reason}`);
  process.exit(2);
}

function loadEnv(): Record<string, string> {
  const file = path.join(root, '.env.staging');
  if (!existsSync(file)) blocked('falta saas/.env.staging (ADEX-Staging no existe o no está configurado)');
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2]) env[m[1]!] = m[2].trim();
  }
  return env;
}

const mode = process.argv[2] ?? '--check';
const env = loadEnv();
const need = (k: string) => env[k] ?? blocked(`falta ${k}`);
const ref = need('ADEX_STAGING_PROJECT_REF');
if (ref === POC_REF) blocked('la referencia es la del proyecto de la POC: no se convierte en staging');
if (need('SUPABASE_URL') !== `https://${ref}.supabase.co`) blocked('SUPABASE_URL no coincide con la referencia');

// Proyecto: identidad DEMOSTRADA antes de cualquier SQL. Dos vías:
//   · con token de la Management API (solo lectura): nombre, región y estado;
//   · sin token (Fase 2: el token temporal de la Fase 1 se retiró): la referencia
//     documentada de ADEX-Staging, un pooler de sa-east-1 (enruta por referencia y
//     solo acepta la contraseña de ESE proyecto), Auth del mismo proyecto con solo
//     usuarios sintéticos, la huella EXACTA de las migraciones ya aplicadas (más
//     abajo, antes de escribir) y la Data API sin acceso a los esquemas de ADEX.
const STAGING_REF = 'hyqaufsagtsucztjfjvc';   // ADEX-Staging (docs/SAAS_FASES_0_1_RESULTADOS.md)
const token = env['SUPABASE_ACCESS_TOKEN'];
let projectLine: string;
let dataApi: string;
if (token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) blocked(`Management API respondió ${res.status}`);
  const p = (await res.json()) as { name?: string; region?: string; status?: string };
  if (p.name !== EXPECTED_NAME) blocked(`el proyecto se llama «${p.name}», no ${EXPECTED_NAME}`);
  if (p.region !== REGION) blocked(`región ${p.region}, se exige ${REGION}`);
  if (p.status !== 'ACTIVE_HEALTHY') blocked(`estado del proyecto ${p.status}`);
  // Data API: estado efectivo. Activa o no, nunca puede exponer adex/adex_control/adex_meta.
  const rest = await fetch(`${need('SUPABASE_URL')}/rest/v1/`, { headers: { apikey: need('SUPABASE_PUBLISHABLE_KEY') } });
  const api = await fetch(`https://api.supabase.com/v1/projects/${ref}/postgrest`, { headers: { authorization: `Bearer ${token}` } });
  const exposed = api.ok ? ((await api.json()) as { db_schema?: string }).db_schema ?? '' : `(config ${api.status})`;
  if (/adex(_control|_meta)?/.test(exposed)) blocked('la Data API expone adex, adex_control o adex_meta');
  dataApi = `Data API ${rest.status === 503 ? 'desactivada' : `responde ${rest.status}`} · esquemas expuestos: ${exposed || 'ninguno'}`;
  projectLine = `${EXPECTED_NAME} (${ref}, ${REGION}, ${p.status}, Management API)`;
} else {
  if (ref !== STAGING_REF) blocked('sin token de la Management API solo se admite la referencia documentada de ADEX-Staging');
  if (!need('SUPABASE_POOLER_HOST').includes(REGION)) blocked(`el pooler no es de ${REGION}`);
  const probes = await Promise.all(['adex', 'adex_control', 'adex_meta'].map((schema) =>
    fetch(`${need('SUPABASE_URL')}/rest/v1/companies?select=id&limit=1`, { headers: { apikey: need('SUPABASE_PUBLISHABLE_KEY'), 'accept-profile': schema } })
      .then((r) => [schema, r.status] as const)));
  const open = probes.filter(([, s]) => s >= 200 && s < 300);
  if (open.length) blocked(`la Data API responde datos de ${open.map(([s]) => s).join(', ')}`);
  dataApi = `Data API sin acceso a adex/adex_control/adex_meta (${probes.map(([s, st]) => `${s}:${st}`).join(' ')})`;
  projectLine = `${ref} (${REGION} por el pooler; sin token de la Management API: identidad por referencia, contraseña del proyecto y huella de migraciones)`;
}
const attestation = env['ADEX_STAGING_OWNER_ATTESTATION'];
if (attestation !== `free:${ref}:${REGION}`) blocked(`falta la declaración del propietario free:${ref}:${REGION} (plan Free sin método de pago)`);

// Auth: solo usuarios sintéticos.
const users = await fetch(`${need('SUPABASE_URL')}/auth/v1/admin/users?per_page=1000`, {
  headers: { apikey: need('SUPABASE_SECRET_KEY'), authorization: `Bearer ${need('SUPABASE_SECRET_KEY')}` },
});
if (!users.ok) blocked(`Auth admin respondió ${users.status}`);
const list = ((await users.json()) as { users?: { email?: string }[] }).users ?? [];
const foreign = list.filter((u) => !(u.email ?? '').endsWith('@example.test'));
if (foreign.length) blocked(`Auth tiene ${foreign.length} usuario(s) no sintético(s)`);

const ssl = env['ADEX_PG_SSL_CA'] ? { ca: readFileSync(env['ADEX_PG_SSL_CA'], 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
const host = need('SUPABASE_POOLER_HOST');
const adminUrl = `postgres://postgres.${ref}:${encodeURIComponent(need('SUPABASE_DB_PASSWORD'))}@${host}:5432/postgres`;
const admin = new pg.Client({ connectionString: adminUrl, ssl });
await admin.connect();
try {
  const tables = await admin.query(`select count(*)::int n from pg_tables where schemaname = 'public'`);
  if (tables.rows[0].n > 0) blocked('el esquema public tiene tablas: el proyecto no está vacío');
  if (!token) {
    // Huella: lo aplicado debe ser EXACTAMENTE un prefijo del repositorio que incluya la
    // Fase 1 (0001…0006, mismos nombres y SHA-256). Otro proyecto no la tiene.
    const has = await admin.query(`select to_regclass('adex_meta.schema_migrations') is not null ok`);
    if (!has.rows[0].ok) blocked('sin token, el destino debe tener ya el historial de migraciones de ADEX-Staging');
    const applied = (await admin.query('select version, name, checksum from adex_meta.schema_migrations order by version')).rows;
    const repo = readMigrations();
    const prefix = applied.length >= 6 && applied.every((a, i) => repo[i] && repo[i]!.version === a.version && repo[i]!.name === a.name && repo[i]!.checksum === a.checksum);
    if (!prefix) blocked('la huella de migraciones aplicadas no coincide con el repositorio');
    projectLine += ` · huella ${applied.map((a) => a.version).join(',')} verificada`;
  }
  console.log(`OK: ${projectLine}, ${list.length} usuario(s) sintético(s), public vacío · ${dataApi}`);
  if (mode === '--check') process.exit(0);

  const passwords = { api: randomSecret(), control: randomSecret() };
  if (mode === '--migrate') {
    const r = await migrate(admin, passwords);
    console.log(`migraciones aplicadas: ${r.applied.join(', ') || 'ninguna'} · omitidas: ${r.skipped.length}`);
    const has = await admin.query('select count(*)::int n from adex.companies');
    if (has.rows[0].n === 0) {
      const { snapshot, options } = syntheticDataset();
      await importSnapshot(admin, snapshot, options);
      console.log('semillas sintéticas importadas');
    }
    process.exit(0);
  }
  if (mode === '--test') {
    await migrate(admin, passwords);
    // La contraseña de adex_api se rota en cada ejecución y Supavisor tarda unos segundos
    // en olvidar la anterior: se espera a tres conexiones seguidas aceptadas (máx. 120 s).
    const apiUrl = `postgres://adex_api.${ref}:${encodeURIComponent(passwords.api)}@${host}:6543/postgres`;
    let streak = 0;
    for (const deadline = Date.now() + 120_000; streak < 3; ) {
      const probe = new pg.Client({ connectionString: apiUrl, ssl });
      try { await probe.connect(); await probe.query('select 1'); streak++; } catch { streak = 0; }
      await probe.end().catch(() => undefined);
      if (streak < 3) {
        if (Date.now() > deadline) blocked('el pooler no acepta la credencial rotada de adex_api');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', '--test', '--test-reporter=spec', '--test-concurrency=1',
        path.join('test', 'auth-real', 'staging-auth.test.ts'), path.join('test', 'auth-real', 'staging-rls.test.ts'),
        path.join('test', 'auth-real', 'staging-phase2.test.ts'), path.join('test', 'auth-real', 'staging-phase3.test.ts'),
        path.join('test', 'auth-real', 'staging-phase4.test.ts')], {
        cwd: root, stdio: 'inherit',
        env: { ...process.env, ...env, ADEX_STAGING_API_URL: apiUrl,
          ADEX_STAGING_ADMIN_URL: adminUrl },
      });
      child.on('close', (c) => resolve(c ?? 1));
    });
    process.exit(code);
  }
  blocked(`modo desconocido ${mode}`);
} finally {
  await admin.end().catch(() => undefined);
}
