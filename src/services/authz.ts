// ============================================================
// GUARDS DE DATOS EN SERVICIOS (no solo de navegación)
// ------------------------------------------------------------
// Cada operación sensible valida capacidad + ruta EN EL SERVICIO que la ejecuta,
// nunca confiando en que la página ya filtró. Lanzan `AuthzError` (mensaje claro).
// ============================================================
import { can, canAccessRoute, type Capability, type PermissionContext } from '@/lib/permissions'
import type { User } from '@/models/types'

export class AuthzError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthzError'
  }
}

/** Lanza si el actor no posee la capacidad en el contexto dado. */
export function assertCan(actor: User | null | undefined, capability: Capability, ctx?: PermissionContext): void {
  if (!can(actor, capability, ctx)) {
    throw new AuthzError(`Acción no autorizada (${capability}).`)
  }
}

/** Lanza si el actor no puede acceder/operar la ruta. */
export function assertRouteAccess(actor: User | null | undefined, routeId: string): void {
  if (!canAccessRoute(actor, routeId)) {
    throw new AuthzError('Ruta no autorizada para tu usuario.')
  }
}
