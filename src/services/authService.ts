// ============================================================
// RUTACASH — AUTENTICACIÓN (LÓGICA DE DOMINIO)
// ------------------------------------------------------------
// Extrae de `useAuth` la comprobación de credenciales para que sea verificable con
// pruebas automáticas sobre una base inyectada. `useAuth.login` delega aquí; la
// semántica es EXACTAMENTE la que ya existía:
//   1) usuario por email (normalizado a minúsculas, sin espacios)
//   2) contraseña exacta
//   3) usuario activo
//   4) empresa no suspendida ni vencida — AHORA TAMBIÉN PARA EL SUPER ADMIN
//
// NOTA DE SEGURIDAD (sin cambios respecto al estado anterior): la contraseña se
// guarda en texto plano en Dexie. Esto NO es seguridad real; la autenticación
// robusta requiere el backend de la versión SaaS. Ver `permissions.ts`.
// ============================================================
import { db } from '@/lib/db'
import { isCompanyBlocked, companyBlockMessage } from '@/lib/company'
import { normalizeEmail } from '@/lib/email'
import type { Route, Tenant, User } from '@/models/types'

/** Superficie mínima de lectura que necesita la autenticación. */
export interface AuthDatabase {
  users: {
    where(index: string): { equals(key: string): { first(): Promise<User | undefined> } }
  }
  tenants: { get(key: string): Promise<Tenant | undefined> }
  routes: { get(key: string): Promise<Route | undefined> }
}

export type AuthFailureCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_INACTIVE'
  | 'COMPANY_BLOCKED'
  | 'INTERNAL'

export interface AuthSuccess {
  ok: true
  user: User
  tenant: Tenant | null
  route: Route | null
  /** true si el usuario debe cambiar su contraseña antes de operar. */
  mustChangePassword: boolean
}

export interface AuthFailure {
  ok: false
  code: AuthFailureCode
  error: string
}

export type AuthResult = AuthSuccess | AuthFailure

// La normalización vive en `lib/email` (fuente única). Se reexporta para no romper
// a quien ya la importaba desde aquí.
export { normalizeEmail } from '@/lib/email'

/**
 * Verifica credenciales y devuelve el contexto de sesión. No muta nada.
 */
export async function authenticateUser(
  email: string,
  password: string,
  database: AuthDatabase = db,
): Promise<AuthResult> {
  try {
    const user = await database.users.where('email').equals(normalizeEmail(email)).first()

    if (!user || user.password !== password) {
      return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Credenciales incorrectas' }
    }
    if (user.status !== 'activo') {
      return { ok: false, code: 'USER_INACTIVE', error: 'Usuario inactivo. Contacta al administrador.' }
    }

    // EMPRESA — SIN EXCEPCIONES. Antes el Super Admin se saltaba esta comprobación
    // porque era un usuario "de plataforma" con tenant centinela. Desde la separación
    // Plataforma/Empresa, TODO usuario de `users` pertenece a una empresa real y le
    // afecta su estado: si el Owner suspende la empresa, su Super Admin tampoco entra.
    // Esa es exactamente la consecuencia deseada de suspender el servicio.
    const tenant: Tenant | null = (await database.tenants.get(user.tenantId)) ?? null
    // Bloqueo por estado EFECTIVO: suspendida (manual) o vencida (por fecha).
    if (tenant && isCompanyBlocked(tenant)) {
      return {
        ok: false,
        code: 'COMPANY_BLOCKED',
        error: companyBlockMessage(tenant) ?? 'Empresa no disponible.',
      }
    }

    let route: Route | null = null
    if (user.routeId) {
      route = (await database.routes.get(user.routeId)) ?? null
    }

    // `mustChangePassword` se sigue devolviendo por compatibilidad del contrato, pero
    // NINGÚN guard lo consume: el cambio obligatorio de contraseña se eliminó.
    return { ok: true, user, tenant, route, mustChangePassword: user.mustChangePassword === true }
  } catch {
    return { ok: false, code: 'INTERNAL', error: 'Error interno. Intenta de nuevo.' }
  }
}
