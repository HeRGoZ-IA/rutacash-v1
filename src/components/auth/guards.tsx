import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { ownerGuardDecision, tenantGuardDecision } from '@/components/auth/guardRules'
import type { Capability } from '@/lib/permissions'
import type { UserRole } from '@/models/types'

/**
 * Guard central de navegación del NIVEL EMPRESA.
 *
 * La DECISIÓN vive en `guardRules.tenantGuardDecision`, que es una función pura y
 * verificable; aquí solo se traduce a JSX. Protege el acceso directo por URL con
 * guard de ROL y, opcionalmente, de CAPACIDAD.
 *
 * AISLAMIENTO ENTRE PORTALES: mira EXCLUSIVAMENTE la sesión de empresa (`useAuth`).
 * Un Owner autenticado no tiene sesión aquí, así que cualquier ruta de empresa lo
 * manda a /login. Ser dueño de RutaCash no concede ni un permiso dentro de las
 * empresas de los clientes; para eso hay que tener una cuenta de empresa.
 *
 * YA NO HAY PUERTA DE CONTRASEÑA: el cambio obligatorio de contraseña se eliminó.
 * Entrar con la contraseña inicial es un uso legítimo y la gestión de contraseñas
 * vive en Usuarios, sin interrumpir el acceso de nadie.
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
  const decision = tenantGuardDecision({ isAuthenticated, user, roles, capability })
  if (!decision.allow) return <Navigate to={decision.redirectTo} replace />
  return <>{children}</>
}

/**
 * Guard del NIVEL PLATAFORMA. Protege TODO `/owner/*`, incluida
 * `/owner/configuracion`, donde vive el restablecimiento de fábrica.
 *
 * La DECISIÓN vive en `guardRules.ownerGuardDecision`. Mira exclusivamente la sesión
 * de Owner (`useOwnerAuth`): un Super Admin, por mucha autoridad que tenga dentro de
 * su empresa, no tiene sesión aquí y termina en /owner/login. Y nunca en /login: el
 * guard de plataforma no devuelve a nadie al portal de empresa.
 */
export function RequireOwner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, owner } = useOwnerAuth()
  const decision = ownerGuardDecision({ isAuthenticated, owner })
  if (!decision.allow) return <Navigate to={decision.redirectTo} replace />
  return <>{children}</>
}
