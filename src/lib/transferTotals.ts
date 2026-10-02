// ============================================================
// TOTALES DE TRANSFERENCIAS POR ENTIDAD (PURO)
// ------------------------------------------------------------
// Entrante / Saliente / Neto de una Ruta o Socio en la vista de Transferencias.
// Muestran el EFECTO VIGENTE: una transferencia anulada y su reversión (storno,
// importe negado) suman 0, así que no se cuentan dos veces ni se "corrigen" dos
// veces. El historial completo sigue en `transfers`.
// ============================================================
import { pairReversals } from '@/lib/movementReversal'
import type { Transfer, TransferEntityType } from '@/models/types'

export interface TransferTotals {
  entrante: number
  saliente: number
  neto: number
  /** Movimientos mostrados (una anulación y su reversión cuentan como uno). */
  cantidad: number
  transfers: Transfer[]
}

export function transferTotalsFor(all: Transfer[], type: TransferEntityType, id: string): TransferTotals {
  const isOrigin = (t: Transfer) => type === 'route' ? t.routeOrigenId === id : t.socioOrigenId === id
  const isDest = (t: Transfer) => type === 'route' ? t.routeDestinoId === id : t.socioDestinoId === id
  const mine = all.filter(t => isOrigin(t) || isDest(t))
  const entrante = mine.filter(isDest).reduce((s, t) => s + t.valor, 0)
  const saliente = mine.filter(isOrigin).reduce((s, t) => s + t.valor, 0)
  return { entrante, saliente, neto: entrante - saliente, cantidad: pairReversals(mine).length, transfers: mine }
}
