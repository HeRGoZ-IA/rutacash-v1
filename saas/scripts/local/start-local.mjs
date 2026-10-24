// ADEX · entorno LOCAL de prueba de «Base por Ruta» para el propietario (versionado desde R74; ver README.md).
// 100 % local y SINTÉTICO: PostgreSQL embebido PERSISTENTE (tmp/local/main/pgdata), TODAS las migraciones
// de la rama, la API de empresa REAL (createCompanyHandler), un emisor JWT local que imita el endpoint de
// token de Supabase (NO es Supabase) y el BUILD DE PRODUCCIÓN de ADEX Online. Nada de ADEX-Staging,
// Supabase, Render, Vercel, BlueLine ni Owners reales: no se lee ningún .env.
//
//   cd saas
//   npm run local:start -- [--reset] [--build] [--head]
//   (equivale a: node --import ./scripts/register-alias.mjs scripts/local/start-local.mjs ...)
//
// El script vive en saas/scripts/local/ (versionado) pero TODO lo que genera (datos de PostgreSQL, estado con las
// claves locales, registros, build, copia de HEAD) va a tmp/local/ (ignorada por Git), nunca a la carpeta versionada.
//
//   --reset        borra la base local y vuelve a sembrar los datos sintéticos
//   --build        reconstruye ADEX Online aunque no haya cambios
//   --head         usa una copia del último commit (git archive HEAD → tmp/local/saas-head) en lugar de
//                  los archivos de trabajo (si otro trabajo en curso dejó saas/ u online/ rotos)
//   --instance X   instancia aparte (datos en tmp/local/X/, puertos --port-base); la usan smoke-local.mjs y e2e
//   --port-base N  web = N, API = N+1, PostgreSQL = N+2 (por defecto 5600; instancias ≠ main: 5610)
//   --check        arranca todo, muestra la tabla y se detiene (comprobación rápida)
//
// Se detiene con Ctrl+C (o escribiendo «stop» + Enter): cierra la web, la API y PostgreSQL limpiamente.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto, { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, register } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.noDeprecation = true; // avisos internos de pg ajenos a este entorno
const HERE = path.dirname(fileURLToPath(import.meta.url)); // saas/scripts/local (versionado: solo código)
const ROOT = path.resolve(HERE, '..', '..', '..');
/** Todo lo generado vive aquí (ignorado por Git). */
const OUT_ROOT = path.join(ROOT, 'tmp', 'local');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const INSTANCE = opt('--instance', 'main');
if (!/^[a-z0-9-]{1,20}$/.test(INSTANCE)) throw new Error('--instance inválido');
const PORT_BASE = Number(opt('--port-base', INSTANCE === 'main' ? '5600' : '5610'));
const WEB_PORT = PORT_BASE, API_PORT = PORT_BASE + 1, PG_PORT = PORT_BASE + 2;
const WEB = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${API_PORT}`;
const INST_DIR = path.join(OUT_ROOT, INSTANCE);
const PGDATA = path.join(INST_DIR, 'pgdata');
const STATE_FILE = path.join(INST_DIR, 'state.json');
const LOGS = path.join(OUT_ROOT, 'logs');
const DIST = path.join(OUT_ROOT, 'dist');
/** La URL de la API queda fija en el build; se sustituye al servir (un solo build para cualquier puerto). */
const API_PLACEHOLDER = 'http://adex-local-api.invalid';
export const SHARED_PASSWORD = 'adex-local-2026';
const DB_NAME = 'adex_local';
const OWNER_EMAIL = 'owner.local@example.test';
for (const p of [INST_DIR, PGDATA, STATE_FILE, LOGS, DIST]) {
  if (!path.resolve(p).startsWith(OUT_ROOT + path.sep)) throw new Error(`ruta fuera de tmp/local: ${p}`);
}
fs.mkdirSync(INST_DIR, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

// ---------------------------------------------------------------- registro
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const LOG_FILE = path.join(LOGS, `${INSTANCE}-${stamp}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const log = (...a) => { const s = a.join(' '); console.log(s); logStream.write(s + '\n'); };
const logOnly = (...a) => logStream.write(a.join(' ') + '\n');

