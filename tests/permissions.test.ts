// ============================================================
// PRUEBA EJECUTABLE — Matriz de permisos (modelo de roles)
// ------------------------------------------------------------
// No requiere framework. Ejecuta con:
//   npx esbuild tests/permissions.test.ts --bundle --format=esm --platform=node --outfile=tests/_out.mjs && node tests/_out.mjs
// (o el script `npm run test:permissions`). Falla con exit 1 si algún caso no se cumple.
// Valida SOLO la lógica pura de permissions.ts (los tipos se eliminan al compilar).
// ============================================================
import {
  can, canManageRole, canManageUser, canAccessRoute, authorizedRouteIdsOf, homePathForRole, ROLE_LABELS,
  hasOperationalRoutes, isRouteUnrestricted, filterByAccessibleRoute, filterAccessibleRoutes,
  isCapabilityCompatible, sanitizeGrantedCapabilities, delegableCapabilitiesFor,
  isPartnerInScope, isTransferInScope, type Capability,
} from '../src/lib/permissions'
import { CAPABILITY_METADATA, CATEGORY_ORDER } from '../src/lib/capabilityCatalog'
import { getEffectiveCompanyStatus, isCompanyBlocked } from '../src/lib/company'
import { shallowDirty } from '../src/hooks/useDirtyForm'
import { computeRouteAssignmentDiff } from '../src/lib/routeAssignmentDiff'
import { getRouteAssignmentsByRole, getUsersAssignedToRoute, ASSIGNMENT_ROLE_ORDER, hasAnyAssignment } from '../src/lib/routeAssignments'
import type { User, UserRole, Tenant } from '../src/models/types'

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) { passed++; /* console.log('  ok:', name) */ }
  else { failed++; console.error('  FALLA:', name) }
}

function mkUser(rol: UserRole, over: Partial<User> = {}): User {
  return {
    id: `u-${rol}`, tenantId: 't1', nombre: rol, email: `${rol}@t.com`, password: 'x',
    rol, status: 'activo', createdAt: '', updatedAt: '', ...over,
  }
}

const superadmin = mkUser('superadmin')
const admin = mkUser('admin', { authorizedRouteIds: ['r1', 'r2'] })
const socio = mkUser('socio', { authorizedRouteIds: ['r1'] })
const supervisor = mkUser('supervisor', { authorizedRouteIds: ['r1'] })
const cobrador = mkUser('cobrador', { authorizedRouteIds: ['r1'] })
const secretario = mkUser('secretario', { authorizedRouteIds: ['r1'] })

// --- D. VENTAS: venta directa vs solicitud ---
check('superadmin puede venta directa', can(superadmin, 'sale.createDirect', { routeId: 'r1' }))
check('admin puede venta directa (ruta autorizada)', can(admin, 'sale.createDirect', { routeId: 'r1' }))
check('cobrador NO puede venta directa', !can(cobrador, 'sale.createDirect', { routeId: 'r1' }))
check('supervisor NO puede venta directa', !can(supervisor, 'sale.createDirect', { routeId: 'r1' }))
check('secretario NO puede venta directa', !can(secretario, 'sale.createDirect', { routeId: 'r1' }))
check('cobrador puede crear solicitud', can(cobrador, 'sale.createRequest', { routeId: 'r1' }))
check('supervisor puede crear solicitud', can(supervisor, 'sale.createRequest', { routeId: 'r1' }))

// --- F. SOCIO: solo lectura ---
check('socio puede consultar clientes', can(socio, 'client.view', { routeId: 'r1' }))
check('socio NO crea clientes', !can(socio, 'client.create', { routeId: 'r1' }))
check('socio NO registra pagos', !can(socio, 'payment.register', { routeId: 'r1' }))
check('socio NO hace transferencias', !can(socio, 'transfer.create'))
check('socio ve su caja propia', can(socio, 'partnerCash.viewOwn'))
check('socio NO ve caja de otros socios', !can(socio, 'partnerCash.viewAll'))
check('socio puede exportar reportes', can(socio, 'report.export'))

// --- SUPERVISOR / COBRADOR operativos ---
check('supervisor registra pagos', can(supervisor, 'payment.register', { routeId: 'r1' }))
check('cobrador registra pagos', can(cobrador, 'payment.register', { routeId: 'r1' }))
check('supervisor NO corrige pagos', !can(supervisor, 'payment.correct', { routeId: 'r1' }))
check('cobrador NO corrige pagos', !can(cobrador, 'payment.correct', { routeId: 'r1' }))
check('supervisor NO ve indicadores consolidados', !can(supervisor, 'report.viewConsolidated'))
check('cobrador NO exporta reportes consolidados', !can(cobrador, 'report.export'))

