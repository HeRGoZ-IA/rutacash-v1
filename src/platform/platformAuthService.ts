// ============================================================
// RUTACASH — AUTENTICACIÓN DEL NIVEL PLATAFORMA (OWNER)
// ------------------------------------------------------------
// Segunda puerta, completamente separada de la de las empresas:
//
//   /owner/login  → ESTE servicio  → tabla `platformUsers` → Dashboard RutaCash
//   /login        → `authService`  → tabla `users`         → panel de la empresa
//
// No hay puente entre ambas. Un Super Admin no puede autenticarse aquí (su fila
// está en otra tabla) y un Owner no puede autenticarse allí (la suya tampoco). No
// existe impersonación, "entrar como cliente" ni modo de prueba: si Helmer o Andrés
// quieren usar el producto como cliente, usan una cuenta NORMAL de empresa por
// `/login`, exactamente igual que cualquier otro cliente. Es intencionado.
//
// NOTA DE SEGURIDAD: contraseña en texto plano en la base local, igual que en el
// nivel empresa. Auditado y documentado; la autenticación real llegará con el
// backend. No se amplía esta entrega a un rediseño criptográfico.
// ============================================================
import { nowISO } from '@/lib/formatters'
import { normalizeEmail } from '@/lib/email'
import { controlPlane, type SaaSControlPlane } from '@/platform/controlPlane'
import type { PlatformUser } from '@/platform/types'

export type OwnerAuthFailureCode = 'INVALID_CREDENTIALS' | 'OWNER_INACTIVE' | 'INTERNAL'

export interface OwnerAuthSuccess {
  ok: true
  owner: PlatformUser
}

export interface OwnerAuthFailure {
  ok: false
  code: OwnerAuthFailureCode
  error: string
}

export type OwnerAuthResult = OwnerAuthSuccess | OwnerAuthFailure

/**
 * Verifica las credenciales de un Owner y registra su telemetría de acceso.
 *
 * `firstLoginAt` se sella una sola vez; `lastLoginAt` se actualiza en cada acceso
 * correcto. Un intento fallido no toca nada (no se registra actividad que no ocurrió).
 */
export async function authenticateOwner(
  email: string,
  password: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<OwnerAuthResult> {
  try {
    const owner = await plane.getOwnerByEmail(normalizeEmail(email))
    if (!owner || owner.password !== password) {
      return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Credenciales incorrectas' }
    }
    if (owner.status !== 'activo') {
      return { ok: false, code: 'OWNER_INACTIVE', error: 'Cuenta inactiva.' }
    }

    const at = nowISO()
    const changes: Partial<PlatformUser> = { lastLoginAt: at, updatedAt: at }
    if (!owner.firstLoginAt) changes.firstLoginAt = at
    await plane.updateOwner(owner.id, changes)

    return { ok: true, owner: { ...owner, ...changes } }
  } catch {
    return { ok: false, code: 'INTERNAL', error: 'Error interno. Intenta de nuevo.' }
  }
}

/**
 * Revalida un Owner persistido en sesión contra la base. Devuelve `null` si dejó de
 * existir o fue desactivado: en ese caso la sesión debe cerrarse.
 */
export async function revalidateOwner(
  ownerId: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<PlatformUser | null> {
  try {
    const owners = await plane.listOwners()
    const fresh = owners.find(o => o.id === ownerId)
    if (!fresh || fresh.status !== 'activo') return null
    return fresh
  } catch {
    // Error transitorio de lectura: no se expulsa de la sesión por un fallo de base.
    return null
  }
}

/** Cambio de contraseña del propio Owner. Voluntario: nunca se fuerza ni se recuerda. */
export async function changeOwnerPassword(
  owner: PlatformUser,
  current: string,
  next: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<{ success: boolean; error?: string }> {
  if (owner.password !== current) return { success: false, error: 'La contraseña actual no es correcta' }
  if (!next || next.length < 8) return { success: false, error: 'La nueva contraseña debe tener al menos 8 caracteres' }
  try {
    await plane.updateOwner(owner.id, { password: next, updatedAt: nowISO() })
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar la contraseña' }
  }
}
