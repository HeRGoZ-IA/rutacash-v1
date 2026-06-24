// ============================================================
// Sincronización Ruta <-> Cobrador (rutas asignadas)
// Concepto: una RUTA tiene un cobrador responsable (route.cobradorId);
// un COBRADOR puede tener MUCHAS rutas asignadas (user.authorizedRouteIds,
// con user.routeId como legacy = primera ruta). Ambos lados se mantienen
// coherentes. No se tocan las rutas autorizadas del supervisor.
// ============================================================
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { getAssignedRouteIds } from '@/lib/roles'

/** Escribe el conjunto de rutas asignadas de un usuario (lista + routeId legacy). */
async function writeUserRoutes(userId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)]
  await db.users.update(userId, { authorizedRouteIds: unique, routeId: unique[0] ?? undefined, updatedAt: nowISO() })
}

/**
 * Usuarios → define la lista completa de rutas asignadas de un cobrador.
 * Sincroniza route.cobradorId: marca como responsable de las rutas añadidas
 * (resolviendo conflicto: la asignación más reciente gana) y libera las quitadas.
 */
export async function setCobradorRoutes(userId: string, routeIds: string[]): Promise<void> {
  await db.transaction('rw', db.routes, db.users, async () => {
    const user = await db.users.get(userId)
    const prev = getAssignedRouteIds(user)
    const next = [...new Set(routeIds)]
    await writeUserRoutes(userId, next)

    const added = next.filter(r => !prev.includes(r))
    const removed = prev.filter(r => !next.includes(r))

    for (const rid of added) {
      const route = await db.routes.get(rid)
      if (!route) continue
      // Conflicto: la ruta ya tenía otro responsable → se la quitamos (gana lo más reciente).
      if (route.cobradorId && route.cobradorId !== userId) {
        const other = await db.users.get(route.cobradorId)
        if (other) await writeUserRoutes(other.id, getAssignedRouteIds(other).filter(x => x !== rid))
      }
      await db.routes.update(rid, { cobradorId: userId, updatedAt: nowISO() })
    }
    for (const rid of removed) {
      const route = await db.routes.get(rid)
      if (route?.cobradorId === userId) await db.routes.update(rid, { cobradorId: undefined, updatedAt: nowISO() })
    }
  })
}

/**
 * Editar Ruta → asigna/cambia/desasigna el cobrador responsable de UNA ruta.
 * Agrega esa ruta a las rutas asignadas del nuevo cobrador (sin borrar las demás)
 * y la quita del cobrador anterior (sin tocar sus otras rutas).
 */
export async function assignCobradorToRoute(routeId: string, newCobradorId: string | undefined): Promise<void> {
  await db.transaction('rw', db.routes, db.users, async () => {
    const route = await db.routes.get(routeId)
    const prevCobradorId = route?.cobradorId
    await db.routes.update(routeId, { cobradorId: newCobradorId || undefined, updatedAt: nowISO() })

    if (prevCobradorId && prevCobradorId !== newCobradorId) {
      const prev = await db.users.get(prevCobradorId)
      if (prev) await writeUserRoutes(prev.id, getAssignedRouteIds(prev).filter(x => x !== routeId))
    }
    if (newCobradorId) {
      const nu = await db.users.get(newCobradorId)
      if (nu) {
        const set = getAssignedRouteIds(nu)
        if (!set.includes(routeId)) set.push(routeId)
        await writeUserRoutes(newCobradorId, set)
      }
    }
  })
}

/**
 * Limpia la responsabilidad de rutas de un usuario (al dejar de ser cobrador).
 * Solo toca route.cobradorId; NO modifica los campos del usuario (eso lo decide
 * quien llama, p. ej. para conservar authorizedRouteIds de un supervisor).
 */
export async function clearRouteResponsibilities(userId: string): Promise<void> {
  await db.transaction('rw', db.routes, async () => {
    const routes = await db.routes.where('cobradorId').equals(userId).toArray()
    for (const r of routes) await db.routes.update(r.id, { cobradorId: undefined, updatedAt: nowISO() })
  })
}