// --- SECRETARIO ---
check('secretario corrige pagos (periodo abierto)', can(secretario, 'payment.correct', { routeId: 'r1', periodClosed: false }))
check('secretario NO corrige en periodo cerrado', !can(secretario, 'payment.correct', { routeId: 'r1', periodClosed: true }))
check('admin SÍ corrige en periodo cerrado', can(admin, 'payment.correct', { routeId: 'r1', periodClosed: true }))
check('secretario aprueba autorizaciones', can(secretario, 'authorization.approve', { routeId: 'r1' }))
check('secretario NO ve caja de ruta', !can(secretario, 'cashbox.viewRoute', { routeId: 'r1' }))
check('secretario NO crea clientes', !can(secretario, 'client.create', { routeId: 'r1' }))
check('secretario edita cliente (limitado)', can(secretario, 'client.editLimited', { routeId: 'r1' }))

// --- B. RESTRICCIÓN POR RUTAS ---
check('supervisor accede a su ruta', canAccessRoute(supervisor, 'r1'))
check('supervisor NO accede a ruta ajena', !canAccessRoute(supervisor, 'r9'))
check('cobrador NO registra pago en ruta ajena', !can(cobrador, 'payment.register', { routeId: 'r9' }))
check('superadmin accede a cualquier ruta', canAccessRoute(superadmin, 'r-cualquiera'))
check('authorizedRouteIds incluye routeId legacy', authorizedRouteIdsOf(mkUser('cobrador', { routeId: 'rL' })).includes('rL'))

// ============================================================
// CIERRE DE BRECHAS — nuevas pruebas
// ============================================================

// --- ADMINISTRADOR SIN RUTAS = CERO ACCESO (FAIL CLOSED) ---
const adminNoRoutes = mkUser('admin')  // sin authorizedRouteIds ni routeId
check('admin sin rutas: NO es unrestricted', !isRouteUnrestricted(adminNoRoutes))
check('admin sin rutas: hasOperationalRoutes false', !hasOperationalRoutes(adminNoRoutes))
check('admin sin rutas: NO accede a ninguna ruta', !canAccessRoute(adminNoRoutes, 'r1'))
check('admin sin rutas: NO consulta clientes', !can(adminNoRoutes, 'client.view', { routeId: 'r1' }))
check('admin sin rutas: NO ve ventas', !can(adminNoRoutes, 'sale.viewActive', { routeId: 'r1' }))
check('admin sin rutas: NO ve caja', !can(adminNoRoutes, 'cashbox.viewRoute', { routeId: 'r1' }))
check('admin sin rutas: NO aprueba solicitudes', !can(adminNoRoutes, 'authorization.approve', { routeId: 'r1' }))
check('admin sin rutas: NO aprueba ajustes', !can(adminNoRoutes, 'payment.approveAdjustment', { routeId: 'r1' }))
// transfer.create no lleva routeId en can(); el guard efectivo es isTransferInScope,
// que para un admin sin rutas rechaza TODA transferencia (ninguna ruta en alcance).
check('admin sin rutas: NINGUNA transferencia en alcance', !isTransferInScope(adminNoRoutes, { origenType: 'route', destinoType: 'route', routeOrigenId: 'r1', routeDestinoId: 'r2' }, () => []))
check('admin sin rutas: filtro de clientes vacío', filterByAccessibleRoute(adminNoRoutes, [{ routeId: 'r1' }, { routeId: 'r2' }]).length === 0)
check('admin sin rutas: filtro de rutas vacío', filterAccessibleRoutes(adminNoRoutes, [{ id: 'r1' }, { id: 'r2' }]).length === 0)
// Sí puede cambiar su contraseña (cuenta).
check('admin sin rutas: SÍ cambia su contraseña', can(adminNoRoutes, 'password.changeOwn'))
// superadmin siempre tiene operación.
check('superadmin: hasOperationalRoutes true aunque sin rutas', hasOperationalRoutes(mkUser('superadmin')))

