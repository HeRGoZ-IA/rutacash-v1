import { useState, useEffect } from 'react'
import { getRouteBase } from '@/services/cashboxEngine'
import { ROUTE_BASE_TABLES, watchQuery } from '@/lib/dataRevision'

/**
 * Base de la ruta (`getRouteBase`) VIVA: se relee al cambiar la ruta y cada vez que se
 * confirma una escritura que la mueve (capital, retiro, transferencia, cobro,
 * desembolso, gasto, anulación), en esta pestaña o en otra del mismo navegador.
 *
 * Antes se leía UNA vez al montar (auditoría del socio 2026-10-02, punto 5): con
 * "Nueva venta" abierta, una inyección de capital hecha en otra pestaña no llegaba y
 * la pantalla bloqueaba una venta válida (o mostraba una Base que ya no existía).
 *
 * El valor queda asociado a SU ruta: al pasar de A a B no se devuelve la Base de A
 * mientras llega la de B (es `null`, cargando), y una respuesta tardía de A se
 * descarta (`watchQuery`).
 */
export function useRouteCapital(routeId: string | undefined | null) {
  const [state, setState] = useState<{ routeId: string; value: number } | null>(null)

  useEffect(() => {
    if (!routeId) return
    return watchQuery(ROUTE_BASE_TABLES, () => getRouteBase(routeId), value => setState({ routeId, value }))
  }, [routeId])

  const available = routeId && state?.routeId === routeId ? state.value : null
  return { available, loading: Boolean(routeId) && available === null }
}
