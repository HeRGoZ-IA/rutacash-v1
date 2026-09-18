import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { can, homePathForRole, type Capability } from '@/lib/permissions'
import type { UserRole } from '@/models/types'

/**
 * Guard central de navegación del NIVEL EMPRESA.
 * No depende solo del menú: protege el acceso directo por URL con
 *   - guard de ROL (roles permitidos),
 *   - guard de CAPACIDAD (opcional),
 * y redirige a la home del rol (o a /login) cuando no procede.
 *
 * AISLAMIENTO ENTRE PORTALES: este guard mira EXCLUSIVAMENTE la sesión de empresa
 * (`useAuth`). Un Owner autenticado no tiene sesión aquí, así que cualquier ruta de
 * empresa lo manda a /login. Ser dueño de RutaCash no concede ni un permiso dentro de
 * las empresas de los clientes; para eso hay que tener una cuenta de empresa.
 *
 * YA NO HAY PUERTA DE CONTRASEÑA: el cambio obligatorio de contraseña se eliminó
 * (apartado Q). Entrar con la contraseña inicial es un uso legítimo y la gestión de
 * contraseñas vive en Usuarios, no interrumpiendo el acceso de nadie.
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

/**
 * Guard del NIVEL PLATAFORMA. Protege todo `/owner/*`.
 *
 * Mira EXCLUSIVAMENTE la sesión de Owner (`useOwnerAuth`). Un Super Admin, por mucha
 * autoridad que tenga dentro de su empresa, no tiene sesión aquí y termina en
 * /owner/login: el Dashboard de RutaCash no es un premio por ser el rol más alto de
 * un cliente, es otro nivel del producto.
 */
export function RequireOwner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, owner } = useOwnerAuth()
  if (!isAuthenticated || !owner) return <Navigate to="/owner/login" replace />
  if (owner.status !== 'activo') return <Navigate to="/owner/login" replace />
  if (owner.rol !== 'owner') return <Navigate to="/owner/login" replace />
  return <>{children}</>
}
