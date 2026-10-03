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

// ------------------------------------------------------------
// SINCRONIZACIÓN DE PAGOS Y ANULACIONES (ajustes del socio 2026-10-02, punto 8)
// ------------------------------------------------------------
// HOY NO HAY BACKEND: `syncStatus` es una etiqueta LOCAL ("registrado sin conexión /
// confirmado") dentro de la única IndexedDB del navegador. Estas reglas fijan el
// contrato que cualquier sincronización —la local de hoy o una remota futura— debe
// respetar para que todas las copias converjan al mismo libro de pagos:
//
//   · CAUSALIDAD: una reversión (o el pago que reemplaza en una corrección) depende
//     de su original. Si el original sigue pendiente, el dependiente nace pendiente
//     y nunca se confirma antes que él.
//   · MONOTONÍA: active → reversed es irreversible; un asiento 'reversal' nunca cambia
//     de estado ni de original. Una copia vieja 'active' no reactiva un anulado.
//   · ESTADOS IMPOSIBLES: se detectan y se señalan (syncStatus 'error'), nunca se
//     ocultan ni se "reparan" adivinando.
// ------------------------------------------------------------

/** Estado de sincronización de un asiento que DEPENDE de `original` (reversión, reemplazo). */
export function dependentSyncStatus(original: Pick<Payment, 'syncStatus'>): Payment['syncStatus'] {
  return original.syncStatus === 'synced' ? 'synced' : 'pending'
}

export class PaymentStateTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentStateTransitionError'
  }
}

/**
 * Guarda de MONOTONÍA para cualquier escritura sobre un pago existente (la aplica el
 * hook `updating` de `db.payments`, así que vale para update, modify y put).
 * Lanza si la escritura reactivaría un anulado, cambiaría el estado de un asiento de
 * reversión o reapuntaría los enlaces original ↔ reversión ya fijados.
 */
export function assertPaymentTransitionAllowed(
  current: Pick<Payment, 'id' | 'state' | 'reversesPaymentId' | 'reversalPaymentId'>,
  changes: Partial<Record<keyof Payment, unknown>>,
): void {
  const cambia = (k: 'state' | 'reversesPaymentId' | 'reversalPaymentId') => k in changes && changes[k] !== current[k]
  if ((current.state === 'reversed' || current.state === 'reversal') && cambia('state')) {
    throw new PaymentStateTransitionError(
      `El pago ${current.id} ya está ${current.state === 'reversed' ? 'anulado' : 'registrado como reversión'}: no puede volver a otro estado.`,
    )
  }
  if (current.reversesPaymentId && cambia('reversesPaymentId')) {
    throw new PaymentStateTransitionError(`La reversión ${current.id} no puede cambiar de pago original.`)
  }
  if (current.reversalPaymentId && cambia('reversalPaymentId')) {
    throw new PaymentStateTransitionError(`El pago ${current.id} ya tiene su reversión enlazada.`)
  }
}

export type PaymentLedgerAnomalyCode =
  | 'REVERSED_WITHOUT_REVERSAL'   // original anulado sin asiento de reversión
  | 'ORPHAN_REVERSAL'             // reversión sin original (o sin `reversesPaymentId`)
  | 'REVERSAL_OF_EFFECTIVE'       // reversión presente con el original aún vigente
  | 'DUPLICATE_REVERSAL'          // dos reversiones para el mismo original
  | 'BROKEN_REVERSAL_LINK'        // `reversalPaymentId` apunta a otra fila

export interface PaymentLedgerAnomaly {
  code: PaymentLedgerAnomalyCode
  /** Pagos implicados (original y/o reversiones). */
  paymentIds: string[]
  message: string
}

/**
 * Estados IMPOSIBLES del libro de pagos de un crédito (o de cualquier conjunto que
 * contenga a la vez originales y reversiones). Los datos antiguos sin
 * `reversalPaymentId` NO son anomalía: el vínculo canónico es `reversesPaymentId`.
 */
export function paymentLedgerAnomalies(
  payments: Pick<Payment, 'id' | 'state' | 'reversesPaymentId' | 'reversalPaymentId'>[],
): PaymentLedgerAnomaly[] {
  const out: PaymentLedgerAnomaly[] = []
  const byId = new Map(payments.map(p => [p.id, p]))
  const reversionesDe = new Map<string, string[]>()
  for (const r of payments.filter(p => p.state === 'reversal')) {
    const target = r.reversesPaymentId ? byId.get(r.reversesPaymentId) : undefined
    if (!r.reversesPaymentId || !target) {
      out.push({ code: 'ORPHAN_REVERSAL', paymentIds: [r.id], message: `La reversión ${r.id} no tiene pago original.` })
      continue
    }
    reversionesDe.set(target.id, [...(reversionesDe.get(target.id) ?? []), r.id])
    if (target.state !== 'reversed') {
      out.push({ code: 'REVERSAL_OF_EFFECTIVE', paymentIds: [target.id, r.id], message: `El pago ${target.id} tiene reversión pero sigue vigente.` })
    }
  }
  for (const [orig, revs] of reversionesDe) {
    if (revs.length > 1) out.push({ code: 'DUPLICATE_REVERSAL', paymentIds: [orig, ...revs], message: `El pago ${orig} tiene ${revs.length} reversiones.` })
  }
  for (const p of payments.filter(x => x.state === 'reversed')) {
    const revs = reversionesDe.get(p.id) ?? []
    if (revs.length === 0) {
      out.push({ code: 'REVERSED_WITHOUT_REVERSAL', paymentIds: [p.id], message: `El pago ${p.id} figura anulado pero no tiene asiento de reversión.` })
    } else if (p.reversalPaymentId && !revs.includes(p.reversalPaymentId)) {
      out.push({ code: 'BROKEN_REVERSAL_LINK', paymentIds: [p.id, ...revs], message: `El pago ${p.id} apunta a una reversión que no es la suya.` })
    }
  }
  return out
}

/**
 * Operaciones de pago aún sin confirmar, contadas como las ve el Cobrador: una fila
 * por pago (el asiento técnico de reversión no cuenta aparte). Incluye 'error', que
 * también está por confirmar.
 */
export function pendingPaymentSyncCount(payments: Pick<Payment, 'id' | 'state' | 'reversesPaymentId' | 'syncStatus'>[]): number {
  const porConfirmar = (p?: Pick<Payment, 'syncStatus'>) => !!p && p.syncStatus !== 'synced'
  return paymentHistoryRows(payments).filter(r => porConfirmar(r.payment) || porConfirmar(r.reversal)).length
}
