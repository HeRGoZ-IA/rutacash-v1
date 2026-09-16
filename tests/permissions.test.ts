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
import { cobradorRemovalBlock, validateCobradorInvariant } from '../src/lib/cobradorRules'
import {
  accessibleOfficeIdsOf, hasRoutesWithoutOffice, filterRoutesByOffice, narrowRouteIdsByOffice,
  groupRoutesByOffice, officeCoverage, officeScopeLabel, officeLabelForRoute, officeNameByRouteId,
  ALL_OFFICES, NO_OFFICE, NO_OFFICE_LABEL,
} from '../src/lib/officeGrouping'
import { validateOfficeIdentity, isRouteOperationBlocked } from '../src/services/officeService'
import {
  routeOperationalState, officeKpis, officeStateSummary, officeScope, officeAlerts,
  relatedUsersOfOffice, applyOfficeRouteSelection, officeRoutesOf, unassignedRoutesOf,
  type OfficeRouteFacts,
} from '../src/lib/officeManagement'
import { readFileSync as readFileSyncForOffices } from 'node:fs'
import { resolve as resolvePathForOffices } from 'node:path'
import { resolveResponsibleCollector, hasPersonalCashbox } from '../src/lib/collectorAttribution'
import type { User, UserRole, Tenant, Office, Route } from '../src/models/types'

/** Lee un archivo de producción para verificar contratos estructurales. */
function readSourceFile(rel: string): string {
  return readFileSyncForOffices(resolvePathForOffices(process.cwd(), rel), 'utf8')
}

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

// ============================================================
// INTEGRIDAD DE COBRADORES EN RUTAS (cobradorRules)
// ============================================================
const cobA = mkAssign('cobA', 'cobrador', 'Ana Cobradora', ['rA'])
const cobB = mkAssign('cobB', 'cobrador', 'Juan Cobrador', ['rA'])
const admB = mkAssign('admB', 'admin', 'Beto Admin', ['rA'])
const byId = (list: User[]) => (id: string) => list.find(u => u.id === id)

// --- Retiro inmediato (cobradorRemovalBlock) ---
// CASO 1 — REGLA REVISADA: el último cobrador SÍ se puede retirar. La ruta queda
// "Sin Cobrador asignado" (estado válido, pendiente de asignación). Antes se
// bloqueaba con 'last-cobrador'; esa regla ya no aplica.
check('COB CASO 1 — retirar al último cobrador ya NO se bloquea',
  cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['cobA'], responsibleId: 'cobA', userId: 'cobA' }) === null)
// CASO 2 — cobrador NO responsable con otros: retiro permitido.
check('COB CASO 2 — cobrador no responsable se puede retirar',
  cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['cobA', 'cobB'], responsibleId: 'cobA', userId: 'cobB' }) === null)
// CASO 3 — responsable con otros: requiere elegir otro responsable primero.
check('COB CASO 3 — responsable con otros requiere reemplazo',
  cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['cobA', 'cobB'], responsibleId: 'cobA', userId: 'cobA' }) === 'responsible-needs-replacement')
// CASO 4 — cambiado el responsable a cobB, el anterior (cobA) ya se puede retirar.
check('COB CASO 4 — tras cambiar responsable, el anterior se puede retirar',
  cobradorRemovalBlock({ isCobrador: true, assignedCobradorIds: ['cobA', 'cobB'], responsibleId: 'cobB', userId: 'cobA' }) === null)
// Un usuario que NO es cobrador nunca se bloquea por esta regla (p. ej. Administrador).
check('COB — retirar un no-cobrador nunca bloquea',
  cobradorRemovalBlock({ isCobrador: false, assignedCobradorIds: ['cobA'], responsibleId: 'cobA', userId: 'admB' }) === null)

// --- Coherencia al guardar (validateCobradorInvariant) ---
// CASO 5 — REGLA REVISADA: cero cobradores es un estado VÁLIDO (ruta pendiente de
// asignación). Antes se rechazaba con 'no-cobrador'.
check('COB CASO 5 — cero cobradores ACEPTADO (ruta pendiente de asignación)',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['admB'], cobradorId: undefined, userById: byId([admB]) }).ok === true)
// CASO 6 — responsable FUERA de los asignados: rechazado con código específico.
const r6 = validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['cobA'], cobradorId: 'cobB', userById: byId([cobA, cobB]) })
check('COB CASO 6 — responsable fuera de asignados rechazado', r6.ok === false && (r6 as { code: string }).code === 'responsible-not-assigned')
// CASO 7 — REGLA REVISADA: crear/guardar SIN NADIE es válido (misma validación que
// aplica el servicio). Antes se rechazaba: una ruta vacía ya no es "inválida".
check('COB CASO 7 — ruta sin ningún usuario ACEPTADA',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: [], cobradorId: undefined, userById: byId([]) }).ok === true)
// Responsable inactivo → inválido.
const cobInact = mkAssign('cx', 'cobrador', 'Inact', ['rA']); cobInact.status = 'inactivo'
check('COB — responsable inactivo inválido',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['cx'], cobradorId: 'cx', userById: byId([cobInact]) }).ok === false)
// Responsable de OTRO tenant → inválido.
const cobOtro = mkAssign('cy', 'cobrador', 'Otro', ['rA'], 't2')
check('COB — responsable de otro tenant inválido',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['cy'], cobradorId: 'cy', userById: byId([cobOtro]) }).ok === false)
// Responsable designado pero SIN asignar → inválido (incoherencia, no ausencia).
check('COB — responsable designado fuera de asignados inválido',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: [], cobradorId: 'cobA', userById: byId([cobA]) }).ok === false)
// Responsable que no es cobrador (rol admin) → inválido.
check('COB — responsable con rol no-cobrador inválido',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['admB'], cobradorId: 'admB', userById: byId([admB]) }).ok === false)
// Caso VÁLIDO: exactamente un cobrador responsable asignado y activo.
check('COB — invariante válido (1 cobrador responsable)',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['cobA'], cobradorId: 'cobA', userById: byId([cobA]) }).ok === true)
// CASO 10 — ruta sin Administrador pero CON cobrador: el invariante de cobrador PASA
// (la regla de Administrador es independiente: permite cero con advertencia).
check('COB CASO 10 — invariante cobrador OK aunque no haya Administrador',
  validateCobradorInvariant({ routeTenantId: 't1', assignedUserIds: ['cobA'], cobradorId: 'cobA', userById: byId([cobA]) }).ok === true)

