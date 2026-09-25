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
  assignableRoles,
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
  routeAdmins, effectiveAdminIdsAfterSave, shouldConfirmRouteWithoutAdmin, routeAdminsLabel,
} from '../src/lib/routeAdmins'
import {
  resolveOfficeParam, routesInOfficeFilter, visibleRouteIds, routeStillInFilter,
  filterRowsByVisibleRoutes, filterContextLabel, buildLookups, routeOfficeLabel, officeLabelOf,
} from '../src/lib/officeRouteFilter'
import {
  routeOpsFacts, officeOpsTotals, officeFinanceTotals, opsAlerts, cumplimientoPct,
  type RouteCashLike,
} from '../src/lib/officeOperations'
import {
  officeComparison, companyOfficesSummary, officeSummaryCsvRows, officeRoutesCsvRows,
  officeActivity, alcanceCsv, type ActivityRowLike,
} from '../src/lib/officeExecutive'
import type { RouteOpsFacts } from '../src/lib/officeOperations'
import {
  routeOperationalState, officeKpis, officeStateSummary, officeScope, officeAlerts,
  relatedUsersOfOffice, applyOfficeRouteSelection, officeRoutesOf, unassignedRoutesOf,
  type OfficeRouteFacts,
} from '../src/lib/officeManagement'
import { readFileSync as readFileSyncForOffices } from 'node:fs'
import { resolve as resolvePathForOffices } from 'node:path'
import { resolveResponsibleCollector, hasPersonalCashbox, isEligibleCashHolder } from '../src/lib/collectorAttribution'
import type { User, UserRole, Tenant, Office, Route, Sale, Installment, Payment, Expense } from '../src/models/types'

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
// [MODIFICADO 2026-09-24 — autoridad comercial del Supervisor] Regla anterior: el Supervisor NO
// hacía venta directa. Regla aprobada: otorga crédito directo en SUS rutas.
check('supervisor puede venta directa en su ruta', can(supervisor, 'sale.createDirect', { routeId: 'r1' }))
check('supervisor NO puede venta directa en ruta ajena', !can(supervisor, 'sale.createDirect', { routeId: 'r9' }))
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
// [MODIFICADO 2026-09-24 — autoridad comercial del Supervisor] antes: NO venta directa.
check('supervisor: venta directa en su ruta', can(supervisor, 'sale.createDirect', { routeId: 'r1' }))
check('supervisor: NO corrige pago', !can(supervisor, 'payment.correct', { routeId: 'r1' }))
check('supervisor: NO anula pago', !can(supervisor, 'payment.reverse', { routeId: 'r1' }))
check('supervisor: NO corrige gasto', !can(supervisor, 'expense.correct', { routeId: 'r1' }))
// [MODIFICADO 2026-09-24 — autoridad comercial del Supervisor] antes: NO aprueba.
check('supervisor: aprueba en su ruta', can(supervisor, 'authorization.approve', { routeId: 'r1' }))
check('supervisor: NO aprueba en ruta ajena', !can(supervisor, 'authorization.approve', { routeId: 'r9' }))
check('supervisor: NO indicadores consolidados', !can(supervisor, 'report.viewConsolidated'))
check('supervisor: NO accede a ruta ajena', !can(supervisor, 'payment.register', { routeId: 'r9' }))

// --- CAPACIDADES INCOMPATIBLES: grantedCapabilities NO habilita lo prohibido ---
const supMalicioso = mkUser('supervisor', { authorizedRouteIds: ['r1'], grantedCapabilities: ['sale.createDirect', 'payment.correct', 'user.create'] as Capability[] })
// [MODIFICADO 2026-09-24 — autoridad comercial del Supervisor] la venta directa ya es capacidad BASE del
// Supervisor; la intención anti-manipulación se conserva con capacidades que sigue sin tener.
check('grant NO habilita anular pagos en Supervisor', !can(mkUser('supervisor', { authorizedRouteIds: ['r1'], grantedCapabilities: ['payment.reverse'] as Capability[] }), 'payment.reverse', { routeId: 'r1' }))
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
// [MODIFICADO 2026-09-24 — autoridad comercial del Supervisor] antes: venta directa incompatible con Supervisor.
check('incompatible: supervisor + capital.manage', !isCapabilityCompatible('supervisor', 'capital.manage'))
check('incompatible: cobrador + sale.createDirect', !isCapabilityCompatible('cobrador', 'sale.createDirect'))
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
// SUPERADMIN-TENANT-002 — REGLA NUEVA (separación Plataforma/Empresa). El Super Admin
// dejó de ser global: es la máxima autoridad DENTRO de su empresa y no puede tocar
// ninguna otra. Antes esta comprobación afirmaba lo contrario; el modelo cambió.
check('SUPERADMIN-TENANT-002 — superadmin NO opera en otro tenant', !can(superadmin, 'client.view', { tenantId: 'otro', routeId: 'r1' }))
check('SUPERADMIN-TENANT-001 — superadmin sí opera en SU tenant', can(superadmin, 'client.view', { tenantId: superadmin.tenantId, routeId: 'r1' }))

// --- Usuario inactivo pierde permisos ---
check('usuario inactivo no tiene permisos', !can(mkUser('admin', { status: 'inactivo' }), 'client.view'))

// --- A. Redirección por rol ---
// OWNER-ROUTING-002 — el Super Admin aterriza en el panel de SU empresa. La antigua
// home '/platform' desapareció con el portal de plataforma del Super Admin.
check('OWNER-ROUTING-002 — home superadmin = panel de empresa', homePathForRole('superadmin') === '/admin/dashboard')
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
// OFFICE-ARCH-003 — LA ÚNICA EXCEPCIÓN PERMITIDA: EL SNAPSHOT DE CIERRE
// ------------------------------------------------------------
// La Entrega 5 introduce `officeIdAtClose` / `officeNameAtClose` /
// `officeCodeAtClose` dentro de `WeeklySettlement`. Es METADATA HISTÓRICA de un
// documento de cierre, no una reintroducción del `officeId` operativo:
//
//   · Vive SOLO en `WeeklySettlement`, en ninguna otra entidad.
//   · Se llama distinto a propósito, para que nadie lo confunda con `Route.officeId`.
//   · No participa en ningún filtro de acceso ni de alcance.
//
// Estas comprobaciones existen para que la excepción siga siendo una excepción.
// ============================================================
{
  const tipos = readSourceFile('src/models/types.ts')

  // (a) `officeId` a secas se declara UNA sola vez en todo el modelo: en Route.
  const declaraciones = (tipos.match(/^\s*officeId\??:/gm) ?? []).length
  check('OFFICE-ARCH-003a — officeId sigue declarándose una sola vez (Route)',
    declaraciones === 1)

  // (b) Los campos de snapshot SOLO existen dentro de WeeklySettlement.
  const iniLiq = tipos.indexOf('export interface WeeklySettlement {')
  const finLiq = tipos.indexOf('\n}', iniLiq)
  const bloqueLiq = tipos.slice(iniLiq, finLiq)
  const fueraDeLiquidacion = tipos.slice(0, iniLiq) + tipos.slice(finLiq)
  check('OFFICE-ARCH-003b — el snapshot vive dentro de WeeklySettlement',
    /^\s*officeIdAtClose\??:/m.test(bloqueLiq) &&
    /^\s*officeNameAtClose\??:/m.test(bloqueLiq))
  check('OFFICE-ARCH-003c — ninguna otra entidad declara campos de snapshot de Oficina',
    !/^\s*office(Id|Name|Code)AtClose\??:/m.test(fueraDeLiquidacion))

  // (c) El snapshot NO se usa para decidir acceso ni para filtrar filas.
  const perms = readSourceFile('src/lib/permissions.ts')
  const scope = readSourceFile('src/lib/scope.ts')
  check('OFFICE-ARCH-003d — el snapshot no aparece en la resolución de permisos',
    !perms.includes('AtClose') && !scope.includes('AtClose'))

  // (d) El servicio de liquidaciones recorta por RUTA, nunca por la Oficina del
  //     documento: el alcance sigue naciendo de authorizedRouteIds.
  const settle = readSourceFile('src/services/settlementService.ts')
  const cuerpoListado = settle.slice(settle.indexOf('export async function listSettlementsForUser'))
  check('OFFICE-ARCH-003e — el listado de liquidaciones filtra por ruta autorizada',
    cuerpoListado.includes('filterAccessibleRoutes') &&
    !/AtClose/.test(cuerpoListado))
}

