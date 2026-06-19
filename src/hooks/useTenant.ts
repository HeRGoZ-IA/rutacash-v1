import { useAuth } from './useAuth'

export function useTenant() {
  const { tenant, office, route, user } = useAuth()
  return {
    tenant,
    office,
    route,
    tenantId: tenant?.id ?? user?.tenantId ?? '',
    officeId: office?.id ?? user?.officeId ?? '',
    routeId: route?.id ?? user?.routeId ?? '',
    currency: tenant?.moneda ?? 'COP',
  }
}
