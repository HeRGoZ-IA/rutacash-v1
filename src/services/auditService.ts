import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import type { AuditLog, AuditAction } from '@/models/types'

export async function logAction(params: {
  tenantId: string
  userId: string
  action: AuditAction
  entityType: string
  entityId: string
  descripcion: string
  metadata?: Record<string, unknown>
}) {
  const log: AuditLog = {
    id: generateId(),
    ...params,
    metadata: params.metadata,
    createdAt: nowISO(),
  }
  await db.auditLogs.add(log)
}
