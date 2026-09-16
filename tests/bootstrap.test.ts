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
import {
  hasOperationalRoutes, canManageRole, canAccessRoute, can,
  filterAccessibleRoutes, filterByAccessibleRoute,
} from '../src/lib/permissions'
import {
  validateCobradorInvariant, cobradorRemovalBlock, routeCanOperateCollection,
  routeAssignmentWarnings, ROUTE_NO_COBRADOR_LABEL,
} from '../src/lib/cobradorRules'
import {
  resolveRouteAdminIds, createRouteWithAdmins, updateRouteWithAssignments,
  type RouteDatabase, type RouteAuditSink,
} from '../src/services/routeService'
import { getRouteAssignmentsByRole, hasAnyAssignment } from '../src/lib/routeAssignments'
import { routeAdmins, routeAdminsLabel } from '../src/lib/routeAdmins'
import {
  createOffice, updateOffice, setOfficeStatus, deleteOffice, moveRouteToOffice,
  assertRouteOperationalContext, isRouteOperational,
  getOfficeManagementSummary, assignRoutesToOffice,
  type OfficeDatabase, type OfficeSummaryDatabase,
} from '../src/services/officeService'
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

await spec('RESET-LOGIN-001', 'Reset total', 'el login CLEAN ofrece acceso al restablecimiento total', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  metric('texto de arranque', '¿Quieres empezar nuevamente?')
  metric('acción', 'Restablecer RutaCash desde cero')
  metric('advertencia', 'Elimina todos los datos de RutaCash de este dispositivo.')
  assert(login.includes('¿Quieres empezar nuevamente?'), 'falta la salida de emergencia en el login')
  assert(login.includes('Restablecer RutaCash desde cero'), 'falta la acción de restablecimiento en el login')
  assert(login.includes('Elimina todos los datos de RutaCash de este dispositivo.'), 'falta la advertencia de borrado')
  // Acción SECUNDARIA: no compite con «Ingresar» (separador, texto pequeño, sin botón primario).
  const iIngresar = login.indexOf("'Ingresar'")
  const iReset = login.indexOf('Restablecer RutaCash desde cero')
  metric('aparece después de «Ingresar»', iReset > iIngresar)
  metric('separada visualmente', login.includes('border-t border-gray-100'))
  assert(iReset > iIngresar, 'la acción debe ir después del botón principal')
  assert(login.includes('border-t border-gray-100'), 'debe estar separada del formulario')
})

await spec('RESET-LOGIN-002', 'Reset total', 'el login DEMO NO ofrece el restablecimiento total', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  // El bloque debe estar condicionado explícitamente a IS_CLEAN.
  const iCond = login.indexOf('{IS_CLEAN && (')
  const iReset = login.indexOf('¿Quieres empezar nuevamente?')
  metric('condicionado a IS_CLEAN', iCond > -1 && iReset > iCond)
  assert(iCond > -1, 'falta la condición IS_CLEAN')
  assert(iReset > iCond, 'la acción debe estar dentro del bloque IS_CLEAN')
  // Y el bloque se cierra antes de que empiece cualquier otra cosa.
  const cierre = login.indexOf(')}', iReset)
  metric('bloque CLEAN cerrado', cierre > iReset)
  assert(cierre > iReset, 'el bloque IS_CLEAN no está bien delimitado')
  // DEMO conserva su propio flujo intacto.
  metric('DEMO conserva accesos rápidos', containsLine(login, 'const DEMO_USERS = IS_DEMO ? ALL_DEMO_USERS : []'))
  assert(containsLine(login, 'const DEMO_USERS = IS_DEMO ? ALL_DEMO_USERS : []'), 'cambió el flujo DEMO del login')
})

await spec('RESET-LOGIN-003', 'Reset total', 'el login reutiliza FullResetDialog', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  metric('monta el diálogo compartido', containsLine(login, '<FullResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />'))
  metric('importa desde', "@/components/ui/FullResetDialog")
  assert(containsLine(login, '<FullResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />'), 'el login no usa el diálogo compartido')
  assert(login.includes("from '@/components/ui/FullResetDialog'"), 'falta el import del diálogo compartido')
  // Y el diálogo conserva todas sus garantías.
  const dlg = readSource('src/components/ui/FullResetDialog.tsx')
  for (const [q, cond] of [
    ['confirmación escrita BORRAR TODO', dlg.includes("RESET_CONFIRM_PHRASE = 'BORRAR TODO'")],
    ['botón disabled hasta coincidir', containsLine(dlg, 'disabled={!habilitado}')],
    ['usa resetLocalAppData', containsLine(dlg, 'await resetLocalAppData()')],
    ['protección de doble clic', containsLine(dlg, 'setBorrando(true)')],
    ['estado «Eliminando datos...»', dlg.includes("'Eliminando datos...'")],
    ['recarga en /login', containsLine(dlg, "location.replace('/login')")],
  ] as Array<[string, boolean]>) {
    metric(q, cond)
    assert(cond, `el diálogo perdió una garantía: ${q}`)
  }
})

await spec('RESET-LOGIN-004', 'Reset total', 'el login no implementa un segundo mecanismo de borrado', () => {
  const login = readSource('src/pages/auth/LoginPage.tsx')
  for (const prohibido of ['resetLocalAppData', 'db.delete()', 'indexedDB.deleteDatabase', 'localStorage.clear', 'location.replace']) {
    metric(`borrado propio (${prohibido})`, login.includes(prohibido) ? 'PRESENTE — ERROR' : 'ausente')
    assert(!login.includes(prohibido), `LoginPage implementa lógica de borrado propia (${prohibido})`)
  }
  // Las CUATRO entradas comparten exactamente el mismo componente.
  const entradas = [
    'src/pages/auth/LoginPage.tsx',
    'src/pages/auth/SetupPage.tsx',
    'src/pages/admin/SettingsPage.tsx',
    'src/components/ui/AppModeBanner.tsx',
  ]
  for (const f of entradas) {
    const src = readSource(f)
    metric(f, src.includes('<FullResetDialog') ? 'usa el diálogo compartido' : 'NO lo usa')
    assert(src.includes('<FullResetDialog'), `${f} no usa el diálogo compartido`)
  }
})