// CASO 8 — cambiar responsable marca dirty (Cancelar pediría descartar → restaura original).
check('COB CASO 8 — cambiar responsable marca dirty',
  shallowDirty({ cobradorId: 'cobA', assignedUserIds: ['cobA'] }, { cobradorId: 'cobB', assignedUserIds: ['cobA', 'cobB'] }))
// CASO 9 — al Actualizar, el diff agrega el nuevo cobrador asignado (persistencia real).
const c9m: Record<string, string[]> = { cobA: ['rA'], cobB: [] }
const d9 = computeRouteAssignmentDiff({ routeId: 'rA', assignableUserIds: ['cobA', 'cobB'], assignedUserIds: ['cobA', 'cobB'], cobradorId: 'cobB', prevCobradorId: 'cobA', membershipOf: (id) => c9m[id] ?? [] })
check('COB CASO 9 — actualizar agrega el nuevo cobrador asignado', d9.added.includes('cobB') && d9.removed.length === 0)

// ============================================================
// RQ-05 — CAJA DEL COBRADOR: SU RECAUDO, NO LA CAJA DE LA RUTA
// ------------------------------------------------------------
// El Cobrador pierde `cashbox.viewRoute` (caja FINANCIERA de la ruta, capital
// incluido) y gana `cashbox.viewOwnCollection` (su efectivo del dia). Los roles
// administrativos conservan intactas sus capacidades financieras.
// ============================================================

// --- COBRADOR: sin caja financiera de ruta ---
check('cobrador NO ve la caja financiera de la ruta', !can(cobrador, 'cashbox.viewRoute', { routeId: 'r1' }))
check('cobrador NO ve caja consolidada', !can(cobrador, 'cashbox.viewConsolidated'))
check('cashbox.viewRoute es INCOMPATIBLE con cobrador', !isCapabilityCompatible('cobrador', 'cashbox.viewRoute'))
const cobCajaHack = mkUser('cobrador', { authorizedRouteIds: ['r1'], grantedCapabilities: ['cashbox.viewRoute', 'cashbox.viewConsolidated'] as Capability[] })
check('grant NO habilita caja de ruta en Cobrador', !can(cobCajaHack, 'cashbox.viewRoute', { routeId: 'r1' }))
check('sanitize elimina cashbox.viewRoute del Cobrador', sanitizeGrantedCapabilities('cobrador', ['cashbox.viewRoute'] as Capability[]).length === 0)

// --- COBRADOR: SI tiene su caja personal ---
check('cobrador ve su propia caja de recaudo', can(cobrador, 'cashbox.viewOwnCollection', { routeId: 'r1' }))
check('cobrador conserva el cuadre diario', can(cobrador, 'cashbox.dailyClose', { routeId: 'r1' }))
check('la caja personal esta limitada por ruta', !can(cobrador, 'cashbox.viewOwnCollection', { routeId: 'r9' }))
const cobSinRutas = mkUser('cobrador', { authorizedRouteIds: [] })
check('cobrador sin rutas NO ve ni su caja personal', !can(cobSinRutas, 'cashbox.viewOwnCollection', { routeId: 'r1' }))

// --- ROLES ADMINISTRATIVOS: conservan lo suyo ---
check('admin conserva la caja de ruta', can(admin, 'cashbox.viewRoute', { routeId: 'r1' }))
check('admin conserva la caja consolidada', can(admin, 'cashbox.viewConsolidated'))
check('supervisor conserva la caja de ruta', can(supervisor, 'cashbox.viewRoute', { routeId: 'r1' }))
check('superadmin conserva la caja de ruta', can(superadmin, 'cashbox.viewRoute', { routeId: 'r1' }))
check('superadmin conserva la caja consolidada', can(superadmin, 'cashbox.viewConsolidated'))
check('admin sin rutas sigue sin ver caja de ruta', !can(adminNoRoutes, 'cashbox.viewRoute', { routeId: 'r1' }))
// El Supervisor tambien recauda en la calle: tiene caja personal.
check('supervisor tiene caja personal de recaudo', can(supervisor, 'cashbox.viewOwnCollection', { routeId: 'r1' }))

// --- ROLES SIN CAJA: siguen sin ella ---
check('secretario NO tiene caja personal', !can(secretario, 'cashbox.viewOwnCollection', { routeId: 'r1' }))
check('socio NO tiene caja personal', !can(socio, 'cashbox.viewOwnCollection', { routeId: 'r1' }))
check('caja personal INCOMPATIBLE con secretario', !isCapabilityCompatible('secretario', 'cashbox.viewOwnCollection'))
check('caja personal INCOMPATIBLE con socio', !isCapabilityCompatible('socio', 'cashbox.viewOwnCollection'))
check('socio conserva su consulta de caja de ruta', can(socio, 'cashbox.viewRoute', { routeId: 'r1' }))

// --- Catalogo humano ---
check('la nueva capacidad tiene etiqueta humana', !!CAPABILITY_METADATA['cashbox.viewOwnCollection'] && !CAPABILITY_METADATA['cashbox.viewOwnCollection'].label.includes('.'))

// ============================================================
// RQ-05 — ATRIBUCION DEL RECAUDO: REGISTRAR != RESPONDER POR EL DINERO

