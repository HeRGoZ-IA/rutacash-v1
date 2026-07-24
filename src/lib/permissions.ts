// ============================================================
// RUTACASH — MÓDULO CENTRAL DE PERMISOS
// Modelo: ROL BASE + CAPACIDADES + RUTAS AUTORIZADAS
// ------------------------------------------------------------
// Punto ÚNICO de verdad para autorización. No dispersar condicionales
// `user.rol === 'admin'` por la app: usar `can(user, capability, ctx?)`,
// `canAccessRoute`, `canManageRole`, etc.
//
// NOTA DE SEGURIDAD: la app es local (frontend + Dexie). Esto NO representa
// seguridad real frente a manipulación directa del navegador; las validaciones
// se cumplen dentro de la lógica normal de la aplicación (UI, routing y, sobre
// todo, en los servicios que ejecutan cada acción crítica). La autenticación
// segura deberá migrar a un backend en la versión SaaS real.
// ============================================================
import type { User, UserRole } from '@/models/types'

// --- Lista tipada de capacidades ---
export type Capability =
  // Plataforma / Empresa
  | 'platform.access'
  | 'company.create'
  | 'company.edit'
  | 'company.suspend'
  | 'company.enterPanel'
  | 'company.viewConsolidated'
  // Configuración
  | 'settings.access'
  | 'settings.edit'
  | 'capital.manage'
  // Rutas
  | 'route.create'
  | 'route.edit'
  | 'route.block'
  | 'route.delete'
  | 'route.assign'
  | 'route.viewAll'        // todas las rutas del tenant (no limitado)
  | 'route.viewAssigned'   // solo rutas autorizadas
  // Usuarios
  | 'user.viewAll'
  | 'user.create'
  | 'user.edit'
  | 'user.block'
  | 'user.setRole'
  | 'user.grantCapabilities'
  | 'user.resetPassword'
  | 'password.changeOwn'
  // Clientes
  | 'client.create'
  | 'client.view'
  | 'client.edit'          // edición completa
  | 'client.editLimited'   // solo datos operativos (Secretario)
  | 'client.deactivate'    // baja lógica (nunca destructiva)
  // Ventas
  | 'sale.viewActive'
  | 'sale.viewHistory'
  | 'sale.createDirect'    // venta directa sin autorización
  | 'sale.createRequest'   // solicitud pendiente de autorización
  | 'sale.editBeforeDisbursement'
  | 'sale.adjustAfterDisbursement'  // ajuste auditado post-desembolso
  | 'sale.cancel'          // anular por estado + trazabilidad (no destructivo)
  | 'sale.confirmDisbursement'
  // Autorizaciones
  | 'authorization.access'
  | 'authorization.approve'
  | 'authorization.reject'
  | 'authorization.modifyConditions'
  | 'authorization.phoneConfirm'
  // Pagos
  | 'payment.register'
  | 'payment.correct'          // corrección controlada (reversión + reemplazo)
  | 'payment.reverse'          // anulación por reversión
  | 'payment.viewHistory'
  | 'payment.approveAdjustment' // aprobar solicitud de ajuste (periodo cerrado)
  // Gastos
  | 'expense.register'
  | 'expense.correct'
  // Caja
  | 'cashbox.viewRoute'
  | 'cashbox.viewConsolidated'
  | 'cashbox.dailyClose'
  | 'partnerCash.viewOwn'
  | 'partnerCash.viewAll'
  | 'partnerCash.registerMovement'
  | 'transfer.create'
  // Reportes / indicadores
  | 'report.view'
  | 'report.export'
  | 'report.viewPortfolio'      // cartera y mora de rutas accesibles
  | 'report.viewConsolidated'   // indicadores financieros consolidados
  // Auditoría
  | 'audit.view'

// --- Capacidades predeterminadas por rol ---

