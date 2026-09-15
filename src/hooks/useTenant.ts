import { useAuth } from './useAuth'

export function useTenant() {
  const { tenant, route, user } = useAuth()
  return {
    tenant,
    route,
    tenantId: tenant?.id ?? user?.tenantId ?? '',
    // Sin `officeId`: la Oficina NO es contexto del usuario. Vive en `Route.officeId`
    // y se deriva por ruta. Exponerla aquí reintroduciría la atadura usuario↔oficina.
    routeId: route?.id ?? user?.routeId ?? '',
    currency: tenant?.moneda ?? 'COP',
  }
}
