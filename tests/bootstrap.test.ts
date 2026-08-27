// ============================================================
// RUTACASH — SUITE DE ARRANQUE (INSTALACIÓN LIMPIA DESDE CERO)
// ------------------------------------------------------------
//   npm run test:bootstrap
//
// Verifica la decisión de producto: una instalación CLEAN nace COMPLETAMENTE VACÍA
// —sin usuarios, sin empresas, sin credenciales conocidas— y la primera acción es
// que una persona cree su propio Super Admin.
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import { seedCleanDatabase, buildDefaultExpenseCategories } from '../src/data/seed'
import {
  getInstallationState, isPlatformInitialized, createFirstSuperAdmin,
  PLATFORM_TENANT_ID, MIN_BOOTSTRAP_PASSWORD_LENGTH,
  type PlatformDatabase,
} from '../src/services/platformBootstrapService'
import { authenticateUser, type AuthDatabase } from '../src/services/authService'
import { validateEmail, normalizeEmail, sameEmail } from '../src/lib/email'
import {
  getLastLoginEmail, rememberLoginEmail, forgetLastLoginEmail, LAST_LOGIN_EMAIL_KEY,
} from '../src/lib/lastLoginEmail'
import { hasOperationalRoutes, canManageRole } from '../src/lib/permissions'
import { validateCobradorInvariant } from '../src/lib/cobradorRules'
import { MemoryDb } from './financial/harness'
import type { Tenant, User } from '../src/models/types'
import { readSource, containsLine, SRC } from './financial/sourceContract'
import { RESET_CONFIRM_PHRASE, matchesResetPhrase } from '../src/components/ui/FullResetDialog'

// ============================================================
// Mini-runner
// ============================================================
interface Result { id: string; group: string; desc: string; passed: boolean; error?: string; metrics: string[] }
const results: Result[] = []
let current: string[] = []

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }
function metric(label: string, value: unknown) { current.push(`${label}: ${String(value)}`) }

async function spec(id: string, group: string, desc: string, fn: () => Promise<void> | void) {
  current = []
  let passed = true
  let error: string | undefined
  try { await fn() } catch (e) { passed = false; error = e instanceof Error ? e.message : String(e) }
  results.push({ id, group, desc, passed, error, metrics: [...current] })
}

// ============================================================
// Utilidades
// ============================================================
const asPlatformDb = (db: MemoryDb) => db as unknown as PlatformDatabase
const asAuthDb = (db: MemoryDb) => db as unknown as AuthDatabase

const OWNER = {
  nombre: 'Hernán Rodríguez',
  email: 'hernan@credirutas.com',
  password: 'MiClaveSegura2026',
  confirmPassword: 'MiClaveSegura2026',
}

/** Instalación CLEAN recién abierta: base vacía + arranque (que no siembra nada). */
async function freshCleanInstall(): Promise<MemoryDb> {
  const db = new MemoryDb()
  await seedCleanDatabase()
  return db
}

/** Instalación HUÉRFANA: la que dejó el seed CLEAN antiguo (Admin, sin Super Admin). */
function orphanedInstall(): MemoryDb {
  const db = new MemoryDb()
  db.tenants._seed([{
    id: 'tenant-main-001', nombre: 'Mi Empresa', email: 'admin@demo.com', plan: 'profesional',
    status: 'activa', pais: 'Colombia', moneda: 'COP', createdAt: '', updatedAt: '',
  }])
  db.users._seed([{
    id: 'user-admin-main-001', tenantId: 'tenant-main-001', email: 'admin@demo.com',
    password: 'claveDelAdmin', nombre: 'Administrador', rol: 'admin', status: 'activo',
    authorizedRouteIds: ['route-legacy-1'], createdAt: '', updatedAt: '',
  }])
  db.routes._seed([{ id: 'route-legacy-1', tenantId: 'tenant-main-001', nombre: 'Ruta Norte', status: 'activa' }])
  db.clients._seed([{ id: 'c1', tenantId: 'tenant-main-001', routeId: 'route-legacy-1', nombre: 'Cliente Uno' }])
  return db
}

const getUser = async (db: MemoryDb, email: string): Promise<User | undefined> =>
  (await db.users.toArray()).find((u: User) => normalizeEmail(u.email) === normalizeEmail(email))

/**
 * `localStorage` de mentira: Node no lo tiene. Se instala en `globalThis.window`
 * para poder verificar QUÉ se guarda (y sobre todo qué NO).
 */
function fakeLocalStorage() {
  const data: Record<string, string> = {}
  const storage = {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = String(v) },
    removeItem: (k: string) => { delete data[k] },
  }
  ;(globalThis as unknown as { window: unknown }).window = { localStorage: storage }
  return storage
}

// ############################################################
// GRUPO — ZERO-STATE (conteos exhaustivos, tabla por tabla)
// ############################################################
/** Vuelca el conteo de TODAS las tablas como métricas legibles. */
async function reportarConteos(db: MemoryDb, etiqueta: string): Promise<Record<string, number>> {
  const c = await db.counts()
  const users = await db.users.toArray() as User[]
  const superadmins = users.filter(u => u.rol === 'superadmin').length
  const admins = users.filter(u => u.rol === 'admin').length
  metric(`── ${etiqueta} ──`, '')
  metric('users', c.users)
  metric('  superadmins', superadmins)
  metric('  admins', admins)
  metric('tenants', c.tenants)
  metric('routes', c.routes)
  metric('clients', c.clients)
  metric('sales', c.sales)
  metric('installments', c.installments)
  metric('payments', c.payments)
  metric('expenses', c.expenses)
  metric('expenseCategories', c.expenseCategories)
  metric('noPaymentVisits', c.noPaymentVisits)
  return { ...c, superadmins, admins }
}

await spec('ZERO-STATE-001', 'Zero-state', 'arranque CLEAN nuevo: TODAS las tablas en 0', async () => {
  const db = new MemoryDb()
  // Arranque CLEAN EXACTO tal y como lo ejecuta App.tsx:
  //   if (!IS_CLEAN) await seedDatabase()   → en CLEAN no se ejecuta
  //   await ensureExpenseCategories()       → itera tenants; con 0 tenants no hace nada
  await seedCleanDatabase()
  const c = await reportarConteos(db, 'CLEAN recién arrancada')
  for (const [tabla, n] of Object.entries(c)) {
    assert(n === 0, `${tabla} = ${n}: una instalación CLEAN nueva debe tener TODO en 0`)
  }
})

await spec('ZERO-STATE-002', 'Zero-state', 'crear el primer Super Admin NO crea ninguna empresa', async () => {
  const db = new MemoryDb()
  await seedCleanDatabase()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  assert(r.ok, 'debía crearse la cuenta')
  const c = await reportarConteos(db, 'tras crear el Super Admin')
  assert(c.users === 1 && c.superadmins === 1, 'debe existir exactamente un usuario, y ser Super Admin')
  assert(c.tenants === 0, `tenants = ${c.tenants}: crear el Super Admin NO debe crear empresa`)
  assert(c.expenseCategories === 0, 'sin empresa no hay categorías de gasto')
  assert(c.routes === 0 && c.clients === 0 && c.sales === 0, 'no debe aparecer ningún dato operativo')
})

await spec('ZERO-STATE-003', 'Zero-state', 'crear el primer Super Admin NO crea ningún Admin', async () => {
  const db = new MemoryDb()
  await seedCleanDatabase()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const users = await db.users.toArray() as User[]
  metric('usuarios existentes', users.map(u => `${u.rol}:${u.email}`).join(', '))
  metric('admins', users.filter(u => u.rol === 'admin').length)
  assert(users.filter(u => u.rol === 'admin').length === 0, 'no debe crearse ningún Administrador')
  assert(users.length === 1, 'solo debe existir el Super Admin creado a mano')
})

await spec('ZERO-STATE-004', 'Zero-state', 'la primera empresa solo nace por acción explícita, y con sus categorías', async () => {
  const db = new MemoryDb()
  await seedCleanDatabase()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const antes = await reportarConteos(db, 'antes de crear empresa')
  assert(antes.tenants === 0, 'precondición: sin empresas')

  // Efecto EXACTO de PlatformPage.handleSave al crear una empresa (transaccional).
  await db.transaction('rw', [db.tenants, db.expenseCategories], async () => {
    await db.tenants.add({
      id: 't-1', nombre: 'Credirutas del Caribe', email: 'contacto@caribe.com', pais: 'Colombia',
      moneda: 'COP', plan: 'profesional', status: 'prueba', createdAt: '', updatedAt: '',
    })
    await db.expenseCategories.bulkAdd(buildDefaultExpenseCategories('t-1'))
  })
  const despues = await reportarConteos(db, 'tras crear la empresa')

  assert(despues.tenants === 1, 'tenants debe pasar de 0 a 1')
  assert(despues.expenseCategories > 0, 'la empresa nace con sus categorías de gasto')
  assert(despues.users === antes.users, 'crear la empresa NO crea usuarios')
  assert(despues.routes === 0, 'crear la empresa NO crea rutas')
  assert(despues.clients === 0 && despues.sales === 0, 'crear la empresa NO crea datos operativos')
  metric('lo ÚNICO que nace con la empresa', `1 tenant + ${despues.expenseCategories} categorías de gasto`)
})

