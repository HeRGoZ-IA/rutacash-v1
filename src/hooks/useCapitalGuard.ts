import { useCallback } from 'react'
import { getRouteBase } from '@/services/cashboxEngine'
import { can } from '@/lib/permissions'
import { useAuth } from '@/hooks/useAuth'
import { useRouteCapital } from '@/hooks/useRouteCapital'

/**
 * GUARDA DE CAPITAL PARA UNA VENTA NUEVA.
 *
 * La regla de negocio "una venta no puede superar la Base de la ruta" (`getRouteBase`)
 * se conserva intacta para TODOS los roles. Lo que cambia es cuánto se revela:
 *
 *  · Con `cashbox.viewRoute` (Administrador, Supervisor, Super Admin) → se devuelve
 *    el monto y la UI puede mostrarlo.
 *  · Sin esa capacidad (Cobrador) → `available` es `null`: la pantalla recibe el
 *    VEREDICTO (`exceeded`) para bloquear la venta con un mensaje comprensible, pero
 *    nunca el capital financiero de la ruta.
 *
 * Así no queda un error inexplicable ni se elimina la validación.
 *
 * La Base es VIVA (`useRouteCapital`) y, al enviar, `recheck` la vuelve a leer: la
 * decisión nunca se toma con la cifra pintada en pantalla. El servicio
 * (`createDirectSale`) la revalida de nuevo dentro de su transacción.
 */
export function useCapitalGuard(routeId: string | undefined | null, valorVenta: number) {
  const { user } = useAuth()
  const puedeVerMonto = can(user, 'cashbox.viewRoute', { routeId: routeId ?? undefined })
  const { available: capital, loading } = useRouteCapital(routeId)

  const exceeded = capital != null && valorVenta > capital

  /** Veredicto con la Base VIGENTE (lectura nueva), para usar justo antes de enviar. */
  const recheck = useCallback(async (valor: number) => {
    if (!routeId) return { exceeded: false, available: null as number | null }
    const base = await getRouteBase(routeId)
    return { exceeded: valor > base, available: puedeVerMonto ? base : null }
  }, [routeId, puedeVerMonto])

  return {
    /** true si la venta supera la Base de la ruta. */
    exceeded,
    /** Base de la ruta SOLO si el usuario puede conocer la caja de la ruta. */
    available: puedeVerMonto ? capital : null,
    /** ¿La UI puede mostrar la cifra? */
    canSeeAmount: puedeVerMonto,
    loading,
    recheck,
  }
}
