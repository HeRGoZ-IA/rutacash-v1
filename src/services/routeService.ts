// ============================================================
// Creación de rutas con ADMINISTRADOR responsable (fuente única: authorizedRouteIds)
// ------------------------------------------------------------
// Regla funcional: no se crea una ruta sin al menos un Administrador ACTIVO del
// tenant, y la ruta debe quedar asignada a uno o varios Administradores responsables.
// La validación se aplica también aquí (no solo en la UI): el servicio RECHAZA la
// creación si no hay Administrador activo o si no se selecciona ninguno.
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
import type { Route, User } from '@/models/types'

/** ¿Existe al menos un Administrador ACTIVO en el tenant? (requisito para crear rutas). */
export async function hasActiveAdmin(tenantId: string): Promise<boolean> {
  const n = await db.users.where('tenantId').equals(tenantId).and(u => u.rol === 'admin' && u.status === 'activo').count()
  return n > 0
}

export interface CreateRouteInput {
  tenantId: string
  nombre: string
  ciudad?: string
  tasaInteres: number
  tasaLibre: boolean
  montoMaximoPrestamo: number
  capitalInicial: number
  codigo: string
  /** Administradores responsables (≥1). Fuente única: se agrega la ruta a su authorizedRouteIds. */
  adminIds: string[]
  /** Cobrador responsable (OBLIGATORIO): debe ser un cobrador activo del tenant. */
  cobradorId?: string
}

