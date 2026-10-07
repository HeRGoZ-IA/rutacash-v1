// ============================================================
// RUTACASH — SMOKE E2E BLACK-BOX CONTRA PRODUCCIÓN
// ------------------------------------------------------------
//   npm run smoke:prod
//   RUTACASH_SMOKE_URL=https://preview.example.app npm run smoke:prod
//
// Recorre la aplicación PUBLICADA como lo haría una persona: formularios,
// botones y navegación del DOM. No importa ningún módulo de `src/`, no llama
// servicios, no lee ni escribe IndexedDB: la propia RutaCash crea sus datos.
//
// AISLAMIENTO: cada ejecución usa un perfil de Chrome NUEVO en un directorio
// temporal (sin cookies, localStorage, IndexedDB, Service Workers ni caché
// previos) que se elimina al terminar, también ante error. Como RutaCash guarda
// todo en el navegador, los datos del smoke existen solo en ese perfil: no tocan
// a ningún usuario real.
//
// Escenarios (docs/PRODUCTION_SMOKE.md):
//   A segundo crédito del Cobrador   E cuadre exacto
//   B autoridad del Supervisor       F faltante que persiste
//   C Base física por trabajador     G conciliación Route ↔ trabajadores
//   D operación / Mi efectivo        H retiro vs efectivo bajo custodia
//   I capital por Administrador (v16): SuperAdmin → Administrador → Ruta
//
// v16 (2026-10-07): el SuperAdmin ya no coloca capital en la ruta ni el Supervisor
// entrega Base desde la caja. El capital fluye SuperAdmin → Andrés (Administrador
// responsable de capital de la ruta) → ruta, y la Base la entrega Andrés.
//
// Evidencia: tmp/prod-smoke/<run-id>/ (result.json + screenshots/), ignorado por git.
// Salida: exit 0 solo si todos los escenarios pasan y no hubo errores de página.
// ============================================================
import puppeteer from 'puppeteer-core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomBytes } from 'node:crypto'