// ============================================================
// OFICINAS — SCOPING DERIVADO Y CONTRATO DE ARQUITECTURA
// ------------------------------------------------------------
// La regla que estos casos existen para proteger:
//
//     accessibleOffices = Oficinas presentes en accessibleRoutes
//
// y NUNCA a la inversa. Una Oficina solo puede ESTRECHAR un conjunto de rutas ya
// permitido; jamás ampliarlo. Si alguien invirtiera esa dirección, aquí se cae.
// ============================================================
const mkRoute = (id: string, officeId?: string, nombre = id): Route =>
  ({ id, tenantId: 't1', officeId, nombre, codigo: id.toUpperCase(), tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 1, capitalInicial: 0, capitalActual: 0, status: 'activa', createdAt: '', updatedAt: '' }) as Route

const mkOffice = (id: string, nombre: string, status: Office['status'] = 'activa'): Office =>
  ({ id, tenantId: 't1', nombre, status, createdAt: '', updatedAt: '' })

const OF_LETICIA = mkOffice('of-let', 'Leticia')
const OF_RIO = mkOffice('of-rio', 'Río')
const OFICINAS = [OF_LETICIA, OF_RIO]

// Empresa: Leticia tiene 3 rutas, Río tiene 2, y hay 1 ruta sin Oficina.
const TODAS_LAS_RUTAS = [
  mkRoute('r-L1', 'of-let', 'Centro'), mkRoute('r-L2', 'of-let', 'Norte'), mkRoute('r-L3', 'of-let', 'Sur'),
  mkRoute('r-R1', 'of-rio', 'Puerto'), mkRoute('r-R2', 'of-rio', 'Mercado'),
  mkRoute('r-X', undefined, 'Antigua'),
]

// OFFICE-SCOPE-001 — un usuario con rutas en dos Oficinas ve exactamente esas dos.
const fabio = mkUser('cobrador', { id: 'u-fabio', authorizedRouteIds: ['r-L1', 'r-R1'] })
const rutasDeFabio = filterAccessibleRoutes(fabio, TODAS_LAS_RUTAS)
const oficinasDeFabio = accessibleOfficeIdsOf(rutasDeFabio)
check('OFFICE-SCOPE-001 — rutas en dos Oficinas → ve las dos Oficinas',
  oficinasDeFabio.size === 2 && oficinasDeFabio.has('of-let') && oficinasDeFabio.has('of-rio'))

// OFFICE-SCOPE-002 — LA REGLA CRÍTICA: tener 1 ruta de Leticia NO da las otras 2.
check('OFFICE-SCOPE-002 — una ruta de una Oficina NO concede las demás rutas de esa Oficina',
  rutasDeFabio.length === 2 &&
  rutasDeFabio.every(r => r.id === 'r-L1' || r.id === 'r-R1') &&
  !rutasDeFabio.some(r => r.id === 'r-L2' || r.id === 'r-L3' || r.id === 'r-R2'))
check('OFFICE-SCOPE-002b — canAccessRoute sigue negando las hermanas de la misma Oficina',
  canAccessRoute(fabio, 'r-L1') && !canAccessRoute(fabio, 'r-L2') && !canAccessRoute(fabio, 'r-L3'))

// OFFICE-SCOPE-003 — las Oficinas se DERIVAN de las rutas, no se consultan aparte.
const soloSinOficina = mkUser('cobrador', { id: 'u-x', authorizedRouteIds: ['r-X'] })
const rutasSinOf = filterAccessibleRoutes(soloSinOficina, TODAS_LAS_RUTAS)
check('OFFICE-SCOPE-003 — sin rutas con Oficina, el conjunto de Oficinas es vacío',
  accessibleOfficeIdsOf(rutasSinOf).size === 0 && hasRoutesWithoutOffice(rutasSinOf))

// OFFICE-SCOPE-004 — el fail-closed del Administrador no cambia con Oficinas.
const adminSinRutas = mkUser('admin', { id: 'u-adm0', authorizedRouteIds: undefined })
check('OFFICE-SCOPE-004 — Admin sin rutas sigue fail-closed aunque existan Oficinas',
  filterAccessibleRoutes(adminSinRutas, TODAS_LAS_RUTAS).length === 0 &&
  accessibleOfficeIdsOf(filterAccessibleRoutes(adminSinRutas, TODAS_LAS_RUTAS)).size === 0 &&
  !hasOperationalRoutes(adminSinRutas))

// OFFICE-SCOPE-005 — el Cobrador solo opera sus rutas, elija la Oficina que elija.
check('OFFICE-SCOPE-005 — el Cobrador no registra pagos en rutas hermanas de su Oficina',
  can(fabio, 'payment.register', { routeId: 'r-L1' }) &&
  !can(fabio, 'payment.register', { routeId: 'r-L2' }))

// OFFICE-SCOPE-006 — gestionar el CATÁLOGO no concede acceso a los datos.
const adminGestor = mkUser('admin', { id: 'u-adm1', authorizedRouteIds: ['r-L1'] })
check('OFFICE-SCOPE-006 — el Admin gestiona Oficinas pero no accede a rutas ajenas',
  can(adminGestor, 'office.create') && can(adminGestor, 'office.edit') &&
  can(adminGestor, 'office.delete') && can(adminGestor, 'office.changeStatus') &&
  !canAccessRoute(adminGestor, 'r-L2') && !canAccessRoute(adminGestor, 'r-L3'))

// Las capacidades de catálogo NO se reparten a los roles operativos ni de consulta.
for (const rol of ['cobrador', 'secretario', 'socio', 'supervisor'] as UserRole[]) {
  const u = mkUser(rol, { authorizedRouteIds: ['r-L1'] })
  check(`OFFICE-SCOPE-006b — ${rol} no gestiona Oficinas`,
    !can(u, 'office.create') && !can(u, 'office.edit') &&
    !can(u, 'office.delete') && !can(u, 'office.changeStatus'))
}

// El Super Admin, al no estar limitado por rutas, ve todas las Oficinas con rutas.
check('OFFICE-SCOPE-007 — el Super Admin ve todas las Oficinas con rutas de la empresa',
  accessibleOfficeIdsOf(filterAccessibleRoutes(superadmin, TODAS_LAS_RUTAS)).size === 2)

