import type { User } from '@/models/types'
import { authorizedRouteIdsOf } from '@/lib/permissions'

/**
 * Rutas asignadas de un usuario (concepto unificado — modelo de roles y permisos).
 *
 * Consolida `authorizedRouteIds` (lista) + `routeId` legacy sin duplicar. Aplica a
 * admin, socio, supervisor, cobrador y secretario. El SUPERADMIN no se limita por
 * rutas (devuelve [] aquí; ver `isRouteUnrestricted` en permissions.ts).
 *
 * Fuente única: delega en `authorizedRouteIdsOf` (permissions.ts) para que exista
 * un solo lugar donde se resuelven las rutas de un usuario.
 */
export function getAssignedRouteIds(user?: User | null): string[] {
  if (!user) return []
  if (user.rol === 'superadmin') return []
  return authorizedRouteIdsOf(user)
}

/**
 * Alias retrocompatible. Históricamente la App Cobrador y el Supervisor usaban
 * `getAuthorizedRouteIds`; ahora delega en `getAssignedRouteIds` (mismo resultado).
 */
export function getAuthorizedRouteIds(user?: User | null): string[] {
  return getAssignedRouteIds(user)
}
