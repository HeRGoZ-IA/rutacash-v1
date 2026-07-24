// ============================================================
// Restablecimiento de contraseñas por jerarquía (SESIONES, BLOQUEOS Y CONTRASEÑAS)
// ------------------------------------------------------------
// - Super Admin: puede restablecer cualquier usuario de la empresa.
// - Administrador: solo perfiles subordinados (nunca Super Admin ni otro Admin).
// - Cambio de contraseña propia: en `useAuth.changeOwnPassword` (todos los perfiles).
//
// Mecanismo local existente (contraseña en texto en Dexie). Se centraliza su uso
// aquí; la autenticación segura deberá migrar a un backend en la versión SaaS real.
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

  await db.users.update(targetUserId, { password: newPassword, updatedAt: nowISO() })
  await logAction({
    tenantId: actor.tenantId, userId: actor.id, userRole: actor.rol,
    action: 'RESET_PASSWORD', entityType: 'User', entityId: targetUserId,
    descripcion: `Restablecimiento de contraseña de ${target.nombre} (${target.email})`,
  })
  return { success: true }
}