const SUPERADMIN_CAPS: Capability[] = [
  'platform.access', 'company.create', 'company.edit', 'company.suspend',
  'company.enterPanel', 'company.viewConsolidated',
  'settings.access', 'settings.edit', 'capital.manage',
  'route.create', 'route.edit', 'route.block', 'route.delete', 'route.assign',
  'route.viewAll', 'route.viewAssigned',
  'user.viewAll', 'user.create', 'user.edit', 'user.block', 'user.setRole',
  'user.grantCapabilities', 'user.resetPassword', 'password.changeOwn',
  'client.create', 'client.view', 'client.edit', 'client.editLimited', 'client.deactivate',
  'sale.viewActive', 'sale.viewHistory', 'sale.createDirect', 'sale.createRequest',
  'sale.editBeforeDisbursement', 'sale.adjustAfterDisbursement', 'sale.cancel', 'sale.confirmDisbursement',
  'authorization.access', 'authorization.approve', 'authorization.reject',
  'authorization.modifyConditions', 'authorization.phoneConfirm',
  'payment.register', 'payment.correct', 'payment.reverse', 'payment.viewHistory', 'payment.approveAdjustment',
  'expense.register', 'expense.correct',
  'cashbox.viewRoute', 'cashbox.viewConsolidated', 'cashbox.dailyClose',
  'partnerCash.viewOwn', 'partnerCash.viewAll', 'partnerCash.registerMovement', 'transfer.create',
  'report.view', 'report.export', 'report.viewPortfolio', 'report.viewConsolidated',
  'audit.view',
]

// Administrador: perfil delegado, LIMITADO a sus rutas autorizadas.
// No crea empresas, no elimina rutas, no accede a la plataforma.
const ADMIN_CAPS: Capability[] = [
  'company.enterPanel', 'company.viewConsolidated',
  'settings.access', 'capital.manage',
  'route.create', 'route.edit', 'route.block', 'route.assign', 'route.viewAssigned',
  'user.viewAll', 'user.create', 'user.edit', 'user.block', 'user.setRole',
  'user.grantCapabilities', 'user.resetPassword', 'password.changeOwn',
  'client.create', 'client.view', 'client.edit', 'client.deactivate',
  'sale.viewActive', 'sale.viewHistory', 'sale.createDirect', 'sale.createRequest',
  'sale.editBeforeDisbursement', 'sale.adjustAfterDisbursement', 'sale.cancel', 'sale.confirmDisbursement',
  'authorization.access', 'authorization.approve', 'authorization.reject', 'authorization.modifyConditions',
  'payment.register', 'payment.correct', 'payment.reverse', 'payment.viewHistory', 'payment.approveAdjustment',
  'expense.register', 'expense.correct',
  'cashbox.viewRoute', 'cashbox.viewConsolidated', 'cashbox.dailyClose',
  'partnerCash.viewAll', 'partnerCash.registerMovement', 'transfer.create',
  'report.view', 'report.export', 'report.viewPortfolio', 'report.viewConsolidated',
  'audit.view',
]

// Socio: perfil de CONSULTA (solo lectura) sobre sus rutas autorizadas.
const SOCIO_CAPS: Capability[] = [
  'route.viewAssigned',
  'client.view',
  'sale.viewActive', 'sale.viewHistory',
  'payment.viewHistory',
  'cashbox.viewRoute',
  'partnerCash.viewOwn',
  'report.view', 'report.export', 'report.viewPortfolio', 'report.viewConsolidated',
  'password.changeOwn',
]

// Supervisor: operativo sobre rutas autorizadas. NO venta directa, NO corrige
// pagos, NO aprueba, NO configuración, NO indicadores consolidados.
const SUPERVISOR_CAPS: Capability[] = [
  'route.viewAssigned',
  'client.create', 'client.view',
  'sale.viewActive', 'sale.viewHistory', 'sale.createRequest', 'sale.confirmDisbursement',
  'payment.register', 'payment.viewHistory',
  'expense.register',
  'cashbox.viewRoute', 'cashbox.dailyClose',
  'report.view', 'report.export', 'report.viewPortfolio',
  'password.changeOwn',
]