// ============================================================
// OFFICE-SETTLE — CIERRE DE PERIODO PERSISTENTE (ENTREGA 5)
// ------------------------------------------------------------
// Antes de la Entrega 5 la liquidación se calculaba y se descartaba: nada se
// archivaba, así que ningún periodo estaba cerrado y la protección de
// correcciones nunca se activaba. Estas comprobaciones congelan lo contrario.
// ============================================================
{
  const pagina = readSourceFile('src/pages/admin/WeeklySettlementPage.tsx')
  const servicio = readSourceFile('src/services/settlementService.ts')
  const puro = readSourceFile('src/lib/settlementPeriods.ts')

  check('OFFICE-SETTLE-101 — la pantalla ya no solo calcula: archiva el cierre',
    pagina.includes('closeSettlement'))
  check('OFFICE-SETTLE-102 — la pantalla NO entrega importes al servicio',
    // Solo viajan ruta, empresa y rango: las cifras las produce el motor.
    /closeSettlement\(\{\s*actor: user, tenantId, routeId, semanaInicio, semanaFin\s*\}\)/.test(pagina))
  check('OFFICE-SETTLE-103 — los importes archivados los calcula el motor financiero',
    servicio.includes('generateWeeklySettlement('))
  check('OFFICE-SETTLE-104 — el CSV de un cierre sale del documento archivado',
    pagina.includes('closedSettlementCsvRow') &&
    puro.includes('No se recalcula nada'))
  check('OFFICE-SETTLE-105 — reabrir exige motivo',
    servicio.includes('MIN_REOPEN_REASON') && servicio.includes('reopenReason'))
  check('OFFICE-SETTLE-106 — un cierre nunca se sobrescribe: se versiona',
    servicio.includes('nextClosureVersion') && servicio.includes('supersededBy'))
  check('OFFICE-SETTLE-107 — el módulo de periodos es puro (no importa la base)',
    !puro.includes("from '@/lib/db'"))
  check('OFFICE-SETTLE-108 — cerrar y reabrir se validan con la RUTA, no solo con el rol',
    servicio.includes("assertCan(actor, 'settlement.close', { routeId, tenantId })") &&
    servicio.includes("assertCan(actor, 'settlement.reopen', { routeId: documento.routeId"))
  check('OFFICE-SETTLE-109 — la corrección de pagos usa la fecha CONTABLE del pago',
    (() => {
      const corr = readSourceFile('src/services/paymentCorrectionService.ts')
      // Solo el CUERPO de la función: más allá hay usos legítimos de `updatedAt`.
      const ini = corr.indexOf('export async function isPaymentInClosedPeriod')
      const cuerpo = corr.slice(ini, corr.indexOf('\n}', ini))
      const limpio = cuerpo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      return limpio.includes('payment.fecha') && !limpio.includes('updatedAt')
    })())
  check('OFFICE-SETTLE-110 — cerrar/reabrir dejan rastro en auditoría',
    servicio.includes("action: 'SETTLEMENT_CLOSED'") &&
    servicio.includes("action: 'SETTLEMENT_REOPENED'"))

  // --- UI: sin textos pedagógicos de vuelta ---
  const detalle = readSourceFile('src/pages/admin/OfficeDetailPage.tsx')
  check('OFFICE-SETTLE-111 — la sección de Liquidaciones del detalle es compacta, sin explicación',
    detalle.includes('Liquidaciones') &&
    !detalle.includes('Aquí se muestran las liquidaciones') &&
    !detalle.includes('Las liquidaciones cerradas'))
  check('OFFICE-SETTLE-112 — el detalle muestra la Oficina HISTÓRICA del cierre',
    detalle.includes('Oficina al cierre'))
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
// MÚLTIPLES ADMINISTRADORES POR EMPRESA Y POR RUTA
// ------------------------------------------------------------
// Una empresa puede tener varios Administradores y una misma ruta puede tener más
// de uno. Son usuarios GENERALES de la empresa: no pertenecen a ninguna Oficina y
// su acceso nace solo de `authorizedRouteIds`.
// ============================================================
const mkAdmin = (id: string, nombre: string, rutas: string[], over: Partial<User> = {}): User =>
  mkUser('admin', { id, nombre, authorizedRouteIds: rutas.length ? rutas : undefined, ...over })

const CARLOS = mkAdmin('u-carlos', 'Carlos', ['r-centro', 'r-sur'])
const JUAN = mkAdmin('u-juan', 'Juan', ['r-centro'])
const PEDRO = mkAdmin('u-pedro', 'Pedro', [])
const COB = mkUser('cobrador', { id: 'u-cob', nombre: 'Luis', authorizedRouteIds: ['r-centro'] })
const EMPRESA = [CARLOS, JUAN, PEDRO, COB]

// ROUTE-ADMIN-001 — varios Administradores en la misma empresa es válido.
check('ROUTE-ADMIN-001 — una empresa admite varios Administradores',
  EMPRESA.filter(u => u.rol === 'admin').length === 3)
check('ROUTE-ADMIN-001b — ninguno pertenece a una Oficina',
  EMPRESA.every(u => !('officeId' in (u as unknown as Record<string, unknown>))))

// ROUTE-ADMIN-002 — una misma ruta puede tener DOS Administradores.
{
  const enCentro = routeAdmins(EMPRESA, 'r-centro', 't1')
  check('ROUTE-ADMIN-002 — una ruta puede tener dos Administradores',
    enCentro.length === 2 && enCentro.map(a => a.nombre).sort().join(',') === 'Carlos,Juan')
  check('ROUTE-ADMIN-002b — los cobradores no se cuentan como Administradores',
    !enCentro.some(a => a.id === COB.id))
  check('ROUTE-ADMIN-002c — una ruta de un solo Admin se resuelve igual',
    routeAdmins(EMPRESA, 'r-sur', 't1').length === 1)
  check('ROUTE-ADMIN-002d — una ruta sin Admin devuelve lista vacía',
    routeAdmins(EMPRESA, 'r-nueva', 't1').length === 0)
}

// ============================================================
// REGRESIÓN DEL BUG: la advertencia falsa al editar una ruta CON Administrador
// ------------------------------------------------------------
// Escenario exacto de la captura: ruta activa, Admin asignado, se abre Editar, no
// se cambia nada y se pulsa Actualizar.
//
// El actor es un ADMINISTRADOR, y `MANAGEABLE_ROLES.admin` no incluye 'admin': el
// borrador de usuarios asignables NUNCA contiene administradores. La lógica
// anterior comparaba ese borrador contra los admins previos y concluía que la
// ruta iba a quedarse sin ninguno.
// ============================================================
{
  const actorAdmin = CARLOS
  // Usuarios que el actor PUEDE togglear: ningún admin entra aquí.
  const asignables = EMPRESA
    .filter(u => u.rol !== 'superadmin' && assignableRoles(actorAdmin).includes(u.rol) && canManageUser(actorAdmin, u))
    .map(u => u.id)
  check('ROUTE-ADMIN-REG-000 — un Administrador no puede gestionar a otros Administradores',
    !asignables.includes(JUAN.id) && !asignables.includes(CARLOS.id) && asignables.includes(COB.id))

  // Borrador tal y como lo hidrata la pantalla: solo asignables ya asignados.
  const borrador = EMPRESA
    .filter(u => asignables.includes(u.id) && (u.authorizedRouteIds ?? []).includes('r-centro'))
    .map(u => u.id)

  // --- LÓGICA ANTERIOR (reproduce el fallo) ---
  const draftAdminsAntiguo = borrador.filter(id => EMPRESA.find(u => u.id === id)?.rol === 'admin')
  const prevAdminsAntiguo = EMPRESA.filter(a => a.rol === 'admin' && (a.authorizedRouteIds ?? []).includes('r-centro'))
  const advertenciaAntigua = draftAdminsAntiguo.length === 0 && prevAdminsAntiguo.length > 0
  check('ROUTE-ADMIN-REG-001 — la lógica anterior producía la advertencia FALSA',
    advertenciaAntigua === true)

  // --- LÓGICA NUEVA (corregida) ---
  const efectivos = effectiveAdminIdsAfterSave({
    routeId: 'r-centro', users: EMPRESA,
    assignableUserIds: asignables, draftAssignedUserIds: borrador, tenantId: 't1',
  })
  const advertenciaNueva = shouldConfirmRouteWithoutAdmin({
    routeStatus: 'activa',
    adminIdsBefore: routeAdmins(EMPRESA, 'r-centro', 't1').map(a => a.id),
    effectiveAdminIdsAfterSave: efectivos,
  })
  check('ROUTE-ADMIN-REG-002 — los administradores efectivos conservan a Carlos y Juan',
    efectivos.length === 2 && efectivos.includes(CARLOS.id) && efectivos.includes(JUAN.id))
  check('ROUTE-ADMIN-003 — editar sin tocar Administradores NO muestra advertencia',
    advertenciaNueva === false)
}

// ROUTE-ADMIN-004 — el editor hidrata correctamente cuando el actor SÍ gestiona admins.
{
  const asignablesSuper = EMPRESA
    .filter(u => u.rol !== 'superadmin' && assignableRoles(superadmin).includes(u.rol) && canManageUser(superadmin, u))
    .map(u => u.id)
  check('ROUTE-ADMIN-004a — el Super Admin sí puede gestionar Administradores',
    asignablesSuper.includes(CARLOS.id) && asignablesSuper.includes(JUAN.id))
  const borradorSuper = EMPRESA
    .filter(u => asignablesSuper.includes(u.id) && (u.authorizedRouteIds ?? []).includes('r-centro'))
    .map(u => u.id)
  check('ROUTE-ADMIN-004 — el borrador del Super Admin hidrata los dos Administradores',
    borradorSuper.includes(CARLOS.id) && borradorSuper.includes(JUAN.id))
  check('ROUTE-ADMIN-004b — y no muestra advertencia al guardar sin cambios',
    shouldConfirmRouteWithoutAdmin({
      routeStatus: 'activa',
      adminIdsBefore: routeAdmins(EMPRESA, 'r-centro', 't1').map(a => a.id),
      effectiveAdminIdsAfterSave: effectiveAdminIdsAfterSave({
        routeId: 'r-centro', users: EMPRESA,
        assignableUserIds: asignablesSuper, draftAssignedUserIds: borradorSuper, tenantId: 't1',
      }),
    }) === false)
}

// ROUTE-ADMIN-005 / 006 — quitar todos vs dejar al menos uno.
{
  const asignablesSuper = [CARLOS.id, JUAN.id, PEDRO.id, COB.id]
  const efectivosTras = (borrador: string[]) => effectiveAdminIdsAfterSave({
    routeId: 'r-centro', users: EMPRESA,
    assignableUserIds: asignablesSuper, draftAssignedUserIds: borrador, tenantId: 't1',
  })
  const antes = routeAdmins(EMPRESA, 'r-centro', 't1').map(a => a.id)

  check('ROUTE-ADMIN-005 — quitar TODOS los Administradores sí advierte',
    shouldConfirmRouteWithoutAdmin({
      routeStatus: 'activa', adminIdsBefore: antes, effectiveAdminIdsAfterSave: efectivosTras([COB.id]),
    }) === true)
  check('ROUTE-ADMIN-006 — dejar al menos uno NO advierte',
    shouldConfirmRouteWithoutAdmin({
      routeStatus: 'activa', adminIdsBefore: antes, effectiveAdminIdsAfterSave: efectivosTras([CARLOS.id, COB.id]),
    }) === false)
  check('ROUTE-ADMIN-006b — una ruta que YA estaba sin Admin no vuelve a preguntar',
    shouldConfirmRouteWithoutAdmin({
      routeStatus: 'activa', adminIdsBefore: [], effectiveAdminIdsAfterSave: [],
    }) === false)
  check('ROUTE-ADMIN-006c — una ruta inactiva no pide confirmación',
    shouldConfirmRouteWithoutAdmin({
      routeStatus: 'inactiva', adminIdsBefore: antes, effectiveAdminIdsAfterSave: [],
    }) === false)
}

// ROUTE-ADMIN-012 — desasignar de una ruta conserva las demás rutas del Admin.
{
  // Carlos tiene r-centro y r-sur. Se edita r-centro y se le desasigna.
  const resultado = applyOfficeRouteSelection(['r-centro', 'r-sur'], ['r-centro'], [])
  check('ROUTE-ADMIN-012 — desasignar de una ruta no borra las otras del Administrador',
    resultado.length === 1 && resultado[0] === 'r-sur')
  // Y el diff de la pantalla de rutas solo retira dentro del alcance del actor.
  const diff = computeRouteAssignmentDiff({
    routeId: 'r-centro',
    assignableUserIds: [CARLOS.id],
    assignedUserIds: [],
    membershipOf: (id) => id === CARLOS.id ? ['r-centro', 'r-sur'] : [],
  })
  check('ROUTE-ADMIN-012b — el diff retira solo de la ruta editada',
    diff.removed.length === 1 && diff.removed[0] === CARLOS.id && diff.added.length === 0)
}

// ROUTE-ADMIN-011 — un admin fuera del alcance del actor NUNCA se retira.
{
  const diff = computeRouteAssignmentDiff({
    routeId: 'r-centro',
    assignableUserIds: [COB.id],          // el actor Admin solo gestiona al cobrador
    assignedUserIds: [COB.id],
    membershipOf: (id) => id === JUAN.id ? ['r-centro'] : id === COB.id ? ['r-centro'] : [],
  })
  check('ROUTE-ADMIN-011 — guardar como Administrador no retira a otros Administradores',
    !diff.removed.includes(JUAN.id) && !diff.added.includes(JUAN.id))
}

// ROUTE-ADMIN-014 — Administrador INACTIVO: no cuenta como responsable efectivo.
{
  const inactivo = mkAdmin('u-inact', 'Inactivo', ['r-sola'], { status: 'inactivo' })
  check('ROUTE-ADMIN-014a — un Admin inactivo no cuenta como Administrador de la ruta',
    routeAdmins([inactivo], 'r-sola', 't1').length === 0)
  check('ROUTE-ADMIN-014b — tampoco entra en los efectivos tras guardar',
    effectiveAdminIdsAfterSave({
      routeId: 'r-sola', users: [inactivo], assignableUserIds: [], draftAssignedUserIds: [], tenantId: 't1',
    }).length === 0)
  check('ROUTE-ADMIN-014c — y por eso la ruta no vuelve a pedir confirmación',
    shouldConfirmRouteWithoutAdmin({ routeStatus: 'activa', adminIdsBefore: [], effectiveAdminIdsAfterSave: [] }) === false)
}

// Aislamiento por empresa.
check('ROUTE-ADMIN-017 — un Admin de otra empresa no cuenta en la ruta',
  routeAdmins([mkAdmin('u-otro', 'Otro', ['r-centro'], { tenantId: 't2' })], 'r-centro', 't1').length === 0)

// ROUTE-ADMIN-013 — etiqueta correcta en tarjeta/vista (nunca singular en plural).
check('ROUTE-ADMIN-013a — 0 administradores', routeAdminsLabel([]) === 'Sin Administrador asignado')
check('ROUTE-ADMIN-013b — 1 administrador', routeAdminsLabel(['Carlos']) === 'Administrador: Carlos')
check('ROUTE-ADMIN-013c — 2+ administradores en plural',
  routeAdminsLabel(['Carlos', 'Juan']) === 'Administradores: Carlos, Juan')

// ROUTE-ADMIN-015 / 016 — la Oficina y el catálogo siguen sin conceder rutas.
{
  const carlosGestor = mkAdmin('u-c2', 'Carlos', ['r-centro'])
  check('ROUTE-ADMIN-015 — gestionar Oficinas no concede ninguna ruta',
    can(carlosGestor, 'office.edit') && can(carlosGestor, 'office.create') &&
    canAccessRoute(carlosGestor, 'r-centro') && !canAccessRoute(carlosGestor, 'r-sur'))
  const sinRutas = mkAdmin('u-vacio', 'Vacío', [])
  check('ROUTE-ADMIN-016 — un Admin sin authorizedRouteIds sigue fail-closed',
    !hasOperationalRoutes(sinRutas) && !canAccessRoute(sinRutas, 'r-centro') &&
    filterAccessibleRoutes(sinRutas, [{ id: 'r-centro' } as never]).length === 0)
}

// ROUTE-ADMIN-007 — un Admin nuevo no hereda ninguna ruta.
check('ROUTE-ADMIN-007 — un Administrador recién creado no recibe rutas automáticamente',
  (PEDRO.authorizedRouteIds ?? []).length === 0 && !hasOperationalRoutes(PEDRO))

// --- La pantalla usa el cálculo corregido (contrato sobre el código) ---
{
  const page = readSourceFile('src/pages/admin/RoutesPage.tsx')
  check('ROUTE-ADMIN-REG-003 — la pantalla decide con los administradores efectivos',
    page.includes('effectiveAdminIdsAfterSave({') && page.includes('shouldConfirmRouteWithoutAdmin({'))
  check('ROUTE-ADMIN-REG-004 — ya no se compara el borrador crudo contra los previos',
    !page.includes("const draftAdmins = form.assignedUserIds.filter"))
  check('ROUTE-ADMIN-REG-005 — la advertencia ámbar usa la misma fuente',
    page.includes('hasAdmin: effectiveAdminIds.length > 0'))
  // Fuente única: no aparecen campos de admin en la Ruta.
  const types = readSourceFile('src/models/types.ts')
  check('ROUTE-ADMIN-018 — no existe Route.adminId ni Route.adminIds',
    !/adminIds?\??:/.test(types))
}


// ============================================================
// ENTREGA 2 — FILTRO TRANSVERSAL OFICINA → RUTA
// ------------------------------------------------------------
// Un solo patrón para ocho módulos. La Oficina SIEMPRE estrecha el alcance ya
// autorizado; ninguna función de este módulo puede devolver una ruta que el
// usuario no tuviera. "Todas las oficinas" = todas las rutas AUTORIZADAS.
// ============================================================
const OFI_LET = 'of-let'
const OFI_RIO = 'of-rio'

const mkRutaE2 = (id: string, officeId: string | undefined, nombre = id): Route =>
  ({ id, tenantId: 't1', officeId, nombre, codigo: id, tasaInteres: 20, tasaLibre: false,
     montoMaximoPrestamo: 1, capitalInicial: 0, capitalActual: 0, status: 'activa',
     createdAt: '', updatedAt: '' }) as Route

const mkOficinaE2 = (id: string, nombre: string, status: Office['status'] = 'activa'): Office =>
  ({ id, tenantId: 't1', nombre, status, createdAt: '', updatedAt: '' })

// Empresa: Leticia tiene 3 rutas, Río 1, y hay 1 ruta Sin Oficina.
const RUTAS_EMPRESA = [
  mkRutaE2('r-L1', OFI_LET, 'Centro'), mkRutaE2('r-L2', OFI_LET, 'Mercado'), mkRutaE2('r-L3', OFI_LET, 'Norte'),
  mkRutaE2('r-R1', OFI_RIO, 'Puerto'),
  mkRutaE2('r-X', undefined, 'Antigua'),
]
const OFICINAS_EMPRESA = [mkOficinaE2(OFI_LET, 'Leticia'), mkOficinaE2(OFI_RIO, 'Río')]

// Admin PARCIAL: Centro y Mercado de Leticia, Puerto de Río, y la ruta Sin Oficina.
// NO tiene Norte, aunque sea de Leticia.
const ADMIN_PARCIAL = mkUser('admin', { id: 'u-parcial', authorizedRouteIds: ['r-L1', 'r-L2', 'r-R1', 'r-X'] })
const ACCESIBLES = filterAccessibleRoutes(ADMIN_PARCIAL, RUTAS_EMPRESA)

// --- OFFICE-FILTER-001: nunca aparecen rutas hermanas no autorizadas ---
{
  const enLeticia = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_LET })
  check('OFFICE-FILTER-001 — un Admin parcial nunca recibe las rutas hermanas de la Oficina',
    enLeticia.size === 2 && enLeticia.has('r-L1') && enLeticia.has('r-L2') && !enLeticia.has('r-L3'))
}

