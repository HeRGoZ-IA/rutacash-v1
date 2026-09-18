// ============================================================
// Creación de rutas (fuente única de asignaciones: User.authorizedRouteIds)
// ------------------------------------------------------------
// REGLA FUNCIONAL VIGENTE (revisión del socio — creación libre de rutas):
//   · El ADMINISTRADOR responsable es OPCIONAL. Una ruta puede nacer sin ningún
//     Administrador y asignársele uno más adelante desde el editor de ruta o desde
//     Gestión de usuarios (misma fuente única: `authorizedRouteIds`).
//   · El COBRADOR responsable TAMBIÉN es OPCIONAL. Una ruta puede nacer sin nadie:
//     queda "creada, pendiente de asignación", NO inválida. Sin Cobrador no hay
//     operación de cobro, pero la ruta existe y se le puede asignar uno después.
//     (Regla anterior derogada: "sin cobrador no hay ruta".)
//   · Si quien crea la ruta es un ADMINISTRADOR, queda SIEMPRE autoasignado. No es
//     una comodidad: el acceso del Administrador es fail-closed por rutas, así que
//     crear una ruta sin quedar dentro lo dejaría sin acceso operativo a la ruta
//     que acaba de crear (auto-bloqueo). El servicio lo garantiza aunque la UI
//     enviara otra cosa.
//   · Si SÍ se seleccionan Administradores, cada uno debe ser un admin ACTIVO del
//     mismo tenant y gestionable por el actor.
//   · La OFICINA también es OPCIONAL. Sin Oficina la ruta queda agrupada bajo
//     "Sin Oficina", que es un estado válido y permanente; puede asignarse después
//     con `moveRouteToOffice` (officeService). La Oficina AGRUPA: no concede acceso
//     ni condiciona la creación.
//
// No hay migración de `Route`: el modelo nunca tuvo campo de Administrador; la
// relación Admin↔Ruta vive exclusivamente en `User.authorizedRouteIds`.
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { assertCan } from '@/services/authz'
import { AuthzError } from '@/services/authz'
import { getAssignedRouteIds } from '@/lib/roles'
import { canManageUser, authorizedRouteIdsOf } from '@/lib/permissions'
import { computeRouteAssignmentDiff } from '@/lib/routeAssignmentDiff'
import { validateCobradorInvariant } from '@/lib/cobradorRules'
import { syncRouteMetrics } from '@/platform/companyControlService'
import { controlPlane } from '@/platform/controlPlane'
import type { ControlEventType } from '@/platform/types'
import type { CapitalMovement, Office, Route, User } from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos (mismo patrón que `PaymentDatabase`)
// ------------------------------------------------------------
/**
 * Superficie mínima de Dexie que necesitan estos servicios. Se declara de forma
 * ESTRUCTURAL para poder inyectar una base en memoria desde las pruebas (Node no
 * tiene IndexedDB) y verificar la creación de rutas de verdad, en la capa de
 * servicio. En producción SIEMPRE se usa el `db` real (valor por defecto).
 */
export interface RouteDatabase {
  routes: {
    add(item: Route): Promise<unknown>
    get(key: string): Promise<Route | undefined>
    update(key: string, changes: Partial<Route>): Promise<number>
  }
  users: {
    get(key: string): Promise<User | undefined>
    update(key: string, changes: Partial<User>): Promise<number>
    where(index: string): { equals(key: string): { toArray(): Promise<User[]> } }
  }
  capitalMovements: { add(item: CapitalMovement): Promise<unknown> }
  /** Solo LECTURA: validar que la Oficina indicada existe y es del mismo tenant. */
  offices: { get(key: string): Promise<Office | undefined> }
  transaction<U>(mode: 'rw', tables: unknown, scope: () => PromiseLike<U>): Promise<U>
}

/** Sumidero de auditoría (inyectable en pruebas; en producción, `logAction`). */
export type RouteAuditSink = (params: Parameters<typeof logAction>[0]) => Promise<void>

/**
 * Sumidero de MÉTRICAS DE PLATAFORMA. Cada alta o baja de ruta cambia la cifra que el
 * Owner factura (`billableRouteCount`), así que la ruta y la métrica no pueden vivir
 * desincronizadas. Se inyecta para poder verificarlo en pruebas con un plano de
 * control en memoria.
 *
 * DIRECCIÓN DEL FLUJO: la empresa EMPUJA un hecho estructural hacia el plano de
 * control. Nunca al revés. El plano de control no lee la operación del cliente.
 *
 * FAIL-SAFE: la implementación por defecto se traga sus propios errores (ver
 * `syncRouteMetrics`). Si la métrica comercial falla, la empresa crea su ruta igual.
 */