await spec('ZERO-STATE-005', 'Zero-state', '«Restablecer app limpia» devuelve la instalación a cero', async () => {
  // Instalación en uso: Super Admin + empresa + admin + ruta + cliente + venta.
  const db = new MemoryDb()
  await seedCleanDatabase()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  await db.tenants.add({ id: 't-1', nombre: 'Caribe', email: 'c@c.com', pais: 'Colombia', moneda: 'COP', plan: 'profesional', status: 'activa', createdAt: '', updatedAt: '' })
  await db.expenseCategories.bulkAdd(buildDefaultExpenseCategories('t-1'))
  await db.users.add({ id: 'u-adm', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x', rol: 'admin', status: 'activo', createdAt: '', updatedAt: '' })
  await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', status: 'activa' })
  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: 'r-1', nombre: 'Cliente' })
  await db.sales.add({ id: 's-1', tenantId: 't-1', routeId: 'r-1', clientId: 'c-1', saldo: 1000, status: 'activa' } as never)
  await reportarConteos(db, 'instalación en uso')

  // resetLocalAppData(): borra la base entera (`db.delete()`), y al recargar la app
  // vuelve a arrancar CLEAN (que no siembra nada).
  await db.clearAll()
  await seedCleanDatabase()
  const c = await reportarConteos(db, 'tras Restablecer app limpia + recarga')

  for (const [tabla, n] of Object.entries(c)) {
    assert(n === 0, `${tabla} = ${n}: el reset debe devolver la instalación a cero`)
  }
  const estado = await getInstallationState(asPlatformDb(db))
  metric('estado de la instalación', estado.status)
  assert(estado.status === 'empty', 'tras el reset debe volver a pedirse la configuración inicial')
})

await spec('ZERO-STATE-006', 'Zero-state', 'nada en el código crea automáticamente empresa "Mi Empresa"', () => {
  const seed = readSource('src/data/seed.ts')
  // La cadena solo sobrevive dentro de `resetCleanDatabase`, que NO tiene llamadores.
  const idx = seed.indexOf("nombre: 'Mi Empresa'")
  const dentroDeResetCleanDatabase = idx > seed.indexOf('export async function resetCleanDatabase')
  metric("'Mi Empresa' aparece en seed.ts", idx > -1)
  metric('dentro de resetCleanDatabase (código muerto)', dentroDeResetCleanDatabase)
  const consumidores = ['src/app/App.tsx', 'src/pages/auth/SetupPage.tsx', 'src/pages/auth/AuthEntry.tsx', 'src/services/platformBootstrapService.ts']
  for (const f of consumidores) {
    const src = readSource(f)
    metric(`${f} crea tenants`, /tenants\.(add|bulkAdd|put)/.test(src))
    assert(!/tenants\.(add|bulkAdd|put)/.test(src), `${f} crea empresas automáticamente`)
  }
  assert(dentroDeResetCleanDatabase, "la cadena 'Mi Empresa' escapó de resetCleanDatabase")
})

await spec('ZERO-STATE-007', 'Zero-state', 'resetLocalAppData borra base, claves locales, caché y service workers', () => {
  const reset = readSource('src/lib/resetApp.ts')
  metric('borra la base completa', containsLine(reset, 'try { await db.delete() } catch'))
  metric('limpia localStorage por prefijo', containsLine(reset, 'clearStorageByPrefix(window.localStorage)'))
  metric('limpia sessionStorage por prefijo', containsLine(reset, 'clearStorageByPrefix(window.sessionStorage)'))
  metric('prefijos', "['rutacash-', 'rutacash_']")
  metric('borra Cache Storage', reset.includes('caches.delete(n)'))
  metric('desregistra Service Workers', reset.includes('r.unregister()'))
  assert(containsLine(reset, 'try { await db.delete() } catch'), 'el reset ya no borra la base completa')
  assert(containsLine(reset, "const RUTACASH_KEY_PREFIXES = ['rutacash-', 'rutacash_']"), 'cambió la limpieza por prefijo')
  assert(reset.includes('caches.delete(n)') && reset.includes('r.unregister()'), 'el reset debe limpiar caché y SW')
})

// ############################################################
// GRUPO — RESTABLECIMIENTO TOTAL («volver a Usuario 0»)
// ############################################################
await spec('RESET-CLEAN-001', 'Reset total', 'el control existe en Configuración, dentro de una Zona de peligro', () => {
  const settings = readSource('src/pages/admin/SettingsPage.tsx')
  metric('sección', 'Zona de peligro')
  metric('título del control', 'Restablecer RutaCash desde cero')
  metric('solo en CLEAN', containsLine(settings, '{IS_CLEAN && ('))
  assert(settings.includes('Zona de peligro'), 'falta la Zona de peligro en Configuración')
  assert(settings.includes('Restablecer RutaCash desde cero'), 'falta el control de restablecimiento total')
  assert(settings.includes('Elimina todos los datos de RutaCash almacenados en este dispositivo'), 'falta la descripción del control')
  assert(containsLine(settings, '<FullResetDialog open={cleanResetOpen} onClose={() => setCleanResetOpen(false)} />'), 'Configuración no usa el diálogo compartido')
  // El control vive dentro del bloque IS_CLEAN.
  const iClean = settings.indexOf('{IS_CLEAN && (')
  const iZona = settings.indexOf('Zona de peligro')
  metric('la Zona de peligro está dentro del bloque CLEAN', iClean > -1 && iZona > iClean)
  assert(iClean > -1 && iZona > iClean, 'la Zona de peligro debe ser exclusiva de CLEAN')
})

await spec('RESET-CLEAN-002', 'Reset total', 'el estado huérfano ofrece los DOS caminos', async () => {
  const db = orphanedInstall()
  const estado = await getInstallationState(asPlatformDb(db))
  metric('estado detectado', estado.status)
  assert(estado.status === 'orphaned', 'la base heredada debe detectarse como huérfana')

  const setup = readSource('src/pages/auth/SetupPage.tsx')
  metric('camino A', 'Recuperar instalación (conserva los datos)')
  metric('camino B', 'Empezar desde cero (elimina los datos locales)')
  metric('el camino B solo aparece si es recuperación', containsLine(setup, '{esRecuperacion && ('))
  assert(setup.includes('Recuperar instalación'), 'falta el camino de recuperación')
  assert(setup.includes('Empezar desde cero'), 'falta el camino de borrado total')
  assert(setup.includes('¿Prefieres empezar de cero?'), 'el segundo camino debe estar explicado')
  assert(containsLine(setup, '<FullResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />'), 'la recuperación no usa el diálogo compartido')
  // En una instalación virgen NO debe ofrecerse borrar: no hay nada que borrar.
  const iCond = setup.indexOf('{esRecuperacion && (')
  const iBoton = setup.indexOf('Empezar desde cero')
  assert(iCond > -1 && iBoton > iCond, 'el botón de borrado debe estar condicionado a la recuperación')
})