await spec('RESET-LOGIN-005', 'Reset total', 'desde estado ready, el reset devuelve la instalación a empty', async () => {
  // Escenario exacto del hueco: hay Super Admin (ready) pero nadie recuerda la clave.
  const db = new MemoryDb()
  await seedCleanDatabase()
  await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  await db.tenants.add({ id: 't-1', nombre: 'Caribe', email: 'c@c.com', pais: 'Colombia', moneda: 'COP', plan: 'profesional', status: 'activa', createdAt: '', updatedAt: '' })
  const antes = await getInstallationState(asPlatformDb(db))
  metric('estado antes', antes.status)
  metric('usuarios antes', antes.userCount)
  metric('empresas antes', antes.companyCount)
  assert(antes.status === 'ready', 'precondición: instalación con Super Admin')

  // Efecto de resetLocalAppData(): db.delete() + recarga → arranque CLEAN sin siembra.
  await db.clearAll()
  await seedCleanDatabase()
  const despues = await getInstallationState(asPlatformDb(db))
  const c = await reportarConteos(db, 'tras el reset desde el login')
  metric('estado después', despues.status)
  assert(despues.status === 'empty', `estado ${despues.status}: debía volver a 'empty'`)
  assert(despues.initialized === false, 'AuthEntry debe volver a mostrar «Configurar RutaCash»')
  for (const [tabla, n] of Object.entries(c)) {
    assert(n === 0, `${tabla} = ${n}: el reset debe dejarlo todo en 0`)
  }
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
// GRUPO — PRIMERA RUTA / PRIMER COBRADOR (deadlock del onboarding)
// ############################################################
/** Empresa recién creada por el Super Admin, con un Admin y SIN ninguna ruta. */
async function empresaSinRutas() {
  const db = new MemoryDb()
  await seedCleanDatabase()
  const r = await createFirstSuperAdmin(OWNER, asPlatformDb(db))
  const su = (r as { user: User }).user
  await db.tenants.add({ id: 't-1', nombre: 'Caribe', email: 'c@c.com', pais: 'Colombia', moneda: 'COP', plan: 'profesional', status: 'activa', createdAt: '', updatedAt: '' })
  const admin: User = {
    id: 'u-admin-1', tenantId: 't-1', nombre: 'Ana', email: 'ana@c.com', password: 'tmp',
    rol: 'admin', status: 'activo', mustChangePassword: true, createdAt: '', updatedAt: '',
  }
  await db.users.add(admin)
  return { db, su, admin }
}

/** Alta de usuario tal y como la hace UsersPage tras la corrección. */
const nuevoUsuario = (over: Partial<User>): User => ({
  id: 'u-x', tenantId: 't-1', nombre: 'X', email: 'x@c.com', password: 'tmp',
  rol: 'cobrador', status: 'activo', mustChangePassword: true, createdAt: '', updatedAt: '',
  ...over,
})

await spec('ONB-ROUTE-001', 'Primera ruta', 'una empresa sin rutas permite crear un Cobrador', async () => {
  const { db, su } = await empresaSinRutas()
  metric('rutas en la empresa', (await db.routes.toArray()).length)

  // La regla que bloqueaba vivía en UsersPage: ya no rechaza el alta sin rutas.
  const users = readSource('src/pages/admin/UsersPage.tsx')
  metric('bloqueo antiguo presente', users.includes('necesita al menos una ruta autorizada'))
  assert(!users.includes('necesita al menos una ruta autorizada'), 'el alta sigue exigiendo una ruta')
  assert(users.includes('Un usuario NO necesita ruta para existir'), 'falta la regla explícita de existencia sin ruta')

  assert(canManageRole(su, 'cobrador'), 'el Super Admin debe poder crear Cobradores')
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', nombre: 'Luis', email: 'luis@c.com' }))
  const cob = (await db.users.toArray() as User[]).find(u => u.id === 'u-cob-1')!
  metric('cobrador creado', `${cob.rol}:${cob.email}`)
  assert(!!cob && cob.rol === 'cobrador', 'el Cobrador debe poder existir sin rutas')
})

await spec('ONB-ROUTE-002', 'Primera ruta', 'el Cobrador recién creado queda sin ruta', async () => {
  const { db } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  const cob = (await db.users.toArray() as User[]).find(u => u.id === 'u-cob-1')!
  metric('routeId', String(cob.routeId))
  metric('authorizedRouteIds', JSON.stringify(cob.authorizedRouteIds))
  metric('rutas en la empresa', (await db.routes.toArray()).length)
  assert(cob.routeId === undefined, 'no debe inventarse un routeId')
  assert(cob.authorizedRouteIds === undefined || cob.authorizedRouteIds.length === 0, 'no debe inventarse una asignación')
})

await spec('ONB-ROUTE-003', 'Primera ruta', 'el Cobrador sin ruta NO tiene acceso operativo', async () => {
  const { db } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  const cob = (await db.users.toArray() as User[]).find(u => u.id === 'u-cob-1')!

  // Fail-closed con las funciones REALES de permisos.
  const rutasVisibles = filterAccessibleRoutes(cob, [{ id: 'r-otra', nombre: 'Ajena' } as never])
  const ventasVisibles = filterByAccessibleRoute(cob, [{ routeId: 'r-otra' } as never])
  metric('hasOperationalRoutes', hasOperationalRoutes(cob))
  metric('rutas visibles', rutasVisibles.length)
  metric('ventas visibles', ventasVisibles.length)
  metric('canAccessRoute(r-otra)', canAccessRoute(cob, 'r-otra'))
  metric('can(payment.register)', can(cob, 'payment.register', { routeId: 'r-otra' }))
  assert(!hasOperationalRoutes(cob), 'un Cobrador sin ruta NO debe tener acceso operativo')
  assert(rutasVisibles.length === 0 && ventasVisibles.length === 0, 'no debe ver ninguna ruta ni venta')
  assert(!canAccessRoute(cob, 'r-otra'), 'no debe acceder a rutas ajenas')
  assert(!can(cob, 'payment.register', { routeId: 'r-otra' }), 'no debe poder registrar pagos')
})

await spec('ONB-ROUTE-004', 'Primera ruta', 'la primera Ruta puede seleccionar un Cobrador sin ruta', async () => {
  const { db, su, admin } = await empresaSinRutas()
  const cobrador = nuevoUsuario({ id: 'u-cob-1', nombre: 'Luis', email: 'luis@c.com' })
  await db.users.add(cobrador)

  // RoutesPage lista TODOS los cobradores del tenant, sin filtrar por rutas.
  const routes = readSource('src/pages/admin/RoutesPage.tsx')
  metric('selector de cobradores', "us.filter(u => u.rol === 'cobrador')")
  assert(containsLine(routes, "setCobradores(us.filter(u => u.rol === 'cobrador'))"), 'el selector filtra cobradores por rutas')

  const candidatos = (await db.users.toArray() as User[]).filter(u => u.rol === 'cobrador' && u.status === 'activo')
  metric('cobradores seleccionables', candidatos.map(c => c.nombre).join(', '))
  assert(candidatos.length === 1, 'el cobrador sin ruta debe ser seleccionable')

  // Invariante REAL de creación de ruta: se satisface con ese cobrador sin ruta.
  const inv = validateCobradorInvariant({
    routeTenantId: 't-1', assignedUserIds: [admin.id, cobrador.id], cobradorId: cobrador.id,
    userById: (id) => [admin, cobrador, su].find(u => u.id === id),
  })
  metric('invariante de cobradores', inv.ok ? 'satisfecho' : inv.message)
  assert(inv.ok, `la primera ruta no es creable: ${inv.ok ? '' : inv.message}`)
})

await spec('ONB-ROUTE-005', 'Primera ruta', 'crear la primera Ruta asigna la Ruta al Cobrador', async () => {
  const { db, admin } = await empresaSinRutas()
  const cobrador = nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' })
  await db.users.add(cobrador)

  // Efecto de routeService.createRouteWithAdmins (transaccional).
  await db.transaction('rw', [db.routes, db.users], async () => {
    await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })
    await db.users.update(admin.id, { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
    await db.users.update('u-cob-1', { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
  })

  const cob = (await db.users.toArray() as User[]).find(u => u.id === 'u-cob-1')!
  const ruta = (await db.routes.toArray())[0]
  metric('authorizedRouteIds del cobrador', JSON.stringify(cob.authorizedRouteIds))
  metric('cobrador responsable de la ruta', ruta.cobradorId)
  metric('hasOperationalRoutes tras asignar', hasOperationalRoutes(cob))
  assert(cob.authorizedRouteIds?.includes('r-1') === true, 'la ruta debe quedar asignada al cobrador')
  assert(ruta.cobradorId === 'u-cob-1', 'el cobrador debe quedar como responsable')
  assert(hasOperationalRoutes(cob), 'con ruta asignada el cobrador ya opera')
})

await spec('ONB-ROUTE-006', 'Primera ruta', 'crear la primera Ruta asigna la Ruta al Admin', async () => {
  const { db, admin } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  assert(!hasOperationalRoutes(admin), 'precondición: el Admin arranca sin rutas')

  await db.transaction('rw', [db.routes, db.users], async () => {
    await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })
    await db.users.update(admin.id, { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
    await db.users.update('u-cob-1', { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
  })

  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('authorizedRouteIds del admin', JSON.stringify(adm.authorizedRouteIds))
  metric('fail-closed levantado', hasOperationalRoutes(adm))
  assert(adm.authorizedRouteIds?.includes('r-1') === true, 'la ruta debe quedar asignada al Admin responsable')
  assert(hasOperationalRoutes(adm), 'el Admin debe quedar operativo tras la asignación')
})

await spec('ONB-ROUTE-007', 'Primera ruta', 'una Ruta SÍ puede crearse sin Cobrador (regla revisada)', async () => {
  const { db, su, admin } = await empresaSinRutas()
  void db
  // REGLA REVISADA: sin cobradores asignados el borrador es VÁLIDO (la ruta queda
  // "pendiente de asignación"). Antes se rechazaba con el código 'no-cobrador'.
  const sinCobrador = validateCobradorInvariant({
    routeTenantId: 't-1', assignedUserIds: [admin.id], cobradorId: undefined,
    userById: (id) => [admin, su].find(u => u.id === id),
  })
  metric('sin cobrador asignado', sinCobrador.ok ? 'ACEPTADO (pendiente de asignación)' : sinCobrador.code)
  assert(sinCobrador.ok, 'una ruta sin cobrador ya NO debe rechazarse')

  // Y el servicio ya no lo exige.
  const routeService = readSource('src/services/routeService.ts')
  metric('routeService exige cobrador', routeService.includes('Debes seleccionar un Cobrador responsable para la ruta.'))
  assert(!routeService.includes('Debes seleccionar un Cobrador responsable para la ruta.'), 'el servicio sigue exigiendo cobrador')
  // La pantalla tampoco lo exige.
  const routesPage = readSource('src/pages/admin/RoutesPage.tsx')
  metric('RoutesPage exige cobrador', routesPage.includes("toast.error('Debes seleccionar un Cobrador responsable para la ruta.')"))
  assert(!routesPage.includes("toast.error('Debes seleccionar un Cobrador responsable para la ruta.')"), 'la pantalla sigue exigiendo cobrador')
  // REGLA REVISADA (revisión del socio): el Administrador ya NO es obligatorio.
  // Solo el Cobrador lo es. Las dos guardas antiguas deben haber desaparecido.
  metric('exige Administrador activo en la empresa', routeService.includes('primero debe existir al menos un Administrador activo'))
  metric('exige seleccionar Administrador responsable', routeService.includes('Debes seleccionar al menos un Administrador responsable'))
  assert(!routeService.includes('primero debe existir al menos un Administrador activo'), 'el servicio sigue exigiendo que exista un Administrador activo')
  assert(!routeService.includes('Debes seleccionar al menos un Administrador responsable'), 'el servicio sigue exigiendo seleccionar Administrador')
})

await spec('ONB-ROUTE-008', 'Primera ruta', 'no se crea ninguna ruta ficticia automáticamente', async () => {
  const { db } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  metric('rutas tras crear empresa, admin y cobrador', (await db.routes.toArray()).length)
  assert((await db.routes.toArray()).length === 0, 'no debe aparecer ninguna ruta automática')

  // Ni el alta de usuarios ni el arranque CLEAN crean rutas.
  for (const f of ['src/pages/admin/UsersPage.tsx', 'src/services/platformBootstrapService.ts', 'src/pages/auth/SetupPage.tsx']) {
    const src = readSource(f)
    const crea = /db\.routes\.(add|bulkAdd|put)/.test(src)
    metric(`${f} crea rutas`, crea)
    assert(!crea, `${f} crea rutas automáticamente`)
  }
  // En `seed.ts` la única siembra de rutas es la de DEMO; el arranque CLEAN no crea ninguna.
  const seed = readSource('src/data/seed.ts')
  const bloqueClean = seed.slice(
    seed.indexOf('export async function seedCleanDatabase'),
    seed.indexOf('export async function resetCleanDatabase'),
  )
  metric('seedDatabase (DEMO) siembra rutas', /db\.routes\.bulkAdd/.test(seed))
  metric('seedCleanDatabase siembra rutas', /db\.routes\./.test(bloqueClean))
  assert(!/db\.routes\./.test(bloqueClean), 'el arranque CLEAN siembra rutas')
})

await spec('ONB-ROUTE-009', 'Primera ruta', 'la asignación de la primera Ruta es transaccional', () => {
  const routeService = readSource('src/services/routeService.ts')
  const body = routeService.slice(routeService.indexOf('export async function createRouteWithAdmins'))
  // La base es INYECTABLE (`database`, con el `db` real por defecto), igual que en
  // paymentService: por eso se busca `database.*` y no `db.*`.
  const iTx = body.indexOf('database.transaction')
  const iRuta = body.indexOf('database.routes.add', iTx)
  const iAdmin = body.indexOf('await database.users.update(id,', iTx)
  const iCob = body.indexOf('await database.users.update(cobrador.id,', iTx)
  metric('abre transacción', iTx > -1)
  metric('crea la ruta dentro', iRuta > iTx)
  metric('asigna al Admin dentro', iAdmin > iTx)
  metric('asigna al Cobrador dentro (cuando lo hay)', iCob > iTx)
  metric('mecanismo reutilizado', 'createRouteWithAdmins (no se duplicó lógica de asignación)')
  assert(iTx > -1, 'la creación de ruta dejó de ser transaccional')
  assert(iRuta > iTx && iAdmin > iTx && iCob > iTx, 'ruta y asignaciones deben ir en la MISMA transacción')
  // UsersPage no reimplementa la asignación de la ruta responsable.
  const users = readSource('src/pages/admin/UsersPage.tsx')
  metric('UsersPage reutiliza setCobradorRoutes', users.includes('setCobradorRoutes('))
  assert(users.includes('setCobradorRoutes('), 'UsersPage debe reutilizar el mecanismo de asignación existente')
})

await spec('ONB-ROUTE-010', 'Primera ruta', 'Secretario, Supervisor y Socio tampoco requieren ruta para existir', () => {
  const users = readSource('src/pages/admin/UsersPage.tsx')
  metric('tabla', 'ROLE_NEEDS_ROUTES_TO_OPERATE (solo gobierna avisos de UI)')
  assert(users.includes('ROLE_NEEDS_ROUTES_TO_OPERATE'), 'falta la tabla renombrada')
  assert(!users.includes('ROLE_REQUIRES_ROUTES'), 'queda la tabla antigua, que bloqueaba el alta')
  // Ninguna rama de `handleSave` rechaza por falta de rutas.
  const save = users.slice(users.indexOf('async function handleSave()'), users.indexOf('async function handleDelete') > -1 ? users.indexOf('async function handleDelete') : undefined)
  metric('handleSave rechaza por falta de rutas', /authorizedRouteIds\.length === 0[\s\S]{0,120}return/.test(save))
  assert(!/authorizedRouteIds\.length === 0[\s\S]{0,120}toast\.error/.test(save), 'el alta sigue rechazando por falta de rutas')
  // Y la operación sigue dependiendo de la asignación.
  const sinRuta = { id: 'u', tenantId: 't-1', nombre: 'S', email: 's@c.com', password: 'x', rol: 'secretario', status: 'activo', createdAt: '', updatedAt: '' } as User
  metric('secretario sin ruta opera', hasOperationalRoutes(sinRuta))
  assert(!hasOperationalRoutes(sinRuta), 'un Secretario sin ruta no debe operar')
})

// ############################################################
// GRUPO — RQ-01: ADMINISTRADOR OPCIONAL AL CREAR RUTA
// ------------------------------------------------------------
// Regla nueva: una ruta puede nacer SIN Administrador. Sigue exigiéndose Cobrador.
// El Administrador que crea la ruta queda SIEMPRE dentro (evita auto-bloqueo).
// ############################################################

await spec('ONB-ROUTE-011', 'Primera ruta', 'una ruta con Cobrador y SIN Administrador es válida', async () => {
  const { db, su, admin } = await empresaSinRutas()
  void db; void admin
  const cobrador = nuevoUsuario({ id: 'u-cob-1', nombre: 'Luis', email: 'luis@c.com' })

  // El invariante de la ruta se satisface solo con el Cobrador: el Administrador
  // no participa en él.
  const inv = validateCobradorInvariant({
    routeTenantId: 't-1', assignedUserIds: [cobrador.id], cobradorId: cobrador.id,
    userById: (id) => [cobrador, su].find(u => u.id === id),
  })
  metric('invariante sin Administrador', inv.ok ? 'satisfecho' : inv.message)
  assert(inv.ok, `una ruta con cobrador y sin admin debe ser válida: ${inv.ok ? '' : inv.message}`)

  // El Super Admin no se autoasigna y la lista de administradores queda vacía.
  const efectivos = resolveRouteAdminIds([], su)
  metric('administradores responsables resultantes', efectivos.length === 0 ? '(ninguno)' : efectivos.join(', '))
  assert(efectivos.length === 0, 'el Super Admin no debe forzar ningún Administrador responsable')

  // Y la UI ya no bloquea la creación por falta de Administradores.
  const routes = readSource('src/pages/admin/RoutesPage.tsx')
  metric('botón Nueva ruta deshabilitado por falta de admin', routes.includes('disabled={!hasActiveAdmin}'))
  metric('rechazo por falta de Administrador en handleSave', routes.includes('Selecciona al menos un Administrador responsable.'))
  assert(!routes.includes('disabled={!hasActiveAdmin}'), 'el botón Nueva ruta sigue deshabilitado sin Administrador')
  assert(!routes.includes('Selecciona al menos un Administrador responsable.'), 'la pantalla sigue rechazando la creación sin Administrador')
})

await spec('ONB-ROUTE-012', 'Primera ruta', 'el Super Admin crea una ruta sin Administrador y el Cobrador queda operativo', async () => {
  const { db } = await empresaSinRutas()
  const cobrador = nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' })
  await db.users.add(cobrador)

  // Efecto de createRouteWithAdmins cuando adminIds queda vacío: solo se asigna
  // el cobrador responsable; ningún Administrador entra en la ruta.
  await db.transaction('rw', [db.routes, db.users], async () => {
    await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })
    await db.users.update('u-cob-1', { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
  })

  const users = await db.users.toArray() as User[]
  const cob = users.find(u => u.id === 'u-cob-1')!
  const adminsEnRuta = users.filter(u => u.rol === 'admin' && (u.authorizedRouteIds ?? []).includes('r-1'))
  const ruta = (await db.routes.toArray())[0]
  metric('rutas creadas', (await db.routes.toArray()).length)
  metric('administradores en la ruta', adminsEnRuta.length)
  metric('cobrador responsable', ruta.cobradorId)
  metric('cobrador operativo', hasOperationalRoutes(cob))
  assert(!!ruta, 'la ruta no se creó')
  assert(adminsEnRuta.length === 0, 'se asignó un Administrador que nadie pidió')
  assert(ruta.cobradorId === 'u-cob-1', 'la ruta quedó sin cobrador responsable')
  assert(hasOperationalRoutes(cob), 'el cobrador debe quedar operativo aunque la ruta no tenga Administrador')
})

await spec('ONB-ROUTE-013', 'Primera ruta', 'el Administrador que crea una ruta queda SIEMPRE autoasignado', async () => {
  const { db, su, admin } = await empresaSinRutas()
  void db
  // Aunque la pantalla enviara una lista vacía, el servicio autoincluye al actor.
  const efectivos = resolveRouteAdminIds([], admin)
  metric('adminIds enviados', '(vacío)')
  metric('adminIds efectivos', efectivos.join(', '))
  assert(efectivos.includes(admin.id), 'el Administrador creador NO quedó asignado: se auto-bloquearía')

  // No duplica si ya venía incluido.
  const yaIncluido = resolveRouteAdminIds([admin.id], admin)
  metric('sin duplicados', yaIncluido.length)
  assert(yaIncluido.length === 1 && yaIncluido[0] === admin.id, 'la autoasignación duplicó al Administrador')

  // Y tras crear la ruta, el fail-closed queda levantado para él.
  await db.transaction('rw', [db.routes, db.users], async () => {
    await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })
    await db.users.update(admin.id, { authorizedRouteIds: ['r-1'], routeId: 'r-1' })
  })
  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('fail-closed levantado tras crear', hasOperationalRoutes(adm))
  assert(hasOperationalRoutes(adm), 'el Administrador creador quedó sin acceso a su propia ruta')

  // El Super Admin no se autoasigna (no se limita por rutas).
  metric('Super Admin autoasignado', resolveRouteAdminIds([], su).length > 0)
  assert(resolveRouteAdminIds([], su).length === 0, 'el Super Admin no debe autoasignarse')

  // El servicio deja constancia auditable de la autoasignación.
  const routeService = readSource('src/services/routeService.ts')
  assert(routeService.includes('resolveRouteAdminIds(input.adminIds, actor)'), 'createRouteWithAdmins dejó de aplicar la regla de autoasignación')
})

await spec('ONB-ROUTE-014', 'Primera ruta', 'un Administrador puede asignarse a una ruta creada sin Administrador', async () => {
  const { db, admin } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  // Ruta creada por el Super Admin SIN Administrador.
  await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })
  await db.users.update('u-cob-1', { authorizedRouteIds: ['r-1'], routeId: 'r-1' })

  const antes = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('admin operativo antes de asignarle la ruta', hasOperationalRoutes(antes))
  assert(!hasOperationalRoutes(antes), 'precondición: el Admin aún no debe tener acceso')

  // ASIGNACIÓN POSTERIOR (editor de ruta / Gestión de usuarios): misma fuente única.
  await db.users.update(admin.id, { authorizedRouteIds: ['r-1'], routeId: 'r-1' })

  const despues = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('authorizedRouteIds tras la asignación', JSON.stringify(despues.authorizedRouteIds))
  metric('admin operativo después', hasOperationalRoutes(despues))
  metric('accede a la ruta', canAccessRoute(despues, 'r-1'))
  assert(hasOperationalRoutes(despues), 'la asignación posterior de Administrador debe habilitar su operación')
  assert(canAccessRoute(despues, 'r-1'), 'el Administrador asignado debe acceder a la ruta')
})

await spec('ONB-ROUTE-015', 'Primera ruta', 'un Administrador sin rutas sigue fail-closed tras la nueva regla', async () => {
  const { db, admin } = await empresaSinRutas()
  await db.users.add(nuevoUsuario({ id: 'u-cob-1', email: 'luis@c.com' }))
  // Ruta creada SIN Administrador: no debe conceder acceso a ningún Admin.
  await db.routes.add({ id: 'r-1', tenantId: 't-1', nombre: 'Ruta Norte', cobradorId: 'u-cob-1', status: 'activa' })

  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('hasOperationalRoutes', hasOperationalRoutes(adm))
  metric('canAccessRoute(r-1)', canAccessRoute(adm, 'r-1'))
  metric('rutas visibles', filterAccessibleRoutes(adm, [{ id: 'r-1' } as never]).length)
  metric('ventas visibles', filterByAccessibleRoute(adm, [{ routeId: 'r-1' } as never]).length)
  metric('can(client.view)', can(adm, 'client.view', { routeId: 'r-1' }))
  assert(!hasOperationalRoutes(adm), 'una ruta sin Administrador NO puede conceder acceso implícito')
  assert(!canAccessRoute(adm, 'r-1'), 'el fail-closed se rompió')
  assert(filterAccessibleRoutes(adm, [{ id: 'r-1' } as never]).length === 0, 'el Admin ve una ruta que no tiene asignada')
  assert(filterByAccessibleRoute(adm, [{ routeId: 'r-1' } as never]).length === 0, 'el Admin ve datos de una ruta ajena')
  assert(!can(adm, 'client.view', { routeId: 'r-1' }), 'el Admin sin rutas consulta clientes')

  // La pantalla informativa sigue montándose para el Admin sin rutas.
  const layout = readSource('src/components/layout/AdminLayout.tsx')
  metric('AdminNoRoutes sigue montado', layout.includes("user?.rol === 'admin' && !hasOperationalRoutes(user) ? <AdminNoRoutes />"))
  assert(layout.includes("user?.rol === 'admin' && !hasOperationalRoutes(user) ? <AdminNoRoutes />"), 'se perdió la pantalla de fail-closed del Administrador')
})

await spec('ONB-ROUTE-016', 'Primera ruta', 'el checklist de arranque no exige Administrador para dar la ruta por hecha', () => {
  const checklist = readSource('src/components/ui/SetupChecklist.tsx')
  metric('condición antigua (routeHasAdmin)', checklist.includes('routeHasAdmin'))
  metric('condición nueva (ruta con cobrador)', checklist.includes('hasOperationalRoute'))
  assert(!checklist.includes('routeHasAdmin'), 'el checklist sigue exigiendo Administrador en la ruta')
  assert(checklist.includes('hasOperationalRoute'), 'falta la condición basada en la ruta con Cobrador')
  assert(!checklist.includes('Crea una ruta y asígnale un Administrador'), 'el texto sigue exigiendo Administrador')
})

// ############################################################
// GRUPO — RUTA LIBRE: CREACIÓN SIN RESPONSABLES OBLIGATORIOS
// ------------------------------------------------------------
// REGLA DEFINITIVA (revisión del socio): la creación de una ruta NO depende de
// tener Administrador ni Cobrador. 0 Admin + 0 Cobrador = ruta VÁLIDA, en estado
// "creada, pendiente de asignación". Se muestran advertencias, nunca bloqueos.
// Lo que sigue exigiendo Cobrador es la OPERACIÓN DE COBRO, no la existencia.
//
// Estos casos ejercitan el SERVICIO REAL (`createRouteWithAdmins` /
// `updateRouteWithAssignments`) inyectando la base en memoria: no se simula el
// efecto, se ejecuta la misma función que usa producción.
// ############################################################
const asRouteDb = (db: MemoryDb) => db as unknown as RouteDatabase

/** Empresa con Super Admin, un Admin y un Cobrador, SIN ninguna ruta. */
async function empresaConEquipo() {
  const { db, su, admin } = await empresaSinRutas()
  const cobrador = nuevoUsuario({ id: 'u-cob-1', nombre: 'Luis', email: 'luis@c.com' })
  await db.users.add(cobrador)
  const audits: string[] = []
  const sink: RouteAuditSink = async (p) => { audits.push(`${p.action}:${p.descripcion}`) }
  return { db, su, admin, cobrador, audits, sink }
}

/** Datos BÁSICOS de una ruta: lo único que la creación debería exigir. */
const datosBasicos = (over: Record<string, unknown> = {}) => ({
  tenantId: 't-1', nombre: 'Ruta Norte', ciudad: 'Barranquilla',
  tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000,
  capitalInicial: 0, codigo: 'RT-001', adminIds: [] as string[],
  ...over,
})

await spec('ROUTE-FREE-001', 'Ruta libre', 'Super Admin crea una ruta SIN Administrador y SIN Cobrador', async () => {
  const { db, su, audits, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)

  const users = await db.users.toArray() as User[]
  const asignados = users.filter(u => (u.authorizedRouteIds ?? []).includes(ruta.id))
  metric('ruta creada', `${ruta.nombre} (${ruta.codigo})`)
  metric('cobradorId', String(ruta.cobradorId))
  metric('usuarios asignados', asignados.length)
  metric('auditoría', audits.join(' | '))
  assert((await db.routes.toArray()).length === 1, 'la ruta NO se creó sin responsables')
  assert(ruta.cobradorId === undefined, 'no debe inventarse un Cobrador responsable')
  assert(asignados.length === 0, 'no debe asignarse nadie que no se haya pedido')
  assert(ruta.status === 'activa', 'la ruta debe nacer activa, no "inválida"')
  assert(audits.some(a => a.includes('SIN Administrador ni Cobrador')), 'la auditoría no deja constancia del estado pendiente')
})

await spec('ROUTE-FREE-002', 'Ruta libre', 'Super Admin crea una ruta CON Administrador y SIN Cobrador', async () => {
  const { db, su, admin, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos({ adminIds: [admin.id] }), su, asRouteDb(db), sink)

  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('cobradorId', String(ruta.cobradorId))
  metric('admin asignado', JSON.stringify(adm.authorizedRouteIds))
  metric('admin operativo', hasOperationalRoutes(adm))
  assert(!!ruta && ruta.cobradorId === undefined, 'la ruta debe crearse sin Cobrador')
  assert((adm.authorizedRouteIds ?? []).includes(ruta.id), 'el Administrador indicado debe quedar asignado')
  assert(hasOperationalRoutes(adm), 'el Administrador asignado debe quedar operativo')
})

await spec('ROUTE-FREE-003', 'Ruta libre', 'Super Admin crea una ruta SIN Administrador y CON Cobrador', async () => {
  const { db, su, cobrador, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos({ cobradorId: cobrador.id }), su, asRouteDb(db), sink)

  const users = await db.users.toArray() as User[]
  const cob = users.find(u => u.id === cobrador.id)!
  const admins = users.filter(u => u.rol === 'admin' && (u.authorizedRouteIds ?? []).includes(ruta.id))
  metric('cobrador responsable', String(ruta.cobradorId))
  metric('cobrador asignado', JSON.stringify(cob.authorizedRouteIds))
  metric('administradores en la ruta', admins.length)
  assert(ruta.cobradorId === cobrador.id, 'el Cobrador elegido debe quedar como responsable')
  assert((cob.authorizedRouteIds ?? []).includes(ruta.id), 'el Cobrador debe quedar asignado a la ruta')
  assert(admins.length === 0, 'no debe asignarse ningún Administrador que nadie pidió')
})

await spec('ROUTE-FREE-004', 'Ruta libre', 'a una ruta sin responsables se le asigna el Cobrador DESPUÉS', async () => {
  const { db, su, cobrador, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  metric('operación de cobro al nacer', routeCanOperateCollection({ assignedCobradorIds: [], cobradorId: ruta.cobradorId }))

  await updateRouteWithAssignments({
    routeId: ruta.id, tenantId: 't-1', nombre: ruta.nombre, ciudad: ruta.ciudad,
    tasaInteres: ruta.tasaInteres, tasaLibre: ruta.tasaLibre, montoMaximoPrestamo: ruta.montoMaximoPrestamo,
    cobradorId: cobrador.id, assignedUserIds: [cobrador.id], assignableUserIds: [cobrador.id],
  }, su, asRouteDb(db), sink)

  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  const guardada = (await db.routes.toArray())[0]
  metric('cobrador responsable tras asignar', guardada.cobradorId)
  metric('cobrador asignado', JSON.stringify(cob.authorizedRouteIds))
  metric('operación de cobro tras asignar', routeCanOperateCollection({ assignedCobradorIds: [cob.id], cobradorId: guardada.cobradorId }))
  assert(guardada.cobradorId === cobrador.id, 'la asignación posterior de Cobrador no se persistió')
  assert((cob.authorizedRouteIds ?? []).includes(ruta.id), 'el Cobrador debe quedar asignado a la ruta')
  assert(hasOperationalRoutes(cob), 'el Cobrador asignado debe quedar operativo')
})

await spec('ROUTE-FREE-005', 'Ruta libre', 'a una ruta sin responsables se le asigna el Administrador DESPUÉS', async () => {
  const { db, su, admin, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  const antes = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  assert(!hasOperationalRoutes(antes), 'precondición: el Admin no debe tener acceso todavía')

  await updateRouteWithAssignments({
    routeId: ruta.id, tenantId: 't-1', nombre: ruta.nombre, ciudad: ruta.ciudad,
    tasaInteres: ruta.tasaInteres, tasaLibre: ruta.tasaLibre, montoMaximoPrestamo: ruta.montoMaximoPrestamo,
    cobradorId: undefined, assignedUserIds: [admin.id], assignableUserIds: [admin.id],
  }, su, asRouteDb(db), sink)

  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  const guardada = (await db.routes.toArray())[0]
  metric('admin asignado', JSON.stringify(adm.authorizedRouteIds))
  metric('sigue sin Cobrador', guardada.cobradorId === undefined)
  metric('accede a la ruta', canAccessRoute(adm, ruta.id))
  assert((adm.authorizedRouteIds ?? []).includes(ruta.id), 'la asignación posterior de Administrador no se persistió')
  assert(canAccessRoute(adm, ruta.id), 'el Administrador asignado debe acceder a la ruta')
  assert(guardada.cobradorId === undefined, 'asignar Administrador no debe inventar un Cobrador')
})

await spec('ROUTE-FREE-006', 'Ruta libre', 'la ruta sin Cobrador se identifica como "Sin Cobrador asignado"', async () => {
  const { db, su, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  const users = await db.users.toArray() as User[]
  const cobradoresDeLaRuta = users.filter(u => u.rol === 'cobrador' && (u.authorizedRouteIds ?? []).includes(ruta.id))
  const opera = routeCanOperateCollection({ assignedCobradorIds: cobradoresDeLaRuta.map(c => c.id), cobradorId: ruta.cobradorId })

  metric('etiqueta', ROUTE_NO_COBRADOR_LABEL)
  metric('opera cobros', opera)
  assert(!opera, 'una ruta sin cobradores no debe declararse operativa para cobro')

  // La etiqueta se muestra en la tarjeta de ruta y en el resumen de asignados.
  const routesPage = readSource('src/pages/admin/RoutesPage.tsx')
  const resumen = readSource('src/components/ui/RouteAssignedUsers.tsx')
  metric('tarjeta de ruta muestra la etiqueta', routesPage.includes('ROUTE_NO_COBRADOR_LABEL'))
  metric('resumen de asignados muestra la etiqueta', resumen.includes('ROUTE_NO_COBRADOR_LABEL'))
  assert(routesPage.includes('ROUTE_NO_COBRADOR_LABEL'), 'la tarjeta de ruta no identifica la ruta sin Cobrador')
  assert(resumen.includes('ROUTE_NO_COBRADOR_LABEL'), 'el resumen de asignados no identifica la ruta sin Cobrador')

  // Y las advertencias son informativas, con las dos causas cuando faltan ambas.
  const avisos = routeAssignmentWarnings({ hasAdmin: false, hasCobrador: false })
  metric('advertencias combinadas', avisos.length)
  assert(avisos.length === 2, 'deben mostrarse las dos advertencias cuando faltan ambos responsables')
  assert(avisos.some(a => a.includes('sin Administrador')) && avisos.some(a => a.includes('sin Cobrador')), 'falta alguna advertencia')
})

await spec('ROUTE-FREE-007', 'Ruta libre', 'la ruta sin responsables no rompe listado ni dashboard', async () => {
  const { db, su, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  const users = await db.users.toArray() as User[]
  const routes = await db.routes.toArray()

  // Listado: el resumen de asignados resuelve sin lanzar y reporta "nadie asignado".
  const asignaciones = getRouteAssignmentsByRole(users, ruta.id, 't-1')
  metric('hasAnyAssignment', hasAnyAssignment(asignaciones))
  metric('rutas visibles para el Super Admin', filterAccessibleRoutes(su, routes as never[]).length)
  assert(!hasAnyAssignment(asignaciones), 'una ruta sin responsables debe reportar cero asignados, no fallar')
  assert(filterAccessibleRoutes(su, routes as never[]).length === 1, 'la ruta debe listarse para el Super Admin')

  // Dashboard: la ruta sin cobrador es un AVISO, no un error que la invalide.
  const dashboard = readSource('src/pages/admin/DashboardPage.tsx')
  const desde = dashboard.indexOf('const rutasSinCobrador')
  const bloque = dashboard.slice(desde, desde + 500)
  metric('severidad del aviso', bloque.includes("severity: 'warning'") ? 'warning' : 'error')
  assert(bloque.includes("severity: 'warning'"), 'el dashboard sigue tratando la ruta sin Cobrador como error')

  // El checklist de arranque da el paso por hecho en cuanto existe la ruta.
  const checklist = readSource('src/components/ui/SetupChecklist.tsx')
  metric('checklist: paso hecho con la ruta creada', checklist.includes('done: routes.length > 0'))
  assert(checklist.includes('done: routes.length > 0'), 'el checklist sigue exigiendo Cobrador para dar la ruta por creada')
})

await spec('ROUTE-FREE-008', 'Ruta libre', 'un Administrador NO asignado sigue fail-closed sobre esa ruta', async () => {
  const { db, su, admin, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!

  metric('hasOperationalRoutes', hasOperationalRoutes(adm))
  metric('canAccessRoute', canAccessRoute(adm, ruta.id))
  metric('rutas visibles', filterAccessibleRoutes(adm, [{ id: ruta.id } as never]).length)
  metric('ventas visibles', filterByAccessibleRoute(adm, [{ routeId: ruta.id } as never]).length)
  metric('can(client.view)', can(adm, 'client.view', { routeId: ruta.id }))
  assert(!hasOperationalRoutes(adm), 'una ruta sin responsables NO puede conceder acceso implícito')
  assert(!canAccessRoute(adm, ruta.id), 'el fail-closed se rompió')
  assert(filterAccessibleRoutes(adm, [{ id: ruta.id } as never]).length === 0, 'el Admin ve una ruta que no tiene asignada')
  assert(filterByAccessibleRoute(adm, [{ routeId: ruta.id } as never]).length === 0, 'el Admin ve datos de una ruta ajena')
  assert(!can(adm, 'client.view', { routeId: ruta.id }), 'el Admin no asignado consulta clientes de la ruta')
})

await spec('ROUTE-FREE-009', 'Ruta libre', 'un Cobrador NO asignado no puede operar la ruta', async () => {
  const { db, su, cobrador, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)
  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!

  metric('hasOperationalRoutes', hasOperationalRoutes(cob))
  metric('canAccessRoute', canAccessRoute(cob, ruta.id))
  metric('can(payment.register)', can(cob, 'payment.register', { routeId: ruta.id }))
  metric('ventas visibles', filterByAccessibleRoute(cob, [{ routeId: ruta.id } as never]).length)
  assert(!hasOperationalRoutes(cob), 'un Cobrador sin asignación NO debe tener acceso operativo')
  assert(!canAccessRoute(cob, ruta.id), 'el Cobrador no asignado accede a la ruta')
  assert(!can(cob, 'payment.register', { routeId: ruta.id }), 'el Cobrador no asignado registra pagos')
  assert(filterByAccessibleRoute(cob, [{ routeId: ruta.id } as never]).length === 0, 'el Cobrador no asignado ve ventas de la ruta')
})

await spec('ROUTE-FREE-010', 'Ruta libre', 'el Super Admin SÍ puede gestionar la ruta sin responsables', async () => {
  const { db, su, cobrador, sink } = await empresaConEquipo()
  const ruta = await createRouteWithAdmins(datosBasicos(), su, asRouteDb(db), sink)

  metric('canAccessRoute', canAccessRoute(su, ruta.id))
  metric('can(route.edit)', can(su, 'route.edit', { routeId: ruta.id, tenantId: 't-1' }))
  assert(canAccessRoute(su, ruta.id), 'el Super Admin debe acceder a la ruta sin responsables')
  assert(can(su, 'route.edit', { routeId: ruta.id, tenantId: 't-1' }), 'el Super Admin debe poder editarla')

  // Y la edita de verdad: renombrarla no exige designar responsables.
  await updateRouteWithAssignments({
    routeId: ruta.id, tenantId: 't-1', nombre: 'Ruta Norte (renombrada)', ciudad: ruta.ciudad,
    tasaInteres: 25, tasaLibre: false, montoMaximoPrestamo: ruta.montoMaximoPrestamo,
    cobradorId: undefined, assignedUserIds: [], assignableUserIds: [cobrador.id],
  }, su, asRouteDb(db), sink)
  const guardada = (await db.routes.toArray())[0]
  metric('nombre tras editar', guardada.nombre)
  metric('tasa tras editar', guardada.tasaInteres)
  assert(guardada.nombre === 'Ruta Norte (renombrada)', 'no se pudo editar una ruta sin responsables')
  assert(guardada.tasaInteres === 25, 'no se guardaron los datos generales')
})

await spec('ROUTE-FREE-011', 'Ruta libre', 'un Administrador que crea una ruta NO queda auto-bloqueado', async () => {
  const { db, admin, sink } = await empresaConEquipo()
  // El Admin crea la ruta SIN seleccionar responsables (ni a sí mismo).
  const ruta = await createRouteWithAdmins(datosBasicos(), admin, asRouteDb(db), sink)

  const adm = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!
  metric('adminIds enviados', '(vacío)')
  metric('authorizedRouteIds tras crear', JSON.stringify(adm.authorizedRouteIds))
  metric('hasOperationalRoutes', hasOperationalRoutes(adm))
  metric('cobradorId de la ruta', String(ruta.cobradorId))
  assert((adm.authorizedRouteIds ?? []).includes(ruta.id), 'el Administrador creador quedó fuera de su propia ruta')
  assert(hasOperationalRoutes(adm), 'el Administrador creador quedó auto-bloqueado')
  assert(ruta.cobradorId === undefined, 'la autoasignación del Admin no debe arrastrar un Cobrador')

  // La autoasignación es una protección INTERNA del actor Admin, no una atadura del
  // formulario: la pantalla no exige seleccionar Administrador.
  const routesPage = readSource('src/pages/admin/RoutesPage.tsx')
  metric('formulario exige Administrador', routesPage.includes('Selecciona al menos un Administrador responsable.'))
  assert(!routesPage.includes('Selecciona al menos un Administrador responsable.'), 'el formulario sigue exigiendo Administrador')
})

await spec('ROUTE-FREE-012', 'Ruta libre', 'retirar al último Cobrador deja la ruta sin Cobrador, no la bloquea', () => {
  // Regla DEROGADA: 'last-cobrador'. Ahora el retiro se permite y la ruta queda
  // "pendiente de asignación"; solo se exige reemplazo cuando QUEDAN otros cobradores.
  const ultimo = cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['c1'], responsibleId: 'c1', userId: 'c1' })
  const responsableConOtros = cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['c1', 'c2'], responsibleId: 'c1', userId: 'c1' })
  metric('retirar al último cobrador', ultimo === null ? 'PERMITIDO' : ultimo)
  metric('retirar al responsable con otros', responsableConOtros)
  assert(ultimo === null, 'retirar al último Cobrador sigue bloqueado')
  assert(responsableConOtros === 'responsible-needs-replacement', 'con otros cobradores debe elegirse reemplazo')

  // Y el borrador de la pantalla limpia el responsable al retirarlo.
  const routesPage = readSource('src/pages/admin/RoutesPage.tsx')
  const limpia = routesPage.includes('if (removing && id === f.cobradorId) cobradorId =')
  metric('la pantalla limpia el responsable', limpia)
  assert(limpia, 'la pantalla no limpia el Cobrador responsable retirado')
})

// ############################################################
// GRUPO — OFICINAS: Empresa → Oficina → Ruta
// ------------------------------------------------------------
// La Oficina AGRUPA; la Ruta CONTROLA el acceso. Estos casos ejercitan el SERVICIO
// REAL (`officeService` + `routeService`) sobre la base en memoria: no simulan el
// efecto, ejecutan las mismas funciones que usa producción.
// ############################################################
const asOfficeDb = (db: MemoryDb) => db as unknown as OfficeDatabase

/** Empresa con Super Admin, un Admin y un Cobrador, sin Oficinas ni rutas. */
async function empresaParaOficinas() {
  const { db, su, admin } = await empresaSinRutas()
  const cobrador = nuevoUsuario({ id: 'u-cob-1', nombre: 'Luis', email: 'luis@c.com' })
  await db.users.add(cobrador)
  const audits: string[] = []
  const sink: RouteAuditSink = async (p) => { audits.push(`${p.action}:${p.descripcion}`) }
  return { db, su, admin, cobrador, audits, sink }
}

const datosRuta = (over: Record<string, unknown> = {}) => ({
  tenantId: 't-1', nombre: 'Ruta Norte', ciudad: 'Barranquilla',
  tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000,
  capitalInicial: 0, codigo: 'RT-001', adminIds: [] as string[],
  ...over,
})

// ------------------------------------------------------------
// CRUD del catálogo
// ------------------------------------------------------------

await spec('OFFICE-CRUD-001', 'Oficinas', 'se crea una Oficina VACÍA, sin ninguna ruta', async () => {
  const { db, su, audits, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Oficina Leticia', codigo: 'LET' }, su, asOfficeDb(db), sink)
  const guardadas = await db.offices.toArray()
  metric('oficinas', guardadas.length)
  metric('rutas', (await db.routes.toArray()).length)
  metric('estado', office.status)
  metric('auditoría', audits.join(' | '))
  assert(guardadas.length === 1, 'la Oficina no se creó')
  assert(office.status === 'activa', 'una Oficina nueva debe nacer activa')
  assert((await db.routes.toArray()).length === 0, 'crear una Oficina no debe crear rutas')
  assert(audits.some(a => a.startsWith('CREATE_OFFICE')), 'falta la auditoría de creación')
})

await spec('OFFICE-CRUD-002', 'Oficinas', 'el nombre duplicado en la empresa se rechaza sin distinguir mayúsculas', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  await createOffice({ tenantId: 't-1', nombre: 'Oficina Leticia' }, su, asOfficeDb(db), sink)
  let error = ''
  try {
    await createOffice({ tenantId: 't-1', nombre: '  oficina leticia  ' }, su, asOfficeDb(db), sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('resultado', error || 'ACEPTADO — ERROR')
  metric('oficinas', (await db.offices.toArray()).length)
  assert(!!error, 'el nombre duplicado debía rechazarse')
  assert((await db.offices.toArray()).length === 1, 'no debe quedar una segunda Oficina')
})

await spec('OFFICE-CRUD-003', 'Oficinas', 'el mismo nombre en OTRA empresa sí se permite', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  await createOffice({ tenantId: 't-1', nombre: 'Oficina Leticia' }, su, asOfficeDb(db), sink)
  await createOffice({ tenantId: 't-2', nombre: 'Oficina Leticia' }, su, asOfficeDb(db), sink)
  const todas = await db.offices.toArray()
  metric('oficinas totales', todas.length)
  metric('empresas', [...new Set(todas.map(o => o.tenantId))].join(', '))
  assert(todas.length === 2, 'la unicidad NO debe ser global entre empresas')
})

await spec('OFFICE-CRUD-004', 'Oficinas', 'el código duplicado en la empresa se rechaza; el libre se acepta', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  await createOffice({ tenantId: 't-1', nombre: 'Leticia', codigo: 'LET' }, su, asOfficeDb(db), sink)
  let error = ''
  try {
    await createOffice({ tenantId: 't-1', nombre: 'Río', codigo: 'let' }, su, asOfficeDb(db), sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  await createOffice({ tenantId: 't-1', nombre: 'Río', codigo: 'RIO' }, su, asOfficeDb(db), sink)
  metric('código duplicado', error || 'ACEPTADO — ERROR')
  metric('oficinas', (await db.offices.toArray()).length)
  assert(!!error, 'el código duplicado debía rechazarse')
  assert((await db.offices.toArray()).length === 2, 'el código libre debía aceptarse')
})

await spec('OFFICE-CRUD-005', 'Oficinas', 'eliminar una Oficina VACÍA está permitido', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const { detached } = await deleteOffice({ officeId: office.id, tenantId: 't-1' }, su, asOfficeDb(db), sink)
  metric('rutas desvinculadas', detached.length)
  metric('oficinas restantes', (await db.offices.toArray()).length)
  assert((await db.offices.toArray()).length === 0, 'la Oficina vacía debía eliminarse')
  assert(detached.length === 0, 'no había rutas que desvincular')
})

await spec('OFFICE-CRUD-006', 'Oficinas', 'eliminar una Oficina CON rutas NO elimina ninguna ruta', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id }), su, asRouteDb(db), sink)

  // Sin pedir desvincular explícitamente, el borrado se RECHAZA.
  let error = ''
  try {
    await deleteOffice({ officeId: office.id, tenantId: 't-1' }, su, asOfficeDb(db), sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('borrado directo', error || 'ACEPTADO — ERROR')
  metric('rutas', (await db.routes.toArray()).length)
  metric('oficinas', (await db.offices.toArray()).length)
  assert(!!error, 'no debe poder borrarse una Oficina con rutas sin decidir qué hacer con ellas')
  assert((await db.routes.toArray()).length === 1, 'la ruta no puede desaparecer')
  assert((await db.offices.toArray()).length === 1, 'la Oficina no debía borrarse')
  void ruta
})

await spec('OFFICE-CRUD-007', 'Oficinas', 'desvincular y eliminar deja las rutas "Sin Oficina", con sus datos intactos', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)
  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: ruta.id, nombre: 'Cliente' })

  const { detached } = await deleteOffice({ officeId: office.id, tenantId: 't-1', detachRoutes: true }, su, asOfficeDb(db), sink)

  const guardada = (await db.routes.toArray())[0]
  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  metric('rutas desvinculadas', detached.join(', '))
  metric('officeId de la ruta', String(guardada.officeId))
  metric('clientes', (await db.clients.toArray()).length)
  metric('asignación del cobrador', JSON.stringify(cob.authorizedRouteIds))
  assert((await db.offices.toArray()).length === 0, 'la Oficina debía eliminarse')
  assert(guardada.officeId === undefined, 'la ruta debía quedar Sin Oficina')
  assert((await db.clients.toArray()).length === 1, 'no puede perderse ningún cliente')
  assert(cob.authorizedRouteIds?.includes(ruta.id) === true, 'las asignaciones de usuarios deben conservarse')
})