// --- OFFICE-FILTER-002: "Todas las oficinas" = todas las AUTORIZADAS ---
{
  const todas = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: ALL_OFFICES })
  check('OFFICE-FILTER-002 — "Todas las oficinas" son todas las rutas autorizadas',
    todas.size === 4 && !todas.has('r-L3'))
  check('OFFICE-FILTER-002b — y para el Super Admin son todas las del tenant',
    visibleRouteIds({ accessibleRoutes: filterAccessibleRoutes(superadmin, RUTAS_EMPRESA), officeId: ALL_OFFICES }).size === 5)
}

// --- OFFICE-FILTER-003: Oficina específica = intersección ---
{
  const rio = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_RIO })
  check('OFFICE-FILTER-003 — una Oficina concreta es la intersección con lo autorizado',
    rio.size === 1 && rio.has('r-R1'))
}

// --- OFFICE-FILTER-004: "Sin Oficina" transversal ---
{
  const sin = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: NO_OFFICE })
  check('OFFICE-FILTER-004 — "Sin Oficina" selecciona solo las rutas sin Oficina accesibles',
    sin.size === 1 && sin.has('r-X'))
}

// --- OFFICE-FILTER-005: cambiar de Oficina invalida la ruta que queda fuera ---
{
  check('OFFICE-FILTER-005a — una ruta de Leticia deja de ser válida al pasar a Río',
    routeStillInFilter(ACCESIBLES, OFI_LET, 'r-L1') && !routeStillInFilter(ACCESIBLES, OFI_RIO, 'r-L1'))
  check('OFFICE-FILTER-005b — "todas las oficinas" no invalida ninguna ruta accesible',
    routeStillInFilter(ACCESIBLES, ALL_OFFICES, 'r-L1'))
  check('OFFICE-FILTER-005c — sin ruta elegida nunca hay nada que limpiar',
    routeStillInFilter(ACCESIBLES, OFI_RIO, ''))
  // Y con la ruta fuera del filtro el conjunto queda VACÍO, nunca amplía.
  check('OFFICE-FILTER-005d — una ruta fuera del filtro produce conjunto vacío',
    visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_RIO, routeId: 'r-L1' }).size === 0)
}

// --- OFFICE-FILTER-006: officeId inválido NUNCA amplía el alcance ---
{
  check('OFFICE-FILTER-006a — una Oficina de otra empresa se ignora',
    resolveOfficeParam('of-ajena', OFICINAS_EMPRESA) === ALL_OFFICES)
  check('OFFICE-FILTER-006b — un id inventado se ignora',
    resolveOfficeParam('no-existe', OFICINAS_EMPRESA) === ALL_OFFICES)
  check('OFFICE-FILTER-006c — sin parámetro se queda en "todas"',
    resolveOfficeParam(null, OFICINAS_EMPRESA) === ALL_OFFICES)
  check('OFFICE-FILTER-006d — una Oficina real del tenant sí se aplica',
    resolveOfficeParam(OFI_LET, OFICINAS_EMPRESA) === OFI_LET)
  check('OFFICE-FILTER-006e — "Sin Oficina" siempre se acepta (es derivada)',
    resolveOfficeParam(NO_OFFICE, OFICINAS_EMPRESA) === NO_OFFICE)
  // Aunque un id ajeno se aceptara, el filtro parte de lo accesible: jamás revela.
  check('OFFICE-FILTER-006f — ni forzando un id ajeno se obtiene una ruta no autorizada',
    visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: 'of-ajena' }).size === 0)
}

// --- Recorte de filas por módulo: el mismo patrón para todos ---
{
  const visiblesLeticia = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_LET })

  const clientes = [
    { id: 'c1', routeId: 'r-L1' }, { id: 'c2', routeId: 'r-L2' },
    { id: 'c3', routeId: 'r-L3' },   // ruta de Leticia NO autorizada
    { id: 'c4', routeId: 'r-R1' },
  ]
  check('OFFICE-CLIENT-001 — los clientes se filtran por la Oficina derivada de su ruta',
    filterRowsByVisibleRoutes(clientes, visiblesLeticia).map(c => c.id).join() === 'c1,c2')

  const ventas = [{ id: 's1', routeId: 'r-L1' }, { id: 's2', routeId: 'r-L3' }, { id: 's3', routeId: 'r-R1' }]
  check('OFFICE-SALES-001 — las ventas se filtran por la Oficina derivada de su ruta',
    filterRowsByVisibleRoutes(ventas, visiblesLeticia).map(v => v.id).join() === 's1')

  const gastos = [{ id: 'e1', routeId: 'r-L2' }, { id: 'e2', routeId: 'r-L3' }]
  check('OFFICE-EXPENSE-FILTER-001 — los gastos respetan Oficina y ruta',
    filterRowsByVisibleRoutes(gastos, visiblesLeticia).map(e => e.id).join() === 'e1')

  const capital = [{ id: 'cm1', routeId: 'r-L1' }, { id: 'cm2', routeId: 'r-R1' }]
  check('OFFICE-CAPITAL-FILTER-001 — el capital respeta el filtro de Oficina',
    filterRowsByVisibleRoutes(capital, visiblesLeticia).map(c => c.id).join() === 'cm1')

  const retiros = [{ id: 'w1', routeId: 'r-L1' }, { id: 'w2', routeId: 'r-L3' }]
  check('OFFICE-WITHDRAW-FILTER-001 — los retiros respetan el filtro de Oficina',
    filterRowsByVisibleRoutes(retiros, visiblesLeticia).map(w => w.id).join() === 'w1')

  // Caja: se ofrece solo la ruta del filtro; el motor sigue siendo por ruta.
  check('OFFICE-CASH-FILTER-001 — la caja solo ofrece rutas accesibles de la Oficina',
    routesInOfficeFilter(ACCESIBLES, OFI_LET).map(r => r.id).join() === 'r-L1,r-L2')
}