// --- ADMIN CON UNA RUTA ---
const admin1 = mkUser('admin', { authorizedRouteIds: ['r1'] })
check('admin 1 ruta: accede a r1', canAccessRoute(admin1, 'r1'))
check('admin 1 ruta: NO accede a r2', !canAccessRoute(admin1, 'r2'))
check('admin 1 ruta: filtro deja solo r1', filterByAccessibleRoute(admin1, [{ routeId: 'r1' }, { routeId: 'r2' }]).length === 1)
check('admin 1 ruta: NO opera en r2', !can(admin1, 'payment.register', { routeId: 'r2' }))
check('admin 1 ruta: NO aprueba ajuste de r2', !can(admin1, 'payment.approveAdjustment', { routeId: 'r2' }))

// --- ADMIN CON VARIAS RUTAS ---
const admin2 = mkUser('admin', { authorizedRouteIds: ['r1', 'r2'] })
check('admin varias: filtro deja la unión (r1,r2)', filterByAccessibleRoute(admin2, [{ routeId: 'r1' }, { routeId: 'r2' }, { routeId: 'r3' }]).length === 2)
check('admin varias: NO incluye r3', !canAccessRoute(admin2, 'r3'))

// --- SUPERVISOR: OPERACIÓN COMPLETA ---
check('supervisor: crea cliente', can(supervisor, 'client.create', { routeId: 'r1' }))
check('supervisor: crea solicitud', can(supervisor, 'sale.createRequest', { routeId: 'r1' }))
check('supervisor: confirma desembolso', can(supervisor, 'sale.confirmDisbursement', { routeId: 'r1' }))
check('supervisor: registra pago', can(supervisor, 'payment.register', { routeId: 'r1' }))
check('supervisor: registra gasto', can(supervisor, 'expense.register', { routeId: 'r1' }))
check('supervisor: hace cuadre', can(supervisor, 'cashbox.dailyClose', { routeId: 'r1' }))
check('supervisor: exporta reportes', can(supervisor, 'report.export'))
check('supervisor: NO venta directa', !can(supervisor, 'sale.createDirect', { routeId: 'r1' }))
check('supervisor: NO corrige pago', !can(supervisor, 'payment.correct', { routeId: 'r1' }))
check('supervisor: NO anula pago', !can(supervisor, 'payment.reverse', { routeId: 'r1' }))
check('supervisor: NO corrige gasto', !can(supervisor, 'expense.correct', { routeId: 'r1' }))
check('supervisor: NO aprueba', !can(supervisor, 'authorization.approve', { routeId: 'r1' }))
check('supervisor: NO indicadores consolidados', !can(supervisor, 'report.viewConsolidated'))
check('supervisor: NO accede a ruta ajena', !can(supervisor, 'payment.register', { routeId: 'r9' }))

// --- CAPACIDADES INCOMPATIBLES: grantedCapabilities NO habilita lo prohibido ---
const supMalicioso = mkUser('supervisor', { authorizedRouteIds: ['r1'], grantedCapabilities: ['sale.createDirect', 'payment.correct', 'user.create'] as Capability[] })
check('grant NO habilita venta directa en Supervisor', !can(supMalicioso, 'sale.createDirect', { routeId: 'r1' }))
check('grant NO habilita corregir pago en Supervisor', !can(supMalicioso, 'payment.correct', { routeId: 'r1' }))
check('grant NO habilita crear usuarios en Supervisor', !can(supMalicioso, 'user.create', { targetRole: 'cobrador' }))
const cobMalicioso = mkUser('cobrador', { authorizedRouteIds: ['r1'], grantedCapabilities: ['sale.createDirect'] as Capability[] })
check('grant NO habilita venta directa en Cobrador', !can(cobMalicioso, 'sale.createDirect', { routeId: 'r1' }))
const socioMalicioso = mkUser('socio', { authorizedRouteIds: ['r1'], grantedCapabilities: ['payment.register', 'client.create', 'transfer.create'] as Capability[] })
check('grant NO habilita escritura en Socio (pagos)', !can(socioMalicioso, 'payment.register', { routeId: 'r1' }))
check('grant NO habilita escritura en Socio (clientes)', !can(socioMalicioso, 'client.create', { routeId: 'r1' }))
check('grant NO habilita transferencias en Socio', !can(socioMalicioso, 'transfer.create'))
const secMalicioso = mkUser('secretario', { authorizedRouteIds: ['r1'], grantedCapabilities: ['payment.register', 'cashbox.viewRoute', 'transfer.create'] as Capability[] })
check('grant NO habilita registrar pago en Secretario', !can(secMalicioso, 'payment.register', { routeId: 'r1' }))
check('grant NO habilita ver caja en Secretario', !can(secMalicioso, 'cashbox.viewRoute', { routeId: 'r1' }))

