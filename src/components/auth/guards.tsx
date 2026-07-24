import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { can, homePathForRole, type Capability } from '@/lib/permissions'
import type { UserRole } from '@/models/types'

/**
 * Guard central de navegación (GUARDS Y NAVEGACIÓN).
 * No depende solo del menú: protege el acceso directo por URL con
 *   - guard de ROL (roles permitidos),
 *   - guard de CAPACIDAD (opcional),
 * y redirige a la home del rol (o a /login) cuando no procede.
 */
export function RequireAuth({
  children,
  roles,
  capability,
}: {
  children: React.ReactNode
  roles?: UserRole[]
  capability?: Capability
}) {
  const { isAuthenticated, user } = useAuth()
  if (!isAuthenticated || !user) return <Navigate to="/login" replace />
  if (user.status !== 'activo') return <Navigate to="/login" replace />
  if (roles && !roles.includes(user.rol)) return <Navigate to={homePathForRole(user.rol)} replace />
  if (capability && !can(user, capability)) return <Navigate to={homePathForRole(user.rol)} replace />
  return <>{children}</>
}