// --- Transferencias: la Oficina de cada extremo se DERIVA de su routeId ---
{
  const { routeById, officeById } = buildLookups(RUTAS_EMPRESA, OFICINAS_EMPRESA)
  check('OFFICE-TRANSFER-FILTER-001a — el origen muestra Oficina / Ruta derivadas',
    routeOfficeLabel('r-L1', routeById, officeById) === 'Leticia / Centro')
  check('OFFICE-TRANSFER-FILTER-001b — el destino de otra Oficina se distingue',
    routeOfficeLabel('r-R1', routeById, officeById) === 'Río / Puerto')
  check('OFFICE-TRANSFER-FILTER-001c — un extremo sin Oficina se etiqueta como tal',
    routeOfficeLabel('r-X', routeById, officeById) === 'Sin Oficina / Antigua')
  check('OFFICE-TRANSFER-FILTER-001d — una ruta desconocida no rompe la etiqueta',
    routeOfficeLabel('r-borrada', routeById, officeById) === 'r-borrada')

  // Una transferencia entra si ALGUNO de sus extremos de ruta está en el filtro.
  const visiblesRio = visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_RIO })
  const enFiltro = (o?: string, d?: string) =>
    [o, d].filter(Boolean).some(id => visiblesRio.has(id as string))
  check('OFFICE-TRANSFER-FILTER-002 — entra si origen o destino pertenecen al filtro',
    enFiltro('r-L1', 'r-R1') && enFiltro('r-R1', undefined) && !enFiltro('r-L1', 'r-L2'))
}

// --- Etiquetas y contexto visible ---
{
  const { routeById, officeById } = buildLookups(RUTAS_EMPRESA, OFICINAS_EMPRESA)
  check('OFFICE-CONTEXT-LABEL-001 — el contexto nombra Oficina y alcance de ruta',
    filterContextLabel({ officeId: OFI_LET, officeById, routeById }) === 'Oficina: Leticia · Todas las rutas autorizadas')
  check('OFFICE-CONTEXT-LABEL-002 — con ruta elegida el contexto la nombra',
    filterContextLabel({ officeId: OFI_LET, officeById, routeId: 'r-L1', routeById }) === 'Oficina: Leticia · Centro')
  check('OFFICE-CONTEXT-LABEL-003 — "Sin Oficina" se rotula como tal',
    filterContextLabel({ officeId: NO_OFFICE, officeById, routeById }).startsWith('Oficina: Sin Oficina'))
  check('OFFICE-CONTEXT-LABEL-004 — sin filtro se dice "Todas las oficinas"',
    filterContextLabel({ officeId: ALL_OFFICES, officeById, routeById }).startsWith('Oficina: Todas las oficinas'))
  check('OFFICE-CONTEXT-LABEL-005 — la Oficina de una fila se deriva de su ruta',
    officeLabelOf(routeById.get('r-L1'), officeById) === 'Leticia' &&
    officeLabelOf(routeById.get('r-X'), officeById) === NO_OFFICE_LABEL)
}

// --- Oficina INACTIVA: se consulta el histórico, no se esconde ---
{
  const conInactiva = [mkOficinaE2(OFI_LET, 'Leticia', 'inactiva'), mkOficinaE2(OFI_RIO, 'Río')]
  check('OFFICE-FILTER-007 — una Oficina inactiva sigue siendo filtrable (histórico)',
    resolveOfficeParam(OFI_LET, conInactiva) === OFI_LET &&
    visibleRouteIds({ accessibleRoutes: ACCESIBLES, officeId: OFI_LET }).size === 2)
}

// --- Rendimiento: índices en memoria, sin una consulta por fila ---
{
  const { routeById, officeById } = buildLookups(RUTAS_EMPRESA, OFICINAS_EMPRESA)
  check('OFFICE-PERF-001 — los índices cubren todas las rutas y oficinas de una vez',
    routeById.size === RUTAS_EMPRESA.length && officeById.size === OFICINAS_EMPRESA.length)
}

// ============================================================
// CONTRATO DE CÓDIGO — contexto conservado y derivación correcta
// ============================================================
{
  const detalle = readSourceFile('src/pages/admin/OfficeDetailPage.tsx')
  const destinos: [string, string][] = [
    ['OFFICE-CONTEXT-001', '/admin/clients?officeId=${office.id}'],
    ['OFFICE-CONTEXT-002', '/admin/reports?officeId=${office.id}'],
    ['OFFICE-CONTEXT-003', '/admin/weekly-settlement?officeId=${office.id}'],
    ['OFFICE-CONTEXT-004', '/admin/routes?officeId=${office.id}'],
    ['OFFICE-CONTEXT-005', '/admin/cashbox?officeId=${office.id}'],
    ['OFFICE-CONTEXT-006', '/admin/active-sales?officeId=${office.id}'],
  ]
  for (const [id, destino] of destinos) {
    check(`${id} — el acceso rápido conserva la Oficina (${destino.split('?')[0]})`,
      detalle.includes(destino))
  }
  check('OFFICE-CONTEXT-007 — ningún acceso rápido navega al módulo general sin contexto',
    !/navigate\('\/admin\/(clients|reports|weekly-settlement|cashbox|active-sales)'\)/.test(detalle))
}

{
  // Cada módulo usa el patrón compartido, no una implementación propia.
  const MODULOS = [
    ['Clientes', 'src/pages/admin/ClientsPage.tsx'],
    ['Ventas', 'src/pages/admin/ActiveSalesPage.tsx'],
    ['Gastos', 'src/pages/admin/ExpensesPage.tsx'],
    ['Retiros', 'src/pages/admin/WithdrawalsPage.tsx'],
    ['Capital', 'src/pages/admin/CapitalPage.tsx'],
    ['Transferencias', 'src/pages/admin/TransfersPage.tsx'],
    ['Caja', 'src/pages/admin/CashboxPage.tsx'],
  ] as const
  for (const [nombre, archivo] of MODULOS) {
    check(`OFFICE-FILTER-PATTERN — ${nombre} usa el filtro compartido`,
      readSourceFile(archivo).includes('useOfficeRouteFilter()'))
  }
  // Y las pantallas con contexto por URL lo validan antes de aplicarlo.
  for (const archivo of ['src/pages/admin/ReportsPage.tsx', 'src/pages/admin/WeeklySettlementPage.tsx', 'src/pages/admin/RoutesPage.tsx']) {
    check(`OFFICE-CONTEXT-VALID — ${archivo.split('/').pop()} valida el officeId recibido`,
      readSourceFile(archivo).includes('resolveOfficeParam('))
  }
}

{
  // REGLA ABSOLUTA: la Oficina se deriva por routeId, nunca de la fila.
  const MODULOS = [
    'src/pages/admin/ClientsPage.tsx', 'src/pages/admin/ActiveSalesPage.tsx',
    'src/pages/admin/ExpensesPage.tsx', 'src/pages/admin/WithdrawalsPage.tsx',
    'src/pages/admin/CapitalPage.tsx', 'src/pages/admin/TransfersPage.tsx',
    'src/pages/admin/CashboxPage.tsx',
  ]
  const lee = /\b(client|sale|expense|withdrawal|movement|transfer|payment|row|c|s|e|w|m|t)\.officeId\b/
  const infractores = MODULOS.filter(f => lee.test(readSourceFile(f)))
  check('OFFICE-DERIVE-STRICT — ningún módulo lee officeId de una fila',
    infractores.length === 0)
  // El hook compartido tampoco decide permisos: parte del scoping central.
  const hook = readSourceFile('src/hooks/useOfficeRouteFilter.ts')
  check('OFFICE-DERIVE-STRICT-b — el filtro parte de useAccessibleRoutes',
    hook.includes('useAccessibleRoutes()'))
  check('OFFICE-DERIVE-STRICT-c — el módulo puro del filtro no toca la base de datos',
    !readSourceFile('src/lib/officeRouteFilter.ts').includes("from '@/lib/db'"))
}


// ============================================================
// ENTREGA 3 — OFICINA OPERATIVA Y FINANCIERA
// ------------------------------------------------------------
// La lógica de cobranza es pura y se calcula SOLO sobre las filas que recibe.
// Quien llama pasa únicamente las de las rutas accesibles de la Oficina, así que
// este módulo no tiene forma de ver ninguna otra.
// ============================================================
const OPS_HOY = '2026-09-16'
const OPS_AYER = '2026-09-15'
const OPS_MANANA = '2026-09-17'

const mkVentaOps = (id: string, routeId: string, clientId: string, over: Record<string, unknown> = {}): Sale =>
  ({ id, tenantId: 't1', routeId, clientId, createdByUserId: 'u', valorVenta: 100, tasaInteres: 20,
     valorInteres: 20, valorTotal: 120, saldo: 120, numeroCuotas: 3, valorCuota: 40,
     frecuenciaPago: 'diaria', fechaInicio: OPS_AYER, fechaFinalEstimada: OPS_MANANA, status: 'activa',
     disbursementStatus: 'desembolsado', createdAt: '', updatedAt: '', ...over }) as Sale

const mkCuotaOps = (id: string, saleId: string, fecha: string, saldo: number, valor = 40): Installment =>
  ({ id, saleId, numero: 1, fechaVencimiento: fecha, valor, pagado: valor - saldo, saldo,
     status: saldo === 0 ? 'pagada' : 'pendiente', diasMora: 0 })

const mkPagoOps = (id: string, routeId: string, fecha: string, valor: number, state?: string): Payment =>
  ({ id, tenantId: 't1', saleId: 's', clientId: 'c', routeId, collectorId: 'u', createdByUserId: 'u',
     valor, fecha, tipo: 'efectivo', syncStatus: 'synced', createdAt: '', state } as unknown as Payment)

const mkGastoOps = (id: string, routeId: string, fecha: string, valor: number): Expense =>
  ({ id, tenantId: 't1', routeId, categoryId: 'cat', userId: 'u', valor, fecha,
     syncStatus: 'synced', createdAt: '' } as unknown as Expense)