// ------------------------------------------------------------
// Rutas y Oficinas
// ------------------------------------------------------------

await spec('OFFICE-ROUTE-001', 'Oficinas', 'se crea una Ruta SIN Oficina (y sin Admin ni Cobrador)', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta(), su, asRouteDb(db), sink)
  metric('officeId', String(ruta.officeId))
  metric('cobradorId', String(ruta.cobradorId))
  metric('estado', ruta.status)
  assert(ruta.officeId === undefined, 'no debe inventarse una Oficina')
  assert(ruta.status === 'activa', 'la ruta debe nacer activa')
  assert((await db.routes.toArray()).length === 1, 'la ruta no se creó')
})

await spec('OFFICE-ROUTE-002', 'Oficinas', 'se crea una Ruta CON Oficina', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id }), su, asRouteDb(db), sink)
  metric('officeId', ruta.officeId)
  assert(ruta.officeId === office.id, 'la ruta no quedó en la Oficina indicada')
})

await spec('OFFICE-ROUTE-002b', 'Oficinas', 'una Oficina de OTRA empresa se rechaza (aislamiento por tenant)', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const ajena = await createOffice({ tenantId: 't-2', nombre: 'Ajena' }, su, asOfficeDb(db), sink)
  let error = ''
  try {
    await createRouteWithAdmins(datosRuta({ officeId: ajena.id }), su, asRouteDb(db), sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  metric('resultado', error || 'ACEPTADO — ERROR')
  metric('rutas creadas', (await db.routes.toArray()).length)
  assert(!!error, 'no puede asignarse una Oficina de otra empresa')
  assert((await db.routes.toArray()).length === 0, 'no debe quedar ninguna ruta')
})

await spec('OFFICE-ROUTE-003', 'Oficinas', 'a una ruta Sin Oficina se le asigna una DESPUÉS', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta(), su, asRouteDb(db), sink)
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)

  await moveRouteToOffice({ routeId: ruta.id, tenantId: 't-1', officeId: office.id }, su, asOfficeDb(db), sink)

  const guardada = (await db.routes.toArray())[0]
  metric('officeId tras asignar', guardada.officeId)
  assert(guardada.officeId === office.id, 'la asignación posterior no se persistió')
})