export type RouteMetricsSink = (tenantId: string, event: ControlEventType, detail?: string) => Promise<void>

/** Sumidero por defecto: recalcula las métricas contra el plano de control real. */
export const defaultRouteMetricsSink: RouteMetricsSink = (tenantId, event, detail) =>
  syncRouteMetrics(tenantId, controlPlane, event, detail)

export interface CreateRouteInput {
  tenantId: string
  nombre: string
  ciudad?: string
  tasaInteres: number
  tasaLibre: boolean
  montoMaximoPrestamo: number
  capitalInicial: number
  codigo: string
  /**
   * OFICINA a la que pertenece la ruta. OPCIONAL: sin ella la ruta queda
   * "Sin Oficina" y se le puede asignar una más adelante.
   */
  officeId?: string
  /**
   * Administradores responsables. OPCIONAL: puede ir vacío y la ruta se crea igual.
   * Fuente única: se agrega la ruta a su `authorizedRouteIds`.
   */
  adminIds: string[]
  /**
   * Cobrador responsable. OPCIONAL: puede omitirse y la ruta se crea igual (queda
   * sin operación de cobro). Si se indica, debe ser un cobrador activo del tenant.
   */
  cobradorId?: string
}

/**
 * Administradores responsables EFECTIVOS de una ruta nueva (regla pura y testeable).
 *
 *  · La lista puede quedar VACÍA: el Administrador es opcional.
 *  · Si el actor es ADMINISTRADOR, se autoincluye siempre. Su acceso es fail-closed
 *    por rutas: crear una ruta sin quedar dentro lo dejaría sin acceso a su propia
 *    ruta (auto-bloqueo del que solo podría rescatarlo un Super Admin).
 *  · El Super Admin NO se autoasigna: no se limita por rutas.
 */
export function resolveRouteAdminIds(adminIds: string[], actor: Pick<User, 'id' | 'rol'>): string[] {
  const ids = [...new Set(adminIds)].filter(Boolean)
  if (actor.rol === 'admin' && !ids.includes(actor.id)) ids.push(actor.id)
  return ids
}