// --- Filtro por Oficina: SOLO estrecha ---
check('OFFICE-SCOPE-008 — "Todas las oficinas" no altera el conjunto',
  filterRoutesByOffice(rutasDeFabio, ALL_OFFICES).length === rutasDeFabio.length)
check('OFFICE-SCOPE-009 — filtrar por Oficina nunca devuelve rutas no accesibles',
  filterRoutesByOffice(rutasDeFabio, 'of-let').every(r => r.id === 'r-L1'))
check('OFFICE-SCOPE-010 — "Sin Oficina" selecciona solo las rutas sin Oficina',
  filterRoutesByOffice(TODAS_LAS_RUTAS, NO_OFFICE).length === 1 &&
  filterRoutesByOffice(TODAS_LAS_RUTAS, NO_OFFICE)[0].id === 'r-X')

// `narrowRouteIdsByOffice` parte SIEMPRE del alcance: no puede inventar rutas.
const alcanceFabio = new Set(['r-L1', 'r-R1'])
check('OFFICE-SCOPE-011 — estrechar por Oficina no puede ampliar el alcance',
  narrowRouteIdsByOffice(alcanceFabio, TODAS_LAS_RUTAS, 'of-let').size === 1 &&
  narrowRouteIdsByOffice(alcanceFabio, TODAS_LAS_RUTAS, 'of-let').has('r-L1') &&
  narrowRouteIdsByOffice(alcanceFabio, TODAS_LAS_RUTAS, ALL_OFFICES).size === 2)

// --- Agrupación ---
const gruposFabio = groupRoutesByOffice(rutasDeFabio, OFICINAS)
check('OFFICE-SCOPE-012 — la agrupación solo contiene rutas accesibles',
  gruposFabio.flatMap(g => g.routes).length === 2)
const gruposTodos = groupRoutesByOffice(TODAS_LAS_RUTAS, OFICINAS)
check('OFFICE-SCOPE-013 — "Sin Oficina" va siempre al final',
  gruposTodos[gruposTodos.length - 1].key === NO_OFFICE)
check('OFFICE-SCOPE-014 — las Oficinas se ordenan alfabéticamente',
  gruposTodos[0].label === 'Leticia' && gruposTodos[1].label === 'Río')
check('OFFICE-SCOPE-015 — una Oficina inexistente no hace desaparecer su ruta',
  groupRoutesByOffice([mkRoute('r-huerfana', 'of-borrada')], OFICINAS).flatMap(g => g.routes).length === 1)

// --- Consolidado parcial rotulado con honestidad ---
check('OFFICE-CONS-001 — cobertura completa no se rotula como parcial',
  officeScopeLabel('Leticia', officeCoverage(3, 3)) === 'Leticia')
check('OFFICE-CONS-002 — cobertura parcial se rotula como parcial',
  officeScopeLabel('Leticia', officeCoverage(1, 3)).includes('1 de 3') &&
  officeScopeLabel('Leticia', officeCoverage(1, 3)).includes('rutas autorizadas'))

// --- Derivación de la Oficina de una ruta (para etiquetas y CSV) ---
check('OFFICE-DERIVE-001 — la Oficina se deriva de la ruta',
  officeLabelForRoute(TODAS_LAS_RUTAS[0], OFICINAS) === 'Leticia')
check('OFFICE-DERIVE-002 — una ruta sin Oficina se etiqueta "Sin Oficina"',
  officeLabelForRoute(TODAS_LAS_RUTAS[5], OFICINAS) === NO_OFFICE_LABEL)
const mapaOficinas = officeNameByRouteId(TODAS_LAS_RUTAS, OFICINAS)
check('OFFICE-DERIVE-003 — el mapa routeId→Oficina cubre también las rutas sin Oficina',
  mapaOficinas.get('r-L1') === 'Leticia' && mapaOficinas.get('r-X') === NO_OFFICE_LABEL)

// --- Guarda de Oficina inactiva (decisión PURA) ---
check('OFFICE-STATUS-000a — Oficina activa no bloquea', !isRouteOperationBlocked(OF_LETICIA))
check('OFFICE-STATUS-000b — Oficina inactiva bloquea', isRouteOperationBlocked(mkOffice('of-x', 'X', 'inactiva')))
check('OFFICE-STATUS-000c — sin Oficina no hay bloqueo por Oficina', !isRouteOperationBlocked(undefined))

// --- Unicidad de nombre y código dentro de la empresa ---
const EXISTENTES = [
  { id: 'of-1', nombre: 'Oficina Leticia', codigo: 'LET' },
  { id: 'of-2', nombre: 'Oficina Río', codigo: undefined },
]
check('OFFICE-CRUD-002 — nombre duplicado (distinta caja y espacios) se rechaza',
  validateOfficeIdentity({ nombre: '  oficina LETICIA ', existentes: EXISTENTES }).ok === false)
check('OFFICE-CRUD-002b — nombre nuevo se acepta',
  validateOfficeIdentity({ nombre: 'Oficina Malambo', existentes: EXISTENTES }).ok === true)
check('OFFICE-CRUD-004 — código duplicado sin distinguir mayúsculas se rechaza',
  validateOfficeIdentity({ nombre: 'Otra', codigo: 'let', existentes: EXISTENTES }).ok === false)
check('OFFICE-CRUD-004b — código libre se acepta',
  validateOfficeIdentity({ nombre: 'Otra', codigo: 'MAL', existentes: EXISTENTES }).ok === true)
check('OFFICE-CRUD-004c — el código es opcional',
  validateOfficeIdentity({ nombre: 'Otra', existentes: EXISTENTES }).ok === true)
check('OFFICE-CRUD-002c — al editar, la propia Oficina no colisiona consigo misma',
  validateOfficeIdentity({ nombre: 'Oficina Leticia', codigo: 'LET', existentes: EXISTENTES, excludeId: 'of-1' }).ok === true)