await spec('OFFICE-ROUTE-004', 'Oficinas', 'mover una Ruta de la Oficina A a la B es UNA sola escritura auditada', async () => {
  const { db, su, audits, sink } = await empresaParaOficinas()
  const a = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const b = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: a.id }), su, asRouteDb(db), sink)

  db.resetLog()
  await moveRouteToOffice({ routeId: ruta.id, tenantId: 't-1', officeId: b.id }, su, asOfficeDb(db), sink)

  const escrituras = db.log.filter(op => op.endsWith('.add') || op.endsWith('.update'))
  const guardada = (await db.routes.toArray())[0]
  metric('escrituras realizadas', escrituras.join(', ') || '(ninguna)')
  metric('officeId final', guardada.officeId)
  metric('auditoría', audits.filter(x => x.includes('Oficina')).join(' | '))
  assert(guardada.officeId === b.id, 'la ruta no se movió')
  assert(escrituras.length === 1 && escrituras[0] === 'routes.update',
    `mover una ruta debe ser UNA sola escritura sobre routes; hubo: ${escrituras.join(', ')}`)
})

await spec('OFFICE-ROUTE-005', 'Oficinas', 'una ruta Sin Oficina sigue plenamente operativa', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta({ cobradorId: cobrador.id }), su, asRouteDb(db), sink)
  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  metric('officeId', String(ruta.officeId))
  metric('cobrador operativo', hasOperationalRoutes(cob))
  metric('accede a la ruta', canAccessRoute(cob, ruta.id))
  metric('puede registrar pagos', can(cob, 'payment.register', { routeId: ruta.id }))
  assert(ruta.officeId === undefined, 'precondición: la ruta no tiene Oficina')
  assert(hasOperationalRoutes(cob) && canAccessRoute(cob, ruta.id), 'una ruta sin Oficina debe operar igual')
  assert(can(cob, 'payment.register', { routeId: ruta.id }), 'no tener Oficina no puede quitar capacidades')
})

