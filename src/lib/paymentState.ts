// ============================================================
// SEMÁNTICA DE PAGOS VIGENTES (PURA, sin dependencias de Dexie)
// ------------------------------------------------------------
// DEFINICIÓN ÚNICA de qué pagos cuentan contablemente. Vivía dentro de
// `paymentCorrectionService`, que importa `db`; se extrajo aquí para que también
// puedan usarla el esquema (migraciones de `db.ts`) y los generadores de reportes
// sin crear una dependencia circular. `paymentCorrectionService` la reexporta,
// así que sigue habiendo un solo criterio en todo el sistema:
//
//   · state 'reversed'  → original anulado por una corrección   → NO cuenta
//   · state 'reversal'  → asiento negativo que anula al anterior → NO cuenta
//   · state 'active' | 'correction' | undefined (pagos antiguos) → SÍ cuenta
//
// Excluir el par (original + reversión) equivale a netearlos, y evita depender del
// signo negativo del asiento.
// ============================================================
import type { Payment } from '@/models/types'

/** ¿Este pago cuenta contablemente? */
export function isEffectivePayment(p: Pick<Payment, 'state'>): boolean {
  return p.state !== 'reversed' && p.state !== 'reversal'
}

/** Pagos "efectivos": excluye originales revertidos y asientos de reversión. */
export function effectivePayments<T extends Pick<Payment, 'state'>>(payments: T[]): T[] {
  return payments.filter(isEffectivePayment)
}

/**
 * Fecha CONTABLE del último pago vigente de una lista (yyyy-MM-dd), o `undefined`
 * si no hay ninguno. Es la única fuente admitida para inferir cuándo terminó de
 * pagarse un crédito histórico: si no existe, no se inventa una fecha.
 */
export function lastEffectivePaymentDate<T extends Pick<Payment, 'state' | 'fecha'>>(payments: T[]): string | undefined {
  const fechas = effectivePayments(payments).map(p => p.fecha).filter(Boolean).sort()
  return fechas.length > 0 ? fechas[fechas.length - 1] : undefined
}

// ------------------------------------------------------------
// ANULACIÓN DE PAGOS (ajustes del socio 2026-10-02, punto 7)
// ------------------------------------------------------------
/**
 * Estado visible de un pago:
 *  · 'vigente'   → cuenta (incluye un pago corregido que reemplazó a otro)
 *  · 'anulado'   → original anulado SIN reemplazo (anulación administrativa)
 *  · 'corregido' → original reemplazado por una corrección del Secretario
 *  · 'reversion' → asiento técnico negativo; nunca se muestra como abono
 */
export type PaymentDisplayState = 'vigente' | 'anulado' | 'corregido' | 'reversion'

export function paymentDisplayStateOf(
  p: Pick<Payment, 'state' | 'correctedByPaymentId'>,
): PaymentDisplayState {
  if (p.state === 'reversal') return 'reversion'
  if (p.state === 'reversed') return p.correctedByPaymentId ? 'corregido' : 'anulado'
  return 'vigente'
}

/** Solo un pago vigente puede anularse: nunca un asiento de reversión ni un original ya revertido. */
export function isPaymentAnnullable(p: Pick<Payment, 'state' | 'valor'>): boolean {
  return isEffectivePayment(p) && p.valor > 0
}

/**
 * Lista de un historial: los pagos que el usuario ve como filas (originales,
 * anulados incluidos), sin los asientos técnicos de reversión, cada uno con su
 * reversión enlazada para mostrar motivo e importe. Conserva el orden de entrada.
 */
export function paymentHistoryRows<T extends Pick<Payment, 'id' | 'state' | 'reversesPaymentId'>>(
  payments: T[],
): { payment: T; reversal?: T }[] {
  const reversiones = new Map(
    payments.filter(p => p.state === 'reversal' && p.reversesPaymentId).map(p => [p.reversesPaymentId!, p]),
  )
  return payments
    .filter(p => p.state !== 'reversal')
    .map(p => ({ payment: p, reversal: reversiones.get(p.id) }))
}