// Cobrador: opera sus rutas. Como Supervisor pero SIN exportar reportes
// administrativos consolidados. NO venta directa (toda venta = solicitud).
const COBRADOR_CAPS: Capability[] = [
  'route.viewAssigned',
  'client.create', 'client.view',
  'sale.viewActive', 'sale.viewHistory', 'sale.createRequest', 'sale.confirmDisbursement',
  'payment.register', 'payment.viewHistory',
  'expense.register',
  'cashbox.viewRoute', 'cashbox.dailyClose',
  'report.view', 'report.viewPortfolio',
  'password.changeOwn',
]

// Secretario: acceso limitado (Clientes, Autorizaciones, Corrección de pagos).
// NO crea clientes/ventas/pagos/gastos, NO caja, NO transferencias, NO usuarios.
const SECRETARIO_CAPS: Capability[] = [
  'route.viewAssigned',
  'client.view', 'client.editLimited',
  'sale.viewActive', 'sale.viewHistory',
  'authorization.access', 'authorization.approve', 'authorization.reject',
  'authorization.modifyConditions', 'authorization.phoneConfirm',
  'payment.correct', 'payment.viewHistory',
  'report.viewPortfolio',
  'password.changeOwn',
]

export const ROLE_CAPABILITIES: Record<UserRole, Capability[]> = {
  superadmin: SUPERADMIN_CAPS,
  admin: ADMIN_CAPS,
  socio: SOCIO_CAPS,
  supervisor: SUPERVISOR_CAPS,
  cobrador: COBRADOR_CAPS,
  secretario: SECRETARIO_CAPS,
}

/** Capacidades que un rol puede tener, para la UI de delegación (Gestión de usuarios). */
export function capabilitiesForRole(rol: UserRole): Capability[] {
  return ROLE_CAPABILITIES[rol] ?? []
}

