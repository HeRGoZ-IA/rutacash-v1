// ============================================================
// HISTORIAL DE CRÉDITOS DE UN CLIENTE (PURO, sin Dexie ni UI)
// ------------------------------------------------------------
// Fuente única de cómo se arma el historial que ven las áreas administrativas
// (Admin/Super Admin, Secretario, Socio). Es puro para poder verificarlo sin
// renderizar React y para que ninguna pantalla invente su propia versión.
//
// DOS REGLAS INNEGOCIABLES:
//
//  1. IDENTIDAD POR `clientId`, JAMÁS POR NOMBRE. Dos clientes distintos pueden
//     llamarse igual (y hasta compartir documento: `documento` no es índice único).
//     Cruzar por nombre mezclaría historiales de personas diferentes.
//
//  2. NO SE INVENTAN FECHAS. `fechaFinalEstimada` es cuándo DEBERÍA terminar el
//     crédito; `fechaFinalizacion` es cuándo terminó REALMENTE. No son lo mismo y
//     no se sustituyen entre sí. Cuando no hay dato real, se muestra "—".
// ============================================================
import { effectivePayments } from '@/lib/paymentState'
import type { Payment, Sale, SaleStatus } from '@/models/types'

/** Etiqueta de negocio de cada estado de crédito. */
export const CREDIT_STATUS_LABEL: Record<SaleStatus, string> = {
  activa: 'Activo',
  finalizada: 'Finalizado',
  perdida: 'Perdido',
  refinanciada: 'Refinanciado',
}

/**
 * Fecha REAL de finalización que debe quedar sellada tras un recálculo.
 *
 *  · La venta sigue/queda FINALIZADA → se respeta la fecha ya sellada; si no había
 *    ninguna, se sella la del último pago vigente (puede no existir → `undefined`).
 *  · La venta deja de estar finalizada (una corrección la REABRE, o pasa a perdida
 *    o refinanciada) → el cierre ya no existe: la fecha se limpia. Si más adelante
 *    vuelve a saldarse, se sellará la nueva fecha real.
 *
 * Esta es la ÚNICA excepción a "una fecha sellada no se toca", y es deliberada:
 * mantener una fecha de finalización en un crédito que volvió a tener saldo sería
 * un dato falso.
 */
export function resolveSealedCompletionDate(params: {
  status: SaleStatus
  sealed?: string
  lastEffectivePaymentDate?: string
}): string | undefined {
  if (params.status !== 'finalizada') return undefined
  return params.sealed ?? params.lastEffectivePaymentDate
}

/** Un crédito del cliente, con lo que el negocio necesita ver. */
export interface CreditHistoryEntry {
  saleId: string
  routeId: string
  /** Monto prestado (capital, sin interés). */
  valorVenta: number
  /** Total a pagar (capital + interés). */
  valorTotal: number
  saldo: number
  /** Suma de abonos VIGENTES de este crédito (excluye reversiones). */
  totalAbonado: number
  numeroCuotas: number
  /** Fecha comercial de arranque del crédito (NO `createdAt`). */
  fechaInicio: string
  /** Cuándo DEBERÍA terminar. */
  fechaFinEstimada: string
  /** Cuándo terminó REALMENTE. `undefined` = no aplica o no determinable. */
  fechaFinalizacion?: string
  status: SaleStatus
  estado: string
}

/** Historial completo de un cliente. */
export interface ClientCreditHistory {
  clientId: string
  /** Cantidad de créditos que ha tenido el cliente. */
  total: number
  activos: number
  finalizados: number
  perdidos: number
  refinanciados: number
  /** Σ capital prestado en todos sus créditos. */
  totalPrestado: number
  /** Σ abonos vigentes de todos sus créditos. */
  totalAbonado: number
  /** Σ saldo pendiente de los créditos ACTIVOS. */
  saldoPendiente: number
  /** Créditos del más reciente al más antiguo. */
  entries: CreditHistoryEntry[]
}

/**
 * Construye el historial de créditos de UN cliente.
 *
 * @param clientId cliente objetivo; el cruce es SIEMPRE por este id.
 * @param sales    ventas ya recortadas por empresa y por rutas accesibles.
 * @param payments pagos de esas ventas (se filtran a las vigentes aquí).
 */
export function buildClientCreditHistory(
  clientId: string,
  sales: Sale[],
  payments: Payment[],
): ClientCreditHistory {
  const empty: ClientCreditHistory = {
    clientId, total: 0, activos: 0, finalizados: 0, perdidos: 0, refinanciados: 0,
    totalPrestado: 0, totalAbonado: 0, saldoPendiente: 0, entries: [],
  }
  if (!clientId) return empty

  // IDENTIDAD POR ID: nunca por nombre ni por documento.
  const propias = sales.filter(s => s.clientId === clientId)
  if (propias.length === 0) return empty

  // Abonos VIGENTES agrupados por venta (las reversiones no cuentan).
  const abonadoPorVenta = new Map<string, number>()
  for (const p of effectivePayments(payments)) {
    if (p.clientId !== clientId) continue
    abonadoPorVenta.set(p.saleId, (abonadoPorVenta.get(p.saleId) ?? 0) + p.valor)
  }

  const entries: CreditHistoryEntry[] = propias
    .map(s => ({
      saleId: s.id,
      routeId: s.routeId,
      valorVenta: s.valorVenta,
      valorTotal: s.valorTotal,
      saldo: Math.max(0, s.saldo),
      totalAbonado: abonadoPorVenta.get(s.id) ?? 0,
      numeroCuotas: s.numeroCuotas,
      fechaInicio: s.fechaInicio,
      fechaFinEstimada: s.fechaFinalEstimada,
      // Solo un crédito FINALIZADO puede tener fecha real de finalización. Un crédito
      // activo NUNCA aparece como finalizado, y uno perdido no inventa fecha.
      fechaFinalizacion: s.status === 'finalizada' ? s.fechaFinalizacion : undefined,
      status: s.status,
      estado: CREDIT_STATUS_LABEL[s.status] ?? s.status,
    }))
    // Del más reciente al más antiguo (fecha comercial; `createdAt` desempata).
    .sort((a, b) => b.fechaInicio.localeCompare(a.fechaInicio) || b.saleId.localeCompare(a.saleId))

  const count = (st: SaleStatus) => entries.filter(e => e.status === st).length

  return {
    clientId,
    total: entries.length,
    activos: count('activa'),
    finalizados: count('finalizada'),
    perdidos: count('perdida'),
    refinanciados: count('refinanciada'),
    totalPrestado: entries.reduce((s, e) => s + e.valorVenta, 0),
    totalAbonado: entries.reduce((s, e) => s + e.totalAbonado, 0),
    saldoPendiente: entries.filter(e => e.status === 'activa').reduce((s, e) => s + e.saldo, 0),
    entries,
  }
}
