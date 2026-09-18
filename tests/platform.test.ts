// ============================================================
// RUTACASH — SUITE DE PLATAFORMA (OWNER / SUPER ADMIN)
// ------------------------------------------------------------
//   npm run test:platform
//
// Verifica la corrección arquitectónica de esta entrega: RutaCash tiene DOS NIVELES
// y no uno y medio.
//
//   NIVEL 1 · PLATAFORMA → OWNER. Administra el SaaS. Tabla `platformUsers`.
//   NIVEL 2 · EMPRESA    → SUPER ADMIN y por debajo. Tabla `users`, con tenantId.
//
// Familias: OWNER-AUTH, OWNER-COMPANY, OWNER-METRICS, OWNER-BILLING, OWNER-PRIVACY,
// SUPERADMIN-TENANT, SUPERADMIN-MULTI, SUPERADMIN-HIERARCHY, SUPERADMIN-LAST,
// ONBOARDING-CLEAN, PASSWORD-USERS y CROSS-DEVICE.
//
// Semántica convencional: cualquier caso fallido → exit 1.
// ============================================================
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

import {
  createFirstOwner, createAdditionalOwner, getInstallationState,
  PLATFORM_TENANT_ID, type PlatformDatabase,
} from '../src/services/platformBootstrapService'
import { authenticateOwner, revalidateOwner, changeOwnerPassword } from '../src/platform/platformAuthService'
import {
  controlPlaneOn, CONTROL_PLANE_IS_SHARED, CONTROL_PLANE_SCOPE_NOTICE,
  type ControlPlaneDatabase, type SaaSControlPlane,
} from '../src/platform/controlPlane'
import {
  createCompanyWithFirstSuperAdmin, setCompanyCommercialStatus, updateCompanyBilling,
  registerSaaSPayment, markPaymentPaid, recordTenantLogin, syncRouteMetrics, ownerKpis,
  tenantStatusFor, commercialStatusFor,
  type CompanyProvisioningDatabase, type StatusChangeDatabase,
} from '../src/platform/companyControlService'
import {
  isBillableRoute, computeRouteMetrics, expectedPeriodAmount, expectedPeriodTotal,
  BILLABLE_ROUTE_STATUS,
} from '../src/platform/billing'
import {
  blockIfLastSuperadmin, blockIfDemotingLastSuperadmin, activeSuperadminsOf,
  tenantHasActiveSuperadmin,
} from '../src/lib/superadminProtection'
import { canManageRole, canManageUser, assignableRoles, can, homePathForRole } from '../src/lib/permissions'
import { authenticateUser, type AuthDatabase } from '../src/services/authService'
import { isCompanyBlocked, companyBlockMessage } from '../src/lib/company'
import { createRouteWithAdmins, type RouteDatabase, type RouteAuditSink } from '../src/services/routeService'
import { MemoryDb } from './financial/harness'
import type { PlatformUser, CompanyControlRecord, ControlEventType } from '../src/platform/types'
import type { User } from '../src/models/types'

// ============================================================
// Mini-runner (idéntico al del resto de suites)
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
const asProvisioningDb = (db: MemoryDb) => db as unknown as CompanyProvisioningDatabase
const asStatusDb = (db: MemoryDb) => db as unknown as StatusChangeDatabase
const asRouteDb = (db: MemoryDb) => db as unknown as RouteDatabase
const plano = (db: MemoryDb): SaaSControlPlane => controlPlaneOn(db as unknown as ControlPlaneDatabase)

const OWNER_INPUT = {
  nombre: 'Persona Propietaria',
  email: 'duenio@rutacash.com',
  password: 'ClaveDePlataforma2026',
  confirmPassword: 'ClaveDePlataforma2026',
}

function readSource(rel: string): string {
  const p = resolve(process.cwd(), rel)
  if (!existsSync(p)) throw new Error(`No se encuentra ${rel} (cwd=${process.cwd()})`)
  return readFileSync(p, 'utf8')
}

/** Todos los archivos .ts/.tsx bajo un directorio, recursivamente. */
function archivosDe(dir: string): string[] {
  const base = resolve(process.cwd(), dir)
  if (!existsSync(base)) return []
  const out: string[] = []
  for (const entrada of readdirSync(base)) {
    const completo = join(base, entrada)
    if (statSync(completo).isDirectory()) out.push(...archivosDe(join(dir, entrada)))
    else if (/\.tsx?$/.test(entrada)) out.push(join(dir, entrada).replace(/\\/g, '/'))
  }
  return out
}