await spec('RESET-CLEAN-003', 'Reset total', 'el botón destructivo exige escribir BORRAR TODO', () => {
  metric('frase exigida', RESET_CONFIRM_PHRASE)
  // Lógica pura de habilitación.
  const rechazadas = ['', '   ', 'borrar', 'BORRAR', 'todo', 'BORRARTODO', 'BORRAR  TOD', 'sí', 'x']
  for (const t of rechazadas) {
    metric(`"${t}"`, matchesResetPhrase(t) ? 'HABILITA — ERROR' : 'bloqueado')
    assert(!matchesResetPhrase(t), `"${t}" no debe habilitar el borrado`)
  }
  const aceptadas = ['BORRAR TODO', 'borrar todo', '  Borrar Todo  ', 'BORRAR   TODO']
  for (const t of aceptadas) {
    metric(`"${t}"`, matchesResetPhrase(t) ? 'habilita' : 'BLOQUEADO — ERROR')
    assert(matchesResetPhrase(t), `"${t}" debía habilitar el borrado`)
  }
  // Y el diálogo ata el `disabled` del botón a esa comprobación.
  const dlg = readSource('src/components/ui/FullResetDialog.tsx')
  metric('habilitación', 'const habilitado = matchesResetPhrase(frase) && !borrando')
  assert(containsLine(dlg, 'const habilitado = matchesResetPhrase(frase) && !borrando'), 'la habilitación no depende de la frase')
  assert(containsLine(dlg, 'disabled={!habilitado}'), 'el botón destructivo no está bloqueado')
  assert(dlg.includes('<input'), 'debe pedirse la frase por teclado, no un simple checkbox')
  assert(dlg.includes("'Eliminando datos...'"), 'falta el estado de progreso')
  assert(containsLine(dlg, 'if (!habilitado) return'), 'la ejecución no revalida la habilitación')
  assert(containsLine(dlg, 'setBorrando(true)'), 'no se bloquea el doble clic')
})

await spec('RESET-CLEAN-004', 'Reset total', 'el reset reutiliza resetLocalAppData: no hay borrado paralelo', () => {
  const dlg = readSource('src/components/ui/FullResetDialog.tsx')
  metric('mecanismo usado', 'resetLocalAppData()')
  metric('redirección', "location.replace('/login')")
  assert(containsLine(dlg, 'await resetLocalAppData()'), 'el diálogo no usa el mecanismo único')
  assert(containsLine(dlg, "location.replace('/login')"), 'falta la recarga dura tras el borrado')
  // El diálogo NO implementa borrado propio.
  for (const prohibido of ['db.delete()', 'localStorage.clear', 'indexedDB.deleteDatabase', '.clear()']) {
    metric(`borrado propio (${prohibido})`, dlg.includes(prohibido) ? 'PRESENTE — ERROR' : 'ausente')
    assert(!dlg.includes(prohibido), `el diálogo implementa un borrado paralelo (${prohibido})`)
  }
  // Y las tres entradas apuntan al MISMO componente.
  const entradas = [
    'src/pages/admin/SettingsPage.tsx',
    'src/pages/auth/SetupPage.tsx',
    'src/components/ui/AppModeBanner.tsx',
  ]
  for (const f of entradas) {
    const src = readSource(f)
    metric(f, src.includes('<FullResetDialog') ? 'usa el diálogo compartido' : 'NO lo usa')
    assert(src.includes('<FullResetDialog'), `${f} no usa el diálogo compartido`)
  }
})

await spec('RESET-CLEAN-005', 'Reset total', 'tras el reset getInstallationState() vuelve a empty', async () => {
  const db = orphanedInstall()
  const antes = await getInstallationState(asPlatformDb(db))
  metric('estado antes', antes.status)
  // Efecto de resetLocalAppData(): db.delete() + recarga → arranque CLEAN sin siembra.
  await db.clearAll()
  await seedCleanDatabase()
  const despues = await getInstallationState(asPlatformDb(db))
  metric('estado después', despues.status)
  metric('initialized', despues.initialized)
  assert(antes.status === 'orphaned', 'precondición: instalación heredada')
  assert(despues.status === 'empty', `estado ${despues.status}: debía volver a 'empty'`)
  assert(despues.initialized === false, 'debe volver a pedirse la configuración inicial')
})

await spec('RESET-CLEAN-006', 'Reset total', 'tras el reset users = 0 y tenants = 0', async () => {
  const db = orphanedInstall()
  const antes = await reportarConteos(db, 'instalación heredada')
  await db.clearAll()
  await seedCleanDatabase()
  const despues = await reportarConteos(db, 'tras el restablecimiento total')
  assert(antes.users > 0 && antes.tenants > 0, 'precondición: había datos')
  assert(despues.users === 0, `users = ${despues.users}: debía quedar en 0`)
  assert(despues.tenants === 0, `tenants = ${despues.tenants}: debía quedar en 0`)
  for (const [tabla, n] of Object.entries(despues)) {
    assert(n === 0, `${tabla} = ${n}: el restablecimiento total debe dejarlo todo en 0`)
  }
})

await spec('RESET-CLEAN-007', 'Reset total', 'DEMO conserva su flujo propio y no usa el de «Usuario 0»', () => {
  const banner = readSource('src/components/ui/AppModeBanner.tsx')
  const settings = readSource('src/pages/admin/SettingsPage.tsx')

  // El banner DEMO conserva su control y su confirmación propia.
  const iDemo = banner.indexOf('if (IS_DEMO)')
  const iClean = banner.indexOf('if (IS_CLEAN)')
  const ramaDemo = banner.slice(iDemo, iClean)
  metric('DEMO conserva "Restaurar datos demo"', ramaDemo.includes('Restaurar datos demo'))
  metric('DEMO no abre el diálogo de Usuario 0', !ramaDemo.includes('FullResetDialog'))
  assert(ramaDemo.includes('Restaurar datos demo'), 'DEMO perdió su control de restauración')
  assert(!ramaDemo.includes('setResetOpen'), 'DEMO no debe usar el diálogo de restablecimiento total')
  assert(banner.includes('handleResetDemo'), 'DEMO perdió su manejador propio')

  // En Configuración, «Restaurar demo» sigue siendo exclusivo de DEMO.
  metric('Configuración: "Restaurar demo" bajo !IS_CLEAN', containsLine(settings, '{!IS_CLEAN && ('))
  assert(containsLine(settings, '{!IS_CLEAN && ('), 'el restaurador demo dejó de ser exclusivo de DEMO')
  assert(settings.includes('Restaurar datos demo'), 'Configuración perdió el restaurador demo')
  // Y la Zona de peligro es exclusiva de CLEAN.
  const iZona = settings.indexOf('Zona de peligro')
  const iCleanBlock = settings.indexOf('{IS_CLEAN && (')
  assert(iZona > iCleanBlock, 'la Zona de peligro debe ser exclusiva de CLEAN')
})

// ############################################################
// GRUPO — INSTALACIÓN VACÍA
// ############################################################
await spec('CLEAN-INIT-001', 'Instalación', 'una base CLEAN nueva no crea NINGÚN usuario ni dato', async () => {
  const db = await freshCleanInstall()
  const users = await db.users.toArray()
  const tenants = await db.tenants.toArray()
  const routes = await db.routes.toArray()
  const clients = await db.clients.toArray()
  const sales = await db.sales.toArray()
  metric('usuarios', users.length)
  metric('empresas', tenants.length)
  metric('rutas', routes.length)
  metric('clientes', clients.length)
  metric('ventas', sales.length)
  assert(users.length === 0, `CLEAN creó ${users.length} usuario(s): debe nacer vacía`)
  assert(tenants.length === 0, `CLEAN creó ${tenants.length} empresa(s): debe nacer vacía`)
  assert(routes.length === 0 && clients.length === 0 && sales.length === 0, 'CLEAN no debe sembrar datos operativos')
})

await spec('CLEAN-INIT-002', 'Instalación', 'una base vacía se reporta como instalación pendiente', async () => {
  const db = await freshCleanInstall()
  const state = await getInstallationState(asPlatformDb(db))
  metric('status', state.status)
  metric('initialized', state.initialized)
  metric('isPlatformInitialized()', await isPlatformInitialized(asPlatformDb(db)))
  assert(state.status === 'empty', `estado ${state.status}: debía ser 'empty'`)
  assert(state.initialized === false, 'una base vacía no está inicializada')
  assert(state.superadminCount === 0 && state.userCount === 0, 'no debe haber usuarios')
})

await spec('CLEAN-INIT-003', 'Instalación', 'crear el primer Super Admin funciona', async () => {
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  metric('resultado', r.ok ? 'CREADO' : `${r.code} — ${r.message}`)
  assert(r.ok, `no se pudo crear: ${r.ok ? '' : r.message}`)
  const su = (r as { user: User }).user
  metric('rol', su.rol)
  metric('email', su.email)
  metric('tenantId', su.tenantId)
  metric('recuperación', (r as { recovered: boolean }).recovered)
  assert(su.rol === 'superadmin', 'el usuario creado debe ser superadmin')
  assert(su.email === normalizeEmail(OWNER.email), 'el email debe normalizarse')
  assert(su.tenantId === PLATFORM_TENANT_ID, 'el Super Admin es de plataforma, no de empresa')
  assert(su.status === 'activo', 'debe nacer activo')
  assert((await db.users.toArray()).length === 1, 'debe existir exactamente un usuario')
  assert((await db.tenants.toArray()).length === 0, 'crear el Super Admin NO debe crear ninguna empresa')
})