// ---------------------------------------------------------------- código a ejecutar (trabajo o HEAD)
let SAAS = path.join(ROOT, 'saas');
let ONLINE = path.join(ROOT, 'online');
if (flag('--head')) {
  const HEAD_DIR = path.join(OUT_ROOT, 'saas-head');
  const headSha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const marker = path.join(HEAD_DIR, '.head');
  if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== headSha) {
    log(`Preparando la copia del commit ${headSha} en tmp/local/saas-head ...`);
    fs.rmSync(HEAD_DIR, { recursive: true, force: true });
    fs.mkdirSync(HEAD_DIR, { recursive: true });
    const tops = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n');
    const want = ['saas', 'online', 'src', 'public', 'tailwind.config.js', 'postcss.config.js', 'package.json', 'tsconfig.json', 'tsconfig.node.json', 'index.html'].filter((x) => tops.includes(x));
    const tar = path.join(HEAD_DIR, 'head.tar');
    execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, 'HEAD', ...want]);
    // Ruta relativa: el tar de Git Bash interpreta «C:\...» como un servidor remoto.
    execFileSync('tar', ['-xf', 'head.tar'], { cwd: HEAD_DIR });
    fs.rmSync(tar);
    fs.symlinkSync(path.join(ROOT, 'saas', 'node_modules'), path.join(HEAD_DIR, 'saas', 'node_modules'), 'junction');
    fs.symlinkSync(path.join(ROOT, 'online', 'node_modules'), path.join(HEAD_DIR, 'online', 'node_modules'), 'junction');
    fs.writeFileSync(marker, headSha);
  }
  SAAS = path.join(HEAD_DIR, 'saas');
  ONLINE = path.join(HEAD_DIR, 'online');
  // Los ganchos registrados después se consultan primero: `@/` → src/ de la copia.
  register(pathToFileURL(path.join(SAAS, 'scripts', 'alias-hooks.mjs')).href, pathToFileURL(path.join(SAAS, 'scripts', 'register-alias.mjs')).href);
  log(`Código: copia de HEAD ${headSha} (tmp/local/saas-head)`);
}
const S = (p) => pathToFileURL(path.join(SAAS, p)).href;
const req = createRequire(path.join(SAAS, 'package.json'));

// ---------------------------------------------------------------- estado persistente
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const secret = () => randomBytes(18).toString('base64url');

// ---------------------------------------------------------------- PostgreSQL (binarios de embedded-postgres, pg_ctl)
const platformPkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const PGBIN = path.join(ROOT, 'saas', 'node_modules', ...platformPkg.split('/'), 'native', 'bin');
if (!fs.existsSync(PGBIN)) throw new Error(`No se encuentran los binarios de PostgreSQL (${PGBIN}). Ejecuta «npm install» dentro de saas/.`);
const exe = (n) => path.join(PGBIN, process.platform === 'win32' ? `${n}.exe` : n);
const PG_LOG = path.join(LOGS, `postgres-${INSTANCE}.log`);
const pgRunning = () => spawnSync(exe('pg_ctl'), ['status', '-D', PGDATA], { windowsHide: true }).status === 0;
let pgStarted = false;
function pgStop() {
  if (!fs.existsSync(path.join(PGDATA, 'postmaster.pid'))) return true;
  const r = spawnSync(exe('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w', '-t', '60'], { windowsHide: true, encoding: 'utf8' });
  logOnly('[pg_ctl stop]', r.status, (r.stdout ?? '') + (r.stderr ?? ''));
  return !pgRunning();
}
async function pgStart() {
  if (pgRunning()) {
    log('Había un PostgreSQL de una ejecución anterior sobre estos datos: se detiene y se vuelve a arrancar.');
    pgStop();
  }
  const args = ['start', '-D', PGDATA, '-w', '-t', '90', '-l', PG_LOG, '-o',
    `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c max_connections=80 -c deadlock_timeout=200ms`];
  // Proceso aparte (sin consola compartida): Ctrl+C llega solo a este script, que lo detiene en orden.
  const code = await new Promise((resolve) => {
    const p = spawn(exe('pg_ctl'), args, { stdio: 'ignore', windowsHide: true, detached: true });
    p.on('exit', resolve);
    p.on('error', () => resolve(-1));
  });
  if (code !== 0 || !pgRunning()) throw new Error(`PostgreSQL no arrancó (pg_ctl=${code}). Revisa ${path.relative(ROOT, PG_LOG)}; ¿está ocupado el puerto ${PG_PORT}?`);
  pgStarted = true;
}

