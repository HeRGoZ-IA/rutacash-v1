// E2E del circuito completo de «Base por Ruta» (Base y efectivo independientes por ruta) en Chrome real, sobre la
// pila 100 % LOCAL y SINTÉTICA de saas/scripts/local/start-local.mjs (PostgreSQL embebido, todas las migraciones,
// API de empresa real, emisor JWT local y el BUILD DE PRODUCCIÓN de ADEX Online). Nada de Supabase, Render, Vercel
// ni ADEX-Staging. Origen: tmp/r74/e2e/e2e-final.mjs (R74), versionado tras revisarlo (sin secretos ni datos reales).
//
// La prueba ARRANCA SU PROPIA INSTANCIA de start-local.mjs (por defecto «e2e»: datos en tmp/local/e2e/, puertos
// 5620–5622) y la detiene al terminar. Nunca usa la instancia «main» del propietario.
//
//   cd saas
//   npm run e2e:routebase -- --part 1     (reset + bloques A–E)
//   npm run e2e:routebase -- --part 2     (SIN reset: bloques F–Z sobre los datos de la parte 1)
//   npm run e2e:routebase -- --part 3     (reset + bloque T: transición con custodias ≠ 0, devolución del sobrante
//                                          desde «Diferencias» e indicador del Supervisor en «Selecciona tu ruta»)
//   npm run e2e:routebase                 (partes 1 y 2 seguidas, con --reset; la parte 3 va siempre aparte)
//   opciones: --build (reconstruye ADEX Online) · --instance X · --port-base N · --out DIR (dentro de tmp/)
//
// Todo flujo de dinero se hace DESDE LA INTERFAZ. Solo las comprobaciones de aislamiento (bloque H1) y de reintentos y
// concurrencia (bloque H2) usan HTTP directo. PostgreSQL se consulta SOLO en lectura, como evidencia.
// Salida (ignorada por Git): <out>/e2e-routebase*.log (PASS/FAIL por caso), *-summary.json y capturas en <out>/shots/;
// por defecto <out> = tmp/local/e2e-routebase.
import { spawn, spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // saas/scripts/local (versionado: solo código)
const ROOT = path.resolve(HERE, '..', '..', '..');
const LOCAL = path.join(ROOT, 'tmp', 'local');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PART = opt('--part', 'all');
if (!['all', '1', '2', '3'].includes(PART)) throw new Error('--part: all | 1 | 2 | 3');
const RESET = PART !== '2';
const INSTANCE = opt('--instance', 'e2e');
if (!/^[a-z0-9-]{1,20}$/.test(INSTANCE) || INSTANCE === 'main') throw new Error('--instance inválido (la instancia «main» es la del propietario)');
const PORT_BASE = Number(opt('--port-base', '5620'));
const WEB = `http://127.0.0.1:${PORT_BASE}`, API = `http://127.0.0.1:${PORT_BASE + 1}`;
const PASS = 'adex-local-2026';
const DIR = path.resolve(ROOT, opt('--out', path.join('tmp', 'local', 'e2e-routebase')));
if (!DIR.startsWith(path.join(ROOT, 'tmp') + path.sep)) throw new Error('--out debe quedar dentro de tmp/ (las evidencias no se versionan)');
const OUT = path.join(DIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const NAME = PART === 'all' ? 'e2e-routebase' : `e2e-routebase-part${PART}`;
const LOG = path.join(DIR, `${NAME}.log`);
const SUMMARY = path.join(DIR, `${NAME}-summary.json`);
const STACK_LOG = path.join(DIR, `${NAME}-stack.log`);
const logStream = fs.createWriteStream(LOG);
const say = (s) => { console.log(s); logStream.write(s + '\n'); };
const results = [];
/** Un caso: id, criterios de aceptación (C-01…C-14), descripción, resultado y detalle. */
const ok = (id, crit, what, pass, detail = '') => {
  results.push({ id, crit, what, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 600) });
  say(`${pass ? 'PASS' : 'FAIL'} ${id} [${crit.join(',')}] ${what}${detail ? ` · ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  return Boolean(pass);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc11 = () => String(randomInt(10_000_000_000, 99_999_999_999));
const puppeteer = createRequire(path.join(ROOT, 'package.json'))('puppeteer-core');
const pg = createRequire(path.join(ROOT, 'saas', 'package.json'))('pg');
/** «R$ 4.700», «-R$ 10,50» → unidades menores. */
const minorOf = (t) => {
  if (t == null) return null;
  const m = String(t).replace(/\u00a0/g, ' ').match(/(-|−)?\s*R\$\s*([\d.]+)(,(\d{1,2}))?/);
  if (!m) return null;
  const v = Number(m[2].replace(/\./g, '')) * 100 + Number((m[4] ?? '0').padEnd(2, '0'));
  return m[1] ? -v : v;
};
const major = (minor) => String(minor / 100).replace('.', ',');

// ============================================================ 1. pila local (instancia «e2e»)
say(`E2E de Base por Ruta · parte ${PART} · instancia ${INSTANCE} · ${new Date().toLocaleString('es')}`);
const stackOut = fs.createWriteStream(STACK_LOG);
const extra = argv.includes('--build') ? ['--build'] : [];
const child = spawn(process.execPath, ['--import', './scripts/register-alias.mjs', './scripts/local/start-local.mjs', '--instance', INSTANCE, '--port-base', String(PORT_BASE),
  ...(RESET ? ['--reset'] : []), ...extra], { cwd: path.join(ROOT, 'saas'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let stackText = '', exitCode = null;
const exited = new Promise((r) => child.on('exit', (c) => { exitCode = c; r(c); }));
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { stackText += d; stackOut.write(d); });
const t0 = Date.now();
const ready = await Promise.race([
  new Promise((r) => { const t = setInterval(() => { if (stackText.includes('ADEX-LOCAL-READY')) { clearInterval(t); r(true); } }, 300); }),
  exited.then(() => false), sleep(8 * 60_000).then(() => false),
]);
ok('L-00', ['C-01'], 'La pila local de la prueba arranca (PostgreSQL, migraciones, siembra por la API real, build, web)', ready, `${Math.round((Date.now() - t0) / 1000)} s${RESET ? ' · --reset' : ' · datos de la parte 1'}`);
const mig = /Migraciones de la rama: (\d+) \((\d{4})–(\d{4})\)/.exec(stackText);
ok('L-01', ['C-01'], 'Aplica todas las migraciones de saas/db/migrations (0036 o posterior)', !!mig && Number(mig[3]) >= 36, mig?.[0]);
if (RESET) ok('L-02', ['C-01'], 'Siembra sin avisos (todo por la API real)', /Siembra terminada en \d+ s\./.test(stackText) && !/AVISO:/.test(stackText), (stackText.match(/AVISO:.*$/gm) ?? []).join(' | '));

let browser, profileDir, db;
const errors = [];
try {
  if (!ready) throw new Error('la pila no arrancó; ver ' + STACK_LOG);
  const state = JSON.parse(fs.readFileSync(path.join(LOCAL, INSTANCE, 'state.json'), 'utf8'));
  db = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(state.passwords.admin)}@127.0.0.1:${PORT_BASE + 2}/adex_local` });
  await db.connect();
  // ---------------------------------------------------------------- PostgreSQL, SOLO lectura (evidencia)
  const q = async (sql, params = []) => { await db.query('begin read only'); try { return (await db.query(sql, params)).rows; } finally { await db.query('rollback'); } };
  const one = async (sql, params) => (await q(sql, params))[0];
  const N = state.companies.A.id, S = state.companies.B.id, V = state.companies.C.id;
  const R = state.facts.A.routes; // nombre → id (Norte)
  const routeId = async (company, name) => (await one('select id from adex.routes where company_id = $1 and name = $2', [company, name]))?.id;
  const RS1 = await routeId(S, 'Ruta Sur 1'), RS2 = await routeId(S, 'Ruta Sur 2'), RV1 = await routeId(V, 'Ruta Vacía 1');
  const mem = async (email, company) => (await one(`select m.id from adex.memberships m join adex.identities i on i.id = m.identity_id where lower(i.email) = $1 and m.company_id = $2`, [email, company]))?.id;
  const M = {
    sa: await mem('sa.norte@example.test', N), ad1: await mem('admin1.norte@example.test', N), ad2: await mem('admin2.norte@example.test', N),
    sup: await mem('supervisor.norte@example.test', N), cob1: await mem('cobrador1.norte@example.test', N), cob2: await mem('cobrador2.norte@example.test', N),
    saS: await mem('sa.sur@example.test', S), adS: await mem('admin.sur@example.test', S), cobS: await mem('cobrador.sur@example.test', S),
    saV: await mem('sa.vacia@example.test', V), adV: await mem('admin.vacia@example.test', V),
  };
  const bal = async (company, kind, { route = null, m = null } = {}) => Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.capital_accounts
     where company_id = $1 and kind = $2 and ($3::text is null or route_id = $3) and ($4::text is null or membership_id = $4)`, [company, kind, route, m])).s);
  const base = (r, company = N) => bal(company, 'route_base', { route: r });
  const custody = (m, r, company = N) => bal(company, 'custody', { route: r, m });
  const payable = (m, company = N) => bal(company, 'admin_payable', { m }).then((x) => -x); // pendiente a favor (positivo)
  const pool = (m, company) => bal(company, 'admin', { m });
  const model = async (company) => (await one('select capital_model from adex.companies where id = $1', [company])).capital_model;
  const controller = async (r) => (await one('select capital_controller_membership_id c, handover_state h from adex.routes where id = $1', [r]));
  const opsCount = async (company, kind) => Number((await one('select count(*)::int n from adex.capital_operations where company_id = $1 and kind = $2', [company, kind])).n);
  const ledgerClean = async (company) => {
    const r = await one(`select (select count(*) from adex.capital_accounts a where a.company_id = $1 and a.balance_minor <> coalesce((select sum(e.amount_minor) from adex.capital_entries e where e.company_id = a.company_id and e.account_id = a.id), 0))::int mismatched,
        (select count(*) from adex.capital_operations o where o.company_id = $1 and (select coalesce(sum(e.amount_minor), 0) <> 0 or count(*) < 2 from adex.capital_entries e where e.company_id = o.company_id and e.operation_id = o.id))::int unbalanced,
        (select count(*) from adex.capital_accounts where company_id = $1 and kind in ('route_base', 'admin', 'company', 'suspense') and balance_minor < 0)::int negative,
        (select coalesce(sum(balance_minor), 0) from adex.capital_accounts where company_id = $1)::bigint total`, [company]);
    return { mismatched: r.mismatched, unbalanced: r.unbalanced, negative: r.negative, total: Number(r.total) };
  };
  const isClean = (x) => x.mismatched === 0 && x.unbalanced === 0 && x.negative === 0 && x.total === 0;
  const saleOf = async (clientName) => one(`select s.id, s.route_id, s.sale_value_minor::int v, s.status from adex.sales s join adex.clients c on c.id = s.client_id where c.name = $1 order by s.created_at desc limit 1`, [clientName]);

  // ---------------------------------------------------------------- API directa (solo H1/H2 y para leer membresías)
  const tokens = new Map();
  async function apiLogin(email) {
    const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASS }) });
    const t = (await r.json()).access_token;
    await fetch(`${API}/v1/session/claim`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' });
    tokens.set(email, t);
    return t;
  }
  /** Llamador directo con membresía explícita; `op` = id de operación (reintentos). */
  const apiAs = async (email, membership) => {
    const t = await apiLogin(email);
    return async (method, p, body, { op } = {}) => {
      const headers = { authorization: `Bearer ${t}`, 'x-adex-membership': membership };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET') headers['x-adex-operation-id'] = op ?? randomUUID();
      const r = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
      return { status: r.status, body: json, text };
    };
  };
  const refused = (r, ...codes) => r.status >= 400 && r.status < 500 && (codes.length === 0 || codes.some((c) => r.text.includes(c)));

  // ---------------------------------------------------------------- navegador
  profileDir = fs.mkdtempSync(path.join(LOCAL, 'chrome-e2e-'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, userDataDir: profileDir, args: ['--no-first-run'] });
  let page, ctx, stage = '';
  const session = async (width = 1280, height = 900) => {
    if (page) await page.close().catch(() => undefined);
    if (ctx) await ctx.close().catch(() => undefined);
    ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    page.setDefaultTimeout(45_000); page.setDefaultNavigationTimeout(90_000);
    page.on('pageerror', (e) => errors.push({ stage, e: String(e).slice(0, 300) }));
    await page.setRequestInterception(true);
    page.on('request', (r) => { const u = r.url(); if (!u.startsWith(WEB) && !u.startsWith(API) && !u.startsWith('data:') && !u.startsWith('blob:')) return void r.abort(); r.continue(); });
    await page.setViewport({ width, height });
    await page.emulateTimezone('America/Sao_Paulo');
  };
  const go = (p) => page.goto(`${WEB}${p}`, { waitUntil: 'domcontentloaded' });
  const pathNow = () => page.evaluate(() => location.pathname);
  const text = () => page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '));
  const testid = (id, scope) => page.evaluate((id, scope) => (scope ? document.querySelector(`[data-testid="${scope}"]`) : document)?.querySelector(`[data-testid="${id}"]`)?.innerText.replace(/\u00a0/g, ' ') ?? null, id, scope ?? null);
  const waitTestid = (id, timeout = 30_000) => page.waitForSelector(`[data-testid="${id}"]`, { timeout }).then(() => true, () => false);
  const gone = (id, timeout = 30_000) => page.waitForSelector(`[data-testid="${id}"]`, { hidden: true, timeout }).then(() => true, () => false);
  const waitText = (part, timeout = 30_000) => page.waitForFunction((p) => document.body.innerText.replace(/\u00a0/g, ' ').includes(p), { timeout }, part).then(() => true, () => false);
  const waitToast = (part, timeout = 30_000) => page.waitForFunction((p) => (document.querySelector('[aria-label="Notificaciones"]')?.innerText ?? '').replace(/\u00a0/g, ' ').includes(p), { timeout }, part).then(() => true, () => false);
  const toasts = () => page.evaluate(() => (document.querySelector('[aria-label="Notificaciones"]')?.innerText ?? '').replace(/\u00a0/g, ' '));
  const tap = (id) => page.evaluate((id) => { const e = document.querySelector(`[data-testid="${id}"]`); if (!e || e.disabled) return false; e.click(); return true; }, id);
  const disabled = (id) => page.$eval(`[data-testid="${id}"]`, (b) => b.disabled || b.getAttribute('aria-disabled') === 'true').catch(() => null);
  const clickText = (tag, re) => page.evaluate((tag, src) => {
    const rx = new RegExp(src);
    const els = [...document.querySelectorAll(tag)].filter((x) => x.offsetParent !== null && rx.test(x.innerText.replace(/\u00a0/g, ' ').trim()));
    const e = els.at(-1); if (!e || e.disabled) return false; e.click(); return true;
  }, tag, re.source);
  /** Campo por su etiqueta, dentro del último diálogo abierto si lo hay. */
  const setField = (label, v) => page.evaluate((label, v) => {
    const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document;
    const l = [...scope.querySelectorAll('label')].find((x) => x.innerText.replace(/\u00a0/g, ' ').trim().replace(/\s*\*$/, '') === label);
    const el = l && (l.htmlFor ? document.getElementById(l.htmlFor) : l.parentElement?.querySelector('input,select,textarea'));
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  }, label, v);
  const pick = (label, contains) => page.evaluate((label, contains) => {
    const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document;
    const l = [...scope.querySelectorAll('label')].find((x) => x.innerText.replace(/\u00a0/g, ' ').trim().replace(/\s*\*$/, '') === label);
    const el = l && (l.htmlFor ? document.getElementById(l.htmlFor) : l.parentElement?.querySelector('select'));
    if (!el) return false;
    const o = [...el.options].find((x) => x.value && x.textContent.includes(contains));
    if (!o) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label, contains);
  /** Selector con búsqueda (cliente): escribe en el campo y toca la primera opción que contiene el texto. */
  const pickSearch = async (label, contains) => {
    const typed = await page.evaluate((label, contains) => {
      const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document;
      const l = [...scope.querySelectorAll('label')].find((x) => x.innerText.replace(/ /g, ' ').trim().replace(/\s*\*$/, '') === label);
      const el = l && document.getElementById(l.htmlFor);
      if (!el || el.getAttribute('role') !== 'combobox') return false;
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, contains);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.id;
    }, label, contains);
    if (!typed) return false;
    await sleep(300);
    return page.evaluate((id, contains) => {
      const o = [...document.querySelectorAll(`#${CSS.escape(id)}-list [role="option"]`)].find((x) => x.textContent.includes(contains));
      if (!o) return false;
      o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return true;
    }, typed, contains);
  };
  const options = (label) => page.evaluate((label) => {
    const scope = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? document;
    const l = [...scope.querySelectorAll('label')].find((x) => x.innerText.replace(/\u00a0/g, ' ').trim().replace(/\s*\*$/, '') === label);
    const el = l && (l.htmlFor ? document.getElementById(l.htmlFor) : l.parentElement?.querySelector('select'));
    return el ? [...el.options].map((o) => o.textContent) : null;
  }, label);
  const setInput = (sel, v) => page.evaluate((sel, v) => {
    const el = document.querySelector(sel); if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, sel, v);
  const overflowX = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  /** Capturas a 390 px (móvil) y 1280 px (escritorio); devuelve si hubo desbordamiento horizontal. */
  const both = async (name, readyFn) => {
    let of = false;
    for (const w of [390, 1280]) {
      await page.setViewport({ width: w, height: w === 390 ? 844 : 900 });
      await sleep(500);
      if (readyFn) await readyFn();
      if (await overflowX()) of = true;
      await page.screenshot({ path: path.join(OUT, `${name}-${w}.png`), fullPage: true }).catch(() => undefined);
    }
    await page.setViewport({ width: 1280, height: 900 });
    return !of;
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => undefined);
  const login = async (email, pickCtx) => {
    stage = email;
    await session();
    await go('/login');
    await page.waitForSelector('input[type=email]');
    await setInput('input[type=email]', email);
    await setInput('input[type=password]', PASS);
    await page.$eval('form', (f) => f.requestSubmit());
    await page.waitForFunction(() => location.pathname !== '/login', { timeout: 45_000 }).catch(() => undefined);
    if ((await pathNow()) === '/contexto') {
      const want = pickCtx ?? '';
      await page.waitForFunction((r) => [...document.querySelectorAll('button')].some((b) => b.innerText.includes(r)), { timeout: 20_000 }, want).catch(() => undefined);
      if (pickCtx) {
        await page.evaluate((r) => [...document.querySelectorAll('button')].find((b) => b.innerText.includes(r))?.click(), pickCtx);
        await page.waitForFunction(() => location.pathname !== '/contexto', { timeout: 30_000 }).catch(() => undefined);
      }
    }
    return pathNow();
  };
  /** Operación de Transferencias (Base por Ruta) por la interfaz. */
  const openOp = async (kind) => {
    await go('/admin/transfers');
    await waitTestid('rb-transfers');
    await page.waitForSelector(`[data-testid="rb-op-${kind}"]`);
    await page.waitForFunction(() => !document.querySelector('[data-testid="rb-transfers"] .animate-pulse'), { timeout: 20_000 }).catch(() => undefined);
    await sleep(600);
    await tap(`rb-op-${kind}`);
    return waitTestid(`rb-form-${kind}`, 15_000);
  };
  const saveOp = async (toastText) => { await sleep(400); const s = await tap('rb-op-save'); return s && waitToast(toastText); };
  const rowClick = (rowTestid, btn) => page.evaluate((r, b) => { const e = document.querySelector(`[data-testid="${r}"] [data-testid="${b}"]`); if (!e || e.disabled) return false; e.click(); return true; }, rowTestid, btn);
  const toPanel = async () => { await go('/admin/capital'); await waitTestid('ge-panel'); await page.waitForFunction(() => !document.querySelector('[data-testid="ge-panel"] .animate-pulse'), { timeout: 20_000 }).catch(() => undefined); await sleep(800); };
  const tab = async (k) => { await tap(`ge-tab-${k}`); await sleep(500); };
  /** 0037: «Reembolsos pendientes» lista UNA obligación por gasto con dinero propio; abre el pago de esa obligación. */
  const openObligation = async (expenseId) => {
    await toPanel(); await tab('pendientes');
    await page.waitForSelector(`[data-testid="ge-obligation-${expenseId}"]`, { timeout: 20_000 }).catch(() => undefined);
    const opened = await rowClick(`ge-obligation-${expenseId}`, 'ge-obligation-pay');
    return opened && await waitTestid('ge-reimb-obligation', 15_000);
  };
  /** Pendiente de una obligación (o null si ya no aparece en la lista). */
  const obligationPending = (expenseId) => page.evaluate((id) => document.querySelector(`[data-testid="ge-obligation-${id}"] [data-testid="ge-obligation-pending"]`)?.innerText ?? null, expenseId).then(minorOf);
  /** Diálogo de corrección (0037): espera a que cargue la vista previa del servidor. */
  const corrReady = async () => (await waitTestid('corr-dialog', 15_000))
    && await page.waitForFunction(() => { const d = document.querySelector('[data-testid="corr-dialog"]'); return d && !d.querySelector('.animate-pulse'); }, { timeout: 20_000 }).then(() => true, () => false);
  /** Abre «Diferencias», la diferencia de una fuente y elige una resolución. */
  const openDifference = async (sourceId, routeFilter) => {
    await go(`/admin/diferencias${routeFilter ? `?ruta=${routeFilter}` : ''}`);
    await waitTestid('dif-page');
    await page.waitForSelector(`[data-testid="dif-item-${sourceId}"]`, { timeout: 20_000 }).catch(() => undefined);
    await rowClick(`dif-item-${sourceId}`, 'dif-open');
    return waitTestid('dif-dialog', 15_000);
  };
  const resolveInUi = async (resolution, reason) => {
    await page.click(`[data-testid="dif-res-${resolution}"]`).catch(() => undefined);
    await page.waitForSelector('[data-testid="dif-preview"]', { timeout: 15_000 }).catch(() => undefined);
    await sleep(500);
    await setField('Motivo', reason); await sleep(400);
  };
  /** Banner de entrega de una ruta en la Caja principal → diálogo de conteo. */
  const confirmHandoverUi = async (routeName, countedMinor, note) => {
    await go('/admin/capital'); await waitTestid('rb-consolidated');
    await page.waitForFunction((n) => [...document.querySelectorAll('[data-testid="rb-handover-banner"]')].some((b) => b.innerText.includes(n)), { timeout: 20_000 }, routeName).catch(() => undefined);
    await page.evaluate((n) => [...document.querySelectorAll('[data-testid="rb-handover-banner"]')].find((b) => b.innerText.includes(n))?.querySelector('button')?.click(), routeName);
    await waitTestid('handover-dialog');
    await page.waitForSelector('[data-testid="handover-expected"]', { timeout: 15_000 }).catch(() => undefined);
    const expected = minorOf(await testid('handover-expected'));
    const counted = countedMinor ?? expected;
    await setField('Valor contado', major(counted));
    if (note) await setField(counted !== expected ? 'Nota de la diferencia' : 'Nota (opcional)', note);
    await sleep(400);
    const saved = (await tap('handover-confirm')) && await waitToast('Entrega confirmada');
    return { expected, counted, saved };
  };
  /** SuperAdmin: cambiar el responsable de capital de una ruta desde el Panel de rutas (acto estructural). */
  const changeControllerUi = async (rId, newAdminName, reason) => {
    await go('/admin/capital'); await waitTestid('rb-consolidated');
    await page.waitForSelector(`[data-testid="rb-route-${rId}"]`);
    await rowClick(`rb-route-${rId}`, 'rb-route-detail');
    await waitTestid('rb-route-drawer');
    await sleep(500);
    await tap('rb-change-controller');
    await waitTestid('rb-change-form');
    const picked = await pick('Nuevo responsable', newAdminName);
    await setField('Motivo', reason); await sleep(300);
    const saved = picked && (await tap('rb-change-save')) && await waitToast('Responsable de capital cambiado');
    await page.keyboard.press('Escape').catch(() => undefined);
    return saved;
  };
  /** SuperAdmin: añade rutas a un usuario desde Usuarios (Editar → Rutas autorizadas → Actualizar). */
  const addRoutesToUserUi = async (email, routeNames) => {
    await go('/admin/users');
    await page.waitForFunction((e) => document.body.innerText.includes(e), { timeout: 30_000 }, email);
    await page.evaluate((e) => { const row = [...document.querySelectorAll('div.cursor-pointer')].find((d) => d.innerText.includes(e)); row?.click(); }, email);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes('Editar usuario')), { timeout: 15_000 });
    await sleep(500);
    for (const n of routeNames) {
      await page.evaluate((n) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        const b = [...dlg.querySelectorAll('button')].find((x) => x.innerText.trim() === n);
        if (b && !b.className.includes('bg-primary-600')) b.click();
      }, n);
      await sleep(200);
    }
    await clickText('button', /^Actualizar$/);
    return waitToast('Usuario actualizado');
  };
  const toggleUserUi = async (email) => {
    await go('/admin/users');
    await page.waitForFunction((e) => document.body.innerText.includes(e), { timeout: 30_000 }, email);
    await sleep(500);
    await page.evaluate((e) => { const row = [...document.querySelectorAll('div')].filter((d) => d.innerText?.includes(e) && d.querySelector('[data-testid="user-toggle"]')).sort((a, b) => a.innerText.length - b.innerText.length)[0];
      row?.querySelector('[data-testid="user-toggle"]')?.click(); }, email);
    await Promise.race([waitTestid('deactivation-blockers', 20_000), waitToast('Usuario inactivo', 20_000)]);
    await sleep(500);
    return { dialog: (await testid('deactivation-blockers')) ?? null, codes: await page.evaluate(() => [...document.querySelectorAll('[data-testid^="deactivation-blocker-"]')].map((e) => e.getAttribute('data-testid').replace('deactivation-blocker-', ''))) };
  };
  const consultasHas = async (label, rId) => {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await go(`/admin/consultas?${rId ? `perspectiva=${encodeURIComponent(`route:${rId}`)}&` : ''}desde=${d}&hasta=${d}`); await sleep(2500);
    return waitText(label, 15_000);
  };

  const P1 = PART === 'all' || PART === '1';
  const P2 = PART === 'all' || PART === '2';
  const P3 = PART === '3'; // siempre aparte: necesita los datos recién sembrados (el sobrante de Oeste 1 y Admin 2 activo)
  const C1 = R['Ruta Centro 1'], C2 = R['Ruta Centro 2'], O1 = R['Ruta Oeste 1'], O2 = R['Ruta Oeste 2'];

  if (P1) {
    // ======================================================================================================
    // A · Admin Norte Uno opera la Base de Centro 1 desde la interfaz (inyección, retiro, entrega, devolución,
    //     desembolso de una venta aprobada y cobro). RB-D4: la solicitud no mueve dinero; la entrega sí, una vez.
    // ======================================================================================================
    stage = 'A';
    await login('admin1.norte@example.test');
    await go('/admin/capital');
    const cajaOk = await waitTestid('rb-consolidated');
    await sleep(1200);
    const cajaTxt = await text();
    ok('A-01', ['C-01', 'C-07'], 'Admin 1: Caja principal consolidada de SUS rutas (Centro 1 y 2; sin Oeste ni bolsa)', cajaOk && cajaTxt.includes('Ruta Centro 1') && cajaTxt.includes('Ruta Centro 2') && !cajaTxt.includes('Ruta Oeste 1') && !/\bbolsa/i.test(cajaTxt));
    const consolidated = { base: minorOf(await testid('rb-total-base')), custody: minorOf(await testid('rb-total-custody')), cash: minorOf(await testid('rb-total-cash')) };
    const dbCons = { base: (await base(C1)) + (await base(C2)), custody: (await bal(N, 'custody', { route: C1 })) + (await bal(N, 'custody', { route: C2 })) };
    ok('A-02', ['C-07'], 'Consolidado = Σ Bases + Σ custodias de sus rutas (PostgreSQL), sin duplicar', consolidated.base === dbCons.base && consolidated.custody === dbCons.custody && consolidated.cash === dbCons.base + dbCons.custody, JSON.stringify({ consolidated, dbCons }));
    ok('A-03', ['C-01'], 'Caja principal sin desbordamiento a 390 y 1280 px', await both('A-03-admin1-caja', () => waitTestid('rb-consolidated')));
    // Observaciones del propietario (2026-10-24): «Base del trabajador» en lugar de «custodias»; ancho completo.
    const wide = async (tid) => page.evaluate((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`); const main = document.querySelector('main');
      return !!el && !!main && el.getBoundingClientRect().width >= main.clientWidth - 2;
    }, tid);
    ok('A-03b', ['C-01'], 'Caja principal: «Base del trabajador» (sin «custodias») y a todo el ancho',
      /Base del trabajador/.test(cajaTxt) && !/custodia/i.test(cajaTxt) && await wide('rb-caja'));
    await go('/admin/routes'); await waitTestid(`route-worker-base-${C1}`); await sleep(1000);
    const card1 = { base: minorOf(await testid(`route-base-${C1}`)), worker: minorOf(await testid(`route-worker-base-${C1}`)) };
    const db1 = { base: await base(C1), worker: await bal(N, 'custody', { route: C1 }) };
    ok('A-03c', ['C-07'], 'Rutas: la tarjeta separa Base disponible, Base del trabajador y Cartera activa (= PostgreSQL)',
      card1.base === db1.base && card1.worker === db1.worker && (await text()).includes('Cartera activa'), JSON.stringify({ card1, db1 }));
    await go('/admin/transfers'); await waitTestid('rb-transfers'); await sleep(800);
    const trTxt = await text();
    ok('A-03d', ['C-01'], 'Transferencias y Notificaciones a todo el ancho; Transferencias sin «Custodias»',
      await wide('rb-transfers') && !/Custodias/.test(trTxt) && (await go('/admin/notificaciones'), await waitTestid('notifications-page'), await wide('notifications-page')));

    let b0 = await base(C1);
    await openOp('inject');
    await pick('Ruta', 'Ruta Centro 1'); await setField('Valor', '1000'); await setField('Origen del dinero (nota, opcional)', 'Aporte sintético del socio (E2E)'); await setField('Concepto', 'Inyección E2E en Centro 1');
    await both('A-04-inyeccion-form', () => waitTestid('rb-form-inject'));
    ok('A-04', ['C-01'], 'Inyección de Base R$ 1.000 en Centro 1 desde Transferencias', await saveOp('Inyección de Base registrada') && (await base(C1)) === b0 + 100_000, `${b0} → ${await base(C1)}`);

    b0 = await base(C1);
    await openOp('withdraw');
    await pick('Ruta', 'Ruta Centro 1'); await setField('Valor', String(Math.ceil(b0 / 100) + 1000)); await setField('Concepto', 'Retiro mayor que la Base'); await sleep(400);
    const overTxt = await text();
    ok('A-05', ['C-06'], 'Retiro mayor que la Base de la ruta: la pantalla lo impide («Supera el saldo disponible», Registrar deshabilitado)', (await disabled('rb-op-save')) === true && overTxt.includes('Supera el saldo disponible'));
    await shot('A-05-retiro-mayor-1280');
    await setField('Valor', '500'); await setField('Concepto', 'Retiro de Base E2E entregado al socio');
    ok('A-06', ['C-01'], 'Retiro de Base R$ 500 en Centro 1', await saveOp('Retiro de Base registrada') && (await base(C1)) === b0 - 50_000, `${b0} → ${await base(C1)}`);

    b0 = await base(C1); let k0 = await custody(M.cob1, C1);
    await openOp('deliver');
    await pick('Ruta', 'Ruta Centro 1'); await sleep(300); await pick('Trabajador', 'Norte Uno'); await setField('Valor', '300'); await setField('Concepto', 'Base para cobrar (E2E)');
    ok('A-07', ['C-01'], 'Entrega de Base R$ 300 al Cobrador Norte Uno: Base −300, custodia +300', await saveOp('Entrega de Base a trabajador registrada') && (await base(C1)) === b0 - 30_000 && (await custody(M.cob1, C1)) === k0 + 30_000);

    // RB-D4: el Administrador pide una devolución → no se mueve dinero.
    b0 = await base(C1); k0 = await custody(M.cob1, C1);
    await go('/admin/transfers'); await waitTestid('rb-op-request'); await sleep(600);
    await tap('rb-op-request'); await waitTestid('request-form');
    await pick('Ruta', 'Ruta Centro 1'); await sleep(300); await pick('Trabajador', 'Norte Uno'); await setField('Valor', '100'); await setField('Nota (opcional)', 'Devuelve R$ 100 de la Base (E2E)');
    await sleep(300); await shot('A-08-pedir-entrega-1280');
    await clickText('button', /^Enviar solicitud$/);
    const reqSent = await waitToast('Solicitud enviada');
    const reqRow = await one(`select id, state from adex.capital_requests where company_id = $1 and kind = 'worker_return' and amount_minor = 10000 order by created_at desc limit 1`, [N]);
    ok('A-08', ['C-01', 'C-09'], 'RB-D4: la solicitud de devolución (R$ 100) NO mueve dinero', reqSent && reqRow?.state === 'pending' && (await base(C1)) === b0 && (await custody(M.cob1, C1)) === k0, JSON.stringify(reqRow));

    // El Cobrador atiende las dos solicitudes (la sembrada de R$ 200 y la nueva de R$ 100): cada entrega mueve el dinero UNA vez.
    await login('cobrador1.norte@example.test');
    await go('/collector/notificaciones');
    await waitTestid('notifications-page');
    await page.waitForSelector('[data-testid="notice-action"]', { timeout: 20_000 }).catch(() => undefined);
    await both('A-09-cobrador-solicitudes', () => waitTestid('notifications-page'));
    for (const amt of [200, 100]) {
      await go('/collector/notificaciones'); await waitTestid('notifications-page');
      await page.waitForSelector('[data-testid="notice-action"]', { timeout: 20_000 }).catch(() => undefined);
      await sleep(800);
      await page.evaluate((a) => { const card = [...document.querySelectorAll('[data-testid="notice-action"]')].find((c) => c.innerText.replace(/\u00a0/g, ' ').includes(`R$ ${a}`)); card?.querySelector('[data-testid="attend"]')?.click(); }, amt);
      await waitTestid('deliver-cash-form');
      await sleep(1500);
      const before = { b: await base(C1), k: await custody(M.cob1, C1) };
      await clickText('button', /^Registrar entrega$/);
      const done = await waitToast('Entrega registrada');
      await sleep(800);
      const after = { b: await base(C1), k: await custody(M.cob1, C1) };
      ok(`A-10-${amt}`, ['C-01', 'C-09'], `RB-D4: el Cobrador entrega la devolución pedida (R$ ${amt}): Base +${amt} y custodia −${amt} una sola vez`, done && after.b === before.b + amt * 100 && after.k === before.k - amt * 100, JSON.stringify({ before, after }));
    }
    const reqStates = await q(`select amount_minor::int a, state, fulfilled_operation_id is not null f from adex.capital_requests where company_id = $1 and kind = 'worker_return' order by created_at`, [N]);
    const returnsOps = Number((await one(`select count(*)::int n from adex.capital_operations where company_id = $1 and kind = 'OWN_RETURN' or (company_id = $1 and kind like '%RETURN%' and worker_membership_id = $2 and created_at > now() - interval '30 minutes')`, [N, M.cob1])).n);
    ok('A-11', ['C-09'], 'Las dos solicitudes quedan atendidas con su operación (sin pendientes ni dobles)', reqStates.every((r) => r.state !== 'pending' && r.f), JSON.stringify({ reqStates, returnsOps }));

    // Desembolso de la venta aprobada «Centro E» (de la custodia que salió de la Base) y cobro.
    k0 = await custody(M.cob1, C1);
    await go('/collector/disbursements');
    await page.waitForFunction(() => document.body.innerText.includes('Ventas aprobadas pendientes por desembolsar'), { timeout: 45_000 }).catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector('.animate-spin'), { timeout: 20_000 }).catch(() => undefined);
    await sleep(1000);
    await both('A-12-cobrador-desembolsos');
    await page.evaluate(() => { const card = [...document.querySelectorAll('div.rounded-2xl')].find((d) => d.innerText.includes('Centro E') && d.innerText.includes('Confirmar desembolso')); [...(card?.querySelectorAll('button') ?? [])].find((x) => x.innerText.includes('Confirmar desembolso'))?.click(); });
    await sleep(800);
    await clickText('button', /^(Confirmar|Sí, desembolsar|Desembolsar)$/).catch(() => undefined);
    await page.waitForFunction(() => /Desembolso confirmado|desembolsad/i.test(document.querySelector('[aria-label="Notificaciones"]')?.innerText ?? ''), { timeout: 30_000 }).catch(() => undefined);
    await sleep(1000);
    const saleE = await saleOf('Cliente Sintético Centro E (aprobada, sin desembolsar)');
    ok('A-13', ['C-01'], 'El Cobrador desembolsa la venta aprobada «Centro E» (R$ 300): crédito activo y custodia −300', !!saleE && saleE.v === 30_000 && (await custody(M.cob1, C1)) === k0 - 30_000, JSON.stringify({ saleE, k0, k1: await custody(M.cob1, C1) }));
    const saleA = await saleOf('Cliente Sintético Centro A');
    k0 = await custody(M.cob1, C1);
    const pay0 = Number((await one('select count(*)::int n from adex.payments where sale_id = $1', [saleA.id])).n);
    await go(`/collector/payment/${saleA.id}`);
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="payment-submit"]'); return b && !b.disabled; }, { timeout: 45_000 }).catch(() => undefined);
    // Pendientes 3.15 y 3.16 (socio): «Cuotas a pagar» llena el valor y la pantalla muestra el día del desembolso.
    const two = Number((await one(`select coalesce(sum(balance_minor), 0)::int s from (select balance_minor from adex.installments
      where sale_id = $1 and status not in ('pagada', 'sustituida') and balance_minor > 0 order by number limit 2) x`, [saleA.id])).s);
    await setInput('#payment-installments', '2'); await sleep(500);
    const filled = minorOf('R$ ' + await page.$eval('#payment-amount', (el) => el.value));
    ok('A-14b', ['C-01'], 'Cobro: «Cuotas a pagar» = 2 llena el valor con la suma de las dos cuotas pendientes', two > 0 && filled === Math.round(two / 100) * 100, JSON.stringify({ two, filled }));
    const dd = (await one('select to_char(disbursement_date, \'DD/MM/YYYY\') d from adex.sales where id = $1', [saleA.id])).d;
    const shownDate = await page.$eval('[data-testid="payment-disbursed-date"]', (el) => el.innerText).catch(() => '');
    ok('A-14c', ['C-01'], 'Cobro: muestra «Desembolsada el» con el día del desembolso', !!dd && shownDate.includes(dd), JSON.stringify({ dd, shownDate }));
    await setInput('#payment-amount', '60'); await sleep(400);
    await both('A-14-cobro', () => waitTestid('payment-submit'));
    await tap('payment-submit');
    await page.waitForFunction((id, n) => true, { timeout: 1000 }, saleA.id, pay0).catch(() => undefined);
    let paid = false;
    for (let i = 0; i < 20 && !paid; i++) { await sleep(1000); paid = Number((await one('select count(*)::int n from adex.payments where sale_id = $1', [saleA.id])).n) === pay0 + 1; }
    ok('A-15', ['C-01'], 'Cobro de R$ 60 en «Centro A» desde la pantalla de cobro: custodia +60', paid && (await custody(M.cob1, C1)) === k0 + 6_000, `custodia ${k0} → ${await custody(M.cob1, C1)}`);

    // Venta directa del Administrador desde la Base de Centro 2 (ruta sin Cobrador): nuevo cliente y venta.
    await login('admin1.norte@example.test');
    const c2Client = 'Cliente E2E Centro 2 Directa João';   // con tilde: lo usa la búsqueda sin acentos (A-16b)
    await go('/admin/clients'); await sleep(2000);
    await clickText('button', /Nuevo cliente/);
    await page.waitForFunction(() => [...document.querySelectorAll('label')].some((l) => l.innerText.includes('Número de documento')), { timeout: 20_000 });
    await pick('Tipo de documento', 'CPF');
    await setField('Número de documento', doc11()); await setField('Nombre completo', c2Client); await setField('Teléfono principal', '11988887777');
    await setField('Dirección de la casa', 'Rua Sintética E2E, 1'); await setField('Dirección del negocio', 'Rua Sintética E2E, 2'); await setField('Negocio', 'Comércio E2E');
    await pick('Ruta', 'Ruta Centro 2'); await sleep(300);
    await clickText('button', /^Crear cliente$/);
    const clientOk = await page.waitForFunction((n) => true, { timeout: 500 }, c2Client).then(() => true);
    let cl = null;
    for (let i = 0; i < 15 && !cl; i++) { await sleep(1000); cl = await one('select id, route_id from adex.clients where name = $1', [c2Client]); }
    ok('A-16', ['C-01'], 'Admin 1 crea un cliente en Centro 2 desde Clientes', clientOk && cl?.route_id === C2, JSON.stringify(cl));
    // Pendiente 3.1: el buscador de Clientes no distingue acentos («joao» encuentra «JOÃO»).
    await page.evaluate(() => { const el = document.querySelector('input[aria-label="Buscar clientes"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'joao'); el.dispatchEvent(new Event('input', { bubbles: true })); });
    const foundFolded = await page.waitForFunction(() => /DIRECTA JO[ÃA]O/i.test(document.body.innerText), { timeout: 10_000 }).then(() => true).catch(() => false);
    ok('A-16b', ['C-01'], 'Clientes: buscar «joao» (sin tilde) encuentra al cliente «… Directa João»', foundFolded);
    await page.evaluate(() => { const el = document.querySelector('input[aria-label="Buscar clientes"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); });
    // Pendiente 3.14 (0040): casilla «Para Cobradores» en Categorías de gasto y lista filtrada del Cobrador.
    const catRow = (name) => one('select id, for_collectors from adex.expense_categories where company_id = $1 and name = $2 and deleted_at is null', [N, name]);
    const papel = await catRow('Papelería'), transp = await catRow('Transporte');
    await go('/admin/expense-categories'); await waitTestid(`cat-collectors-${papel.id}`);
    const shownMarks = await page.evaluate((a, b) => [a, b].map((id) => document.querySelector(`[data-testid="cat-collectors-${id}"]`)?.checked ?? null), papel.id, transp.id);
    await tap(`cat-collectors-${papel.id}`);
    let marked = false;
    for (let i = 0; i < 20 && !marked; i++) { await sleep(700); marked = (await catRow('Papelería')).for_collectors === true; }
    await both('A-16c-categorias', () => waitTestid(`cat-collectors-${papel.id}`));
    ok('A-16c', ['C-01'], 'Categorías: Transporte nace marcada «Para Cobradores» y Papelería no; el Administrador marca Papelería', shownMarks[0] === false && shownMarks[1] === true && marked, JSON.stringify({ shownMarks, marked }));
    await clickText('button', /Nueva categoría/); await waitTestid('cat-form-collectors');
    await setField('Nombre de la categoría', 'Peaje E2E'); await tap('cat-form-collectors'); await sleep(300); await tap('cat-save');
    let peaje = null;
    for (let i = 0; i < 20 && !peaje; i++) { await sleep(700); peaje = await catRow('Peaje E2E'); }
    ok('A-16d', ['C-01'], 'Categorías: «Nueva categoría» con la casilla marcada la crea «Para Cobradores»', peaje?.for_collectors === true, JSON.stringify(peaje));
    let peajeGone = false;
    if (peaje) {
      await waitTestid(`cat-delete-${peaje.id}`); await tap(`cat-delete-${peaje.id}`); await waitTestid('cat-delete-confirm');
      const noHistoryText = !(await page.$('[data-testid="cat-delete-keeps"]'));
      await tap('cat-delete-confirm');
      for (let i = 0; i < 20 && !peajeGone; i++) { await sleep(700); peajeGone = !(await one('select id from adex.expense_categories where id = $1', [peaje.id])); }
      peajeGone = peajeGone && noHistoryText && await gone(`cat-row-${peaje.id}`, 15_000);
    }
    ok('A-16e', ['C-01'], 'Categorías: eliminar una categoría sin gastos la borra y sale de la lista', peajeGone);
    await login('cobrador1.norte@example.test');
    await go('/collector/expenses'); await waitTestid('expense-new'); await tap('expense-new'); await waitTestid('expense-category');
    const offered = await page.$$eval('[data-testid="expense-category"] option', (os) => os.map((o) => o.textContent.trim()).filter((t) => t && !t.startsWith('Seleccionar')));
    await both('A-16f-cobrador-categorias', () => waitTestid('expense-category'));
    ok('A-16f', ['C-01'], 'Gastos del Cobrador: solo ofrece las categorías marcadas (Alimentación, Combustible, Papelería, Transporte)',
      JSON.stringify([...offered].sort()) === JSON.stringify(['Alimentación', 'Combustible', 'Papelería', 'Transporte']), JSON.stringify(offered));
    await login('admin1.norte@example.test');
    const bC2 = await base(C2), bC1 = await base(C1);
    await go('/admin/active-sales'); await sleep(2000);
    await clickText('button', /^Nueva venta$/);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes('Valor de la venta')), { timeout: 20_000 });
    await pick('Ruta', 'Ruta Centro 2'); await sleep(800); if (!(await pickSearch('Cliente', 'E2E CENTRO 2').catch(() => false))) await pickSearch('Cliente', 'Directa');
    await sleep(1200);
    const dispTxt = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText.replace(/\u00a0/g, ' ') ?? '');
    const cap = minorOf((dispTxt.match(/Disponible para esta venta:\s*(R\$\s*[\d.,]+)/) ?? [])[1]);
    ok('B-01', ['C-06'], 'Venta directa: «Disponible para esta venta» = Base de Centro 2 (no la de Centro 1 ni el consolidado)', cap === bC2 && bC2 < bC1, JSON.stringify({ cap, bC2, bC1 }));
    await setField('Valor de la venta', String(Math.ceil(bC2 / 100) + 500)); await sleep(500);
    const overSale = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText.includes('El valor supera el dinero disponible'));
    const createBtnDisabled = await page.evaluate(() => [...[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelectorAll('button')].find((b) => b.innerText.trim() === 'Crear venta')?.disabled);
    await shot('B-02-venta-mayor-que-base-1280');
    ok('B-02', ['C-06'], 'Venta mayor que la Base de Centro 2 (con Centro 1 con más dinero): la pantalla la rechaza', overSale && createBtnDisabled === true);
    await setField('Valor de la venta', '200'); await sleep(500);
    await clickText('button', /^Crear venta$/);
    await sleep(800);
    if (await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /otra venta|ya tiene una venta/i.test(d.innerText)))) await clickText('button', /Crear|Confirmar|Sí/);
    const saleOk = await waitToast('Venta creada');
    const saleC2 = await saleOf(c2Client);
    ok('A-17', ['C-01'], 'Venta directa de R$ 200 en Centro 2: sale de la Base de Centro 2 (y solo de ella)', saleOk && saleC2?.v === 20_000 && (await base(C2)) === bC2 - 20_000 && (await base(C1)) === bC1, JSON.stringify({ saleC2, bC2, after: await base(C2) }));

    // Gasto general con un aporte mayor que la Base de su ruta: la pantalla lo impide.
    await toPanel();
    await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    await pick('Categoría', 'Papelería'); await setField('Valor total', String(Math.ceil((await base(C2)) / 100) + 100)); await setField('Descripción', 'Aporte mayor que la Base (no se registra)');
    await setField('Aporte de Ruta Centro 2', String(Math.ceil((await base(C2)) / 100) + 100)); await sleep(400);
    ok('B-03', ['C-06'], 'Gasto general: un aporte mayor que la Base de Centro 2 se impide («Supera la Base disponible», Registrar deshabilitado)', ((await testid('ge-contributions')) ?? '').includes('Supera la Base disponible') && (await disabled('ge-save')) === true);
    await shot('B-03-aporte-mayor-1280');
    await page.keyboard.press('Escape'); await sleep(300);
    await clickText('button', /^(Descartar|Salir sin guardar|Sí, descartar)$/).catch(() => undefined);

    // Transferencias entre rutas: propia (inmediata) y hacia otro responsable (aviso).
    let [t1, t2] = [await base(C1), await base(C2)];
    await openOp('transfer');
    await pick('Ruta de origen', 'Ruta Centro 1'); await sleep(300); await pick('Ruta destino', 'Ruta Centro 2'); await setField('Valor', '400'); await setField('Concepto', 'Refuerzo de Centro 2 (E2E)');
    await both('B-04-transferencia-propia', () => waitTestid('rb-form-transfer'));
    ok('B-04', ['C-01', 'C-06'], 'Transferencia Centro 1 → Centro 2 (mismo responsable): inmediata, sin aceptación', await saveOp('Transferencia entre rutas registrada') && (await base(C1)) === t1 - 40_000 && (await base(C2)) === t2 + 40_000);
    [t2] = [await base(C2)]; const tO1 = await base(O1);
    await openOp('transfer');
    await pick('Ruta de origen', 'Ruta Centro 2'); await sleep(300); await pick('Ruta destino', 'Ruta Oeste 1'); await setField('Valor', '150'); await setField('Concepto', 'Apoyo a Oeste 1 (E2E)'); await sleep(300);
    const hint = await text();
    ok('B-05', ['C-01'], 'Transferencia Centro 2 → Oeste 1 (otro responsable): avisa que el destino recibirá un aviso y se aplica en el acto', hint.includes('recibirá un aviso') && await saveOp('Transferencia entre rutas registrada') && (await base(C2)) === t2 - 15_000 && (await base(O1)) === tO1 + 15_000);
    // Opciones de las Transferencias: solo sus rutas como origen.
    await openOp('withdraw');
    const wOpts = (await options('Ruta')) ?? [];
    ok('B-06', ['C-06', 'C-10'], 'Transferencias del Admin 1: como origen solo ofrece SUS rutas (nunca Oeste 1/2)', wOpts.some((o) => o.includes('Centro 1')) && !wOpts.some((o) => o.includes('Oeste')), wOpts.join(' | '));
    await page.keyboard.press('Escape');

    // ======================================================================================================
    // C · Gastos generales A / C1 / C2 y reembolsos (parcial, total, a sí mismo); nunca dos veces
    // ======================================================================================================
    stage = 'C';
    await toPanel();
    let [g1, g2] = [await base(C1), await base(C2)];
    await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    await pick('Categoría', 'Papelería'); await setField('Valor total', '90'); await setField('Descripción', 'Papelería conjunta E2E (A)');
    await setField('Aporte de Ruta Centro 1', '60'); await setField('Aporte de Ruta Centro 2', '30'); await sleep(400);
    await both('C-01-gasto-A', () => waitTestid('ge-form'));
    await tap('ge-save');
    ok('C-01', ['C-01', 'C-08'], 'Gasto general A (R$ 90) con aportes de Centro 1 (60) y Centro 2 (30)', await gone('ge-form') && await waitToast('Gasto general registrado') && (await base(C1)) === g1 - 6_000 && (await base(C2)) === g2 - 3_000);
    const eA = await one(`select id from adex.expenses where company_id = $1 and description = 'Papelería conjunta E2E (A)'`, [N]);
    ok('C-02', ['C-08'], 'PostgreSQL: un solo gasto y dos aportes', Number((await one('select count(*)::int n from adex.general_funding_contributions where expense_id = $1', [eA.id])).n) === 2);
    g2 = await base(C2);
    await sleep(800); await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    await pick('Categoría', 'Otros'); await setField('Valor total', '40'); await setField('Descripción', 'Servicio solo de Centro 2 E2E (A)');
    await setField('Aporte de Ruta Centro 2', '40'); await sleep(300); await tap('ge-save');
    ok('C-03', ['C-08'], 'Gasto general A (R$ 40) solo con aporte de Centro 2 (para la anulación por el nuevo responsable, RB-D7)', await gone('ge-form') && await waitToast('Gasto general registrado') && (await base(C2)) === g2 - 4_000);
    await sleep(800); await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    await page.click('[data-testid="ge-scope-empresa"]'); await sleep(300);
    const c1Txt = (await testid('ge-contributions')) ?? '';
    ok('C-04', ['C-06', 'C-10'], 'C1 (general de empresa): el formulario solo ofrece Centro 1 y Centro 2 (nunca rutas del Admin 2)', c1Txt.includes('Ruta Centro 1') && c1Txt.includes('Ruta Centro 2') && !c1Txt.includes('Oeste'), c1Txt.replace(/\n/g, ' | ').slice(0, 200));
    await pick('Categoría', 'Otros'); await setField('Valor total', '25'); await setField('Descripción', 'Contador (parte de Admin 1) E2E (C1)'); await setField('Aporte de Ruta Centro 1', '25'); await sleep(300);
    await tap('ge-save');
    ok('C-05', ['C-01', 'C-08'], 'C1 con aporte de Centro 1 registrado', await gone('ge-form') && await waitToast('Gasto general registrado'));
    const pay1 = await payable(M.ad1); g1 = await base(C1); g2 = await base(C2);
    await sleep(800); await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    await page.click('[data-testid="ge-source-own_money"]'); await sleep(300);
    await pick('Categoría', 'Otros'); await setField('Valor total', '120'); await setField('Descripción', 'Pagado con mi dinero E2E (C2)'); await sleep(300);
    await both('C-06-gasto-C2', () => waitTestid('ge-form'));
    await tap('ge-save');
    ok('C-06', ['C-01', 'C-08'], 'C2 con dinero propio (R$ 120): crea saldo a favor (obligación, NO efectivo) y ninguna Base cambia', await gone('ge-form') && await waitToast('saldo a favor') && (await payable(M.ad1)) === pay1 + 12_000 && (await base(C1)) === g1 && (await base(C2)) === g2, `pendiente ${pay1} → ${await payable(M.ad1)}`);
    // 0037: «Reembolsos pendientes» lista una obligación POR GASTO. Autorreembolso parcial (RB-D8) de la obligación
    // nueva desde Centro 1; después se paga el resto de cada obligación del Admin 1 desde Centro 2.
    const eOwn = await one(`select id from adex.expenses where company_id = $1 and description = 'Pagado con mi dinero E2E (C2)'`, [N]);
    const eRent = await one(`select id from adex.expenses where company_id = $1 and funding = 'own_money' and description = 'Arriendo de la oficina pagado por el Administrador Norte Uno'`, [N]);
    await sleep(800);
    const pend0 = await payable(M.ad1);
    const opened0 = await openObligation(eOwn.id);
    const rentRow = (await testid(`ge-obligation-${eRent.id}`)) ?? '';
    ok('C-07', ['C-08'], 'RB-D8: «Reembolsos pendientes» muestra una fila por obligación del Admin 1; el pago de la nueva se rotula «Autorreembolso» y su tope es lo pendiente de ESA obligación (R$ 120)',
      opened0 && !!(await testid('ge-self-note')) && minorOf(await testid('ge-reimb-pending')) === 12_000 && rentRow.includes('Arriendo'), `${await testid('ge-reimb-pending')} · total ${pend0} · arriendo: ${rentRow.replace(/\n/g, ' ').slice(0, 120)}`);
    await setField('Aporte de Ruta Centro 1', major(12_000 + 1_000)); await setField('Motivo', 'Más que lo pendiente'); await sleep(400);
    ok('C-08', ['C-08'], 'Reembolso mayor que lo pendiente de la obligación: la pantalla lo impide', (await disabled('ge-reimb-save')) === true && (await text()).includes('supera lo pendiente'));
    await setField('Aporte de Ruta Centro 1', '50'); await setField('Motivo', 'Autorreembolso parcial E2E'); await sleep(300);
    await both('C-09-autorreembolso', () => waitTestid('ge-reimb-form'));
    g1 = await base(C1);
    await tap('ge-reimb-save');
    const linkedOwn = async () => Number((await one('select count(*)::int n from adex.admin_reimbursements where company_id = $1 and expense_id = $2 and reversed_at is null', [N, eOwn.id])).n);
    ok('C-09', ['C-01', 'C-08'], 'Autorreembolso parcial R$ 50 desde Centro 1: pendiente −50, Base −50 y el pago queda enlazado a ESA obligación; el gasto no se registra otra vez',
      await gone('ge-reimb-form') && await waitToast('Reembolso registrado') && (await payable(M.ad1)) === pend0 - 5_000 && (await base(C1)) === g1 - 5_000 && (await linkedOwn()) === 1);
    await sleep(1000);
    const pend1 = await payable(M.ad1); g2 = await base(C2);
    const paidRest = [];
    for (const id of [eOwn.id, eRent.id]) {
      if (!(await openObligation(id))) { paidRest.push(`${id}: no abre`); continue; }
      const rest = minorOf(await testid('ge-reimb-pending'));
      await setField('Aporte de Ruta Centro 2', major(rest)); await setField('Motivo', 'Autorreembolso del resto E2E'); await sleep(300);
      await tap('ge-reimb-save');
      paidRest.push(`${rest}:${await gone('ge-reimb-form') && await waitToast('Reembolso registrado')}`);
      await sleep(1000);
    }
    ok('C-10', ['C-08'], `Pago del resto de cada obligación (total R$ ${pend1 / 100}) desde Centro 2: pendiente 0`, paidRest.every((x) => x.endsWith(':true')) && (await payable(M.ad1)) === 0 && (await base(C2)) === g2 - pend1, paidRest.join(' | '));
    await toPanel(); await tab('pendientes'); await sleep(500);
    const leftRows = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="ge-obligation-${id}"]`)).length, [eOwn.id, eRent.id]);
    const again = await (await apiAs('admin1.norte@example.test', M.ad1))('POST', '/v1/capital/reimbursements', { adminId: M.ad1, expenseId: eOwn.id, reason: 'Segundo pago de la misma obligación', contributions: [{ routeId: C1, amountMinor: 1_000 }] });
    ok('C-11', ['C-08'], 'Saldadas, las obligaciones del Admin 1 salen de «Reembolsos pendientes» y la API rechaza pagar otra vez la misma (no se paga dos veces)', leftRows === 0 && refused(again) && (await payable(M.ad1)) === 0, `filas ${leftRows} · API ${again.status} ${again.text.slice(0, 120)}`);
    // El inicio de sesión por la API cerró la sesión del navegador (una sola sesión activa por persona): se vuelve a entrar.
    await login('admin1.norte@example.test'); await toPanel();
    await tab('reembolsos');
    ok('C-12', ['C-01'], 'Historial de reembolsos y lista de gastos visibles a 390 y 1280 px', await both('C-12-historial-reembolsos', () => waitTestid('ge-reimbursements')));
    // Gastos: el total del encabezado deja claro que no incluye los gastos generales.
    await go('/admin/expenses'); await sleep(2500);
    const totTxt = (await testid('expenses-total')) ?? '';
    ok('C-13', ['C-08'], 'Gastos: el total del encabezado indica que NO incluye los gastos generales (listados aparte)', totTxt.includes('no incluye los gastos generales') && !!(await testid('ge-expenses-list')), totTxt);
    await both('C-13-gastos');

    // Préstamos Sintéticos Sur (admin_pool): C2 + reembolso desde la bolsa (RB-D9), nunca dos veces.
    await login('admin.sur@example.test');
    await go('/admin/capital');
    const poolUi = await page.waitForSelector('[data-testid="admin-pool"],[data-testid="pool-empty"]', { timeout: 30_000 }).then(() => true, () => false);
    ok('C-14', ['C-12'], 'Sur (admin_pool): Caja principal de bolsa de siempre, sin panel de Base por Ruta', poolUi && !(await page.$('[data-testid="rb-caja"]')));
    await both('C-14-sur-caja', () => waitTestid('ge-panel'));
    const poolS0 = await pool(M.adS, S), payS0 = await payable(M.adS, S);
    await waitTestid('ge-panel'); await sleep(800);
    await tap('ge-new'); await waitTestid('ge-form'); await sleep(500);
    ok('C-15', ['C-12'], 'Sur: el formulario solo ofrece «Mi dinero propio» (sin aportes de rutas)', !(await page.$('[data-testid="ge-source-routes"]')) && !!(await page.$('[data-testid="ge-source-own_money"]')));
    await pick('Categoría', 'Otros'); await setField('Valor total', '60'); await setField('Descripción', 'Internet de la oficina E2E (C2 Sur)'); await sleep(300);
    await tap('ge-save');
    ok('C-16', ['C-12', 'C-08'], 'Sur: C2 de R$ 60 → saldo a favor; la bolsa no cambia', await gone('ge-form') && await waitToast('saldo a favor') && (await payable(M.adS, S)) === payS0 + 6_000 && (await pool(M.adS, S)) === poolS0);
    await sleep(1000); await go('/admin/capital'); await waitTestid('ge-panel'); await sleep(1500);
    const payS1 = await payable(M.adS, S);
    await tap('ge-reimburse'); await waitTestid('ge-reimb-form'); await sleep(500);
    await setField('Valor del reembolso', major(payS1)); await setField('Motivo', 'Reembolso total desde mi bolsa E2E'); await sleep(300);
    await shot('C-17-sur-reembolso-bolsa-1280');
    await tap('ge-reimb-save');
    ok('C-17', ['C-12', 'C-08'], `RB-D9: reembolso total (R$ ${payS1 / 100}) desde la bolsa propia: pendiente 0 y la bolsa baja lo mismo`, await gone('ge-reimb-form') && await waitToast('Reembolso registrado') && (await payable(M.adS, S)) === 0 && (await pool(M.adS, S)) === poolS0 - payS1);
    await sleep(1000); await go('/admin/capital'); await waitTestid('ge-panel'); await sleep(1500);
    ok('C-18', ['C-08', 'C-12'], 'Sur: sin pendiente, «Pagar reembolso» deshabilitado (la misma obligación no se paga dos veces)', (await disabled('ge-reimburse')) === true);
    ok('C-19', ['C-12'], 'Sur sigue en admin_pool', (await model(S)) === 'admin_pool');

    // ======================================================================================================
    // F1 · Desactivación del Admin 2 con cuentas pendientes → rechazo con explicación (antes de saldar)
    // ======================================================================================================
    stage = 'F1';
    await login('sa.norte@example.test');
    const d1 = await toggleUserUi('admin2.norte@example.test');
    ok('F-01', ['C-05'], 'SuperAdmin → Usuarios → desactivar Admin 2: diálogo con las cuentas pendientes y NO lo desactiva',
      !!d1.dialog && ['CAPITAL_CONTROLLER', 'ADMIN_POOL_BALANCE', 'PENDING_REIMBURSEMENT', 'UNRESOLVED_DIFFERENCES', 'SUSPENSE_BALANCE'].every((c) => d1.codes.includes(c))
      && (await one('select status from adex.memberships where id = $1', [M.ad2])).status === 'activo', d1.codes.join(', '));
    ok('F-02', ['C-05'], 'Diálogo de bloqueos legible a 390 y 1280 px', await both('F-02-desactivacion-bloqueada', () => waitTestid('deactivation-blockers')));

    // ======================================================================================================
    // H1 · Aislamiento por la API directa (empresa ajena, rutas de otro Administrador, SuperAdmin sin dinero)
    // ======================================================================================================
    stage = 'H1';
    const a1 = await apiAs('admin1.norte@example.test', M.ad1);
    const surplusItem = await one(`select id from adex.custody_settlements where company_id = $1 and route_id = $2 order by closing_seq desc limit 1`, [N, O1]);
    let r;
    r = await a1('POST', '/v1/capital/differences/resolve', { sourceKind: 'settlement_surplus', sourceId: surplusItem.id, resolution: 'surplus_to_base', amountMinor: 2000, reason: 'Intento de conciliar una ruta ajena' });
    ok('H-01', ['C-10', 'C-03'], 'Admin 1 NO concilia la diferencia de una ruta del Admin 2 (Oeste 1)', refused(r), `${r.status} ${r.text.slice(0, 160)}`);
    r = await a1('POST', '/v1/expenses', { scope: 'empresa', fundingSource: 'routes', categoryId: (await one(`select id from adex.expense_categories where company_id = $1 and name = 'Otros'`, [N])).id, amountMinor: 1000, description: 'C1 con ruta ajena (API)', contributions: [{ routeId: O1, amountMinor: 1000 }] });
    ok('H-02', ['C-10', 'C-06'], 'Admin 1 NO aporta desde Oeste 1 (C1 por la API directa)', refused(r), `${r.status} ${r.text.slice(0, 160)}`);
    const bO1 = await base(O1);
    r = await a1('POST', '/v1/capital/route-base/withdrawals', { routeId: O1, amountMinor: 1000, reason: 'Retiro de una ruta ajena' });
    const r2 = await a1('POST', '/v1/capital/route-base/transfers', { fromRouteId: O1, toRouteId: C1, amountMinor: 1000, reason: 'Consumir la Base ajena' });
    ok('H-03', ['C-10', 'C-06'], 'Admin 1 NO retira ni transfiere desde la Base de Oeste 1', refused(r) && refused(r2) && (await base(O1)) === bO1, `${r.status}/${r2.status}`);
    r = await a1('POST', '/v1/credits/direct', { routeId: C2, clientId: cl.id, amountMinor: (await base(C2)) + 50_000, interestRate: 20, installmentsCount: 10, frequency: 'diaria', startDate: new Date().toISOString().slice(0, 10), paymentDays: [0, 1, 2, 3, 4, 5, 6] });
    ok('H-04', ['C-06'], 'Venta directa mayor que la Base de Centro 2 por la API directa: rechazada (no toma dinero de Centro 1)', refused(r), `${r.status} ${r.text.slice(0, 160)}`);
    r = await a1('GET', `/v1/routes/${RS1}`);
    const r3 = await a1('GET', `/v1/capital/differences?status=all&routeId=${RS1}`);
    const r4 = await a1('POST', '/v1/capital/route-base/injections', { routeId: RS1, amountMinor: 1000, reason: 'Inyección en ruta de otra empresa' });
    ok('H-05', ['C-10'], 'Token de Norte NO lee ni escribe rutas o diferencias de Sur', (r.status === 404 || r.status === 403) && (refused(r3) || (r3.body.items ?? []).length === 0) && refused(r4), `${r.status}/${r3.status}:${(r3.body.items ?? []).length}/${r4.status}`);
    const fake = await (async () => { const t = tokens.get('admin1.norte@example.test'); const x = await fetch(`${API}/v1/capital/differences`, { headers: { authorization: `Bearer ${t}`, 'x-adex-membership': M.adS } }); return x.status; })();
    ok('H-06', ['C-10'], 'Token de Norte con la membresía de Sur en la cabecera: rechazado', fake === 403 || fake === 401 || fake === 404, String(fake));
    const sa = await apiAs('sa.norte@example.test', M.sa);
    const saOps = [
      await sa('POST', '/v1/capital/route-base/injections', { routeId: C1, amountMinor: 1000, reason: 'SuperAdmin intenta inyectar' }),
      await sa('POST', '/v1/capital/route-base/withdrawals', { routeId: C1, amountMinor: 1000, reason: 'SuperAdmin intenta retirar' }),
      await sa('POST', '/v1/capital/deliveries', { routeId: C1, workerId: M.cob1, amountMinor: 1000, reason: 'SuperAdmin intenta entregar' }),
      await sa('POST', '/v1/capital/company/deposits', { amountMinor: 1000, reason: 'SuperAdmin intenta depositar' }),
      await sa('POST', '/v1/capital/differences/resolve', { sourceKind: 'settlement_surplus', sourceId: surplusItem.id, resolution: 'surplus_to_base', amountMinor: 2000, reason: 'SuperAdmin intenta conciliar' }),
    ];
    ok('H-07', ['C-11'], 'SuperAdmin NO ejecuta operaciones de dinero de route_base (inyección, retiro, entrega, depósito, conciliación)', saOps.every((x) => refused(x)), saOps.map((x) => x.status).join('/'));

    // ======================================================================================================
    // D · RB-D7 + 0037: cambio de responsable (SuperAdmin, estructural), anulación por el nuevo responsable (diálogo de
    //     corrección) y operación conjunta de dos responsables por el procedimiento de ANULACIÓN CONJUNTA: uno propone,
    //     el otro confirma su parte desde su pantalla y se asienta todo junto; quien propone puede cancelar. Nunca parcial.
    // ======================================================================================================
    stage = 'D';
    await login('sa.norte@example.test');
    ok('D-01', ['C-01', 'C-11'], 'SuperAdmin: Usuarios → Admin 2 → añade «Ruta Centro 2» a sus rutas', await addRoutesToUserUi('admin2.norte@example.test', ['Ruta Centro 2']));
    await go('/admin/capital'); await waitTestid('rb-sa-global'); await sleep(1000);
    const saPanel = await text();
    ok('D-02', ['C-11'], 'Panel de rutas del SuperAdmin: solo lectura (sin Transferencias ni registro de gastos)', !(await page.$('[data-testid="rb-go-transfers"]')) && !(await page.$('[data-testid="ge-new"]')) && saPanel.includes('Panel de rutas'));
    await both('D-02-sa-panel', () => waitTestid('rb-sa-global'));
    const ctrlOk = await changeControllerUi(C2, 'Norte Dos', 'El Admin 2 asume Centro 2 (prueba RB-D7)');
    const c2ctrl = await controller(C2);
    ok('D-03', ['C-01', 'C-11'], 'SuperAdmin cambia el responsable de Centro 2 al Admin 2 (Detalle → Cambiar responsable): ruta «en entrega»', ctrlOk && c2ctrl.c === M.ad2 && c2ctrl.h === 'en_entrega', JSON.stringify(c2ctrl));
    await login('admin2.norte@example.test');
    // El conteo físico tiene R$ 10 menos que la Base esperada: el acta queda con faltante.
    const bHand = await base(C2);
    const hv = await confirmHandoverUi('Ruta Centro 2', bHand - 1_000, 'Faltan R$ 10 en el conteo físico de la Base');
    ok('D-04', ['C-01'], 'Admin 2 ve el banner de entrega de Centro 2 con la Base esperada', hv.expected === bHand, JSON.stringify(hv));
    ok('D-05', ['C-01'], 'Admin 2 confirma el conteo con faltante de R$ 10 (acta con diferencia; la Base no se mueve)', hv.saved && (await controller(C2)).h === 'normal' && (await base(C2)) === bHand, JSON.stringify(hv));
    const hrec = await one(`select id, difference_minor::int d from adex.route_handover_records where route_id = $1 and status = 'confirmada' order by confirmed_at desc limit 1`, [C2]);
    ok('D-06', ['C-01'], 'PostgreSQL: acta confirmada de Centro 2', !!hrec, JSON.stringify(hrec));
    // El nuevo responsable anula el gasto A solo de Centro 2 y el reembolso sembrado al Admin 1 desde Centro 2 (diálogo de corrección).
    await toPanel(); await tab('gastos');
    const eOnlyC2 = await one(`select id from adex.expenses where company_id = $1 and description = 'Servicio solo de Centro 2 E2E (A)'`, [N]);
    let bc = await base(C2);
    const canRev = await rowClick(`ge-expense-${eOnlyC2.id}`, 'ge-expense-reverse');
    const effRev = canRev && await corrReady() ? (await testid('corr-effects')) ?? '' : '';
    if (canRev) { await setField('Motivo de la anulación', 'Lo anula el nuevo responsable de Centro 2'); await sleep(300); await tap('corr-confirm'); }
    ok('D-07', ['C-01', 'C-08'], 'RB-D7: el nuevo responsable (Admin 2) anula el gasto A de Centro 2 registrado por el Admin 1 (vista previa: +R$ 40 a la Base de Centro 2); el aporte vuelve a Centro 2',
      canRev && effRev.includes('Base de Ruta Centro 2') && await waitToast('Anulación registrada') && await gone('corr-dialog') && (await base(C2)) === bc + 4_000, `${effRev.replace(/\n/g, ' ')} · ${bc} → ${await base(C2)}`);
    await sleep(1000); await toPanel(); await tab('reembolsos');
    const seedReimb = await one(`select r.id, r.amount_minor::int a from adex.admin_reimbursements r where r.company_id = $1 and r.admin_membership_id = $2 and r.reason = 'Reembolso parcial del arriendo de la oficina'`, [N, M.ad1]);
    bc = await base(C2); const pA1 = await payable(M.ad1);
    const canRevR = await rowClick(`ge-reimb-${seedReimb.id}`, 'ge-reimb-reverse');
    if (canRevR && await corrReady()) { await setField('Motivo de la anulación', 'Reembolso pagado por error desde Centro 2'); await sleep(300); await tap('corr-confirm'); }
    ok('D-08', ['C-01', 'C-08'], 'RB-D7: el Admin 2 anula el reembolso al Admin 1 que salió de Centro 2: vuelve a la Base y la obligación queda pendiente otra vez',
      canRevR && await waitToast('Anulación registrada') && await gone('corr-dialog') && (await base(C2)) === bc + seedReimb.a && (await payable(M.ad1)) === pA1 + seedReimb.a, JSON.stringify({ bc, after: await base(C2), pA1, pA1b: await payable(M.ad1) }));

    // Operación conjunta: el gasto A con aportes de Centro 1 (Admin 1) y Centro 2 (ahora Admin 2), REGISTRADO por el Admin 1.
    // 0039 (RB-D12, propietario 2026-10-27): lo anula COMPLETO quien lo registró (Admin 1), sin anulación coordinada; el Admin 2 no.
    await sleep(800);
    let [j1, j2] = [await base(C1), await base(C2)];
    await toPanel(); await tab('gastos');
    const openedA2 = await rowClick(`ge-expense-${eA.id}`, 'ge-expense-reverse') && await corrReady();
    const blockedTxt = openedA2 ? (await testid('corr-blocked')) ?? '' : '';
    const noConfirmA2 = !(await page.$('[data-testid="corr-confirm"]')) && !(await page.$('[data-testid="corr-propose"]'));
    await both('D-09-conjunta-bloqueada', () => waitTestid('corr-blocked'));
    ok('D-09', ['C-08', 'C-10'], 'Operación conjunta: el Admin 2 (no la registró) ve que solo la anula quien la registró, con su nombre; no puede anularla ni proponer',
      openedA2 && noConfirmA2 && /Solo puede anularla/.test(blockedTxt) && /Norte Uno/i.test(blockedTxt) && (await base(C1)) === j1 && (await base(C2)) === j2, blockedTxt.replace(/\n/g, ' '));
    await page.keyboard.press('Escape').catch(() => undefined);
    const jApi2 = await (await apiAs('admin2.norte@example.test', M.ad2))('POST', `/v1/expenses/${eA.id}/reverse`, { reason: 'Intento del Admin 2 por la API' });
    ok('D-09b', ['C-08'], 'Por la API el Admin 2 tampoco la anula (403); el gasto conjunto sigue vigente y ningún dinero se movió',
      jApi2.status === 403 && jApi2.text.includes('CAPITAL_AUTHORITY_REQUIRED') && !(await one('select reversal_id from adex.expenses where id = $1', [eA.id])).reversal_id
      && (await base(C1)) === j1 && (await base(C2)) === j2, `${jApi2.status} ${jApi2.text.slice(0, 160)}`);
    // El Admin 1 (lo registró y sigue respondiendo por Centro 1) la anula completa desde el mismo diálogo.
    await login('admin1.norte@example.test');
    await toPanel(); await tab('gastos');
    const openedA1 = await rowClick(`ge-expense-${eA.id}`, 'ge-expense-reverse') && await corrReady();
    const directA1 = openedA1 && !!(await page.$('[data-testid="corr-confirm"]'));
    if (directA1) { await setField('Motivo de la anulación', 'Papelería conjunta duplicada: se anula entera'); await sleep(300); await tap('corr-confirm'); }
    const postedA1 = directA1 && await waitToast('Anulación registrada') && await gone('corr-dialog');
    await sleep(800);
    const revA = await one('select reversal_id from adex.expenses where id = $1', [eA.id]);
    ok('D-10', ['C-08', 'C-10'], 'El Admin 1 (lo registró) anula el gasto conjunto COMPLETO sin confirmación del Admin 2: Centro 1 +R$ 60, Centro 2 +R$ 30, gasto anulado',
      postedA1 && !!revA?.reversal_id && (await base(C1)) === j1 + 6_000 && (await base(C2)) === j2 + 3_000,
      JSON.stringify({ revA, c1: [j1, await base(C1)], c2: [j2, await base(C2)] }));
    const consA = await consultasHas('Anulación · aporte de ruta a gasto general', C1);
    await shot('D-11-consultas-anulacion-conjunta');
    const rev = await one(`select count(*)::int n, count(distinct o.route_id)::int routes, coalesce(sum(o.amount_minor), 0)::int a from adex.capital_operations o
      where o.company_id = $1 and o.reverses_operation_id in (select c.operation_id from adex.general_funding_contributions c where c.expense_id = $2)`, [N, eA.id]);
    ok('D-11', ['C-08', 'C-04'], 'Consultas (Centro 1) muestra la anulación; PostgreSQL: los dos aportes se anularon juntos (R$ 90, dos rutas), sin anulación parcial',
      consA && rev.n === 2 && rev.routes === 2 && rev.a === 9_000, JSON.stringify(rev));

    // ======================================================================================================
    // E · Diferencias (RB-D3) desde la pantalla «Diferencias»: el Administrador concilia sin aprobación superior
    // ======================================================================================================
    stage = 'E';
    await login('admin1.norte@example.test');
    await go('/admin/capital'); await waitTestid('rb-consolidated'); await sleep(1200);
    const alertC1 = await page.$(`[data-testid="rb-route-${C1}"] [data-testid="alert-PENDING_DIFFERENCES"]`);
    ok('E-01', ['C-04'], 'Centro 1 muestra la alerta «Diferencias por conciliar» (faltante sembrado de R$ 30)', !!alertC1);
    await page.click(`[data-testid="rb-route-${C1}"] [data-testid="alert-PENDING_DIFFERENCES"]`);
    await waitTestid('dif-list');
    ok('E-02', ['C-03'], 'La alerta abre «Diferencias» filtrada por la ruta', (await pathNow()) === '/admin/diferencias' && ((await testid('dif-list')) ?? '').includes('Ruta Centro 1'));
    await both('E-02-diferencias-admin1', () => waitTestid('dif-list'));
    const shortItem = await one(`select id from adex.custody_settlements where company_id = $1 and route_id = $2 order by closing_seq limit 1`, [N, C1]);
    await openDifference(shortItem.id, C1);
    await resolveInUi('route_shortage', 'La ruta asume el faltante del cuadre sembrado');
    const prevTxt = (await testid('dif-preview')) ?? '';
    await both('E-03-conciliar-faltante', () => waitTestid('dif-dialog'));
    let bd = await base(C1);
    await tap('dif-confirm');
    const concOk = await gone('dif-dialog') && await waitToast('Diferencia conciliada');
    const conc1 = await one(`select resolution, amount_minor::int a, actor_membership_id from adex.difference_conciliations where company_id = $1 and settlement_id = $2`, [N, shortItem.id]);
    ok('E-03', ['C-03', 'C-04'], 'Faltante de cuadre conciliado como «faltante de la ruta» por el Admin 1 (sin aprobación superior)', concOk && conc1?.resolution === 'route_shortage' && conc1.a === 3_000 && conc1.actor_membership_id === M.ad1,
      JSON.stringify({ conc1, concOk, base: [bd, await base(C1)], carried: (await one(`select carried_minor::int c from adex.capital_accounts where company_id = $1 and kind = 'custody' and route_id = $2 and membership_id = $3`, [N, C1, M.cob1]))?.c, prev: prevTxt.replace(/\n/g, ' | ').slice(0, 200) }));
    await go('/admin/capital'); await waitTestid('rb-consolidated'); await sleep(1500);
    ok('E-04', ['C-04'], 'Tras conciliar, la alerta PENDING_DIFFERENCES de Centro 1 desaparece', !(await page.$(`[data-testid="rb-route-${C1}"] [data-testid="alert-PENDING_DIFFERENCES"]`)));
    bd = await base(C1); let kd = await custody(M.cob1, C1);
    await openOp('deliver');
    await pick('Ruta', 'Ruta Centro 1'); await sleep(300); await pick('Trabajador', 'Norte Uno'); await setField('Valor', '50'); await setField('Concepto', 'Entrega posterior a la conciliación');
    ok('E-05', ['C-04'], 'La ruta sigue operando: una entrega posterior funciona', await saveOp('Entrega de Base a trabajador registrada') && (await base(C1)) === bd - 5_000 && (await custody(M.cob1, C1)) === kd + 5_000);
    ok('E-06', ['C-04'], 'Consultas muestra «Conciliación de diferencia»', await consultasHas('Conciliación de diferencia', C1));
    await both('E-06-consultas-conciliacion');

    // Nuevo cuadre del Cobrador 1 (Liquidación) con faltante → «El trabajador repone» (no mueve dinero).
    await go('/admin/weekly-settlement'); await sleep(2000);
    await clickText('button', /^Cuadre por trabajador$/); await sleep(800);
    await pick('Ruta', 'Ruta Centro 1'); await sleep(1500);
    await pick('Trabajador', 'Norte Uno'); await sleep(2500);
    const espTxt = await text();
    const esperado = minorOf((espTxt.match(/Esperado a entregar\s*(R\$\s*[\d.,]+)/) ?? [])[1]);
    await setField('Entregado', major(esperado - 1_500)); await sleep(500);
    await setField('Motivo de la diferencia (obligatorio)', 'Faltaron R$ 15 en el conteo del día (E2E)'); await sleep(300);
    await both('E-07-cuadre-faltante');
    await clickText('button', /^Cerrar cuadre$/); await sleep(800);
    await clickText('button', /^Confirmar cierre$/);
    await page.waitForFunction(() => /[Cc]uadre/.test(document.querySelector('[aria-label="Notificaciones"]')?.innerText ?? ''), { timeout: 20_000 }).catch(() => undefined);
    await sleep(1500);
    const newSet = await one(`select id, expected_position_minor::int e from adex.custody_settlements where company_id = $1 and route_id = $2 order by closing_seq desc limit 1`, [N, C1]);
    const newShort = await one(`select count(*)::int n from adex.custody_settlements where company_id = $1 and route_id = $2`, [N, C1]);
    ok('E-07', ['C-01'], `Cuadre del Cobrador 1 desde Liquidación (route_base) con faltante de R$ 15 (esperado ${esperado / 100})`, !!esperado && newShort.n >= 2, JSON.stringify(newSet));
    bd = await base(C1);
    await openDifference(newSet.id, C1);
    await resolveInUi('worker_owes', 'El trabajador repone el faltante en la próxima entrega');
    const noMoney = !!(await testid('dif-no-money'));
    await shot('E-08-trabajador-repone-1280');
    await tap('dif-confirm');
    const wOk = await gone('dif-dialog') && await waitToast('Diferencia conciliada');
    const conc2 = await one(`select resolution, amount_minor::int a, ledger_operation_id from adex.difference_conciliations where company_id = $1 and settlement_id = $2`, [N, newSet.id]);
    ok('E-08', ['C-03', 'C-04'], '«El trabajador repone»: no mueve dinero (vista previa y PostgreSQL), Base intacta', wOk && noMoney && conc2?.resolution === 'worker_owes' && !conc2.ledger_operation_id && (await base(C1)) === bd, JSON.stringify(conc2));
    // La ruta sigue: cobro del Cobrador 1 tras la conciliación.
    await login('cobrador1.norte@example.test');
    const saleB = await saleOf('Cliente Sintético Centro B');
    kd = await custody(M.cob1, C1);
    await go(`/collector/payment/${saleB.id}`);
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="payment-submit"]'); return b && !b.disabled; }, { timeout: 45_000 }).catch(() => undefined);
    await setInput('#payment-amount', '40'); await sleep(300); await tap('payment-submit');
    let paidB = false; for (let i = 0; i < 20 && !paidB; i++) { await sleep(1000); paidB = (await custody(M.cob1, C1)) === kd + 4_000; }
    ok('E-09', ['C-04'], 'Tras «El trabajador repone», el Cobrador sigue cobrando (custodia +40)', paidB);

    // Admin 2: sobrante sembrado → «Incorporar a la Base»; acta de Centro 2 → faltante de la ruta.
    await login('admin2.norte@example.test');
    await go('/admin/diferencias'); await waitTestid('dif-list'); await sleep(800);
    await both('E-10-diferencias-admin2', () => waitTestid('dif-list'));
    bd = await base(O1);
    await openDifference(surplusItem.id);
    await resolveInUi('surplus_to_base', 'El sobrante del cuadre se incorpora a la Base de la ruta');
    await tap('dif-confirm');
    const sOk = await gone('dif-dialog') && await waitToast('Diferencia conciliada');
    ok('E-10', ['C-03', 'C-04'], 'Sobrante de cuadre (R$ 20) incorporado a la Base de Oeste 1 por el Admin 2; el sobrante en control queda en 0', sOk && (await base(O1)) === bd + 2_000 && (await bal(N, 'suspense', { m: M.ad2 })) === 0, `${bd} → ${await base(O1)}`);
    if (hrec?.d) {
      bd = await base(C2);
      await openDifference(hrec.id);
      const allowed = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="dif-res-"]')].map((e) => e.getAttribute('data-testid').slice(8)));
      await resolveInUi(allowed.includes('route_shortage') ? 'route_shortage' : allowed[0], 'El faltante del acta de entrega lo asume la ruta');
      await tap('dif-confirm');
      const hOk = await gone('dif-dialog') && await waitToast('Diferencia conciliada');
      const conc3 = await one(`select resolution, amount_minor::int a from adex.difference_conciliations where company_id = $1 and handover_id = $2`, [N, hrec.id]);
      ok('E-11', ['C-03', 'C-04'], 'Diferencia del acta de entrega de Centro 2 (R$ 10) conciliada por el Admin 2', hOk && !!conc3 && conc3.a === Math.abs(hrec.d), JSON.stringify({ conc3, allowed, bd, after: await base(C2) }));
    } else ok('E-11', ['C-03'], 'Diferencia del acta de entrega', false, 'el acta no quedó con diferencia');
    await go('/admin/capital'); await waitTestid('rb-consolidated'); await sleep(1500);
    ok('E-12', ['C-04'], 'Admin 2: ninguna ruta conserva la alerta PENDING_DIFFERENCES', !(await page.$('[data-testid="alert-PENDING_DIFFERENCES"]')));
    bd = await base(C2);
    await openOp('inject');
    await pick('Ruta', 'Ruta Centro 2'); await setField('Valor', '100'); await setField('Concepto', 'Inyección posterior a la conciliación del acta');
    ok('E-13', ['C-04'], 'Centro 2 sigue operando tras conciliar el acta (inyección)', await saveOp('Inyección de Base registrada') && (await base(C2)) === bd + 10_000);
    ok('E-14', ['C-04'], 'Consultas del Admin 2 (perspectiva Oeste 1) muestra «Conciliación de diferencia»', await consultasHas('Conciliación de diferencia', O1));

    // SuperAdmin y Supervisor: solo lectura (sin botones de conciliar); selector de empresa del Supervisor.
    await login('sa.norte@example.test');
    await go('/admin/diferencias'); await waitTestid('dif-history'); await sleep(1000);
    ok('E-15', ['C-11'], 'SuperAdmin: Diferencias en solo lectura (historial; sin «Conciliar»)', ((await testid('dif-history')) ?? '').includes('Incorporar') && !(await page.$('[data-testid="dif-confirm"]')) && !/Conciliar$/m.test(await text()));
    await both('E-15-sa-diferencias', () => waitTestid('dif-history'));
    stage = 'supervisor';
    await session(); await go('/login'); await page.waitForSelector('input[type=email]');
    await setInput('input[type=email]', 'supervisor.norte@example.test'); await setInput('input[type=password]', PASS);
    await page.$eval('form', (f) => f.requestSubmit());
    await page.waitForFunction(() => location.pathname !== '/login', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForFunction(() => document.body.innerText.includes('Sur'), { timeout: 20_000 }).catch(() => undefined);
    const selTxt = await text();
    ok('E-16', ['C-01'], 'Supervisor: selector de contexto con Norte y Sur', selTxt.includes('Cobros Sintéticos Norte') && selTxt.includes('Préstamos Sintéticos Sur'));
    await both('E-16-supervisor-selector');
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Cobros Sintéticos Norte'))?.click());
    await page.waitForFunction(() => location.pathname !== '/contexto', { timeout: 30_000 }).catch(() => undefined);
    // El Supervisor elige primero la ruta que trabaja (capa operativa) y abre «Diferencias» del menú.
    await page.waitForFunction(() => document.body.innerText.includes('Trabajar esta ruta'), { timeout: 20_000 }).catch(() => undefined);
    await clickText('button', /Trabajar esta ruta/);
    await page.waitForFunction(() => !location.pathname.endsWith('select-route'), { timeout: 20_000 }).catch(() => undefined);
    await go('/supervisor/diferencias'); await waitTestid('dif-page'); await sleep(1500);
    const supTxt = await text();
    ok('E-17', ['C-01', 'C-11'], 'Supervisor (Norte): Diferencias en solo lectura, sin resolver', supTxt.includes('solo lectura') && !(await page.$('[data-testid="dif-confirm"]')));
    await both('E-17-supervisor-diferencias', () => waitTestid('dif-page'));
    const switched = await page.click('[aria-label="Cambiar empresa o rol"]').then(() => true, () => false);
    await page.waitForFunction(() => location.pathname === '/contexto', { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Préstamos Sintéticos Sur'))?.click());
    await page.waitForFunction(() => location.pathname !== '/contexto', { timeout: 30_000 }).catch(() => undefined);
    await sleep(1500);
    ok('E-18', ['C-01', 'C-12'], 'Supervisor cambia a Sur con «Cambiar empresa o rol»', switched && (await text()).includes('Préstamos Sintéticos Sur'));
  }

  if (P2) {
    // ======================================================================================================
    // F · Saldar y entregar las cuentas del Admin 2 desde la interfaz; después la desactivación se permite
    // ======================================================================================================
    stage = 'F';
    // F-03: ADMIN_POOL_BALANCE → el Admin 2 reparte su saldo «sin asignar» a Oeste 2.
    await login('admin2.norte@example.test');
    const un2 = await pool(M.ad2, N); const bO2 = await base(O2);
    await openOp('assign');
    await pick('Ruta', 'Ruta Oeste 2'); await setField('Valor', major(un2)); await setField('Concepto', 'Reparto del saldo sin asignar antes de entregar');
    await setField('Evidencia', 'Conteo del sistema anterior: Oeste 2 usaba esta bolsa');
    await page.click('[data-testid="rb-assign-confirm"]').catch(() => undefined); await sleep(300);
    await both('F-03-reparto-sin-asignar', () => waitTestid('rb-form-assign'));
    ok('F-03', ['C-05', 'C-13'], `ADMIN_POOL_BALANCE: el Admin 2 reparte su saldo sin asignar (R$ ${un2 / 100}) a Oeste 2 desde Transferencias`, un2 > 0 && await saveOp('Reparto de saldo sin asignar registrada') && (await pool(M.ad2, N)) === 0 && (await base(O2)) === bO2 + un2);
    // F-04: PENDING_REIMBURSEMENT → el Admin 2 se reembolsa a sí mismo (RB-D8) desde Oeste 2 antes de entregar sus rutas.
    // 0037: «Reembolsos pendientes» lista una obligación por gasto; el Admin 2 paga cada una de las SUYAS («Pagar mi reembolso»).
    const p2 = await payable(M.ad2); const bO2r = await base(O2);
    const own2 = (await q(`select e.id from adex.expenses e where e.company_id = $1 and e.funding = 'own_money' and e.responsible_admin_membership_id = $2 and e.reversal_id is null and e.reverses_id is null order by e.created_at`, [N, M.ad2])).map((x) => x.id);
    const paid2 = [];
    for (const id of own2) {
      await toPanel(); await tab('pendientes');
      if ((await obligationPending(id)) == null) continue; // ya saldada
      if (!(await openObligation(id))) { paid2.push(`${id}: no abre`); continue; }
      const rest = minorOf(await testid('ge-reimb-pending'));
      await setField('Aporte de Ruta Oeste 2', major(rest)); await setField('Motivo', 'Autorreembolso antes de entregar mis rutas'); await sleep(300);
      if (paid2.length === 0) await shot('F-04-autorreembolso-admin2-1280');
      await tap('ge-reimb-save');
      paid2.push(`${rest}:${await gone('ge-reimb-form') && await waitToast('Reembolso registrado')}`);
      await sleep(1000);
    }
    ok('F-04', ['C-05', 'C-08'], `PENDING_REIMBURSEMENT: el Admin 2 paga cada obligación suya (total R$ ${p2 / 100}) con aporte de Oeste 2 (RB-D8)`,
      paid2.length > 0 && paid2.every((x) => x.endsWith(':true')) && (await payable(M.ad2)) === 0 && (await base(O2)) === bO2r - p2, `${paid2.join(' | ')} · ${p2} → ${await payable(M.ad2)} · ${(await toasts()).slice(0, 200)}`);
    // F-05: CAPITAL_CONTROLLER → el SuperAdmin asigna Oeste 1/2 al Admin 1 y le cambia el responsable de las tres rutas del Admin 2.
    await login('sa.norte@example.test');
    const dMid = await toggleUserUi('admin2.norte@example.test');
    ok('F-05', ['C-05'], 'Tras repartir, reembolsar y conciliar: solo queda «responsable de capital de rutas»', dMid.codes.length === 1 && dMid.codes[0] === 'CAPITAL_CONTROLLER', dMid.codes.join(', '));
    await page.keyboard.press('Escape');
    ok('F-06', ['C-05'], 'SuperAdmin: Usuarios → Admin 1 → añade Oeste 1 y Oeste 2', await addRoutesToUserUi('admin1.norte@example.test', ['Ruta Oeste 1', 'Ruta Oeste 2']));
    const moved = [];
    for (const [rid, name] of [[O1, 'Ruta Oeste 1'], [O2, 'Ruta Oeste 2'], [C2, 'Ruta Centro 2']]) moved.push(await changeControllerUi(rid, 'Norte Uno', `El Admin 1 recibe ${name} por la salida del Admin 2`));
    ok('F-07', ['C-05', 'C-11'], 'SuperAdmin cambia el responsable de Oeste 1, Oeste 2 y Centro 2 al Admin 1 (entregas estructurales)', moved.every(Boolean) && (await controller(O1)).c === M.ad1 && (await controller(O2)).c === M.ad1 && (await controller(C2)).c === M.ad1, moved.join('/'));
    const dHand = await toggleUserUi('admin2.norte@example.test');
    ok('F-08', ['C-05'], 'Mientras el Admin 1 no confirme el conteo, el bloqueo es «actas de entrega pendientes»', dHand.codes.includes('PENDING_HANDOVER') && !dHand.codes.includes('CAPITAL_CONTROLLER'), dHand.codes.join(', '));
    await page.keyboard.press('Escape');
    await login('admin1.norte@example.test');
    const hs = [];
    for (const name of ['Ruta Oeste 1', 'Ruta Oeste 2', 'Ruta Centro 2']) hs.push(await confirmHandoverUi(name, null, null));
    ok('F-09', ['C-05'], 'El Admin 1 confirma el conteo (exacto) de las tres rutas recibidas', hs.every((h) => h.saved) && [(await controller(O1)).h, (await controller(O2)).h, (await controller(C2)).h].every((h) => h === 'normal'), JSON.stringify(hs));
    await login('sa.norte@example.test');
    const dEnd = await toggleUserUi('admin2.norte@example.test');
    const st2 = (await one('select status from adex.memberships where id = $1', [M.ad2])).status;
    ok('F-10', ['C-05'], 'Ahora la desactivación del Admin 2 se permite («Usuario inactivo»)', !dEnd.dialog && st2 === 'inactivo', `${st2} ${dEnd.codes.join(',')}`);
    await both('F-10-usuarios-tras-desactivar');

    // ======================================================================================================
    // I · Cuadre y cierre de periodo en route_base; Cobrador sin conexión (service worker)
    // ======================================================================================================
    stage = 'I';
    await login('admin1.norte@example.test');
    // Entrega de Base al Cobrador 2 en Oeste 1 (ruta recibida) y su cuadre con faltante.
    await openOp('deliver');
    await pick('Ruta', 'Ruta Oeste 1'); await sleep(300); await pick('Trabajador', 'Norte Dos'); await setField('Valor', '100'); await setField('Concepto', 'Base del día en la ruta recibida');
    ok('I-00', ['C-01'], 'El Admin 1 entrega R$ 100 de Base al Cobrador 2 en Oeste 1 (ruta recibida del Admin 2)', await saveOp('Entrega de Base a trabajador registrada'));
    await go('/admin/weekly-settlement'); await sleep(2000);
    await clickText('button', /^Cuadre por trabajador$/); await sleep(800);
    await pick('Ruta', 'Ruta Oeste 1'); await sleep(1500);
    await pick('Trabajador', 'Norte Dos'); await sleep(2500);
    const esp2 = minorOf(((await text()).match(/Esperado a entregar\s*(R\$\s*[\d.,]+)/) ?? [])[1]);
    await setField('Entregado', major(esp2 - 700)); await sleep(400);
    await setField('Motivo de la diferencia (obligatorio)', 'Faltaron R$ 7 en el conteo (E2E concurrencia)'); await sleep(300);
    await clickText('button', /^Cerrar cuadre$/); await sleep(800);
    await clickText('button', /^Confirmar cierre$/); await sleep(2500);
    const setO1 = await one(`select id from adex.custody_settlements where company_id = $1 and route_id = $2 order by closing_seq desc limit 1`, [N, O1]);
    const pendO1 = await one(`select count(*)::int n from adex.difference_conciliations where settlement_id = $1`, [setO1.id]);
    ok('I-01', ['C-01'], 'Cuadre del Cobrador 2 en Oeste 1 (ahora del Admin 1) desde Liquidación, con faltante de R$ 7 pendiente', !!esp2 && pendO1.n === 0, JSON.stringify({ setO1, esp2 }));
    // Cierre de la semana anterior de Centro 1 (el servidor exige un periodo terminado).
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dow = (today.getDay() + 6) % 7; // lunes = 0
    const mon = new Date(today); mon.setDate(today.getDate() - dow - 7);
    const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await go('/admin/weekly-settlement'); await sleep(2000);
    await pick('Ruta', 'Ruta Centro 1'); await sleep(800);
    await page.evaluate((a, b) => {
      const ins = [...document.querySelectorAll('input[type=date]')];
      for (const [el, v] of [[ins[0], a], [ins[1], b]]) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, iso(mon), iso(sat));
    await sleep(600);
    await clickText('button', /^Generar$/); await sleep(2500);
    await clickText('button', /^Cerrar semana$/);
    await waitTestid('settlement-close-dialog', 15_000);
    await both('I-02-cierre-semana', () => waitTestid('settlement-close-dialog'));
    await tap('settlement-close-confirm');
    await sleep(3000);
    const closure = await one(`select id, week_start::text ws, week_end::text we from adex.period_closures where company_id = $1 and route_id = $2 order by closed_at desc limit 1`, [N, C1]);
    ok('I-02', ['C-01'], `Cierre de periodo (semana ${iso(mon)}–${iso(sat)}) de Centro 1 en route_base desde Liquidación`, closure?.ws === iso(mon), JSON.stringify(closure) + ' ' + (await toasts()));
    // La ruta sigue operando hoy tras el cierre de la semana anterior.
    const bAfterClose = await base(C1);
    await openOp('inject');
    await pick('Ruta', 'Ruta Centro 1'); await setField('Valor', '10'); await setField('Concepto', 'Inyección tras el cierre de la semana anterior');
    ok('I-03', ['C-01'], 'Tras el cierre, la ruta sigue operando hoy (inyección)', await saveOp('Inyección de Base registrada') && (await base(C1)) === bAfterClose + 1_000);

    // Cobrador 1: una venta nueva EN LÍNEA (cliente + solicitud), aprobada por el Admin 1 → el dispositivo la conoce.
    const offName = 'Cliente E2E Sin Conexion';
    await login('cobrador1.norte@example.test');
    await page.evaluate(() => navigator.serviceWorker?.ready.then(() => true)).catch(() => undefined);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30_000 }).catch(() => undefined);
    await go('/collector/clients/new');
    await page.waitForFunction(() => document.body.innerText.includes('Número de documento'), { timeout: 45_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.value === 'CPF')), { timeout: 20_000 }).catch(() => undefined);
    await setField('Número de documento', doc11()); await setField('Nombre completo', offName); await setField('Dirección de residencia', 'Rua E2E 10');
    await setField('Dirección de cobro / negocio', 'Rua E2E 20'); await setField('Negocio', 'Comércio E2E'); await setField('Teléfono', '11900001111');
    await page.evaluate(() => { const c = document.querySelector('input[type=checkbox]'); if (c && !c.checked) c.click(); });
    await sleep(500);
    await setField('Valor de la venta', '120'); await sleep(400);
    await shot('I-04-cobrador-cliente-y-solicitud-1280');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Guardar cliente/.test(x.innerText.trim())); b?.click(); });
    let sreq = null; for (let i = 0; i < 20 && !sreq; i++) { await sleep(1000); sreq = await one(`select r.id, r.status from adex.sale_requests r join adex.clients c on c.id = r.client_id where c.name = $1`, [offName.toUpperCase()]) ?? await one(`select r.id, r.status from adex.sale_requests r join adex.clients c on c.id = r.client_id where c.name ilike $1`, [offName]); }
    ok('I-04', ['C-14'], 'En línea, el Cobrador crea cliente + solicitud de venta (queda pendiente de aprobación)', sreq?.status === 'pending', JSON.stringify(sreq) + ' ' + (await toasts()).slice(0, 200));
    await login('admin1.norte@example.test');
    await go('/admin/sale-authorizations'); await sleep(2500);
    await page.evaluate((n) => { const row = [...document.querySelectorAll('tr,div.rounded-2xl,li')].filter((d) => d.innerText.toUpperCase().includes(n.toUpperCase())).sort((a, b) => a.innerText.length - b.innerText.length)[0]; [...(row?.querySelectorAll('button') ?? [])][0]?.click(); }, offName);
    await waitTestid('authorization-approve', 15_000); await sleep(1500);
    await tap('authorization-approve');
    let appr = null; for (let i = 0; i < 15 && appr !== 'approved'; i++) { await sleep(1000); appr = (await one('select status from adex.sale_requests where id = $1', [sreq?.id]))?.status; }
    ok('I-05', ['C-14'], 'El Admin 1 aprueba la solicitud desde Autorizaciones', appr === 'approved', appr);
    // El Cobrador necesita efectivo para desembolsar sin conexión: el Admin 1 le entrega R$ 300 de Base.
    await openOp('deliver');
    await pick('Ruta', 'Ruta Centro 1'); await sleep(300); await pick('Trabajador', 'Norte Uno'); await setField('Valor', '300'); await setField('Concepto', 'Base para desembolsar en campo');
    ok('I-05b', ['C-01'], 'El Admin 1 entrega R$ 300 de Base al Cobrador 1 (para el desembolso en campo)', await saveOp('Entrega de Base a trabajador registrada'));
    // Sin conexión: no hay alta de clientes ni ventas; desembolso aprobado y cobro sí, en cola; al volver, se sincronizan.
    await login('cobrador1.norte@example.test');
    await page.evaluate(() => navigator.serviceWorker?.ready.then(() => true)).catch(() => undefined);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout: 30_000 }).catch(() => undefined);
    await go('/collector/disbursements');
    await page.waitForFunction((n) => document.body.innerText.toUpperCase().includes(n.toUpperCase()), { timeout: 45_000 }, offName).catch(() => undefined);
    await go('/collector/home'); await sleep(2500);
    const saleD = await saleOf('Cliente Sintético Centro D');
    await go(`/collector/payment/${saleD.id}`); await page.waitForFunction(() => { const b = document.querySelector('[data-testid="payment-submit"]'); return b && !b.disabled; }, { timeout: 45_000 }).catch(() => undefined);
    const kOff0 = await custody(M.cob1, C1);
    const payD0 = Number((await one('select count(*)::int n from adex.payments where sale_id = $1', [saleD.id])).n);
    await page.setOfflineMode(true);
    await go('/collector/clients/new');
    const blockedClient = await waitTestid('offline-blocked', 30_000);
    const blockedTxt = (await testid('offline-blocked')) ?? '';
    await both('I-06-sin-conexion-cliente-bloqueado', () => waitTestid('offline-blocked'));
    await go('/collector/new-sale');
    const blockedSale = await waitTestid('offline-blocked', 30_000);
    ok('I-06', ['C-14'], 'Sin conexión: «Nuevo cliente» y «Nueva venta» no disponibles (aviso, sin formulario)', blockedClient && blockedSale && blockedTxt.includes('no disponible sin internet'), blockedTxt.replace(/\n/g, ' | ').slice(0, 160));
    await go(`/collector/payment/${saleD.id}`);
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="payment-submit"]'); return b && !b.disabled; }, { timeout: 45_000 }).catch(() => undefined);
    await setInput('#payment-amount', '50'); await sleep(300); await tap('payment-submit');
    const paySaved = await waitTestid('offline-payment-saved', 40_000);
    await go('/collector/disbursements');
    await page.waitForFunction(() => document.body.innerText.includes('Ventas aprobadas pendientes por desembolsar'), { timeout: 45_000 }).catch(() => undefined);
    await sleep(1500);
    await page.evaluate((n) => { const card = [...document.querySelectorAll('div.rounded-2xl')].find((d) => d.innerText.toUpperCase().includes(n.toUpperCase()) && d.innerText.includes('Confirmar desembolso')); [...(card?.querySelectorAll('button') ?? [])].find((x) => x.innerText.includes('Confirmar desembolso'))?.click(); }, offName);
    const disbSaved = await waitToast('guardado en este dispositivo', 30_000);
    await both('I-07-sin-conexion-desembolso-guardado');
    ok('I-07', ['C-14'], 'Sin conexión: el cobro y el desembolso aprobado quedan guardados en el dispositivo; el servidor aún no los tiene',
      paySaved && disbSaved && Number((await one('select count(*)::int n from adex.payments where sale_id = $1', [saleD.id])).n) === payD0 && !(await saleOf(offName.toUpperCase())) && (await custody(M.cob1, C1)) === kOff0, (await toasts()).slice(0, 200));
    await page.setOfflineMode(false);
    let synced = false;
    for (let i = 0; i < 60 && !synced; i++) {
      await sleep(1500);
      synced = Number((await one('select count(*)::int n from adex.payments where sale_id = $1', [saleD.id])).n) === payD0 + 1 && !!(await saleOf(offName.toUpperCase()) ?? await one(`select s.id from adex.sales s join adex.clients c on c.id = s.client_id where c.name ilike $1`, [offName]));
      if (i === 10) { await go('/collector/sync'); await waitTestid('offline-sync-now', 10_000); await tap('offline-sync-now'); }
    }
    ok('I-08', ['C-14', 'C-09'], 'Al volver la conexión, la cola se sincroniza: un cobro y un desembolso (una vez cada uno); custodia −120 +50', synced && (await custody(M.cob1, C1)) === kOff0 + 5_000 - 12_000, `custodia ${kOff0} → ${await custody(M.cob1, C1)}`);

    // ======================================================================================================
    // G · Activación: Empresa Vacía directa (todo en cero) y transición con saldos (Sur: Migrando → Base por Ruta)
    // ======================================================================================================
    stage = 'G';
    await login('sa.vacia@example.test');
    await go('/admin/capital/modelo'); await waitTestid('rb-prereqs');
    await page.waitForFunction(() => document.querySelector('[data-testid="rb-prereqs-state"]')?.textContent?.includes('Todos'), { timeout: 20_000 }).catch(() => undefined);
    ok('G-01', ['C-13'], 'Empresa Vacía: requisitos todos cumplidos (todo en cero)', ((await testid('rb-prereqs-state')) ?? '').includes('Todos cumplidos'));
    await setField('Evidencia de la autorización', 'Activación de la Empresa Vacía en la prueba E2E final (sintética)');
    await setField('Referencia del respaldo verificado', 'respaldo-e2e-vacia-0001'); await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR'); await sleep(300);
    await both('G-01-activacion-vacia', () => waitTestid('rb-activation-form'));
    await tap('rb-activation-submit');
    ok('G-02', ['C-13'], 'sa.vacia activa Base por Ruta directamente desde la pantalla', await waitToast('Base por Ruta activada') && (await model(V)) === 'route_base');
    await login('admin.vacia@example.test');
    await openOp('inject');
    await pick('Ruta', 'Ruta Vacía 1'); await setField('Valor', '500'); await setField('Concepto', 'Primera Base de la Ruta Vacía 1');
    ok('G-03', ['C-13', 'C-01'], 'admin.vacia inyecta R$ 500 de Base en Ruta Vacía 1', await saveOp('Inyección de Base registrada') && (await base(RV1, V)) === 50_000);

    // Sur con saldos: posiciones e ingresos ANTES.
    const incomeOf = async (c) => bal(c, 'income');
    const posBefore = { income: await incomeOf(S), company: await bal(S, 'company'), pools: await bal(S, 'admin'), custody: await bal(S, 'custody'), suspense: await bal(S, 'suspense'),
      portfolio: Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.sales where company_id = $1 and status = 'activa'`, [S])).s), ledger: await ledgerClean(S) };
    await login('sa.sur@example.test');
    await go('/admin/capital/modelo'); await waitTestid('rb-prereqs'); await sleep(1000);
    const dirChk = (await testid('rb-check-direct-activation-or-migrating')) ?? '';
    const dirOk = await page.$eval('[data-testid="rb-check-direct-activation-or-migrating"]', (e) => e.getAttribute('data-ok')).catch(() => null);
    await pick('Cambio', 'Activar Base por Ruta'); await sleep(300);
    await setField('Evidencia de la autorización', 'Intento de activación directa con saldos'); await setField('Referencia del respaldo verificado', 'respaldo-e2e-sur'); await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR'); await sleep(300);
    const blockedAct = (await disabled('rb-activation-submit')) === true && !!(await testid('rb-activation-blocked'));
    await both('G-04-sur-activacion-directa-rechazada', () => waitTestid('rb-prereqs'));
    const sS = await apiAs('sa.sur@example.test', M.saS);
    const apiDirect = await sS('POST', '/v1/capital/model', { target: 'route_base', evidence: 'Activación directa con saldos por la API', backupReference: 'respaldo-e2e-sur' });
    ok('G-04', ['C-13'], 'Sur con saldos: la activación directa se rechaza («Con saldos, pasa primero por Migrando») en pantalla y por la API', dirOk === '0' && dirChk.includes('Migrando') && blockedAct && refused(apiDirect), `${dirChk.replace(/\n/g, ' ')} · API ${apiDirect.status} ${apiDirect.text.slice(0, 120)}`);
    // Capital de empresa a cero (RB-D2) desde «Realizar movimientos», luego «Migrando» y activación.
    await login('sa.sur@example.test');
    await go('/admin/capital'); await waitTestid('sa-movements'); await sleep(800);
    const compS = await bal(S, 'company');
    await tap('sa-movements'); await waitTestid('sa-movement-form'); await sleep(400);
    await pick('Operación', 'Retiro de capital de la empresa'); await setField('Valor', major(compS)); await setField('Concepto', 'Capital de empresa a cero antes del corte (RB-D2)'); await sleep(300);
    await clickText('button', /^Registrar$/);
    let zero = false; for (let i = 0; i < 15 && !zero; i++) { await sleep(1000); zero = (await bal(S, 'company')) === 0; }
    ok('G-05', ['C-13', 'C-12'], `Sur: el SuperAdmin deja el capital de empresa en cero (retiro de R$ ${compS / 100}) con la pantalla de siempre`, zero);
    await go('/admin/capital/modelo'); await waitTestid('rb-prereqs'); await sleep(800);
    await pick('Cambio', 'Congelar bolsas'); await sleep(300);
    await setField('Evidencia de la autorización', 'Congelamos las bolsas de Sur para el corte (E2E)'); await setField('Escribe CONGELAR para confirmar', 'CONGELAR'); await sleep(300);
    await tap('rb-activation-submit');
    ok('G-06', ['C-13'], 'Sur pasa a «Migrando» (bolsas congeladas) desde la pantalla', await waitToast('Bolsas congeladas') && (await model(S)) === 'migrating');
    await sleep(1000); await go('/admin/capital/modelo'); await waitTestid('rb-prereqs');
    await page.waitForFunction(() => document.querySelector('[data-testid="rb-prereqs-state"]')?.textContent?.includes('Todos'), { timeout: 20_000 }).catch(() => undefined);
    await pick('Cambio', 'Activar Base por Ruta'); await sleep(300);
    await setField('Evidencia de la autorización', 'Corte de Sur autorizado por el propietario (E2E sintético)'); await setField('Referencia del respaldo verificado', 'respaldo-e2e-sur-0001'); await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR'); await sleep(300);
    await both('G-07-sur-activacion-desde-migrando', () => waitTestid('rb-activation-form'));
    await tap('rb-activation-submit');
    ok('G-07', ['C-13'], 'Desde «Migrando», Sur se activa en Base por Ruta', await waitToast('Base por Ruta activada') && (await model(S)) === 'route_base');
    const unS = await pool(M.adS, S);
    await login('admin.sur@example.test');
    await go('/admin/capital'); await waitTestid('rb-unassigned'); await sleep(1000);
    ok('G-08', ['C-13'], `admin.sur ve su «Saldo sin asignar» (R$ ${unS / 100}) con «Repartir a una ruta»`, unS === posBefore.pools && minorOf(await testid('rb-unassigned')) === unS && !!(await page.$('[data-testid="rb-assign-unassigned"]')));
    await both('G-08-sur-sin-asignar', () => waitTestid('rb-unassigned'));
    const half = Math.round(unS / 2 / 100) * 100;
    for (const [name, amt] of [['Ruta Sur 1', half], ['Ruta Sur 2', unS - half]]) {
      await openOp('assign');
      await pick('Ruta', name); await setField('Valor', major(amt)); await setField('Concepto', `Reparto del saldo anterior a la ${name}`);
      await setField('Evidencia', `Conteo del sistema anterior: la ${name} usaba esta bolsa`); await page.click('[data-testid="rb-assign-confirm"]').catch(() => undefined); await sleep(300);
      ok(`G-09 ${name}`, ['C-13'], `Reparto de R$ ${amt / 100} del saldo sin asignar a ${name}, con evidencia`, await saveOp('Reparto de saldo sin asignar registrada'));
    }
    const ev = await q(`select o.reason, o.amount_minor::int a from adex.capital_operations o where o.company_id = $1 and o.kind = 'LEGACY_POOL_TO_ROUTE' order by o.created_at`, [S]).catch(() => []);
    const posAfter = { income: await incomeOf(S), company: await bal(S, 'company'), pools: await bal(S, 'admin'), bases: (await base(RS1, S)) + (await base(RS2, S)), custody: await bal(S, 'custody'),
      portfolio: Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.sales where company_id = $1 and status = 'activa'`, [S])).s), ledger: await ledgerClean(S) };
    ok('G-10', ['C-13'], 'Transición: saldo sin asignar repartido por completo (bolsas 0 → Bases), custodias y cartera intactas', posAfter.pools === 0 && posAfter.bases === posBefore.pools && posAfter.custody === posBefore.custody && posAfter.portfolio === posBefore.portfolio, JSON.stringify({ posBefore, posAfter, ev }));
    ok('G-11', ['C-13'], 'Sin ingresos ficticios: las cuentas de ingreso de Sur no cambian con la transición y el libro concilia', posAfter.income === posBefore.income && isClean(posAfter.ledger), JSON.stringify({ incomeBefore: posBefore.income, incomeAfter: posAfter.income, ledger: posAfter.ledger }));

    // ======================================================================================================
    // H2 · Reintentos y concurrencia (HTTP directo)
    // ======================================================================================================
    stage = 'H2';
    const ad1 = await apiAs('admin1.norte@example.test', M.ad1);
    const opId = randomUUID(); const bR0 = await base(C1);
    const rep = await Promise.all([1, 2].map(() => ad1('POST', '/v1/capital/route-base/injections', { routeId: C1, amountMinor: 1_234, reason: 'Reintento con el mismo id (E2E)' }, { op: opId })));
    const rep3 = await ad1('POST', '/v1/capital/route-base/injections', { routeId: C1, amountMinor: 1_234, reason: 'Reintento con el mismo id (E2E)' }, { op: opId });
    const opIds = [...rep, rep3].map((x) => x.body?.operation?.id).filter(Boolean);
    ok('H-08', ['C-09'], 'Mismo X-Adex-Operation-Id reenviado (2 en paralelo + 1 después): una sola operación y la Base sube una vez', (await base(C1)) === bR0 + 1_234 && new Set(opIds).size <= 1 && [...rep, rep3].filter((x) => x.status < 300).length >= 1,
      `${[...rep, rep3].map((x) => x.status).join('/')} ops=${[...new Set(opIds)].join(',')} base ${bR0} → ${await base(C1)}`);
    const resolveBody = { sourceKind: 'settlement_shortage', sourceId: setO1.id, resolution: 'route_shortage', amountMinor: 700, reason: 'Concurrencia: dos conciliaciones a la vez' };
    const par = await Promise.all([ad1('POST', '/v1/capital/differences/resolve', resolveBody), ad1('POST', '/v1/capital/differences/resolve', resolveBody)]);
    const nConc = Number((await one('select count(*)::int n from adex.difference_conciliations where settlement_id = $1', [setO1.id])).n);
    ok('H-09', ['C-09'], 'Dos conciliaciones en paralelo de la misma diferencia: una entra y la otra se rechaza (DIFFERENCE_NOT_PENDING / conflicto)', par.filter((x) => x.status < 300).length === 1 && par.some((x) => x.status === 409 || x.text.includes('DIFFERENCE_NOT_PENDING')) && nConc === 1,
      par.map((x) => `${x.status} ${x.text.slice(0, 80)}`).join(' || '));
    const cat = (await one(`select id from adex.expense_categories where company_id = $1 and name = 'Otros'`, [N])).id;
    const bDrain = await base(O2);
    const chunk = Math.floor(bDrain * 0.7);
    const drain = await Promise.all([1, 2].map((i) => ad1('POST', '/v1/expenses', { scope: 'administrador', fundingSource: 'routes', categoryId: cat, amountMinor: chunk, description: `Concurrencia: aporte ${i} que vacía la Base (E2E)`, contributions: [{ routeId: O2, amountMinor: chunk }] })));
    ok('H-10', ['C-09', 'C-06'], 'Dos aportes en paralelo que vacían la misma Base (70 % cada uno): uno entra, el otro se rechaza y la Base nunca queda negativa', drain.filter((x) => x.status < 300).length === 1 && (await base(O2)) === bDrain - chunk && (await base(O2)) >= 0,
      `${drain.map((x) => x.status).join('/')} base ${bDrain} → ${await base(O2)}`);

    // ======================================================================================================
    // Z · Conciliación del libro y criterios globales
    // ======================================================================================================
    stage = 'Z';
    for (const [c, name] of [[N, 'Norte'], [S, 'Sur'], [V, 'Vacía']]) {
      const l = await ledgerClean(c);
      ok(`Z-01 ${name}`, ['C-07'], `Libro de ${name}: sin descuadres, operaciones balanceadas, sin Bases/bolsas negativas, suma 0`, isClean(l), JSON.stringify(l));
    }
    const saZ = await apiAs('sa.norte@example.test', M.sa);
    const rec = await saZ('GET', '/v1/capital/reconciliation');
    const failed = (rec.body.checks ?? []).filter((c) => !c.ok);
    ok('Z-02', ['C-07'], 'Conciliación del servidor (SuperAdmin Norte, incluye conservación por ruta): limpia', rec.status === 200 && failed.length === 0, JSON.stringify(failed).slice(0, 300));
    const dupAssign = Number((await one(`select count(*)::int n from (select operation_id from adex.capital_operations where company_id = $1 group by operation_id having count(*) > 1) x`, [N])).n);
    ok('Z-03', ['C-08', 'C-09'], 'Ningún id de operación aparece dos veces en el libro de Norte', dupAssign === 0, String(dupAssign));
  }

  if (P3) {
    // ======================================================================================================
    // T1 · Transición con CUSTODIAS ≠ 0 («Transición Sintética»: bolsa con saldo, Cobrador con efectivo en mano,
    //      cartera activa, empresa en cero). Activación directa negada → Migrando → activación → reparto del saldo
    //      sin asignar. Conservación: (bolsas + custodias) antes = (Bases + custodias + sin asignar) después.
    // ======================================================================================================
    stage = 'T1';
    const T = state.companies.D.id;
    const RT = state.facts.D.routes;
    const T1r = RT['Ruta Transición 1'], T2r = RT['Ruta Transición 2'];
    const mT = { sa: await mem('sa.transicion@example.test', T), ad: await mem('admin.transicion@example.test', T), cob: await mem('cobrador.transicion@example.test', T) };
    const custodyRows = async (c) => (await q(`select route_id, membership_id, balance_minor::bigint b, carried_minor::bigint k from adex.capital_accounts
        where company_id = $1 and kind = 'custody' order by route_id, membership_id`, [c])).map((r) => `${r.route_id}|${r.membership_id}|${r.b}|${r.k}`).join(';');
    const snapT = async () => ({
      model: await model(T), company: await bal(T, 'company'), pools: await bal(T, 'admin'), bases: await bal(T, 'route_base'),
      custody: await bal(T, 'custody'), custodyCob: await custody(mT.cob, T1r, T), custodyRows: await custodyRows(T),
      income: await bal(T, 'income'), suspense: await bal(T, 'suspense'),
      portfolio: Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.sales where company_id = $1 and status = 'activa'`, [T])).s),
      ledger: await ledgerClean(T),
    });
    const tStart = (await one('select now()::text t')).t;
    const before = await snapT();
    ok('T-01', ['C-13'], 'Transición Sintética: admin_pool con bolsa > 0, custodia del Cobrador > 0, cartera > 0, empresa en 0 y libro limpio',
      before.model === 'admin_pool' && before.pools > 0 && before.custodyCob > 0 && before.portfolio > 0 && before.company === 0 && isClean(before.ledger), JSON.stringify({ ...before, custodyRows: undefined }));

    await login('sa.transicion@example.test');
    await go('/admin/capital/modelo'); await waitTestid('rb-prereqs'); await sleep(1000);
    const tDirChk = (await testid('rb-check-direct-activation-or-migrating')) ?? '';
    const tDirOk = await page.$eval('[data-testid="rb-check-direct-activation-or-migrating"]', (e) => e.getAttribute('data-ok')).catch(() => null);
    await pick('Cambio', 'Activar Base por Ruta'); await sleep(300);
    await setField('Evidencia de la autorización', 'Intento de activación directa con saldos y custodias'); await setField('Referencia del respaldo verificado', 'respaldo-e2e-transicion'); await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR'); await sleep(300);
    const tBlocked = (await disabled('rb-activation-submit')) === true && !!(await testid('rb-activation-blocked'));
    await both('T-02-activacion-directa-rechazada', () => waitTestid('rb-prereqs'));
    const saT = await apiAs('sa.transicion@example.test', mT.sa);
    const tApiDirect = await saT('POST', '/v1/capital/model', { target: 'route_base', evidence: 'Activación directa con saldos por la API', backupReference: 'respaldo-e2e-transicion' });
    ok('T-02', ['C-13'], 'Activación directa con bolsa y custodias: rechazada en pantalla («pasa primero por Migrando») y por la API; el modelo no cambia',
      tDirOk === '0' && tDirChk.includes('Migrando') && tBlocked && refused(tApiDirect) && (await model(T)) === 'admin_pool', `${tDirChk.replace(/\n/g, ' ')} · API ${tApiDirect.status} ${tApiDirect.text.slice(0, 120)}`);

    await login('sa.transicion@example.test');
    await go('/admin/capital/modelo'); await waitTestid('rb-prereqs'); await sleep(800);
    await pick('Cambio', 'Congelar bolsas'); await sleep(300);
    await setField('Evidencia de la autorización', 'Congelamos las bolsas de Transición para el corte (E2E)'); await setField('Escribe CONGELAR para confirmar', 'CONGELAR'); await sleep(300);
    await tap('rb-activation-submit');
    const migOk = await waitToast('Bolsas congeladas') && (await model(T)) === 'migrating';
    const mid = await snapT();
    ok('T-03', ['C-13'], 'Pasa a «Migrando» desde la pantalla sin mover dinero (bolsas, custodias, cartera e ingresos iguales)',
      migOk && mid.pools === before.pools && mid.custodyRows === before.custodyRows && mid.portfolio === before.portfolio && mid.income === before.income && mid.bases === 0, JSON.stringify({ ...mid, custodyRows: undefined }));

    await sleep(1000); await go('/admin/capital/modelo'); await waitTestid('rb-prereqs');
    await page.waitForFunction(() => document.querySelector('[data-testid="rb-prereqs-state"]')?.textContent?.includes('Todos'), { timeout: 20_000 }).catch(() => undefined);
    await pick('Cambio', 'Activar Base por Ruta'); await sleep(300);
    await setField('Evidencia de la autorización', 'Corte de Transición autorizado por el propietario (E2E sintético)'); await setField('Referencia del respaldo verificado', 'respaldo-e2e-transicion-0001'); await setField('Escribe ACTIVAR para confirmar', 'ACTIVAR'); await sleep(300);
    await both('T-04-activacion-desde-migrando', () => waitTestid('rb-activation-form'));
    await tap('rb-activation-submit');
    ok('T-04', ['C-13'], 'Desde «Migrando», Transición Sintética se activa en Base por Ruta', await waitToast('Base por Ruta activada') && (await model(T)) === 'route_base');

    const unT = await pool(mT.ad, T);
    await login('admin.transicion@example.test');
    await go('/admin/capital'); await waitTestid('rb-unassigned'); await sleep(1000);
    ok('T-05', ['C-13'], `admin.transicion ve su «Saldo sin asignar» (R$ ${unT / 100}) = bolsa anterior, con «Repartir a una ruta»`,
      unT === before.pools && minorOf(await testid('rb-unassigned')) === unT && !!(await page.$('[data-testid="rb-assign-unassigned"]')));
    await both('T-05-sin-asignar', () => waitTestid('rb-unassigned'));
    const tHalf = Math.round(unT / 2 / 100) * 100;
    for (const [name, amt] of [['Ruta Transición 1', tHalf], ['Ruta Transición 2', unT - tHalf]]) {
      await openOp('assign');
      await pick('Ruta', name); await setField('Valor', major(amt)); await setField('Concepto', `Reparto del saldo anterior a la ${name}`);
      await setField('Evidencia', `Conteo del sistema anterior: la ${name} usaba esta bolsa`); await page.click('[data-testid="rb-assign-confirm"]').catch(() => undefined); await sleep(300);
      ok(`T-06 ${name}`, ['C-13'], `Reparto de R$ ${amt / 100} del saldo sin asignar a ${name}, con evidencia`, await saveOp('Reparto de saldo sin asignar registrada'));
    }
    const after = await snapT();
    const cashBefore = before.pools + before.custody + before.company;
    const cashAfter = after.bases + after.custody + after.pools + after.company;
    ok('T-07', ['C-13', 'C-07'], 'Conservación: bolsas + custodias ANTES = Base + custodias + sin asignar DESPUÉS; custodias idénticas (cada posición y su arrastre)',
      cashBefore === cashAfter && after.pools === 0 && after.bases === before.pools && after.custodyRows === before.custodyRows && after.custodyCob === before.custodyCob,
      JSON.stringify({ cashBefore, cashAfter, before: { pools: before.pools, custody: before.custody, company: before.company }, after: { bases: after.bases, custody: after.custody, unassigned: after.pools, company: after.company } }));
    const tKinds = (await q(`select kind, count(*)::int n from adex.capital_operations where company_id = $1 and created_at > $2::timestamptz group by kind order by kind`, [T, tStart])).map((r) => `${r.kind}×${r.n}`);
    ok('T-08', ['C-13'], 'Sin ingresos ficticios: ingresos, cartera y control sin cambios; las únicas operaciones nuevas son los repartos; libro limpio',
      // El reparto del saldo sin asignar se registra como LEGACY_POOL_TO_ROUTE (0034); Migrando y la activación no escriben dinero.
      after.income === before.income && after.portfolio === before.portfolio && after.suspense === before.suspense && tKinds.length === 1 && tKinds[0] === 'LEGACY_POOL_TO_ROUTE×2' && isClean(after.ledger),
      JSON.stringify({ incomeBefore: before.income, incomeAfter: after.income, portfolio: [before.portfolio, after.portfolio], kinds: tKinds, ledger: after.ledger }));
    await go('/admin/capital'); await waitTestid('rb-consolidated'); await sleep(1200);
    const tCons = { base: minorOf(await testid('rb-total-base')), custody: minorOf(await testid('rb-total-custody')), cash: minorOf(await testid('rb-total-cash')) };
    ok('T-09', ['C-07', 'C-13'], 'Caja principal tras la transición: Base disponible + Efectivo en custodias = Efectivo de las rutas (= PostgreSQL)',
      tCons.base === after.bases && tCons.custody === after.custody && tCons.cash === after.bases + after.custody, JSON.stringify(tCons));
    await both('T-09-caja-tras-transicion', () => waitTestid('rb-consolidated'));

    // ======================================================================================================
    // T2 · «Devolver el sobrante a su dueño» (surplus_returned) desde «Diferencias»: sale del control, no es ingreso
    // ======================================================================================================
    stage = 'T2';
    const surplusItem = await one(`select id from adex.custody_settlements where company_id = $1 and route_id = $2 and surplus_minor > 0 order by closing_seq desc limit 1`, [N, O1]);
    const uni = (r) => bal(N, 'unidentified', { route: r });
    const s0 = { base: await base(O1), suspense: await bal(N, 'suspense', { m: M.ad2 }), custody: await custody(M.cob2, O1), income: await bal(N, 'income'), unidentified: await uni(O1), portfolio: Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.sales where company_id = $1 and status = 'activa'`, [N])).s) };
    await login('admin2.norte@example.test');
    const opened = surplusItem ? await openDifference(surplusItem.id) : false;
    const offered = await page.$('[data-testid="dif-res-surplus_returned"]').then((e) => !!e);
    await resolveInUi('surplus_returned', 'El sobrante pertenece al Cobrador: se le devuelve en mano');
    const preview = (await testid('dif-preview')) ?? '';
    await both('T-10-devolver-sobrante-vista-previa', () => waitTestid('dif-dialog'));
    ok('T-10', ['C-01', 'C-03'], 'Admin 2 abre el sobrante de Oeste 1 en «Diferencias» y la pantalla ofrece «Devolver el sobrante a su dueño» con vista previa',
      !!surplusItem && opened && offered && preview.length > 0, preview.replace(/\s+/g, ' ').slice(0, 300));
    await tap('dif-confirm');
    const retOk = await gone('dif-dialog') && await waitToast('Diferencia conciliada');
    const concR = surplusItem ? await one(`select resolution, amount_minor::int a, actor_membership_id, ledger_operation_id from adex.difference_conciliations where company_id = $1 and settlement_id = $2`, [N, surplusItem.id]) : null;
    ok('T-11', ['C-03'], 'Conciliado por el Admin 2 sin aprobación superior: resolución surplus_returned de R$ 20 con operación en el libro',
      retOk && concR?.resolution === 'surplus_returned' && concR.a === 2_000 && concR.actor_membership_id === M.ad2 && !!concR.ledger_operation_id, JSON.stringify(concR));
    const s1 = { base: await base(O1), suspense: await bal(N, 'suspense', { m: M.ad2 }), custody: await custody(M.cob2, O1), income: await bal(N, 'income'), unidentified: await uni(O1), portfolio: Number((await one(`select coalesce(sum(balance_minor), 0)::bigint s from adex.sales where company_id = $1 and status = 'activa'`, [N])).s) };
    ok('T-12', ['C-03', 'C-07'], 'Efecto: el control del Admin 2 baja R$ 20 (sale del control); Base, custodia, cartera e INGRESOS no cambian; libro de Norte limpio',
      s1.suspense === s0.suspense - 2_000 && s1.suspense === 0 && s1.unidentified === s0.unidentified + 2_000 && s1.base === s0.base && s1.custody === s0.custody && s1.income === s0.income && s1.portfolio === s0.portfolio && isClean(await ledgerClean(N)),
      JSON.stringify({ s0, s1 }));
    await go('/admin/diferencias'); await waitTestid('dif-page'); await sleep(1200);
    const hist = (await testid('dif-history')) ?? '';
    ok('T-13', ['C-04'], 'El historial de «Diferencias» registra «Devolver el sobrante» y Oeste 1 ya no tiene la alerta de diferencias',
      /Devolver/.test(hist) && await (async () => { await go('/admin/capital'); await waitTestid('rb-consolidated'); await sleep(1200); return !(await page.$(`[data-testid="rb-route-${O1}"] [data-testid="alert-PENDING_DIFFERENCES"]`)); })(), hist.replace(/\s+/g, ' ').slice(0, 200));
    // Consultas: la devolución mueve «Sobrante en control» → «Origen sin identificar»; ninguna es cuenta de la ruta
    // (Base o custodias), así que en la perspectiva de la ruta cuenta como «no toca su Base ni sus custodias».
    const inRoute = await consultasHas('Conciliación de diferencia', O1);
    const outsideNote = /no tocan su Base disponible ni la Base del trabajador/.test(await text());
    await shot('T-14-consultas-admin2-oeste1');
    const dd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await go(`/admin/consultas?vista=actividad&perspectiva=${encodeURIComponent(`route:${O1}`)}&desde=${dd}&hasta=${dd}`); await sleep(2500);
    const inActivity = await waitText('Conciliación de diferencia', 8_000);
    await shot('T-14-consultas-admin2-actividad');
    ok('T-14a', ['C-01'], 'Consultas del Admin 2 (perspectiva Oeste 1): la devolución no cambia el efectivo de la ruta (fila en Dinero, o aviso «no tocan su Base ni sus custodias»)',
      inRoute || outsideNote, JSON.stringify({ filaEnDinero: inRoute, avisoFuera: outsideNote, filaEnActividad: inActivity }));
    await login('sa.norte@example.test');
    const inCompany = await consultasHas('Conciliación de diferencia');
    const companyTxt = await text();
    await shot('T-14-consultas-sa-empresa');
    // Fila de la tabla (escritorio): … | Persona / concepto | Responsable | Entrada | Salida.
    const cells = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('tr')].find((t) => t.innerText.includes('Conciliación de diferencia'));
      return tr ? [...tr.children].map((c) => c.innerText.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()) : null;
    });
    ok('T-14b', ['C-01', 'C-11'], 'Consultas del SuperAdmin (perspectiva Empresa): la devolución es una SALIDA de R$ 20 «Fuera de la empresa» («sobrante devuelto a su dueño»), sin entrada ni ingreso',
      inCompany && !!cells && cells.some((c) => /Fuera de la empresa/.test(c) && /sobrante devuelto/i.test(c)) && cells.at(-1) === 'R$ 20' && cells.at(-2) === '',
      JSON.stringify(cells ?? companyTxt.slice(0, 200)));

    // ======================================================================================================
    // T3 · Indicador del Supervisor en «Selecciona tu ruta»: Base real y custodias por separado (route_base);
    //      en el modelo de bolsas, «Efectivo en custodias» (nunca rotulado como Base).
    // ======================================================================================================
    stage = 'T3';
    await login('supervisor.norte@example.test', 'Cobros Sintéticos Norte');
    await go('/supervisor/select-route');
    const selOk = await waitTestid(`sel-route-${C1}`, 45_000);
    await sleep(1500);
    const card = async (r) => ({ base: minorOf(await testid(`sel-route-base-${r}`)), custody: minorOf(await testid(`sel-route-custody-${r}`)),
      baseLbl: await testid(`sel-route-base-${r}`), custLbl: await testid(`sel-route-custody-${r}`) });
    const cC1 = await card(C1), cO1 = await card(O1);
    const dbC1 = { base: await base(C1), custody: await bal(N, 'custody', { route: C1 }) }, dbO1 = { base: await base(O1), custody: await bal(N, 'custody', { route: O1 }) };
    const selTxt = await text();
    ok('T-15', ['C-07'], 'Supervisor Norte (Base por Ruta): cada tarjeta muestra «Base disponible» = Base real de la ruta y «Base del trabajador» aparte (= PostgreSQL), sin «Base de la ruta»',
      selOk && cC1.base === dbC1.base && cC1.custody === dbC1.custody && cO1.base === dbO1.base && cO1.custody === dbO1.custody
        && /Base disponible/.test(cC1.baseLbl ?? '') && /Base del trabajador/.test(cC1.custLbl ?? '') && !selTxt.includes('Base de la ruta'),
      JSON.stringify({ cC1: { base: cC1.base, custody: cC1.custody }, dbC1, cO1: { base: cO1.base, custody: cO1.custody }, dbO1 }));
    ok('T-16', ['C-01'], '«Selecciona tu ruta» del Supervisor sin desbordamiento a 390 y 1280 px', await both('T-16-supervisor-selecciona-ruta-norte', () => waitTestid(`sel-route-${C1}`)));
    await login('supervisor.norte@example.test', 'Préstamos Sintéticos Sur');
    await go('/supervisor/select-route');
    await sleep(1500);
    // Sur sigue en el modelo de bolsas en la parte 3: la tarjeta (una sola ruta autorizada puede autoseleccionarse).
    const surCard = await waitTestid(`sel-route-custody-${RS1}`, 30_000) ? minorOf(await testid(`sel-route-custody-${RS1}`)) : null;
    const surTxt = await text();
    ok('T-17', ['C-12'], 'Supervisor Sur (modelo de bolsas): la tarjeta rotula «Efectivo en custodias» (Σ custodias, = PostgreSQL) y no muestra Base',
      (await model(S)) === 'admin_pool' && surCard === (await bal(S, 'custody', { route: RS1 })) && !(await page.$(`[data-testid="sel-route-base-${RS1}"]`)) && !surTxt.includes('Base de la ruta'),
      `tarjeta=${surCard} · ruta=${await pathNow()}`);
    await shot('T-17-supervisor-selecciona-ruta-sur');

    stage = 'TZ';
    for (const [c, name] of [[N, 'Norte'], [T, 'Transición']]) {
      const l = await ledgerClean(c);
      ok(`TZ-01 ${name}`, ['C-07'], `Libro de ${name}: sin descuadres, operaciones balanceadas, sin saldos negativos indebidos, suma 0`, isClean(l), JSON.stringify(l));
    }
  }
  const other = errors.filter((x) => !x.e.includes('StaleContext'));
  ok('X-99', ['C-01'], 'Sin errores de JavaScript en las páginas', other.length === 0, other.map((x) => `${x.stage}: ${x.e}`).join(' | '));
} catch (e) {
  ok('X', ['C-01'], 'Excepción del arnés', false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser?.close().catch(() => undefined);
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  await db?.end().catch(() => undefined);
  if (exitCode === null) { child.stdin.write('stop\n'); await Promise.race([exited, sleep(60_000)]); }
  if (exitCode === null) child.kill();
  stackOut.end();
  const pass = results.filter((r) => r.pass).length;
  const crit = {};
  for (const r of results) for (const c of r.crit) { crit[c] ??= { pass: 0, fail: 0, cases: [] }; crit[c][r.pass ? 'pass' : 'fail']++; crit[c].cases.push(`${r.pass ? '✓' : '✗'} ${r.id}`); }
  fs.writeFileSync(SUMMARY, JSON.stringify({ part: PART, at: new Date().toISOString(), pass, total: results.length, criteria: crit, results }, null, 2));
  say(`\n${pass}/${results.length} PASS · log: ${path.relative(ROOT, LOG)} · resumen: ${path.relative(ROOT, SUMMARY)} · capturas: ${path.relative(ROOT, OUT)}`);
  await new Promise((r) => logStream.end(r));
  // Tras la parte 2: log y resumen únicos (parte 1 + parte 2) en e2e-routebase.log y e2e-routebase-summary.json.
  if (PART === '2' && fs.existsSync(path.join(DIR, 'e2e-routebase-part1-summary.json'))) {
    const p1 = JSON.parse(fs.readFileSync(path.join(DIR, 'e2e-routebase-part1-summary.json'), 'utf8'));
    const all = [...p1.results, ...results];
    const critAll = {};
    for (const r of all) for (const c of r.crit) { critAll[c] ??= { pass: 0, fail: 0, cases: [] }; critAll[c][r.pass ? 'pass' : 'fail']++; critAll[c].cases.push(`${r.pass ? '✓' : '✗'} ${r.id}`); }
    fs.writeFileSync(path.join(DIR, 'e2e-routebase-summary.json'), JSON.stringify({ part: '1+2', at: new Date().toISOString(), pass: all.filter((r) => r.pass).length, total: all.length, criteria: critAll, results: all }, null, 2));
    fs.writeFileSync(path.join(DIR, 'e2e-routebase.log'), fs.readFileSync(path.join(DIR, 'e2e-routebase-part1.log'), 'utf8') + '\n' + fs.readFileSync(LOG, 'utf8')
      + `\nTOTAL (parte 1 + parte 2): ${all.filter((r) => r.pass).length}/${all.length} PASS\n`);
  }
  process.exit(pass === results.length ? 0 : 1);
}
