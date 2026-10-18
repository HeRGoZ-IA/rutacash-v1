// ALTA DEL OWNER de ADEX Soluciones (procedimiento del administrador de la base, Ronda 20).
// Lo ejecuta el PROPIETARIO en SU equipo. El correo se escribe aquí, en su terminal; no
// pasa por chats ni por el repositorio. La contraseña la fija él mismo en el proveedor
// de identidad (Supabase Auth): ADEX no la guarda y este script no la imprime.
//
//   cd saas
//   node --import ./scripts/register-alias.mjs scripts/owner-register.ts              (pregunta correo y nombre; contraseña oculta)
//   node --import ./scripts/register-alias.mjs scripts/owner-register.ts --send-link  (en vez de escribir la contraseña: enlace al correo)
//   node --import ./scripts/register-alias.mjs scripts/owner-register.ts --deactivate (retira el rol Owner de un correo)
//
// Qué hace (y qué NO):
//   1. Crea (o reutiliza) la identidad en Supabase Auth para ese correo.
//   2. Registra la identidad en ADEX y la fila Owner (`adex_control.platform_operators`).
//   3. Contraseña: escrita dos veces sin eco y enviada SOLO al proveedor; o enlace de
//      recuperación que el proveedor envía al correo (vuelve a /owner para fijarla).
//   4. NO crea ninguna membresía: el Owner no es SuperAdmin de ninguna empresa. Si la
//      identidad ya tuviera membresías, se avisa y se detiene (Owner y empresa separados).
//   5. Permite ese correo real en las comprobaciones de staging (por id, en el .env.staging
//      local, ignorado por Git), sin escribir el correo en ningún archivo.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from '../src/db/pgTypes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'hyqaufsagtsucztjfjvc';
const OWNER_PAGE = process.env['ADEX_OWNER_PAGE'] ?? 'https://adex-online.vercel.app/owner/';
const fail = (m: string): never => { console.error(`DETENIDO: ${m}`); process.exit(2); };

const envFile = path.join(root, '.env.staging');
if (!existsSync(envFile)) fail('falta saas/.env.staging en este equipo');
const raw = readFileSync(envFile, 'utf8');
const env = Object.fromEntries(raw.split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
  .filter((m): m is RegExpExecArray => Boolean(m)).map((m) => [m[1]!, m[2]!.trim()]));
if (env['ADEX_STAGING_PROJECT_REF'] !== STAGING_REF) fail('solo se admite el proyecto ADEX-Staging');
const SB = env['SUPABASE_URL']!;
const admin = { apikey: env['SUPABASE_SECRET_KEY']!, authorization: `Bearer ${env['SUPABASE_SECRET_KEY']}`, 'content-type': 'application/json' };

