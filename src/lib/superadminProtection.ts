// ============================================================
// RUTACASH — PROTECCIÓN DEL ÚLTIMO SUPER ADMIN (LAST_SUPERADMIN_PROTECTION)
// ------------------------------------------------------------
// Una empresa puede tener VARIOS Super Admin: lo decide el cliente, y es lo normal
// en cuanto hay más de un socio o más de una oficina. Lo que NUNCA puede pasar es
// que se quede con CERO Super Admin activos: sería una empresa sin nadie capaz de
// crear usuarios, configurar la empresa o recuperar el control. Y el Owner no puede
// rescatarla desde fuera, porque el Owner no entra en las empresas: solo podría
// crearle un Super Admin nuevo, dejando la cuenta anterior huérfana.
//
// Esta regla es PURA y se aplica en TRES sitios, sobre la misma función:
//   · desactivar un usuario,
//   · eliminar un usuario,
//   · cambiarle el rol a uno inferior.
// Vive separada de `canManageUser` a propósito: aquella responde "¿tengo autoridad
// sobre esta persona?"; esta responde "¿puede la empresa permitirse perderla?".
// Son preguntas distintas y confundirlas produce agujeros.
// ============================================================
import type { User } from '@/models/types'

/** Motivo por el que una baja queda bloqueada. `null` = no hay bloqueo. */
export type SuperadminProtectionBlock = {
  code: 'LAST_SUPERADMIN'
  message: string
} | null

export const LAST_SUPERADMIN_MESSAGE =
  'No puedes dejar la empresa sin Super Admin. Crea o activa otro Super Admin antes de hacer este cambio.'

/** Super Admin ACTIVOS de una empresa. Fuente única del recuento. */
export function activeSuperadminsOf(users: User[], tenantId: string): User[] {
  return users.filter(u => u.tenantId === tenantId && u.rol === 'superadmin' && u.status === 'activo')
}

/**
 * ¿Bloquea la protección DESACTIVAR (o eliminar) a `target`?
 *
 * Bloquea solo cuando `target` es un Super Admin activo y es el ÚNICO que le queda a
 * su empresa. Con dos o más, desactivar a cualquiera es legítimo.
 */
export function blockIfLastSuperadmin(target: User, tenantUsers: User[]): SuperadminProtectionBlock {
  if (target.rol !== 'superadmin') return null
  if (target.status !== 'activo') return null   // ya estaba inactivo: no resta nada
  const activos = activeSuperadminsOf(tenantUsers, target.tenantId)
  if (activos.length > 1) return null
  return { code: 'LAST_SUPERADMIN', message: LAST_SUPERADMIN_MESSAGE }
}

/**
 * ¿Bloquea la protección CAMBIAR EL ROL de `target` a `nextRole`?
 *
 * Degradar al último Super Admin activo deja la empresa sin autoridad máxima: es
 * exactamente el mismo agujero que desactivarlo. Mantener el rol (o cualquier cambio
 * sobre quien no es Super Admin) no se toca.
 */
export function blockIfDemotingLastSuperadmin(
  target: User,
  nextRole: string,
  tenantUsers: User[],
): SuperadminProtectionBlock {
  if (target.rol !== 'superadmin') return null
  if (nextRole === 'superadmin') return null
  return blockIfLastSuperadmin(target, tenantUsers)
}

/**
 * ¿Existe al menos un Super Admin activo en la empresa? Invariante que el sistema
 * debe poder responder afirmativamente SIEMPRE, para cualquier empresa dada de alta.
 */
export function tenantHasActiveSuperadmin(users: User[], tenantId: string): boolean {
  return activeSuperadminsOf(users, tenantId).length > 0
}