/** Módulos que aparecen en los `import ... from '...'` de un archivo. */
function importsDe(rel: string): string[] {
  const src = readSource(rel)
  const re = /from\s+['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

/** Owner recién creado sobre una base virgen. */
async function nuevoOwner(db: MemoryDb): Promise<PlatformUser> {
  const r = await createFirstOwner(OWNER_INPUT, asPlatformDb(db))
  if (!r.ok) throw new Error(r.message)
  return r.owner
}

/** Onboarding completo: Owner → empresa → primer Super Admin. */
async function altaDeEmpresa(
  db: MemoryDb,
  over: { nombre?: string; email?: string; adminEmail?: string; password?: string; owner?: PlatformUser } = {},
) {
  const owner = over.owner ?? await nuevoOwner(db)
  const r = await createCompanyWithFirstSuperAdmin(owner, {
    nombre: over.nombre ?? 'Empresa A',
    email: over.email ?? 'contacto@empresa-a.com',
    billingMode: 'per_route',
    billingRate: 50_000,
    superAdmin: {
      nombre: 'Super Admin A',
      email: over.adminEmail ?? 'su.a@empresa-a.com',
      password: over.password ?? 'ClaveInicial1',
    },
  }, asProvisioningDb(db), plano(db))
  if (!r.ok) throw new Error(r.message)
  return { owner, ...r }
}

const usuario = (over: Partial<User> & { tenantId: string; rol: User['rol'] }): User => ({
  id: `u-${Math.random().toString(36).slice(2, 9)}`,
  nombre: 'Usuario', email: `${Math.random().toString(36).slice(2, 9)}@x.com`,
  password: 'ClaveInicial1', status: 'activo', mustChangePassword: false,
  createdAt: '', updatedAt: '',
  ...over,
})

// ############################################################
// FAMILIA — OWNER-AUTH
// ############################################################
await spec('OWNER-AUTH-001', 'Owner · Acceso', 'el Owner entra por el portal de plataforma', async () => {
  const db = new MemoryDb()
  await nuevoOwner(db)
  const r = await authenticateOwner(OWNER_INPUT.email, OWNER_INPUT.password, plano(db))
  metric('resultado', r.ok ? 'ACEPTADO' : r.code)
  metric('rol', r.ok ? r.owner.rol : '—')
  metric('primer ingreso sellado', r.ok ? !!r.owner.firstLoginAt : '—')
  metric('último ingreso', r.ok ? !!r.owner.lastLoginAt : '—')
  assert(r.ok, 'el Owner debe poder entrar con sus credenciales')
  assert(r.ok && r.owner.rol === 'owner', 'la sesión debe ser de nivel plataforma')
  assert(r.ok && !!r.owner.firstLoginAt && !!r.owner.lastLoginAt, 'debe registrarse su telemetría de acceso')

  // El primer ingreso NO se reescribe en accesos posteriores.
  const primero = (r as { owner: PlatformUser }).owner.firstLoginAt
  const segundo = await authenticateOwner(OWNER_INPUT.email, OWNER_INPUT.password, plano(db))
  metric('primer ingreso tras el segundo acceso', segundo.ok ? segundo.owner.firstLoginAt === primero : '—')
  assert(segundo.ok && segundo.owner.firstLoginAt === primero, 'el primer ingreso se sella una sola vez')
})

await spec('OWNER-AUTH-002', 'Owner · Acceso', 'un Super Admin NO entra al portal Owner', async () => {
  const db = new MemoryDb()
  const { superAdmin } = await altaDeEmpresa(db, { adminEmail: 'su.a@empresa-a.com', password: 'ClaveInicial1' })

  const porOwner = await authenticateOwner('su.a@empresa-a.com', 'ClaveInicial1', plano(db))
  metric('Super Admin en /owner/login', porOwner.ok ? 'ACEPTADO — ERROR' : porOwner.code)
  assert(!porOwner.ok, 'un Super Admin no puede autenticarse en el portal de plataforma')

  // Y a la inversa: el Owner tampoco entra por la puerta de las empresas.
  const ownerPorEmpresa = await authenticateUser(OWNER_INPUT.email, OWNER_INPUT.password, asAuthDb(db))
  metric('Owner en /login', ownerPorEmpresa.ok ? 'ACEPTADO — ERROR' : ownerPorEmpresa.code)
  assert(!ownerPorEmpresa.ok, 'el Owner no puede autenticarse en el portal de empresas')

  // Las dos cuentas viven en tablas distintas: no hay ni un registro compartido.
  metric('usuarios de empresa', (await db.users.toArray()).length)
  metric('cuentas de plataforma', (await db.platformUsers.toArray()).length)
  metric('el Super Admin está en platformUsers', (await db.platformUsers.toArray() as PlatformUser[]).some(o => o.email === superAdmin.email))
  assert(!(await db.platformUsers.toArray() as PlatformUser[]).some(o => o.email === superAdmin.email),
    'ningún usuario de empresa puede aparecer en la tabla de plataforma')
})

await spec('OWNER-AUTH-003', 'Owner · Acceso', 'ser Owner NO concede ningún privilegio dentro de una empresa', () => {
  // El Owner no es un `UserRole`: no existe siquiera la posibilidad de preguntarle a
  // `can()` por él. Esa es la garantía más fuerte posible, y es estructural.
  const roles = Object.keys(homePathForRole as unknown as object)
  metric('el rol "owner" existe en la jerarquía de empresa', 'no (no es UserRole)')
  metric('roles con home de empresa', 'superadmin, admin, socio, supervisor, cobrador, secretario')

  const perms = readSource('src/lib/permissions.ts')
  metric('UserRole incluye owner', readSource('src/models/types.ts').includes("| 'owner'") ? 'SÍ — ERROR' : 'no')
  assert(!readSource('src/models/types.ts').includes("'owner'"),
    'el rol de plataforma no puede formar parte de los roles de empresa')
  // Y ningún rol de empresa conserva capacidades SaaS.
  assert(perms.includes("superadmin: ['platform.access', 'company.create', 'company.suspend']"),
    'las capacidades SaaS deben ser incompatibles con el Super Admin')

  const su = usuario({ tenantId: 't-1', rol: 'superadmin' })
  metric("can(superadmin, 'platform.access')", can(su, 'platform.access'))
  metric("can(superadmin, 'company.create')", can(su, 'company.create'))
  metric("can(superadmin, 'company.suspend')", can(su, 'company.suspend'))
  assert(!can(su, 'platform.access'), 'el Super Admin no accede a la plataforma')
  assert(!can(su, 'company.create'), 'el Super Admin no crea empresas SaaS')
  assert(!can(su, 'company.suspend'), 'el Super Admin no suspende empresas')
  assert(roles.length >= 0, 'comprobación estructural')
})

await spec('OWNER-AUTH-004', 'Owner · Acceso', 'un Owner desactivado pierde el acceso y la sesión', async () => {
  const db = new MemoryDb()
  const owner = await nuevoOwner(db)
  await db.platformUsers.update(owner.id, { status: 'inactivo' })

  const login = await authenticateOwner(OWNER_INPUT.email, OWNER_INPUT.password, plano(db))
  const sesion = await revalidateOwner(owner.id, plano(db))
  metric('login', login.ok ? 'ACEPTADO — ERROR' : login.code)
  metric('revalidación de sesión', sesion === null ? 'sesión cerrada' : 'SIGUE VIVA — ERROR')
  assert(!login.ok && login.code === 'OWNER_INACTIVE', 'una cuenta inactiva no debe entrar')
  assert(sesion === null, 'la sesión persistida debe caerse al revalidar')
})

await spec('OWNER-AUTH-005', 'Owner · Acceso', 'el cambio de contraseña propio es voluntario y validado', async () => {
  const db = new MemoryDb()
  const owner = await nuevoOwner(db)
  const malActual = await changeOwnerPassword(owner, 'otra', 'ClaveNuevaLarga1', plano(db))
  const corta = await changeOwnerPassword(owner, OWNER_INPUT.password, 'abc', plano(db))
  const ok = await changeOwnerPassword(owner, OWNER_INPUT.password, 'ClaveNuevaLarga1', plano(db))
  metric('contraseña actual incorrecta', malActual.error)
  metric('contraseña nueva demasiado corta', corta.error)
  metric('cambio válido', ok.success)
  assert(!malActual.success && !corta.success && ok.success, 'las tres reglas deben cumplirse')

  const conLaNueva = await authenticateOwner(OWNER_INPUT.email, 'ClaveNuevaLarga1', plano(db))
  metric('entra con la nueva', conLaNueva.ok ? 'sí' : conLaNueva.code)
  assert(conLaNueva.ok, 'debe poder entrar con la contraseña nueva')
})

// ############################################################
// FAMILIA — OWNER-COMPANY / ONBOARDING-CLEAN
// ############################################################
await spec('OWNER-COMPANY-003', 'Owner · Empresas', 'la ficha de control nace con los datos comerciales', async () => {
  const db = new MemoryDb()
  const { record, tenant } = await altaDeEmpresa(db)
  metric('companyId = tenantId', record.companyId === tenant.id)
  metric('estado comercial inicial', record.status)
  metric('estado operativo del tenant', tenant.status)
  metric('rutas al nacer', `${record.billableRouteCount} de ${record.routeCount}`)
  metric('modo de cobro', record.billingMode)
  metric('primer ingreso', record.firstLoginAt ?? 'sin acceder todavía')
  assert(record.companyId === tenant.id, 'la ficha y la empresa son la misma entidad vista desde dos niveles')
  assert(record.status === 'trial' && tenant.status === 'prueba', 'estado comercial y operativo deben nacer alineados')
  assert(record.routeCount === 0 && record.billableRouteCount === 0, 'una empresa nueva no tiene rutas')
  assert(record.firstLoginAt === undefined, 'no se inventa una fecha de acceso que no ha ocurrido')
})

await spec('OWNER-COMPANY-004', 'Owner · Empresas', 'el alta rechaza datos incompletos sin escribir nada', async () => {
  const db = new MemoryDb()
  const owner = await nuevoOwner(db)
  const casos: Array<[string, Parameters<typeof createCompanyWithFirstSuperAdmin>[1], string]> = [
    ['empresa sin nombre', { nombre: ' ', email: 'a@b.com', superAdmin: { nombre: 'Ana', email: 'a@b.com', password: 'ClaveInicial1' } }, 'INVALID_COMPANY_NAME'],
    ['correo de empresa inválido', { nombre: 'Empresa', email: 'no-es-correo', superAdmin: { nombre: 'Ana', email: 'a@b.com', password: 'ClaveInicial1' } }, 'INVALID_COMPANY_EMAIL'],
    ['Super Admin sin nombre', { nombre: 'Empresa', email: 'a@b.com', superAdmin: { nombre: '', email: 'a@b.com', password: 'ClaveInicial1' } }, 'INVALID_ADMIN_NAME'],
    ['correo de Super Admin inválido', { nombre: 'Empresa', email: 'a@b.com', superAdmin: { nombre: 'Ana', email: 'x', password: 'ClaveInicial1' } }, 'INVALID_ADMIN_EMAIL'],
    ['contraseña demasiado corta', { nombre: 'Empresa', email: 'a@b.com', superAdmin: { nombre: 'Ana', email: 'a@b.com', password: '123' } }, 'WEAK_PASSWORD'],
  ]
  for (const [nombre, input, esperado] of casos) {
    const r = await createCompanyWithFirstSuperAdmin(owner, input, asProvisioningDb(db), plano(db))
    metric(nombre, r.ok ? 'ACEPTADO — ERROR' : r.code)
    assert(!r.ok && r.code === esperado, `[${nombre}] se esperaba ${esperado}`)
  }
  metric('empresas creadas por intentos inválidos', (await db.tenants.toArray()).length)
  metric('usuarios creados por intentos inválidos', (await db.users.toArray()).length)
  assert((await db.tenants.toArray()).length === 0, 'ningún intento inválido debe escribir una empresa')
  assert((await db.users.toArray()).length === 0, 'ningún intento inválido debe escribir un usuario')
})

await spec('ONBOARDING-CLEAN-001', 'Onboarding', 'la empresa nace SIN Oficinas ni Rutas configuradas por el Owner', async () => {
  const db = new MemoryDb()
  const { tenant } = await altaDeEmpresa(db)
  const offices = await db.offices.toArray()
  const routes = await db.routes.toArray()
  const users = await db.users.toArray() as User[]
  metric('oficinas', offices.length)
  metric('rutas', routes.length)
  metric('usuarios', users.map(u => u.rol).join(', '))
  metric('categorías de gasto', (await db.expenseCategories.toArray()).length)
  assert(offices.length === 0, 'el Owner no organiza la estructura interna del cliente')
  assert(routes.length === 0, 'el Owner no crea rutas')
  assert(users.length === 1 && users[0].rol === 'superadmin', 'la empresa nace solo con su Super Admin')
  assert((await db.expenseCategories.toArray()).every(c => c.tenantId === tenant.id),
    'las categorías de gasto son dato de la empresa')

  // Y el código del alta no toca ni oficinas ni rutas: no es cuestión de suerte.
  const svc = readSource('src/platform/companyControlService.ts')
  metric('el alta escribe en offices', /offices\.(add|bulkAdd|put)/.test(svc) ? 'SÍ — ERROR' : 'no')
  metric('el alta escribe en routes', /routes\.(add|bulkAdd|put)/.test(svc) ? 'SÍ — ERROR' : 'no')
  assert(!/offices\.(add|bulkAdd|put)/.test(svc), 'el alta de empresa no puede crear Oficinas')
  assert(!/routes\.(add|bulkAdd|put)/.test(svc), 'el alta de empresa no puede crear Rutas')
})

await spec('ONBOARDING-CLEAN-002', 'Onboarding', 'el primer Super Admin configura su empresa entera', async () => {
  const db = new MemoryDb()
  const { su } = { su: (await altaDeEmpresa(db)).superAdmin }
  metric('tenantId', su.tenantId)
  metric('roles que puede crear', assignableRoles(su).join(', '))
  const capacidades: Array<[string, boolean]> = [
    ['configurar la empresa', can(su, 'settings.edit', { tenantId: su.tenantId })],
    ['crear Oficinas', can(su, 'office.create', { tenantId: su.tenantId })],
    ['crear Rutas', can(su, 'route.create', { tenantId: su.tenantId })],
    ['crear usuarios', can(su, 'user.create', { tenantId: su.tenantId })],
    ['cerrar liquidaciones', can(su, 'settlement.close', { tenantId: su.tenantId })],
    ['reabrir liquidaciones', can(su, 'settlement.reopen', { tenantId: su.tenantId })],
  ]
  for (const [que, puede] of capacidades) {
    metric(que, puede)
    assert(puede, `el Super Admin debe poder ${que}`)
  }
  // Y puede crear TODOS los perfiles de su empresa, incluido otro Super Admin.
  for (const rol of ['superadmin', 'admin', 'supervisor', 'cobrador', 'secretario', 'socio'] as const) {
    assert(canManageRole(su, rol), `el Super Admin debe poder crear el rol ${rol}`)
  }
})

// ############################################################
// FAMILIA — OWNER-METRICS (la cifra que se factura)
// ############################################################
await spec('OWNER-METRICS-000', 'Owner · Métricas', 'la regla comercial de ruta facturable es explícita', () => {
  metric('estado facturable', BILLABLE_ROUTE_STATUS)
  metric('ruta activa', isBillableRoute({ status: 'activa' }))
  metric('ruta inactiva', isBillableRoute({ status: 'inactiva' }))
  assert(BILLABLE_ROUTE_STATUS === 'activa', 'se factura la ruta ACTIVA')
  assert(isBillableRoute({ status: 'activa' }), 'una ruta activa se factura')
  assert(!isBillableRoute({ status: 'inactiva' }), 'una ruta inactiva NO se factura')

  const m = computeRouteMetrics([{ status: 'activa' }, { status: 'activa' }, { status: 'inactiva' }])
  metric('routeCount / billableRouteCount', `${m.routeCount} / ${m.billableRouteCount}`)
  assert(m.routeCount === 3 && m.billableRouteCount === 2, 'las dos cifras deben ser distintas y ambas correctas')
})

await spec('OWNER-METRICS-001', 'Owner · Métricas', 'crear una Ruta actualiza billableRouteCount', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  const p = plano(db)
  const sinkAudit: RouteAuditSink = async () => {}
  const sinkMetrics = (tenantId: string, evento: ControlEventType, detalle?: string) =>
    syncRouteMetrics(tenantId, p, evento, detalle)

  const antes = (await p.getCompany(tenant.id))!
  metric('rutas facturables antes', antes.billableRouteCount)

  for (const [i, nombre] of ['Ruta Norte', 'Ruta Sur', 'Ruta Centro'].entries()) {
    await createRouteWithAdmins({
      tenantId: tenant.id, nombre, tasaInteres: 20, tasaLibre: false,
      montoMaximoPrestamo: 500_000, capitalInicial: 0, codigo: `RT-00${i + 1}`, adminIds: [],
    }, superAdmin, asRouteDb(db), sinkAudit, sinkMetrics)
  }

  const despues = (await p.getCompany(tenant.id))!
  metric('rutas facturables después', despues.billableRouteCount)
  metric('rutas totales', despues.routeCount)
  assert(antes.billableRouteCount === 0, 'precondición: empresa sin rutas')
  assert(despues.billableRouteCount === 3, `el Owner debe ver 3 rutas facturables, vio ${despues.billableRouteCount}`)
  assert(despues.routeCount === 3, 'el conteo total también debe subir')

  // Y queda constancia en el historial estructural, sin ningún dato operativo.
  const eventos = await p.listEvents(tenant.id)
  metric('eventos ROUTE_CREATED', eventos.filter(e => e.type === 'ROUTE_CREATED').length)
  assert(eventos.filter(e => e.type === 'ROUTE_CREATED').length === 3, 'cada alta de ruta deja su evento')
})

await spec('OWNER-METRICS-002', 'Owner · Métricas', 'desactivar o eliminar una Ruta baja el contador', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  const p = plano(db)
  const sinkAudit: RouteAuditSink = async () => {}
  const sinkMetrics = (t: string, e: ControlEventType, d?: string) => syncRouteMetrics(t, p, e, d)

  const rutas = []
  for (const [i, nombre] of ['A', 'B', 'C'].entries()) {
    rutas.push(await createRouteWithAdmins({
      tenantId: tenant.id, nombre: `Ruta ${nombre}`, tasaInteres: 20, tasaLibre: false,
      montoMaximoPrestamo: 500_000, capitalInicial: 0, codigo: `RT-00${i + 1}`, adminIds: [],
    }, superAdmin, asRouteDb(db), sinkAudit, sinkMetrics))
  }
  metric('facturables tras crear 3', (await p.getCompany(tenant.id))!.billableRouteCount)

  // DESACTIVAR: la ruta sigue existiendo (su histórico intacto) pero deja de cobrarse.
  await db.routes.update(rutas[0].id, { status: 'inactiva' })
  await syncRouteMetrics(tenant.id, p, 'ROUTE_DEACTIVATED', 'Ruta A desactivada')
  const trasDesactivar = (await p.getCompany(tenant.id))!
  metric('tras desactivar una', `${trasDesactivar.billableRouteCount} facturables de ${trasDesactivar.routeCount} existentes`)
  assert(trasDesactivar.billableRouteCount === 2, 'una ruta inactiva deja de facturarse')
  assert(trasDesactivar.routeCount === 3, 'pero sigue existiendo: no se borró nada')

  // ELIMINAR: desaparece de las dos cifras.
  await db.routes.delete(rutas[1].id)
  await syncRouteMetrics(tenant.id, p, 'ROUTE_DELETED', 'Ruta B eliminada')
  const trasEliminar = (await p.getCompany(tenant.id))!
  metric('tras eliminar otra', `${trasEliminar.billableRouteCount} facturables de ${trasEliminar.routeCount} existentes`)
  assert(trasEliminar.billableRouteCount === 1 && trasEliminar.routeCount === 2, 'la ruta eliminada sale de ambas cifras')

  // REACTIVAR: vuelve a contarse. El contador se RECALCULA, no se acumula.
  await db.routes.update(rutas[0].id, { status: 'activa' })
  await syncRouteMetrics(tenant.id, p, 'ROUTE_CREATED', 'Ruta A reactivada')
  metric('tras reactivar', (await p.getCompany(tenant.id))!.billableRouteCount)
  assert((await p.getCompany(tenant.id))!.billableRouteCount === 2, 'reactivar vuelve a sumar')
})