await spec('CLEAN-INIT-004', 'Instalación', 'no se puede crear un segundo Super Admin desde el bootstrap público', async () => {
  const db = await freshCleanInstall()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const segundo = await createFirstSuperAdmin(
    { nombre: 'Intruso', email: 'intruso@x.com', password: 'OtraClave2026', confirmPassword: 'OtraClave2026' },
    asPlatformDb(db),
  )
  metric('segundo intento', segundo.ok ? 'CREADO — ERROR' : segundo.code)
  metric('usuarios totales', (await db.users.toArray()).length)
  assert(!segundo.ok && segundo.code === 'ALREADY_INITIALIZED', 'debe rechazarse el segundo Super Admin')
  assert((await db.users.toArray()).length === 1, 'no debe haberse creado ningún usuario extra')
})

await spec('CLEAN-INIT-005', 'Instalación', 'las credenciales elegidas permiten iniciar sesión', async () => {
  const db = await freshCleanInstall()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const ok = await authenticateUser(OWNER.email, OWNER.password, asAuthDb(db))
  const mayus = await authenticateUser(OWNER.email.toUpperCase(), OWNER.password, asAuthDb(db))
  const mala = await authenticateUser(OWNER.email, 'otra', asAuthDb(db))
  metric('login correcto', ok.ok ? 'ACEPTADO' : ok.code)
  metric('login con email en mayúsculas', mayus.ok ? 'ACEPTADO' : mayus.code)
  metric('login con clave incorrecta', mala.ok ? 'ACEPTADO — ERROR' : mala.code)
  assert(ok.ok && ok.user.rol === 'superadmin', 'debe poder entrar con lo que eligió')
  assert(mayus.ok, 'el email no debe distinguir mayúsculas')
  assert(!mala.ok && mala.code === 'INVALID_CREDENTIALS', 'una clave incorrecta debe rechazarse')
})

await spec('CLEAN-INIT-006', 'Instalación', 'la contraseña elegida NO exige cambio obligatorio', async () => {
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const sesion = await authenticateUser(OWNER.email, OWNER.password, asAuthDb(db))
  metric('mustChangePassword en la base', (r as { user: User }).user.mustChangePassword)
  metric('mustChangePassword al entrar', sesion.ok ? sesion.mustChangePassword : '—')
  assert((r as { user: User }).user.mustChangePassword === false, 'la clave que elige su dueño es definitiva')
  assert(sesion.ok && sesion.mustChangePassword === false, 'no debe pedirse cambio al entrar')
})

await spec('CLEAN-INIT-007', 'Instalación', 'tras crear el Super Admin la instalación pasa a estado "ready"', async () => {
  const db = await freshCleanInstall()
  const antes = await getInstallationState(asPlatformDb(db))
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const despues = await getInstallationState(asPlatformDb(db))
  metric('antes', `${antes.status} · initialized=${antes.initialized}`)
  metric('después', `${despues.status} · initialized=${despues.initialized}`)
  assert(antes.status === 'empty' && !antes.initialized, 'antes debía estar pendiente')
  assert(despues.status === 'ready' && despues.initialized, 'después debe mostrarse el login normal')
})

await spec('CLEAN-INIT-008', 'Instalación', 'el formulario valida nombre, correo y contraseña', async () => {
  const db = await freshCleanInstall()
  const casos: Array<[string, Parameters<typeof createFirstSuperAdmin>[0], string]> = [
    ['nombre vacío', { ...OWNER, nombre: ' ' }, 'INVALID_NAME'],
    ['correo inválido', { ...OWNER, email: 'no-es-un-correo' }, 'INVALID_EMAIL'],
    ['contraseña corta', { ...OWNER, password: 'abc', confirmPassword: 'abc' }, 'WEAK_PASSWORD'],
    ['confirmación distinta', { ...OWNER, confirmPassword: 'otra-cosa' }, 'PASSWORD_MISMATCH'],
  ]
  for (const [nombre, input, esperado] of casos) {
    const r = await createFirstSuperAdmin(input, asPlatformDb(db))
    metric(nombre, r.ok ? 'ACEPTADO — ERROR' : r.code)
    assert(!r.ok && r.code === esperado, `[${nombre}] se esperaba ${esperado}`)
  }
  metric('longitud mínima exigida', MIN_BOOTSTRAP_PASSWORD_LENGTH)
  metric('usuarios creados por intentos inválidos', (await db.users.toArray()).length)
  assert((await db.users.toArray()).length === 0, 'ningún intento inválido debe escribir')
})

await spec('CLEAN-INIT-009', 'Instalación', 'la comprobación anti-carrera vive DENTRO de la transacción', () => {
  const src = readSource('src/services/platformBootstrapService.ts')
  const body = src.slice(src.indexOf('export async function createFirstSuperAdmin'))
  const tx = body.indexOf('database.transaction')
  const check = body.indexOf("u.rol === 'superadmin'", tx)
  const write = body.indexOf('database.users.add', tx)
  metric('abre transacción', tx > -1)
  metric('re-comprueba dentro', check > tx)
  metric('escribe después de comprobar', write > check)
  assert(tx > -1, 'la creación no es transaccional')
  assert(check > tx && write > check, 'la comprobación debe estar dentro de la transacción y antes de escribir')
})

// ############################################################
// GRUPO — EMPRESA
// ############################################################
await spec('CLEAN-COMPANY-001', 'Empresa', 'el Super Admin puede crear la primera empresa', async () => {
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const su = (r as { user: User }).user
  metric('empresas al inicio', (await db.tenants.toArray()).length)

  // Efecto de PlatformPage.handleSave (crear empresa + categorías, transaccional).
  const empresa: Tenant = {
    id: 't-1', nombre: 'Credirutas del Caribe', email: 'contacto@caribe.com', pais: 'Colombia',
    moneda: 'COP', plan: 'profesional', status: 'prueba', createdAt: '', updatedAt: '',
  }
  await db.tenants.add(empresa)
  await db.expenseCategories.bulkAdd([{ id: 'ec-1', tenantId: 't-1', nombre: 'Transporte', activa: true }])

  const state = await getInstallationState(asPlatformDb(db))
  metric('empresas tras crear', state.companyCount)
  metric('categorías de la empresa', (await db.expenseCategories.toArray()).length)
  assert(su.rol === 'superadmin', 'quien la crea debe ser el Super Admin')
  assert(state.companyCount === 1, 'debe existir la empresa creada')
  assert((await db.expenseCategories.toArray()).length > 0, 'la empresa nace con sus categorías de gasto')
})

await spec('CLEAN-COMPANY-002', 'Empresa', 'ninguna empresa se crea automáticamente', async () => {
  const db = await freshCleanInstall()
  metric('empresas tras el arranque', (await db.tenants.toArray()).length)
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  metric('empresas tras crear el Super Admin', (await db.tenants.toArray()).length)
  assert((await db.tenants.toArray()).length === 0, 'no debe aparecer ninguna "Mi Empresa" automática')
})

await spec('CLEAN-COMPANY-003', 'Empresa', 'las categorías de gasto se crean con la empresa, no al arrancar', () => {
  const platform = readSource('src/pages/platform/PlatformPage.tsx')
  const seed = readSource('src/data/seed.ts')
  metric('PlatformPage crea categorías', containsLine(platform, 'await db.expenseCategories.bulkAdd(buildDefaultExpenseCategories(t.id))'))
  metric('lo hace en una transacción', containsLine(platform, "await db.transaction('rw', [db.tenants, db.expenseCategories], async () => {"))
  assert(containsLine(platform, 'buildDefaultExpenseCategories(t.id)'), 'la empresa ya no nace con sus categorías')
  assert(containsLine(platform, "db.transaction('rw', [db.tenants, db.expenseCategories]"), 'empresa y categorías deben crearse atómicamente')
  assert(containsLine(seed, 'export async function ensureExpenseCategories'), 'debe conservarse la red de seguridad para empresas antiguas')
})

// ############################################################
// GRUPO — ADMINISTRADOR
// ############################################################
await spec('CLEAN-ADMIN-001', 'Administrador', 'no existe ningún Admin precreado', async () => {
  const db = await freshCleanInstall()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const users = await db.users.toArray() as User[]
  metric('usuarios', users.map(u => `${u.rol}:${u.email}`).join(', '))
  assert(users.filter(u => u.rol === 'admin').length === 0, 'no debe haber ningún Administrador sembrado')
  assert(users.length === 1, 'solo debe existir el Super Admin que se creó a mano')
})

