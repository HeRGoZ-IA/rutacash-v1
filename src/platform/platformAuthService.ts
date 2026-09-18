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
 * Resultado de revalidar una sesión de Owner. Son TRES desenlaces y no dos, y
 * confundirlos tiene consecuencias: un fallo transitorio de lectura no puede
 * significar lo mismo que una cuenta borrada.
 *
 *   'ok'       → la cuenta sigue viva y activa; se refresca.
 *   'revoked'  → dejó de existir o fue desactivada; hay que CERRAR la sesión.
 *   'unknown'  → no se pudo leer la base; se MANTIENE la sesión tal cual.
 */
export type OwnerRevalidation =
  | { status: 'ok'; owner: PlatformUser }
  | { status: 'revoked' }
  | { status: 'unknown' }

/**
 * Revalida un Owner persistido en sesión contra la base.
 *
 * CORRECCIÓN: antes devolvía `null` tanto cuando la cuenta había desaparecido como
 * cuando la lectura fallaba, y el store cerraba la sesión en ambos casos — pese a que
 * el comentario afirmaba lo contrario. Un error transitorio de IndexedDB al arrancar
 * expulsaba al Owner sin motivo. Ahora los tres desenlaces son distinguibles, igual
 * que en `useAuth.revalidateSession` para el nivel empresa.
 */
export async function revalidateOwnerSession(
  ownerId: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<OwnerRevalidation> {
  try {
    const owners = await plane.listOwners()
    const fresh = owners.find(o => o.id === ownerId)
    if (!fresh || fresh.status !== 'activo') return { status: 'revoked' }
    return { status: 'ok', owner: fresh }
  } catch {
    // Fallo de lectura: NO se expulsa de la sesión por un error transitorio.
    return { status: 'unknown' }
  }
}

/**
 * Compatibilidad: devuelve el Owner o `null`. Se conserva para quien solo necesite
 * "dámelo si está vivo"; para decidir si cerrar la sesión hay que usar
 * `revalidateOwnerSession`, que distingue el fallo de lectura.
 */
export async function revalidateOwner(
  ownerId: string,
  plane: SaaSControlPlane = controlPlane,
): Promise<PlatformUser | null> {
  const r = await revalidateOwnerSession(ownerId, plane)
  return r.status === 'ok' ? r.owner : null
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
