// Cuentas FICTICIAS de la Empresa Demo de ADEX Online (Ronda 20). Herramienta
// administrativa local, limitada al entorno Demo de ADEX-Staging:
//
//   node --import ./scripts/register-alias.mjs scripts/demo-accounts.ts --setup
//   node --import ./scripts/register-alias.mjs scripts/demo-accounts.ts --finish   (solo Socio y Secretario)
//   node --import ./scripts/register-alias.mjs scripts/demo-accounts.ts --verify
//   node --import ./scripts/register-alias.mjs scripts/demo-accounts.ts --reset <rol>
//
// Reglas que el script se impone a sí mismo:
//   · Solo toca usuarios de Supabase Auth cuyo correo sea `demo.<rol>@example.test`
//     (dominio reservado, nunca recibe correo). No cambia ningún ajuste de Auth ni
//     afecta a usuarios reales: fija la contraseña de ESAS cuentas con la API de
//     administración del proveedor, sin enviar mensajes.
//   · La Empresa Demo se crea por el camino oficial: operador Demo + API de
//     administración Demo publicada (mismo motor y mismas reglas que cualquier empresa).
//     El alta del operador Demo es el paso del administrador de la base previsto en 0011.
//   · Socio y Secretario los da de alta el SuperAdmin Demo con la API normal de
//     usuarios (POST /v1/members), como haría cualquier empresa.
//   · Las contraseñas se generan aquí, se guardan cifradas con DPAPI de Windows (solo
//     este usuario de este equipo puede descifrarlas) en el archivo privado del
//     propietario y NUNCA se imprimen.

import { spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../src/db/pgTypes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'hyqaufsagtsucztjfjvc';
const API = process.env['ADEX_API_URL'] ?? 'https://adex-online-api.onrender.com';
const SLOT = 'principal';
const VAULT = process.env['ADEX_DEMO_VAULT'] ?? path.join(os.homedir(), 'ADEX_PRIVADO', 'demo-credenciales.dpapi');
const fail = (m: string): never => { console.error(`BLOQUEADO: ${m}`); process.exit(2); };

interface Account { key: string; label: string; email: string; displayName: string; role: string | null; seat: string | null }
const ACCOUNTS: readonly Account[] = [
  { key: 'superadmin', label: 'SuperAdmin', email: 'demo.superadmin@example.test', displayName: 'Sara SuperAdmin (Demo)', role: 'superadmin', seat: 'superadmin-invitado' },
  { key: 'admin', label: 'Administrador', email: 'demo.admin@example.test', displayName: 'Andrés Administrador (Demo)', role: 'admin', seat: 'admin-centro' },
  { key: 'cobrador', label: 'Cobrador', email: 'demo.cobrador@example.test', displayName: 'Carlos Cobrador (Demo)', role: 'cobrador', seat: 'cobrador-centro' },
  { key: 'supervisor', label: 'Supervisor', email: 'demo.supervisor@example.test', displayName: 'Sofía Supervisora (Demo)', role: 'supervisor', seat: 'supervisor-centro' },
  { key: 'socio', label: 'Socio', email: 'demo.socio@example.test', displayName: 'Pablo Socio (Demo)', role: 'socio', seat: null },
  { key: 'secretario', label: 'Secretario', email: 'demo.secretario@example.test', displayName: 'Elena Secretaria (Demo)', role: 'secretario', seat: null },
  // Administra el ciclo de vida de la Demo (/demo-admin). No es miembro de ninguna empresa.
  { key: 'operador', label: 'Operador Demo', email: 'demo.operador@example.test', displayName: 'Operador Demo', role: null, seat: null },
];
const DEMO_EMAIL = /^demo\.[a-z]+@example\.test$/;
for (const a of ACCOUNTS) if (!DEMO_EMAIL.test(a.email)) fail(`correo fuera del entorno Demo: ${a.email}`);

const envFile = path.join(root, '.env.staging');
if (!existsSync(envFile)) fail('falta saas/.env.staging');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1]!, m[2]!.trim()]));
if (env['ADEX_STAGING_PROJECT_REF'] !== STAGING_REF) fail('solo se admite ADEX-Staging');
const SB = env['SUPABASE_URL']!;
const adminHeaders = { apikey: env['SUPABASE_SECRET_KEY']!, authorization: `Bearer ${env['SUPABASE_SECRET_KEY']}`, 'content-type': 'application/json' };

