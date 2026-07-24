import { useState, useEffect } from 'react'
import { db } from '@/lib/db'
import { useAuth } from './useAuth'
import { filterAccessibleRoutes } from '@/lib/permissions'
import type { Route } from '@/models/types'

/**
 * Rutas ACCESIBLES por el usuario en sesión (RESTRICCIÓN POR RUTAS).
 * Superadmin / admin-sin-límite → todas las de la empresa; el resto → solo las
 * autorizadas. Fuente única vía `filterAccessibleRoutes` (permissions.ts).
 */
export function useAccessibleRoutes() {
  const { user } = useAuth()
  const [routes, setRoutes] = useState<Route[] | null>(null)

  useEffect(() => {
    let alive = true
    if (!user) { setRoutes([]); return }
    db.routes.where('tenantId').equals(user.tenantId).toArray().then(all => {
      if (alive) setRoutes(filterAccessibleRoutes(user, all))
    })
    return () => { alive = false }
  }, [user])

  return { routes: routes ?? [], loading: routes === null }
}
