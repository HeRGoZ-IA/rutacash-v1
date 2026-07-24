// ============================================================
// SCOPING CENTRAL POR RUTAS AUTORIZADAS
// ------------------------------------------------------------
// Utilidades para que TODA consulta administrativa filtre por las rutas del
// usuario ANTES de agregar/sumar/calcular. Fail-closed: sin rutas → sin datos.
// El Super Admin (isRouteUnrestricted) obtiene todas las rutas de la empresa.
// ============================================================
import { db } from '@/lib/db'
import { filterAccessibleRoutes, authorizedRouteIdsOf } from '@/lib/permissions'
import type { User } from '@/models/types'

/** IDs de rutas accesibles por el usuario dentro de su empresa (validadas contra la base). */
export async function getAccessibleRouteIds(user: User | null | undefined, tenantId: string): Promise<string[]> {
  if (!user || !tenantId) return []
  const all = await db.routes.where('tenantId').equals(tenantId).toArray()
  return filterAccessibleRoutes(user, all).map(r => r.id)
}

/** Conjunto de rutas accesibles (para filtrar registros en memoria antes de agregar). */
export async function getAccessibleRouteIdSet(user: User | null | undefined, tenantId: string): Promise<Set<string>> {
  return new Set(await getAccessibleRouteIds(user, tenantId))
}

/**
 * Mapa socioId → rutas del socio (relación socio↔ruta vía authorizedRouteIds del socio).
 * Base para decidir qué cajas de socios entran en el alcance del Administrador.
 */
export async function getPartnerRouteMap(tenantId: string): Promise<Map<string, string[]>> {
  const users = await db.users.where('tenantId').equals(tenantId).toArray()
  return new Map(users.filter(u => u.rol === 'socio').map(s => [s.id, authorizedRouteIdsOf(s)]))
}
