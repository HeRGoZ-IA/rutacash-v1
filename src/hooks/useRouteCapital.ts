import { useState, useEffect } from 'react'
import { getRouteBase } from '@/services/cashboxEngine'

/**
 * Base de la ruta (`getRouteBase`) para validar que una venta no la supere. Se recarga cuando cambia la ruta o el contador `refreshKey`.
 */
export function useRouteCapital(routeId: string | undefined | null, refreshKey: unknown = 0) {
  const [available, setAvailable] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    if (!routeId) { setAvailable(null); return }
    setLoading(true)
    getRouteBase(routeId)
      .then(v => { if (alive) setAvailable(v) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [routeId, refreshKey])

  return { available, loading }
}