// --- isCapabilityCompatible / sanitize / delegable ---
check('incompatible: supervisor + sale.createDirect', !isCapabilityCompatible('supervisor', 'sale.createDirect'))
check('incompatible: socio + payment.register', !isCapabilityCompatible('socio', 'payment.register'))
check('compatible: cobrador + report.viewPortfolio', isCapabilityCompatible('cobrador', 'report.viewPortfolio'))
check('sanitize elimina incompatibles', sanitizeGrantedCapabilities('supervisor', ['sale.createDirect', 'report.export'] as Capability[]).every(c => c !== 'sale.createDirect'))
check('delegableFor admin→supervisor excluye venta directa', !delegableCapabilitiesFor(admin1, 'supervisor').includes('sale.createDirect'))
check('delegableFor admin→cobrador excluye corregir pago', !delegableCapabilitiesFor(admin1, 'cobrador').includes('payment.correct'))

// --- SCOPING: transferencias y caja de socios ---
const socioR1R2 = ['r1', 'r2']  // rutas del socio
const partnerRoutes = (id: string) => id === 'sA' ? ['r1'] : id === 'sB' ? ['r9'] : []
check('admin1 ve socio vinculado a su ruta', isPartnerInScope(admin1, ['r1']))
check('admin1 NO ve socio de ruta ajena', !isPartnerInScope(admin1, ['r9']))
check('superadmin ve cualquier socio', isPartnerInScope(superadmin, ['r9']))
check('transfer r1→r2 en alcance (admin varias)', isTransferInScope(admin2, { origenType: 'route', destinoType: 'route', routeOrigenId: 'r1', routeDestinoId: 'r2' }, partnerRoutes))
check('transfer r1→r3 FUERA de alcance', !isTransferInScope(admin1, { origenType: 'route', destinoType: 'route', routeOrigenId: 'r1', routeDestinoId: 'r3' }, partnerRoutes))
check('transfer r1→socio(sA en r1) en alcance', isTransferInScope(admin1, { origenType: 'route', destinoType: 'partner', routeOrigenId: 'r1', socioDestinoId: 'sA' }, partnerRoutes))
check('transfer r1→socio(sB en r9) FUERA de alcance', !isTransferInScope(admin1, { origenType: 'route', destinoType: 'partner', routeOrigenId: 'r1', socioDestinoId: 'sB' }, partnerRoutes))
void socioR1R2

// --- C. USUARIOS: jerarquía ---
check('superadmin gestiona admin', canManageRole(superadmin, 'admin'))
check('superadmin gestiona superadmin', canManageRole(superadmin, 'superadmin'))
check('admin gestiona cobrador', canManageRole(admin, 'cobrador'))
check('admin gestiona secretario', canManageRole(admin, 'secretario'))
check('admin NO crea admin', !canManageRole(admin, 'admin'))
check('admin NO crea superadmin', !canManageRole(admin, 'superadmin'))
check('supervisor NO gestiona usuarios', !canManageRole(supervisor, 'cobrador'))

// --- Delegación: no otorgar capacidad que no se posee ---
const adminGranting = can(admin, 'user.grantCapabilities')
check('admin puede delegar capacidades', adminGranting)
check('cobrador NO delega capacidades', !can(cobrador, 'user.grantCapabilities'))

// --- Empresa: fuera de tenant ---
check('admin NO opera en otro tenant', !can(admin, 'client.view', { tenantId: 'otro', routeId: 'r1' }))
check('superadmin opera en cualquier tenant', can(superadmin, 'client.view', { tenantId: 'otro', routeId: 'r1' }))

// --- Usuario inactivo pierde permisos ---
check('usuario inactivo no tiene permisos', !can(mkUser('admin', { status: 'inactivo' }), 'client.view'))

// --- A. Redirección por rol ---
check('home superadmin', homePathForRole('superadmin') === '/platform')
check('home admin', homePathForRole('admin') === '/admin/dashboard')
check('home socio', homePathForRole('socio') === '/socio')
check('home supervisor', homePathForRole('supervisor') === '/supervisor/home')
check('home cobrador', homePathForRole('cobrador') === '/collector/home')
check('home secretario', homePathForRole('secretario') === '/secretario')

// --- Etiquetas de los 6 roles ---
check('existen 6 etiquetas de rol', Object.keys(ROLE_LABELS).length === 6)

// ============================================================
// CORRECCIÓN DE EXPERIENCIA SUPER ADMIN Y JERARQUÍA — nuevas pruebas
// ============================================================