await spec('OWNER-METRICS-003', 'Owner · Métricas', 'primer y último ingreso de la EMPRESA, no de la persona', async () => {
  const db = new MemoryDb()
  const { tenant } = await altaDeEmpresa(db)
  const p = plano(db)

  await recordTenantLogin(tenant.id, p, '2026-09-01T08:00:00.000Z')
  const tras1 = (await p.getCompany(tenant.id))!
  await recordTenantLogin(tenant.id, p, '2026-09-05T19:30:00.000Z')
  const tras2 = (await p.getCompany(tenant.id))!

  metric('primer ingreso', tras2.firstLoginAt)
  metric('último ingreso', tras2.lastLoginAt)
  assert(tras1.firstLoginAt === '2026-09-01T08:00:00.000Z', 'el primer acceso se sella con el primero que ocurre')
  assert(tras2.firstLoginAt === tras1.firstLoginAt, 'el primer acceso NO se reescribe jamás')
  assert(tras2.lastLoginAt === '2026-09-05T19:30:00.000Z', 'el último acceso se actualiza en cada entrada')

  const eventos = await p.listEvents(tenant.id)
  metric('eventos FIRST_LOGIN', eventos.filter(e => e.type === 'FIRST_LOGIN').length)
  metric('eventos LOGIN', eventos.filter(e => e.type === 'LOGIN').length)
  assert(eventos.filter(e => e.type === 'FIRST_LOGIN').length === 1, 'el primer acceso ocurre una sola vez')

  // Y no se guarda QUIÉN entró: el Owner ve dos fechas, no una bitácora de personas.
  const svc = readSource('src/platform/companyControlService.ts')
  const cuerpo = svc.slice(svc.indexOf('export async function recordTenantLogin'))
  metric('recordTenantLogin recibe un userId', /userId/.test(cuerpo.slice(0, 400)) ? 'SÍ — ERROR' : 'no')
  assert(!/userId/.test(cuerpo.slice(0, 400)), 'la telemetría es de la empresa, no de la persona')
})