// ---------------------------------------------------------------- servidores y cierre ordenado
let apiServer = null, webServer = null, pools = [];
let closing = false;
async function shutdown(code, why) {
  if (closing) return;
  closing = true;
  if (why) log(`\nDeteniendo (${why}) ...`);
  for (const s of [webServer, apiServer]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  for (const p of pools) await p.end().catch(() => undefined);
  if (pgStarted) log(pgStop() ? 'PostgreSQL detenido limpiamente.' : `ATENCIÓN: PostgreSQL no se detuvo; revisa ${path.relative(ROOT, PG_LOG)}`);
  log(`Registro: ${path.relative(ROOT, LOG_FILE)}`);
  await new Promise((r) => logStream.end(r));
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => void shutdown(0, sig === 'SIGINT' ? 'Ctrl+C' : sig));
process.on('uncaughtException', (e) => { if (closing) return; log('ERROR:', String(e?.stack ?? e)); void shutdown(1); });
process.on('unhandledRejection', (e) => { if (closing) return; log('ERROR:', String(e?.stack ?? e)); void shutdown(1); });
if (process.stdin.readable) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false }).on('line', (l) => { if (/^\s*(stop|salir|parar)\s*$/i.test(l)) void shutdown(0, 'stop'); });
  rl.on('SIGINT', () => void shutdown(0, 'Ctrl+C'));
}

// ---------------------------------------------------------------- JWT local con forma de Supabase (ES256)
function makeIssuer(state, issuerUrl) {
  const priv = crypto.createPrivateKey({ key: state.jwk.private, format: 'jwk' });
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  return {
    jwks: { keys: [{ ...state.jwk.public, kid: state.jwk.kid, alg: 'ES256', use: 'sig' }] },
    issue(identityId, email, sessionId = randomUUID()) {
      const iat = Math.floor(Date.now() / 1000);
      const head = b64({ alg: 'ES256', kid: state.jwk.kid, typ: 'JWT' });
      const body = b64({ sub: identityId, iss: issuerUrl, aud: 'authenticated', iat, exp: iat + 3600, role: 'authenticated', session_id: sessionId, aal: 'aal1', email: email ?? undefined });
      const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return { token: `${head}.${body}.${sig}`, exp: iat + 3600 };
    },
  };
}

// ---------------------------------------------------------------- proveedor de identidad local (memoria + adex.identities)
function makeProvider() {
  const ids = new Map(); // correo → identidad
  const links = new Map(); // token de primer acceso → identidad
  return {
    ids, links,
    emailOf(id) { for (const [e, v] of ids) if (v === id) return e; return null; },
    async ensureIdentity(email) {
      const e = email.trim().toLowerCase();
      if (ids.has(e)) return { identityId: ids.get(e), created: false };
      const id = randomUUID();
      ids.set(e, id);
      return { identityId: id, created: true };
    },
    async issueAccessLink(identityId) {
      const tokenHash = randomUUID().replaceAll('-', '');
      links.set(tokenHash, identityId);
      return { status: 'issued', tokenHash };
    },
    async changeEmail(identityId, email) {
      const e = email.trim().toLowerCase();
      const holder = ids.get(e);
      if (holder && holder !== identityId) return { status: 'taken' };
      for (const [k, v] of ids) if (v === identityId) ids.delete(k);
      ids.set(e, identityId);
      return { status: 'changed' };
    },
    async signOut() {},
  };
}