// --- CAPACIDADES INCOMPATIBLES POR ROL ---
// Aunque no estén en la matriz base, `grantedCapabilities` NUNCA puede habilitarlas.
// Se bloquean en tres capas: (1) `can()` las rechaza, (2) `sanitizeGrantedCapabilities`
// las elimina antes de guardar, (3) la UI de delegación no las ofrece.
const INCOMPATIBLE_BY_ROLE: Record<UserRole, Capability[]> = {
  superadmin: [],
  admin: [
    // El Administrador no es plataforma ni gestiona empresas ni borra rutas.
    'platform.access', 'company.create', 'company.edit', 'company.suspend',
    'route.delete', 'route.viewAll',
  ],
  socio: [
    // Perfil de consulta: prohibida toda escritura operativa y de gestión.
    'client.create', 'client.edit', 'client.editLimited', 'client.deactivate',
    'sale.createDirect', 'sale.createRequest', 'sale.editBeforeDisbursement',
    'sale.adjustAfterDisbursement', 'sale.cancel', 'sale.confirmDisbursement',
    'payment.register', 'payment.correct', 'payment.reverse', 'payment.approveAdjustment',
    'expense.register', 'expense.correct',
    'authorization.approve', 'authorization.reject', 'authorization.modifyConditions', 'authorization.phoneConfirm',
    'transfer.create', 'partnerCash.registerMovement', 'partnerCash.viewAll',
    'route.create', 'route.edit', 'route.block', 'route.delete', 'route.assign',
    'user.create', 'user.edit', 'user.block', 'user.setRole', 'user.grantCapabilities', 'user.resetPassword',
    'platform.access', 'company.create', 'company.edit', 'company.suspend',
  ],
  supervisor: [
    'sale.createDirect',
    'authorization.approve', 'authorization.reject', 'authorization.modifyConditions', 'authorization.phoneConfirm',
    'payment.correct', 'payment.reverse', 'payment.approveAdjustment',
    'expense.correct',
    'transfer.create', 'partnerCash.viewAll', 'partnerCash.registerMovement',
    'cashbox.viewConsolidated', 'report.viewConsolidated',
    'route.create', 'route.edit', 'route.block', 'route.delete', 'route.assign',
    'user.create', 'user.edit', 'user.block', 'user.setRole', 'user.grantCapabilities', 'user.resetPassword',
    'platform.access', 'company.create', 'company.edit', 'company.suspend', 'settings.access', 'capital.manage',
  ],
  cobrador: [
    'sale.createDirect',
    'authorization.approve', 'authorization.reject', 'authorization.modifyConditions', 'authorization.phoneConfirm',
    'payment.correct', 'payment.reverse', 'payment.approveAdjustment',
    'expense.correct',
    'transfer.create', 'partnerCash.viewAll', 'partnerCash.registerMovement',
    'cashbox.viewConsolidated', 'report.viewConsolidated', 'report.export',
    'route.create', 'route.edit', 'route.block', 'route.delete', 'route.assign',
    'user.create', 'user.edit', 'user.block', 'user.setRole', 'user.grantCapabilities', 'user.resetPassword',
    'platform.access', 'company.create', 'company.edit', 'company.suspend', 'settings.access', 'capital.manage',
  ],
  secretario: [
    'sale.createDirect', 'sale.createRequest',
    'payment.register',
    'expense.register', 'expense.correct',
    'cashbox.viewRoute', 'cashbox.viewConsolidated', 'cashbox.dailyClose',
    'transfer.create', 'partnerCash.viewOwn', 'partnerCash.viewAll', 'partnerCash.registerMovement',
    'route.create', 'route.edit', 'route.block', 'route.delete', 'route.assign',
    'user.create', 'user.edit', 'user.block', 'user.setRole', 'user.grantCapabilities', 'user.resetPassword',
    'platform.access', 'company.create', 'company.edit', 'company.suspend',
  ],
}

/** ¿La capacidad es COMPATIBLE con el rol? (no está en la lista de incompatibles). */
export function isCapabilityCompatible(rol: UserRole, cap: Capability): boolean {
  return !(INCOMPATIBLE_BY_ROLE[rol] ?? []).includes(cap)
}

/** Depura una lista de capacidades otorgadas: elimina incompatibles y las que ya son base. */
export function sanitizeGrantedCapabilities(rol: UserRole, caps: Capability[]): Capability[] {
  const base = new Set(capabilitiesForRole(rol))
  return [...new Set(caps)].filter(c => isCapabilityCompatible(rol, c) && !base.has(c))
}

// --- Jerarquía de roles (creación / bloqueo / reseteo de contraseña) ---

/** Roles que cada rol puede CREAR o EDITAR (jerarquía descendente). */
const MANAGEABLE_ROLES: Record<UserRole, UserRole[]> = {
  superadmin: ['superadmin', 'admin', 'socio', 'supervisor', 'cobrador', 'secretario'],
  admin: ['socio', 'supervisor', 'cobrador', 'secretario'],
  socio: [],
  supervisor: [],
  cobrador: [],
  secretario: [],
}

/** ¿`actor` puede crear/editar/bloquear usuarios con rol `targetRole`? */
export function canManageRole(actor: User | null | undefined, targetRole: UserRole): boolean {
  if (!actor) return false
  return (MANAGEABLE_ROLES[actor.rol] ?? []).includes(targetRole)
}

/** Roles que `actor` puede asignar en el formulario de usuarios. */
export function assignableRoles(actor: User | null | undefined): UserRole[] {
  if (!actor) return []
  return MANAGEABLE_ROLES[actor.rol] ?? []
}

/**
 * ¿`actor` puede administrar (editar/bloquear/reset) al usuario `target`?
 * Reglas: no a sí mismo para bloqueo; jerarquía por rol; mismo tenant (salvo superadmin).
 */
