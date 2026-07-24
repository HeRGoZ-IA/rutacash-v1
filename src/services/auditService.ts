import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import type { AuditLog, AuditAction, UserRole } from '@/models/types'

/**
 * Registra una acción crítica en la auditoría (modelo de roles y permisos).
 * Cada registro incluye usuario, rol, fecha/hora, empresa, ruta (si aplica),
 * acción, entidad, id, valores anteriores/nuevos y motivo (cuando es obligatorio).
 */
export async function logAction(params: {
  tenantId: string
  userId: string
  userRole?: UserRole
  routeId?: string
  action: AuditAction
  entityType: string
  entityId: string
  descripcion: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  motivo?: string
  metadata?: Record<string, unknown>
}) {
  const log: AuditLog = {
    id: generateId(),
    ...params,
    createdAt: nowISO(),
  }
  await db.auditLogs.add(log)
}