export async function createRouteWithAdmins(
  input: CreateRouteInput,
  actor: User,
  database: RouteDatabase = db,
  auditSink: RouteAuditSink = logAction,
  metricsSink: RouteMetricsSink = defaultRouteMetricsSink,
): Promise<Route> {
  // 1) Administradores responsables: OPCIONALES. Si el actor es Administrador,
  //    queda autoasignado SIEMPRE (evita que se auto-bloquee por el fail-closed).
  const adminIds = resolveRouteAdminIds(input.adminIds, actor)

  // 2) Cada responsable indicado debe ser Administrador activo del tenant y asignable
  //    por el actor (o el propio actor, para el Administrador creador que se autoasigna).
  const users = await database.users.where('tenantId').equals(input.tenantId).toArray()
  for (const id of adminIds) {
    const a = users.find(u => u.id === id)
    if (!a || a.rol !== 'admin' || a.status !== 'activo') throw new AuthzError('Administrador responsable inválido o inactivo.')
    if (a.id !== actor.id && !canManageUser(actor, a)) throw new AuthzError('No puedes asignar a ese Administrador.')
  }
  // 3) COBRADOR RESPONSABLE: OPCIONAL. Si NO se indica, la ruta nace sin cobrador
  //    (estado válido: "pendiente de asignación"; sin operación de cobro hasta que
  //    se le asigne uno). Si SÍ se indica, debe ser un cobrador activo del tenant.
  const cobrador = input.cobradorId ? users.find(u => u.id === input.cobradorId) : undefined
  if (input.cobradorId && (!cobrador || cobrador.rol !== 'cobrador' || cobrador.status !== 'activo')) {
    throw new AuthzError('Cobrador responsable inválido o inactivo.')
  }

  // 3.b) OFICINA: opcional. Si se indica, debe existir y ser de la misma empresa
  //      (aislamiento por tenant). Si no, la ruta nace "Sin Oficina".
  if (input.officeId) {
    const office = await database.offices.get(input.officeId)
    if (!office || office.tenantId !== input.tenantId) {
      throw new AuthzError('La Oficina indicada no existe o pertenece a otra empresa.')
    }
  }

  const route: Route = {
    id: generateId(), tenantId: input.tenantId, officeId: input.officeId || undefined,
    nombre: input.nombre, codigo: input.codigo, ciudad: input.ciudad,
    tasaInteres: input.tasaInteres, tasaLibre: input.tasaLibre,
    montoMaximoPrestamo: input.montoMaximoPrestamo, capitalInicial: input.capitalInicial,
    capitalActual: input.capitalInicial, cobradorId: input.cobradorId,
    status: 'activa', createdAt: nowISO(), updatedAt: nowISO(),
  }

  // 4) Transaccional ÚNICO: crea la ruta, el capital inicial, asigna la ruta a cada Admin
  //    y al cobrador responsable. Si algo falla, Dexie revierte todo (no queda ruta huérfana).
  await database.transaction('rw', [database.routes, database.users, database.capitalMovements], async () => {
    await database.routes.add(route)
    if (input.capitalInicial > 0) {
      await database.capitalMovements.add({
        id: generateId(), tenantId: input.tenantId, routeId: route.id,
        tipo: 'ingresoCapital', valor: input.capitalInicial, descripcion: 'Capital inicial',
        fecha: nowISO().slice(0, 10), userId: actor.id, createdAt: nowISO(),
      })
    }
    for (const id of adminIds) {
      const a = users.find(u => u.id === id)!
      const ids = new Set(getAssignedRouteIds(a)); ids.add(route.id) // sin duplicados
      const list = [...ids]
      await database.users.update(id, { authorizedRouteIds: list, routeId: list[0], updatedAt: nowISO() })
    }
    // Cobrador responsable (si lo hay): queda ASIGNADO (fuente única
    // authorizedRouteIds) y es el responsable (route.cobradorId ya fijado arriba).
    // Misma transacción → atómico. Sin cobrador no hay nada que asignar.
    if (cobrador) {
      const cids = new Set(getAssignedRouteIds(cobrador)); cids.add(route.id)
      const clist = [...cids]
      await database.users.update(cobrador.id, { authorizedRouteIds: clist, routeId: clist[0], updatedAt: nowISO() })
    }
  })

  // 5) Auditoría de creación, de cada asignación de Administrador y del cobrador responsable.
  // Se deja constancia explícita de una ruta creada SIN responsables: es un estado
  // válido ("pendiente de asignación"), pero conviene poder rastrearlo (sin
  // Administrador nadie aprueba solicitudes; sin Cobrador no hay operación de cobro).
  const faltantes = [
    adminIds.length === 0 ? 'Administrador' : null,
    !cobrador ? 'Cobrador' : null,
  ].filter(Boolean)
  await auditSink({
    tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id,
    action: 'CREATE_ROUTE', entityType: 'Route', entityId: route.id,
    descripcion: faltantes.length > 0
      ? `Ruta creada SIN ${faltantes.join(' ni ')} responsable: ${route.nombre}`
      : `Ruta creada: ${route.nombre}`,
    after: {
      adminIds, cobradorId: input.cobradorId, officeId: input.officeId ?? null,
      sinAdministrador: adminIds.length === 0, sinCobrador: !cobrador,
      sinOficina: !input.officeId,
    },
  })
  for (const id of adminIds) {
    await auditSink({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Administrador responsable asignado a ${route.nombre}` })
  }
  if (cobrador) {
    await auditSink({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: cobrador.id, descripcion: `Cobrador responsable asignado a ${route.nombre}` })
  }

  // 6) MÉTRICA DE PLATAFORMA: la ruta nace 'activa', así que sube `billableRouteCount`.
  //    Se recalcula contando de nuevo, no sumando uno (ver `syncRouteMetrics`).
  await metricsSink(input.tenantId, 'ROUTE_CREATED', `Ruta creada: ${route.nombre}`)

  return route
}

// ============================================================
// EDICIÓN TRANSACCIONAL DE RUTA (draft → una sola transacción)
// El editor de Ruta NO persiste nada hasta "Actualizar": todos los cambios (datos
// generales + cobrador responsable + asignaciones de usuarios) se aplican aquí en una
// ÚNICA transacción Dexie. Fuente única: User.authorizedRouteIds (+ route.cobradorId
// legado sincronizado explícitamente). Si algo falla, rollback total (Dexie revierte).
// ============================================================

export interface UpdateRouteInput {
  routeId: string
  tenantId: string
  nombre: string
  ciudad?: string
  tasaInteres: number
  tasaLibre: boolean
  montoMaximoPrestamo: number
  cobradorId?: string
  /** Oficina de la ruta. `undefined` = "Sin Oficina" (estado válido). */
  officeId?: string
  /** Membresía DESEADA (draft) entre los usuarios asignables. */
  assignedUserIds: string[]
  /** Universo de usuarios que el actor puede togglear (para acotar los retiros). */
  assignableUserIds: string[]
}

/** Actualiza la ruta y TODAS sus relaciones en una sola transacción. Audita al final. */
export async function updateRouteWithAssignments(
  input: UpdateRouteInput,
  actor: User,
  database: RouteDatabase = db,
  auditSink: RouteAuditSink = logAction,
): Promise<{ added: string[]; removed: string[] }> {
  assertCan(actor, 'route.edit', { routeId: input.routeId, tenantId: input.tenantId })
  const prevRoute = await database.routes.get(input.routeId)
  if (!prevRoute) throw new AuthzError('Ruta no encontrada')

  // La Oficina indicada debe existir y ser del mismo tenant (o ninguna).
  if (input.officeId) {
    const office = await database.offices.get(input.officeId)
    if (!office || office.tenantId !== input.tenantId) {
      throw new AuthzError('La Oficina indicada no existe o pertenece a otra empresa.')
    }
  }

  const beforeGeneral = {
    nombre: prevRoute.nombre, ciudad: prevRoute.ciudad ?? '', tasaInteres: prevRoute.tasaInteres,
    tasaLibre: prevRoute.tasaLibre, montoMaximoPrestamo: prevRoute.montoMaximoPrestamo,
    cobradorId: prevRoute.cobradorId ?? '', officeId: prevRoute.officeId ?? '',
  }
  const afterGeneral = {
    nombre: input.nombre, ciudad: input.ciudad ?? '', tasaInteres: input.tasaInteres,
    tasaLibre: input.tasaLibre, montoMaximoPrestamo: input.montoMaximoPrestamo,
    cobradorId: input.cobradorId ?? '', officeId: input.officeId ?? '',
  }

  let added: string[] = []
  let removed: string[] = []

  await database.transaction('rw', [database.routes, database.users], async () => {
    // Todos los usuarios que podrían cambiar (asignables + cobrador previo/nuevo).
    const affectedIds = new Set<string>(input.assignableUserIds)
    if (prevRoute.cobradorId) affectedIds.add(prevRoute.cobradorId)
    if (input.cobradorId) affectedIds.add(input.cobradorId)
    const users = new Map<string, User>()
    for (const id of affectedIds) { const u = await database.users.get(id); if (u) users.set(id, u) }

    // COHERENCIA DEL COBRADOR RESPONSABLE (defensa en el servicio). Una ruta SIN
    // cobrador es un borrador válido; lo que se revalida es que, si se designa un
    // responsable, sea un cobrador activo del tenant y esté asignado. Si falla, se
    // lanza y Dexie revierte TODO (no hay persistencia parcial).
    const inv = validateCobradorInvariant({
      routeTenantId: input.tenantId,
      assignedUserIds: input.assignedUserIds,
      cobradorId: input.cobradorId,
      userById: (id) => users.get(id),
    })
    if (!inv.ok) throw new AuthzError(inv.message)

    const diff = computeRouteAssignmentDiff({
      routeId: input.routeId,
      assignableUserIds: input.assignableUserIds,
      assignedUserIds: input.assignedUserIds,
      cobradorId: input.cobradorId,
      prevCobradorId: prevRoute.cobradorId,
      membershipOf: (id) => authorizedRouteIdsOf(users.get(id)),
    })
    added = diff.added; removed = diff.removed

    // Datos generales + cobrador responsable (route.cobradorId).
    await database.routes.update(input.routeId, {
      nombre: input.nombre, ciudad: input.ciudad, tasaInteres: input.tasaInteres,
      tasaLibre: input.tasaLibre, montoMaximoPrestamo: input.montoMaximoPrestamo,
      cobradorId: input.cobradorId || undefined,
      // Cambiar de Oficina es UNA escritura: ninguna entidad hija se toca, porque
      // todas derivan la Oficina por `routeId`.
      officeId: input.officeId || undefined,
      updatedAt: nowISO(),
    })

    // Relaciones User.authorizedRouteIds (agregar/retirar routeId sin duplicados).
    for (const id of [...added, ...removed]) {
      const u = users.get(id); if (!u) continue
      const set = new Set(authorizedRouteIdsOf(u))
      if (added.includes(id)) set.add(input.routeId); else set.delete(input.routeId)
      const list = [...set]
      await database.users.update(id, { authorizedRouteIds: list.length ? list : undefined, routeId: list[0], updatedAt: nowISO() })
    }
  })

  // Auditoría (fuera de la transacción de escritura).
  await auditSink({
    tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId,
    action: 'UPDATE_ROUTE', entityType: 'Route', entityId: input.routeId,
    descripcion: `Ruta actualizada: ${input.nombre}`, before: beforeGeneral, after: afterGeneral,
    metadata: { usuariosAgregados: added, usuariosRetirados: removed },
  })
  for (const id of added) await auditSink({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Usuario asignado a ${input.nombre}` })
  for (const id of removed) await auditSink({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId, action: 'UNASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Usuario retirado de ${input.nombre}` })

  return { added, removed }
}