// ---------- Bóveda privada (DPAPI, usuario actual) ----------
type Vault = Record<string, { email: string; password: string; label: string }>;
function ps(script: string, input?: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', env: { ...process.env, ADEX_VAULT: VAULT } });
  if (r.status !== 0) fail(`bóveda: PowerShell terminó con ${r.status}`);
  return r.stdout;
}
function readVault(): Vault {
  if (!existsSync(VAULT)) return {};
  const out = ps('$e = (Get-Content -Raw -LiteralPath $env:ADEX_VAULT).Trim(); $s = ConvertTo-SecureString $e; '
    + '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }');
  return JSON.parse(out) as Vault;
}
function writeVault(v: Vault): void {
  mkdirSync(path.dirname(VAULT), { recursive: true });
  ps('$t = [Console]::In.ReadToEnd(); $s = ConvertTo-SecureString $t -AsPlainText -Force; '
    + 'ConvertFrom-SecureString $s | Set-Content -Encoding ascii -LiteralPath $env:ADEX_VAULT', JSON.stringify(v));
  const back = readVault();
  if (JSON.stringify(back) !== JSON.stringify(v)) fail('la bóveda no se pudo verificar tras escribirla');
}
function newPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_.!#%+='];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join('');
}

// ---------- Supabase Auth (solo cuentas demo.*@example.test) ----------
async function findUser(email: string): Promise<{ id: string } | null> {
  const r = await fetch(`${SB}/auth/v1/admin/users?per_page=1000`, { headers: adminHeaders });
  if (!r.ok) fail(`Auth admin respondió ${r.status}`);
  const users = ((await r.json()) as { users?: { id: string; email?: string }[] }).users ?? [];
  return users.find((u) => u.email === email) ?? null;
}
async function setPassword(a: Account, password: string): Promise<string> {
  if (!DEMO_EMAIL.test(a.email)) fail('correo fuera del entorno Demo');
  const existing = await findUser(a.email);
  const res = existing
    ? await fetch(`${SB}/auth/v1/admin/users/${existing.id}`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ password, email_confirm: true }) })
    : await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email: a.email, password, email_confirm: true }) });
  if (!res.ok) fail(`Auth no aceptó la cuenta ${a.key} (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}
async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST',
    headers: { apikey: env['SUPABASE_PUBLISHABLE_KEY']!, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email.split('@')[0]} → ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

// ---------- API publicada ----------
async function api(token: string, method: string, p: string, opts: { membership?: string; body?: unknown; operation?: boolean } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.membership) headers['x-adex-membership'] = opts.membership;
  if (opts.operation) headers['x-adex-operation-id'] = randomUUID();
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }).catch((e: Error) => e);
    // Solo se reintenta lo que no llegó (red / despertar de Render) y es idempotente o lectura.
    if (r instanceof Error || (r.status >= 502 && r.status <= 504)) {
      if (attempt < 6 && (method === 'GET' || method === 'PUT' || opts.operation)) { await new Promise((ok) => setTimeout(ok, 10_000)); continue; }
      throw r instanceof Error ? r : new Error(`${method} ${p} → ${r.status}`);
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, body };
  }
}

const accountsByKey = new Map(ACCOUNTS.map((a) => [a.key, a]));

async function demoMembership(token: string) {
  const r = await api(token, 'GET', '/v1/me/memberships');
  if (r.status !== 200) throw new Error(`memberships ${r.status}`);
  return (r.body['memberships'] as { membershipId: string; role: string; company: { isDemo: boolean } }[])
    .map((m) => ({ membershipId: m.membershipId, role: m.role, isDemo: m.company.isDemo === true }));
}

async function setup() {
  const db = new pg.Client({ connectionString: `postgres://postgres.${STAGING_REF}:${encodeURIComponent(env['SUPABASE_DB_PASSWORD']!)}@${env['SUPABASE_POOLER_HOST']}:5432/postgres`, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const slot = (await db.query<{ state: string }>('select state from adex_demo.slots where slot = $1', [SLOT])).rows[0];
    if (slot && slot.state !== 'empty') fail(`el hueco ${SLOT} no está vacío (${slot.state}): no se crea otra Demo`);
    const demos = (await db.query<{ n: string }>('select count(*) n from adex.companies where is_demo')).rows[0]!.n;
    if (demos !== '0') fail(`ya hay ${demos} empresa(s) Demo: se exige empezar sin ninguna`);

    // 1. Contraseñas nuevas, guardadas ANTES de fijarlas (si algo falla, siguen en la bóveda).
    const vault: Vault = {};
    for (const a of ACCOUNTS) vault[a.key] = { email: a.email, password: newPassword(), label: a.label };
    writeVault(vault);
    const ids: Record<string, string> = {};
    for (const a of ACCOUNTS) ids[a.key] = await setPassword(a, vault[a.key]!.password);
    console.log(`Cuentas Auth listas: ${ACCOUNTS.length} (contraseñas en la bóveda privada)`);

    // 2. Operador Demo (paso del administrador de la base previsto en 0011).
    const op = accountsByKey.get('operador')!;
    await db.query('begin');
    await db.query('insert into adex.identities (id, email) values ($1, $2) on conflict (id) do nothing', [ids['operador'], op.email]);
    await db.query(`insert into adex_demo.operators (identity_id, status, note) values ($1, 'activo', 'Ronda 20: operador ficticio de la Demo única')
                    on conflict (identity_id) do update set status = 'activo', updated_at = now()`, [ids['operador']]);
    await db.query('commit');
    const opToken = await login(op.email, vault['operador']!.password);

    // 3. Personas ficticias en los cuatro puestos asignables (se aplican al crear).
    for (const a of ACCOUNTS.filter((x) => x.seat)) {
      const r = await api(opToken, 'PUT', `/demo/v1/slots/${SLOT}/participants/${a.seat}`, { body: { email: a.email, displayName: a.displayName } });
      if (r.status !== 200) fail(`puesto ${a.seat}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    console.log('Puestos asignados: 4');

    // 4. Crear LA Empresa Demo (una sola vez) y esperar a que quede activa.
    const created = await api(opToken, 'POST', `/demo/v1/slots/${SLOT}/create`, { body: { wait: false } });
    if (created.status !== 202 && created.status !== 200) fail(`crear Demo: ${created.status} ${JSON.stringify(created.body)}`);
    const companyId = String(created.body['companyId']);
    let state = '';
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 5_000));
      const s = await api(opToken, 'GET', `/demo/v1/slots/${SLOT}`);
      state = String(s.body['state']);
      if (state === 'active' || state === 'empty') break;
    }
    if (state !== 'active') fail(`la Demo no quedó activa (estado ${state}); revisar /demo-admin`);
    console.log(`Empresa Demo activa: ${companyId}`);

    // 5. Socio y Secretario: alta normal por el SuperAdmin Demo.
    await addRouteRoles(vault);
  } finally {
    await db.end();
  }
}

/** Socio y Secretario: alta normal por el SuperAdmin Demo en la Ruta Centro. Idempotente. */
async function addRouteRoles(vault: Vault) {
  const saToken = await login(vault['superadmin']!.email, vault['superadmin']!.password);
  const sa = (await demoMembership(saToken)).find((m) => m.isDemo && m.role === 'superadmin');
  if (!sa) fail('el SuperAdmin Demo no tiene su membresía');
  const routes = await api(saToken, 'GET', '/v1/routes', { membership: sa!.membershipId });
  const centro = ((routes.body['routes'] as { id: string; name: string }[]) ?? []).find((r) => r.name.startsWith('Ruta Centro'));
  if (!centro) fail('no se encontró la Ruta Centro');
  const members = await api(saToken, 'GET', '/v1/members', { membership: sa!.membershipId });
  const existing = ((members.body['members'] as { role: string; displayName: string }[]) ?? []);
  for (const a of ACCOUNTS.filter((x) => !x.seat && x.role)) {
    if (existing.some((m) => m.role === a.role && m.displayName === a.displayName)) { console.log(`${a.label}: ya existía`); continue; }
    const r = await api(saToken, 'POST', '/v1/members', { membership: sa!.membershipId, operation: true,
      body: { email: a.email, role: a.role, displayName: a.displayName, routeIds: [centro!.id] } });
    if (r.status !== 201 && r.status !== 200) fail(`alta ${a.key}: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`${a.label}: alta en la Ruta Centro`);
  }
}