export async function createRouteWithAdmins(input: CreateRouteInput, actor: User): Promise<Route> {
  // 1) Debe existir al menos un Administrador activo en la empresa.
  if (!(await hasActiveAdmin(input.tenantId))) {
    throw new AuthzError('No se puede crear la ruta: primero debe existir al menos un Administrador activo.')
  }
  // 2) Debe seleccionarse al menos un Administrador responsable.
  const adminIds = [...new Set(input.adminIds)].filter(Boolean)
  if (adminIds.length === 0) {
    throw new AuthzError('Debes seleccionar al menos un Administrador responsable de la ruta.')
  }
  // 3) Cada responsable debe ser Administrador activo del tenant y asignable por el actor
  //    (o el propio actor, para el caso del Administrador creador que se autoasigna).
  const users = await db.users.where('tenantId').equals(input.tenantId).toArray()
  for (const id of adminIds) {
    const a = users.find(u => u.id === id)
    if (!a || a.rol !== 'admin' || a.status !== 'activo') throw new AuthzError('Administrador responsable inválido o inactivo.')
    if (a.id !== actor.id && !canManageUser(actor, a)) throw new AuthzError('No puedes asignar a ese Administrador.')
  }
  // 3.b) COBRADOR RESPONSABLE obligatorio: toda ruta nace con exactamente un cobrador
  //      responsable, activo y del mismo tenant. El servicio RECHAZA la creación si falta.
  if (!input.cobradorId) throw new AuthzError('Debes seleccionar un Cobrador responsable para la ruta.')
  const cobrador = users.find(u => u.id === input.cobradorId)
  if (!cobrador || cobrador.rol !== 'cobrador' || cobrador.status !== 'activo') {
    throw new AuthzError('Cobrador responsable inválido o inactivo.')
  }

  const route: Route = {
    id: generateId(), tenantId: input.tenantId, officeId: '',
    nombre: input.nombre, codigo: input.codigo, ciudad: input.ciudad,
    tasaInteres: input.tasaInteres, tasaLibre: input.tasaLibre,
    montoMaximoPrestamo: input.montoMaximoPrestamo, capitalInicial: input.capitalInicial,
    capitalActual: input.capitalInicial, cobradorId: input.cobradorId,
    status: 'activa', createdAt: nowISO(), updatedAt: nowISO(),
  }

  // 4) Transaccional ÚNICO: crea la ruta, el capital inicial, asigna la ruta a cada Admin
  //    y al cobrador responsable. Si algo falla, Dexie revierte todo (no queda ruta huérfana).
  await db.transaction('rw', db.routes, db.users, db.capitalMovements, async () => {
    await db.routes.add(route)
    if (input.capitalInicial > 0) {
      await db.capitalMovements.add({
        id: generateId(), tenantId: input.tenantId, officeId: '', routeId: route.id,
        tipo: 'ingresoCapital', valor: input.capitalInicial, descripcion: 'Capital inicial',
        fecha: nowISO().slice(0, 10), userId: actor.id, createdAt: nowISO(),
      })
    }
    for (const id of adminIds) {
      const a = users.find(u => u.id === id)!
      const ids = new Set(getAssignedRouteIds(a)); ids.add(route.id) // sin duplicados
      const list = [...ids]
      await db.users.update(id, { authorizedRouteIds: list, routeId: list[0], updatedAt: nowISO() })
    }
    // Cobrador responsable: queda ASIGNADO (fuente única authorizedRouteIds) y es el
    // responsable (route.cobradorId ya fijado arriba). Misma transacción → atómico.
    const cids = new Set(getAssignedRouteIds(cobrador)); cids.add(route.id)
    const clist = [...cids]
    await db.users.update(cobrador.id, { authorizedRouteIds: clist, routeId: clist[0], updatedAt: nowISO() })
  })

  // 5) Auditoría de creación, de cada asignación de Administrador y del cobrador responsable.
  await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'CREATE_ROUTE', entityType: 'Route', entityId: route.id, descripcion: `Ruta creada: ${route.nombre}`, after: { adminIds, cobradorId: input.cobradorId } })
  for (const id of adminIds) {
    await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Administrador responsable asignado a ${route.nombre}` })
  }
  await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: cobrador.id, descripcion: `Cobrador responsable asignado a ${route.nombre}` })
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
  /** Membresía DESEADA (draft) entre los usuarios asignables. */
  assignedUserIds: string[]
  /** Universo de usuarios que el actor puede togglear (para acotar los retiros). */
  assignableUserIds: string[]
}

/** Actualiza la ruta y TODAS sus relaciones en una sola transacción. Audita al final. */
export async function updateRouteWithAssignments(input: UpdateRouteInput, actor: User): Promise<{ added: string[]; removed: string[] }> {
  assertCan(actor, 'route.edit', { routeId: input.routeId, tenantId: input.tenantId })
  const prevRoute = await db.routes.get(input.routeId)
  if (!prevRoute) throw new AuthzError('Ruta no encontrada')

  const beforeGeneral = {
    nombre: prevRoute.nombre, ciudad: prevRoute.ciudad ?? '', tasaInteres: prevRoute.tasaInteres,
    tasaLibre: prevRoute.tasaLibre, montoMaximoPrestamo: prevRoute.montoMaximoPrestamo, cobradorId: prevRoute.cobradorId ?? '',
  }
  const afterGeneral = {
    nombre: input.nombre, ciudad: input.ciudad ?? '', tasaInteres: input.tasaInteres,
    tasaLibre: input.tasaLibre, montoMaximoPrestamo: input.montoMaximoPrestamo, cobradorId: input.cobradorId ?? '',
  }

  let added: string[] = []
  let removed: string[] = []

  await db.transaction('rw', db.routes, db.users, async () => {
    // Todos los usuarios que podrían cambiar (asignables + cobrador previo/nuevo).
    const affectedIds = new Set<string>(input.assignableUserIds)
    if (prevRoute.cobradorId) affectedIds.add(prevRoute.cobradorId)
    if (input.cobradorId) affectedIds.add(input.cobradorId)
    const users = new Map<string, User>()
    for (const id of affectedIds) { const u = await db.users.get(id); if (u) users.set(id, u) }

    // INVARIANTE DE COBRADORES (defensa en el servicio; la UI ya bloquea estados
    // inválidos). Se revalida sobre el borrador recibido; si falla, se lanza y Dexie
    // revierte TODO (no hay persistencia parcial). No se corrige silenciosamente.
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
    await db.routes.update(input.routeId, {
      nombre: input.nombre, ciudad: input.ciudad, tasaInteres: input.tasaInteres,
      tasaLibre: input.tasaLibre, montoMaximoPrestamo: input.montoMaximoPrestamo,
      cobradorId: input.cobradorId || undefined, updatedAt: nowISO(),
    })

    // Relaciones User.authorizedRouteIds (agregar/retirar routeId sin duplicados).
    for (const id of [...added, ...removed]) {
      const u = users.get(id); if (!u) continue
      const set = new Set(authorizedRouteIdsOf(u))
      if (added.includes(id)) set.add(input.routeId); else set.delete(input.routeId)
      const list = [...set]
      await db.users.update(id, { authorizedRouteIds: list.length ? list : undefined, routeId: list[0], updatedAt: nowISO() })
    }
  })

  // Auditoría (fuera de la transacción de escritura).
  await logAction({
    tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId,
    action: 'UPDATE_ROUTE', entityType: 'Route', entityId: input.routeId,
    descripcion: `Ruta actualizada: ${input.nombre}`, before: beforeGeneral, after: afterGeneral,
    metadata: { usuariosAgregados: added, usuariosRetirados: removed },
  })
  for (const id of added) await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Usuario asignado a ${input.nombre}` })
  for (const id of removed) await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: input.routeId, action: 'UNASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Usuario retirado de ${input.nombre}` })

  return { added, removed }
}