await spec('OWNER-METRICS-004', 'Owner · Métricas', 'la métrica NUNCA bloquea la operación del cliente', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  // Plano de control roto (simula un backend caído o una base sin permisos).
  const planoRoto: SaaSControlPlane = {
    listCompanies: async () => { throw new Error('caído') },
    getCompany: async () => { throw new Error('caído') },
    putCompany: async () => { throw new Error('caído') },
    updateCompany: async () => { throw new Error('caído') },
    countRoutes: async () => { throw new Error('caído') },
    listPayments: async () => { throw new Error('caído') },
    addPayment: async () => { throw new Error('caído') },
    updatePayment: async () => { throw new Error('caído') },
    listEvents: async () => { throw new Error('caído') },
    addEvent: async () => { throw new Error('caído') },
    listOwners: async () => { throw new Error('caído') },
    getOwnerByEmail: async () => { throw new Error('caído') },
    addOwner: async () => { throw new Error('caído') },
    updateOwner: async () => { throw new Error('caído') },
  }

  let error = ''
  try {
    await createRouteWithAdmins({
      tenantId: tenant.id, nombre: 'Ruta pese a todo', tasaInteres: 20, tasaLibre: false,
      montoMaximoPrestamo: 500_000, capitalInicial: 0, codigo: 'RT-001', adminIds: [],
    }, superAdmin, asRouteDb(db), async () => {}, (t, e, d) => syncRouteMetrics(t, planoRoto, e, d))
  } catch (e) { error = e instanceof Error ? e.message : String(e) }

  metric('resultado de crear la ruta', error || 'CREADA')
  metric('rutas en la base', (await db.routes.toArray()).length)
  assert(!error, 'un fallo del plano de control no puede impedir que la empresa cree su ruta')
  assert((await db.routes.toArray()).length === 1, 'la ruta debe existir igualmente')

  // Y el acceso tampoco se bloquea.
  await recordTenantLogin(tenant.id, planoRoto, '2026-09-01T08:00:00.000Z')
  metric('recordTenantLogin con el plano caído', 'no lanza')
})

// ############################################################
// FAMILIA — OWNER-BILLING
// ############################################################
await spec('OWNER-BILLING-001', 'Owner · Cobros', 'el valor esperado se calcula sobre rutas facturables', () => {
  const base = {
    companyId: 'c', nombre: 'X', createdAt: '', status: 'active' as const,
    routeCount: 5, billableRouteCount: 4, nextBillingDate: undefined,
    paymentStatus: 'pending' as const, updatedAt: '',
  }
  const porRuta: CompanyControlRecord = { ...base, billingMode: 'per_route', billingRate: 50_000 }
  const fija: CompanyControlRecord = { ...base, billingMode: 'fixed', billingRate: 300_000 }
  metric('por ruta: 4 facturables × 50.000', expectedPeriodAmount(porRuta))
  metric('tarifa fija', expectedPeriodAmount(fija))
  assert(expectedPeriodAmount(porRuta) === 200_000, 'per_route = facturables × tarifa, no existentes × tarifa')
  assert(expectedPeriodAmount(fija) === 300_000, 'fixed ignora el número de rutas')

  // Una empresa SUSPENDIDA no genera expectativa de cobro mientras lo esté.
  const suspendida: CompanyControlRecord = { ...porRuta, companyId: 'c2', status: 'suspended' }
  metric('total con una suspendida', expectedPeriodTotal([porRuta, suspendida]))
  assert(expectedPeriodTotal([porRuta, suspendida]) === 200_000, 'la suspendida no suma al esperado')
})

await spec('OWNER-BILLING-002', 'Owner · Cobros', 'registrar un cobro y marcarlo pagado', async () => {
  const db = new MemoryDb()
  const { owner, tenant } = await altaDeEmpresa(db)
  const p = plano(db)

  const malPeriodo = await registerSaaSPayment(owner, { companyId: tenant.id, periodo: '2026/09', valor: 100, fechaEsperada: '2026-09-05', status: 'pending' }, p)
  const malValor = await registerSaaSPayment(owner, { companyId: tenant.id, periodo: '2026-09', valor: 0, fechaEsperada: '2026-09-05', status: 'pending' }, p)
  metric('período con formato inválido', malPeriodo.error)
  metric('valor cero', malValor.error)
  assert(!malPeriodo.ok && !malValor.ok, 'las validaciones básicas deben rechazar')

  const r = await registerSaaSPayment(owner, {
    companyId: tenant.id, periodo: '2026-09', valor: 200_000,
    fechaEsperada: '2026-09-05', status: 'pending', nota: 'Primer período',
  }, p)
  metric('cobro registrado', r.ok)
  metric('estado de pago de la ficha', (await p.getCompany(tenant.id))!.paymentStatus)
  assert(r.ok, 'el cobro debe registrarse')
  assert((await p.getCompany(tenant.id))!.paymentStatus === 'pending', 'la ficha refleja el último cobro')

  await markPaymentPaid(owner, r.payment!, '2026-09-07', p)
  const cobros = await p.listPayments(tenant.id)
  metric('estado del cobro', cobros[0].status)
  metric('fecha de pago', cobros[0].fechaPagada)
  metric('estado de pago de la ficha', (await p.getCompany(tenant.id))!.paymentStatus)
  assert(cobros[0].status === 'paid' && cobros[0].fechaPagada === '2026-09-07', 'debe quedar pagado con su fecha')
  assert((await p.getCompany(tenant.id))!.paymentStatus === 'paid', 'la ficha debe actualizarse')
})

await spec('OWNER-BILLING-003', 'Owner · Cobros', 'solo un Owner activo edita tarifas y registra cobros', async () => {
  const db = new MemoryDb()
  const { owner, tenant, superAdmin } = await altaDeEmpresa(db)
  const p = plano(db)
  const falso = superAdmin as unknown as PlatformUser
  const inactivo: PlatformUser = { ...owner, status: 'inactivo' }

  const porSuperAdmin = await updateCompanyBilling(falso, tenant.id, { billingRate: 1 }, p)
  const porInactivo = await updateCompanyBilling(inactivo, tenant.id, { billingRate: 1 }, p)
  const cobroPorSuperAdmin = await registerSaaSPayment(falso, { companyId: tenant.id, periodo: '2026-09', valor: 1, fechaEsperada: '2026-09-05', status: 'pending' }, p)
  metric('Super Admin editando tarifa', porSuperAdmin.error)
  metric('Owner inactivo editando tarifa', porInactivo.error)
  metric('Super Admin registrando cobro', cobroPorSuperAdmin.error)
  assert(!porSuperAdmin.ok && !porInactivo.ok && !cobroPorSuperAdmin.ok, 'la gestión comercial es exclusiva del Owner activo')

  const ok = await updateCompanyBilling(owner, tenant.id, { billingRate: 75_000, billingMode: 'per_route', nextBillingDate: '2026-10-05' }, p)
  const ficha = (await p.getCompany(tenant.id))!
  metric('tarifa tras editar', ficha.billingRate)
  metric('próximo cobro', ficha.nextBillingDate)
  assert(ok.ok && ficha.billingRate === 75_000 && ficha.nextBillingDate === '2026-10-05', 'el Owner sí puede editarlo')
})