// --- #1 Identidad: Super Admin siempre "Super Admin", nunca "Admin" ---
check('etiqueta superadmin = "Super Admin"', ROLE_LABELS.superadmin === 'Super Admin')
check('etiqueta admin = "Administrador"', ROLE_LABELS.admin === 'Administrador')
check('etiqueta superadmin NO es "Admin"', ROLE_LABELS.superadmin !== 'Admin')

// --- #2 Edición de empresa: Super Admin sí; Admin no supera al Super Admin ---
check('superadmin edita empresa (company.edit)', can(superadmin, 'company.edit'))
check('admin NO edita empresa (company.edit)', !can(admin, 'company.edit'))
check('admin NO crea empresas', !can(admin, 'company.create'))
check('admin NO suspende empresas', !can(admin, 'company.suspend'))
// Admin no tiene ninguna capacidad corporativa que el Super Admin no tenga.
const corporate: Capability[] = ['company.create', 'company.edit', 'company.suspend', 'platform.access']
check('admin ⊆ superadmin en autoridad corporativa', corporate.every(c => !can(admin, c) || can(superadmin, c)))

// --- #5 Visibilidad jerárquica (réplica de la regla de UsersPage) ---
function visibleTo(actor: User, target: User): boolean {
  if (isRouteUnrestricted(actor)) return true
  if (target.id === actor.id) return true
  if (!canManageUser(actor, target)) return false
  const actorRoutes = new Set(authorizedRouteIdsOf(actor))
  const targetRoutes = authorizedRouteIdsOf(target)
  if (targetRoutes.length === 0) return true
  return targetRoutes.some(r => actorRoutes.has(r))
}
const otherAdmin = mkUser('admin', { authorizedRouteIds: ['r1'] })
otherAdmin.id = 'u-admin-2'
const socioR1 = mkUser('socio', { authorizedRouteIds: ['r1'] }); socioR1.id = 'u-socio-r1'
const socioR9 = mkUser('socio', { authorizedRouteIds: ['r9'] }); socioR9.id = 'u-socio-r9'
const cobradorPend = mkUser('cobrador'); cobradorPend.id = 'u-cob-pend'
check('admin NO ve Super Admin', !visibleTo(admin1, superadmin))
check('admin NO ve otro Administrador', !visibleTo(admin1, otherAdmin))
check('admin ve subordinado con ruta compartida', visibleTo(admin1, socioR1))
check('admin NO ve subordinado de ruta ajena', !visibleTo(admin1, socioR9))
check('admin ve subordinado pendiente (sin rutas)', visibleTo(admin1, cobradorPend))
check('superadmin ve a todos', visibleTo(superadmin, otherAdmin) && visibleTo(superadmin, socioR9))
// Servicios siguen bloqueando por jerarquía (edición / reset).
check('admin NO gestiona superadmin (edición/reset)', !canManageUser(admin1, superadmin))
check('admin NO gestiona otro admin', !canManageUser(admin1, otherAdmin))

// --- #6 Catálogo de capacidades en lenguaje humano (sin claves técnicas visibles) ---
const metaKeys = Object.keys(CAPABILITY_METADATA) as Capability[]
check('toda capacidad tiene metadatos', metaKeys.length >= 40)
check('ninguna etiqueta está vacía', metaKeys.every(k => CAPABILITY_METADATA[k].label.trim().length > 0))
check('ninguna etiqueta es la clave técnica', metaKeys.every(k => CAPABILITY_METADATA[k].label !== k))
check('ninguna etiqueta contiene punto (clave técnica)', metaKeys.every(k => !CAPABILITY_METADATA[k].label.includes('.')))
check('toda categoría es válida', metaKeys.every(k => CATEGORY_ORDER.includes(CAPABILITY_METADATA[k].category)))
check('toda descripción existe', metaKeys.every(k => CAPABILITY_METADATA[k].description.trim().length > 0))

// ============================================================
// ONBOARDING, VIGENCIA Y ROLES PUROS — nuevas pruebas
// ============================================================