// ---------------------------------------------------------------- build de ADEX Online
function newestMtime(p) {
  let t = 0;
  const walk = (x) => {
    let st;
    try { st = fs.statSync(x); } catch { return; }
    if (st.isDirectory()) { if (path.basename(x) === 'node_modules' || path.basename(x) === 'dist') return; for (const f of fs.readdirSync(x)) walk(path.join(x, f)); }
    else if (st.mtimeMs > t) t = st.mtimeMs;
  };
  walk(p);
  return t;
}
async function ensureBuild() {
  const STAMP = path.join(DIST, '.adex-local-build.json');
  const prev = fs.existsSync(STAMP) ? JSON.parse(fs.readFileSync(STAMP, 'utf8')) : null;
  const sourceRoot = path.dirname(ONLINE);
  const srcTime = Math.max(...[path.join(ONLINE, 'src'), path.join(ONLINE, 'index.html'), path.join(ONLINE, 'vite.config.ts'), path.join(sourceRoot, 'src'), path.join(sourceRoot, 'public')].map(newestMtime));
  const reason = flag('--build') ? 'se pidió --build' : !prev || !fs.existsSync(path.join(DIST, 'index.html')) ? 'no existe todavía'
    : prev.online !== ONLINE ? 'cambió el origen del código' : srcTime > prev.builtAt ? 'hay cambios en online/ o src/ desde el último build' : null;
  if (!reason) { log(`ADEX Online: build existente (${new Date(prev.builtAt).toLocaleString('es')}).`); return; }
  log(`Construyendo ADEX Online (build de producción; ${reason}) ... puede tardar 1-3 minutos.`);
  const BUILD_LOG = path.join(LOGS, `build-${stamp}.log`);
  const out = fs.createWriteStream(BUILD_LOG);
  const tmpDist = path.join(OUT_ROOT, 'dist-tmp');
  fs.rmSync(tmpDist, { recursive: true, force: true });
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const b = spawn(process.execPath, [path.join(ONLINE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', tmpDist, '--emptyOutDir'], {
      cwd: ONLINE, windowsHide: true,
      env: { ...process.env, VITE_ADEX_API_URL: API_PLACEHOLDER, VITE_SUPABASE_URL: API_PLACEHOLDER, VITE_ADEX_CONTROL_URL: API_PLACEHOLDER, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_sintetica' } });
    b.stdout.pipe(out); b.stderr.pipe(out);
    b.on('close', resolve);
  });
  if (code === 0 && fs.existsSync(path.join(tmpDist, 'index.html'))) {
    fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 5 });
    // Windows puede bloquear un momento la carpeta recién escrita: reintento y, si no, copia.
    let moved = false;
    for (let i = 0; i < 5 && !moved; i++) {
      try { fs.renameSync(tmpDist, DIST); moved = true; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!moved) { fs.cpSync(tmpDist, DIST, { recursive: true }); fs.rmSync(tmpDist, { recursive: true, force: true, maxRetries: 5 }); }
    fs.writeFileSync(STAMP, JSON.stringify({ builtAt: Date.now(), online: ONLINE }));
    log(`Build listo en ${Math.round((Date.now() - t0) / 1000)} s (registro: ${path.relative(ROOT, BUILD_LOG)}).`);
  } else if (fs.existsSync(path.join(DIST, 'index.html'))) {
    log(`ATENCIÓN: el build falló (exit ${code}); se sirve el build anterior. Registro: ${path.relative(ROOT, BUILD_LOG)}. Prueba --head si hay trabajo en curso.`);
  } else {
    throw new Error(`El build de ADEX Online falló (exit ${code}). Registro: ${path.relative(ROOT, BUILD_LOG)}. Prueba con --head.`);
  }
}

// ================================================================ arranque
log(`ADEX · entorno local de Base por Ruta · instancia «${INSTANCE}» · ${new Date().toLocaleString('es')}`);
log(`Rama: ${execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()} @ ${execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`);

if (flag('--reset')) {
  log('--reset: se borran la base local y el estado de esta instancia.');
  if (fs.existsSync(path.join(PGDATA, 'postmaster.pid'))) pgStop();
  fs.rmSync(PGDATA, { recursive: true, force: true });
  fs.rmSync(STATE_FILE, { force: true });
}

let state = loadState();
const fresh = !fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
if (fresh) {
  const pub = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  state = {
    createdAt: new Date().toISOString(),
    boot: secret(),
    passwords: { admin: secret(), api: secret(), control: secret(), demo: secret() },
    jwk: { kid: randomUUID(), private: pub.privateKey.export({ format: 'jwk' }), public: pub.publicKey.export({ format: 'jwk' }) },
    customPasswords: {},
    seeded: false,
  };
  saveState(state);
  log('Creando la base local (initdb) en ' + path.relative(ROOT, PGDATA).replaceAll('\\', '/') + ' ...');
  fs.mkdirSync(PGDATA, { recursive: true });
  const pw = path.join(INST_DIR, '.pwfile');
  fs.writeFileSync(pw, state.boot);
  try {
    // En Windows, el antivirus o el indexador a veces bloquean un instante un archivo recién creado
    // («could not rename file ... Permission denied»): se reintenta.
    for (let i = 1; ; i++) {
      try {
        execFileSync(exe('initdb'), ['-D', PGDATA, '-U', 'supabase_admin', `--pwfile=${pw}`, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C'], { stdio: 'pipe', windowsHide: true });
        break;
      } catch (e) {
        logOnly('[initdb]', String(e.stderr ?? e));
        if (i >= 4) throw new Error(`initdb falló ${i} veces: ${String(e.stderr ?? e).split('\n').find((l) => /PANIC|FATAL|error/i.test(l)) ?? e.message}`);
        log(`  initdb falló (intento ${i}; suele ser un bloqueo momentáneo de Windows); se reintenta ...`);
        fs.rmSync(PGDATA, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, 3000 * i));
        fs.mkdirSync(PGDATA, { recursive: true });
      }
    }
  } finally { fs.rmSync(pw, { force: true }); }
} else if (!state) {
  throw new Error(`Hay datos en ${path.relative(ROOT, PGDATA)} pero falta ${path.relative(ROOT, STATE_FILE)}: ejecuta con --reset.`);
}

await pgStart();
log(`PostgreSQL local en 127.0.0.1:${PG_PORT} (datos: ${path.relative(ROOT, PGDATA)}).`);

const pg = (await import(S('src/db/pgTypes.ts'))).default;
const url = (user, pass, db = 'postgres') => `postgres://${user}:${encodeURIComponent(pass)}@127.0.0.1:${PG_PORT}/${db}`;
if (fresh) {
  const c = new pg.Client({ connectionString: url('supabase_admin', state.boot) });
  await c.connect();
  // Roles con los privilegios de un proyecto Supabase (igual que saas/scripts/local-cluster.ts). NO es Supabase.
  await c.query(`create role postgres login nosuperuser createrole createdb bypassrls password '${state.passwords.admin}'`);
  await c.query('grant create on database postgres to postgres');
  await c.query('create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls');
  await c.query(`create role authenticator login noinherit password '${secret()}'; grant anon, authenticated, service_role to authenticator`);
  await c.query('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role');
  await c.end();
  const a = new pg.Client({ connectionString: url('postgres', state.passwords.admin) });
  await a.connect(); await a.query(`create database ${DB_NAME}`); await a.end();
}

// ---------- migraciones de la rama (todas las presentes en saas/db/migrations)
const { migrate, readMigrations } = await import(S('src/db/migrate.ts'));
const files = readMigrations();
const dirty = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'saas/db/migrations'], { encoding: 'utf8' }).stdout.trim();
if (dirty && !flag('--head')) log(`ATENCIÓN: hay migraciones sin commit (trabajo en curso):\n${dirty}`);
{
  const m = new pg.Client({ connectionString: url('postgres', state.passwords.admin, DB_NAME) });
  await m.connect();
  let res;
  try {
    res = await migrate(m, { api: state.passwords.api, control: state.passwords.control, demo: state.passwords.demo }, files);
  } catch (e) {
    await m.end();
    if (/checksum mismatch/.test(String(e))) throw new Error(`${e.message}\nUna migración ya aplicada cambió en la rama. Vuelve a crear la base: añade --reset al comando.`);
    throw new Error(`${e.message}\nSi es una migración en preparación (sin commit) de otro trabajo, inténtalo más tarde o arranca con --head (último commit).`);
  }
  await m.end();
  const all = files.map((f) => f.name);
  log(`Migraciones de la rama: ${all.length} (${all[0]?.slice(0, 4)}–${all.at(-1)?.slice(0, 4)}) · última: ${all.at(-1)}`);
  log(res.applied.length ? `  aplicadas ahora: ${res.applied.join(', ')}` : '  ya estaban todas aplicadas.');
  state.migrations = all;
  saveState(state);
}