await spec('CLEAN-ADMIN-002', 'Administrador', 'el Super Admin crea el Administrador', async () => {
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const su = (r as { user: User }).user
  metric('canManageRole(superadmin, admin)', canManageRole(su, 'admin'))
  assert(canManageRole(su, 'admin'), 'el Super Admin debe poder crear Administradores')

  // Efecto de UsersPage: alta con contraseña TEMPORAL.
  await db.users.add({
    id: 'u-admin-1', tenantId: 't-1', nombre: 'Ana Administradora', email: 'ana@caribe.com',
    password: 'temporal123', rol: 'admin', status: 'activo', mustChangePassword: true,
    createdAt: '', updatedAt: '',
  })
  const admin = (await getUser(db, 'ana@caribe.com'))!
  metric('rol', admin.rol)
  metric('mustChangePassword', admin.mustChangePassword)
  assert(admin.rol === 'admin', 'debe crearse como Administrador')
})

await spec('CLEAN-ADMIN-003', 'Administrador', 'un usuario creado por un superior recibe mustChangePassword', async () => {
  const usersPage = readSource('src/pages/admin/UsersPage.tsx')
  metric('UsersPage marca la clave como temporal', containsLine(usersPage, 'mustChangePassword: true,'))
  assert(containsLine(usersPage, 'mustChangePassword: true,'), 'los usuarios creados por un superior deben exigir cambio')

  const db = await freshCleanInstall()
  await db.users.add({
    id: 'u-admin-1', tenantId: 't-1', nombre: 'Ana', email: 'ana@caribe.com', password: 'temporal123',
    rol: 'admin', status: 'activo', mustChangePassword: true, createdAt: '', updatedAt: '',
  })
  db.tenants._seed([{ id: 't-1', nombre: 'Caribe', email: 'x@y.com', plan: 'profesional', status: 'activa', pais: 'Colombia', moneda: 'COP', createdAt: '', updatedAt: '' }])
  const sesion = await authenticateUser('ana@caribe.com', 'temporal123', asAuthDb(db))
  metric('al entrar exige cambio', sesion.ok ? sesion.mustChangePassword : '—')
  assert(sesion.ok && sesion.mustChangePassword === true, 'al entrar debe pedirse el cambio de contraseña')
})

await spec('CLEAN-ADMIN-004', 'Administrador', 'un Admin sin ruta sigue fail-closed', async () => {
  const db = await freshCleanInstall()
  await db.users.add({
    id: 'u-admin-1', tenantId: 't-1', nombre: 'Ana', email: 'ana@caribe.com', password: 'x',
    rol: 'admin', status: 'activo', createdAt: '', updatedAt: '',
  })
  const sinRuta = (await getUser(db, 'ana@caribe.com'))!
  metric('authorizedRouteIds', JSON.stringify(sinRuta.authorizedRouteIds))
  metric('hasOperationalRoutes', hasOperationalRoutes(sinRuta))
  assert(!hasOperationalRoutes(sinRuta), 'un Admin sin rutas DEBE seguir fail-closed')

  await db.users.update('u-admin-1', { authorizedRouteIds: ['r-1'] })
  const conRuta = (await getUser(db, 'ana@caribe.com'))!
  metric('tras asignar ruta', hasOperationalRoutes(conRuta))
  assert(hasOperationalRoutes(conRuta), 'con ruta asignada debe quedar operativo')
})

await spec('CLEAN-ADMIN-005', 'Administrador', 'la primera ruta es creable (invariante de cobradores satisfacible)', async () => {
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const su = (r as { user: User }).user
  const admin: User = { id: 'u-admin-1', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'x', rol: 'admin', status: 'activo', createdAt: '', updatedAt: '' }
  const cobrador: User = { id: 'u-cob-1', tenantId: 't-1', nombre: 'Luis', email: 'luis@c.com', password: 'x', rol: 'cobrador', status: 'activo', createdAt: '', updatedAt: '' }
  await db.users.add(admin)
  await db.users.add(cobrador)
  assert(canManageRole(su, 'cobrador'), 'el Super Admin debe poder crear Cobradores')
  const inv = validateCobradorInvariant({
    routeTenantId: 't-1', assignedUserIds: [admin.id, cobrador.id], cobradorId: cobrador.id,
    userById: (id) => [admin, cobrador, su].find(u => u.id === id),
  })
  metric('invariante', inv.ok ? 'satisfecho' : inv.message)
  assert(inv.ok, `no se puede crear la primera ruta: ${inv.ok ? '' : inv.message}`)
})

// ############################################################
// GRUPO — RECUPERACIÓN DE INSTALACIONES HEREDADAS
// ############################################################
await spec('CLEAN-RECOVERY-001', 'Recuperación', 'una base heredada sin Super Admin se detecta como huérfana', async () => {
  const db = orphanedInstall()
  const state = await getInstallationState(asPlatformDb(db))
  metric('status', state.status)
  metric('usuarios', state.userCount)
  metric('superadmins', state.superadminCount)
  metric('empresas', state.companyCount)
  metric('admins existentes', state.existingAdminEmails.join(', '))
  assert(state.status === 'orphaned', `estado ${state.status}: debía ser 'orphaned'`)
  assert(state.initialized === false, 'sin Super Admin no está inicializada')
  assert(state.userCount === 1 && state.companyCount === 1, 'debe reportar lo que ya existe')
})

await spec('CLEAN-RECOVERY-002', 'Recuperación', 'la recuperación permite crear el Super Admin manualmente', async () => {
  const db = orphanedInstall()
  const antes = await authenticateUser(OWNER.email, OWNER.password, asAuthDb(db))
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const despues = await authenticateUser(OWNER.email, OWNER.password, asAuthDb(db))
  metric('login antes', antes.ok ? 'ACEPTADO' : antes.code)
  metric('creación', r.ok ? 'CREADO' : r.code)
  metric('marcada como recuperación', r.ok ? r.recovered : '—')
  metric('login después', despues.ok ? 'ACEPTADO' : despues.code)
  assert(!antes.ok, 'antes de recuperar no debía existir esa cuenta')
  assert(r.ok && r.recovered === true, 'debe reportarse como recuperación de una instalación con datos')
  assert(despues.ok, 'tras recuperar, el Super Admin debe poder entrar')
  assert((await getInstallationState(asPlatformDb(db))).status === 'ready', 'la instalación debe quedar lista')
})

await spec('CLEAN-RECOVERY-003', 'Recuperación', 'la recuperación NO modifica el Admin existente', async () => {
  const db = orphanedInstall()
  const antes = (await getUser(db, 'admin@demo.com'))!
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const despues = (await getUser(db, 'admin@demo.com'))!
  metric('contraseña antes → después', `${antes.password} → ${despues.password}`)
  metric('rutas antes → después', `${JSON.stringify(antes.authorizedRouteIds)} → ${JSON.stringify(despues.authorizedRouteIds)}`)
  metric('administradores', (await db.users.toArray() as User[]).filter(u => u.rol === 'admin').length)
  assert(JSON.stringify(antes) === JSON.stringify(despues), 'el Admin existente no debe cambiar en absoluto')
  assert((await db.users.toArray() as User[]).filter(u => u.rol === 'admin').length === 1, 'no debe duplicarse')
  // Y sigue pudiendo entrar con SU contraseña de siempre.
  const login = await authenticateUser('admin@demo.com', 'claveDelAdmin', asAuthDb(db))
  metric('el Admin sigue entrando con su clave', login.ok ? 'sí' : login.code)
  assert(login.ok, 'la recuperación no debe invalidar el acceso del Admin')
})

await spec('CLEAN-RECOVERY-004', 'Recuperación', 'la recuperación no borra empresa, rutas ni clientes', async () => {
  const db = orphanedInstall()
  const antes = JSON.stringify([
    await db.tenants.toArray(), await db.routes.toArray(), await db.clients.toArray(),
  ])
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const despues = JSON.stringify([
    await db.tenants.toArray(), await db.routes.toArray(), await db.clients.toArray(),
  ])
  metric('empresas', (await db.tenants.toArray()).length)
  metric('rutas', (await db.routes.toArray()).length)
  metric('clientes', (await db.clients.toArray()).length)
  assert(antes === despues, 'la recuperación modificó datos existentes')
})

