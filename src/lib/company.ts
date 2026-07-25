// ============================================================
// ESTADO EFECTIVO DE LA EMPRESA (vigencia real)
// ------------------------------------------------------------
// El `status` guardado ('activa' | 'prueba' | 'suspendida') NO basta: si la empresa
// tiene fecha de vencimiento y ya pasó, su estado EFECTIVO es 'vencida'. Esta es la
// FUENTE ÚNICA para decidir vencimiento; la usan login, revalidación, guards y UI.
//
// Reglas:
//  - 'suspendida' (decisión MANUAL) tiene prioridad y NO se reactiva por fecha.
//  - Vencimiento por FECHA CALENDARIO (yyyy-MM-dd), inclusivo: la empresa funciona
//    hasta las 23:59:59 del día de vencimiento; desde el día siguiente = 'vencida'.
//  - 'Sin vencimiento' (fechaVencimiento vacío) nunca vence por fecha.
//  - Renovar (fecha futura o sin vencimiento) devuelve el estado efectivo a
//    'activa'/'prueba' automáticamente, salvo suspensión manual.
// ============================================================
import { today } from '@/lib/formatters'
import type { Tenant } from '@/models/types'

export type EffectiveCompanyStatus = 'activa' | 'prueba' | 'suspendida' | 'vencida'

/** Estado EFECTIVO de la empresa (deriva 'vencida' de la fecha; no muta el guardado). */
export function getEffectiveCompanyStatus(
  tenant: Pick<Tenant, 'status' | 'fechaVencimiento'>,
  nowStr: string = today(),
): EffectiveCompanyStatus {
  // Suspensión manual manda sobre cualquier fecha.
  if (tenant.status === 'suspendida') return 'suspendida'
  // Vencida si hay fecha y el día de hoy es POSTERIOR (comparación de calendario).
  if (tenant.fechaVencimiento && tenant.fechaVencimiento < nowStr) return 'vencida'
  // Sin vencimiento o fecha vigente → estado guardado (activa/prueba).
  return tenant.status === 'prueba' ? 'prueba' : 'activa'
}

/** ¿La empresa está VENCIDA por fecha (no suspendida manual)? */
export function isCompanyExpired(tenant: Pick<Tenant, 'status' | 'fechaVencimiento'>, nowStr?: string): boolean {
  return getEffectiveCompanyStatus(tenant, nowStr) === 'vencida'
}

/**
 * ¿La empresa BLOQUEA el acceso a los usuarios NO superadmin?
 * Bloquea si está suspendida (manual) o vencida (por fecha).
 */
export function isCompanyBlocked(tenant: Pick<Tenant, 'status' | 'fechaVencimiento'>, nowStr?: string): boolean {
  const eff = getEffectiveCompanyStatus(tenant, nowStr)
  return eff === 'suspendida' || eff === 'vencida'
}

/** Mensaje de bloqueo según el estado efectivo (para login/revalidación). */
export function companyBlockMessage(tenant: Pick<Tenant, 'status' | 'fechaVencimiento'>, nowStr?: string): string | null {
  const eff = getEffectiveCompanyStatus(tenant, nowStr)
  if (eff === 'vencida') return 'El servicio de esta empresa se encuentra vencido. Comunícate con el responsable para renovar.'
  if (eff === 'suspendida') return 'Tu empresa está suspendida. Contacta al soporte.'
  return null
}

export const EFFECTIVE_STATUS_LABEL: Record<EffectiveCompanyStatus, string> = {
  activa: 'activa', prueba: 'prueba', suspendida: 'suspendida', vencida: 'vencida',
}
