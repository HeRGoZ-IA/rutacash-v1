import { useState, useEffect } from 'react'
import { db } from '@/lib/db'
import { useAuth } from './useAuth'
import { useAccessibleRoutes } from './useAccessibleRoutes'
import { accessibleOfficeIdsOf, groupRoutesByOffice, hasRoutesWithoutOffice, type OfficeGroup } from '@/lib/officeGrouping'
import type { Office } from '@/models/types'

/**
 * Oficinas VISIBLES para el usuario en sesión.
 *
 * Se derivan de `useAccessibleRoutes`: son las Oficinas que aparecen en las rutas
 * que el usuario ya tiene autorizadas. La tabla `offices` solo se lee para poner
 * nombre a esos ids — NUNCA para decidir qué rutas ve.
 *
 * Por eso ver una Oficina no concede ninguna ruta: si un Administrador tiene una
 * sola ruta de la Oficina Leticia, verá "Oficina Leticia" con esa única ruta, no
 * con las demás.
 *
 * `allOffices` devuelve el catálogo completo de la empresa y existe SOLO para la
 * pantalla de gestión de Oficinas (capacidades `office.*`). Gestionar el catálogo
 * y acceder a los datos de sus rutas son cosas distintas.
 */
export function useAccessibleOffices() {
  const { user } = useAuth()
  const { routes, loading: routesLoading } = useAccessibleRoutes()
  const [allOffices, setAllOffices] = useState<Office[] | null>(null)

  useEffect(() => {
    let alive = true
    if (!user) { setAllOffices([]); return }
    db.offices.where('tenantId').equals(user.tenantId).toArray().then(list => {
      if (alive) setAllOffices(list)
    })
    return () => { alive = false }
  }, [user])

  const catalogo = allOffices ?? []
  const visibleIds = accessibleOfficeIdsOf(routes)
  const offices = catalogo.filter(o => visibleIds.has(o.id))
  const groups: OfficeGroup[] = groupRoutesByOffice(routes, catalogo)

  return {
    /** Oficinas con al menos una ruta accesible por el usuario. */
    offices,
    /** Catálogo completo del tenant — solo para gestión, nunca para scoping. */
    allOffices: catalogo,
    /** Rutas accesibles agrupadas por Oficina, con "Sin Oficina" al final. */
    groups,
    /** ¿Hay rutas accesibles sin Oficina? (para ofrecer ese grupo en los filtros). */
    hasUnassigned: hasRoutesWithoutOffice(routes),
    routes,
    loading: routesLoading || allOffices === null,
  }
}
