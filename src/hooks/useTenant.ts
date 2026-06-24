import { useAuth } from './useAuth'

export function useTenant() {
  const { tenant, route, user } = useAuth()
  return {
    tenant,
    route,
    tenantId: tenant?.id ?? user?.tenantId ?? '',
    // Legacy: ya no hay oficinas; se conserva officeId derivado del usuario por compatibilidad.
    officeId: user?.officeId ?? '',
    routeId: route?.id ?? user?.routeId ?? '',
    currency: tenant?.moneda ?? 'COP',
  }
}
