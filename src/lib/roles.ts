import type { User } from '@/models/types'

/**
 * Rutas asignadas de un usuario (concepto unificado).
 *
 * - **Cobrador:** todas sus **rutas asignadas**. Consolida `authorizedRouteIds`
 *   (lista de rutas asignadas) + `routeId` legacy, sin duplicar. Un cobrador puede
 *   tener una o muchas rutas asignadas.
 * - **Supervisor:** sus **rutas autorizadas** (`authorizedRouteIds`), con fallback a
 *   `routeId` legacy si la lista está vacía.
 * - **Otros roles (admin/superadmin):** no aplica → [].
 */
export function getAssignedRouteIds(user?: User | null): string[] {
  if (!user) return []
  if (user.rol === 'cobrador' || user.rol === 'supervisor') {
    const ids = new Set(user.authorizedRouteIds ?? [])
    if (user.routeId) ids.add(user.routeId)
    return [...ids]
  }
  return []
}

/**
 * Alias retrocompatible. Históricamente la App Cobrador y el Supervisor usaban
 * `getAuthorizedRouteIds`; ahora delega en `getAssignedRouteIds` (mismo resultado).
 */
export function getAuthorizedRouteIds(user?: User | null): string[] {
  return getAssignedRouteIds(user)
}