// ---------- pools, emisor, proveedor y API real
const mkPool = (user, pass, max) => { const p = new pg.Pool({ connectionString: url(user, pass, DB_NAME), max, idleTimeoutMillis: 30_000 }); p.on('error', (e) => logOnly('[pool]', String(e))); pools.push(p); return p; };
const adminPool = mkPool('postgres', state.passwords.admin, 4);
const apiPool = mkPool('adex_api', state.passwords.api, 20);
const controlPool = mkPool('adex_control', state.passwords.control, 3);

const ISSUER_URL = `${API}/auth/v1`;
const issuer = makeIssuer(state, ISSUER_URL);
const { createTokenVerifier } = await import(S('src/auth/jwt.ts'));
const verifyToken = createTokenVerifier({ issuer: ISSUER_URL, jwks: issuer.jwks });
const provider = makeProvider();
for (const r of (await adminPool.query('select id::text id, email from adex.identities')).rows) provider.ids.set(r.email, r.id);
const ownerId = provider.ids.get(OWNER_EMAIL) ?? null;

const { createCompanyHandler } = await import(S('src/http/companyApi.ts'));
const { API_FEATURES } = await import(S('src/server/app.ts'));
const apiErrors = [];
const companyHandler = createCompanyHandler({ pool: apiPool, verifyToken, provider, onError: (e) => { apiErrors.push(e); logOnly('[api error]', String(e?.stack ?? e)); } });