// --- #7 MODELO PURO: can() IGNORA grantedCapabilities / revokedCapabilities ---
const socioConGrant = mkUser('socio', { authorizedRouteIds: ['r1'], grantedCapabilities: ['audit.view', 'client.create'] as Capability[] })
check('can() ignora granted (audit.view no se habilita en socio)', !can(socioConGrant, 'audit.view'))
check('can() ignora granted (escritura no se habilita en socio)', !can(socioConGrant, 'client.create', { routeId: 'r1' }))
const adminConRevoke = mkUser('admin', { authorizedRouteIds: ['r1'], revokedCapabilities: ['report.export', 'client.view'] as Capability[] })
check('can() ignora revoked (report.export sigue disponible)', can(adminConRevoke, 'report.export'))
check('can() ignora revoked (client.view sigue disponible)', can(adminConRevoke, 'client.view', { routeId: 'r1' }))
// Manipulación no rompe: cobrador con sale.createDirect sigue sin venta directa.
const cobHack = mkUser('cobrador', { authorizedRouteIds: ['r1'], grantedCapabilities: ['sale.createDirect'] as Capability[] })
check('cobrador manipulado sigue sin venta directa', !can(cobHack, 'sale.createDirect', { routeId: 'r1' }))
const socioHack = mkUser('socio', { authorizedRouteIds: ['r1'], grantedCapabilities: ['payment.register', 'transfer.create'] as Capability[] })
check('socio manipulado sigue solo lectura (pagos)', !can(socioHack, 'payment.register', { routeId: 'r1' }))
check('socio manipulado sigue solo lectura (transferencias)', !can(socioHack, 'transfer.create'))
// Rol + rutas siguen determinando el acceso.
check('rol determina acceso: cobrador registra pago en su ruta', can(cobrador, 'payment.register', { routeId: 'r1' }))
check('rutas determinan acceso: cobrador NO en ruta ajena', !can(cobrador, 'payment.register', { routeId: 'r9' }))

// --- #4 VIGENCIA (estado efectivo por fecha calendario) ---
function mkTenant(over: Partial<Tenant> = {}): Tenant {
  return { id: 't1', nombre: 'Emp', email: 'e@e.com', plan: 'profesional', status: 'activa', pais: 'Colombia', moneda: 'COP', createdAt: '', updatedAt: '', ...over }
}
const HOY = '2026-07-25'
const AYER = '2026-07-24'
const MANANA = '2026-07-26'
check('sin fecha → activa', getEffectiveCompanyStatus(mkTenant({ fechaVencimiento: undefined }), HOY) === 'activa')
check('sin fecha (prueba) → prueba', getEffectiveCompanyStatus(mkTenant({ status: 'prueba', fechaVencimiento: undefined }), HOY) === 'prueba')
check('fecha = hoy → sigue activa (inclusivo)', getEffectiveCompanyStatus(mkTenant({ fechaVencimiento: HOY }), HOY) === 'activa')
check('fecha = ayer → vencida', getEffectiveCompanyStatus(mkTenant({ fechaVencimiento: AYER }), HOY) === 'vencida')
check('fecha = mañana → activa', getEffectiveCompanyStatus(mkTenant({ fechaVencimiento: MANANA }), HOY) === 'activa')
check('vencida bloquea acceso', isCompanyBlocked(mkTenant({ fechaVencimiento: AYER }), HOY))
check('activa no bloquea', !isCompanyBlocked(mkTenant({ fechaVencimiento: MANANA }), HOY))
// Suspensión MANUAL manda sobre la fecha; no se reactiva por fecha futura.
check('suspendida NO se reactiva por fecha futura', getEffectiveCompanyStatus(mkTenant({ status: 'suspendida', fechaVencimiento: MANANA }), HOY) === 'suspendida')
check('suspendida bloquea', isCompanyBlocked(mkTenant({ status: 'suspendida' }), HOY))
// Renovación: pasar de vencida a fecha futura o sin fecha → activa.
check('renovar (fecha futura) → activa', getEffectiveCompanyStatus(mkTenant({ status: 'activa', fechaVencimiento: MANANA }), HOY) === 'activa')
check('renovar (sin vencimiento) → activa', getEffectiveCompanyStatus(mkTenant({ status: 'activa', fechaVencimiento: undefined }), HOY) === 'activa')
// suspendida ≠ vencida (estados diferenciados).
check('suspendida y vencida son estados distintos', getEffectiveCompanyStatus(mkTenant({ status: 'suspendida' }), HOY) !== getEffectiveCompanyStatus(mkTenant({ fechaVencimiento: AYER }), HOY))