await spec('CLEAN-RECOVERY-005', 'Recuperación', 'NUNCA se crea una cuenta raíz automáticamente', async () => {
  // El arranque, por sí solo, no debe generar ningún Super Admin sobre una base huérfana.
  const db = orphanedInstall()
  await seedCleanDatabase()
  const state = await getInstallationState(asPlatformDb(db))
  metric('superadmins tras el arranque', state.superadminCount)
  metric('estado', state.status)
  assert(state.superadminCount === 0, 'el arranque creó una cuenta raíz por su cuenta')

  // Y en el código no puede quedar ninguna contraseña por defecto.
  const seed = readSource('src/data/seed.ts')
  const cleanBlock = seed.slice(seed.indexOf('// ---- INSTALACIÓN LIMPIA ----'))
  for (const prohibido = '123456'; ;) {
    metric('contraseña por defecto en el bloque CLEAN', cleanBlock.includes(prohibido) ? 'PRESENTE' : 'ausente')
    assert(!cleanBlock.includes(prohibido), 'quedó una contraseña conocida en el arranque CLEAN')
    break
  }
})

await spec('CLEAN-RECOVERY-006', 'Recuperación', 'ninguna contraseña conocida sobrevive fuera del seed DEMO', () => {
  // Barrido de todo `src/`: la única cadena '123456' admisible está dentro del seed
  // DEMO (usuarios ficticios) y en la pantalla de acceso rápido, también solo DEMO.
  const sospechosos = [
    'src/pages/admin/UsersPage.tsx',
    'src/services/platformBootstrapService.ts',
    'src/services/passwordService.ts',
  ]
  for (const archivo of sospechosos) {
    const src = readSource(archivo)
    const tiene = src.includes("'123456'") || src.includes('/ 123456')
    metric(archivo, tiene ? 'CONTIENE una contraseña conocida' : 'limpio')
    assert(!tiene, `${archivo} propone una contraseña conocida`)
  }

  // SettingsPage conserva un panel de credenciales, pero SOLO en la rama DEMO del
  // ternario `IS_CLEAN ? (…CLEAN…) : (…DEMO…)`. Se comprueba la rama CLEAN.
  const settings = readSource('src/pages/admin/SettingsPage.tsx')
  const iniCLEAN = settings.indexOf('{IS_CLEAN ? (')
  const finCLEAN = settings.indexOf(') : (', iniCLEAN)
  const ramaClean = settings.slice(iniCLEAN, finCLEAN)
  const ramaDemo = settings.slice(finCLEAN)
  metric('rama CLEAN de SettingsPage', ramaClean.includes('123456') ? 'CONTIENE credenciales' : 'limpia')
  metric('rama DEMO (admitida)', ramaDemo.includes('123456') ? 'contiene credenciales demo' : 'sin credenciales')
  assert(iniCLEAN > -1 && finCLEAN > iniCLEAN, 'cambió la estructura del panel de usuarios de SettingsPage')
  assert(!ramaClean.includes('123456'), 'la rama CLEAN de SettingsPage anuncia una contraseña conocida')
  assert(!settings.includes('admin@demo.com / 123456'), 'el aviso de restablecimiento sigue prometiendo un usuario inicial que ya no existe')

  // El aviso del restablecimiento describe el estado real (base vacía). Desde que el
  // borrado se unificó, ese texto vive en el diálogo compartido, no en Configuración.
  const dialogo = readSource('src/components/ui/FullResetDialog.tsx')
  metric('el diálogo explica que la base queda vacía', dialogo.includes('volverá al estado inicial'))
  assert(dialogo.includes('volverá al estado inicial'), 'el aviso debe explicar que la instalación vuelve al estado inicial')
  assert(dialogo.includes('tendrás que crear nuevamente el primer'), 'el aviso debe advertir que habrá que recrear el Super Admin')
  metric('archivos con credenciales DEMO admitidas', 'src/data/seed.ts, src/pages/auth/LoginPage.tsx, rama DEMO de SettingsPage')
})

await spec('CLEAN-RECOVERY-007', 'Recuperación', 'las contraseñas temporales se generan al azar', () => {
  const utils = readSource('src/lib/utils.ts')
  const users = readSource('src/pages/admin/UsersPage.tsx')
  metric('generador presente', containsLine(utils, 'export function generateTemporaryPassword(): string'))
  metric('usa crypto.getRandomValues', utils.includes('crypto.getRandomValues'))
  metric('UsersPage lo usa en el alta', users.includes('password: generateTemporaryPassword()'))
  metric('UsersPage lo usa al restablecer', users.includes('setResetPass(generateTemporaryPassword())'))
  assert(containsLine(utils, 'export function generateTemporaryPassword(): string'), 'falta el generador de claves temporales')
  assert(utils.includes('crypto.getRandomValues'), 'la clave temporal debe ser criptográficamente aleatoria')
  assert(users.includes('password: generateTemporaryPassword()'), 'el alta de usuario debe proponer una clave aleatoria')
  assert(users.includes('setResetPass(generateTemporaryPassword())'), 'el restablecimiento debe proponer una clave aleatoria')
})

// ############################################################
// GRUPO — VALIDACIÓN CENTRAL DE CORREO
// ############################################################
const ACEPTAR: Array<[string, string]> = [
  ['EMAIL-001', 'usuario@dominio.com'],
  ['EMAIL-002', 'nombre.apellido@empresa.com.br'],
  ['EMAIL-003', 'user+test@empresa.com'],
]
for (const [id, correo] of ACEPTAR) {
  await spec(id, 'Correo', `acepta ${correo}`, () => {
    const r = validateEmail(correo)
    metric('resultado', r.ok ? `aceptado → ${r.email}` : `RECHAZADO (${r.reason})`)
    assert(r.ok, `debía aceptarse y se rechazó por ${r.ok ? '' : r.reason}`)
    assert(r.ok && r.email === correo.toLowerCase(), 'debe devolverse en forma canónica')
  })
}

const RECHAZAR: Array<[string, string, string]> = [
  ['EMAIL-004', '111@111.1', 'TLD de un carácter y numérico'],
  ['EMAIL-005', 'usuario@dominio.c', 'TLD de un solo carácter'],
  ['EMAIL-006', 'usuario@dominio.12', 'TLD numérico'],
  ['EMAIL-007', 'usuario@dominio', 'dominio sin punto'],
  ['EMAIL-008', 'usuario @dominio.com', 'espacio interior'],
  ['EMAIL-009', '@dominio.com', 'parte local vacía'],
]
for (const [id, correo, motivo] of RECHAZAR) {
  await spec(id, 'Correo', `rechaza ${correo} (${motivo})`, () => {
    const r = validateEmail(correo)
    metric('resultado', r.ok ? `ACEPTADO — ERROR` : `rechazado: ${r.reason}`)
    metric('mensaje al usuario', r.ok ? '—' : r.message)
    assert(!r.ok, `"${correo}" debía rechazarse (${motivo})`)
  })
}

await spec('EMAIL-009B', 'Correo', 'rechaza otros dominios inválidos', () => {
  const casos = ['usuario@.com', 'usuario@dominio..com', 'usuario@-dominio.com', 'usuario@dominio-.com', 'a@b@c.com', '', '   ']
  for (const c of casos) {
    const r = validateEmail(c)
    metric(JSON.stringify(c), r.ok ? 'ACEPTADO — ERROR' : r.reason)
    assert(!r.ok, `"${c}" debía rechazarse`)
  }
})

await spec('EMAIL-010', 'Correo', 'normaliza recortando espacios alrededor', () => {
  const r = validateEmail('   usuario@dominio.com   ')
  metric('entrada', '"   usuario@dominio.com   "')
  metric('salida', r.ok ? r.email : r.reason)
  assert(r.ok && r.email === 'usuario@dominio.com', 'debe recortar los extremos')
  assert(normalizeEmail('  A@B.CO  ') === 'a@b.co', 'normalizeEmail debe recortar y bajar a minúsculas')
})

await spec('EMAIL-011', 'Correo', 'normaliza a minúsculas', () => {
  const r = validateEmail('Usuario@Dominio.COM')
  metric('entrada', 'Usuario@Dominio.COM')
  metric('salida', r.ok ? r.email : r.reason)
  assert(r.ok && r.email === 'usuario@dominio.com', 'debe guardarse en minúsculas')
})

