import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { db } from '@/lib/db'
import { useAuth } from './useAuth'
import { useTenant } from './useTenant'
import { useAccessibleRoutes } from './useAccessibleRoutes'
import { ALL_OFFICES, NO_OFFICE, hasRoutesWithoutOffice } from '@/lib/officeGrouping'
import {
  resolveOfficeParam, routesInOfficeFilter, visibleRouteIds, routeStillInFilter,
  filterRowsByVisibleRoutes, filterContextLabel, buildLookups, routeOfficeLabel, officeLabelOf,
} from '@/lib/officeRouteFilter'
import type { Office } from '@/models/types'

/**
 * FILTRO OFICINA → RUTA compartido por los módulos administrativos.
 *
 * Encapsula lo que TODOS necesitan y nada de la lógica de negocio de cada uno:
 * la Oficina seleccionada, las rutas accesibles dentro de ella, la ruta elegida,
 * el conjunto final de rutas visibles y las etiquetas.
 *
 * Garantías:
 *  · Parte siempre de `useAccessibleRoutes` (scoping central). La Oficina solo
 *    puede estrechar ese conjunto, jamás ampliarlo.
 *  · Lee `?officeId=` al entrar (contexto que llega desde el panel de Oficina) y
 *    lo valida contra el catálogo de la empresa. Un id ajeno o inventado se ignora
 *    y se cae a "todas las oficinas", sin ampliar nada.
 *  · Al cambiar de Oficina, una ruta que quede fuera del filtro se LIMPIA.
 *  · No persiste ninguna "Oficina activa": el contexto vive en la URL mientras dura
 *    la navegación, no en el usuario ni en almacenamiento local.
 */
export function useOfficeRouteFilter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const { routes, loading: routesLoading } = useAccessibleRoutes()

  const [offices, setOffices] = useState<Office[] | null>(null)
  const [officeId, setOfficeIdState] = useState<string>(ALL_OFFICES)
  const [routeId, setRouteIdState] = useState<string>('')
  const [paramAplicado, setParamAplicado] = useState(false)

  // Catálogo de Oficinas de la empresa: solo para nombres y para VALIDAR el
  // parámetro. No decide qué rutas se ven.
  useEffect(() => {
    let alive = true
    if (!tenantId) { setOffices([]); return }
    db.offices.where('tenantId').equals(tenantId).toArray().then(list => {
      if (alive) setOffices(list)
    })
    return () => { alive = false }
  }, [tenantId, user])

  // Contexto que llega desde el panel de Oficina. Se aplica UNA vez y se consume
  // de la URL, para que un refresco no reimponga un filtro que el usuario ya cambió.
  useEffect(() => {
    if (offices === null || paramAplicado) return
    const crudo = searchParams.get('officeId')
    if (crudo) {
      setOfficeIdState(resolveOfficeParam(crudo, offices))
      const limpios = new URLSearchParams(searchParams)
      limpios.delete('officeId')
      setSearchParams(limpios, { replace: true })
    }
    setParamAplicado(true)
  }, [offices, paramAplicado, searchParams, setSearchParams])

  const catalogo = offices ?? []
  const { routeById, officeById } = useMemo(() => buildLookups(routes, catalogo), [routes, catalogo])

  /** Cambiar de Oficina limpia la ruta que ya no pertenezca al nuevo filtro. */
  const setOfficeId = useCallback((next: string) => {
    setOfficeIdState(next)
    setRouteIdState(prev => (routeStillInFilter(routes, next, prev) ? prev : ''))
  }, [routes])

  const routesInOffice = useMemo(() => routesInOfficeFilter(routes, officeId), [routes, officeId])
  const visibles = useMemo(
    () => visibleRouteIds({ accessibleRoutes: routes, officeId, routeId }),
    [routes, officeId, routeId],
  )

  return {
    /** Oficinas VISIBLES: las que tienen alguna ruta accesible para el usuario. */
    offices: catalogo.filter(o => routes.some(r => r.officeId === o.id)),
    /** Catálogo completo de la empresa (para nombres y validación). */
    allOffices: catalogo,
    officeId,
    setOfficeId,
    routeId,
    setRouteId: setRouteIdState,
    /** Rutas accesibles dentro del filtro de Oficina (alimenta el RouteSelector). */
    routesInOffice,
    /** Todas las rutas accesibles, sin filtrar por Oficina. */
    routes,
    /** Conjunto FINAL de rutas visibles (Oficina ∩ ruta elegida). */
    visibleRouteIds: visibles,
    /** Recorta filas con `routeId` al conjunto visible. */
    filterRows: useCallback(
      <T extends { routeId: string }>(rows: T[]) => filterRowsByVisibleRoutes(rows, visibles),
      [visibles],
    ),
    /** ¿Ofrecer el grupo "Sin Oficina"? Solo si el usuario tiene rutas así. */
    hasUnassigned: hasRoutesWithoutOffice(routes),
    /** Oficina activa (null en "todas" o en "Sin Oficina"). */
    activeOffice: officeId && officeId !== NO_OFFICE ? (officeById.get(officeId) ?? null) : null,
    /** ¿Hay un filtro de Oficina puesto? (para mostrar el contexto). */
    hasOfficeFilter: officeId !== ALL_OFFICES,
    contextLabel: filterContextLabel({ officeId, officeById, routeId, routeById }),
    /** "Leticia / Ruta Centro" para una fila del listado. */
    labelFor: useCallback(
      (rid: string | undefined) => routeOfficeLabel(rid, routeById, officeById),
      [routeById, officeById],
    ),
    /** Nombre de la Oficina de una ruta. */
    officeNameOf: useCallback(
      (rid: string | undefined) => officeLabelOf(rid ? routeById.get(rid) : undefined, officeById),
      [routeById, officeById],
    ),
    routeById,
    officeById,
    loading: routesLoading || offices === null,
  }
}
