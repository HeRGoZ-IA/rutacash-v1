import { useState, useEffect } from 'react'
import { getRouteAvailableCapital } from '@/services/cashboxEngine'

/**
 * Capital disponible de una ruta (saldo de caja) para validar que una venta no
 * supere el capital. Se recarga cuando cambia la ruta o el contador `refreshKey`.
 */
export function useRouteCapital(routeId: string | undefined | null, refreshKey: unknown = 0) {
  const [available, setAvailable] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    if (!routeId) { setAvailable(null); return }
    setLoading(true)
    getRouteAvailableCapital(routeId)
      .then(v => { if (alive) setAvailable(v) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [routeId, refreshKey])

  return { available, loading }
}