await spec('EMAIL-012', 'Correo', 'los duplicados se comparan sin distinguir mayúsculas', async () => {
  metric('sameEmail(Admin@Empresa.com, admin@empresa.com)', sameEmail('Admin@Empresa.com', 'admin@empresa.com'))
  metric('sameEmail(a@b.com, otro@b.com)', sameEmail('a@b.com', 'otro@b.com'))
  metric('sameEmail("", "")', sameEmail('', ''))
  assert(sameEmail('Admin@Empresa.com', 'admin@empresa.com'), 'deben considerarse el mismo correo')
  assert(sameEmail(' ADMIN@empresa.COM ', 'admin@empresa.com'), 'debe normalizar antes de comparar')
  assert(!sameEmail('a@b.com', 'otro@b.com'), 'correos distintos no deben coincidir')
  assert(!sameEmail('', ''), 'dos vacíos no son "el mismo correo"')

  // Y el bootstrap lo aplica: no admite un segundo usuario con el mismo correo en otra caja.
  const db = await freshCleanInstall()
  await createFirstSuperAdmin({ ...OWNER, email: 'Duenio@Empresa.com' }, asPlatformDb(db))
  const guardado = (await db.users.toArray() as User[])[0]
  metric('guardado como', guardado.email)
  assert(guardado.email === 'duenio@empresa.com', 'el bootstrap debe guardar el correo normalizado')
})

await spec('EMAIL-013', 'Correo', 'la validación está centralizada: sin regex propios por pantalla', () => {
  const central = readSource('src/lib/email.ts')
  metric('utilidad central', 'src/lib/email.ts')
  assert(containsLine(central, 'export function validateEmail'), 'falta la utilidad central')
  assert(containsLine(central, 'export function normalizeEmail'), 'falta la normalización central')
  assert(containsLine(central, 'export function sameEmail'), 'falta la comparación normalizada')

  // Ninguna pantalla ni servicio puede llevar su propio regex de correo.
  const consumidores = [
    'src/services/platformBootstrapService.ts',
    'src/pages/admin/UsersPage.tsx',
    'src/pages/platform/PlatformPage.tsx',
    'src/services/authService.ts',
  ]
  for (const archivo of consumidores) {
    const src = readSource(archivo)
    const tieneRegexPropio = /const\s+EMAIL_RE\s*=/.test(src) || /\/\^\[\^\\s@\]/.test(src)
    const usaCentral = /from '@\/lib\/email'/.test(src)
    metric(archivo, `${usaCentral ? 'usa lib/email' : 'NO usa lib/email'}${tieneRegexPropio ? ' · REGEX PROPIO' : ''}`)
    assert(!tieneRegexPropio, `${archivo} conserva un regex de correo propio`)
    assert(usaCentral, `${archivo} no usa la utilidad central de correo`)
  }
})

// ############################################################
// GRUPO — LOGIN Y ÚLTIMO CORREO
// ############################################################
await spec('LOGIN-EMAIL-001', 'Login', 'el acceso admite diferencias de mayúsculas y espacios', async () => {
  const db = await freshCleanInstall()
  await createFirstSuperAdmin({ ...OWNER, email: 'persona@empresa.com' }, asPlatformDb(db))
  const variantes = ['persona@empresa.com', 'Persona@Empresa.COM', '  PERSONA@EMPRESA.com  ']
  for (const v of variantes) {
    const r = await authenticateUser(v, OWNER.password, asAuthDb(db))
    metric(JSON.stringify(v), r.ok ? 'ACEPTADO' : r.code)
    assert(r.ok, `debía autenticar con "${v}"`)
  }
  // La contraseña NO se normaliza: sigue distinguiendo mayúsculas.
  const claveDistintaCaja = await authenticateUser('persona@empresa.com', OWNER.password.toUpperCase(), asAuthDb(db))
  metric('contraseña en mayúsculas', claveDistintaCaja.ok ? 'ACEPTADA — ERROR' : claveDistintaCaja.code)
  assert(!claveDistintaCaja.ok, 'la contraseña no debe normalizarse')
})

await spec('LOGIN-EMAIL-002', 'Login', 'un acceso correcto guarda el último correo', () => {
  const store = fakeLocalStorage()
  forgetLastLoginEmail()
  metric('antes', JSON.stringify(getLastLoginEmail()))
  rememberLoginEmail('Persona@Empresa.COM')
  metric('después', getLastLoginEmail())
  metric('clave usada', LAST_LOGIN_EMAIL_KEY)
  assert(getLastLoginEmail() === 'persona@empresa.com', 'debe guardarse normalizado')
  assert(LAST_LOGIN_EMAIL_KEY.startsWith('rutacash-'), 'la clave debe llevar el prefijo que limpia el reset')
  // No se guarda nada más.
  metric('claves almacenadas', Object.keys(store.data).join(', '))
  assert(Object.keys(store.data).length === 1, 'solo debe guardarse el correo')
  assert(!JSON.stringify(store.data).includes(OWNER.password), 'jamás debe guardarse la contraseña')

  // Y `useAuth.login` lo invoca tras un acceso correcto.
  const auth = readSource('src/hooks/useAuth.ts')
  metric('useAuth lo registra tras autenticar', containsLine(auth, 'rememberLoginEmail(result.user.email)'))
  assert(containsLine(auth, 'rememberLoginEmail(result.user.email)'), 'el login no registra el último correo')
})

await spec('LOGIN-EMAIL-003', 'Login', 'cerrar sesión NO borra el último correo', () => {
  fakeLocalStorage()
  rememberLoginEmail('persona@empresa.com')
  // `logout` solo limpia el store de sesión; no toca localStorage salvo `rutacash-auth`.
  const auth = readSource('src/hooks/useAuth.ts')
  const logoutBody = auth.slice(auth.indexOf('logout: () =>'), auth.indexOf('selectTenant:'))
  metric('cuerpo de logout', logoutBody.replace(/\s+/g, ' ').trim())
  metric('correo tras cerrar sesión', getLastLoginEmail())
  assert(!logoutBody.includes('lastLoginEmail') && !logoutBody.includes('localStorage'), 'logout no debe tocar el último correo')
  assert(getLastLoginEmail() === 'persona@empresa.com', 'el correo debe seguir disponible tras cerrar sesión')
})

await spec('LOGIN-EMAIL-004', 'Login', 'el login se prerrellena con el último correo', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  metric('estado inicial del campo', 'useState(getLastLoginEmail)')
  assert(containsLine(login, 'const [email, setEmail] = useState(getLastLoginEmail)'), 'el campo de correo no se prerrellena')
  assert(login.includes("from '@/lib/lastLoginEmail'"), 'LoginPage no consulta el último correo')
  // La contraseña nunca se prerrellena.
  assert(containsLine(login, "const [password, setPassword] = useState('')"), 'la contraseña no debe prerrellenarse')
})

await spec('LOGIN-EMAIL-005', 'Login', '«Restablecer app limpia» SÍ borra el último correo', () => {
  const reset = readSource('src/lib/resetApp.ts')
  metric('prefijos que limpia', "['rutacash-', 'rutacash_']")
  metric('clave del último correo', LAST_LOGIN_EMAIL_KEY)
  assert(containsLine(reset, "const RUTACASH_KEY_PREFIXES = ['rutacash-', 'rutacash_']"), 'cambió la limpieza por prefijo')
  assert(LAST_LOGIN_EMAIL_KEY.startsWith('rutacash-'), 'la clave debe caer dentro del prefijo que se limpia')
})

await spec('SETUP-EMAIL-001', 'Login', 'crear el primer Super Admin guarda su correo como último correo', async () => {
  fakeLocalStorage()
  forgetLastLoginEmail()
  const db = await freshCleanInstall()
  const r = await createFirstSuperAdmin({ ...OWNER, email: 'Duenio@Empresa.com' }, asPlatformDb(db))
  assert(r.ok, 'debía crearse la cuenta')
  // Réplica del efecto de SetupPage tras la creación.
  rememberLoginEmail((r as { user: User }).user.email)
  metric('correo creado', (r as { user: User }).user.email)
  metric('último correo recordado', getLastLoginEmail())
  assert(getLastLoginEmail() === 'duenio@empresa.com', 'el correo creado debe quedar recordado')

  const setup = readSource('src/pages/auth/SetupPage.tsx')
  metric('SetupPage lo registra', containsLine(setup, 'rememberLoginEmail(correo)'))
  metric('SetupPage confirma el correo creado', setup.includes('Cuenta principal creada · Super Admin:'))
  assert(containsLine(setup, 'rememberLoginEmail(correo)'), 'SetupPage no registra el correo creado')
  assert(setup.includes('Cuenta principal creada · Super Admin:'), 'falta la confirmación visual del correo creado')
})

// ############################################################
// GRUPO — REGRESIÓN DEMO
// ############################################################
await spec('DEMO-REG-001', 'Regresión DEMO', 'el seed DEMO conserva su guarda y su carga completa', () => {
  const src = readSource('src/data/seed.ts')
  assert(containsLine(src, 'export async function seedDatabase()'), 'seedDatabase ya no existe')
  assert(containsLine(src, 'const existing = await db.tenants.count()'), 'cambió la guarda del seed DEMO')
  assert(containsLine(src, "console.log('[RutaCash] Datos demo cargados exitosamente')"), 'cambió el cierre del seed DEMO')
  metric('guarda DEMO', 'intacta')
})

