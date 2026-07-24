// ============================================================
// PRUEBA EJECUTABLE — Matriz de permisos (modelo de roles)
// ------------------------------------------------------------
// No requiere framework. Ejecuta con:
//   npx esbuild tests/permissions.test.ts --bundle --format=esm --platform=node --outfile=tests/_out.mjs && node tests/_out.mjs
// (o el script `npm run test:permissions`). Falla con exit 1 si algún caso no se cumple.
// Valida SOLO la lógica pura de permissions.ts (los tipos se eliminan al compilar).
// ============================================================
import {
  can, canManageRole, canAccessRoute, authorizedRouteIdsOf, homePathForRole, ROLE_LABELS,
  hasOperationalRoutes, isRouteUnrestricted, filterByAccessibleRoute, filterAccessibleRoutes,
  isCapabilityCompatible, sanitizeGrantedCapabilities, delegableCapabilitiesFor,
  isPartnerInScope, isTransferInScope, type Capability,
} from '../src/lib/permissions'
import type { User, UserRole } from '../src/models/types'

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

console.log(`\nPRUEBA DE PERMISOS: ${passed} OK, ${failed} FALLIDAS`)
if (failed > 0) process.exit(1)