await spec('OFFICE-ROUTE-006', 'Oficinas', 'mover una Ruta NO toca clientes, ventas, pagos ni parcelas', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const a = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const b = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: a.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)

  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: ruta.id, nombre: 'Cliente' })
  await db.sales.add({ id: 's-1', tenantId: 't-1', routeId: ruta.id, clientId: 'c-1', saldo: 1000, status: 'activa' } as never)
  await db.installments.add({ id: 'i-1', saleId: 's-1', numero: 1, valor: 1000, pagado: 0, saldo: 1000, status: 'pendiente' } as never)
  await db.payments.add({ id: 'p-1', tenantId: 't-1', saleId: 's-1', clientId: 'c-1', routeId: ruta.id, collectorId: cobrador.id, valor: 500 })

  const antes = JSON.stringify([
    await db.clients.toArray(), await db.sales.toArray(),
    await db.installments.toArray(), await db.payments.toArray(),
  ])

  await moveRouteToOffice({ routeId: ruta.id, tenantId: 't-1', officeId: b.id }, su, asOfficeDb(db), sink)

  const despues = JSON.stringify([
    await db.clients.toArray(), await db.sales.toArray(),
    await db.installments.toArray(), await db.payments.toArray(),
  ])
  metric('entidades hijas idénticas', antes === despues)
  metric('officeId de la ruta', (await db.routes.toArray())[0].officeId)
  assert(antes === despues, 'mover la Oficina modificó entidades que dependen de la RUTA, no de la Oficina')
  assert((await db.routes.toArray())[0].officeId === b.id, 'la ruta no se movió')
})

await spec('OFFICE-ROUTE-007', 'Oficinas', 'crear una Ruta no exige Oficina, ni Administrador, ni Cobrador', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta(), su, asRouteDb(db), sink)
  const users = await db.users.toArray() as User[]
  metric('ruta creada', `${ruta.nombre} · ${ruta.codigo}`)
  metric('sin Oficina / sin Cobrador', `${ruta.officeId === undefined} / ${ruta.cobradorId === undefined}`)
  metric('usuarios asignados', users.filter(u => (u.authorizedRouteIds ?? []).includes(ruta.id)).length)
  assert(!!ruta.id, 'la ruta debe crearse solo con sus datos básicos')
  assert(ruta.officeId === undefined && ruta.cobradorId === undefined, 'no debe inventarse ningún responsable ni Oficina')

  // Y la advertencia combinada las menciona a las tres.
  const avisos = routeAssignmentWarnings({ hasOffice: false, hasAdmin: false, hasCobrador: false })
  metric('advertencias', avisos.length)
  assert(avisos.length === 3, 'deben avisarse Oficina, Administrador y Cobrador ausentes')
  assert(avisos.some(a => a.includes('sin Oficina')), 'falta la advertencia de Oficina')
})

// ------------------------------------------------------------
// Oficina inactiva
// ------------------------------------------------------------

await spec('OFFICE-STATUS-001', 'Oficinas', 'una Oficina inactiva conserva TODA la consulta histórica', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)
  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: ruta.id, nombre: 'Cliente' })
  await db.sales.add({ id: 's-1', tenantId: 't-1', routeId: ruta.id, clientId: 'c-1', saldo: 1000, status: 'activa' } as never)

  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'inactiva' }, su, asOfficeDb(db), sink)

  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  const rutaGuardada = (await db.routes.toArray())[0]
  metric('clientes visibles', (await db.clients.toArray()).length)
  metric('ventas visibles', (await db.sales.toArray()).length)
  metric('status de la ruta', rutaGuardada.status)
  metric('asignación del cobrador', JSON.stringify(cob.authorizedRouteIds))
  metric('sigue accediendo a la ruta', canAccessRoute(cob, ruta.id))
  assert((await db.clients.toArray()).length === 1 && (await db.sales.toArray()).length === 1, 'la consulta histórica debe seguir intacta')
  assert(rutaGuardada.status === 'activa', 'inactivar la Oficina NO debe cambiar el estado de la ruta')
  assert(cob.authorizedRouteIds?.includes(ruta.id) === true, 'no debe desasignarse a nadie')
  assert(canAccessRoute(cob, ruta.id), 'el acceso de consulta no se toca')
})

await spec('OFFICE-STATUS-002', 'Oficinas', 'la guarda bloquea operaciones NUEVAS en rutas de Oficina inactiva', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id }), su, asRouteDb(db), sink)

  await assertRouteOperationalContext(ruta.id, asOfficeDb(db))   // activa: no lanza
  const operativaAntes = await isRouteOperational(ruta.id, asOfficeDb(db))

  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'inactiva' }, su, asOfficeDb(db), sink)
  let error = ''
  try { await assertRouteOperationalContext(ruta.id, asOfficeDb(db)) } catch (e) { error = e instanceof Error ? e.message : String(e) }
  const operativaDespues = await isRouteOperational(ruta.id, asOfficeDb(db))

  metric('operativa con Oficina activa', operativaAntes)
  metric('operativa con Oficina inactiva', operativaDespues)
  metric('mensaje', error)
  assert(operativaAntes, 'con la Oficina activa la ruta debe operar')
  assert(!operativaDespues && !!error, 'con la Oficina inactiva debe bloquearse')
  assert(error.includes('Oficina inactiva'), 'el mensaje debe explicar el motivo con claridad')
})

await spec('OFFICE-STATUS-003', 'Oficinas', 'una ruta SIN Oficina nunca se bloquea por esta regla', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta(), su, asRouteDb(db), sink)
  const operativa = await isRouteOperational(ruta.id, asOfficeDb(db))
  metric('officeId', String(ruta.officeId))
  metric('operativa', operativa)
  assert(operativa, 'una ruta sin Oficina no tiene Oficina que la pueda inactivar')
})

await spec('OFFICE-STATUS-004', 'Oficinas', 'inactivar una Oficina no afecta a las rutas de OTRAS Oficinas', async () => {
  const { db, su, sink } = await empresaParaOficinas()
  const a = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const b = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)
  const rA = await createRouteWithAdmins(datosRuta({ officeId: a.id }), su, asRouteDb(db), sink)
  const rB = await createRouteWithAdmins(datosRuta({ officeId: b.id, codigo: 'RT-002', nombre: 'Ruta Río' }), su, asRouteDb(db), sink)

  await setOfficeStatus({ officeId: a.id, tenantId: 't-1', status: 'inactiva' }, su, asOfficeDb(db), sink)

  metric('ruta de Leticia operativa', await isRouteOperational(rA.id, asOfficeDb(db)))
  metric('ruta de Río operativa', await isRouteOperational(rB.id, asOfficeDb(db)))
  assert(!(await isRouteOperational(rA.id, asOfficeDb(db))), 'la ruta de la Oficina inactiva debía bloquearse')
  assert(await isRouteOperational(rB.id, asOfficeDb(db)), 'la ruta de otra Oficina no debe verse afectada')
})