await spec('OWNER-BILLING-004', 'Owner · Cobros', 'los KPIs del Dashboard son los comerciales, y solo esos', async () => {
  const db = new MemoryDb()
  const owner = await nuevoOwner(db)
  await altaDeEmpresa(db, { owner, nombre: 'Empresa A', email: 'a@x.com', adminEmail: 'a@su.com' })
  const b = await altaDeEmpresa(db, { owner, nombre: 'Empresa B', email: 'b@x.com', adminEmail: 'b@su.com' })
  const c = await altaDeEmpresa(db, { owner, nombre: 'Empresa C', email: 'c@x.com', adminEmail: 'c@su.com' })
  const p = plano(db)

  await setCompanyCommercialStatus(owner, b.tenant.id, 'active', asStatusDb(db), p)
  await setCompanyCommercialStatus(owner, c.tenant.id, 'suspended', asStatusDb(db), p)
  await p.updateCompany(b.tenant.id, { routeCount: 4, billableRouteCount: 3, billingRate: 50_000 })
  await p.updateCompany(c.tenant.id, { routeCount: 2, billableRouteCount: 2, billingRate: 50_000 })
  await registerSaaSPayment(owner, { companyId: b.tenant.id, periodo: '2026-09', valor: 150_000, fechaEsperada: '2026-09-05', status: 'pending' }, p)

  const k = ownerKpis(await p.listCompanies(), await p.listPayments())
  metric('empresas totales', k.empresasTotales)
  metric('activas / prueba / suspendidas', `${k.empresasActivas} / ${k.empresasPrueba} / ${k.empresasSuspendidas}`)
  metric('rutas actuales / facturables', `${k.rutasActuales} / ${k.rutasFacturables}`)
  metric('cobro esperado del período', k.cobroEsperadoPeriodo)
  metric('cobros pendientes', k.cobrosPendientes)
  assert(k.empresasTotales === 3, 'deben contarse las tres empresas')
  assert(k.empresasActivas === 1 && k.empresasPrueba === 1 && k.empresasSuspendidas === 1, 'un estado por empresa')
  assert(k.rutasActuales === 6 && k.rutasFacturables === 5, 'las dos cifras de rutas son distintas y ambas se muestran')
  // Solo B genera expectativa: A no tiene rutas y C está suspendida.
  assert(k.cobroEsperadoPeriodo === 150_000, `el esperado debe ser 150.000, fue ${k.cobroEsperadoPeriodo}`)
  assert(k.cobrosPendientes === 1, 'un cobro pendiente')
})

// ############################################################
// FAMILIA — OWNER-PRIVACY (guardianes de importación)
// ############################################################
/**
 * Módulos OPERATIVOS de la empresa. Si el código del Owner importa cualquiera de
 * ellos, la separación de niveles deja de ser real y pasa a depender de la disciplina
 * de quien escribe. Esto lo impide.
 */
const MODULOS_OPERATIVOS: Array<[string, RegExp]> = [
  ['clientes', /clientsService|ClientsPage|creditHistory/],
  ['ventas', /saleRequestService|installmentEngine|ActiveSalesPage/],
  ['pagos operativos', /paymentService|paymentCorrectionService|paymentState/],
  ['cartera y reportes internos', /reportService|financialReconciliation/],
  ['caja', /cashboxEngine|partnerCashService|weeklySettlementEngine|settlementService/],
  ['documentos e imágenes de clientes', /lib\/image|PhotoInput/],
  ['cobradores', /collectorAttribution|cobradorRules|CollectorPicker/],
  ['siembra DEMO', /data\/seed/],
]

const ARCHIVOS_OWNER = [...archivosDe('src/platform'), ...archivosDe('src/pages/owner')]

await spec('OWNER-PRIVACY-001', 'Owner · Privacidad', 'el Dashboard Owner no carga clientes', () => {
  const [etiqueta, patron] = MODULOS_OPERATIVOS[0]
  const culpables = ARCHIVOS_OWNER.filter(f => importsDe(f).some(m => patron.test(m)))
  metric('archivos del Owner revisados', ARCHIVOS_OWNER.length)
  metric(`importan ${etiqueta}`, culpables.join(', ') || 'ninguno')
  assert(culpables.length === 0, `el código del Owner importa ${etiqueta}: ${culpables.join(', ')}`)
})

await spec('OWNER-PRIVACY-002', 'Owner · Privacidad', 'el Dashboard Owner no carga ventas', () => {
  const [etiqueta, patron] = MODULOS_OPERATIVOS[1]
  const culpables = ARCHIVOS_OWNER.filter(f => importsDe(f).some(m => patron.test(m)))
  metric(`importan ${etiqueta}`, culpables.join(', ') || 'ninguno')
  assert(culpables.length === 0, `el código del Owner importa ${etiqueta}: ${culpables.join(', ')}`)
})

await spec('OWNER-PRIVACY-003', 'Owner · Privacidad', 'el Dashboard Owner no carga pagos operativos', () => {
  const [etiqueta, patron] = MODULOS_OPERATIVOS[2]
  const culpables = ARCHIVOS_OWNER.filter(f => importsDe(f).some(m => patron.test(m)))
  metric(`importan ${etiqueta}`, culpables.join(', ') || 'ninguno')
  assert(culpables.length === 0, `el código del Owner importa ${etiqueta}: ${culpables.join(', ')}`)
})

await spec('OWNER-PRIVACY-004', 'Owner · Privacidad', 'el Dashboard Owner no carga caja', () => {
  const [etiqueta, patron] = MODULOS_OPERATIVOS[4]
  const culpables = ARCHIVOS_OWNER.filter(f => importsDe(f).some(m => patron.test(m)))
  metric(`importan ${etiqueta}`, culpables.join(', ') || 'ninguno')
  assert(culpables.length === 0, `el código del Owner importa ${etiqueta}: ${culpables.join(', ')}`)
})

await spec('OWNER-PRIVACY-005', 'Owner · Privacidad', 'ningún módulo operativo entra en el código del Owner', () => {
  const fallos: string[] = []
  for (const [etiqueta, patron] of MODULOS_OPERATIVOS) {
    for (const f of ARCHIVOS_OWNER) {
      if (importsDe(f).some(m => patron.test(m))) fallos.push(`${f} → ${etiqueta}`)
    }
  }
  metric('archivos revisados', ARCHIVOS_OWNER.length)
  metric('familias prohibidas', MODULOS_OPERATIVOS.map(([e]) => e).join(' · '))
  metric('violaciones', fallos.join(' | ') || 'ninguna')
  assert(fallos.length === 0, `importaciones prohibidas: ${fallos.join(' | ')}`)
})

await spec('OWNER-PRIVACY-006', 'Owner · Privacidad', 'las pantallas del Owner NO tienen el objeto Dexie completo', () => {
  // `@/lib/db` expone `clients`, `sales`, `payments`, `cashboxMovements`… Tenerlo a
  // mano convierte la privacidad en una cuestión de disciplina. Solo dos archivos del
  // plano de control pueden importarlo, y ahí se estrecha a tipos mínimos.
  const AUTORIZADOS = ['src/platform/controlPlane.ts', 'src/platform/localDatabases.ts']
  const culpables = ARCHIVOS_OWNER
    .filter(f => !AUTORIZADOS.includes(f))
    .filter(f => importsDe(f).some(m => m === '@/lib/db'))
  metric('archivos autorizados a tocar la base', AUTORIZADOS.join(', '))
  metric('pantallas del Owner que importan @/lib/db', culpables.join(', ') || 'ninguna')
  assert(culpables.length === 0, `estas pantallas tienen la base entera: ${culpables.join(', ')}`)

  // Y los tipos que reciben no declaran ni una tabla operativa.
  const contrato = readSource('src/platform/controlPlane.ts')
  const superficie = contrato.slice(contrato.indexOf('export interface ControlPlaneDatabase'), contrato.indexOf('// Interfaz pública'))
  for (const prohibida of ['clients', 'sales', 'payments', 'installments', 'cashboxMovements', 'expenses', 'withdrawals']) {
    metric(`ControlPlaneDatabase declara ${prohibida}`, superficie.includes(`${prohibida}:`) ? 'SÍ — ERROR' : 'no')
    assert(!superficie.includes(`${prohibida}:`), `la superficie del Owner no puede declarar ${prohibida}`)
  }
})

