// ============================================================
// RESTABLECIMIENTO DE CONTRASEÑAS — TODO OCURRE EN «USUARIOS»
// ------------------------------------------------------------
// Punto único de gestión administrativa de contraseñas (apartado R):
//   · Super Admin   → cualquier usuario de SU empresa, incluidos otros Super Admin.
//   · Administrador → solo los perfiles subordinados. NUNCA un Super Admin: no puede
//                     restablecer la contraseña de quien está por encima de él, que
//                     sería la forma más directa de suplantarlo.
//   · Cambio propio → `useAuth.changeOwnPassword`, voluntario, desde Mi Perfil.
//
// LO QUE ESTE SERVICIO YA NO HACE: marcar `mustChangePassword`. El cambio obligatorio
// de contraseña se eliminó (apartado Q). Quien recibe una contraseña nueva la usa con
// normalidad; nadie le interrumpe el acceso con un modal ni con una pantalla previa.
//
// NUNCA se muestra la contraseña actual: no se lee ni se devuelve en ningún punto,
// solo se sobrescribe. La contraseña sigue guardándose en texto plano en la base
// local — auditado y documentado; la protección real exige backend.
// ============================================================
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { canManageUser } from '@/lib/permissions'
import type { User } from '@/models/types'

export async function resetUserPassword(actor: User, targetUserId: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  const target = await db.users.get(targetUserId)
  if (!target) return { success: false, error: 'Usuario no encontrado' }
  if (target.id === actor.id) return { success: false, error: 'Usa "cambiar contraseña" para tu propia cuenta.' }
  if (!canManageUser(actor, target)) return { success: false, error: 'No tienes permiso para restablecer la contraseña de este usuario.' }
  if (!newPassword || newPassword.length < 4) return { success: false, error: 'La contraseña debe tener al menos 4 caracteres.' }

  // Se escribe la contraseña y NADA más. `mustChangePassword` se fija explícitamente
  // en false para no reactivar un flag legado sobre cuentas antiguas.
  await db.users.update(targetUserId, { password: newPassword, mustChangePassword: false, updatedAt: nowISO() })
  await logAction({
    tenantId: actor.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'RESET_PASSWORD', entityType: 'User', entityId: targetUserId,
    descripcion: `Restablecimiento de contraseña de ${target.nombre} (${target.email})`,
  })
  return { success: true }
}