await spec('OFFICE-STATUS-006', 'Oficinas', 'reactivar la Oficina restablece la operación sin reasignar a nadie', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)

  const asignacionInicial = JSON.stringify(((await db.users.toArray() as User[]).find(u => u.id === cobrador.id))!.authorizedRouteIds)
  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'inactiva' }, su, asOfficeDb(db), sink)
  await setOfficeStatus({ officeId: office.id, tenantId: 't-1', status: 'activa' }, su, asOfficeDb(db), sink)

  const asignacionFinal = JSON.stringify(((await db.users.toArray() as User[]).find(u => u.id === cobrador.id))!.authorizedRouteIds)
  metric('operativa tras reactivar', await isRouteOperational(ruta.id, asOfficeDb(db)))
  metric('asignación antes → después', `${asignacionInicial} → ${asignacionFinal}`)
  assert(await isRouteOperational(ruta.id, asOfficeDb(db)), 'reactivar debe restablecer la operación')
  assert(asignacionInicial === asignacionFinal, 'reactivar no debe tocar las asignaciones de usuarios')
})

// ------------------------------------------------------------
// Usuarios generales de empresa
// ------------------------------------------------------------

await spec('OFFICE-USER-001', 'Oficinas', 'un usuario puede tener rutas de VARIAS Oficinas', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const let_ = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)
  const rL = await createRouteWithAdmins(datosRuta({ officeId: let_.id, nombre: 'Centro', codigo: 'RT-001' }), su, asRouteDb(db), sink)
  const rR = await createRouteWithAdmins(datosRuta({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-002' }), su, asRouteDb(db), sink)
  // Ruta de Leticia a la que NO se le asigna: la prueba de que la Oficina no contagia.
  const rL2 = await createRouteWithAdmins(datosRuta({ officeId: let_.id, nombre: 'Norte', codigo: 'RT-003' }), su, asRouteDb(db), sink)

  await db.users.update(cobrador.id, { authorizedRouteIds: [rL.id, rR.id] })
  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  const rutas = await db.routes.toArray()
  const accesibles = filterAccessibleRoutes(cob, rutas as never[])

  metric('authorizedRouteIds', JSON.stringify(cob.authorizedRouteIds))
  metric('rutas accesibles', accesibles.length)
  metric('tiene officeIds', 'officeIds' in (cob as unknown as Record<string, unknown>))
  assert(accesibles.length === 2, 'debe ver exactamente sus dos rutas')
  assert(canAccessRoute(cob, rL.id) && canAccessRoute(cob, rR.id), 'debe acceder a sus dos rutas')
  assert(!canAccessRoute(cob, rL2.id), 'tener una ruta de Leticia NO puede conceder las demás de Leticia')
  assert(!('officeIds' in (cob as unknown as Record<string, unknown>)), 'no debe guardarse ninguna lista de oficinas')
  assert(!('officeId' in (cob as unknown as Record<string, unknown>)), 'el usuario no pertenece a una Oficina')
})

await spec('OFFICE-USER-003', 'Oficinas', 'cambiar la Oficina de una Ruta NO cambia authorizedRouteIds', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const a = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const b = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: a.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)

  const antes = JSON.stringify(await db.users.toArray())
  await moveRouteToOffice({ routeId: ruta.id, tenantId: 't-1', officeId: b.id }, su, asOfficeDb(db), sink)
  const despues = JSON.stringify(await db.users.toArray())

  metric('usuarios idénticos', antes === despues)
  metric('sigue accediendo', canAccessRoute((await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!, ruta.id))
  assert(antes === despues, 'mover la ruta de Oficina alteró los usuarios')
})

await spec('OFFICE-USER-004', 'Oficinas', 'eliminar la Oficina conserva las asignaciones de los usuarios', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id, cobradorId: cobrador.id }), su, asRouteDb(db), sink)

  await deleteOffice({ officeId: office.id, tenantId: 't-1', detachRoutes: true }, su, asOfficeDb(db), sink)

  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!
  metric('authorizedRouteIds', JSON.stringify(cob.authorizedRouteIds))
  metric('ruta Sin Oficina', (await db.routes.toArray())[0].officeId === undefined)
  metric('sigue operativo', hasOperationalRoutes(cob))
  assert(cob.authorizedRouteIds?.includes(ruta.id) === true, 'la asignación debe sobrevivir al borrado de la Oficina')
  assert(hasOperationalRoutes(cob), 'el cobrador debe seguir operativo')
})

// ------------------------------------------------------------
// CLEAN y DEMO
// ------------------------------------------------------------

await spec('OFFICE-CLEAN-001', 'Oficinas', 'una instalación CLEAN arranca con CERO Oficinas', async () => {
  const db = await freshCleanInstall()
  const c = await db.counts()
  metric('offices', c.offices)
  metric('routes', c.routes)
  assert(c.offices === 0, 'CLEAN no debe traer ninguna Oficina')
  assert(Object.values(c).every(n => n === 0), 'CLEAN debe seguir naciendo completamente vacía')
})

await spec('OFFICE-CLEAN-002', 'Oficinas', 'el recorrido CLEAN se completa SIN crear ninguna Oficina', async () => {
  const { db, su, cobrador, sink } = await empresaParaOficinas()
  const ruta = await createRouteWithAdmins(datosRuta({ cobradorId: cobrador.id }), su, asRouteDb(db), sink)
  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: ruta.id, nombre: 'Cliente' })
  const cob = (await db.users.toArray() as User[]).find(u => u.id === cobrador.id)!

  metric('oficinas creadas', (await db.offices.toArray()).length)
  metric('ruta operativa', await isRouteOperational(ruta.id, asOfficeDb(db)))
  metric('cobrador operativo', hasOperationalRoutes(cob))
  assert((await db.offices.toArray()).length === 0, 'el recorrido no debe exigir ninguna Oficina')
  assert(await isRouteOperational(ruta.id, asOfficeDb(db)), 'la ruta sin Oficina debe operar')
  assert(hasOperationalRoutes(cob) && canAccessRoute(cob, ruta.id), 'el cobrador debe poder trabajar')

  // Y el checklist de arranque NO incorpora las Oficinas como paso.
  const checklist = readSource('src/components/ui/SetupChecklist.tsx')
  metric('checklist menciona Oficinas', /[Oo]ficina/.test(checklist))
  assert(!/[Oo]ficina/.test(checklist), 'las Oficinas son opcionales: no deben entrar en el checklist')
})

await spec('OFFICE-CLEAN-003', 'Oficinas', 'el reset de empresa limpia también las Oficinas', () => {
  const seed = readSource('src/data/seed.ts')
  const bloque = seed.slice(seed.indexOf('export async function resetCleanDatabase'))
  metric('limpia offices', bloque.includes("db.offices.where('tenantId')"))
  assert(bloque.includes("db.offices.where('tenantId')"), 'resetCleanDatabase dejaría Oficinas huérfanas')
  // Y el reset total borra la base completa (cubre cualquier tabla nueva).
  const reset = readSource('src/lib/resetApp.ts')
  assert(reset.includes('db.delete()'), 'el reset total debe seguir borrando la base entera')
})

await spec('OFFICE-DEMO-001', 'Oficinas', 'DEMO siembra Oficinas y una ruta deliberadamente Sin Oficina', () => {
  const seed = readSource('src/data/seed.ts')
  metric('Oficina Barranquilla', seed.includes("nombre: 'Oficina Barranquilla'"))
  metric('Oficina Soledad', seed.includes("nombre: 'Oficina Soledad'"))
  metric('ruta sin Oficina', seed.includes('ROUTE5_ID'))
  assert(seed.includes("nombre: 'Oficina Barranquilla'") && seed.includes("nombre: 'Oficina Soledad'"),
    'DEMO debe traer las dos oficinas representativas')
  assert(seed.includes('ROUTE5_ID'), 'DEMO debe incluir una ruta Sin Oficina para mostrar ese estado')

  // La tabla DEBE estar declarada en la transacción del seed (lección del 15/09).
  const tx = seed.slice(seed.indexOf("await db.transaction('rw', ["), seed.indexOf('await db.tenants.add(tenant)'))
  metric('db.offices en el alcance de la transacción', tx.includes('db.offices'))
  assert(tx.includes('db.offices'), 'toda tabla usada dentro de una transacción debe declararse en su alcance')
  assert(seed.includes('await db.offices.bulkAdd(offices)'), 'DEMO no siembra las oficinas')
})

await spec('OFFICE-DEMO-002', 'Oficinas', 'DEMO no guarda officeId fuera de las rutas', () => {
  const seed = readSource('src/data/seed.ts')
  // Las únicas asignaciones admisibles son `officeId: OFFICE1_ID` / `OFFICE2_ID`
  // dentro del array de rutas.
  const asignaciones = seed.match(/officeId:\s*[^,\n}]+/g) ?? []
  const fuera = asignaciones.filter(a => !/OFFICE[12]_ID/.test(a))
  metric('asignaciones de officeId', asignaciones.length)
  metric('fuera de Route', fuera.length === 0 ? '(ninguna)' : fuera.join(' | '))
  assert(fuera.length === 0, `DEMO guarda officeId fuera de las rutas: ${fuera.join(', ')}`)
  assert(asignaciones.length === 4, `se esperaban 4 rutas con Oficina; hay ${asignaciones.length}`)
})

// ############################################################
// GRUPO — OFICINA COMO UNIDAD DE GESTIÓN (servicio real)
// ------------------------------------------------------------
// `getOfficeManagementSummary` es el punto único de carga del panel de Oficina.
// Estos casos comprueban sobre el SERVICIO REAL que entrar a una Oficina no
// concede ni una ruta, y que el recorte se hace ANTES de agrupar.
// ############################################################
const asSummaryDb = (db: MemoryDb) => db as unknown as OfficeSummaryDatabase

/**
 * Empresa con dos Oficinas: Leticia (3 rutas) y Río (1 ruta).
 * El Admin solo tiene autorizadas 2 de las 3 de Leticia — la situación que debe
 * mostrarse como "2 de 3 rutas visibles" sin aparentar el total.
 */
async function empresaConOficinas() {
  const { db, su, admin, sink } = await empresaParaOficinas()
  const leticia = await createOffice({ tenantId: 't-1', nombre: 'Leticia', codigo: 'LET' }, su, asOfficeDb(db), sink)
  const rio = await createOffice({ tenantId: 't-1', nombre: 'Río' }, su, asOfficeDb(db), sink)

  const rL1 = await createRouteWithAdmins(datosRuta({ officeId: leticia.id, nombre: 'Centro', codigo: 'RT-001' }), su, asRouteDb(db), sink)
  const rL2 = await createRouteWithAdmins(datosRuta({ officeId: leticia.id, nombre: 'Mercado', codigo: 'RT-002' }), su, asRouteDb(db), sink)
  const rL3 = await createRouteWithAdmins(datosRuta({ officeId: leticia.id, nombre: 'Norte', codigo: 'RT-003' }), su, asRouteDb(db), sink)
  const rR1 = await createRouteWithAdmins(datosRuta({ officeId: rio.id, nombre: 'Puerto', codigo: 'RT-004' }), su, asRouteDb(db), sink)
  const rX = await createRouteWithAdmins(datosRuta({ nombre: 'Antigua', codigo: 'RT-005' }), su, asRouteDb(db), sink)

  // El Admin ve Centro y Mercado, NO Norte.
  await db.users.update(admin.id, { authorizedRouteIds: [rL1.id, rL2.id] })
  const adminScoped = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!

  return { db, su, admin: adminScoped, sink, leticia, rio, rL1, rL2, rL3, rR1, rX }
}

await spec('OFFICE-MGMT-001', 'Gestión Oficina', 'el panel carga la Oficina correcta y solo esa', async () => {
  const { db, su, leticia } = await empresaConOficinas()
  const resumen = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  metric('oficina', resumen?.office.nombre)
  metric('código', resumen?.office.codigo)
  metric('rutas del panel', resumen?.accessibleOfficeRoutes.map(r => r.nombre).join(', '))
  assert(resumen?.office.id === leticia.id, 'no cargó la Oficina pedida')
  assert(resumen!.accessibleOfficeRoutes.every(r => r.officeId === leticia.id), 'se colaron rutas de otra Oficina')
  assert(!resumen!.accessibleOfficeRoutes.some(r => r.nombre === 'Puerto' || r.nombre === 'Antigua'),
    'aparecieron rutas ajenas a la Oficina')
})

await spec('OFFICE-MGMT-001b', 'Gestión Oficina', 'una Oficina de otra empresa no se carga', async () => {
  const { db, su, sink } = await empresaConOficinas()
  const ajena = await createOffice({ tenantId: 't-2', nombre: 'Ajena' }, su, asOfficeDb(db), sink)
  const resumen = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: ajena.id }, asSummaryDb(db))
  metric('resultado', resumen === null ? 'null (correcto)' : 'CARGÓ — ERROR')
  assert(resumen === null, 'el aislamiento por empresa se rompió')
})

await spec('OFFICE-MGMT-002', 'Gestión Oficina', 'el Admin ve SOLO sus rutas autorizadas de esa Oficina', async () => {
  const { db, admin, leticia, rL3 } = await empresaConOficinas()
  const resumen = await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  const nombres = resumen!.accessibleOfficeRoutes.map(r => r.nombre)
  metric('rutas visibles', nombres.join(', '))
  metric('alcance', resumen!.scope.label)
  assert(nombres.length === 2, `el Admin debía ver 2 rutas, vio ${nombres.length}`)
  assert(nombres.includes('Centro') && nombres.includes('Mercado'), 'faltan sus rutas')
  assert(!nombres.includes('Norte'), 'el Admin ve una ruta de la Oficina que NO tiene autorizada')
  assert(!resumen!.accessibleOfficeRoutes.some(r => r.id === rL3.id), 'entrar a la Oficina concedió una ruta')
  assert(resumen!.scope.parcial && resumen!.scope.label === '2 de 3 rutas visibles — rutas autorizadas',
    'el alcance parcial debe rotularse con honestidad')
})