const URL_BASE = (process.env.RUTACASH_SMOKE_URL ?? 'https://rutacash-clean.vercel.app').replace(/\/+$/, '')
const RUN_ID = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`
const OUT = path.resolve(process.env.RUTACASH_SMOKE_OUT ?? path.join('tmp', 'prod-smoke', RUN_ID))
const SHOTS = path.join(OUT, 'screenshots')
const TIMEOUT = Number(process.env.RUTACASH_SMOKE_TIMEOUT ?? 15000)
// Credenciales sintéticas, válidas solo dentro del perfil temporal. No se escriben en result.json.
const PASS = `Smk-${randomBytes(4).toString('hex')}!`
const OWNER_PASS = `SmkOwner-${randomBytes(4).toString('hex')}!`
const DOM = 'smoke.rutacash.test'
const mail = u => `${u}.${RUN_ID}@${DOM}`
const EMPRESA = `SMOKE PRODUCCION ${RUN_ID}`
const RUTA = 'Norte Smoke'
const JUAN = 'Juan Smoke'
const LAURA = 'Laura Smoke'
const ANDRES = 'Andres Smoke'
const CARLOS = 'Carlos Smoke'
const DIANA = 'Diana Smoke'

function chromePath() {
  const candidatos = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean)
  const encontrado = candidatos.find(p => fs.existsSync(p))
  if (!encontrado) throw new Error('No se encontró Chrome. Indica su ruta con CHROME_PATH.')
  return encontrado
}

// ------------------------------------------------------------
// Resultado estructurado: escenario → comprobaciones (esperado / observado)
// ------------------------------------------------------------
const escenarios = []
let actual = null
let pasoActual = ''
let capturas = 0
const log = (...a) => console.log('  ·', ...a)

class SmokeError extends Error {
  constructor(detalle) { super(detalle); this.name = 'SmokeError' }
}
function escenario(id, titulo) {
  actual = { id, titulo, ok: true, comprobaciones: [], evidencias: [] }
  escenarios.push(actual)
  console.log(`\n▌ ${id} · ${titulo}`)
}
function paso(nombre) { pasoActual = nombre }
function comprobar(que, esperado, observado, ok = Object.is(esperado, observado), destino = actual) {
  destino.comprobaciones.push({ que, esperado, observado, ok })
  if (!ok) destino.ok = false
  console.log(`    [${ok ? 'OK ' : 'NO '}] ${que}: esperado ${JSON.stringify(esperado)} · observado ${JSON.stringify(observado)}`)
  return ok
}

// ------------------------------------------------------------
// Navegador con perfil temporal
// ------------------------------------------------------------
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'rutacash-smoke-'))
fs.mkdirSync(SHOTS, { recursive: true })

console.log('════════════════════════════════════════════════════════════════')
console.log('  RUTACASH PRODUCTION BLACK-BOX SMOKE')
console.log(`  URL:     ${URL_BASE}`)
console.log('  PROFILE: TEMPORARY (se elimina al terminar)')
console.log('  DATA:    SYNTHETIC')
console.log(`  RUN:     ${RUN_ID}`)
console.log(`  OUT:     ${OUT}`)
console.log('════════════════════════════════════════════════════════════════')

const erroresPagina = []
let browser
let page

const sleep = ms => new Promise(r => setTimeout(r, ms))
const num = s => {
  if (s === null || s === undefined) return null
  const t = String(s).replace(/\u2212/g, '-')
  const n = Number(t.replace(/[^\d]/g, ''))
  return t.includes('-') ? -n : n
}
const falla = (esperado, observado, p = page) =>
  new SmokeError(`[${actual?.id ?? 'BOOTSTRAP'} · ${pasoActual}] esperado: ${esperado} · observado: ${observado} · url: ${p?.url?.()}`)

/** Espera una condición del DOM (polling de la página, sin sleeps fijos). */
async function hasta(fn, descripcion, { p = page, ms = TIMEOUT } = {}) {
  const fin = Date.now() + ms
  let ultimo
  while (Date.now() < fin) {
    try { ultimo = await fn(); if (ultimo) return ultimo } catch (e) { ultimo = e.message }
    await sleep(150)
  }
  throw falla(descripcion, `no ocurrió en ${ms} ms (último: ${JSON.stringify(ultimo)?.slice(0, 160)})`, p)
}
const texto = (p = page) => p.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '))
const esperarTexto = (t, opts = {}) => hasta(async () => (await texto(opts.p ?? page)).includes(t), `texto visible "${t}"`, opts)
const aparece = (t, opts = {}) => esperarTexto(t, { ms: 6000, ...opts }).then(() => true).catch(() => false)

/** Pulsa un botón visible y habilitado; dentro del modal abierto si lo hay. */
async function click(t, { exact = false, within = null, p = page } = {}) {
  await hasta(() => p.evaluate((t, exact, within) => {
    const modales = [...document.querySelectorAll('div.fixed.inset-0.z-50')]
    const base = modales.length ? modales[modales.length - 1] : document
    const root = within
      ? [...document.querySelectorAll('*')].reverse().find(e => e.children.length && [].concat(within).every(w => e.innerText?.includes(w)) && e.querySelector('button'))
      : base
    if (!root) return false
    const el = [...root.querySelectorAll('button')]
      .find(b => (exact ? b.textContent.trim() === t : b.textContent.includes(t)) && !b.disabled && b.offsetParent !== null)
    if (!el) return false
    el.scrollIntoView({ block: 'center' }); el.click(); return true
  }, t, exact, within), `botón "${t}" visible y habilitado`, { p })
}

/** Campo de formulario por su etiqueta visible (coincidencia exacta primero). */
async function campo(label, p = page) {
  return hasta(async () => {
    const h = await p.evaluateHandle(label => {
      const norm = x => x.textContent.replace(/\*/g, '').trim()
      const modales = [...document.querySelectorAll('div.fixed.inset-0.z-50')]
      const raiz = modales.length ? modales[modales.length - 1] : document
      const vis = [...raiz.querySelectorAll('label')].filter(x => x.offsetParent !== null)
      const exactas = vis.filter(x => norm(x) === label)
      for (const l of exactas.length ? exactas : vis.filter(x => norm(x).startsWith(label))) {
        if (l.htmlFor) { const e = document.getElementById(l.htmlFor); if (e) return e }
        let n = l.parentElement
        for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
          const e = n.querySelector('input:not([type=checkbox]),textarea,select')
          if (e) return e
        }
      }
      return null
    }, label)
    return h.asElement()
  }, `campo "${label}"`, { p })
}
async function escribirEn(el, valor, p = page) {
  await el.click({ clickCount: 3 })
  await p.keyboard.down('Control'); await p.keyboard.press('KeyA'); await p.keyboard.up('Control')
  await p.keyboard.press('Backspace')
  await el.type(String(valor))
}
const escribir = async (label, valor, p = page) => escribirEn(await campo(label, p), valor, p)
async function elegir(label, opcion, p = page) {
  const el = await campo(label, p)
  const value = await hasta(() => el.evaluate((s, t) => [...s.options].find(o => o.textContent.includes(t))?.value, opcion),
    `opción "${opcion}" en "${label}"`, { p })
  await el.select(value)
}
async function evidencia(nombre, p = page) {
  const f = `${String(++capturas).padStart(2, '0')}_${nombre}.png`
  await p.screenshot({ path: path.join(SHOTS, f), fullPage: true })
  actual?.evidencias.push(`screenshots/${f}`)
  return f
}
const ir = (ruta, p = page) => p.goto(`${URL_BASE}${ruta}`, { waitUntil: 'networkidle0' })

async function logout() {
  paso('cerrar sesión')
  if (page.url().includes('/admin')) await click('Cerrar sesión')
  else await hasta(() => page.evaluate(() => { const b = document.querySelector('[aria-label="Cerrar sesión"]'); b?.click(); return !!b }), 'botón "Cerrar sesión"')
  await page.waitForFunction(() => location.pathname.includes('/login'), { timeout: TIMEOUT })
}
async function login(email, nombreVisible) {
  paso(`login ${email}`)
  await ir('/login')
  const correo = await hasta(() => page.$('input[type=email]'), 'campo de correo')
  await escribirEn(correo, email)
  await escribirEn(await page.$('input[type=password]'), PASS)
  await click('Ingresar')
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: TIMEOUT })
  await esperarTexto(nombreVisible)
}
const desktop = () => page.setViewport({ width: 1366, height: 900 })
const movil = () => page.setViewport({ width: 412, height: 915 })

/** Filas "etiqueta → valor" que ve el usuario (tarjeta de conciliación y cuadre). */
async function tarjeta(p = page) {
  const f = await p.evaluate(() => {
    const out = {}
    for (const r of document.querySelectorAll('div.flex.items-center.justify-between')) {
      const sp = r.querySelectorAll(':scope > span')
      if (sp.length === 2) out[sp[0].innerText.trim()] = sp[1].innerText.replace(/\u00a0/g, ' ').trim()
    }
    return out
  })
  const v = pref => { const k = Object.keys(f).find(k => k.startsWith(pref)); return k === undefined ? null : num(f[k]) }
  const t = await texto(p)
  return {
    libro: v('Base de la ruta'), juan: v(`En manos de ${JUAN}`), laura: v(`En manos de ${LAURA}`) ?? 0,
    sinAsignar: v('Sin asignar (caja de la ruta)'), cartera: v('Cartera en calle'), cuadra: t.includes('Cuadra'),
    esperado: v('Esperado a entregar'), arrastre: v('Arrastre pendiente'), base: v('(+) Base recibida'),
    estructural: v('Capital + transferencias'), noPersonal: v('(+) Operación no atribuida'), baseNeta: v('(−) Base entregada neta'),
    entregado: v('(+) Entregado en cuadres'), sobrantes: v('(−) Sobrantes'), total: v('= Sin asignar'),
    faltanteJuan: v(`Faltante pendiente · ${JUAN}`),
  }
}
/** Marca visible: el logo ADEX (por su texto alternativo) dentro de la cabecera/sidebar. */
const marcaADEX = (p = page) => p.evaluate(() => !!document.querySelector('header img[alt="ADEX Soluciones"], aside img[alt="ADEX Soluciones"]'))
/** Sesión visible tras el login: marca, rol, actor, ruta activa y layout, cada uno por separado. */
async function sesion({ rol, actor, ruta, layout }) {
  const cab = await page.evaluate(() => (document.querySelector('header') ?? document.querySelector('aside'))?.innerText ?? '')
  const cuerpo = await texto()
  comprobar(`sesión ${actor}: marca ADEX visible`, true, await marcaADEX())
  comprobar(`sesión ${actor}: rol "${rol}" visible`, true, cuerpo.includes(rol))
  comprobar(`sesión ${actor}: actor visible`, true, cuerpo.includes(actor))
  if (ruta) comprobar(`sesión ${actor}: ruta activa en la cabecera`, true, cab.includes(ruta))
  comprobar(`sesión ${actor}: layout`, layout, new URL(page.url()).pathname.slice(0, layout.length))
}
const esperarTarjeta = (cond, desc, p = page) => hasta(async () => { const t = await tarjeta(p); return cond(t) ? t : false }, desc, { p })
async function disponibleRetiro(p) {
  const m = (await texto(p)).match(/Disponible para retiro \(caja no asignada\):\s*(-?\$?\s*[\d.]+)/)
  return m ? num(m[1]) : null
}

// ============================================================
// RECORRIDO
// ============================================================
let fatal = null
try {
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    userDataDir: PROFILE,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  })
  const vigilar = p => { p.on('pageerror', e => erroresPagina.push(`${p.url()}: ${e.message}`)); p.on('dialog', d => d.accept()) }
  page = (await browser.pages())[0] ?? await browser.newPage()
  vigilar(page)

  // ---------------- BOOTSTRAP (solo UI) ----------------
  escenario('BOOTSTRAP', 'Owner → empresa → Super Admin → ruta, usuarios, capital y clientes por UI')
  await desktop()
  paso('perfil limpio')
  await ir('/owner/login')
  await esperarTexto('Crear Owner')
  const almacen = await page.evaluate(async () => ({
    localStorage: localStorage.length, sessionStorage: sessionStorage.length,
    serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
    caches: (await globalThis.caches?.keys?.())?.length ?? 0,
  }))
  comprobar('perfil sin almacenamiento previo', '{"localStorage":0,"sessionStorage":0,"serviceWorkers":0,"caches":0}', JSON.stringify(almacen))
  comprobar('instalación vacía (pide crear Owner)', true, true)

  paso('crear Owner')
  await escribir('Nombre', 'Owner Smoke')
  await escribir('Correo electrónico', mail('owner'))
  await escribir('Contraseña', OWNER_PASS)
  await escribir('Confirmar contraseña', OWNER_PASS)
  await click('Crear Owner')
  await page.waitForFunction(() => location.pathname.startsWith('/owner') && !location.pathname.includes('login'), { timeout: TIMEOUT })

  paso('crear empresa y Super Admin')
  await ir('/owner/empresas')
  await click('Crear la primera empresa').catch(() => click('Nueva empresa'))
  await escribir('Nombre de la empresa', EMPRESA)
  await escribir('Correo de la empresa', mail('empresa'))
  await escribir('Nombre', 'Sonia Smoke')
  await escribir('Correo (usuario de acceso)', mail('sonia'))
  await escribir('Contraseña inicial', PASS)
  await click('Crear empresa')
  await esperarTexto('Credenciales del Super Admin')
  await click('Listo')

  await login(mail('sonia'), 'Sonia Smoke')
  paso('crear ruta')
  await ir('/admin/routes')
  await click('Crear ruta').catch(() => click('Nueva ruta'))
  await escribir('Nombre de la ruta', RUTA)
  await escribir('Ciudad', 'Smoke City')
  await click('Crear', { exact: true })
  await esperarTexto('Ruta creada')

  for (const [nombre, usuario, rol] of [[JUAN, 'juan', 'Cobrador'], [LAURA, 'laura', 'Supervisor'], [ANDRES, 'andres', 'Administrador']]) {
    paso(`crear usuario ${nombre} (${rol})`)
    await ir('/admin/users')
    await click('Nuevo usuario').catch(() => click('Crear usuario'))
    await escribir('Nombre completo', nombre)
    await escribir('Email', mail(usuario))
    await escribir('Contraseña inicial', PASS)
    await elegir('Rol', rol)
    await click(RUTA)
    await click('Crear', { exact: true })
    await esperarTexto('Usuario creado')
  }

  // v16: capital por Administrador. El SuperAdmin ingresa capital a la empresa y lo
  // asigna a Andrés (primer y único Administrador de la ruta → su responsable).
  paso('ingresar 5.000.000 a la empresa')
  await ir('/admin/capital')
  await click('Ingresar capital')
  await escribir('Valor', 5000000)
  await escribir('Descripción', 'Capital smoke')
  await click('Registrar', { exact: true })
  await esperarTexto('Movimiento de capital registrado')
  paso('asignar 5.000.000 a Andrés')
  await click('Asignar a Administrador')
  await elegir('Administrador', ANDRES)
  await escribir('Valor', 5000000)
  await click('Registrar', { exact: true })
  await esperarTexto('Movimiento de capital registrado')
  paso('el SuperAdmin ve la ruta con su responsable')
  await esperarTexto(`Responsable: ${ANDRES}`)
  await logout()

  // La Base de la ruta la pone su responsable desde su bolsa (antes de los créditos).
  paso('Andrés coloca 5.000.000 de su bolsa en la ruta')
  await login(mail('andres'), ANDRES)
  await ir('/admin/capital')
  await esperarTexto('Rutas cuyo capital controlo')
  await click('Colocar capital')
  await escribir('Valor', 5000000)
  await escribir('Descripción', 'Base estructural smoke')
  await click('Registrar', { exact: true })
  await esperarTexto('Capital colocado en la ruta')
  await logout()
  await login(mail('sonia'), 'Sonia Smoke')

  for (const [doc, nombre, credito] of [[`SMK-${RUN_ID}-1`, CARLOS, 1000000], [`SMK-${RUN_ID}-2`, DIANA, 0]]) {
    paso(`crear cliente ${nombre}${credito ? ' con Venta A' : ''}`)
    await ir('/admin/clients')
    await click('Nuevo cliente')
    await escribir('Número de documento', doc)
    await escribir('Nombre completo', nombre)
    await escribir('Teléfono principal', '3000000000')
    await escribir('Dirección de la casa', 'Calle Smoke 1')
    await escribir('Dirección del negocio', 'Carrera Smoke 2')
    await elegir('Ruta', RUTA)
    if (credito) {
      await page.evaluate(() => [...document.querySelectorAll('label')].find(l => l.textContent.includes('Crear crédito ahora'))?.querySelector('input')?.click())
      await escribir('Valor del préstamo', credito)
      await escribir('N° de parcelas', 20)
      await click('Crear cliente y crédito')
      await esperarTexto('Cliente y crédito creados')
    } else {
      await click('Crear cliente', { exact: true })
      await esperarTexto('Cliente creado')
    }
  }
  await evidencia('bootstrap_clientes')
  await logout()

  // ---------------- A · Segundo crédito del Cobrador ----------------
  escenario('A', 'Segundo crédito del Cobrador → solicitud, nunca venta directa')
  await movil()
  await login(mail('juan'), JUAN)
  paso('sesión Juan')
  await sesion({ rol: 'Cobrador', actor: JUAN, ruta: RUTA, layout: '/collector' })
  paso('nueva venta a Carlos (con Venta A activa)')
  await ir('/collector/new-sale')
  await elegir('Cliente', CARLOS)
  await esperarTexto('Este cliente ya tiene una venta activa.')
  comprobar('aviso de crédito activo', true, await aparece('El cliente ya tiene un crédito activo: esta venta se enviará como solicitud de autorización.'))
  comprobar('botón "Crear venta" (venta directa) ausente', false, (await texto()).includes('Crear venta'))
  await escribir('Valor de la venta', 200000)
  await evidencia('A_antes_nueva_venta')
  await click('Enviar solicitud de venta')
  await click('Sí, crear otra')
  comprobar('solicitud enviada', true, await aparece('Solicitud de venta enviada'))
  paso('reintento para Carlos')
  await ir('/collector/new-sale')
  await elegir('Cliente', CARLOS)
  await escribir('Valor de la venta', 150000)
  await click('Enviar solicitud de venta')
  await click('Sí, crear otra')
  comprobar('reintento rechazado (sin solicitud duplicada)', true, await aparece('Este cliente ya tiene una solicitud de venta pendiente'))
  await evidencia('A_despues_reintento')
  paso('solicitud normal para Diana (prepara D)')
  await ir('/collector/new-sale')
  await elegir('Cliente', DIANA)
  await escribir('Valor de la venta', 500000)
  await click('Enviar solicitud de venta')
  await esperarTexto('Solicitud de venta enviada')
  await logout()

  // ---------------- B · Supervisor ----------------
  escenario('B', 'Supervisor: ve y aprueba solicitudes, conserva el crédito directo')
  await login(mail('laura'), LAURA)
  paso('sesión Laura')
  await sesion({ rol: 'Supervisor', actor: LAURA, layout: '/supervisor' })
  paso('autorizaciones de la ruta')
  await ir('/supervisor/authorizations')
  await esperarTexto(CARLOS)
  const tAut = await texto()
  // Estas dos comprobaciones pertenecen a A: se ven desde el autorizador.
  const escA = escenarios.find(e => e.id === 'A')
  const nCarlos = (tAut.match(new RegExp(CARLOS, 'g')) ?? []).length
  comprobar('[A] solicitudes pendientes de Carlos (sin duplicado)', 1, nCarlos, nCarlos === 1, escA)
  const marcada = tAut.includes('Cliente con crédito activo')
  comprobar('[A] solicitud marcada "Cliente con crédito activo"', true, marcada, marcada, escA)
  await evidencia('B_autorizaciones')
  paso('aprobar solicitud de Diana')
  await click(DIANA)
  await click('Aprobar')
  comprobar('aprobación', true, await aparece('Solicitud aprobada'))
  paso('crédito directo a Carlos')
  await ir('/supervisor/new-sale')
  await elegir('Cliente', CARLOS)
  await escribir('Valor de la venta', 200000)
  comprobar('botón "Crear venta" (sale.createDirect) visible', true, (await texto()).includes('Crear venta'))
  await click('Crear venta')
  await click('Sí, crear otra')
  comprobar('crédito directo creado', true, await aparece('Venta creada y activa para recaudo'))
  await evidencia('B_credito_directo')

  // ---------------- C · Base física ----------------
  escenario('C', 'Base física: 1.500.000 a Juan sin duplicar el libro (la entrega el responsable de capital)')
  paso('el Supervisor ya no entrega Base desde la caja (v16)')
  await ir('/supervisor/worker-settlements')
  await esperarTexto('Efectivo de la ruta')
  await elegir('Trabajador', JUAN)
  await esperarTexto('Esperado a entregar')
  await esperarTexto(`Responsable de capital: ${ANDRES}`)
  comprobar('Supervisor: botón "Entregar Base" oculto', false, (await texto()).includes('Entregar Base'))
  comprobar('Supervisor: conserva "Recibir devolución"', true, (await texto()).includes('Recibir devolución'))
  await evidencia('C_supervisor_sin_entregar_base')
  await logout()
  await desktop()
  await login(mail('andres'), ANDRES)
  paso('conciliación antes (Andrés, Liquidación → Cuadre por trabajador)')
  await ir('/admin/weekly-settlement?vista=trabajadores')
  await elegir('Ruta', RUTA).catch(() => {})
  await esperarTexto('Efectivo de la ruta')
  const c0 = await esperarTarjeta(t => t.libro !== null && t.sinAsignar !== null, 'tarjeta de conciliación cargada')
  paso('entregar Base a Juan')
  await elegir('Trabajador', JUAN)
  await esperarTexto('Esperado a entregar')
  await click('Entregar Base')
  await escribir('Efectivo entregado', 1500000)
  await click('Registrar', { exact: true })
  const c1 = await esperarTarjeta(t => t.juan === 1500000 && t.base === 1500000, 'Juan con 1.500.000 en la tarjeta (sin F5)')
  await evidencia('C_base_entregada')
  comprobar('responsabilidad de Juan', 1500000, c1.juan)
  comprobar('libro sin cambios', c0.libro, c1.libro)
  comprobar('sin asignar baja 1.500.000', c0.sinAsignar - 1500000, c1.sinAsignar)
  comprobar('libro = sin asignar + personas', c1.libro, c1.sinAsignar + c1.juan + c1.laura)
  comprobar('conciliación', 'Cuadra', c1.cuadra ? 'Cuadra' : 'Revisar')
  await logout()
  await movil()

  // ---------------- D · Operación ----------------
  escenario('D', 'Operación de Juan: 1.500.000 − 500.000 + 300.000 − 100.000 = 1.200.000')
  await login(mail('juan'), JUAN)
  paso('confirmar desembolso a Diana (500.000)')
  await ir('/collector/disbursements')
  await esperarTexto(DIANA)
  await click('Confirmar desembolso')
  await esperarTexto('Desembolso confirmado')
  paso('abono de Carlos a la Venta A (300.000)')
  await ir('/collector/route')
  await esperarTexto(CARLOS)
  await click('Abonar', { within: [CARLOS, '1.200.000'] })
  await page.waitForFunction(() => location.pathname.includes('/payment/'), { timeout: TIMEOUT })
  await escribirEn(await hasta(() => page.$('input[inputmode=numeric]'), 'campo del abono'), 300000)
  await click('Registrar abono')
  await esperarTexto('Volver a la ruta')
  paso('gasto de Juan (100.000)')
  await ir('/collector/expenses')
  await hasta(() => page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.className.includes('rounded-full') && x.className.includes('bg-primary-600'))
    b?.click(); return !!b
  }), 'botón de nuevo gasto')
  await esperarTexto('Registrar gasto')
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.textContent.includes('Seleccionar categoría')))
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(s, s.options[1].value); s.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await (await page.$('input[placeholder=Valor]')).type('100000')
  await click('Guardar', { exact: true })
  await esperarTexto('Gasto registrado')
  paso('Mi efectivo')
  await ir('/collector/cashclose')
  await esperarTexto('Efectivo a entregar')
  const tD = await texto()
  const leer = re => { const m = tD.match(re); return m ? num(m[1]) : null }
  await evidencia('D_mi_efectivo')
  comprobar('Base recibida', 1500000, leer(/Base recibida\s*\+?\$?\s*([\d.]+)/))
  comprobar('Desembolsado por Juan', 500000, leer(/Desembolsado por ti\s*-?\$?\s*([\d.]+)/))
  comprobar('Recaudado por Juan', 300000, leer(/Recaudado por ti\s*\+?\$?\s*([\d.]+)/))
  comprobar('Gastos de Juan', 100000, leer(/Tus gastos\s*-?\$?\s*([\d.]+)/))
  comprobar('Efectivo a entregar', 1200000, leer(/Efectivo a entregar\s*\$?\s*([\d.]+)/))
  await logout()

  // ---------------- E · Cuadre exacto ----------------
  escenario('E', 'Cuadre exacto de 1.200.000 y ciclo siguiente en 0')
  await login(mail('laura'), LAURA)
  paso('vista previa del cuadre de Juan')
  await ir('/supervisor/worker-settlements')
  await elegir('Trabajador', JUAN)
  const e0 = await esperarTarjeta(t => t.esperado === 1200000, 'esperado 1.200.000')
  comprobar('esperado antes del cierre', 1200000, e0.esperado)
  paso('cerrar con 1.200.000')
  await escribir('Entregado', 1200000)
  comprobar('vista previa: CUADRE EXACTO', true, await aparece('CUADRE EXACTO'))
  await click('Cerrar cuadre')
  await click('Confirmar cierre')
  comprobar('cierre registrado como exacto', true, await aparece('cerrado: exacto'))
  paso('ciclo siguiente')
  await elegir('Trabajador', JUAN)
  const e1 = await esperarTarjeta(t => t.esperado === 0 && t.arrastre === 0, 'ciclo siguiente en 0 (sin F5)')
  await evidencia('E_ciclo_siguiente')
  comprobar('arrastre del ciclo siguiente', 0, e1.arrastre)
  comprobar('Base del ciclo siguiente', 0, e1.base)
  comprobar('esperado del ciclo siguiente', 0, e1.esperado)
  comprobar('Juan fuera de "En manos de"', null, e1.juan)
  await logout()

  // ---------------- F · Faltante ----------------
  // v16: la Base la entrega Andrés (responsable de capital); él también cuadra.
  escenario('F', 'Faltante: esperado 1.000.000, entregado 900.000 → 100.000 persiste')
  await desktop()
  await login(mail('andres'), ANDRES)
  await ir('/admin/weekly-settlement?vista=trabajadores')
  await elegir('Ruta', RUTA).catch(() => {})
  await esperarTexto('Efectivo de la ruta')
  await elegir('Trabajador', JUAN)
  await esperarTexto('Esperado a entregar')
  paso('entregar Base 1.000.000')
  await click('Entregar Base')
  await escribir('Efectivo entregado', 1000000)
  await click('Registrar', { exact: true })
  await esperarTarjeta(t => t.esperado === 1000000, 'esperado 1.000.000')
  paso('cerrar con 900.000')
  await escribir('Entregado', 900000)
  await (await hasta(() => page.$('textarea'), 'motivo de la diferencia')).type('faltaron cien mil en la entrega del smoke')
  await click('Cerrar cuadre')
  await click('Confirmar cierre')
  comprobar('cierre con faltante', true, await aparece('Cuadre cerrado con FALTANTE'))
  paso('ciclo siguiente')
  await elegir('Trabajador', JUAN)
  const f1 = await esperarTarjeta(t => t.arrastre === 100000, 'arrastre 100.000 (sin F5)')
  await evidencia('F_faltante_persiste')
  comprobar('arrastre al ciclo siguiente', 100000, f1.arrastre)
  comprobar('esperado del ciclo siguiente', 100000, f1.esperado)
  comprobar('conciliación: faltante pendiente de Juan', 100000, f1.faltanteJuan)
  comprobar('conciliación: Juan responde por el faltante', 100000, f1.juan)
  paso('Base para H (1.500.000 en custodia de Juan)')
  await click('Entregar Base')
  await escribir('Efectivo entregado', 1500000)
  await click('Registrar', { exact: true })
  await esperarTarjeta(t => t.esperado === 1600000, 'esperado 1.600.000')

  // ---------------- G · Conciliación ----------------
  escenario('G', 'Conciliación Route ↔ trabajadores: dos vías iguales, cartera aparte')
  paso('sesión Andrés')
  await sesion({ rol: 'Administrador', actor: ANDRES, layout: '/admin' })
  paso('Liquidación → Cuadre por trabajador')
  await ir('/admin/weekly-settlement')
  await click('Cuadre por trabajador')
  await elegir('Ruta', RUTA).catch(() => {})
  await esperarTexto('Efectivo de la ruta')
  await click('Cómo se explica lo no asignado')
  const g = await esperarTarjeta(t => t.total !== null, 'desglose de lo no asignado')
  await evidencia('G_conciliacion')
  comprobar('libro = sin asignar + Juan + Laura', g.libro, g.sinAsignar + (g.juan ?? 0) + g.laura)
  comprobar('vía (b): estructural + no personal − Base neta + entregado − sobrantes', g.sinAsignar,
    g.estructural + g.noPersonal - g.baseNeta + g.entregado - g.sobrantes)
  comprobar('estructural (capital 5.000.000)', 5000000, g.estructural)
  comprobar('faltante de Juan visible', 100000, g.faltanteJuan)
  comprobar('cartera informada aparte (> 0)', true, g.cartera > 0)
  comprobar('conciliación', 'Cuadra', g.cuadra ? 'Cuadra' : 'Revisar')

  // ---------------- H · Retiro vs custodia ----------------
  escenario('H', 'Retiro no toca el efectivo bajo custodia; la devolución lo libera')
  paso('segunda pestaña (misma sesión) en Retiros')
  const p2 = await browser.newPage()
  vigilar(p2)
  await p2.setViewport({ width: 1366, height: 900 })
  await ir('/admin/withdrawals', p2)
  await click('Nuevo retiro', { p: p2 })
  await elegir('Ruta', RUTA, p2)
  const disp0 = await hasta(() => disponibleRetiro(p2), 'disponible para retiro visible', { p: p2 })
  comprobar('disponible = libro − efectivo en personas', g.libro - (g.juan ?? 0) - g.laura, disp0)
  paso(`retirar el libro completo (${g.libro})`)
  await escribir('Valor', g.libro, p2)
  await click('Registrar', { exact: true, p: p2 })
  comprobar('retiro que toca la custodia', 'RECHAZADO',
    await aparece('El retiro supera los fondos disponibles de la ruta', { p: p2 }) ? 'RECHAZADO' : 'ACEPTADO')
  await evidencia('H_retiro_rechazado', p2)
  paso('devolución de 500.000 de Juan (pestaña 1)')
  await page.bringToFront()
  await elegir('Trabajador', JUAN)
  await esperarTexto('Esperado a entregar')
  await click('Recibir devolución')
  await escribir('Efectivo recibido', 500000)
  await click('Registrar', { exact: true })
  await esperarTexto('Devolución de Juan Smoke registrada')
  await evidencia('H_devolucion')
  paso('disponible en la pestaña 2 sin F5')
  await p2.bringToFront()
  const disp1 = await hasta(async () => { const d = await disponibleRetiro(p2); return d === disp0 + 500000 ? d : false },
    `disponible ${disp0 + 500000} sin recargar`, { p: p2 })
  comprobar('disponible tras la devolución (sin F5, otra pestaña)', disp0 + 500000, disp1)
  const permitido = disp0 + 200000
  paso(`retirar ${permitido}`)
  await escribir('Valor', permitido, p2)
  await click('Registrar', { exact: true, p: p2 })
  comprobar('retiro dentro del disponible', 'ACEPTADO', await aparece('Retiro registrado', { p: p2 }) ? 'ACEPTADO' : 'RECHAZADO')
  await evidencia('H_retiro_aceptado', p2)
  paso('conciliación tras el retiro (pestaña 1, sin F5)')
  await page.bringToFront()
  const gFin = await esperarTarjeta(t => t.libro === g.libro - permitido, `libro ${g.libro - permitido} tras el retiro`)
  await evidencia('H_conciliacion_final')
  comprobar('libro = sin asignar + personas tras el retiro', gFin.libro, gFin.sinAsignar + (gFin.juan ?? 0) + gFin.laura)
  comprobar('conciliación tras el retiro', 'Cuadra', gFin.cuadra ? 'Cuadra' : 'Revisar')

  // ---------------- I · Capital por Administrador ----------------
  escenario('I', 'Capital por Administrador: SuperAdmin → Andrés → ruta; el retiro vuelve a su bolsa')
  paso('Capital de Andrés')
  await ir('/admin/capital')
  await esperarTexto('Mi capital')
  const leerStat = id => page.evaluate(id => document.querySelector(`[data-testid="${id}"] p:last-child`)?.innerText ?? null, id).then(num)
  const iAsignado = await hasta(() => leerStat('my-assigned'), 'capital asignado de Andrés')
  const iDisponible = await leerStat('my-available')
  const iRutas = await leerStat('my-in-routes')
  await evidencia('I_capital_andres')
  comprobar('Andrés: asignado = disponible + en rutas', iAsignado, iDisponible + iRutas)
  comprobar('Andrés: el retiro volvió a su bolsa (disponible)', permitido, iDisponible)
  comprobar('Andrés: asignado = 5.000.000 (no se creó ni perdió capital)', 5000000, iAsignado)
  comprobar('Andrés controla la ruta', true, await aparece('Rutas cuyo capital controlo') && (await texto()).includes(RUTA))
  paso('Transferencias sin el acceso confuso')
  await ir('/admin/transfers')
  await esperarTexto('Nueva transferencia')
  comprobar('botón "Traspaso entre trabajadores" retirado de Transferencias', false,
    await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Traspaso entre trabajadores'))))
  await evidencia('I_transferencias')
  await logout()
  paso('SuperAdmin: Administradores primero')
  await login(mail('sonia'), 'Sonia Smoke')
  await ir('/admin/capital')
  await esperarTexto('Administradores')
  const fila = await hasta(() => page.evaluate(n => [...document.querySelectorAll('[data-testid^="admin-row-"]')].find(r => r.innerText.includes(n))?.innerText ?? null, ANDRES), 'fila de Andrés')
  const cifras = [...fila.matchAll(/\$\s*[\d.]+/g)].map(m => num(m[0]))
  await evidencia('I_capital_superadmin')
  comprobar('SuperAdmin ve a Andrés: asignado / en rutas / disponible', JSON.stringify([5000000, 5000000 - permitido, permitido]), JSON.stringify(cifras.slice(0, 3)))
  comprobar('SuperAdmin no coloca capital en rutas', false, (await texto()).includes('Inyectar capital'))
} catch (e) {
  fatal = e
  console.error(`\n  ✖ ${e instanceof SmokeError ? e.message : `[${actual?.id ?? 'BOOTSTRAP'} · ${pasoActual}] ${e.stack ?? e}`}`)
  if (actual) { actual.ok = false; actual.error = e.message }
  if (page) await evidencia('ERROR').catch(() => {})
} finally {
  if (browser) await browser.close().catch(() => {})
  fs.rmSync(PROFILE, { recursive: true, force: true })
}

// ============================================================
// Informe
// ============================================================
const ESPERADOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']
const resumen = ESPERADOS.map(id => {
  const e = escenarios.find(x => x.id === id)
  return { id, titulo: e?.titulo ?? '(no ejecutado)', ok: Boolean(e?.ok) && !e?.error }
})
const ok = !fatal && erroresPagina.length === 0 && resumen.every(r => r.ok) && escenarios.every(e => e.ok)
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({
  runId: RUN_ID, url: URL_BASE, fecha: new Date().toISOString(), ok,
  perfilTemporalEliminado: !fs.existsSync(PROFILE),
  resumen, escenarios, erroresPagina, fatal: fatal ? String(fatal.message ?? fatal) : null,
}, null, 2))

console.log('\n════════════════════════════════════════════════════════════════')
for (const r of resumen) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id} · ${r.titulo}`)
console.log(`  errores de página: ${erroresPagina.length ? erroresPagina.join(' | ') : 'ninguno'}`)
console.log(`  perfil temporal eliminado: ${!fs.existsSync(PROFILE)}`)
console.log(`  evidencia: ${OUT}`)
console.log(`  RESULTADO: ${ok ? 'SMOKE DE PRODUCCIÓN OK' : 'SMOKE DE PRODUCCIÓN FALLÓ'}`)
console.log('════════════════════════════════════════════════════════════════')
process.exit(ok ? 0 : 1)