check('OFFICE-CRUD-008 — el nombre es obligatorio',
  validateOfficeIdentity({ nombre: '   ', existentes: [] }).ok === false)

// ============================================================
// CONTRATO DE ARQUITECTURA — verificado sobre el código fuente real
// ============================================================

// OFFICE-MODEL-003 — SOLO Route puede tener officeId.
{
  const types = readSourceFile('src/models/types.ts')
  const ocurrencias = (types.match(/officeId\?: string/g) ?? []).length
  check('OFFICE-MODEL-003 — officeId existe exactamente una vez en el modelo (Route)', ocurrencias === 1)
  const bloqueRoute = types.slice(types.indexOf('export interface Route {'), types.indexOf('export interface User {'))
  check('OFFICE-MODEL-003b — ese único officeId pertenece a Route', bloqueRoute.includes('officeId?: string'))
}

// OFFICE-USER-002 — User no tiene officeId ni officeIds, ni nadie los escribe.
{
  const types = readSourceFile('src/models/types.ts')
  const bloqueUser = types.slice(types.indexOf('export interface User {'), types.indexOf('export interface Client {'))
  // Se busca la DECLARACIÓN del campo. La palabra puede aparecer en un comentario
  // que explique justamente por qué el campo no existe.
  check('OFFICE-USER-002 — User no declara officeId', !/^\s*officeId\??:/m.test(bloqueUser))
  check('OFFICE-USER-002b — no existe officeIds en ninguna parte del modelo', !types.includes('officeIds'))
  const tenantHook = readSourceFile('src/hooks/useTenant.ts')
  check('OFFICE-USER-002c — useTenant no devuelve officeId', !/^\s*officeId:/m.test(tenantHook))
}

// OFFICE-ARCH-001 — ninguna escritura copia Route.officeId a otra entidad.
{
  const SOSPECHOSOS = [
    'src/services/routeService.ts', 'src/services/saleRequestService.ts',
    'src/pages/admin/ActiveSalesPage.tsx', 'src/pages/admin/ClientsPage.tsx',
    'src/pages/admin/CapitalPage.tsx', 'src/pages/admin/ExpensesPage.tsx',
    'src/pages/admin/WithdrawalsPage.tsx', 'src/pages/admin/TransfersPage.tsx',
    'src/pages/collector/CollectorExpensesPage.tsx', 'src/pages/collector/CollectorNewClientPage.tsx',
    'src/pages/collector/CollectorNewSalePage.tsx',
  ]
  // Patrón prohibido: DERIVAR la Oficina desde otra entidad para guardarla en una
  // nueva. `Route` es la única dueña del campo, así que su propia asignación
  // (`officeId: input.officeId` dentro del literal `const route: Route = {`) es
  // legítima y se comprueba aparte.
  const derivacion = /officeId:\s*(route\??\.|client\??\.|user\??\.|sale\??\.|form\.officeId\s*\?\?)/
  const infractores = SOSPECHOSOS.filter(f => derivacion.test(readSourceFile(f)))
  check('OFFICE-ARCH-001 — nadie deriva Route.officeId hacia clientes/ventas/gastos/etc.',
    infractores.length === 0)

  // Y en routeService la ÚNICA asignación de officeId es la de la propia Route.
  const rs = readSourceFile('src/services/routeService.ts')
  const asignaciones = (rs.match(/officeId:\s*[^,\n}]+/g) ?? [])
    .filter(a => !a.includes('officeId: input.officeId')
              && !a.includes('officeId: route.officeId ?? null')
              && !a.includes('officeId: params.officeId')
              && !a.includes('officeId: prevRoute.officeId')
              && !a.includes("officeId: input.officeId ?? null"))
  check('OFFICE-ARCH-001b — routeService solo asigna officeId a la propia Route',
    asignaciones.length === 0)

  // Ninguna entidad operativa vuelve a declarar el campo.
  const tiposFuente = readSourceFile('src/models/types.ts')
  const ENTIDADES_SIN_OFICINA = ['Client', 'Sale', 'Payment', 'Installment', 'Expense',
    'CapitalMovement', 'Transfer', 'Withdrawal', 'WeeklySettlement', 'SaleRequest']
  const conCampo = ENTIDADES_SIN_OFICINA.filter(nombre => {
    const ini = tiposFuente.indexOf(`export interface ${nombre} {`)
    if (ini === -1) return false
    const fin = tiposFuente.indexOf('\n}', ini)
    return /^\s*officeId\??:/m.test(tiposFuente.slice(ini, fin))
  })
  check('OFFICE-ARCH-001c — ninguna entidad operativa declara officeId',
    conCampo.length === 0)
}

// OFFICE-ARCH-002 — permissions.ts no usa Office para resolver acceso.
{
  const perms = readSourceFile('src/lib/permissions.ts')
  const cuerpoScoping = perms.slice(perms.indexOf('export function authorizedRouteIdsOf'))
  check('OFFICE-ARCH-002 — el scoping por rutas no menciona officeId en su lógica',
    !/officeId/.test(cuerpoScoping))
  check('OFFICE-ARCH-002b — permissions.ts no importa nada de oficinas',
    !perms.includes("from '@/lib/officeGrouping'") && !perms.includes("from '@/services/officeService'"))
  // El módulo de agrupación jamás debe recibir una Oficina y devolver sus rutas.
  const grouping = readSourceFile('src/lib/officeGrouping.ts')
  check('OFFICE-ARCH-002c — officeGrouping no consulta la base de datos',
    !grouping.includes("from '@/lib/db'"))
}


// ============================================================
// OFICINA COMO UNIDAD DE GESTIÓN — lógica pura
// ------------------------------------------------------------
// Entrar a una Oficina no puede conceder nada. Todo lo que se muestra dentro
// (indicadores, alertas, usuarios relacionados) se calcula sobre las rutas ya
// autorizadas; estas funciones no tienen forma de ver ninguna otra.
// ============================================================

