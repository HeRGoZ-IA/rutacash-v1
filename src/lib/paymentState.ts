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