export function canManageUser(actor: User | null | undefined, target: User): boolean {
  if (!actor) return false
  if (actor.rol !== 'superadmin' && actor.tenantId !== target.tenantId) return false
  return canManageRole(actor, target.rol)
}

// --- Rutas autorizadas ---

/**
 * IDs de rutas autorizadas de un usuario (compat: authorizedRouteIds + routeId legacy).
 * El SUPERADMIN devuelve [] aquí (no se limita por rutas: usar `isRouteUnrestricted`).
 */
export function authorizedRouteIdsOf(user?: User | null): string[] {
  if (!user) return []
  const ids = new Set(user.authorizedRouteIds ?? [])
  if (user.routeId) ids.add(user.routeId)
  return [...ids]
}

/**
 * ¿El usuario NO está limitado por rutas autorizadas?
 *
 * REGLA DEFINITIVA (FAIL CLOSED): **solo el Super Admin** tiene acceso global dentro
 * de la empresa. El Administrador SIEMPRE está limitado por `authorizedRouteIds`; sin
 * rutas asignadas su acceso operativo es CERO. Se eliminó por completo la regla
 * insegura "Administrador sin rutas = todas las rutas": la ausencia de asignación
 * nunca amplía privilegios.
 */
export function isRouteUnrestricted(user?: User | null): boolean {
  return user?.rol === 'superadmin'
}

/**
 * ¿El usuario tiene al menos una ruta con la que operar?
 * Super Admin siempre (acceso global). El resto: requiere `authorizedRouteIds` no vacío.
 * Un Administrador sin rutas → false → sin acceso operativo (pantalla informativa).
 */
export function hasOperationalRoutes(user?: User | null): boolean {
  if (!user) return false
  if (user.rol === 'superadmin') return true
  return authorizedRouteIdsOf(user).length > 0
}

/** ¿El usuario puede CONSULTAR la ruta indicada? (fail-closed: sin rutas → false). */
export function canAccessRoute(user: User | null | undefined, routeId: string): boolean {
  if (!user || !routeId) return false
  if (isRouteUnrestricted(user)) return true
  return authorizedRouteIdsOf(user).includes(routeId)
}

/**
 * ¿El usuario puede OPERAR sobre la ruta? (crear/registrar). Mismo criterio de
 * acceso; se separa por claridad semántica y por si en el futuro difieren.
 */
export function canOperateRoute(user: User | null | undefined, routeId: string): boolean {
  return canAccessRoute(user, routeId)
}

/**
 * Filtra una lista de rutas (o de objetos con `routeId`) a las accesibles por el usuario.
 * Para superadmin/admin-sin-límite devuelve la lista completa.
 */
export function filterAccessibleRoutes<T extends { id: string }>(user: User | null | undefined, routes: T[]): T[] {
  if (isRouteUnrestricted(user)) return routes
  const allowed = new Set(authorizedRouteIdsOf(user))
  return routes.filter(r => allowed.has(r.id))
}

/** Filtra registros que referencian `routeId` (clientes, ventas, pagos…) a rutas accesibles. */
export function filterByAccessibleRoute<T extends { routeId: string }>(user: User | null | undefined, rows: T[]): T[] {
  if (isRouteUnrestricted(user)) return rows
  const allowed = new Set(authorizedRouteIdsOf(user))
  return rows.filter(r => allowed.has(r.routeId))
}

/**
 * ¿La transferencia está DENTRO del alcance del usuario? Debe cumplirse para TODAS
 * las entidades implicadas (origen y destino). Rutas → ruta autorizada; Socios →
 * socio vinculado a alguna ruta autorizada (`partnerRouteIds`, ver `isPartnerInScope`).
 * Una transferencia sin ruta/socio resoluble se considera FUERA de alcance (fail-closed).
 */