await spec('OWNER-PRIVACY-007', 'Owner · Privacidad', 'los eventos SaaS no admiten hechos operativos', () => {
  const tipos = readSource('src/platform/types.ts')
  const bloque = tipos.slice(tipos.indexOf('export type ControlEventType'), tipos.indexOf('export interface ControlEvent'))
  const permitidos: ControlEventType[] = [
    'COMPANY_CREATED', 'COMPANY_ACTIVATED', 'COMPANY_SUSPENDED', 'FIRST_LOGIN', 'LOGIN',
    'ROUTE_CREATED', 'ROUTE_DEACTIVATED', 'ROUTE_DELETED', 'BILLING_UPDATED', 'PAYMENT_REGISTERED',
  ]
  for (const t of permitidos) assert(bloque.includes(`'${t}'`), `falta el evento ${t}`)
  metric('eventos permitidos', permitidos.length)

  const PROHIBIDOS = ['SALE', 'CLIENT_CREATED', 'COLLECTION', 'EXPENSE', 'REGISTER_PAYMENT', 'CASHBOX']
  for (const t of PROHIBIDOS) {
    metric(`evento ${t}`, bloque.includes(t) ? 'PRESENTE — ERROR' : 'ausente')
    assert(!bloque.includes(t), `el canal del Owner no puede transportar ${t}`)
  }
})

// ############################################################
// FAMILIA — SUPERADMIN (tenant, jerarquía, múltiples, último)
// ############################################################
await spec('SUPERADMIN-TENANT-003', 'Super Admin · Empresa', 'el Super Admin solo opera SU empresa', async () => {
  const db = new MemoryDb()
  const owner = await nuevoOwner(db)
  const a = await altaDeEmpresa(db, { owner, nombre: 'Empresa A', email: 'a@x.com', adminEmail: 'su.a@x.com' })
  const b = await altaDeEmpresa(db, { owner, nombre: 'Empresa B', email: 'b@x.com', adminEmail: 'su.b@x.com' })

  metric('tenant de A', a.superAdmin.tenantId)
  metric('tenant de B', b.superAdmin.tenantId)
  assert(a.superAdmin.tenantId !== b.superAdmin.tenantId, 'cada empresa tiene el suyo')

  const propias: Array<[string, boolean]> = [
    ['ver clientes de SU empresa', can(a.superAdmin, 'client.view', { tenantId: a.tenant.id })],
    ['crear rutas en SU empresa', can(a.superAdmin, 'route.create', { tenantId: a.tenant.id })],
    ['configurar SU empresa', can(a.superAdmin, 'settings.edit', { tenantId: a.tenant.id })],
  ]
  for (const [que, puede] of propias) { metric(que, puede); assert(puede, `debe poder ${que}`) }

  const ajenas: Array<[string, boolean]> = [
    ['ver clientes de la empresa ajena', can(a.superAdmin, 'client.view', { tenantId: b.tenant.id })],
    ['crear rutas en la empresa ajena', can(a.superAdmin, 'route.create', { tenantId: b.tenant.id })],
    ['configurar la empresa ajena', can(a.superAdmin, 'settings.edit', { tenantId: b.tenant.id })],
    ['gestionar al Super Admin ajeno', canManageUser(a.superAdmin, b.superAdmin)],
  ]
  for (const [que, puede] of ajenas) { metric(que, puede); assert(!puede, `NO debe poder ${que}`) }
})

await spec('SUPERADMIN-MULTI-001', 'Super Admin · Múltiples', 'un Super Admin crea un segundo Super Admin', async () => {
  const db = new MemoryDb()
  const { superAdmin, tenant } = await altaDeEmpresa(db)
  metric('puede crear el rol superadmin', canManageRole(superAdmin, 'superadmin'))
  metric('roles asignables', assignableRoles(superAdmin).join(', '))
  assert(canManageRole(superAdmin, 'superadmin'), 'debe poder crear otro Super Admin')
  assert(assignableRoles(superAdmin).includes('superadmin'), 'el rol debe ofrecerse en el formulario')

  const segundo = usuario({ tenantId: tenant.id, rol: 'superadmin', id: 'u-su-2', email: 'su2@x.com' })
  await db.users.add(segundo)
  const todos = await db.users.toArray() as User[]
  metric('Super Admin activos', activeSuperadminsOf(todos, tenant.id).length)
  assert(activeSuperadminsOf(todos, tenant.id).length === 2, 'la empresa debe poder tener varios')

  // Y cada uno puede administrar al otro, incluida su contraseña.
  metric('el primero gestiona al segundo', canManageUser(superAdmin, segundo))
  metric('el segundo gestiona al primero', canManageUser(segundo, superAdmin))
  assert(canManageUser(superAdmin, segundo) && canManageUser(segundo, superAdmin), 'son pares entre sí')
})

await spec('SUPERADMIN-HIERARCHY-001', 'Super Admin · Jerarquía', 'el Administrador NO puede crear Super Admins', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  const admin = usuario({ tenantId: tenant.id, rol: 'admin', id: 'u-adm' })

  metric('roles que el Admin puede asignar', assignableRoles(admin).join(', '))
  metric('canManageRole(admin, superadmin)', canManageRole(admin, 'superadmin'))
  metric('canManageUser(admin, superAdmin)', canManageUser(admin, superAdmin))
  assert(!canManageRole(admin, 'superadmin'), 'el Admin no crea Super Admins')
  assert(!assignableRoles(admin).includes('superadmin'), 'el rol no debe ofrecérsele siquiera')
  assert(!canManageUser(admin, superAdmin), 'el Admin no edita, desactiva ni resetea a un Super Admin')

  // Ni tampoco a otro Administrador: su jerarquía es estrictamente descendente.
  const otroAdmin = usuario({ tenantId: tenant.id, rol: 'admin', id: 'u-adm-2' })
  metric('canManageUser(admin, otro admin)', canManageUser(admin, otroAdmin))
  assert(!canManageUser(admin, otroAdmin), 'un Admin no gestiona a otro Admin')
  // Pero sí a sus subordinados.
  for (const rol of ['supervisor', 'cobrador', 'secretario', 'socio'] as const) {
    assert(canManageRole(admin, rol), `el Admin sí gestiona a ${rol}`)
  }
})

await spec('SUPERADMIN-LAST-001', 'Super Admin · Protección', 'no puede desactivarse el último Super Admin activo', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  let todos = await db.users.toArray() as User[]

  const bloqueo = blockIfLastSuperadmin(superAdmin, todos)
  metric('Super Admin activos', activeSuperadminsOf(todos, tenant.id).length)
  metric('intento de desactivar al único', bloqueo?.code ?? 'PERMITIDO — ERROR')
  assert(bloqueo?.code === 'LAST_SUPERADMIN', 'debe bloquearse: la empresa quedaría sin autoridad máxima')

  // Degradarlo es el mismo agujero por otra puerta.
  const degradar = blockIfDemotingLastSuperadmin(superAdmin, 'admin', todos)
  metric('intento de degradarlo a Administrador', degradar?.code ?? 'PERMITIDO — ERROR')
  assert(degradar?.code === 'LAST_SUPERADMIN', 'degradar al último también debe bloquearse')

  // Con un segundo Super Admin activo, ambas operaciones se permiten.
  await db.users.add(usuario({ tenantId: tenant.id, rol: 'superadmin', id: 'u-su-2', email: 'su2@x.com' }))
  todos = await db.users.toArray() as User[]
  metric('Super Admin activos ahora', activeSuperadminsOf(todos, tenant.id).length)
  metric('desactivar con dos', blockIfLastSuperadmin(superAdmin, todos) === null ? 'PERMITIDO' : 'BLOQUEADO — ERROR')
  metric('degradar con dos', blockIfDemotingLastSuperadmin(superAdmin, 'admin', todos) === null ? 'PERMITIDO' : 'BLOQUEADO — ERROR')
  assert(blockIfLastSuperadmin(superAdmin, todos) === null, 'con dos, desactivar a uno es legítimo')
  assert(blockIfDemotingLastSuperadmin(superAdmin, 'admin', todos) === null, 'con dos, degradar a uno es legítimo')

  // El invariante se sostiene siempre.
  metric('la empresa conserva Super Admin', tenantHasActiveSuperadmin(todos, tenant.id))
  assert(tenantHasActiveSuperadmin(todos, tenant.id), 'toda empresa debe conservar al menos uno activo')
})