// ============================================================
// AUDITORÍA DE BOTONES — lógica de "cambios sin guardar" (dirty state)
// ============================================================
// Editar Ruta / Empresa / Usuario / Cliente: abrir y cerrar sin tocar nada NO debe
// pedir confirmación; cualquier cambio de un campo o de un arreglo SÍ debe marcar dirty.
const routeOriginal = { nombre: 'Ruta Norte', ciudad: 'BAQ', cobradorId: 'c1', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, adminIds: [] as string[] }
check('dirty: abrir y cerrar sin cambios → NO dirty', !shallowDirty(routeOriginal, { ...routeOriginal }))
check('dirty: cambiar nombre → dirty', shallowDirty(routeOriginal, { ...routeOriginal, nombre: 'Ruta Sur' }))
check('dirty: cambiar número (tasa) → dirty', shallowDirty(routeOriginal, { ...routeOriginal, tasaInteres: 10 }))
check('dirty: cambiar booleano (tasaLibre) → dirty', shallowDirty(routeOriginal, { ...routeOriginal, tasaLibre: true }))
check('dirty: cambiar arreglo (adminIds) → dirty', shallowDirty(routeOriginal, { ...routeOriginal, adminIds: ['a1'] }))
check('dirty: vaciar un campo → dirty', shallowDirty(routeOriginal, { ...routeOriginal, cobradorId: '' }))
check('dirty: undefined vs "" en foto se detecta', shallowDirty({ foto: undefined }, { foto: 'data:img' }))
check('dirty: mismos valores distinto orden de claves → NO dirty', !shallowDirty({ a: 1, b: 2 }, { b: 2, a: 1 }))

// ============================================================
// EDITOR DE RUTAS TRANSACCIONAL — asignaciones como BORRADOR
// ============================================================

// --- Dirty state de asignaciones (orden-independiente) ---
const routeDraft0 = { nombre: 'R', cobradorId: 'c1', assignedUserIds: ['u1', 'u2'] as string[] }
check('CASO 6a — asignar usuario marca dirty', shallowDirty(routeDraft0, { ...routeDraft0, assignedUserIds: ['u1', 'u2', 'u3'] }))
check('CASO 6b — asignar y retirar el mismo → NO dirty', !shallowDirty(routeDraft0, { ...routeDraft0, assignedUserIds: ['u2', 'u1'] }))
check('CASO 6c — orden de asignaciones irrelevante', !shallowDirty({ assignedUserIds: ['a', 'b', 'c'] }, { assignedUserIds: ['c', 'a', 'b'] }))
check('CASO 6d — retirar usuario marca dirty', shallowDirty(routeDraft0, { ...routeDraft0, assignedUserIds: ['u1'] }))
check('CASO 6e — cambiar cobrador marca dirty', shallowDirty(routeDraft0, { ...routeDraft0, cobradorId: 'c2' }))

// --- computeRouteAssignmentDiff (lógica de CASO 3 y CASO 4) ---
const membership: Record<string, string[]> = { u1: ['rA'], u2: [], u3: ['rA', 'rB'], cob: [] }
const mOf = (id: string) => membership[id] ?? []
// CASO 3 — asignar u2 (no era miembro): aparece en added; nada en removed.
const d1 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: ['u1', 'u2'], assignedUserIds: ['u1', 'u2'], membershipOf: mOf })
check('CASO 3 — asignar u2 → added', d1.added.includes('u2') && d1.removed.length === 0)
// CASO 4 — retirar u1 (era miembro): aparece en removed.
const d2 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: ['u1', 'u2'], assignedUserIds: ['u2'], membershipOf: mOf })
check('CASO 4 — retirar u1 → removed', d2.removed.includes('u1') && d2.added.includes('u2'))
// Sin cambios → diff vacío.
const d3 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: ['u1'], assignedUserIds: ['u1'], membershipOf: mOf })
check('sin cambios → added/removed vacíos', d3.added.length === 0 && d3.removed.length === 0)
// El cobrador responsable SIEMPRE queda como miembro (auto-add).
const d4 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: [], assignedUserIds: [], cobradorId: 'cob', membershipOf: mOf })
check('cobrador responsable se agrega como miembro', d4.added.includes('cob'))
// Solo se retiran usuarios dentro del alcance (assignableUserIds); u3 no está en alcance → intacto.
const d5 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: ['u1'], assignedUserIds: [], membershipOf: mOf })
check('no toca usuarios fuera de alcance (u3 intacto)', !d5.removed.includes('u3') && d5.removed.includes('u1'))

