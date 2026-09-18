// ============================================================
// RUTACASH — DECISIÓN PURA DE LOS GUARDS DE NAVEGACIÓN
// ------------------------------------------------------------
// La lógica de "¿dejo pasar o a dónde redirijo?" vive aquí, separada de los
// componentes de `guards.tsx`, por una razón concreta y aprendida a golpes:
//
// Mientras la decisión estuvo DENTRO del componente, las pruebas solo podían
// comprobar que el texto del guard existiera en el archivo. Podían afirmar que
// `RequireOwner` estaba escrito, pero no qué hacía. Un guard se verifica
// EJECUTÁNDOLO, no leyéndolo: estas funciones son puras, deterministas y se prueban
// de verdad (OWNER-SETTINGS-*, GUARD-*).
//
// `guards.tsx` queda como una envoltura fina que traduce la decisión a JSX.
// ============================================================
import { can, homePathForRole, type Capability } from '@/lib/permissions'
import type { User, UserRole } from '@/models/types'
import type { PlatformUser } from '@/platform/types'

/** Dejar pasar, o redirigir a una ruta concreta. No hay tercera opción. */
export type GuardDecision =
  | { allow: true }
  | { allow: false; redirectTo: string }

const ALLOW: GuardDecision = { allow: true }
const redirect = (redirectTo: string): GuardDecision => ({ allow: false, redirectTo })

/** Puerta del portal de EMPRESA. Nunca redirige fuera del portal de empresa. */
export const TENANT_LOGIN_PATH = '/login'
/** Puerta del portal de PLATAFORMA. Nunca redirige al portal de empresa. */
export const OWNER_LOGIN_PATH = '/owner/login'

export interface TenantGuardInput {
  isAuthenticated: boolean
  user: User | null
  roles?: UserRole[]
  capability?: Capability
}

/**
 * Decisión del guard de EMPRESA.
 *
 * Sin sesión o con usuario inactivo → `/login`. Con sesión pero sin el rol o la
 * capacidad exigidos → la home de SU rol (nunca `/login`, que parecería una sesión
 * caída cuando en realidad es una pantalla que no le corresponde).
 */
export function tenantGuardDecision(input: TenantGuardInput): GuardDecision {
  const { isAuthenticated, user, roles, capability } = input
  if (!isAuthenticated || !user) return redirect(TENANT_LOGIN_PATH)
  if (user.status !== 'activo') return redirect(TENANT_LOGIN_PATH)
  if (roles && !roles.includes(user.rol)) return redirect(homePathForRole(user.rol))
  if (capability && !can(user, capability)) return redirect(homePathForRole(user.rol))
  return ALLOW
}

export interface OwnerGuardInput {
  isAuthenticated: boolean
  owner: PlatformUser | null
}

/**
 * Decisión del guard de PLATAFORMA.
 *
 * Mira EXCLUSIVAMENTE la sesión de Owner. Un usuario de empresa —incluido un Super
 * Admin— no tiene sesión aquí y termina en `/owner/login`.
 *
 * GARANTÍA IMPORTANTE: este guard NUNCA redirige a `/login`. Mandar a un Owner al
 * portal de empresa sería mandarlo a un sitio donde no tiene cuenta, y parecería que
 * su sesión se ha perdido cuando lo único que pasó fue que la URL no existía.
 */
export function ownerGuardDecision(input: OwnerGuardInput): GuardDecision {
  const { isAuthenticated, owner } = input
  if (!isAuthenticated || !owner) return redirect(OWNER_LOGIN_PATH)
  if (owner.status !== 'activo') return redirect(OWNER_LOGIN_PATH)
  if (owner.rol !== 'owner') return redirect(OWNER_LOGIN_PATH)
  return ALLOW
}