await spec('OFFICE-MGMT-003', 'Gestión Oficina', 'el Super Admin ve todas las rutas de la Oficina', async () => {
  const { db, su, leticia } = await empresaConOficinas()
  const resumen = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  metric('rutas visibles', resumen!.accessibleOfficeRoutes.length)
  metric('alcance', resumen!.scope.label)
  assert(resumen!.accessibleOfficeRoutes.length === 3, 'el Super Admin debe ver las 3 rutas')
  assert(!resumen!.scope.parcial, 'con cobertura completa no debe rotularse como parcial')
})

await spec('OFFICE-MGMT-004', 'Gestión Oficina', 'entrar a la Oficina NO concede ninguna ruta nueva', async () => {
  const { db, admin, leticia, rL3 } = await empresaConOficinas()
  const antes = JSON.stringify((await db.users.toArray() as User[]).find(u => u.id === admin.id))
  await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  const despues = (await db.users.toArray() as User[]).find(u => u.id === admin.id)!

  metric('usuario sin cambios', antes === JSON.stringify(despues))
  metric('canAccessRoute(Norte)', canAccessRoute(despues, rL3.id))
  assert(antes === JSON.stringify(despues), 'abrir el panel modificó las asignaciones del usuario')
  assert(!canAccessRoute(despues, rL3.id), 'entrar a la Oficina concedió acceso a una ruta ajena')
})

await spec('OFFICE-MGMT-005', 'Gestión Oficina', 'crear una Ruta desde la Oficina la preselecciona y sigue siendo opcional', async () => {
  const { db, su, leticia, sink } = await empresaConOficinas()
  // La pantalla envía la Oficina como parámetro y el servicio la aplica.
  const conOficina = await createRouteWithAdmins(datosRuta({ officeId: leticia.id, nombre: 'Nueva', codigo: 'RT-010' }), su, asRouteDb(db), sink)
  // Y la Oficina NO es obligatoria: el mismo flujo sin ella también crea la ruta.
  const sinOficina = await createRouteWithAdmins(datosRuta({ nombre: 'Libre', codigo: 'RT-011' }), su, asRouteDb(db), sink)

  metric('ruta creada desde la Oficina', conOficina.officeId === leticia.id)
  metric('ruta creada sin Oficina', sinOficina.officeId === undefined)
  metric('sin Admin ni Cobrador', `${conOficina.cobradorId === undefined}`)
  assert(conOficina.officeId === leticia.id, 'la Oficina preseleccionada no se aplicó')
  assert(sinOficina.officeId === undefined, 'la Oficina dejó de ser opcional')
  assert(conOficina.cobradorId === undefined, 'crear desde la Oficina no debe exigir Cobrador')

  // La pantalla de rutas acepta el enlace profundo y no duplica el formulario.
  const page = readSource('src/pages/admin/RoutesPage.tsx')
  metric('acepta ?nueva&officeId', page.includes("searchParams.get('nueva')") && page.includes("searchParams.get('officeId')"))
  assert(page.includes("openCreate(searchParams.get('officeId') ?? undefined)"),
    'el enlace desde la Oficina debe reutilizar el formulario existente')
})

await spec('OFFICE-MGMT-006', 'Gestión Oficina', 'la Oficina sigue siendo opcional y el enlace no puede editar rutas ajenas', () => {
  const page = readSource('src/pages/admin/RoutesPage.tsx')
  const avisos = routeAssignmentWarnings({ hasOffice: false, hasAdmin: false, hasCobrador: false })
  metric('advertencias sin responsables', avisos.length)
  assert(avisos.some(a => a.includes('sin Oficina')), 'debe seguir avisándose la Oficina ausente')
  // El enlace `?editar=` solo abre rutas que están entre las accesibles.
  metric('el enlace valida el alcance', page.includes("const route = routes.find(r => r.id === editar)"))
  assert(/if \(route\) openEdit\(route\)\s*\n\s*else toast\.error/.test(page),
    'un enlace con una ruta fuera de alcance no debe abrir el editor')
})

await spec('OFFICE-MGMT-007', 'Gestión Oficina', 'mover una Ruta A → B solo cambia Route.officeId', async () => {
  const { db, su, rL1, rio, sink } = await empresaConOficinas()
  await db.clients.add({ id: 'c-1', tenantId: 't-1', routeId: rL1.id, nombre: 'Cliente' })
  await db.sales.add({ id: 's-1', tenantId: 't-1', routeId: rL1.id, clientId: 'c-1', saldo: 1000, status: 'activa' } as never)

  const antes = JSON.stringify([await db.clients.toArray(), await db.sales.toArray(), await db.users.toArray()])
  db.resetLog()
  await moveRouteToOffice({ routeId: rL1.id, tenantId: 't-1', officeId: rio.id }, su, asOfficeDb(db), sink)
  const escrituras = db.log.filter(op => op.endsWith('.add') || op.endsWith('.update'))
  const despues = JSON.stringify([await db.clients.toArray(), await db.sales.toArray(), await db.users.toArray()])

  metric('escrituras', escrituras.join(', '))
  metric('hijos y usuarios idénticos', antes === despues)
  metric('nueva Oficina', (await db.routes.get(rL1.id) as { officeId?: string }).officeId === rio.id)
  assert(escrituras.length === 1 && escrituras[0] === 'routes.update', `mover debe ser UNA escritura; hubo: ${escrituras.join(', ')}`)
  assert(antes === despues, 'mover la ruta alteró clientes, ventas o usuarios')
})

await spec('OFFICE-MGMT-008', 'Gestión Oficina', 'mover una Ruta a "Sin Oficina" funciona y la deja operativa', async () => {
  const { db, su, rL1, sink } = await empresaConOficinas()
  await moveRouteToOffice({ routeId: rL1.id, tenantId: 't-1', officeId: undefined }, su, asOfficeDb(db), sink)
  const ruta = await db.routes.get(rL1.id) as { officeId?: string; status: string }
  metric('officeId', String(ruta.officeId))
  metric('status', ruta.status)
  metric('operativa', await isRouteOperational(rL1.id, asOfficeDb(db)))
  assert(ruta.officeId === undefined, 'la ruta debía quedar Sin Oficina')
  assert(ruta.status === 'activa', 'quitarle la Oficina no puede cambiar su estado')
  assert(await isRouteOperational(rL1.id, asOfficeDb(db)), 'una ruta Sin Oficina debe seguir operando')
})

await spec('OFFICE-MGMT-010', 'Gestión Oficina', 'los usuarios relacionados se derivan de authorizedRouteIds', async () => {
  const { db, su, leticia, rL1, rL2, rR1, cobradorId } = await (async () => {
    const base = await empresaConOficinas()
    // Fabio trabaja en Leticia/Centro y en Río/Puerto.
    await base.db.users.update('u-cob-1', { authorizedRouteIds: [base.rL1.id, base.rR1.id] })
    return { ...base, cobradorId: 'u-cob-1' }
  })()

  const resumen = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  const fabio = resumen!.relatedUsers.find(u => u.id === cobradorId)

  metric('usuarios relacionados', resumen!.relatedUsers.map(u => u.nombre).join(', '))
  metric('rutas de Fabio en Leticia', fabio?.routes.map(r => r.nombre).join(', '))
  assert(!!fabio, 'Fabio debe aparecer relacionado con Leticia')
  assert(fabio!.routes.length === 1 && fabio!.routes[0].id === rL1.id,
    'de un usuario multi-Oficina aquí solo deben verse sus rutas de ESTA Oficina')
  assert(!fabio!.routes.some(r => r.id === rR1.id), 'se filtró una ruta de otra Oficina')
  void rL2
})

await spec('OFFICE-MGMT-011', 'Gestión Oficina', 'los indicadores y alertas se calculan solo sobre las rutas visibles', async () => {
  const { db, admin, su, leticia, rL3 } = await empresaConOficinas()
  // La ruta que el Admin NO ve tiene datos: no pueden aparecer en sus indicadores.
  await db.clients.add({ id: 'c-oculto', tenantId: 't-1', routeId: rL3.id, nombre: 'Cliente oculto' })
  await db.sales.add({ id: 's-oculto', tenantId: 't-1', routeId: rL3.id, clientId: 'c-oculto', saldo: 9999, status: 'activa', disbursementStatus: 'pendiente' } as never)

  const delAdmin = await getOfficeManagementSummary({ user: admin, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))
  const delSuper = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: leticia.id }, asSummaryDb(db))

  metric('rutas del Admin', delAdmin!.kpis.rutasVisibles)
  metric('desembolsos pendientes del Admin', delAdmin!.kpis.desembolsosPendientes)
  metric('desembolsos pendientes del Super Admin', delSuper!.kpis.desembolsosPendientes)
  metric('alertas del Admin mencionan Norte', delAdmin!.alerts.some(a => a.mensaje.includes('Norte')))
  assert(delAdmin!.kpis.rutasVisibles === 2, 'los indicadores del Admin deben contar solo sus rutas')
  assert(delAdmin!.kpis.desembolsosPendientes === 0, 'un dato de una ruta no autorizada se filtró a los indicadores')
  assert(delSuper!.kpis.desembolsosPendientes === 1, 'el Super Admin sí debe verlo')
  assert(!delAdmin!.alerts.some(a => a.mensaje.includes('Norte')), 'una alerta reveló una ruta no autorizada')
})

await spec('OFFICE-UNASSIGNED-003', 'Gestión Oficina', 'asignar rutas desde "Sin Oficina" es transaccional y no toca hijos', async () => {
  const { db, su, leticia, rX, sink } = await empresaConOficinas()
  const otra = await createRouteWithAdmins(datosRuta({ nombre: 'Antigua 2', codigo: 'RT-006' }), su, asRouteDb(db), sink)
  await db.clients.add({ id: 'c-x', tenantId: 't-1', routeId: rX.id, nombre: 'Cliente X' })

  const antes = JSON.stringify(await db.clients.toArray())
  const { moved } = await assignRoutesToOffice({ routeIds: [rX.id, otra.id], tenantId: 't-1', officeId: leticia.id }, su, asOfficeDb(db), sink)
  const despues = JSON.stringify(await db.clients.toArray())

  const rutas = await db.routes.toArray()
  metric('rutas movidas', moved.length)
  metric('ahora en Leticia', rutas.filter(r => r.officeId === leticia.id).length)
  metric('clientes intactos', antes === despues)
  assert(moved.length === 2, 'debían moverse las dos rutas')
  assert(rutas.find(r => r.id === rX.id)?.officeId === leticia.id, 'la ruta no se asignó')
  assert(antes === despues, 'asignar la Oficina alteró los clientes')
})

await spec('OFFICE-UNASSIGNED-004', 'Gestión Oficina', 'la asignación masiva es todo-o-nada', async () => {
  const { db, su, leticia, rX, sink } = await empresaConOficinas()
  let error = ''
  try {
    // Una ruta inexistente invalida TODA la operación.
    await assignRoutesToOffice({ routeIds: [rX.id, 'r-inexistente'], tenantId: 't-1', officeId: leticia.id }, su, asOfficeDb(db), sink)
  } catch (e) { error = e instanceof Error ? e.message : String(e) }

  const ruta = await db.routes.get(rX.id) as { officeId?: string }
  metric('resultado', error || 'ACEPTADO — ERROR')
  metric('la ruta válida quedó sin mover', ruta.officeId === undefined)
  assert(!!error, 'una ruta inválida debía abortar la operación')
  assert(ruta.officeId === undefined, 'se movió una ruta pese a fallar la operación: no fue todo-o-nada')
})

await spec('OFFICE-NAV-001', 'Gestión Oficina', 'Oficinas enlaza al panel de cada Oficina y a "Sin Oficina"', () => {
  const lista = readSource('src/pages/admin/OfficesPage.tsx')
  const app = readSource('src/app/App.tsx')
  metric('botón Entrar', lista.includes('/admin/offices/${office.id}'))
  metric('bloque Sin Oficina', lista.includes("navigate('/admin/offices/sin-oficina')"))
  assert(lista.includes('/admin/offices/${office.id}'), 'falta la acción Entrar')
  assert(lista.includes("navigate('/admin/offices/sin-oficina')"), 'falta el acceso a "Sin Oficina"')
  assert(app.includes('offices/:officeId') && app.includes('offices/sin-oficina'), 'faltan las rutas de navegación')
  // La ruta literal debe declararse ANTES del parámetro, o "sin-oficina" se tomaría por un id.
  metric('orden de rutas correcto', app.indexOf('offices/sin-oficina') < app.indexOf('offices/:officeId'))
  assert(app.indexOf('offices/sin-oficina') < app.indexOf('offices/:officeId'),
    '"sin-oficina" debe declararse antes que :officeId')
})

await spec('OFFICE-NAV-002', 'Gestión Oficina', '"Nueva ruta" desde la Oficina reutiliza el formulario existente', () => {
  const detalle = readSource('src/pages/admin/OfficeDetailPage.tsx')
  metric('enlace con preselección', detalle.includes('/admin/routes?nueva=1&officeId=${office.id}'))
  assert(detalle.includes('/admin/routes?nueva=1&officeId=${office.id}'), 'falta el enlace de creación')
  // No debe existir un segundo formulario de ruta.
  metric('crea su propio formulario de ruta', detalle.includes('createRouteWithAdmins('))
  assert(!detalle.includes('createRouteWithAdmins('), 'el panel de Oficina no debe duplicar la creación de rutas')
})