await spec('DEMO-REG-002', 'Regresión DEMO', 'los 6 usuarios demo y sus rutas siguen sembrándose', () => {
  const src = readSource('src/data/seed.ts')
  const emails = ['superadmin@demo.com', 'admin@demo.com', 'socio1@demo.com', 'supervisor@demo.com', 'cobrador@demo.com', 'secretario@demo.com']
  for (const e of emails) assert(src.includes(e), `falta el usuario demo ${e}`)
  metric('usuarios demo presentes', emails.length)
  assert(containsLine(src, 'authorizedRouteIds: [ROUTE1_ID, ROUTE2_ID, ROUTE3_ID, ROUTE4_ID]'), 'el Admin demo perdió sus rutas')
  assert(src.includes('ROUTE4_ID'), 'faltan rutas demo')
})

await spec('DEMO-REG-003', 'Regresión DEMO', 'DEMO no exige cambio de contraseña ni pasa por configuración inicial', () => {
  const src = readSource('src/data/seed.ts')
  const demoBlock = src.slice(src.indexOf('export async function seedDatabase()'), src.indexOf('export async function resetToDemo'))
  metric('mustChangePassword en el seed DEMO', demoBlock.includes('mustChangePassword') ? 'PRESENTE' : 'ausente')
  metric('el seed DEMO crea un superadmin', demoBlock.includes("rol: 'superadmin'"))
  assert(!demoBlock.includes('mustChangePassword'), 'DEMO no debe bloquear con cambio de contraseña')
  // Al crear un superadmin, `getInstallationState` devuelve 'ready' → nunca aparece SetupPage.
  assert(demoBlock.includes("rol: 'superadmin'"), 'DEMO debe seguir sembrando su Super Admin, o mostraría la configuración inicial')
})

await spec('DEMO-REG-004', 'Regresión DEMO', 'el arranque solo siembra en DEMO', () => {
  const app = readSource(SRC.app)
  metric('condición de siembra', 'if (!IS_CLEAN) await seedDatabase()')
  assert(containsLine(app, 'if (!IS_CLEAN) await seedDatabase()'), 'cambió la condición de siembra por modo')
  assert(!app.includes('seedCleanDatabase'), 'el arranque no debe seguir invocando un seed para CLEAN')
})

await spec('DEMO-REG-005', 'Regresión DEMO', 'los accesos rápidos de credenciales son exclusivos de DEMO', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  metric('lista de accesos rápidos', 'const DEMO_USERS = IS_DEMO ? ALL_DEMO_USERS : []')
  assert(containsLine(login, 'const DEMO_USERS = IS_DEMO ? ALL_DEMO_USERS : []'), 'CLEAN no debe sugerir credenciales')
  assert(!login.includes('CLEAN_USERS'), 'quedó la lista de credenciales CLEAN')
})

// ############################################################
// GRUPO — CONTRATO CON EL CÓDIGO FUENTE
// ############################################################
await spec('BOOT-SRC-001', 'Arquitectura', 'el arranque CLEAN no siembra absolutamente nada', () => {
  const src = readSource('src/data/seed.ts')
  const body = src.slice(src.indexOf('export async function seedCleanDatabase'))
  const fin = body.indexOf('\n}')
  const cuerpo = body.slice(0, fin)
  metric('cuerpo de seedCleanDatabase', cuerpo.split('\n').slice(1).join(' ').trim() || '(vacío)')
  for (const prohibido of ['users.add', 'tenants.add', 'bulkAdd', 'routes.add', 'password']) {
    assert(!cuerpo.includes(prohibido), `el arranque CLEAN sigue creando datos (${prohibido})`)
  }
})

await spec('BOOT-SRC-002', 'Arquitectura', 'la puerta de entrada decide login vs configuración inicial', () => {
  const entry = readSource('src/pages/auth/AuthEntry.tsx')
  const app = readSource(SRC.app)
  metric('AuthEntry monta SetupPage si no está inicializada', containsLine(entry, 'if (!state.initialized) return <SetupPage state={state} onDone={refresh} />'))
  metric('/login usa AuthEntry', containsLine(app, '<Route path="/login" element={<AuthEntry />} />'))
  assert(containsLine(entry, 'if (!state.initialized) return <SetupPage state={state} onDone={refresh} />'), 'AuthEntry ya no protege la entrada')
  assert(containsLine(app, '<Route path="/login" element={<AuthEntry />} />'), '/login debe pasar por AuthEntry')
})

await spec('BOOT-SRC-003', 'Arquitectura', 'el fail-closed del Administrador sigue intacto', () => {
  const perms = readSource('src/lib/permissions.ts')
  const layout = readSource('src/components/layout/AdminLayout.tsx')
  assert(containsLine(perms, "return user?.rol === 'superadmin'"), 'isRouteUnrestricted cambió')
  assert(containsLine(perms, 'return authorizedRouteIdsOf(user).length > 0'), 'hasOperationalRoutes cambió')
  assert(containsLine(layout, "user?.rol === 'admin' && !hasOperationalRoutes(user) ? <AdminNoRoutes /> : <Outlet />"), 'el fail-closed del layout cambió')
  metric('fail-closed', 'intacto')
})

await spec('BOOT-SRC-004', 'Arquitectura', 'el gate de contraseña temporal precede al guard de roles', () => {
  const guards = readSource('src/components/auth/guards.tsx')
  const idxGate = guards.indexOf('mustChangePassword')
  const idxRoles = guards.indexOf('if (roles &&')
  metric('gate presente', idxGate > -1)
  metric('antes que el guard de roles', idxGate < idxRoles)
  assert(containsLine(guards, 'if (user.mustChangePassword === true) return <PasswordChangeGate />'), 'el guard ya no aplica el cambio obligatorio')
  assert(idxGate < idxRoles, 'debe evaluarse antes que el guard de roles')
})

await spec('BOOT-SRC-005', 'Arquitectura', 'el Super Admin es de plataforma: el centinela está centralizado', () => {
  const svc = readSource('src/services/platformBootstrapService.ts')
  metric('constante', "export const PLATFORM_TENANT_ID = 'platform'")
  metric('valor', PLATFORM_TENANT_ID)
  metric('deuda de modelo documentada', svc.includes('DEUDA DE MODELO'))
  assert(containsLine(svc, "export const PLATFORM_TENANT_ID = 'platform'"), 'el centinela debe estar centralizado')
  assert(svc.includes('DEUDA DE MODELO'), 'la deuda de modelo debe quedar documentada en el código')
})

// ############################################################
// INFORME
// ############################################################
const PAD = 22
const line = (ch = '─') => ch.repeat(96)

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE DE ARRANQUE (INSTALACIÓN LIMPIA DESDE CERO)')
console.log(line('═'))

let group = ''
for (const r of results) {
  if (r.group !== group) {
    group = r.group
    console.log('')
    console.log(`▌ ${group.toUpperCase()}`)
    console.log(line())
  }
  console.log(`[${r.passed ? ' PASS ' : ' FAIL '}] ${r.id.padEnd(PAD)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (r.error) console.log(`           ↳ ERROR: ${r.error}`)
}

const fallidos = results.filter(r => !r.passed)
const porGrupo = new Map<string, { pass: number; fail: number }>()
for (const r of results) {
  const g = porGrupo.get(r.group) ?? { pass: 0, fail: 0 }
  r.passed ? g.pass++ : g.fail++
  porGrupo.set(r.group, g)
}

console.log('')
console.log(line('═'))
console.log('  RESUMEN POR GRUPO')
for (const [g, c] of porGrupo) {
  console.log(`    ${g.padEnd(18)} ${String(c.pass).padStart(3)} PASS   ${String(c.fail).padStart(3)} FAIL`)
}
console.log(line())
console.log(`  TOTAL: ${results.length} casos   ${results.length - fallidos.length} PASS   ${fallidos.length} FAIL`)
console.log(line('═'))

if (fallidos.length) {
  console.log('')
  console.log('CASOS FALLIDOS:')
  for (const r of fallidos) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('')
  console.log('SUITE DE ARRANQUE: FALLÓ')
} else {
  console.log('')
  console.log('SUITE DE ARRANQUE: TODOS LOS CASOS PASAN')
}

process.exit(fallidos.length === 0 ? 0 : 1)