// ---------- servidor de la API + autenticación local (puerto API_PORT)
const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch { resolve({}); } }); });
const tokenSet = (id, session = randomUUID()) => {
  const email = provider.emailOf(id);
  const t = issuer.issue(id, email, session);
  return { access_token: t.token, token_type: 'bearer', expires_in: 3600, expires_at: t.exp, refresh_token: `r:${id}:${session}`,
    user: { id, aud: 'authenticated', role: 'authenticated', email } };
};
const passwordOf = (id) => state.customPasswords?.[id] ?? SHARED_PASSWORD;
async function authRoute(req, res, u) {
  const p = u.pathname;
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const b = await readBody(req);
    const grant = u.searchParams.get('grant_type');
    if (grant === 'password') {
      const email = String(b.email ?? '').trim().toLowerCase();
      const id = provider.ids.get(email);
      // El Owner de la plataforma no entra por aquí (el panel Owner queda fuera de este entorno).
      if (!id || email === OWNER_EMAIL || String(b.password ?? '') !== passwordOf(id)) {
        logOnly(`[auth] inicio de sesión rechazado: ${email}`);
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      logOnly(`[auth] inicio de sesión: ${email}`);
      return sendJson(res, 200, tokenSet(id));
    }
    if (grant === 'refresh_token') {
      const m = /^r:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(String(b.refresh_token ?? ''));
      if (!m || !provider.emailOf(m[1])) return sendJson(res, 400, { error: 'invalid_grant' });
      return sendJson(res, 200, tokenSet(m[1], m[2]));
    }
    return sendJson(res, 400, { error: 'unsupported_grant_type' });
  }
  if (p === '/auth/v1/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const id = provider.links.get(String(b.token_hash ?? ''));
    if (!id) return sendJson(res, 403, { error: 'otp_expired' });
    provider.links.delete(String(b.token_hash));
    return sendJson(res, 200, tokenSet(id));
  }
  if (p === '/auth/v1/user') {
    let claims;
    try { claims = await verifyToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')); } catch { return sendJson(res, 401, { error: 'bad_jwt' }); }
    if (req.method === 'PUT') {
      const b = await readBody(req);
      const pw = String(b.password ?? '');
      if (pw.length < 8) return sendJson(res, 422, { error_code: 'weak_password' });
      if (pw === passwordOf(claims.identityId)) return sendJson(res, 422, { error_code: 'same_password' });
      state.customPasswords = { ...(state.customPasswords ?? {}), [claims.identityId]: pw };
      saveState(state);
      log(`[auth] ${provider.emailOf(claims.identityId)} fijó su propia contraseña (primer acceso local).`);
    }
    return sendJson(res, 200, { id: claims.identityId, email: provider.emailOf(claims.identityId), aud: 'authenticated' });
  }
  if (p === '/auth/v1/recover') return sendJson(res, 200, {});
  if (p === '/auth/v1/logout') { res.writeHead(204); return void res.end(); }
  return sendJson(res, 404, { error: 'not_found' });
}
apiServer = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, apikey, x-client-info, x-adex-membership, x-adex-operation-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return void res.end(); }
  const u = new URL(req.url ?? '/', API);
  const t0 = Date.now();
  res.on('finish', () => logOnly(`[http] ${req.method} ${u.pathname} ${res.statusCode} ${Date.now() - t0}ms`));
  if (u.pathname === '/healthz') return sendJson(res, 200, { status: 'ok', service: 'adex-local', features: API_FEATURES });
  if (u.pathname === '/readyz') return void adminPool.query('select 1').then(() => sendJson(res, 200, { status: 'ready' }), () => sendJson(res, 503, { status: 'down' }));
  if (u.pathname.startsWith('/auth/v1/')) return void authRoute(req, res, u).catch((e) => { logOnly('[auth error]', String(e?.stack ?? e)); sendJson(res, 500, { error: 'internal' }); });
  void companyHandler(req, res);
});
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(API_PORT, '127.0.0.1', resolve); }).catch((e) => {
  throw new Error(`No se pudo abrir el puerto ${API_PORT} (${e.code}). ¿Ya hay otro entorno local abierto?`);
});