/** Ruta con dos ventas: una al día y otra con cuota vencida. */
function rutaDeEjemplo(routeId: string, nombre: string) {
  const ventas = [
    mkVentaOps('s-hoy', routeId, 'c-1'),
    mkVentaOps('s-atraso', routeId, 'c-2'),
    mkVentaOps('s-pend', routeId, 'c-3', { disbursementStatus: 'pendiente' }),
  ]
  const cuotas = new Map<string, Installment[]>([
    ['s-hoy', [mkCuotaOps('i-1', 's-hoy', OPS_HOY, 40), mkCuotaOps('i-2', 's-hoy', OPS_MANANA, 40)]],
    ['s-atraso', [mkCuotaOps('i-3', 's-atraso', OPS_AYER, 30), mkCuotaOps('i-4', 's-atraso', OPS_HOY, 40)]],
    ['s-pend', [mkCuotaOps('i-5', 's-pend', OPS_HOY, 40)]],
  ])
  return { routeId, nombre, sales: ventas, installmentsBySale: cuotas, today: OPS_HOY }
}

// ============================================================
// SEMÁNTICA DE "A COBRAR HOY" — los dos casos canónicos
// ------------------------------------------------------------
// Definición única de RutaCash, alineada con `quickAmounts` (que propone cobrar el
// SALDO de la cuota en curso) y con `applyPaymentToInstallments` (que aplica los
// pagos a la primera cuota no pagada, de modo que un adelanto de ayer reduce el
// saldo de hoy):
//
//     pendienteHoy = Σ saldo ACTUAL de las cuotas que vencen hoy
//     aCobrarHoy   = pendienteHoy + recaudadoHoy   ← meta al empezar la jornada
//
// Reconstruir la meta sumando lo ya cobrado evita que cobrar encoja la meta.
// ============================================================
{
  // CASO 1 — cuota de hoy 100, sin abonos previos, se cobran 60 hoy.
  // El pago YA redujo el saldo de la cuota (así funciona el motor real).
  const caso1 = routeOpsFacts({
    routeId: 'r-c1', nombre: 'Caso 1',
    sales: [mkVentaOps('s1', 'r-c1', 'c1')],
    installmentsBySale: new Map([['s1', [
      { id: 'i1', saleId: 's1', numero: 1, fechaVencimiento: OPS_HOY, valor: 100, pagado: 60, saldo: 40, status: 'parcial', diasMora: 0 },
    ]]]),
    payments: [mkPagoOps('p1', 'r-c1', OPS_HOY, 60)],
    expenses: [], today: OPS_HOY,
  })
  check('OFFICE-COLLECTION-SEMANTICS-001a — meta = pendiente + recaudado = 100',
    caso1.aCobrarHoy === 100)
  check('OFFICE-COLLECTION-SEMANTICS-001b — pendiente hoy es el saldo que aún falta',
    caso1.pendienteHoy === 40)
  check('OFFICE-COLLECTION-SEMANTICS-001c — cumplimiento 60 %',
    caso1.recaudadoHoy === 60 && caso1.cumplimiento === 60)

  // CASO 2 — cuota de hoy 100 con 40 abonados AYER; hoy se cobran los 60 que
  // faltaban. La deuda del día queda saldada: es un 100 %, no un 60 %.
  const caso2 = routeOpsFacts({
    routeId: 'r-c2', nombre: 'Caso 2',
    sales: [mkVentaOps('s2', 'r-c2', 'c2')],
    installmentsBySale: new Map([['s2', [
      { id: 'i2', saleId: 's2', numero: 1, fechaVencimiento: OPS_HOY, valor: 100, pagado: 100, saldo: 0, status: 'pagada', diasMora: 0 },
    ]]]),
    payments: [mkPagoOps('p2', 'r-c2', OPS_HOY, 60)],   // los 40 de ayer no son de hoy
    expenses: [], today: OPS_HOY,
  })
  check('OFFICE-COLLECTION-SEMANTICS-002a — la meta descuenta el adelanto de ayer',
    caso2.aCobrarHoy === 60)
  check('OFFICE-COLLECTION-SEMANTICS-002b — no queda nada pendiente del día',
    caso2.pendienteHoy === 0)
  check('OFFICE-COLLECTION-SEMANTICS-002c — cumplimiento 100 %: la deuda del día quedó saldada',
    caso2.cumplimiento === 100)

  // CASO 3 — nada cobrado: la meta es el saldo íntegro y el cumplimiento 0 %.
  const caso3 = routeOpsFacts({
    routeId: 'r-c3', nombre: 'Caso 3',
    sales: [mkVentaOps('s3', 'r-c3', 'c3')],
    installmentsBySale: new Map([['s3', [
      { id: 'i3', saleId: 's3', numero: 1, fechaVencimiento: OPS_HOY, valor: 100, pagado: 0, saldo: 100, status: 'pendiente', diasMora: 0 },
    ]]]),
    payments: [], expenses: [], today: OPS_HOY,
  })
  check('OFFICE-COLLECTION-SEMANTICS-003 — sin cobrar, meta íntegra y cumplimiento 0 %',
    caso3.aCobrarHoy === 100 && caso3.pendienteHoy === 100 && caso3.cumplimiento === 0)

  // La meta NO se encoge al cobrar: es el fallo que traía la Entrega 3.
  check('OFFICE-COLLECTION-SEMANTICS-004 — cobrar no reduce la meta del día',
    caso1.aCobrarHoy === caso3.aCobrarHoy)
}

// --- OFFICE-OPS-001/002/003/004: cobranza del día sobre el escenario base ---
{
  const base = rutaDeEjemplo('r-1', 'Centro')
  const f = routeOpsFacts({ ...base, payments: [mkPagoOps('p-1', 'r-1', OPS_HOY, 50)], expenses: [] })

  check('OFFICE-OPS-001 — el pendiente del día es el saldo de las cuotas que vencen hoy',
    f.pendienteHoy === 80)   // i-1 (40) + i-4 (40); i-3 vence ayer
  check('OFFICE-OPS-001b — las ventas NO desembolsadas no entran en la cobranza',
    f.ventasActivas === 2)
  check('OFFICE-OPS-002 — "recaudado hoy" toma los pagos vigentes de hoy',
    f.recaudadoHoy === 50)
  check('OFFICE-OPS-003 — la meta reconstruye lo que había al empezar el día',
    f.aCobrarHoy === 130)   // 80 pendiente + 50 ya cobrado
  check('OFFICE-OPS-004 — el cumplimiento es recaudado / meta',
    f.cumplimiento === 38)   // 50/130 = 38,4 → 38
}

// El recaudo excluye pagos REVERTIDOS y sus contrapartidas.
{
  const base = rutaDeEjemplo('r-1', 'Centro')
  const f = routeOpsFacts({
    ...base,
    payments: [
      mkPagoOps('p-ok', 'r-1', OPS_HOY, 20),
      mkPagoOps('p-rev', 'r-1', OPS_HOY, 100, 'reversed'),
      mkPagoOps('p-contra', 'r-1', OPS_HOY, -100, 'reversal'),
    ],
    expenses: [],
  })
  check('OFFICE-OPS-002b — un pago revertido no infla el recaudo del día',
    f.recaudadoHoy === 20)
}

// Pagos de OTROS días no cuentan como recaudo de hoy.
{
  const base = rutaDeEjemplo('r-1', 'Centro')
  const f = routeOpsFacts({ ...base, payments: [mkPagoOps('p-ayer', 'r-1', OPS_AYER, 500)], expenses: [] })
  check('OFFICE-OPS-002c — el recaudo de ayer no cuenta como recaudo de hoy',
    f.recaudadoHoy === 0 && f.cumplimiento === 0)
}

// --- OFFICE-OPS-005: cartera vencida y clientes con atraso ---
{
  const base = rutaDeEjemplo('r-1', 'Centro')
  const f = routeOpsFacts({ ...base, payments: [], expenses: [] })
  check('OFFICE-OPS-005 — la cartera vencida suma las cuotas con fecha anterior a hoy',
    f.carteraVencida === 30)
  check('OFFICE-OPS-005b — se cuentan los clientes distintos con cuotas vencidas',
    f.clientesConAtraso === 1)
  check('OFFICE-OPS-005c — la cartera activa suma todo el saldo pendiente desembolsado',
    f.carteraActiva === 150)   // 40 + 40 + 30 + 40
  check('OFFICE-OPS-005d — las parcelas pendientes se cuentan',
    f.parcelasPendientes === 4)
  check('OFFICE-OPS-005e — los desembolsos pendientes se cuentan aparte',
    f.desembolsosPendientes === 1)
  check('OFFICE-OPS-005f — los clientes activos son los de ventas desembolsadas',
    f.clientesActivos === 2)
}

// --- Gastos del día ---
{
  const base = rutaDeEjemplo('r-1', 'Centro')
  const f = routeOpsFacts({
    ...base, payments: [],
    expenses: [mkGastoOps('e-1', 'r-1', OPS_HOY, 15), mkGastoOps('e-2', 'r-1', OPS_AYER, 900)],
  })
  check('OFFICE-OPS-006 — los gastos del día no arrastran los de otros días',
    f.gastosHoy === 15)
}

// --- Cumplimiento: casos límite sin división por cero ---
check('OFFICE-OPS-004b — sin cuota que cobrar y sin recaudo, el cumplimiento es 0',
  cumplimientoPct(0, 0) === 0)
check('OFFICE-OPS-004c — sin cuota pero con recaudo (adelanto), se considera 100',
  cumplimientoPct(0, 5000) === 100)
check('OFFICE-OPS-004d — recaudar de más no pasa del 100',
  cumplimientoPct(100, 250) === 100)
check('OFFICE-OPS-004e — cumplimiento exacto',
  cumplimientoPct(200, 100) === 50)

// --- Totales de la Oficina: la suma de sus rutas VISIBLES ---
{
  const fCentro = routeOpsFacts({ ...rutaDeEjemplo('r-1', 'Centro'), payments: [mkPagoOps('p1', 'r-1', OPS_HOY, 40)], expenses: [] })
  const fNorte = routeOpsFacts({ ...rutaDeEjemplo('r-2', 'Norte'), payments: [mkPagoOps('p2', 'r-2', OPS_HOY, 80)], expenses: [] })
  const totales = officeOpsTotals([fCentro, fNorte])

  check('OFFICE-DASH-ADV-001 — el comparativo por ruta produce un hecho por ruta',
    fCentro.routeId === 'r-1' && fNorte.routeId === 'r-2' && fCentro.nombre === 'Centro')
  check('OFFICE-OPS-007 — los totales suman exactamente las rutas recibidas',
    totales.aCobrarHoy === 280 && totales.recaudadoHoy === 120 && totales.carteraActiva === 300)
  check('OFFICE-OPS-007b — el cumplimiento del total se recalcula, no se promedia',
    totales.cumplimiento === 43)   // 120/280
  check('OFFICE-OPS-007b2 — el pendiente total suma los pendientes reales de cada ruta',
    totales.pendienteHoy === 160)
  check('OFFICE-OPS-007c — una ruta NO incluida no puede aparecer en los totales',
    officeOpsTotals([fCentro]).aCobrarHoy === 120)
  check('OFFICE-OPS-007d — una Oficina sin rutas visibles da totales en cero',
    officeOpsTotals([]).aCobrarHoy === 0 && officeOpsTotals([]).cumplimiento === 0)
}