await spec('OFFICE-NAV-003', 'Gestión Oficina', 'los breadcrumbs no alteran el scoping ni son obligatorios', () => {
  const detalle = readSource('src/pages/admin/OfficeDetailPage.tsx')
  const rutas = readSource('src/pages/admin/RoutesPage.tsx')
  metric('breadcrumb presente', detalle.includes('Oficinas</Link>'))
  assert(detalle.includes('Empresa</Link>') && detalle.includes('Oficinas</Link>'), 'faltan los breadcrumbs')
  // El panel carga por el servicio scoped, no por lo que diga la navegación.
  assert(detalle.includes('getOfficeManagementSummary('), 'el panel debe cargar por el servicio con scoping')
  // Y /admin/routes sigue funcionando sin ningún parámetro de Oficina.
  metric('rutas accesible sin parámetros', rutas.includes("if (!nueva && !editar) return"))
  assert(rutas.includes('if (!nueva && !editar) return'),
    'entrar a /admin/routes directamente debe seguir funcionando igual')
})

// ############################################################
// GRUPO — MÚLTIPLES ADMINISTRADORES (servicio real)
// ------------------------------------------------------------
// Una empresa puede tener varios Administradores y una ruta puede tener más de
// uno. Crear un Administrador no le regala rutas, y crear una ruta no reparte esa
// ruta entre todos los Administradores existentes.
// ############################################################

/** Empresa con TRES Administradores (Carlos, Juan, Pedro) y ninguna ruta. */
async function empresaTresAdmins() {
  const { db, su, sink } = await empresaParaOficinas()
  const admins = [
    { id: 'u-carlos', nombre: 'Carlos' },
    { id: 'u-juan', nombre: 'Juan' },
    { id: 'u-pedro', nombre: 'Pedro' },
  ]
  for (const a of admins) {
    await db.users.add({
      id: a.id, tenantId: 't-1', nombre: a.nombre, email: `${a.id}@c.com`, password: 'x',
      rol: 'admin', status: 'activo', createdAt: '', updatedAt: '',
    })
  }
  const traer = async (id: string) => (await db.users.toArray() as User[]).find(u => u.id === id)!
  return { db, su, sink, carlos: await traer('u-carlos'), juan: await traer('u-juan'), pedro: await traer('u-pedro') }
}

await spec('ROUTE-ADMIN-001S', 'Multi-Admin', 'una empresa sostiene varios Administradores a la vez', async () => {
  const { db } = await empresaTresAdmins()
  const admins = (await db.users.toArray() as User[]).filter(u => u.rol === 'admin')
  metric('administradores', admins.map(a => a.nombre).join(', '))
  metric('alguno con officeId', admins.some(a => 'officeId' in (a as unknown as Record<string, unknown>)))
  assert(admins.length === 4, 'deben convivir los tres nuevos más el Admin inicial de la empresa')
  assert(!admins.some(a => 'officeId' in (a as unknown as Record<string, unknown>)),
    'ningún Administrador puede pertenecer a una Oficina')
})

await spec('ROUTE-ADMIN-007S', 'Multi-Admin', 'un Administrador recién creado NO hereda ninguna ruta', async () => {
  const { db, su, sink } = await empresaTresAdmins()
  // La empresa ya tiene rutas cuando aparece el nuevo Administrador.
  await createRouteWithAdmins(datosRuta({ nombre: 'Ruta A', codigo: 'RT-001' }), su, asRouteDb(db), sink)
  await createRouteWithAdmins(datosRuta({ nombre: 'Ruta B', codigo: 'RT-002' }), su, asRouteDb(db), sink)

  await db.users.add({
    id: 'u-nuevo', tenantId: 't-1', nombre: 'Nuevo', email: 'nuevo@c.com', password: 'x',
    rol: 'admin', status: 'activo', createdAt: '', updatedAt: '',
  })
  const nuevo = (await db.users.toArray() as User[]).find(u => u.id === 'u-nuevo')!
  metric('rutas de la empresa', (await db.routes.toArray()).length)
  metric('authorizedRouteIds', JSON.stringify(nuevo.authorizedRouteIds))
  metric('operativo', hasOperationalRoutes(nuevo))
  assert((nuevo.authorizedRouteIds ?? []).length === 0, 'un Admin nuevo no debe heredar rutas')
  assert(!hasOperationalRoutes(nuevo), 'debe quedar sin acceso operativo hasta que se le asigne una ruta')
})

await spec('ROUTE-ADMIN-008S', 'Multi-Admin', 'el Super Admin crea una ruta SIN Administrador y sigue siendo válida', async () => {
  const { db, su, sink } = await empresaTresAdmins()
  const ruta = await createRouteWithAdmins(datosRuta(), su, asRouteDb(db), sink)
  const conLaRuta = (await db.users.toArray() as User[]).filter(u => (u.authorizedRouteIds ?? []).includes(ruta.id))
  metric('usuarios con la ruta', conLaRuta.length)
  metric('estado', ruta.status)
  assert(conLaRuta.length === 0, 'no debe repartirse la ruta a ningún Administrador')
  assert(ruta.status === 'activa', 'una ruta sin Administrador sigue siendo válida')
})

await spec('ROUTE-ADMIN-009S', 'Multi-Admin', 'crear con Carlos y Pedro NO concede la ruta a Juan', async () => {
  const { db, su, carlos, pedro, juan, sink } = await empresaTresAdmins()
  const ruta = await createRouteWithAdmins(
    datosRuta({ adminIds: [carlos.id, pedro.id] }), su, asRouteDb(db), sink,
  )
  const users = await db.users.toArray() as User[]
  const tiene = (id: string) => (users.find(u => u.id === id)?.authorizedRouteIds ?? []).includes(ruta.id)

  metric('Carlos', tiene(carlos.id))
  metric('Pedro', tiene(pedro.id))
  metric('Juan', tiene(juan.id))
  assert(tiene(carlos.id) && tiene(pedro.id), 'los Administradores elegidos deben recibir la ruta')
  assert(!tiene(juan.id), 'un Administrador NO elegido no puede recibir la ruta')
  assert(!canAccessRoute(users.find(u => u.id === juan.id)!, ruta.id), 'Juan no debe acceder a esa ruta')
})

await spec('ROUTE-ADMIN-010S', 'Multi-Admin', 'un Admin que crea una ruta queda autoasignado (protección anti auto-bloqueo)', async () => {
  const { db, carlos, sink } = await empresaTresAdmins()
  const ruta = await createRouteWithAdmins(datosRuta(), carlos, asRouteDb(db), sink)
  const actualizado = (await db.users.toArray() as User[]).find(u => u.id === carlos.id)!
  metric('adminIds enviados', '(vacío)')
  metric('Carlos asignado', (actualizado.authorizedRouteIds ?? []).includes(ruta.id))
  metric('operativo', hasOperationalRoutes(actualizado))
  assert((actualizado.authorizedRouteIds ?? []).includes(ruta.id), 'el Administrador creador quedaría auto-bloqueado')
  assert(hasOperationalRoutes(actualizado), 'debe conservar acceso a la ruta que acaba de crear')
})

await spec('ROUTE-ADMIN-011S', 'Multi-Admin', 'la autoasignación del actor NO arrastra a los demás Administradores', async () => {
  const { db, carlos, juan, pedro, sink } = await empresaTresAdmins()
  const ruta = await createRouteWithAdmins(datosRuta(), carlos, asRouteDb(db), sink)
  const users = await db.users.toArray() as User[]
  const tiene = (id: string) => (users.find(u => u.id === id)?.authorizedRouteIds ?? []).includes(ruta.id)

  metric('Carlos (actor)', tiene(carlos.id))
  metric('Juan', tiene(juan.id))
  metric('Pedro', tiene(pedro.id))
  assert(tiene(carlos.id), 'el actor debe quedar asignado')
  assert(!tiene(juan.id) && !tiene(pedro.id), 'la autoasignación no puede arrastrar a otros Administradores')

  // Y el formulario sigue sin exigir seleccionar Administrador.
  const page = readSource('src/pages/admin/RoutesPage.tsx')
  assert(!page.includes('Selecciona al menos un Administrador responsable.'),
    'la autoasignación debe ser protección interna, no una atadura del formulario')
})

await spec('ROUTE-ADMIN-002S', 'Multi-Admin', 'una misma ruta sostiene DOS Administradores', async () => {
  const { db, su, carlos, juan, sink } = await empresaTresAdmins()
  const ruta = await createRouteWithAdmins(datosRuta({ adminIds: [carlos.id, juan.id] }), su, asRouteDb(db), sink)
  const users = await db.users.toArray() as User[]
  const admins = routeAdmins(users, ruta.id, 't-1')

  metric('administradores de la ruta', admins.map(a => a.nombre).sort().join(', '))
  metric('etiqueta', routeAdminsLabel(admins.map(a => a.nombre).sort()))
  assert(admins.length === 2, 'la ruta debe admitir dos Administradores')
  assert(routeAdminsLabel(admins.map(a => a.nombre).sort()).startsWith('Administradores:'),
    'con varios no puede usarse el singular')
})

await spec('ROUTE-ADMIN-012S', 'Multi-Admin', 'desasignar de una ruta conserva las demás rutas del Administrador', async () => {
  const { db, su, carlos, juan, sink } = await empresaTresAdmins()
  const rA = await createRouteWithAdmins(datosRuta({ adminIds: [carlos.id], nombre: 'Ruta A', codigo: 'RT-001' }), su, asRouteDb(db), sink)
  const rB = await createRouteWithAdmins(datosRuta({ adminIds: [carlos.id], nombre: 'Ruta B', codigo: 'RT-002' }), su, asRouteDb(db), sink)
  const rX = await createRouteWithAdmins(datosRuta({ adminIds: [carlos.id, juan.id], nombre: 'Ruta X', codigo: 'RT-003' }), su, asRouteDb(db), sink)

  // Se edita Ruta X y se desasigna a Carlos (Juan sigue): el guardado real.
  await updateRouteWithAssignments({
    routeId: rX.id, tenantId: 't-1', nombre: 'Ruta X', ciudad: undefined,
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000,
    cobradorId: undefined,
    assignedUserIds: [juan.id],
    assignableUserIds: [carlos.id, juan.id],
  }, su, asRouteDb(db), sink)

  const users = await db.users.toArray() as User[]
  const carlosFinal = users.find(u => u.id === carlos.id)!
  const rutasDeCarlos = carlosFinal.authorizedRouteIds ?? []

  metric('rutas de Carlos', rutasDeCarlos.length)
  metric('conserva A y B', rutasDeCarlos.includes(rA.id) && rutasDeCarlos.includes(rB.id))
  metric('Juan sigue en X', routeAdmins(users, rX.id, 't-1').map(a => a.id).includes(juan.id))
  assert(!rutasDeCarlos.includes(rX.id), 'Carlos debía salir de Ruta X')
  assert(rutasDeCarlos.includes(rA.id) && rutasDeCarlos.includes(rB.id), 'SE PERDIERON las otras rutas de Carlos')
  assert(routeAdmins(users, rX.id, 't-1').length === 1, 'Juan debe seguir siendo Administrador de Ruta X')
})

await spec('ROUTE-ADMIN-014S', 'Multi-Admin', 'el panel de Oficina muestra los DOS Administradores de una ruta', async () => {
  const { db, su, carlos, juan, sink } = await empresaTresAdmins()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(
    datosRuta({ officeId: office.id, adminIds: [carlos.id, juan.id] }), su, asRouteDb(db), sink,
  )
  const resumen = await getOfficeManagementSummary({ user: su, tenantId: 't-1', officeId: office.id }, asSummaryDb(db))
  const relacionados = resumen!.relatedUsers.filter(u => u.routes.some(r => r.id === ruta.id))

  metric('relacionados con la ruta', relacionados.map(u => u.nombre).sort().join(', '))
  assert(relacionados.length === 2, 'el panel debe mostrar ambos Administradores')
  assert(relacionados.every(u => u.rol === 'admin'), 'ambos deben figurar con su rol')
})

await spec('ROUTE-ADMIN-015S', 'Multi-Admin', 'gestionar Oficinas no concede rutas a ningún Administrador', async () => {
  const { db, su, carlos, juan, sink } = await empresaTresAdmins()
  const office = await createOffice({ tenantId: 't-1', nombre: 'Leticia' }, su, asOfficeDb(db), sink)
  const ruta = await createRouteWithAdmins(datosRuta({ officeId: office.id, adminIds: [carlos.id] }), su, asRouteDb(db), sink)

  const juanFinal = (await db.users.toArray() as User[]).find(u => u.id === juan.id)!
  const resumenDeJuan = await getOfficeManagementSummary({ user: juanFinal, tenantId: 't-1', officeId: office.id }, asSummaryDb(db))

  metric('Juan gestiona Oficinas', can(juanFinal, 'office.edit', { tenantId: 't-1' }))
  metric('rutas que ve Juan en Leticia', resumenDeJuan!.accessibleOfficeRoutes.length)
  metric('accede a la ruta', canAccessRoute(juanFinal, ruta.id))
  assert(can(juanFinal, 'office.edit', { tenantId: 't-1' }), 'un Admin debe poder gestionar el catálogo')
  assert(resumenDeJuan!.accessibleOfficeRoutes.length === 0, 'gestionar la Oficina no puede mostrarle rutas ajenas')
  assert(!canAccessRoute(juanFinal, ruta.id), 'gestionar la Oficina no puede concederle la ruta')
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