// --- Estado operativo DERIVADO (sin persistir nada nuevo) ---
check('OFFICE-DASH-002a — sin cobradores ni responsable → sin-cobrador',
  routeOperationalState({ status: 'activa', assignedCobradorIds: [], cobradorId: undefined }) === 'sin-cobrador')
check('OFFICE-DASH-002b — con cobrador asignado → operativa',
  routeOperationalState({ status: 'activa', assignedCobradorIds: ['c1'], cobradorId: undefined }) === 'operativa')
check('OFFICE-DASH-002c — solo con responsable legado → operativa',
  routeOperationalState({ status: 'activa', assignedCobradorIds: [], cobradorId: 'c1' }) === 'operativa')
check('OFFICE-DASH-003 — la ruta inactiva manda sobre la falta de cobrador',
  routeOperationalState({ status: 'inactiva', assignedCobradorIds: [], cobradorId: undefined }) === 'inactiva')

// --- Indicadores: SOLO agregan lo que se les pasa ---
const factOf = (over: Partial<OfficeRouteFacts> & { routeId: string }): OfficeRouteFacts => ({
  nombre: over.routeId, state: 'operativa', clientesActivos: 0, ventasActivas: 0,
  desembolsosPendientes: 0, carteraEnCalle: 0, ...over,
})

const FACTS_VISIBLES: OfficeRouteFacts[] = [
  factOf({ routeId: 'r-A1', nombre: 'Centro', clientesActivos: 10, ventasActivas: 8, carteraEnCalle: 500_000 }),
  factOf({ routeId: 'r-A2', nombre: 'Mercado', state: 'sin-cobrador', clientesActivos: 4, ventasActivas: 3, desembolsosPendientes: 2, carteraEnCalle: 200_000 }),
  factOf({ routeId: 'r-A3', nombre: 'Vieja', state: 'inactiva', clientesActivos: 1, ventasActivas: 0 }),
]

const KPIS = officeKpis(FACTS_VISIBLES)
check('OFFICE-DASH-001a — los indicadores cuentan solo las rutas recibidas',
  KPIS.rutasVisibles === 3 && KPIS.clientesActivos === 15 && KPIS.ventasActivas === 11)
check('OFFICE-DASH-001b — una ruta NO incluida no puede aparecer en los indicadores',
  officeKpis(FACTS_VISIBLES.filter(f => f.routeId !== 'r-A2')).clientesActivos === 11)
check('OFFICE-DASH-002 — las rutas sin Cobrador se cuentan aparte',
  KPIS.rutasSinCobrador === 1 && KPIS.rutasOperativas === 1 && KPIS.rutasInactivas === 1)
check('OFFICE-DASH-004 — desembolsos pendientes y cartera se agregan',
  KPIS.desembolsosPendientes === 2 && KPIS.carteraEnCalle === 700_000)
check('OFFICE-DASH-005 — una Oficina sin rutas visibles da indicadores en cero',
  officeKpis([]).rutasVisibles === 0 && officeKpis([]).clientesActivos === 0)
check('OFFICE-DASH-006 — el resumen operativo es legible',
  officeStateSummary(KPIS).includes('3 ruta(s)') && officeStateSummary(KPIS).includes('1 sin Cobrador'))

// --- Alcance honesto ---
check('OFFICE-DASH-007a — cobertura completa no se rotula como parcial',
  officeScope(3, 3).parcial === false && !officeScope(3, 3).label.includes('de 3'))
check('OFFICE-DASH-007b — cobertura parcial lo dice explícitamente',
  officeScope(3, 5).parcial === true &&
  officeScope(3, 5).label === '3 de 5 rutas visibles — rutas autorizadas')

// --- Alertas DERIVADAS (sin tabla nueva) ---
const ALERTAS = officeAlerts({ office: { nombre: 'Leticia', status: 'activa' }, facts: FACTS_VISIBLES })
check('OFFICE-ALERT-001 — una ruta sin Cobrador genera alerta',
  ALERTAS.some(a => a.kind === 'sin-cobrador' && a.routeId === 'r-A2'))
check('OFFICE-ALERT-001b — la alerta nombra la ruta',
  ALERTAS.find(a => a.kind === 'sin-cobrador')?.mensaje.includes('Mercado') === true)
check('OFFICE-ALERT-002 — una ruta normal NO genera alerta',
  !ALERTAS.some(a => a.routeId === 'r-A1'))
check('OFFICE-ALERT-003 — la ruta inactiva genera su propia alerta',
  ALERTAS.some(a => a.kind === 'ruta-inactiva' && a.routeId === 'r-A3'))
check('OFFICE-ALERT-004 — los desembolsos pendientes generan alerta con su conteo',
  ALERTAS.some(a => a.kind === 'desembolsos-pendientes' && a.mensaje.includes('2 desembolso')))
check('OFFICE-ALERT-005 — la Oficina inactiva se avisa como error, no como aviso menor',
  officeAlerts({ office: { nombre: 'Leticia', status: 'inactiva' }, facts: [] })
    .some(a => a.kind === 'oficina-inactiva' && a.severity === 'error'))
check('OFFICE-ALERT-006 — sin problemas no hay alertas inventadas',
  officeAlerts({ office: { nombre: 'Leticia', status: 'activa' }, facts: [factOf({ routeId: 'r-ok' })] }).length === 0)

// --- Usuarios RELACIONADOS (derivados de authorizedRouteIds) ---
const RUTAS_LETICIA = [{ id: 'r-L1', nombre: 'Centro' }, { id: 'r-L2', nombre: 'Norte' }]
const fabioMulti = mkUser('cobrador', { id: 'u-fabio', nombre: 'Fabio', authorizedRouteIds: ['r-L1', 'r-L2', 'r-R1'] })
const lauraSolo = mkUser('supervisor', { id: 'u-laura', nombre: 'Laura', authorizedRouteIds: ['r-L1'] })
const ajeno = mkUser('cobrador', { id: 'u-ajeno', nombre: 'Ajeno', authorizedRouteIds: ['r-R1'] })
const root = mkUser('superadmin', { id: 'u-root', nombre: 'Root' })