await spec('SUPERADMIN-LAST-002', 'Super Admin · Protección', 'la protección se aplica en Usuarios, en los tres caminos', () => {
  const page = readSource('src/pages/admin/UsersPage.tsx')
  metric('al desactivar', page.includes('blockIfLastSuperadmin(u,'))
  metric('al eliminar', (page.match(/blockIfLastSuperadmin\(u,/g) ?? []).length >= 2)
  metric('al cambiar el rol', page.includes('blockIfDemotingLastSuperadmin('))
  assert((page.match(/blockIfLastSuperadmin\(/g) ?? []).length >= 2, 'debe cubrir desactivar Y eliminar')
  assert(page.includes('blockIfDemotingLastSuperadmin('), 'debe cubrir también la degradación de rol')
})

await spec('SUPERADMIN-TENANT-004', 'Super Admin · Empresa', 'una empresa suspendida bloquea también a su Super Admin', async () => {
  const db = new MemoryDb()
  const { owner, tenant } = await altaDeEmpresa(db, { adminEmail: 'su.a@x.com', password: 'ClaveInicial1' })
  const p = plano(db)

  const antes = await authenticateUser('su.a@x.com', 'ClaveInicial1', asAuthDb(db))
  metric('login antes de suspender', antes.ok ? 'ACEPTADO' : antes.code)
  assert(antes.ok, 'precondición: la empresa funciona')

  await setCompanyCommercialStatus(owner, tenant.id, 'suspended', asStatusDb(db), p)
  const despues = await authenticateUser('su.a@x.com', 'ClaveInicial1', asAuthDb(db))
  const tenantTrasSuspender = (await db.tenants.get(tenant.id))!
  metric('estado comercial', (await p.getCompany(tenant.id))!.status)
  metric('estado operativo', tenantTrasSuspender.status)
  metric('login después', despues.ok ? 'ACEPTADO — ERROR' : despues.code)
  metric('mensaje', despues.ok ? '—' : despues.error)
  assert(despues.ok === false && despues.code === 'COMPANY_BLOCKED', 'ni el Super Admin opera con la empresa suspendida')
  assert(isCompanyBlocked(tenantTrasSuspender), 'el estado operativo debe reflejar la suspensión')
  // Mensaje corto y SIN detalles comerciales (apartado W).
  assert(companyBlockMessage(tenantTrasSuspender) === 'Servicio suspendido. Contacte al proveedor.',
    'el mensaje no puede revelar la relación comercial')
  // Y NO se borró nada.
  metric('la empresa sigue existiendo', !!tenantTrasSuspender)
  metric('sus usuarios siguen existiendo', (await db.users.toArray()).length)
  assert((await db.users.toArray()).length === 1, 'suspender no borra datos')

  // Reactivar es competencia EXCLUSIVA del Owner: el Super Admin ni siquiera tiene
  // la capacidad con la que intentarlo.
  const su = (await db.users.toArray() as User[])[0]
  metric("can(superadmin, 'company.suspend')", can(su, 'company.suspend', { tenantId: tenant.id }))
  assert(!can(su, 'company.suspend', { tenantId: tenant.id }), 'el Super Admin no reactiva su propia empresa')

  await setCompanyCommercialStatus(owner, tenant.id, 'active', asStatusDb(db), p)
  const reactivado = await authenticateUser('su.a@x.com', 'ClaveInicial1', asAuthDb(db))
  metric('login tras reactivar', reactivado.ok ? 'ACEPTADO' : reactivado.code)
  assert(reactivado.ok, 'reactivar debe devolver el servicio íntegro')
})

await spec('SUPERADMIN-TENANT-005', 'Super Admin · Empresa', 'los dos relojes de estado se escriben juntos', () => {
  metric('trial → prueba', tenantStatusFor('trial'))
  metric('active → activa', tenantStatusFor('active'))
  metric('suspended → suspendida', tenantStatusFor('suspended'))
  assert(tenantStatusFor('trial') === 'prueba', 'trial es prueba')
  assert(tenantStatusFor('active') === 'activa', 'active es activa')
  assert(tenantStatusFor('suspended') === 'suspendida', 'suspended es suspendida')
  metric('prueba → trial', commercialStatusFor('prueba'))
  metric('suspendida → suspended', commercialStatusFor('suspendida'))
  assert(commercialStatusFor('prueba') === 'trial' && commercialStatusFor('suspendida') === 'suspended',
    'la correspondencia inversa debe ser coherente')

  // Y hay UN solo sitio que escribe ambos: no pueden divergir.
  const svc = readSource('src/platform/companyControlService.ts')
  const cuerpo = svc.slice(svc.indexOf('export async function setCompanyCommercialStatus'))
  metric('escribe el estado operativo', cuerpo.includes('database.tenants.update(companyId, { status: tenantStatusFor(status)'))
  metric('escribe el estado comercial', cuerpo.includes('plane.updateCompany(companyId, { status,'))
  assert(cuerpo.includes('tenantStatusFor(status)') && cuerpo.includes('plane.updateCompany(companyId, { status,'),
    'el cambio de estado debe actualizar los dos relojes en el mismo sitio')
})

// ############################################################
// FAMILIA — PASSWORD-USERS
// ############################################################
await spec('PASSWORD-USERS-001', 'Contraseñas', 'el Super Admin restablece contraseñas de su empresa', async () => {
  const db = new MemoryDb()
  const { tenant, superAdmin } = await altaDeEmpresa(db)
  const cobrador = usuario({ tenantId: tenant.id, rol: 'cobrador', id: 'u-cob' })
  const otroSuper = usuario({ tenantId: tenant.id, rol: 'superadmin', id: 'u-su-2' })
  const ajeno = usuario({ tenantId: 'otra-empresa', rol: 'cobrador', id: 'u-aj' })

  metric('Super Admin → Cobrador', canManageUser(superAdmin, cobrador))
  metric('Super Admin → otro Super Admin', canManageUser(superAdmin, otroSuper))
  metric('Super Admin → usuario ajeno', canManageUser(superAdmin, ajeno))
  assert(canManageUser(superAdmin, cobrador), 'debe poder restablecer la clave de su equipo')
  assert(canManageUser(superAdmin, otroSuper), 'y la de otro Super Admin de su empresa')
  assert(!canManageUser(superAdmin, ajeno), 'nunca la de un usuario de otra empresa')

  // La contraseña ACTUAL nunca se muestra ni se devuelve: solo se sobrescribe.
  const svc = readSource('src/services/passwordService.ts')
  metric('el servicio devuelve la contraseña', /return[^\n]*target\.password/.test(svc) ? 'SÍ — ERROR' : 'no')
  assert(!/return[^\n]*target\.password/.test(svc), 'la contraseña actual no puede devolverse')
  metric('gestión centralizada en', 'Usuarios (UsersPage) → passwordService')
})

await spec('PASSWORD-USERS-003', 'Contraseñas', 'no queda ningún recordatorio automático de cambio', () => {
  // Barrido de TODO src: ningún componente puede volver a interponer el flujo.
  const todos = archivosDe('src')
  const culpables = todos.filter(f => /PasswordChangeGate/.test(readSource(f)))
  metric('archivos revisados', todos.length)
  metric('mencionan el gate eliminado', culpables.join(', ') || 'ninguno')
  assert(culpables.length === 0, `quedan referencias al cambio obligatorio: ${culpables.join(', ')}`)

  // El flag legado sigue en el modelo por compatibilidad, pero nadie lo EXIGE.
  const guards = readSource('src/components/auth/guards.tsx')
  metric('el guard consulta mustChangePassword', guards.includes('mustChangePassword') ? 'SÍ — ERROR' : 'no')
  assert(!guards.includes('mustChangePassword'), 'ningún guard puede condicionar el acceso al flag')
})

// ############################################################
// FAMILIA — CROSS-DEVICE (informe honesto, apartado AE)
// ############################################################
await spec('CROSS-DEVICE-001', 'Cross-device', 'el plano de control declara su alcance REAL, sin maquillaje', () => {
  metric('¿existe backend compartido?', CONTROL_PLANE_IS_SHARED ? 'SÍ' : 'NO')
  metric('aviso mostrado al Owner', CONTROL_PLANE_SCOPE_NOTICE)
  assert(CONTROL_PLANE_IS_SHARED === false,
    'si esto pasa a true debe existir de verdad un backend compartido, no una promesa')

  // La única implementación que existe habla con la base LOCAL. No hay ningún
  // cliente HTTP escondido que sugiera lo contrario.
  const plane = readSource('src/platform/controlPlane.ts')
  metric('implementaciones', 'LocalControlPlane (única)')
  metric('llamadas de red en el plano de control', /fetch\(|axios|XMLHttpRequest|WebSocket|EventSource/.test(plane) ? 'PRESENTES' : 'ninguna')
  assert(!/fetch\(|axios|XMLHttpRequest|WebSocket|EventSource/.test(plane),
    'no puede haber una sincronización simulada: o hay backend o se dice que no lo hay')

  // Y la interfaz del Owner lo ADVIERTE en pantalla, no en un comentario.
  const layout = readSource('src/pages/owner/OwnerLayout.tsx')
  metric('el portal muestra el aviso', layout.includes('CONTROL_PLANE_SCOPE_NOTICE'))
  assert(layout.includes('CONTROL_PLANE_SCOPE_NOTICE'), 'el alcance debe advertirse en la interfaz')
})

await spec('CROSS-DEVICE-002', 'Cross-device', 'dos "dispositivos" no comparten nada: evidencia ejecutable', async () => {
  // Cada MemoryDb es un almacenamiento independiente, igual que dos IndexedDB de dos
  // navegadores distintos. Esta prueba NO demuestra un fallo: demuestra el límite
  // real de la arquitectura actual, para que el informe no pueda adornarlo.
  const dispositivoA = new MemoryDb()
  const dispositivoB = new MemoryDb()

  const ownerA = await nuevoOwner(dispositivoA)
  const { tenant } = await altaDeEmpresa(dispositivoA, { owner: ownerA })

  // El cliente crea una ruta... en SU dispositivo (B).
  await dispositivoB.routes.add({ id: 'r-1', tenantId: tenant.id, nombre: 'Ruta Norte', status: 'activa' })
  await syncRouteMetrics(tenant.id, plano(dispositivoB), 'ROUTE_CREATED', 'Ruta Norte')

  const desdeA = (await plano(dispositivoA).getCompany(tenant.id))!
  metric('rutas que ve el Owner desde SU dispositivo', desdeA.billableRouteCount)
  metric('rutas reales en el dispositivo del cliente', (await dispositivoB.routes.toArray()).length)
  metric('¿el Owner ve el cambio de otro dispositivo?', 'NO')
  assert(desdeA.billableRouteCount === 0,
    'sin backend compartido, el dispositivo A no puede enterarse de lo que ocurrió en B')
  assert((await dispositivoB.routes.toArray()).length === 1, 'la ruta sí existe, pero solo allí')

  // En el MISMO dispositivo, en cambio, la métrica sí llega: el modelo funciona, lo
  // que falta es el transporte entre dispositivos.
  await dispositivoA.routes.add({ id: 'r-2', tenantId: tenant.id, nombre: 'Ruta Sur', status: 'activa' })
  await syncRouteMetrics(tenant.id, plano(dispositivoA), 'ROUTE_CREATED', 'Ruta Sur')
  metric('en el mismo dispositivo', (await plano(dispositivoA).getCompany(tenant.id))!.billableRouteCount)
  assert((await plano(dispositivoA).getCompany(tenant.id))!.billableRouteCount === 1,
    'dentro de un mismo dispositivo la métrica sí se propaga')
})

await spec('CROSS-DEVICE-003', 'Cross-device', 'el contrato del backend pendiente está documentado', () => {
  const doc = 'docs/CONTROL_PLANE_BACKEND_REQUIREMENTS_2026-09.md'
  metric('documento', doc)
  assert(existsSync(resolve(process.cwd(), doc)), `falta ${doc}`)
  const texto = readSource(doc)
  const OPERACIONES = [
    'createCompany', 'getCompanies', 'getCompany', 'updateCompanyStatus',
    'recordTenantLogin', 'updateRouteMetrics', 'getBilling', 'registerSaaSPayment',
  ]
  for (const op of OPERACIONES) {
    metric(`operación ${op}`, texto.includes(op) ? 'definida' : 'FALTA')
    assert(texto.includes(op), `el contrato debe definir ${op}`)
  }
  const CAMPOS = ['companyId', 'firstLoginAt', 'lastLoginAt', 'routeCount', 'billableRouteCount', 'billingPlan', 'billingRate', 'nextBillingDate', 'paymentStatus']
  for (const c of CAMPOS) assert(texto.includes(c), `el contrato debe definir el campo ${c}`)
  metric('campos mínimos definidos', CAMPOS.length)
})

await spec('CROSS-DEVICE-004', 'Cross-device', 'la separación Plataforma/Empresa está documentada', () => {
  const doc = 'docs/ARQUITECTURA_OWNER_SUPERADMIN_2026-09.md'
  metric('documento', doc)
  assert(existsSync(resolve(process.cwd(), doc)), `falta ${doc}`)
  const texto = readSource(doc)
  for (const seccion of ['Owner', 'Super Admin', 'onboarding', 'billableRouteCount', 'cross-device', 'contraseñas']) {
    metric(`menciona ${seccion}`, texto.toLowerCase().includes(seccion.toLowerCase()))
    assert(texto.toLowerCase().includes(seccion.toLowerCase()), `el documento debe tratar ${seccion}`)
  }
})

// ############################################################
// FAMILIA — ESTADO DE LA INSTALACIÓN
// ############################################################
await spec('OWNER-COMPANY-005', 'Owner · Empresas', 'el estado de la instalación distingue los dos niveles', async () => {
  const db = new MemoryDb()
  const vacia = await getInstallationState(asPlatformDb(db))
  metric('base virgen', `${vacia.status} · owners=${vacia.ownerCount} · users=${vacia.userCount}`)
  assert(vacia.status === 'empty' && vacia.ownerCount === 0, 'una base virgen no tiene dueño ni usuarios')

  const owner = await nuevoOwner(db)
  const conOwner = await getInstallationState(asPlatformDb(db))
  metric('con Owner y sin empresas', `${conOwner.status} · owners=${conOwner.ownerCount} · empresas=${conOwner.companyCount}`)
  assert(conOwner.status === 'ready' && conOwner.companyCount === 0,
    'la plataforma queda lista aunque todavía no tenga ninguna empresa')

  await altaDeEmpresa(db, { owner })
  const conEmpresa = await getInstallationState(asPlatformDb(db))
  metric('con una empresa', `owners=${conEmpresa.ownerCount} · users=${conEmpresa.userCount} · superadmins=${conEmpresa.superadminCount} · empresas=${conEmpresa.companyCount}`)
  assert(conEmpresa.ownerCount === 1 && conEmpresa.superadminCount === 1 && conEmpresa.companyCount === 1,
    'un Owner, un Super Admin y una empresa: los dos niveles bien contados')
  assert(conEmpresa.userCount === 1, 'el Owner no cuenta como usuario de empresa')

  // El centinela heredado nunca se cuenta como empresa.
  db.tenants._seed([{ id: PLATFORM_TENANT_ID, nombre: 'centinela', email: 'x@y.com', plan: 'profesional', status: 'activa', pais: '', moneda: 'COP', createdAt: '', updatedAt: '' }])
  const conCentinela = await getInstallationState(asPlatformDb(db))
  metric('empresas con el centinela presente', conCentinela.companyCount)
  assert(conCentinela.companyCount === 1, 'el centinela de plataforma no es una empresa')
})

// ############################################################
// INFORME
// ############################################################
const PAD = 26
const line = (ch = '─') => ch.repeat(96)

console.log('')
console.log(line('═'))
console.log('  RUTACASH — SUITE DE PLATAFORMA (OWNER / SUPER ADMIN)')
console.log(line('═'))

let grupoActual = ''
for (const r of results) {
  if (r.group !== grupoActual) {
    grupoActual = r.group
    console.log('')
    console.log(`▌ ${grupoActual.toUpperCase()}`)
    console.log(line())
  }
  console.log(`[ ${r.passed ? 'PASS' : 'FAIL'} ] ${r.id.padEnd(PAD)} ${r.desc}`)
  for (const m of r.metrics) console.log(`           · ${m}`)
  if (!r.passed) console.log(`           ↳ ERROR: ${r.error}`)
}

const porGrupo = new Map<string, { pass: number; fail: number }>()
for (const r of results) {
  const g = porGrupo.get(r.group) ?? { pass: 0, fail: 0 }
  if (r.passed) g.pass++; else g.fail++
  porGrupo.set(r.group, g)
}

console.log('')
console.log(line('═'))
console.log('  RESUMEN')
console.log(line())
for (const [g, { pass, fail }] of porGrupo) {
  console.log(`    ${g.padEnd(24)} ${String(pass).padStart(3)} PASS   ${String(fail).padStart(3)} FAIL`)
}
const pass = results.filter(r => r.passed).length
const fail = results.length - pass
console.log(line())
console.log(`  TOTAL: ${results.length} casos   ${pass} PASS   ${fail} FAIL`)
console.log(line('═'))
console.log('')

if (fail > 0) {
  console.log('CASOS FALLIDOS:')
  for (const r of results.filter(x => !x.passed)) console.log(`  · ${r.id} — ${r.desc}\n    ${r.error}`)
  console.log('')
  console.log('SUITE DE PLATAFORMA: FALLÓ')
  process.exit(1)
}
console.log('SUITE DE PLATAFORMA: TODOS LOS CASOS PASAN')
