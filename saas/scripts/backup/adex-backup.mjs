// Respaldo lógico CIFRADO y recurrente de ADEX (Ronda 76, alternativa A aprobada por el propietario el
// 2026-10-26: RS-1 OneDrive como segundo destino, RS-2 clave de recuperación en su gestor de contraseñas,
// RS-3 copia inmediata). Sucesor versionado de los scripts de R73 (`~/ADEX-tools/respaldo-r73.mjs`).
//
// Solo LEE la base gestionada (pg_dump y recuentos en una transacción de solo lectura). Nunca escribe en ella.
// Ninguna salida muestra secretos: credenciales de `saas/.env.staging`, claves en memoria y borradas al terminar.
//
//   cd RutaCash/saas
//   node --import ./scripts/register-alias.mjs scripts/backup/adex-backup.mjs <orden> [opciones]
//
// Órdenes:
//   crear [--motivo diaria|pre-migracion|manual]   volcado + cifrado + copia a OneDrive + poda
//   verificar [--copia adex-AAAAMMDDTHHMM]         restaura (por defecto la última) en un PostgreSQL LOCAL aislado y
//                                                  compara el recuento EXACTO de filas por tabla con el tomado al copiar
//   clave-recuperacion                             (solo el PROPIETARIO, en su terminal) crea la clave de recuperación,
//                                                  la muestra UNA vez para su gestor de contraseñas y envuelve con ella
//                                                  las claves de todas las copias (también las anteriores, sin tocarlas)
//   estado                                         avisa (notificación de Windows) si falló la última copia o si no hay
//                                                  una correcta en las últimas 36 h
//   recuperar --copia adex-… [--carpeta D] [--salida F]
//                                                  SIN este equipo: pide la clave de recuperación (sin mostrarla), descifra
//                                                  la copia (p. ej. desde OneDrive) y deja el volcado listo para pg_restore
//   prueba-recuperacion                            autoprueba con claves sintéticas (no toca ninguna copia real)
//
// Archivos de cada copia `adex-<AAAAMMDDTHHMM>` (carpeta local, acceso solo de este usuario):
//   .dump.enc   volcado pg_dump -Fc cifrado con AES-256-GCM (cabecera ADEXBK1 | iv | tag | datos), como en R73
//   .key.dpapi  clave de datos protegida con DPAPI (solo este usuario en este equipo)       → NO se sube a OneDrive
//   .key.rec    clave de datos envuelta con la clave de recuperación (AES-256-GCM)         → sí se sube
//   .json       metadatos: huella SHA-256, recuentos exactos por tabla (misma instantánea que el volcado), política
// Las copias anteriores a R76 (sin `"politica": "R76"`) NUNCA se podan.

import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAAS = path.resolve(HERE, '..', '..');
const HOME = os.homedir();
// ADEX_RESPALDOS_DIR solo para pruebas de la poda en una carpeta temporal (sin OneDrive).
const LOCAL = process.env.ADEX_RESPALDOS_DIR ?? path.join(HOME, 'ADEX-respaldos');
const CLOUD = process.env.ADEX_RESPALDOS_DIR ? null : process.env.OneDrive ? path.join(process.env.OneDrive, 'ADEX-respaldos') : null;
const BIN = path.join(HOME, 'ADEX-tools', 'pg17', 'pgsql', 'bin');
const KEK_DPAPI = path.join(LOCAL, 'recuperacion.kek.dpapi');
const STATE = path.join(LOCAL, 'estado.json');
const LOG = path.join(LOCAL, 'registro.log');
const SCHEMAS = ['adex', 'adex_control', 'adex_demo', 'adex_meta', 'auth', 'public'];
const POLICY = 'R76';
const RETENTION = { daily: 14, weeklyWeeks: 8, monthlyMonths: 12, preMigrationMonths: 12 };

const pg = createRequire(path.join(SAAS, 'package.json'))('pg');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };

// ---------- utilidades ----------
function readEnv() {
  const env = {};
  for (const l of fs.readFileSync(path.join(SAAS, '.env.staging'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && m[2]) env[m[1]] = m[2].trim();
  }
  for (const k of ['SUPABASE_POOLER_HOST', 'SUPABASE_DB_PASSWORD', 'ADEX_STAGING_PROJECT_REF', 'ADEX_PG_SSL_CA']) if (!env[k]) throw new Error(`falta ${k} en .env.staging`);
  return env;
}
const log = (msg) => { fs.mkdirSync(LOCAL, { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').slice(0, 13);
const dateOfStamp = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00Z`);
const ps = (script, input) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8' });

function dpapiProtect(buf, file) {
  const r = ps(`Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
    + `[IO.File]::WriteAllBytes('${file}', [System.Security.Cryptography.ProtectedData]::Protect($k,$null,'CurrentUser'))`, buf.toString('base64'));
  if (r.status !== 0) throw new Error('DPAPI (proteger) falló');
}
function dpapiUnprotect(file) {
  const r = ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${file}'),$null,'CurrentUser'))`);
  if (r.status !== 0) throw new Error('DPAPI (recuperar) falló');
  return Buffer.from(r.stdout.trim(), 'base64');
}
function seal(key, plain, magic) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from(magic), iv, c.getAuthTag(), enc]);
}
function open(key, blob, magic) {
  if (blob.subarray(0, magic.length).toString() !== magic) throw new Error('formato desconocido');
  const o = magic.length;
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(o, o + 12));
  d.setAuthTag(blob.subarray(o + 12, o + 28));
  return Buffer.concat([d.update(blob.subarray(o + 28)), d.final()]);
}
function notify(title, text) {
  // Notificación de Windows (sin módulos externos). Si no se puede mostrar, queda en el registro.
  const esc = (s) => s.replace(/'/g, "''");
  ps(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; `
    + `$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); `
    + `$t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${esc(text)}')) > $null; `
    + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ADEX respaldos').Show([Windows.UI.Notifications.ToastNotification]::new($x))`);
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (patch) => fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));
function recycle(file) {
  // Regla del espacio de trabajo: lo que se elimina va a la Papelera de reciclaje, nunca se borra en definitiva.
  ps(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${file}','OnlyErrorDialogs','SendToRecycleBin')`);
}
const copies = () => fs.readdirSync(LOCAL).filter((f) => /^adex-\d{8}T\d{4}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();

// ---------- crear ----------
async function crear() {
  const motivo = opt('motivo') ?? 'manual';
  if (!['diaria', 'pre-migracion', 'manual'].includes(motivo)) throw new Error('motivo: diaria | pre-migracion | manual');
  const env = readEnv();
  fs.mkdirSync(LOCAL, { recursive: true });
  const name = `adex-${stampOf()}`;
  const base = path.join(LOCAL, name);
  const plainFile = `${base}.dump`;
  const user = `postgres.${env.ADEX_STAGING_PROJECT_REF}`;
  // 1. Instantánea de solo lectura: los recuentos y el volcado ven exactamente los mismos datos.
  // TLS verificado con el certificado raíz de Supabase (ADEX_PG_SSL_CA), igual que la API publicada.
  const src = new pg.Client({ host: env.SUPABASE_POOLER_HOST, port: 5432, user, password: env.SUPABASE_DB_PASSWORD, database: 'postgres',
    ssl: { ca: fs.readFileSync(env.ADEX_PG_SSL_CA, 'utf8'), rejectUnauthorized: true } });
  await src.connect();
  let counts = {};
  try {
    await src.query('begin isolation level repeatable read read only');
    const snapshot = (await src.query('select pg_export_snapshot() s')).rows[0].s;
    const tables = (await src.query(`select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = any($1) order by 1`, [SCHEMAS])).rows.map((r) => r.t);
    for (const t of tables) { const [s, r] = t.split('.'); counts[t] = Number((await src.query(`select count(*) n from "${s}"."${r}"`)).rows[0].n); }
    const r = spawnSync(path.join(BIN, 'pg_dump.exe'), ['-h', env.SUPABASE_POOLER_HOST, '-p', '5432', '-U', user, '-d', 'postgres', '-Fc', '-Z', '6',
      '--no-password', `--snapshot=${snapshot}`, ...SCHEMAS.flatMap((s) => ['-n', s]), '-f', plainFile],
      { env: { ...process.env, PGPASSWORD: env.SUPABASE_DB_PASSWORD, PGSSLMODE: 'verify-full', PGSSLROOTCERT: env.ADEX_PG_SSL_CA }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`pg_dump falló: ${(r.stderr ?? '').split(env.SUPABASE_DB_PASSWORD).join('***').slice(0, 800)}`);
  } finally {
    await src.query('rollback').catch(() => undefined);
    await src.end();
  }
  // 2. Cifrado con clave de datos aleatoria; la clave se guarda con DPAPI y, si existe, con la clave de recuperación.
  const plain = fs.readFileSync(plainFile);
  const hash = sha(plain);
  const key = randomBytes(32);
  fs.writeFileSync(`${base}.dump.enc`, seal(key, plain, 'ADEXBK1'));
  dpapiProtect(key, `${base}.key.dpapi`);
  let recovery = false;
  if (fs.existsSync(KEK_DPAPI)) {
    const kek = dpapiUnprotect(KEK_DPAPI);
    fs.writeFileSync(`${base}.key.rec`, seal(kek, key, 'ADEXRK1'));
    kek.fill(0);
    recovery = true;
  }
  key.fill(0);
  // 3. Comprobación inmediata: se descifra con la clave recuperada por DPAPI y se compara la huella.
  const k2 = dpapiUnprotect(`${base}.key.dpapi`);
  const ok = sha(open(k2, fs.readFileSync(`${base}.dump.enc`), 'ADEXBK1')) === hash;
  k2.fill(0);
  plain.fill(0);
  fs.rmSync(plainFile);
  if (!ok) throw new Error('el descifrado de comprobación no coincide');
  const meta = { creado: new Date().toISOString(), politica: POLICY, motivo, formato: 'pg_dump -Fc (17)', esquemas: SCHEMAS,
    sha256_volcado: hash, bytes_volcado: fs.statSync(`${base}.dump.enc`).size - 35, tablas: Object.keys(counts).length,
    filas: Object.values(counts).reduce((a, b) => a + b, 0), recuentos: counts,
    cifrado: 'AES-256-GCM; clave de datos con DPAPI CurrentUser' + (recovery ? ' y con la clave de recuperación' : ' (clave de recuperación aún no creada)'),
    verificacion_descifrado: ok };
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2));
  counts = {};
  // 4. Segundo destino (OneDrive): copia cifrada, clave de recuperación envuelta y metadatos. Nunca la clave DPAPI.
  const cloud = toCloud(name);
  // 5. Poda según la política (solo copias R76).
  const pruned = prune();
  writeState({ ultimaCopia: { nombre: name, fecha: meta.creado, motivo, ok: true, recuperacion: recovery, onedrive: cloud }, ultimoFallo: null });
  log(`crear ${name} ok · ${meta.tablas} tablas · ${meta.filas} filas · recuperación=${recovery} · onedrive=${cloud} · podadas=${pruned.length}`);
  console.log(JSON.stringify({ copia: name, tablas: meta.tablas, filas: meta.filas, sha256: `${hash.slice(0, 16)}…`, descifrado_ok: ok,
    clave_recuperacion: recovery, onedrive: cloud, podadas: pruned }));
}

function toCloud(name) {
  if (!CLOUD) return false;
  fs.mkdirSync(CLOUD, { recursive: true });
  for (const ext of ['.dump.enc', '.key.rec', '.json']) {
    const f = path.join(LOCAL, `${name}${ext}`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(CLOUD, `${name}${ext}`));
  }
  return true;
}

// Retención R76: 14 diarias; 1 por semana durante 8 semanas; 1 por mes durante 12 meses; pre-migración 12 meses.
function prune() {
  const now = Date.now();
  const r76 = copies().map((n) => ({ n, m: JSON.parse(fs.readFileSync(path.join(LOCAL, `${n}.json`), 'utf8')) }))
    .filter((x) => x.m.politica === POLICY).map((x) => ({ ...x, t: dateOfStamp(x.n.slice(5)).getTime() })).sort((a, b) => b.t - a.t);
  const keep = new Set(r76.slice(0, RETENTION.daily).map((x) => x.n));
  const firstPer = (keyOf, horizonMs) => {
    const seen = new Set();
    for (const x of r76) {
      if (now - x.t > horizonMs) continue;
      const k = keyOf(new Date(x.t));
      if (!seen.has(k)) { seen.add(k); keep.add(x.n); }
    }
  };
  const day = 86_400_000;
  firstPer((d) => `${d.getUTCFullYear()}-${Math.floor((d.getTime() / day + 3) / 7)}`, RETENTION.weeklyWeeks * 7 * day);
  firstPer((d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`, RETENTION.monthlyMonths * 31 * day);
  for (const x of r76) if (x.m.motivo === 'pre-migracion' && now - x.t <= RETENTION.preMigrationMonths * 31 * day) keep.add(x.n);
  const gone = r76.filter((x) => !keep.has(x.n)).map((x) => x.n);
  for (const n of gone) {
    for (const dir of [LOCAL, CLOUD].filter(Boolean)) {
      for (const ext of ['.dump.enc', '.key.dpapi', '.key.rec', '.json']) {
        const f = path.join(dir, `${n}${ext}`);
        if (fs.existsSync(f)) recycle(f);
      }
    }
  }
  return gone;
}

// ---------- verificar ----------
async function verificar() {
  const list = copies();
  const name = opt('copia') ?? list.filter((n) => JSON.parse(fs.readFileSync(path.join(LOCAL, `${n}.json`), 'utf8')).recuentos).at(-1);
  if (!name) throw new Error('no hay copias con recuentos para verificar');
  const base = path.join(LOCAL, name);
  const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  if (!meta.recuentos) throw new Error(`${name} es anterior a R76 (sin recuentos): use el script de R73 para comparar con la fuente`);
  const key = dpapiUnprotect(`${base}.key.dpapi`);
  const plain = open(key, fs.readFileSync(`${base}.dump.enc`), 'ADEXBK1');
  key.fill(0);
  if (sha(plain) !== meta.sha256_volcado) throw new Error('la huella del volcado no coincide');
  const plainFile = path.join(os.tmpdir(), `${name}.verify-${process.pid}.dump`);
  fs.writeFileSync(plainFile, plain);
  plain.fill(0);
  const { startLocalCluster } = await import(pathToFileURL(path.join(SAAS, 'scripts', 'local-cluster.ts')).href);
  let cluster;
  const result = { copia: name };
  try {
    cluster = await startLocalCluster(`backup-verify-${process.pid}`);
    const adm = new pg.Client({ connectionString: cluster.adminUrl() });
    await adm.connect();
    await adm.query('create database adex_restore');
    for (const r of ['adex_owner', 'adex_api', 'adex_control', 'adex_demo', 'supabase_auth_admin', 'supabase_admin', 'dashboard_user', 'authenticator']) {
      await adm.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
    }
    await adm.end();
    const url = new URL(cluster.adminUrl('adex_restore'));
    const r = spawnSync(path.join(BIN, 'pg_restore.exe'), ['-h', url.hostname, '-p', url.port, '-U', decodeURIComponent(url.username), '-d', 'adex_restore',
      '--no-owner', '--no-privileges', plainFile], { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const errors = (r.stderr ?? '').split('\n').filter((l) => /error:/i.test(l));
    // «schema "public" already exists» es esperado (el clúster nuevo ya trae ese esquema).
    result.erroresInesperados = errors.filter((l) => !/schema "public" already exists/.test(l)).slice(0, 8);
    const dst = new pg.Client({ connectionString: cluster.adminUrl('adex_restore') });
    await dst.connect();
    const diffs = [];
    for (const [t, n] of Object.entries(meta.recuentos)) {
      const [s, rel] = t.split('.');
      const got = Number((await dst.query(`select count(*) n from "${s}"."${rel}"`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);
      if (got !== n) diffs.push({ t, copia: n, restaurado: got });
    }
    result.migraciones = (await dst.query('select max(version) v, count(*)::int n from adex_meta.schema_migrations')).rows[0];
    await dst.end();
    result.tablas = Object.keys(meta.recuentos).length;
    result.filas = meta.filas;
    result.diferencias = diffs;
    result.ok = diffs.length === 0 && result.erroresInesperados.length === 0;
  } finally {
    fs.rmSync(plainFile, { force: true });
    await cluster?.stop().catch(() => undefined);
  }
  writeState({ ultimoEnsayo: { copia: name, fecha: new Date().toISOString(), ok: result.ok, tablas: result.tablas, diferencias: result.diferencias.length } });
  log(`verificar ${name} ok=${result.ok} · ${result.tablas} tablas · ${result.diferencias.length} diferencias · errores=${result.erroresInesperados.length}`);
  if (!result.ok) notify('ADEX: falló el ensayo de restauración', `${name}: ${result.diferencias.length} diferencias. Revise ADEX-respaldos\\registro.log`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

// ---------- clave de recuperación (solo el propietario, en su terminal) ----------
async function claveRecuperacion() {
  if (fs.existsSync(KEK_DPAPI) && !argv.includes('--envolver')) {
    console.log('La clave de recuperación ya existe. Para solo envolver copias nuevas o anteriores sin .key.rec: añada --envolver');
    return;
  }
  let kek;
  if (fs.existsSync(KEK_DPAPI)) {
    kek = dpapiUnprotect(KEK_DPAPI);
  } else {
    kek = randomBytes(32);
    dpapiProtect(kek, KEK_DPAPI);
    const b32 = toBase32(kek);
    console.log('\n=== CLAVE DE RECUPERACIÓN DE LOS RESPALDOS DE ADEX ===');
    console.log('Guárdela AHORA en su gestor de contraseñas (entrada «ADEX respaldos - clave de recuperación»).');
    console.log('Se muestra UNA sola vez. No la envíe por chat ni la pegue en documentos.\n');
    console.log(`    ${b32.match(/.{1,4}/g).join('-')}\n`);
    console.log(`Comprobación (para confirmar que la copió bien): termina en «${b32.slice(-4)}» y su huella es ${sha(kek).slice(0, 8)}.\n`);
  }
  let wrapped = 0;
  for (const n of copies()) {
    const base = path.join(LOCAL, n);
    if (fs.existsSync(`${base}.key.rec`) || !fs.existsSync(`${base}.key.dpapi`)) continue;
    const key = dpapiUnprotect(`${base}.key.dpapi`);
    fs.writeFileSync(`${base}.key.rec`, seal(kek, key, 'ADEXRK1'));
    key.fill(0);
    toCloud(n);
    wrapped++;
  }
  writeState({ claveRecuperacion: { creada: true, huella: sha(kek).slice(0, 8) } });
  kek.fill(0);
  log(`clave-recuperacion: ${wrapped} copias envueltas y subidas a OneDrive`);
  console.log(`Copias protegidas también con la clave de recuperación: ${wrapped} (y subidas a OneDrive).`);
}
function toBase32(buf) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin I, O, 0, 1 (se confunden al copiar)
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error('la clave tiene caracteres no válidos');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  const buf = Buffer.from(out);
  if (buf.length !== 32) throw new Error('la clave de recuperación no tiene la longitud esperada');
  return buf;
}
function decryptWithRecovery(dir, name, kek) {
  const key = open(kek, fs.readFileSync(path.join(dir, `${name}.key.rec`)), 'ADEXRK1');
  const plain = open(key, fs.readFileSync(path.join(dir, `${name}.dump.enc`)), 'ADEXBK1');
  key.fill(0);
  return plain;
}

// ---------- recuperar (sin este equipo) ----------
async function askHidden(question) {
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
async function recuperar() {
  const name = opt('copia');
  const dir = opt('carpeta') ?? CLOUD ?? LOCAL;
  if (!name) throw new Error('indique --copia adex-AAAAMMDDTHHMM');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const kek = fromBase32(await askHidden('Clave de recuperación (no se mostrará): '));
  const plain = decryptWithRecovery(dir, name, kek);
  kek.fill(0);
  if (sha(plain) !== meta.sha256_volcado) throw new Error('la huella no coincide: clave equivocada o archivo dañado');
  const out = opt('salida') ?? path.join(os.tmpdir(), `${name}.dump`);
  fs.writeFileSync(out, plain);
  plain.fill(0);
  console.log(`Volcado descifrado y comprobado (huella correcta): ${out}`);
  console.log('Siga el procedimiento de recuperación (docs/ADEX_PROPUESTA_RESPALDOS_Y_RECUPERACION.md §5) y borre este archivo al terminar: contiene los datos en claro.');
}

// Autoprueba: el mismo camino que una recuperación real, con claves y datos sintéticos generados aquí.
function pruebaRecuperacion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adex-rec-test-'));
  try {
    const data = randomBytes(4096), key = randomBytes(32), kek = randomBytes(32);
    fs.writeFileSync(path.join(dir, 'x.dump.enc'), seal(key, data, 'ADEXBK1'));
    fs.writeFileSync(path.join(dir, 'x.key.rec'), seal(kek, key, 'ADEXRK1'));
    const typed = toBase32(kek).match(/.{1,4}/g).join('-').toLowerCase();   // como la escribiría una persona
    const ok = decryptWithRecovery(dir, 'x', fromBase32(typed)).equals(data);
    let wrongRejected = false;
    try { decryptWithRecovery(dir, 'x', randomBytes(32)); } catch { wrongRejected = true; }
    console.log(JSON.stringify({ base32_ida_y_vuelta: ok, clave_equivocada_rechazada: wrongRejected }));
    if (!ok || !wrongRejected) process.exitCode = 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- estado ----------
function estado() {
  const s = readState();
  const last = s.ultimaCopia?.fecha ? Date.parse(s.ultimaCopia.fecha) : 0;
  const hours = (Date.now() - last) / 3_600_000;
  const problems = [];
  if (s.ultimoFallo) problems.push(`la última copia falló (${s.ultimoFallo.fecha})`);
  if (hours > 36) problems.push(last ? `no hay copia correcta desde hace ${Math.round(hours)} h` : 'no hay ninguna copia R76');
  if (s.ultimoEnsayo && !s.ultimoEnsayo.ok) problems.push('el último ensayo de restauración falló');
  if (!s.claveRecuperacion?.creada) problems.push('falta crear la clave de recuperación');
  if (problems.length) notify('ADEX: revisar respaldos', problems.join('; '));
  console.log(JSON.stringify({ ok: problems.length === 0, problemas: problems, ...s }, null, 2));
}

// ---------- principal ----------
try {
  if (cmd === 'crear') await crear();
  else if (cmd === 'verificar') await verificar();
  else if (cmd === 'clave-recuperacion') await claveRecuperacion();
  else if (cmd === 'estado') estado();
  else if (cmd === 'recuperar') await recuperar();
  else if (cmd === 'podar') console.log(JSON.stringify({ podadas: prune() }));
  else if (cmd === 'prueba-recuperacion') pruebaRecuperacion();
  else { console.log('órdenes: crear | verificar | clave-recuperacion | estado | recuperar | prueba-recuperacion'); process.exitCode = 2; }
} catch (e) {
  const msg = String(e?.message ?? e).slice(0, 500);
  log(`${cmd} FALLÓ: ${msg}`);
  if (cmd === 'crear') {
    writeState({ ultimoFallo: { fecha: new Date().toISOString(), mensaje: msg } });
    notify('ADEX: falló la copia de seguridad', msg.slice(0, 120));
  }
  console.error(`${cmd} falló: ${msg}`);
  process.exitCode = 1;
}