const RELACIONADOS = relatedUsersOfOffice([fabioMulti, lauraSolo, ajeno, root], RUTAS_LETICIA, 't1')
check('OFFICE-MGMT-010a — solo aparecen usuarios con rutas EN esta Oficina',
  RELACIONADOS.length === 2 && RELACIONADOS.every(u => u.id !== 'u-ajeno'))
check('OFFICE-MGMT-010b — de un usuario multi-Oficina se muestran SOLO sus rutas de aquí',
  RELACIONADOS.find(u => u.id === 'u-fabio')?.routes.length === 2 &&
  !RELACIONADOS.find(u => u.id === 'u-fabio')?.routes.some(r => r.id === 'r-R1'))
check('OFFICE-MGMT-010c — el Super Admin no se lista como asignado',
  !RELACIONADOS.some(u => u.id === 'u-root'))
check('OFFICE-MGMT-010d — se conserva el rol para mostrarlo',
  RELACIONADOS.find(u => u.id === 'u-laura')?.rol === 'supervisor')
check('OFFICE-MGMT-010e — usuarios de otra empresa no se relacionan',
  relatedUsersOfOffice([{ ...fabioMulti, tenantId: 't2' }], RUTAS_LETICIA, 't1').length === 0)

// --- EDICIÓN DE ASIGNACIONES DESDE UNA OFICINA (el caso más delicado) ---
// Fabio: Leticia/Centro + Leticia/Norte + Río/Puerto.
const ACTUALES = ['r-L1', 'r-L2', 'r-R1']
const RUTAS_DE_LETICIA = ['r-L1', 'r-L2']

{
  // Se desmarca Centro desde Leticia. Puerto (de Río) NO puede perderse.
  const resultado = applyOfficeRouteSelection(ACTUALES, RUTAS_DE_LETICIA, ['r-L2'])
  check('OFFICE-MGMT-009 — editar desde una Oficina NO borra rutas de otras',
    resultado.includes('r-R1') && resultado.includes('r-L2') && !resultado.includes('r-L1'))
}
{
  // Se desmarca TODO en Leticia: el usuario conserva Río.
  const resultado = applyOfficeRouteSelection(ACTUALES, RUTAS_DE_LETICIA, [])
  check('OFFICE-MGMT-009b — vaciar una Oficina deja intactas las demás',
    resultado.length === 1 && resultado[0] === 'r-R1')
}
{
  // Se agrega una ruta nueva de Leticia.
  const resultado = applyOfficeRouteSelection(['r-L1', 'r-R1'], RUTAS_DE_LETICIA, ['r-L1', 'r-L2'])
  check('OFFICE-MGMT-003 — asignar una ruta añade su routeId y nada más',
    resultado.length === 3 && resultado.includes('r-L2') && resultado.includes('r-R1'))
}
{
  // Una ruta ajena colada en la selección no puede entrar.
  const resultado = applyOfficeRouteSelection(ACTUALES, RUTAS_DE_LETICIA, ['r-L1', 'r-INTRUSA'])
  check('OFFICE-MGMT-009c — una ruta fuera de la Oficina no puede colarse en la selección',
    !resultado.includes('r-INTRUSA'))
}
{
  // Idempotencia: guardar sin cambios no altera nada.
  const resultado = applyOfficeRouteSelection(ACTUALES, RUTAS_DE_LETICIA, ['r-L1', 'r-L2'])
  check('OFFICE-MGMT-009d — guardar sin cambios no altera las asignaciones',
    resultado.length === 3 && ACTUALES.every(id => resultado.includes(id)))
}
{
  // Un usuario sin nada previo queda solo con lo marcado aquí.
  const resultado = applyOfficeRouteSelection([], RUTAS_DE_LETICIA, ['r-L1'])
  check('OFFICE-MGMT-009e — un usuario sin rutas previas recibe solo lo marcado',
    resultado.length === 1 && resultado[0] === 'r-L1')
}
{
  // Rutas Sin Oficina del usuario tampoco se tocan al editar una Oficina.
  const resultado = applyOfficeRouteSelection(['r-L1', 'r-SIN'], RUTAS_DE_LETICIA, [])
  check('OFFICE-MGMT-009f — las rutas Sin Oficina del usuario se conservan',
    resultado.length === 1 && resultado[0] === 'r-SIN')
}

// OFFICE-MGMT-004 — pertenecer/entrar a una Oficina no amplía el acceso.
{
  const rutasEmpresa = [
    { id: 'r-L1', officeId: 'of-let' }, { id: 'r-L2', officeId: 'of-let' },
    { id: 'r-L3', officeId: 'of-let' }, { id: 'r-R1', officeId: 'of-rio' },
  ] as never[]
  const admin2 = mkUser('admin', { id: 'u-adm2', authorizedRouteIds: ['r-L1'] })
  const accesibles = filterAccessibleRoutes(admin2, rutasEmpresa)
  const enLeticia = officeRoutesOf(accesibles as unknown as { officeId?: string; id: string }[], 'of-let')
  check('OFFICE-MGMT-004 — entrar a una Oficina no concede sus demás rutas',
    enLeticia.length === 1 && enLeticia[0].id === 'r-L1')
  check('OFFICE-MGMT-004b — y el fail-closed sigue negando las hermanas',
    !canAccessRoute(admin2, 'r-L2') && !canAccessRoute(admin2, 'r-L3'))
}