// --- Consolidado financiero: suma de lo que ya produce el motor de caja ---
{
  const caja = (over: Partial<RouteCashLike> = {}): RouteCashLike => ({
    cobros: 0, gastos: 0, prestamosEntregados: 0, retiros: 0,
    transferenciasEntradas: 0, transferenciasSalidas: 0, saldoActual: 0, ...over,
  })
  const fin = officeFinanceTotals(
    [caja({ cobros: 100, gastos: 10, saldoActual: 500 }), caja({ cobros: 50, retiros: 25, saldoActual: 300 })],
    [{ baseActual: 500, carteraEnCalle: 1000 }, { baseActual: 300, carteraEnCalle: 700 }],
  )
  check('OFFICE-FIN-001 — la caja de Oficina agrega las rutas recibidas',
    fin.cobros === 150 && fin.saldoActual === 800)
  check('OFFICE-FIN-002 — los gastos y retiros se agregan igual',
    fin.gastos === 10 && fin.retiros === 25)
  check('OFFICE-FIN-002b — base y cartera se agregan, y el total es su suma',
    fin.baseActual === 800 && fin.carteraEnCalle === 1700 && fin.totalControlado === 2500)
  check('OFFICE-FIN-002c — sin rutas, el consolidado es cero y no rompe',
    officeFinanceTotals([], []).totalControlado === 0)
}

// --- OFFICE-FIN-003/004: el consolidado depende del PERMISO financiero ---
{
  const conCaja = mkUser('admin', { id: 'u-fin', authorizedRouteIds: ['r-1'] })
  const sinCaja = mkUser('cobrador', { id: 'u-cob-fin', authorizedRouteIds: ['r-1'] })
  check('OFFICE-FIN-003 — el Administrador tiene permiso sobre la caja de ruta',
    can(conCaja, 'cashbox.viewRoute', { routeId: 'r-1' }))
  check('OFFICE-FIN-004 — el Cobrador NO puede ver la caja financiera de la ruta',
    !can(sinCaja, 'cashbox.viewRoute', { routeId: 'r-1' }))
  // Y el servicio ni siquiera calcula el consolidado cuando falta el permiso.
  const svc = readSourceFile('src/services/officeService.ts')
  check('OFFICE-FIN-003b — el servicio condiciona el consolidado al permiso',
    svc.includes("can(user, 'cashbox.viewRoute', { routeId: r.id, tenantId })") &&
    svc.includes('let finance: OfficeFinanceTotals | null = null'))
}

// --- OFFICE-DASH-ADV-003: alertas operativas avanzadas ---
{
  const fMal = routeOpsFacts({ ...rutaDeEjemplo('r-1', 'Centro'), payments: [], expenses: [] })
  const alertas = opsAlerts({ facts: [fMal], routesWithoutAdmin: [{ routeId: 'r-9', nombre: 'Huérfana' }] })

  check('OFFICE-DASH-ADV-003a — la cartera vencida genera alerta',
    alertas.some(a => a.kind === 'cartera-vencida' && a.routeId === 'r-1'))
  check('OFFICE-DASH-ADV-003b — los clientes con atraso generan alerta con su conteo',
    alertas.some(a => a.kind === 'clientes-atraso' && a.mensaje.includes('1 cliente')))
  check('OFFICE-DASH-ADV-003c — el cumplimiento bajo genera alerta',
    alertas.some(a => a.kind === 'cumplimiento-bajo' && a.mensaje.includes('0%')))
  check('OFFICE-DASH-ADV-003d — una ruta sin Administrador genera alerta',
    alertas.some(a => a.kind === 'sin-administrador' && a.mensaje.includes('Huérfana')))
}

// Una ruta sana no genera alertas falsas, y un día sin cuotas no es incumplimiento.
{
  const sana = routeOpsFacts({
    routeId: 'r-ok', nombre: 'Sana',
    sales: [mkVentaOps('s-ok', 'r-ok', 'c-ok')],
    installmentsBySale: new Map([['s-ok', [mkCuotaOps('i-ok', 's-ok', OPS_MANANA, 40)]]]),
    payments: [], expenses: [], today: OPS_HOY,
  })
  check('OFFICE-DASH-ADV-003e — una ruta sana no genera alertas',
    opsAlerts({ facts: [sana] }).length === 0)
  check('OFFICE-DASH-ADV-003f — un día sin cuotas no se marca como incumplimiento',
    sana.aCobrarHoy === 0 && !opsAlerts({ facts: [sana] }).some(a => a.kind === 'cumplimiento-bajo'))
}

// --- OFFICE-DASH-ADV-004: alcance parcial nunca aparenta el total ---
{
  check('OFFICE-DASH-ADV-004 — el alcance parcial se rotula como parcial',
    officeScope(2, 4).parcial && officeScope(2, 4).label === '2 de 4 rutas visibles — rutas autorizadas')
  check('OFFICE-DASH-ADV-004b — el alcance completo no lleva coletilla',
    !officeScope(4, 4).parcial)
  // Y el estado operativo se deriva, no se persiste.
  const resumen = officeStateSummary({
    rutasVisibles: 5, rutasOperativas: 4, rutasSinCobrador: 1, rutasInactivas: 0,
    clientesActivos: 0, ventasActivas: 0, desembolsosPendientes: 0, carteraEnCalle: 0,
  })
  check('OFFICE-OPS-008 — el estado operativo es un resumen derivado',
    resumen.includes('5 ruta(s)') && resumen.includes('4 operativa(s)') && resumen.includes('1 sin Cobrador'))
}

// --- OFFICE-DASH-ADV-002: una Oficina inactiva sigue siendo consultable ---
{
  const svc = readSourceFile('src/services/officeService.ts')
  check('OFFICE-DASH-ADV-002 — el resumen no filtra por estado de la Oficina',
    !/office\.status\s*[!=]==\s*'inactiva'[\s\S]{0,80}return null/.test(svc))
}

// --- Scoping: el módulo operativo no consulta la base ni conoce la Oficina ---
{
  const ops = readSourceFile('src/lib/officeOperations.ts')
  check('OFFICE-OPS-SCOPE-001 — el módulo operativo es puro (no importa la base)',
    !ops.includes("from '@/lib/db'"))
  // La palabra puede aparecer en un comentario que explique justamente que NO se
  // consulta por Oficina; lo que se prohíbe es USARLA en código.
  const sinComentarios = ops.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
  check('OFFICE-OPS-SCOPE-002 — no recibe ni conoce la Oficina: solo filas de rutas',
    !/officeId/.test(sinComentarios))
  const svc = readSourceFile('src/services/officeService.ts')
  check('OFFICE-OPS-SCOPE-003 — los hechos operativos se calculan sobre accessibleOfficeRoutes',
    svc.includes('accessibleOfficeRoutes.map(r => routeOpsFacts({'))
  check('OFFICE-OPS-SCOPE-004 — las filas se recortan por las rutas visibles',
    svc.includes('sales.filter(s => routeIds.has(s.routeId))'))
  check('OFFICE-PERF-002 — las filas se cargan una vez y se indexan (sin N+1)',
    svc.includes('const installmentsBySale = new Map<string, Installment[]>()'))
}