export function isTransferInScope(
  user: User | null | undefined,
  transfer: { origenType?: 'route' | 'partner'; destinoType?: 'route' | 'partner'; routeOrigenId?: string; routeDestinoId?: string; socioOrigenId?: string; socioDestinoId?: string },
  partnerRouteIds: (socioId: string) => string[],
): boolean {
  if (!user) return false
  if (isRouteUnrestricted(user)) return true
  const allowed = new Set(authorizedRouteIdsOf(user))
  const endpointOk = (type: 'route' | 'partner' | undefined, routeId?: string, socioId?: string): boolean => {
    // Compatibilidad: transferencias antiguas sin type se interpretan como 'route'.
    const t = type ?? 'route'
    if (t === 'route') return !!routeId && allowed.has(routeId)
    if (t === 'partner') return !!socioId && partnerRouteIds(socioId).some(r => allowed.has(r))
    return false
  }
  const originOk = endpointOk(transfer.origenType, transfer.routeOrigenId, transfer.socioOrigenId)
  // El destino es opcional en algunos flujos; si existe, debe estar en alcance.
  const hasDestino = !!transfer.routeDestinoId || !!transfer.socioDestinoId
  const destOk = !hasDestino || endpointOk(transfer.destinoType, transfer.routeDestinoId, transfer.socioDestinoId)
  return originOk && destOk
}

/**
 * ¿El socio (caja de socios) está dentro del alcance del usuario? Un Administrador
 * solo ve socios vinculados a alguna de sus rutas autorizadas. Super Admin: todos.
 * `partnerRouteIds` = rutas autorizadas del socio (su relación socio↔ruta).
 */
export function isPartnerInScope(user: User | null | undefined, partnerRouteIds: string[]): boolean {
  if (!user) return false
  if (isRouteUnrestricted(user)) return true
  const allowed = new Set(authorizedRouteIdsOf(user))
  return partnerRouteIds.some(r => allowed.has(r))
}

// --- Contexto y función central `can` ---

export interface PermissionContext {
  /** Ruta implicada en la acción (se valida contra rutas autorizadas). */
  routeId?: string
  /** Empresa implicada (se valida contra el tenant del usuario, salvo superadmin). */
  tenantId?: string
  /** Rol objetivo (para acciones de gestión de usuarios). */
  targetRole?: UserRole
  /** Usuario objetivo (para acciones de gestión de usuarios). */
  targetUser?: User
  /** Estado de periodo (para corrección de pagos): true si el pago está en periodo cerrado. */
  periodClosed?: boolean
}

/** Capacidades que, cuando llevan `ctx.routeId`, exigen que la ruta esté autorizada. */
const ROUTE_SCOPED: ReadonlySet<Capability> = new Set<Capability>([
  'route.edit', 'route.block', 'route.assign', 'route.viewAssigned',
  'client.create', 'client.view', 'client.edit', 'client.editLimited', 'client.deactivate',
  'sale.viewActive', 'sale.viewHistory', 'sale.createDirect', 'sale.createRequest',
  'sale.editBeforeDisbursement', 'sale.adjustAfterDisbursement', 'sale.cancel', 'sale.confirmDisbursement',
  'authorization.access', 'authorization.approve', 'authorization.reject',
  'authorization.modifyConditions', 'authorization.phoneConfirm',
  'payment.register', 'payment.correct', 'payment.reverse', 'payment.viewHistory', 'payment.approveAdjustment',
  'expense.register', 'expense.correct',
  'cashbox.viewRoute', 'cashbox.dailyClose',
])

/**
 * ¿El usuario `user` posee la capacidad `capability` en el contexto `ctx`?
 * Considera: rol base + capacidades otorgadas − capacidades retiradas, y valida
 * empresa, ruta autorizada, rol objetivo y periodo abierto/cerrado cuando aplica.
 */