// ---------- siembra sintética (primera vez o --reset), por la API real
if (!state.seeded) {
  if (!fresh) throw new Error('La siembra anterior no terminó. Vuelve a empezar con --reset.');
  const { seed } = await import(pathToFileURL(path.join(HERE, 'seed.mjs')).href);
  const { createControlApi } = await import(S('src/http/controlApi.ts'));
  // Operador de la plataforma SINTÉTICO, solo para dar de alta las empresas por la API Owner (en producción
  // los Owners también se provisionan fuera de la API). No puede iniciar sesión en este entorno.
  const oid = randomUUID();
  await adminPool.query(`insert into adex.identities (id, email, status) values ($1, $2, 'active')`, [oid, OWNER_EMAIL]);
  await adminPool.query(`insert into adex_control.platform_operators (id, identity_id, display_name, role, status, created_at, updated_at)
                         values ($1, $2, 'Owner local sintético', 'owner', 'activo', now(), now())`, [randomUUID(), oid]);
  provider.ids.set(OWNER_EMAIL, oid);
  const controlServer = createControlApi({ pool: controlPool, verifyToken, provider, onError: (e) => logOnly('[control error]', String(e?.stack ?? e)) });
  await new Promise((r) => controlServer.listen(0, '127.0.0.1', r));
  const CONTROL = `http://127.0.0.1:${controlServer.address().port}`;
  log('Sembrando datos sintéticos por la API real (Owner → empresas → estructura → dinero) ...');
  const t0 = Date.now();
  try {
    const out = await seed({ API, CONTROL, issuer, provider, ownerId: oid, adminPool, log, logOnly, password: SHARED_PASSWORD });
    state.seeded = true;
    state.seededAt = new Date().toISOString();
    state.profiles = out.profiles;
    state.companies = out.companies;
    state.warnings = out.warnings;
    state.facts = out.facts;
    saveState(state);
    log(`Siembra terminada en ${Math.round((Date.now() - t0) / 1000)} s${out.warnings.length ? ` con ${out.warnings.length} aviso(s)` : ''}.`);
    for (const w of out.warnings) log(`  AVISO: ${w}`);
  } finally {
    await new Promise((r) => controlServer.close(() => r()));
  }
} else if (!ownerId) {
  log('ATENCIÓN: no se encontró el operador sintético; la base parece incompleta. Usa --reset si algo falla.');
}