// ============================================================
// CONSISTENCIA VISUAL Usuarios ↔ Rutas (tarjeta = authorizedRouteIds)
// ============================================================
function mkAssign(id: string, rol: UserRole, nombre: string, routes: string[], tenantId = 't1'): User {
  return { id, tenantId, nombre, email: `${id}@t.com`, password: 'x', rol, status: 'activo', authorizedRouteIds: routes, createdAt: '', updatedAt: '' }
}

// CASO 1 — cobrador con routeId en authorizedRouteIds, route.cobradorId vacío → aparece igual.
const c1Users = [mkAssign('cob', 'cobrador', '12312', ['rA'])]
const c1 = getRouteAssignmentsByRole(c1Users, 'rA', 't1')
check('CASO 1 — cobrador asignado aparece aunque route.cobradorId esté vacío', c1.cobradores.length === 1 && c1.cobradores[0].nombre === '12312')
check('CASO 1 — hay asignaciones (no "sin usuarios")', hasAnyAssignment(c1))

// CASO 2 — Administrador + Cobrador → ambos roles, orden correcto (admin antes que cobrador).
const c2Users = [mkAssign('a1', 'admin', 'Jhon', ['rA']), mkAssign('cob', 'cobrador', '12312', ['rA'])]
const c2 = getRouteAssignmentsByRole(c2Users, 'rA', 't1')
check('CASO 2 — muestra Administrador y Cobrador', c2.admins.length === 1 && c2.cobradores.length === 1)
const c2order = ASSIGNMENT_ROLE_ORDER.findIndex(g => g.rol === 'admin') < ASSIGNMENT_ROLE_ORDER.findIndex(g => g.rol === 'cobrador')
check('CASO 2 — orden de roles Admin antes que Cobrador', c2order)

// CASO 3 — todos los roles: agrupación + orden de roles + orden alfabético dentro del rol.
const c3Users = [
  mkAssign('a1', 'admin', 'Jhon', ['rA']),
  mkAssign('s1', 'socio', 'Marta', ['rA']),
  mkAssign('sp1', 'supervisor', 'Ana', ['rA']),
  mkAssign('cob2', 'cobrador', 'Juan Cobrador', ['rA']),
  mkAssign('cob1', 'cobrador', '12312', ['rA']),
  mkAssign('sec1', 'secretario', 'Laura', ['rA']),
]
const c3 = getRouteAssignmentsByRole(c3Users, 'rA', 't1')
check('CASO 3 — agrupación completa por rol', c3.admins.length === 1 && c3.socios.length === 1 && c3.supervisores.length === 1 && c3.cobradores.length === 2 && c3.secretarios.length === 1)
check('CASO 3 — orden alfabético dentro de Cobradores', c3.cobradores[0].nombre === '12312' && c3.cobradores[1].nombre === 'Juan Cobrador')
const roleKeys = ASSIGNMENT_ROLE_ORDER.map(g => g.rol)
check('CASO 3 — orden de roles Admin→Socio→Supervisor→Cobrador→Secretario', JSON.stringify(roleKeys) === JSON.stringify(['admin', 'socio', 'supervisor', 'cobrador', 'secretario']))

// Super Admin NO se lista aunque tuviera routeId manipulado.
const withSuper = [...c1Users, mkAssign('sa', 'superadmin', 'Root', ['rA'])]
check('Super Admin nunca aparece como asignado', getUsersAssignedToRoute(withSuper, 'rA', 't1').every(u => u.rol !== 'superadmin'))

// CASO 8 — usuarios de OTRO tenant no aparecen.
const c8Users = [mkAssign('cob', 'cobrador', 'Mismo', ['rA'], 't1'), mkAssign('x', 'cobrador', 'Otro', ['rA'], 't2')]
const c8 = getUsersAssignedToRoute(c8Users, 'rA', 't1')
check('CASO 8 — usuarios de otro tenant excluidos', c8.length === 1 && c8[0].nombre === 'Mismo')

// Estado vacío — ruta sin nadie asignado.
check('ruta sin asignados → hasAnyAssignment false', !hasAnyAssignment(getRouteAssignmentsByRole([], 'rZ', 't1')))

// La resolución usa authorizedRouteIds, NO route.cobradorId (no hay tal campo en User).
check('resolución por authorizedRouteIds (routeId legado también cuenta)',
  getUsersAssignedToRoute([{ ...mkAssign('c', 'cobrador', 'Leg', []), routeId: 'rA', authorizedRouteIds: undefined }], 'rA', 't1').length === 1)

console.log(`\nPRUEBA DE PERMISOS: ${passed} OK, ${failed} FALLIDAS`)
if (failed > 0) process.exit(1)
