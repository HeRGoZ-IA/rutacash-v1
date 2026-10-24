// Prueba de humo del entorno local de Base por Ruta. Arranca start-local.mjs como instancia APARTE
// («smoke»: datos en tmp/local/smoke/, puertos 5610-5612 o --port-base N) con --reset, entra con cada perfil
// sembrado por el endpoint de token local, recorre pantallas clave en Chrome (headless, puppeteer-core) y detiene todo.
//   cd saas
//   npm run local:smoke -- [--build] [--head] [--instance X] [--port-base N]
// Salidas (ignoradas por Git): tmp/local/logs/smoke-*.log|json y capturas en tmp/local/<instancia>/shots/.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // saas/scripts/local (versionado: solo código)
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT_ROOT = path.join(ROOT, 'tmp', 'local');
const PASS = 'adex-local-2026';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const INSTANCE = opt('--instance', 'smoke');
if (!/^[a-z0-9-]{1,20}$/.test(INSTANCE) || INSTANCE === 'main') throw new Error('--instance inválido (la instancia «main» es la del propietario)');
const PORT_BASE = Number(opt('--port-base', '5610'));
const WEB = `http://127.0.0.1:${PORT_BASE}`, API = `http://127.0.0.1:${PORT_BASE + 1}`;
const LOGS = path.join(OUT_ROOT, 'logs');
const OUT = path.join(OUT_ROOT, INSTANCE, 'shots');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const STACK_LOG = path.join(LOGS, `smoke-${stamp}-stack.log`);
const RESULTS = path.join(LOGS, `smoke-${stamp}-results.json`);
const results = [];
const ok = (id, what, pass, detail = '') => { results.push({ id, what, pass: Boolean(pass), detail }); console.log(`${pass ? 'OK  ' : 'FAIL'} ${id} ${what}${detail ? ` · ${String(detail).slice(0, 300)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const puppeteer = createRequire(path.join(ROOT, 'package.json'))('puppeteer-core');

// ---------- 1. arrancar la pila (instancia «smoke», --reset)
const extra = argv.filter((a) => a === '--build' || a === '--head');
const stackOut = fs.createWriteStream(STACK_LOG);
const child = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', './scripts/local/start-local.mjs', '--instance', INSTANCE, '--port-base', String(PORT_BASE), '--reset', ...extra],
  { cwd: path.join(ROOT, 'saas'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let stackText = '';
let exitCode = null;
const exited = new Promise((r) => child.on('exit', (c) => { exitCode = c; r(c); }));
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { stackText += d; stackOut.write(d); });
const t0 = Date.now();
const ready = await Promise.race([
  new Promise((r) => { const t = setInterval(() => { if (stackText.includes('ADEX-LOCAL-READY')) { clearInterval(t); r(true); } }, 300); }),
  exited.then(() => false),
  sleep(8 * 60_000).then(() => false),
]);
ok('S-00', 'La pila local arranca (PostgreSQL persistente, migraciones, siembra por API, build, web)', ready, `${Math.round((Date.now() - t0) / 1000)} s`);
const mig = /Migraciones de la rama: (\d+) \((\d{4})–(\d{4})\)/.exec(stackText);
ok('S-01', 'Aplica TODAS las migraciones de la rama', !!mig, mig?.[0]);
ok('S-02', 'Siembra sin avisos (todos los pasos por la API real)', /Siembra terminada en \d+ s\./.test(stackText) && !/AVISO:/.test(stackText), (stackText.match(/AVISO:.*$/gm) ?? []).join(' | '));

let browser, profileDir;
try {
  if (!ready) throw new Error('la pila no arrancó; ver ' + STACK_LOG);
  const state = JSON.parse(fs.readFileSync(path.join(OUT_ROOT, INSTANCE, 'state.json'), 'utf8'));

  // ---------- 2. API: cada perfil entra por el endpoint de token local y ve sus membresías
  const health = await (await fetch(`${API}/healthz`)).json();
  ok('S-03', '/healthz declara route-base-v1 y general-expenses-v1', ['route-base-v1', 'general-expenses-v1'].every((f) => health.features?.includes(f)));
  const token = async (email, password = PASS) => {
    const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'x' }, body: JSON.stringify({ email, password }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const get = async (t, p, m) => { const r = await fetch(API + p, { headers: { authorization: `Bearer ${t}`, ...(m ? { 'x-adex-membership': m } : {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const ROLE = { SuperAdmin: 'superadmin', Administrador: 'admin', Supervisor: 'supervisor', Cobrador: 'cobrador', Secretario: 'secretario' };
  const memberships = {};
  for (const p of state.profiles) {
    const t = await token(p.email);
    const ms = t.status === 200 ? await get(t.body.access_token, '/v1/me/memberships') : { status: 0, body: {} };
    const list = ms.body.memberships ?? [];
    memberships[p.email] = list;
    const want = ROLE[p.role.split(' ')[0]];
    let ctxOk = list.length > 0;
    for (const m of list) {
      const c = await get(t.body.access_token, '/v1/context', m.membershipId ?? m.id);
      ctxOk &&= c.status === 200 && c.body.role === (m.role ?? c.body.role);
    }
    ok(`S-10 ${p.email}`, `entra con la contraseña compartida y abre el contexto (${p.role})`, t.status === 200 && ms.status === 200 && ctxOk && list.some((m) => m.role === want),
      `membresías=${list.map((m) => `${m.role}@${m.companyName ?? m.company?.name ?? ''}`).join(', ')}`);
  }
  ok('S-11', 'Contraseña incorrecta → rechazada (400 invalid_grant)', (await token('admin1.norte@example.test', 'otra-clave')).status === 400);
  ok('S-12', 'El Owner sintético no puede entrar (panel Owner fuera de alcance)', (await token('owner.local@example.test')).status === 400);
  ok('S-13', 'Supervisor con 2 membresías (Norte y Sur)', (memberships['supervisor.norte@example.test'] ?? []).length === 2);
  // Conciliación del libro de la empresa A (SuperAdmin) y modelo de cada empresa.
  const saT = (await token('sa.norte@example.test')).body.access_token;
  const saM = (memberships['sa.norte@example.test'] ?? [])[0];
  const rec = await get(saT, '/v1/capital/reconciliation', saM?.membershipId ?? saM?.id);
  const failed = (rec.body.checks ?? []).filter((c) => !c.ok);
  ok('S-14', 'Norte: conciliación del libro limpia tras la siembra', rec.status === 200 && failed.length === 0, JSON.stringify(failed).slice(0, 300));
  // Sesión única (0031): un token nuevo debe reclamar la sesión (como el inicio de sesión del navegador).
  const model = async (email) => { const t = (await token(email)).body.access_token; await fetch(`${API}/v1/session/claim`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' }); const m = (memberships[email] ?? [])[0]; return (await get(t, '/v1/capital/model', m?.membershipId ?? m?.id)).body.model; };
  ok('S-15', 'Modelos: Norte route_base · Sur, Vacía y Transición admin_pool', (await model('sa.norte@example.test')) === 'route_base' && (await model('sa.sur@example.test')) === 'admin_pool' && (await model('sa.vacia@example.test')) === 'admin_pool' && (await model('sa.transicion@example.test')) === 'admin_pool');

  // ---------- 3. Chrome: pantallas clave con el build de producción
  profileDir = fs.mkdtempSync(path.join(OUT_ROOT, 'chrome-smoke-'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profileDir, args: ['--no-first-run'] });
  const errors = [];
  let page, ctx, stage = '';
  const session = async () => {
    if (page) await page.close().catch(() => undefined);
    if (ctx) await ctx.close().catch(() => undefined);
    ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    page.setDefaultTimeout(45_000);
    page.on('pageerror', (e) => errors.push(`${stage}: ${String(e).slice(0, 200)}`));
    await page.setRequestInterception(true);
    page.on('request', (r) => { const u = r.url(); if (!u.startsWith(WEB) && !u.startsWith(API) && !u.startsWith('data:') && !u.startsWith('blob:')) return void r.abort(); r.continue(); });
    await page.setViewport({ width: 1280, height: 900 });
    await page.emulateTimezone('America/Sao_Paulo');
  };
  const go = (p) => page.goto(`${WEB}${p}`, { waitUntil: 'domcontentloaded' });
  const pathNow = () => page.evaluate(() => location.pathname);
  const has = (id, timeout = 30_000) => page.waitForSelector(`[data-testid="${id}"]`, { timeout }).then(() => true, () => false);
  const textOf = (id) => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.innerText.replace(/\u00a0/g, ' ') ?? null, id);
  const body = () => page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '));
  const setInput = (sel, v) => page.evaluate((sel, v) => { const el = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
  const setField = (label, v) => page.evaluate((label, v) => {
    const l = [...document.querySelectorAll('label')].find((x) => x.innerText.replace(/\u00a0/g, ' ').trim().replace(/\s*\*$/, '') === label);
    const el = l && (l.htmlFor ? document.getElementById(l.htmlFor) : l.parentElement?.querySelector('input,select,textarea'));
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  }, label, v);
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => undefined);
  const login = async (email, pick, password = PASS) => {
    stage = email;
    await session();
    await go('/login');
    await page.waitForSelector('input[type=email]');
    await setInput('input[type=email]', email);
    await setInput('input[type=password]', password);
    await page.$eval('form', (f) => f.requestSubmit());
    await page.waitForFunction(() => location.pathname !== '/login', { timeout: 30_000 }).catch(() => undefined);
    if (pick && (await pathNow()) === '/contexto') {
      await page.waitForFunction((r) => [...document.querySelectorAll('button')].some((b) => b.innerText.includes(r)), { timeout: 20_000 }, pick).catch(() => undefined);
      await page.evaluate((r) => [...document.querySelectorAll('button')].find((b) => b.innerText.includes(r))?.click(), pick);
      await page.waitForFunction(() => location.pathname !== '/contexto', { timeout: 30_000 }).catch(() => undefined);
    }
    return pathNow();
  };

  // Contraseña incorrecta en la pantalla de acceso.
  ok('B-01', 'Pantalla de acceso: contraseña incorrecta → sigue en /login', (await login('admin1.norte@example.test', null, 'equivocada')) === '/login');
  // Administrador Norte Uno (route_base).
  await login('admin1.norte@example.test');
  await go('/admin/capital');
  ok('B-02', 'Admin Norte: Caja principal NUEVA (panel consolidado, sin bolsa)', await has('rb-consolidated') && (await page.$('[data-testid="admin-pool"]')) === null);
  await sleep(800); await shot('B-02-admin1-caja');
  const cajaTxt = await body();
  ok('B-03', 'Admin Norte: aparecen sus dos rutas', cajaTxt.includes('Ruta Centro 1') && cajaTxt.includes('Ruta Centro 2'));
  ok('B-04', 'Admin Norte: saldo «sin asignar» visible para repartir', await has('rb-unassigned', 10_000));
  await go('/admin/transfers');
  ok('B-05', 'Admin Norte: Transferencias nuevas (Base por Ruta)', await has('rb-transfers') && await has('rb-op-inject', 10_000));
  await sleep(600); await shot('B-05-admin1-transferencias');
  await go('/admin/active-sales');
  ok('B-06', 'Admin Norte: ventas activas con los clientes sintéticos', await page.waitForFunction(() => document.body.innerText.includes('Centro A') || document.body.innerText.includes('CENTRO A'), { timeout: 30_000 }).then(() => true, () => false));
  await go('/admin/consultas');
  ok('B-07', 'Admin Norte: Consultas abre', await page.waitForFunction(() => location.pathname.startsWith('/admin/consultas') && document.body.innerText.length > 200, { timeout: 30_000 }).then(() => true, () => false));
  // Administrador Norte Dos: aviso de transferencia recibida.
  await login('admin2.norte@example.test');
  await go('/admin/notificaciones');
  ok('B-08', 'Admin Norte Dos: aviso «Transferencia de Base recibida»', await page.waitForFunction(() => document.body.innerText.includes('Transferencia de Base recibida'), { timeout: 30_000 }).then(() => true, () => false));
  // SuperAdmin Norte: panel de solo lectura.
  await login('sa.norte@example.test');
  await go('/admin/capital');
  ok('B-09', 'SuperAdmin Norte: panel global de solo lectura, sin Transferencias', await has('rb-sa-global') && (await page.$('[data-testid="rb-go-transfers"]')) === null);
  await sleep(600); await shot('B-09-sa-norte-panel');
  await go('/admin/capital/modelo');
  ok('B-10', 'SuperAdmin Norte: Modelo de capital = Base por Ruta, sin formulario', await has('rb-model-current') && ((await textOf('rb-model-current')) ?? '').includes('Base por Ruta') && (await page.$('[data-testid="rb-activation-form"]')) === null);
  // Secretario Norte: Transferencias = historial.
  await login('secretario.norte@example.test');
  await go('/secretario/transferencias');
  ok('B-11', 'Secretario Norte: Transferencias = solo historial (sin «Registrar»)', await has('secretary-route-base') && (await page.$('[data-testid="register-admin-transfer"]')) === null);
  // Cobrador Norte Uno.
  const cp = await login('cobrador1.norte@example.test');
  await sleep(1500);
  ok('B-12', 'Cobrador Norte Uno: entra a su panel de Cobrador', cp.startsWith('/collector') && !(await body()).includes('Configuración incompleta'), cp);
  await shot('B-12-cobrador1');
  // Supervisor: selector de contexto con dos empresas.
  stage = 'supervisor';
  await session(); await go('/login'); await page.waitForSelector('input[type=email]');
  await setInput('input[type=email]', 'supervisor.norte@example.test'); await setInput('input[type=password]', PASS);
  await page.$eval('form', (f) => f.requestSubmit());
  await page.waitForFunction(() => location.pathname !== '/login', { timeout: 30_000 }).catch(() => undefined);
  const ctxTxt = (await pathNow()) === '/contexto' ? (await page.waitForFunction(() => document.body.innerText.includes('Sur'), { timeout: 20_000 }).catch(() => undefined), await body()) : '';
  ok('B-13', 'Supervisor: selector de contexto con Norte y Sur', ctxTxt.includes('Cobros Sintéticos Norte') && ctxTxt.includes('Préstamos Sintéticos Sur'), await pathNow());
  await shot('B-13-selector');
  // Empresa B sin cambios.
  await login('admin.sur@example.test');
  await go('/admin/capital');
  ok('B-14', 'Admin Sur (modelo actual): Caja principal ANTERIOR (bolsa), sin panel nuevo', await page.waitForSelector('[data-testid="admin-pool"],[data-testid="pool-empty"]', { timeout: 30_000 }).then(() => true, () => false) && (await page.$('[data-testid="rb-caja"]')) === null);
  await go('/admin/transfers');
  ok('B-15', 'Admin Sur: Transferencias ANTERIORES («Nueva operación»)', await has('new-operation') && (await page.$('[data-testid="rb-transfers"]')) === null);
  // Empresa C: activación directa desde la pantalla (solo en esta instancia desechable).
  await login('sa.vacia@example.test');
  await go('/admin/capital/modelo');
  await has('rb-prereqs');
  await page.waitForFunction(() => document.querySelector('[data-testid="rb-prereqs-state"]')?.textContent?.includes('Todos'), { timeout: 20_000 }).catch(() => undefined);
  ok('B-16', 'SuperAdmin Vacía: requisitos de activación todos cumplidos', ((await textOf('rb-prereqs-state')) ?? '').includes('Todos cumplidos'));
  await setField('Evidencia de la autorización', 'Activación de prueba en la instancia de humo (sintética)');
  await setField('Referencia del respaldo verificado', 'respaldo-smoke-0001');
  await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR');
  await sleep(400); await shot('B-17-activacion-lista');
  await page.evaluate(() => document.querySelector('[data-testid="rb-activation-submit"]')?.click());
  ok('B-17', 'SuperAdmin Vacía: activa Base por Ruta desde la pantalla', await page.waitForFunction(() => (document.querySelector('[aria-label="Notificaciones"]')?.innerText ?? '').includes('Base por Ruta activada'), { timeout: 30_000 }).then(() => true, () => false));
  ok('B-18', 'API: la Empresa Vacía queda en route_base', (await model('sa.vacia@example.test')) === 'route_base');
  const other = errors.filter((e) => !e.includes('StaleContext'));
  ok('B-99', 'Sin errores de JavaScript en las páginas', other.length === 0, other.join(' | '));
} catch (e) {
  ok('X', 'Excepción de la prueba de humo', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => undefined);
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  // ---------- 4. parada ordenada (como Ctrl+C: «stop» por la entrada estándar)
  if (exitCode === null) { child.stdin.write('stop\n'); await Promise.race([exited, sleep(60_000)]); }
  if (exitCode === null) child.kill();
  const pgPkg = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const pgCtl = path.join(ROOT, 'saas', 'node_modules', '@embedded-postgres', pgPkg, 'native', 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  const pgUp = spawnSync(pgCtl, ['status', '-D', path.join(OUT_ROOT, INSTANCE, 'pgdata')]).status === 0;
  ok('S-99', 'Parada limpia: proceso terminado con 0 y PostgreSQL detenido', exitCode === 0 && /PostgreSQL detenido limpiamente/.test(stackText) && !pgUp, `exit=${exitCode}`);
  stackOut.end();
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${pass}/${results.length} OK · pila: ${path.relative(ROOT, STACK_LOG)} · resultados: ${path.relative(ROOT, RESULTS)} · capturas: ${path.relative(ROOT, OUT)}`);
  process.exit(pass === results.length ? 0 : 1);
}