async function verify() {
  const vault = readVault();
  let bad = 0;
  for (const a of ACCOUNTS) {
    const v = vault[a.key];
    try {
      if (!v) throw new Error('sin entrada en la bóveda');
      const token = await login(v.email, v.password);
      const ms = await demoMembership(token);
      const ok = a.role ? ms.length === 1 && ms[0]!.isDemo && ms[0]!.role === a.role : ms.length === 0;
      console.log(`${ok ? 'OK ' : 'MAL'} ${a.label.padEnd(14)} ${a.email.padEnd(30)} membresías: ${ms.map((m) => `${m.role}${m.isDemo ? '@Demo' : ''}`).join(', ') || 'ninguna'}`);
      if (!ok) bad++;
    } catch (e) { bad++; console.log(`MAL ${a.label.padEnd(14)} ${a.email.padEnd(30)} ${(e as Error).message}`); }
  }
  if (bad) process.exitCode = 1;
}

async function reset(key: string) {
  const a = accountsByKey.get(key) ?? fail(`rol desconocido: ${key} (use ${ACCOUNTS.map((x) => x.key).join(', ')})`);
  const vault = readVault();
  vault[a.key] = { email: a.email, password: newPassword(), label: a.label };
  writeVault(vault);
  await setPassword(a, vault[a.key]!.password);
  console.log(`Contraseña de ${a.label} renovada y guardada en la bóveda privada.`);
}

const mode = process.argv[2];
if (mode === '--setup') await setup();
else if (mode === '--finish') await addRouteRoles(readVault());
else if (mode === '--verify') await verify();
else if (mode === '--reset') await reset(process.argv[3] ?? '');
else fail('modo: --setup | --finish | --verify | --reset <rol>');
