// ============================================================
// RESOLUCIÓN DE ASIGNACIONES Usuario ↔ Ruta (fuente única, PURO)
// ------------------------------------------------------------
// FUENTE ÚNICA para saber qué usuarios están asignados a una ruta:
// User.authorizedRouteIds (incluye routeId legado vía authorizedRouteIdsOf).
// NO se usa route.cobradorId para decidir asignaciones (ese campo es solo el
// "cobrador responsable"). El Super Admin NO se lista (acceso global).
//
// Este helper lo comparten la TARJETA de ruta, el editor y cualquier selector,
// para que jamás se contradigan.
// ============================================================
import { authorizedRouteIdsOf } from '@/lib/permissions'
import type { User, UserRole } from '@/models/types'

/** Usuarios asignados a la ruta (misma empresa, con routeId en authorizedRouteIds). */
export function getUsersAssignedToRoute(users: User[], routeId: string, tenantId?: string): User[] {
  return users.filter(u =>
    u.rol !== 'superadmin' &&
    (!tenantId || u.tenantId === tenantId) &&
    authorizedRouteIdsOf(u).includes(routeId)
  )
}

export interface RouteAssignmentsByRole {
  admins: User[]
  socios: User[]
  supervisores: User[]
  cobradores: User[]
  secretarios: User[]
}

/** Orden obligatorio de roles para la vista (Administrador → … → Secretario). */
export const ASSIGNMENT_ROLE_ORDER: { key: keyof RouteAssignmentsByRole; rol: UserRole; singular: string; plural: string }[] = [
  { key: 'admins', rol: 'admin', singular: 'Administrador', plural: 'Administradores' },
  { key: 'socios', rol: 'socio', singular: 'Socio', plural: 'Socios' },
  { key: 'supervisores', rol: 'supervisor', singular: 'Supervisor', plural: 'Supervisores' },
  { key: 'cobradores', rol: 'cobrador', singular: 'Cobrador', plural: 'Cobradores' },
  { key: 'secretarios', rol: 'secretario', singular: 'Secretario', plural: 'Secretarios' },
]

/**
 * Asignaciones agrupadas por rol y ordenadas alfabéticamente dentro de cada rol.
 * Misma resolución que `getUsersAssignedToRoute` (fuente única).
 */
export function getRouteAssignmentsByRole(users: User[], routeId: string, tenantId?: string): RouteAssignmentsByRole {
  const assigned = getUsersAssignedToRoute(users, routeId, tenantId)
  const byRole = (rol: UserRole) => assigned.filter(u => u.rol === rol).sort((a, b) => a.nombre.localeCompare(b.nombre))
  return {
    admins: byRole('admin'),
    socios: byRole('socio'),
    supervisores: byRole('supervisor'),
    cobradores: byRole('cobrador'),
    secretarios: byRole('secretario'),
  }
}

/** ¿Hay algún usuario asignado a la ruta? */
export function hasAnyAssignment(a: RouteAssignmentsByRole): boolean {
  return a.admins.length + a.socios.length + a.supervisores.length + a.cobradores.length + a.secretarios.length > 0
}
