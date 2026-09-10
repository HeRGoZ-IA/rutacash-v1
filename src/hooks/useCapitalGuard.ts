import { useState, useEffect } from 'react'
import { getRouteAvailableCapital } from '@/services/cashboxEngine'
import { can } from '@/lib/permissions'
import { useAuth } from '@/hooks/useAuth'

/**
 * GUARDA DE CAPITAL PARA UNA VENTA NUEVA.
 *
 * La regla de negocio "una venta no puede superar el capital disponible de la ruta"
 * se conserva intacta para TODOS los roles. Lo que cambia es cuánto se revela:
 *
 *  · Con `cashbox.viewRoute` (Administrador, Supervisor, Super Admin) → se devuelve
 *    el monto y la UI puede mostrarlo.
 *  · Sin esa capacidad (Cobrador) → `available` es `null`: la pantalla recibe el
 *    VEREDICTO (`exceeded`) para bloquear la venta con un mensaje comprensible, pero
 *    nunca el capital financiero de la ruta.
 *
 * Así no queda un error inexplicable ni se elimina la validación.
 */
export function useCapitalGuard(routeId: string | undefined | null, valorVenta: number) {
  const { user } = useAuth()
  const puedeVerMonto = can(user, 'cashbox.viewRoute', { routeId: routeId ?? undefined })
  const [capital, setCapital] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    if (!routeId) { setCapital(null); return }
    setLoading(true)
    getRouteAvailableCapital(routeId)
      .then(v => { if (alive) setCapital(v) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [routeId])

  const exceeded = capital != null && valorVenta > capital

  return {
    /** true si la venta supera el capital disponible de la ruta. */
    exceeded,
    /** Monto disponible SOLO si el usuario puede conocer la caja de la ruta. */
    available: puedeVerMonto ? capital : null,
    /** ¿La UI puede mostrar la cifra? */
    canSeeAmount: puedeVerMonto,
    loading,
  }
}
