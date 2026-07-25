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
import { AuthzError } from '@/services/authz'
import { getAssignedRouteIds } from '@/lib/roles'
import { canManageUser } from '@/lib/permissions'
import { assignCobradorToRoute } from '@/services/routeAssignment'
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

  const route: Route = {
    id: generateId(), tenantId: input.tenantId, officeId: '',
    nombre: input.nombre, codigo: input.codigo, ciudad: input.ciudad,
    tasaInteres: input.tasaInteres, tasaLibre: input.tasaLibre,
    montoMaximoPrestamo: input.montoMaximoPrestamo, capitalInicial: input.capitalInicial,
    capitalActual: input.capitalInicial, cobradorId: undefined,
    status: 'activa', createdAt: nowISO(), updatedAt: nowISO(),
  }

  // 4) Transaccional: crea la ruta, el capital inicial y asigna la ruta a cada Admin.
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
  })

  // 5) Cobrador responsable opcional (sincroniza route.cobradorId con su propia lógica).
  if (input.cobradorId) await assignCobradorToRoute(route.id, input.cobradorId)

  // 6) Auditoría de creación y de cada asignación de Administrador.
  await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'CREATE_ROUTE', entityType: 'Route', entityId: route.id, descripcion: `Ruta creada: ${route.nombre}`, after: { adminIds } })
  for (const id of adminIds) {
    await logAction({ tenantId: input.tenantId, userId: actor.id, userRole: actor.rol, routeId: route.id, action: 'ASSIGN_ROUTE', entityType: 'User', entityId: id, descripcion: `Administrador responsable asignado a ${route.nombre}` })
  }
  return route
}