// ============================================================
// AJUSTES UX ABSORBIDOS DE LA ENTREGA 2 (contrato sobre el código)
// ============================================================
{
  const lista = readSourceFile('src/pages/admin/OfficesPage.tsx')
  const detalle = readSourceFile('src/pages/admin/OfficeDetailPage.tsx')

  // Se elimina el BANNER explicativo. El texto del estado vacío se conserva: es
  // funcional (dice qué hacer cuando no hay ninguna oficina), no una explicación
  // del funcionamiento obvio.
  check('OFFICE-UX-001 — OficinasPage ya no muestra el banner explicativo general',
    !lista.includes('agrupan rutas') &&
    !lista.includes('el acceso sigue dependiendo de las rutas asignadas'))
  check('OFFICE-UX-002 — OfficeDetail ya no explica que los usuarios son de la empresa',
    !detalle.includes('Los usuarios pertenecen a la empresa, no a la oficina'))
  check('OFFICE-UX-003 — la barra de acciones no lleva texto explicativo',
    !detalle.includes('Estos accesos abren cada módulo filtrado por'))
  check('OFFICE-UX-004a — la sección de usuarios usa filas compactas',
    detalle.includes('Lista COMPACTA') && detalle.includes('divide-y divide-gray-50'))
  check('OFFICE-UX-004b — el enlace largo se sustituyó por un botón corto',
    !detalle.includes('Editar sus rutas de esta oficina') &&
    detalle.includes('onClick={() => openAssign(u.id)}>Editar</Button>'))

  check('OFFICE-ACTIONBAR-001 — la barra de acciones queda anclada al borde inferior',
    detalle.includes('sticky bottom-0'))
  check('OFFICE-ACTIONBAR-001c — en pantallas estrechas se desplaza en vez de romperse',
    detalle.includes('overflow-x-auto'))

  // --- Corrección: la barra NO puede invadir el sidebar ---
  check('OFFICE-ACTIONBAR-003 — pertenece al contenedor principal, no al viewport',
    detalle.includes('sticky bottom-0') && !detalle.includes('fixed bottom-0'))
  check('OFFICE-ACTIONBAR-004 — no ocupa el ancho del viewport ignorando el sidebar',
    !detalle.includes('left-0 right-0'))
  // El <main> del layout es el contenedor de scroll: `sticky` se ancla a él.
  const layout = readSourceFile('src/components/layout/AdminLayout.tsx')
  check('OFFICE-ACTIONBAR-005a — el layout ofrece un contenedor de scroll propio',
    layout.includes('<main className="flex-1 overflow-y-auto">'))
  // Se inspecciona SOLO el bloque de la barra: en el resto de la pantalla hay
  // sangrías legítimas (`ml-6`, `ml-7`) que no tienen que ver con el sidebar.
  const barra = detalle.slice(detalle.indexOf('BARRA DE ACCIONES ANCLADA'),
                              detalle.indexOf('Mover ruta de Oficina'))
  check('OFFICE-ACTIONBAR-005b — la barra no usa desplazamientos hardcodeados del sidebar',
    !/left-\[?\d/.test(barra) && !/ml-\d+/.test(barra) &&
    !barra.includes('w-56') && !barra.includes('w-64') && !barra.includes('calc('))
  check('OFFICE-ACTIONBAR-006a — la barra llega de borde a borde del área de contenido',
    detalle.includes('sticky bottom-0 z-20 -mx-4 md:-mx-6'))
  check('OFFICE-ACTIONBAR-006b — en responsive todos los accesos siguen alcanzables',
    detalle.includes('overflow-x-auto') && detalle.includes('w-max md:w-auto'))
  for (const destino of ['clients', 'active-sales', 'cashbox', 'reports', 'weekly-settlement', 'routes']) {
    check(`OFFICE-ACTIONBAR-002 — la barra incluye ${destino} con contexto de Oficina`,
      detalle.includes(`/admin/${destino}?officeId=\${office.id}`))
  }
}


// ============================================================
// ENTREGA 4 — VISIÓN EJECUTIVA, ROLES Y EXPORTACIONES
// ------------------------------------------------------------
// El comparativo entre Oficinas y el resumen de empresa se construyen SOLO con
// los hechos de las rutas accesibles. El conteo de rutas totales sirve para
// declarar el alcance parcial; es un número, no un acceso.
// ============================================================
const EXEC_HOY = '2026-09-16'

const mkFact = (routeId: string, nombre: string, over: Partial<RouteOpsFacts> = {}): RouteOpsFacts => ({
  routeId, nombre, clientesActivos: 1, ventasActivas: 1, parcelasPendientes: 1,
  aCobrarHoy: 100, recaudadoHoy: 50, pendienteHoy: 50, cumplimiento: 50,
  carteraActiva: 1000, carteraVencida: 0, clientesConAtraso: 0,
  gastosHoy: 10, desembolsosPendientes: 0, ...over,
})

const OFI_A = { id: 'of-a', tenantId: 't1', nombre: 'Leticia', codigo: 'LET', status: 'activa' as const, createdAt: '', updatedAt: '' }
const OFI_B = { id: 'of-b', tenantId: 't1', nombre: 'Río', status: 'inactiva' as const, createdAt: '', updatedAt: '' }

// Empresa: Leticia 3 rutas, Río 1, una Sin Oficina. El usuario ve 2 de Leticia,
// la de Río y la suelta. NO ve la tercera de Leticia.
const EXEC_TODAS = [
  { id: 'r-a1', officeId: 'of-a' }, { id: 'r-a2', officeId: 'of-a' }, { id: 'r-a3', officeId: 'of-a' },
  { id: 'r-b1', officeId: 'of-b' },
  { id: 'r-x', officeId: undefined },
]
const EXEC_ACCESIBLES = EXEC_TODAS.filter(r => r.id !== 'r-a3')
const EXEC_FACTS = [
  mkFact('r-a1', 'Centro'), mkFact('r-a2', 'Mercado', { carteraVencida: 200, clientesConAtraso: 2 }),
  mkFact('r-b1', 'Puerto', { recaudadoHoy: 100, pendienteHoy: 0, aCobrarHoy: 100, cumplimiento: 100 }),
  mkFact('r-x', 'Antigua'),
]

const EXEC_FILAS = officeComparison({
  facts: EXEC_FACTS, accessibleRoutes: EXEC_ACCESIBLES, allRoutes: EXEC_TODAS,
  offices: [OFI_A, OFI_B], alertCountByOffice: { 'of-a': 3 },
})

// --- OFFICE-COMPARE-001/002 ---
check('OFFICE-COMPARE-001 — el comparativo suma solo las rutas accesibles',
  EXEC_FILAS.find(f => f.officeId === 'of-a')!.rutasVisibles === 2)
check('OFFICE-COMPARE-001b — la fila declara el alcance parcial',
  EXEC_FILAS.find(f => f.officeId === 'of-a')!.parcial &&
  EXEC_FILAS.find(f => f.officeId === 'of-a')!.alcance === '2/3 rutas')   // Leticia tiene 3 en la empresa
check('OFFICE-COMPARE-001c — una Oficina con alcance completo no se marca parcial',
  !EXEC_FILAS.find(f => f.officeId === 'of-b')!.parcial)
check('OFFICE-COMPARE-001d — los totales de la fila agregan sus rutas visibles',
  EXEC_FILAS.find(f => f.officeId === 'of-a')!.totals.carteraActiva === 2000 &&
  EXEC_FILAS.find(f => f.officeId === 'of-a')!.totals.carteraVencida === 200)
check('OFFICE-COMPARE-001e — el estado de la Oficina viaja a la fila',
  EXEC_FILAS.find(f => f.officeId === 'of-b')!.status === 'inactiva')

{
  const empresa = companyOfficesSummary(EXEC_FILAS)
  const sumaFilas = EXEC_FILAS.reduce((n, f) => n + f.totals.carteraActiva, 0)
  check('OFFICE-COMPARE-002 — el total cuadra exactamente con la suma de las filas',
    empresa.totals.carteraActiva === sumaFilas && sumaFilas === 4000)
  check('OFFICE-COMPARE-002b — el cumplimiento del total se recalcula sobre la meta agregada',
    empresa.totals.cumplimiento === 63)   // 250/400
  check('OFFICE-COMPARE-002c — el conteo de rutas visibles cuadra',
    empresa.rutasVisibles === 4 && empresa.rutasSinOficina === 1)
  check('OFFICE-COMPARE-002d — las alertas se agregan',
    empresa.alertas === 3)
}

// --- OFFICE-EXEC-001/002/003 ---
check('OFFICE-EXEC-001 — el resumen de empresa agrupa las Oficinas visibles',
  companyOfficesSummary(EXEC_FILAS).oficinasVisibles === 2)
check('OFFICE-EXEC-002 — "Sin Oficina" aparece como grupo derivado, al final',
  EXEC_FILAS[EXEC_FILAS.length - 1].officeId === NO_OFFICE &&
  EXEC_FILAS[EXEC_FILAS.length - 1].nombre === NO_OFFICE_LABEL)
check('OFFICE-EXEC-002b — no se inventa un registro de Oficina para ese grupo',
  !EXEC_FILAS.some(f => f.officeId === NO_OFFICE && f.status !== null))
check('OFFICE-EXEC-003 — la ruta no autorizada no aporta a ninguna fila',
  !EXEC_FILAS.some(f => f.totals.carteraActiva > 2000) &&
  EXEC_FILAS.reduce((n, f) => n + f.rutasVisibles, 0) === 4)
check('OFFICE-EXEC-003b — el orden es alfabético con "Sin Oficina" al final',
  EXEC_FILAS.map(f => f.nombre).join(',') === 'Leticia,Río,Sin Oficina')

// Una Oficina sin rutas visibles no genera fila: no se insinúa lo que no se ve.
check('OFFICE-EXEC-004 — una Oficina sin rutas accesibles no aparece en el comparativo',
  !officeComparison({
    facts: [mkFact('r-a1', 'Centro')],
    accessibleRoutes: [{ id: 'r-a1', officeId: 'of-a' }],
    allRoutes: EXEC_TODAS, offices: [OFI_A, OFI_B],
  }).some(f => f.officeId === 'of-b'))

// --- OFFICE-EXPORT-001/002 ---
{
  const resumen = officeSummaryCsvRows({
    office: OFI_A, fecha: EXEC_HOY, visibles: 2, totales: 4,
    totals: EXEC_FILAS.find(f => f.officeId === 'of-a')!.totals, alertas: 3,
  })
  check('OFFICE-EXPORT-001 — el CSV de resumen trae una fila con las cifras visibles',
    resumen.length === 1 && resumen[0]['Rutas visibles'] === 2 && resumen[0].Cartera === 2000)
  check('OFFICE-EXPORT-002 — el CSV declara el alcance parcial',
    resumen[0].Alcance === '2 de 4 rutas autorizadas')
  check('OFFICE-EXPORT-002b — con alcance completo lo dice explícitamente',
    (officeSummaryCsvRows({
      office: OFI_A, fecha: EXEC_HOY, visibles: 4, totales: 4,
      totals: EXEC_FILAS[0].totals, alertas: 0,
    })[0].Alcance as string).includes('alcance completo'))

  const rutas = officeRoutesCsvRows({ office: OFI_A, fecha: EXEC_HOY, facts: EXEC_FACTS.slice(0, 2) })
  check('OFFICE-EXPORT-001b — el CSV de rutas trae una fila por ruta visible',
    rutas.length === 2 && rutas[0].Ruta === 'Centro')
  check('OFFICE-EXPORT-001c — el CSV de rutas nunca incluye una ruta no visible',
    !rutas.some(r => r.Ruta === 'Norte'))
  check('OFFICE-EXPORT-003 — el texto de alcance es explícito en ambos casos',
    alcanceCsv(2, 4) === '2 de 4 rutas autorizadas' && alcanceCsv(4, 4).includes('completo'))
}

// --- OFFICE-ACTIVITY-001/002 ---
{
  const filas: ActivityRowLike[] = [
    { id: 'a1', createdAt: '2026-09-16T10:00:00.000Z', action: 'REGISTER_PAYMENT', descripcion: 'Pago registrado por 50', routeId: 'r-a1', userId: 'u-1' },
    { id: 'a2', createdAt: '2026-09-16T11:00:00.000Z', action: 'CREATE_SALE', descripcion: 'Venta creada', routeId: 'r-a3', userId: 'u-1' },
    { id: 'a3', createdAt: '2026-09-16T09:00:00.000Z', action: 'CREATE_EXPENSE', descripcion: 'Gasto registrado', routeId: 'r-a2', userId: 'u-2' },
    { id: 'a4', createdAt: '2026-09-16T12:00:00.000Z', action: 'UPDATE_TENANT', descripcion: 'Empresa actualizada', userId: 'u-1' },
  ]
  const vista = officeActivity({
    rows: filas, officeRouteIds: ['r-a1', 'r-a2'],
    routeNameById: new Map([['r-a1', 'Centro'], ['r-a2', 'Mercado']]),
    userNameById: new Map([['u-1', 'Ana'], ['u-2', 'Luis']]),
  })

  check('OFFICE-ACTIVITY-001 — la actividad de una ruta autorizada aparece',
    vista.some(v => v.id === 'a1') && vista.some(v => v.id === 'a3'))
  check('OFFICE-ACTIVITY-002 — la actividad de una ruta NO autorizada no aparece',
    !vista.some(v => v.id === 'a2'))
  check('OFFICE-ACTIVITY-002b — una acción sin ruta no se atribuye a la Oficina',
    !vista.some(v => v.id === 'a4'))
  check('OFFICE-ACTIVITY-003 — se ordena de más reciente a más antigua',
    vista[0].id === 'a1' && vista[1].id === 'a3')
  check('OFFICE-ACTIVITY-004 — se resuelven los nombres de ruta y actor',
    vista[0].routeNombre === 'Centro' && vista[0].actorNombre === 'Ana')
  check('OFFICE-ACTIVITY-005 — se respeta el límite',
    officeActivity({ rows: filas, officeRouteIds: ['r-a1', 'r-a2'], limit: 1 }).length === 1)
  check('OFFICE-ACTIVITY-006 — sin rutas accesibles no hay actividad',
    officeActivity({ rows: filas, officeRouteIds: [] }).length === 0)
}

// --- Roles: Supervisor, Secretario y Socio ---
{
  const RUTAS_ROL = [
    mkRutaE2('r-L1', OFI_LET, 'Centro'), mkRutaE2('r-L2', OFI_LET, 'Norte'),
    mkRutaE2('r-R1', OFI_RIO, 'Puerto'),
  ]
  const sup = mkUser('supervisor', { id: 'u-sup', authorizedRouteIds: ['r-L1', 'r-R1'] })
  const suyas = filterAccessibleRoutes(sup, RUTAS_ROL)
  const grupos = groupRoutesByOffice(suyas, [mkOficinaE2(OFI_LET, 'Leticia'), mkOficinaE2(OFI_RIO, 'Río')])

  check('OFFICE-ROLE-SUP-001 — el Supervisor multi-Oficina ve solo sus rutas',
    suyas.length === 2 && !suyas.some(r => r.id === 'r-L2'))
  check('OFFICE-ROLE-SUP-001b — agrupadas por Oficina, sin las hermanas no autorizadas',
    grupos.length === 2 && grupos.every(g => g.routes.length === 1))
  check('OFFICE-ROLE-SUP-002 — el Supervisor no gestiona el catálogo de Oficinas',
    !can(sup, 'office.create') && !can(sup, 'office.edit') && !can(sup, 'office.delete'))
  check('OFFICE-ROLE-SUP-003 — y sigue sin acceder a la ruta hermana',
    !canAccessRoute(sup, 'r-L2'))

  const sec = mkUser('secretario', { id: 'u-sec', authorizedRouteIds: ['r-L1'] })
  const clientesSec = [{ id: 'c1', routeId: 'r-L1' }, { id: 'c2', routeId: 'r-L2' }]
  const visiblesSec = visibleRouteIds({ accessibleRoutes: filterAccessibleRoutes(sec, RUTAS_ROL), officeId: OFI_LET })
  check('OFFICE-ROLE-SEC-001 — el Secretario filtra clientes por Oficina y Ruta',
    filterRowsByVisibleRoutes(clientesSec, visiblesSec).map(c => c.id).join() === 'c1')
  check('OFFICE-ROLE-SEC-002 — sus correcciones no escapan del alcance',
    can(sec, 'payment.correct', { routeId: 'r-L1' }) && !can(sec, 'payment.correct', { routeId: 'r-L2' }))
  check('OFFICE-ROLE-SEC-003 — el Secretario tampoco gestiona Oficinas',
    !can(sec, 'office.create') && !can(sec, 'office.changeStatus'))

  const socio = mkUser('socio', { id: 'u-socio', authorizedRouteIds: ['r-L1'] })
  const suyasSocio = filterAccessibleRoutes(socio, RUTAS_ROL)
  const filasSocio = officeComparison({
    facts: [mkFact('r-L1', 'Centro')],
    accessibleRoutes: suyasSocio.map(r => ({ id: r.id, officeId: r.officeId })),
    allRoutes: RUTAS_ROL.map(r => ({ id: r.id, officeId: r.officeId })),
    offices: [mkOficinaE2(OFI_LET, 'Leticia'), mkOficinaE2(OFI_RIO, 'Río')],
  })
  check('OFFICE-ROLE-PARTNER-001 — el Socio ve el consolidado de SUS rutas por Oficina',
    filasSocio.length === 1 && filasSocio[0].nombre === 'Leticia' && filasSocio[0].rutasVisibles === 1)
  check('OFFICE-ROLE-PARTNER-002 — con alcance parcial no aparenta el total de la Oficina',
    filasSocio[0].parcial && filasSocio[0].alcance === '1/2 rutas')
  check('OFFICE-ROLE-PARTNER-003 — el Socio es de consulta: no gestiona Oficinas ni rutas',
    !can(socio, 'office.create') && !can(socio, 'route.edit', { routeId: 'r-L1' }))
}

// --- Contrato de código de la Entrega 4 ---
{
  const exec = readSourceFile('src/lib/officeExecutive.ts')
  check('OFFICE-EXEC-ARCH-001 — el módulo ejecutivo es puro (no importa la base)',
    !exec.includes("from '@/lib/db'"))
  const svc = readSourceFile('src/services/officeService.ts')
  check('OFFICE-EXEC-ARCH-002 — el resumen ejecutivo recorta por usuario antes de agrupar',
    svc.includes('const accessible = filterAccessibleRoutes(user, allRoutes)') &&
    svc.indexOf('const accessible = filterAccessibleRoutes(user, allRoutes)') < svc.indexOf('officeComparison({'))
  check('OFFICE-EXEC-ARCH-003 — la actividad se recorta por las rutas accesibles',
    svc.includes('officeRouteIds: [...routeIds]'))

  const panel = readSourceFile('src/components/ui/OfficesExecutivePanel.tsx')
  check('OFFICE-EXEC-ARCH-004 — el panel ejecutivo permite entrar a cada Oficina',
    panel.includes('/admin/offices/${officeId}') && panel.includes("'/admin/offices/sin-oficina'"))
  const dash = readSourceFile('src/pages/admin/DashboardPage.tsx')
  check('OFFICE-EXEC-ARCH-005 — el Dashboard de empresa monta el panel de Oficinas',
    dash.includes('<OfficesExecutivePanel />'))

  // Roles: las pantallas usan el filtro compartido, no una implementación propia.
  for (const [rol, archivo] of [
    ['Secretario', 'src/pages/secretario/SecretarioClientsPage.tsx'],
    ['Socio', 'src/pages/socio/SocioClientsPage.tsx'],
  ] as const) {
    check(`OFFICE-ROLE-ARCH — ${rol} usa el filtro Oficina → Ruta compartido`,
      readSourceFile(archivo).includes('useOfficeRouteFilter()'))
  }
  check('OFFICE-ROLE-ARCH-b — el panel del Socio agrupa su consolidado por Oficina',
    readSourceFile('src/pages/socio/SocioDashboardPage.tsx').includes('groupRoutesByOffice(routes, allOffices)'))
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

// Un actor ADMINISTRATIVO registra un cobro hecho por A: el dinero es de A, no de
// quien digita. [MODIFICADO 2026-09-24 — regla Supervisor: antes el actor era el
// Supervisor; por la regla definitiva el Supervisor ya no puede cargar su cobro a
// otra persona, así que la intención se conserva con un Admin.]
const rExp = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-atrCobA', routeCollectors: [atrCobA, atrCobB] })
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

// ------------------------------------------------------------
// ATRIB-SUP — EL SUPERVISOR COMO RESPONSABLE DEL EFECTIVO (Fase 1)
// ------------------------------------------------------------
// Antes, el universo de responsables era SOLO el rol 'cobrador': un Supervisor que
// cobraba en persona no podía indicarse ni a sí mismo (devolvía 'invalid') y el
// dinero se cargaba al cobrador habitual. Ver auditoría §29 CASO B.
const atrSup = { id: 'u-sup', rol: 'supervisor' as UserRole, status: 'activo' as const }
const atrSupInactivo = { id: 'u-supOff', rol: 'supervisor' as UserRole, status: 'inactivo' as const }

// 1) El Supervisor actor queda como responsable aunque se indique a sí mismo.
//    [MODIFICADO 2026-09-24: source 'explicit' → 'actor'. Regla definitiva: el
//    Supervisor responde por su registro por ser quien cobra, no por elegirse.]
const rSupYo = resolveResponsibleCollector({ actor: actorSup, requested: 'u-sup', routeCollectors: [atrCobA] })
check('ATRIB-SUP — el Supervisor puede indicarse a si mismo', rSupYo.ok && rSupYo.collectorId === 'u-sup' && rSupYo.source === 'actor')

// 2) [SUSTITUIDO 2026-09-24] Regla anterior (Fase 1): con cobradores en la ruta el
//    Supervisor debía ELEGIR ('must-choose'). Regla definitiva aprobada por
//    negocio: el Supervisor que registra el pago ES el responsable, sin selector.
const rSupAuto = resolveResponsibleCollector({ actor: actorSup, routeCollectors: [atrCobA] })
check('SUP-RESP — con un cobrador en la ruta el Supervisor responde automaticamente', rSupAuto.ok && rSupAuto.collectorId === 'u-sup' && rSupAuto.source === 'actor')
const rSupDos = resolveResponsibleCollector({ actor: actorSup, routeCollectors: [atrCobA, atrCobB] })
check('SUP-RESP — con dos cobradores en la ruta el Supervisor responde automaticamente', rSupDos.ok && rSupDos.collectorId === 'u-sup')
const rSupDesvio = resolveResponsibleCollector({ actor: actorSup, requested: 'u-atrCobA', routeCollectors: [atrCobA, atrCobB] })
check('SUP-RESP — el Supervisor NO puede cargar su cobro a un Cobrador', !rSupDesvio.ok && rSupDesvio.code === 'actor-owns-cash')
const rCobDesvio = resolveResponsibleCollector({ actor: actorCob, requested: 'u-atrCobB', routeCollectors: [atrCobA, atrCobB] })
check('SUP-RESP — el Cobrador NO puede cargar su cobro a otro Cobrador', !rCobDesvio.ok && rCobDesvio.code === 'actor-owns-cash')

// 3) Y tampoco se preselecciona al cobrador habitual cuando el Supervisor opera.
check('ATRIB-SUP — no se preselecciona al cobrador habitual si el Supervisor opera', !(rSupAuto.ok && (rSupAuto as { collectorId: string }).collectorId === 'u-atrCobA'))

// 4) Ruta SIN cobradores: el Supervisor responde.
//    [MODIFICADO 2026-09-24: source 'legacy-actor' → 'actor'. Ya no es la rama de
//    respaldo: es la regla general del Supervisor.]
const rSupSolo = resolveResponsibleCollector({ actor: actorSup, routeCollectors: [] })
check('ATRIB-SUP — sin cobradores en la ruta el Supervisor responde', rSupSolo.ok && rSupSolo.collectorId === 'u-sup' && rSupSolo.source === 'actor')

// 5) Un Supervisor ASIGNADO a la ruta es destino válido aunque no sea el actor.
const rSupOtro = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-sup', routeCollectors: [atrCobA, atrSup] })
check('ATRIB-SUP — un Supervisor de la ruta es destino valido para el Admin', rSupOtro.ok && rSupOtro.collectorId === 'u-sup')

// 6) Un Supervisor INACTIVO no puede recibir efectivo.
const rSupOff = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-supOff', routeCollectors: [atrCobA, atrSupInactivo] })
check('ATRIB-SUP — un Supervisor inactivo se rechaza', !rSupOff.ok && rSupOff.code === 'invalid')

// 7) El Admin NO amplia su alcance: sigue sin caja personal ni indicandose.
const rAdmYo = resolveResponsibleCollector({ actor: actorAdmin, requested: 'u-adm', routeCollectors: [atrCobA] })
check('ATRIB-SUP — el Admin no puede atribuirse el efectivo', !rAdmYo.ok && rAdmYo.code === 'invalid')

// 8) El Admin conserva la preseleccion con un unico cobrador (no compite por la caja).
const rAdmUno = resolveResponsibleCollector({ actor: actorAdmin, routeCollectors: [atrCobA] })
check('ATRIB-SUP — el Admin conserva la preseleccion de un unico cobrador', rAdmUno.ok && rAdmUno.source === 'single-route-collector')

// 9) Predicado de elegibilidad: activo + rol con caja personal.
check('ATRIB-SUP — cobrador activo es elegible', isEligibleCashHolder(atrCobA))
check('ATRIB-SUP — supervisor activo es elegible', isEligibleCashHolder(atrSup))
check('ATRIB-SUP — cobrador inactivo NO es elegible', !isEligibleCashHolder(atrCobInactivo))
check('ATRIB-SUP — supervisor inactivo NO es elegible', !isEligibleCashHolder(atrSupInactivo))
check('ATRIB-SUP — un admin activo NO es elegible', !isEligibleCashHolder({ id: 'u-adm', rol: 'admin', status: 'activo' }))

console.log(`\nPRUEBA DE PERMISOS: ${passed} OK, ${failed} FALLIDAS`)
if (failed > 0) process.exit(1)
