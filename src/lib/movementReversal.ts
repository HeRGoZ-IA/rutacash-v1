// ============================================================
// ANULACIÓN DE MOVIMIENTOS DE FONDOS — REGLAS PURAS
// ------------------------------------------------------------
// Ajustes del socio 2026-10-02, punto 3. Ver `MovementReversalFields`.
//
// ESTRATEGIA CONTABLE (única): el libro conserva el original y su reversión; la
// reversión es un storno (mismo tipo y dirección, importe negado). Los agregados
// NO filtran por estado: suman ambos y el neto es 0. El estado ANULADO sirve para
// auditoría y presentación, nunca para excluir el original de un cálculo.
// Sin Dexie ni React.
// ============================================================
import type { MovementReversalFields } from '@/models/types'

export type ReversalState = 'vigente' | 'anulado' | 'reversion'

export function reversalStateOf(m: MovementReversalFields): ReversalState {
  if (m.reversesId) return 'reversion'
  if (m.reversalId) return 'anulado'
  return 'vigente'
}

/** Solo un movimiento vigente que no sea, a su vez, una reversión puede anularse. */
export function isReversible(m: MovementReversalFields): boolean {
  return reversalStateOf(m) === 'vigente'
}

export const REVERSAL_REASON_MAX = 200

/** Motivo normalizado, o `null` si está vacío / solo espacios. */
export function normalizeReversalReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const r = reason.trim().replace(/\s+/g, ' ')
  return r ? r.slice(0, REVERSAL_REASON_MAX) : null
}

/**
 * Agrupa para mostrar: cada original con su reversión debajo. Una reversión cuyo
 * original no está en la lista (p. ej. fuera del rango de fechas) se muestra suelta.
 * Conserva el orden de la lista de entrada.
 */
export function pairReversals<T extends { id: string } & MovementReversalFields>(
  list: T[],
): { movement: T; reversal?: T }[] {
  const porId = new Map(list.map(m => [m.id, m]))
  const reversiones = new Map(list.filter(m => m.reversesId).map(m => [m.reversesId!, m]))
  return list
    .filter(m => !(m.reversesId && porId.has(m.reversesId)))
    .map(m => ({ movement: m, reversal: reversiones.get(m.id) }))
}