// ---------- web: build de producción + servidor estático
await ensureBuild();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const cache = new Map();
webServer = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, p === '/owner' || p.startsWith('/owner/') ? 'owner.html' : 'index.html');
  const ext = path.extname(file);
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
  if (p === '/sw.js' || ext === '.html') headers['cache-control'] = 'no-cache, no-store, must-revalidate';
  if (ext === '.js' || ext === '.html') {
    const key = `${file}|${fs.statSync(file).mtimeMs}`;
    if (!cache.has(key)) cache.set(key, fs.readFileSync(file, 'utf8').replaceAll(API_PLACEHOLDER, API));
    res.writeHead(200, headers);
    return void res.end(cache.get(key));
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => { webServer.once('error', reject); webServer.listen(WEB_PORT, '127.0.0.1', resolve); }).catch((e) => {
  throw new Error(`No se pudo abrir el puerto ${WEB_PORT} (${e.code}). ¿Ya hay otro entorno local abierto?`);
});

// ---------- resumen
const pad = (s, n) => String(s ?? '').padEnd(n);
log('\n' + '='.repeat(118));
log(`  ADEX local listo:  ${WEB}      (API local: ${API})`);
log(`  Contraseña de TODOS los perfiles: ${SHARED_PASSWORD}`);
log('='.repeat(118));
log(`  ${pad('Empresa', 28)}${pad('Perfil', 34)}${pad('Correo', 34)}Qué probar primero`);
log('  ' + '-'.repeat(116));
for (const p of state.profiles ?? []) log(`  ${pad(p.company, 28)}${pad(p.role, 34)}${pad(p.email, 34)}${p.tryFirst}`);
log('  ' + '-'.repeat(116));
log('  Modelos: Norte = Base por Ruta (activada) · Sur = modelo actual (bolsas) · Vacía = sin activar (pruébala tú) · Transición = bolsas con custodia (prueba la transición).');
log('  El panel Owner (/owner) queda FUERA de este entorno. Datos 100 % sintéticos; nada sale de este equipo.');
log('  Para detener: Ctrl+C (o escribe stop y Enter).  Para empezar de cero: añade --reset.');
log('='.repeat(118));
log(`ADEX-LOCAL-READY web=${WEB} api=${API} state=${STATE_FILE}`);
if (flag('--check')) await shutdown(0, '--check: todo arrancó; se detiene');