// --- "SIN OFICINA" es una agrupación derivada, no un registro ---
{
  const rutas = [
    { id: 'r-1', officeId: 'of-let' }, { id: 'r-2', officeId: undefined }, { id: 'r-3', officeId: undefined },
  ]
  check('OFFICE-UNASSIGNED-001 — "Sin Oficina" deriva de officeId undefined',
    unassignedRoutesOf(rutas).length === 2 &&
    unassignedRoutesOf(rutas).every(r => !r.officeId))
  check('OFFICE-UNASSIGNED-001b — solo puede contener rutas ya accesibles',
    unassignedRoutesOf(filterAccessibleRoutes(
      mkUser('admin', { id: 'u-a', authorizedRouteIds: ['r-2'] }),
      rutas.map(r => ({ ...r, id: r.id })) as never[],
    ) as unknown as { officeId?: string }[]).length === 1)

  // No existe ningún registro Office llamado "Sin Oficina" en el código.
  const pagina = readSourceFile('src/pages/admin/UnassignedRoutesPage.tsx')
  const servicio = readSourceFile('src/services/officeService.ts')
  check('OFFICE-UNASSIGNED-002 — no se crea ninguna Office "Sin Oficina"',
    !/createOffice\(\s*\{[^}]*Sin Oficina/.test(pagina) && !/nombre:\s*['"]Sin Oficina['"]/.test(servicio))
  check('OFFICE-UNASSIGNED-002b — la vista parte del scoping, no de la Oficina',
    pagina.includes('unassignedRoutesOf(filterAccessibleRoutes(user, all))'))
}

// --- El resumen de gestión respeta el orden de recorte (contrato de código) ---
{
  const svc = readSourceFile('src/services/officeService.ts')
  const cuerpo = svc.slice(svc.indexOf('export async function getOfficeManagementSummary'))
  const iCarga = cuerpo.indexOf("database.routes.where('tenantId')")
  const iRecorte = cuerpo.indexOf('filterAccessibleRoutes(user, allRoutes)')
  const iOficina = cuerpo.indexOf("accessible.filter(r => r.officeId === officeId)")
  check('OFFICE-DASH-008 — el resumen recorta por usuario ANTES de filtrar por Oficina',
    iCarga > -1 && iRecorte > iCarga && iOficina > iRecorte)
  check('OFFICE-DASH-008b — los indicadores se calculan sobre accessibleOfficeRoutes',
    cuerpo.includes('accessibleOfficeRoutes.map(r =>'))
  // El único vistazo fuera del alcance es un CONTEO estructural.
  check('OFFICE-DASH-008c — el total de la Oficina es solo un conteo',
    /const totalRoutesInOffice = allRoutes\.filter\(r => r\.officeId === officeId\)\.length/.test(cuerpo))
}

// ============================================================
const atrCobA = { id: 'u-atrCobA', rol: 'cobrador' as UserRole, status: 'activo' as const }
const atrCobB = { id: 'u-atrCobB', rol: 'cobrador' as UserRole, status: 'activo' as const }
const atrCobInactivo = { id: 'u-cobC', rol: 'cobrador' as UserRole, status: 'inactivo' as const }
const actorCob = { id: 'u-atrCobA', rol: 'cobrador' as UserRole }
const actorSup = { id: 'u-sup', rol: 'supervisor' as UserRole }
const actorAdmin = { id: 'u-adm', rol: 'admin' as UserRole }

// El cobrador responde por lo que el mismo registra.
const rCob = resolveResponsibleCollector({ actor: actorCob, routeCollectors: [atrCobA, atrCobB] })
check('ATRIB — el cobrador responde por su propio recaudo', rCob.ok && rCob.collectorId === 'u-atrCobA' && rCob.source === 'actor')

// Supervisor registra un cobro hecho por A: el dinero es de A, no del Supervisor.
const rExp = resolveResponsibleCollector({ actor: actorSup, requested: 'u-atrCobA', routeCollectors: [atrCobA, atrCobB] })
check('ATRIB — el dinero se atribuye al cobrador indicado, no a quien digita', rExp.ok && rExp.collectorId === 'u-atrCobA' && rExp.source === 'explicit')

// Ruta con UN solo cobrador: se preselecciona sin ambiguedad.
const rUno = resolveResponsibleCollector({ actor: actorAdmin, routeCollectors: [atrCobA] })
check('ATRIB — con un unico cobrador se preselecciona', rUno.ok && rUno.collectorId === 'u-atrCobA' && rUno.source === 'single-route-collector')

// Ruta con VARIOS: no se adivina, se exige elegir.
const rVarios = resolveResponsibleCollector({ actor: actorAdmin, routeCollectors: [atrCobA, atrCobB] })
check('ATRIB — con varios cobradores se EXIGE elegir', !rVarios.ok && rVarios.code === 'ambiguous')
check('ATRIB — nunca se atribuye al Admin por ser quien digita', !(rVarios.ok && (rVarios as { collectorId: string }).collectorId === 'u-adm'))

// Un cobrador que no pertenece a la ruta (o inactivo) se rechaza.
const rAjeno = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-otro', routeCollectors: [atrCobA, atrCobB] })
check('ATRIB — cobrador ajeno a la ruta rechazado', !rAjeno.ok && rAjeno.code === 'invalid')
const rInactivo = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-cobC', routeCollectors: [atrCobA, atrCobInactivo] })
check('ATRIB — cobrador inactivo rechazado', !rInactivo.ok && rInactivo.code === 'invalid')

// Ruta sin cobradores: se conserva el comportamiento anterior, marcado como legacy.
const rSin = resolveResponsibleCollector({ actor: actorAdmin, routeCollectors: [] })
check('ATRIB — ruta sin cobradores conserva el comportamiento legacy', rSin.ok && rSin.collectorId === 'u-adm' && rSin.source === 'legacy-actor')

// Solo los perfiles de calle tienen caja personal.
check('ATRIB — el cobrador tiene caja personal', hasPersonalCashbox('cobrador'))
check('ATRIB — el supervisor tiene caja personal', hasPersonalCashbox('supervisor'))
check('ATRIB — el admin NO tiene caja personal', !hasPersonalCashbox('admin'))
check('ATRIB — el secretario NO tiene caja personal', !hasPersonalCashbox('secretario'))

console.log(`\nPRUEBA DE PERMISOS: ${passed} OK, ${failed} FALLIDAS`)
if (failed > 0) process.exit(1)