// ---------- Entrada por terminal (la contraseña sin eco) ----------
let piped: string[] | null = null;
async function line(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) {
    // Sin terminal (pruebas automatizadas): una respuesta por línea desde stdin, sin eco.
    piped ??= await new Promise<string[]>((resolve) => { let b = ''; process.stdin.on('data', (d) => { b += d; }); process.stdin.on('end', () => resolve(b.split(/\r?\n/))); });
    process.stdout.write(`${question}${hidden ? '(oculto)' : ''}\n`);
    return (piped.shift() ?? '').trim();
  }
  if (!hidden) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let v = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stdout.write('\n'); resolve(v); return;
        }
        if (ch === '\u007f' || ch === '\b') v = v.slice(0, -1); else v += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function findUser(email: string): Promise<{ id: string } | null> {
  for (let page = 1; page < 50; page++) {
    const r = await fetch(`${SB}/auth/v1/admin/users?per_page=200&page=${page}`, { headers: admin });
    if (!r.ok) fail(`el proveedor de identidad respondió ${r.status}`);
    const users = ((await r.json()) as { users?: { id: string; email?: string }[] }).users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

const db = new pg.Client({ connectionString: `postgres://postgres.${STAGING_REF}:${encodeURIComponent(env['SUPABASE_DB_PASSWORD']!)}@${env['SUPABASE_POOLER_HOST']}:5432/postgres`,
  ssl: { rejectUnauthorized: false } });

const deactivate = process.argv.includes('--deactivate');
const sendLink = process.argv.includes('--send-link');

console.log('\nADEX Soluciones · alta del Owner (sus datos se escriben solo en este equipo)\n');
const email = (await line('Correo personal del Owner: ')).toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) fail('correo no válido');

await db.connect();
try {
  if (deactivate) {
    const u = await findUser(email);
    const r = u ? await db.query(`update adex_control.platform_operators set status = 'inactivo', updated_at = now() where identity_id = $1`, [u.id]) : null;
    console.log(r?.rowCount ? 'Rol Owner retirado. La identidad sigue existiendo, sin acceso al panel Owner.' : 'Ese correo no era Owner.');
    process.exit(0);
  }
  const displayName = (await line('Nombre visible en el panel (p. ej. su nombre): ')) || 'Owner ADEX';
  if (displayName.length > 80) fail('nombre demasiado largo');

  // 1. Identidad en el proveedor (sin contraseña conocida por nadie todavía).
  let user = await findUser(email);
  if (!user) {
    const c = await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, email_confirm: true }) });
    if (!c.ok) fail(`el proveedor no aceptó el alta (${c.status})`);
    user = (await c.json()) as { id: string };
    console.log('Identidad creada en el proveedor.');
  } else {
    console.log('La identidad ya existía en el proveedor: se reutiliza.');
  }

  // 2. Owner y empresa separados: nada de membresías.
  const ms = await db.query<{ n: string }>('select count(*) n from adex.memberships where identity_id = $1', [user.id]);
  if (ms.rows[0]!.n !== '0') fail('ese correo ya es miembro de alguna empresa. Use para el Owner un correo distinto al de su usuario de empresa.');

  await db.query('begin');
  await db.query('insert into adex.identities (id, email) values ($1, $2) on conflict (id) do nothing', [user.id, email]);
  await db.query(`insert into adex_control.platform_operators (id, identity_id, display_name, role, status, created_at, updated_at)
                  values ($1, $2, $3, 'owner', 'activo', now(), now())
                  on conflict (identity_id) do update set status = 'activo', display_name = excluded.display_name, updated_at = now()`,
    [randomUUID(), user.id, displayName]);
  await db.query('commit');
  console.log('Rol Owner registrado (sin membresías en empresas).');

  // 3. Permitir esta identidad real en las comprobaciones de staging (por id, archivo local ignorado por Git).
  const key = 'ADEX_STAGING_REAL_OWNER_IDS';
  const ids = new Set((env[key] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  if (!ids.has(user.id) && !email.endsWith('@example.test')) {
    ids.add(user.id);
    const next = raw.includes(`${key}=`) ? raw.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${[...ids].join(',')}`) : `${raw.replace(/\s*$/, '\n')}${key}=${[...ids].join(',')}\n`;
    writeFileSync(envFile, next);
  }

  // 4. Contraseña: solo el propietario la conoce.
  if (sendLink) {
    const r = await fetch(`${SB}/auth/v1/recover`, { method: 'POST', headers: { apikey: env['SUPABASE_PUBLISHABLE_KEY']!, 'content-type': 'application/json' },
      body: JSON.stringify({ email, redirect_to: OWNER_PAGE }) });
    if (r.status >= 500) fail('el proveedor no pudo enviar el enlace');
    console.log(`\nEnlace enviado a su correo. Ábralo en el navegador: le llevará a ${OWNER_PAGE} para fijar la contraseña.`);
    console.log('Si el enlace le lleva a otra dirección, el proveedor aún no admite esa página: use este script sin --send-link.');
  } else {
    const a = await line('Elija su contraseña (12+ caracteres, no se muestra): ', true);
    const b = await line('Repítala: ', true);
    if (a !== b) fail('las contraseñas no coinciden; no se cambió nada de la contraseña');
    if (a.length < 12) fail('use al menos 12 caracteres');
    const r = await fetch(`${SB}/auth/v1/admin/users/${user.id}`, { method: 'PUT', headers: admin, body: JSON.stringify({ password: a }) });
    if (!r.ok) fail(`el proveedor rechazó la contraseña (${r.status}); pruebe una más larga o variada`);
    console.log('Contraseña fijada en el proveedor de identidad. ADEX no la guarda.');
  }
  console.log(`\nListo. Entre en ${OWNER_PAGE} con ese correo (cuando el panel Owner esté publicado).\n`);
} catch (err) {
  await db.query('rollback').catch(() => undefined);
  fail((err as Error).message);
} finally {
  await db.end().catch(() => undefined);
}