export function can(user: User | null | undefined, capability: Capability, ctx?: PermissionContext): boolean {
  if (!user) return false
  if (user.status !== 'activo') return false

  const base = ROLE_CAPABILITIES[user.rol] ?? []
  const granted = (user.grantedCapabilities ?? []) as Capability[]
  const revoked = (user.revokedCapabilities ?? []) as Capability[]

  if (revoked.includes(capability)) return false
  // CAPACIDAD INCOMPATIBLE: aunque figure en `granted` (dato manipulado), se rechaza.
  if (!isCapabilityCompatible(user.rol, capability)) return false
  const hasCap = base.includes(capability) || granted.includes(capability)
  if (!hasCap) return false

  // Empresa: salvo superadmin, la acción debe ser dentro de su tenant.
  if (ctx?.tenantId && user.rol !== 'superadmin' && user.tenantId !== ctx.tenantId) return false

  // Ruta autorizada.
  if (ctx?.routeId && ROUTE_SCOPED.has(capability) && !canAccessRoute(user, ctx.routeId)) return false

  // Gestión de usuarios: jerarquía de roles.
  if (ctx?.targetRole && (capability === 'user.create' || capability === 'user.edit' || capability === 'user.block' || capability === 'user.setRole' || capability === 'user.resetPassword')) {
    if (!canManageRole(user, ctx.targetRole)) return false
  }
  if (ctx?.targetUser && (capability === 'user.edit' || capability === 'user.block' || capability === 'user.resetPassword')) {
    if (!canManageUser(user, ctx.targetUser)) return false
  }

  // Corrección de pago en periodo cerrado: solo quien puede aprobar ajustes.
  if (capability === 'payment.correct' && ctx?.periodClosed) {
    return can(user, 'payment.approveAdjustment', { routeId: ctx.routeId, tenantId: ctx.tenantId })
  }

  return true
}

/**
 * ¿El actor puede otorgar la capacidad `cap` a un usuario con rol `targetRole`?
 * Reglas: (1) el actor debe poder delegar, (2) debe poseer la capacidad, (3) la
 * capacidad debe ser COMPATIBLE con el rol objetivo (no se puede delegar algo
 * prohibido para ese rol, p. ej. `sale.createDirect` a un Supervisor).
 */
export function canGrantCapability(actor: User | null | undefined, cap: Capability, targetRole?: UserRole): boolean {
  if (!actor) return false
  if (!can(actor, 'user.grantCapabilities')) return false
  if (!can(actor, cap)) return false
  if (targetRole && !isCapabilityCompatible(targetRole, cap)) return false
  return true
}

/**
 * Capacidades que `actor` puede DELEGAR a un usuario con rol `targetRole`:
 * las que el actor posee, que no son ya base del objetivo y que son compatibles
 * con el rol objetivo. Fuente única para la UI de Gestión de usuarios.
 */
export function delegableCapabilitiesFor(actor: User | null | undefined, targetRole: UserRole): Capability[] {
  if (!actor) return []
  const actorCaps = new Set<Capability>([
    ...capabilitiesForRole(actor.rol),
    ...((actor.grantedCapabilities ?? []) as Capability[]),
  ])
  const baseTarget = new Set(capabilitiesForRole(targetRole))
  return [...actorCaps].filter(c => !baseTarget.has(c) && isCapabilityCompatible(targetRole, c) && can(actor, c))
}

/** Ruta de inicio (post-login) según el rol. Fuente única para redirección. */
export function homePathForRole(rol: UserRole): string {
  switch (rol) {
    case 'superadmin': return '/platform'
    case 'admin': return '/admin/dashboard'
    case 'socio': return '/socio'
    case 'supervisor': return '/supervisor/home'
    case 'cobrador': return '/collector/home'
    case 'secretario': return '/secretario'
    default: return '/login'
  }
}

/** Etiqueta legible del rol (UI). */
export const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: 'Super Admin',
  admin: 'Administrador',
  socio: 'Socio',
  supervisor: 'Supervisor',
  cobrador: 'Cobrador',
  secretario: 'Secretario',
}
