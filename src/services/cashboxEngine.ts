// ============================================================
// Motor de caja - calcula saldos desde movimientos
// ============================================================
import { db } from '@/lib/db'
import { effectivePayments } from '@/lib/paymentState'
import { today as todayLocal } from '@/lib/formatters'
import {
  personalPaymentLedger, disbursementInstant, expenseInstant, inCycle,
} from '@/lib/cashSettlementRules'
import type {
  CashboxSummary, RouteFinancialSummary, CollectorCashSummary,
  CapitalMovement, Expense, Payment, Sale, Transfer, Withdrawal,
} from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
/**
 * Superficie mínima de Dexie que necesita el motor de caja. Se declara de forma
 * estructural (mismo criterio que `PaymentDatabase` en paymentService y
 * `ReconciliationDatabase` en financialReconciliation) para poder inyectar una
 * base en memoria desde las pruebas sin arrastrar IndexedDB a Node.
 * En producción SIEMPRE se usa el `db` real.
 */
export interface CashboxReadTable<T> {
  where(index: string): { equals(key: string): { toArray(): Promise<T[]> } }
}

export interface CashboxDatabase {
  capitalMovements: CashboxReadTable<CapitalMovement>
  payments: CashboxReadTable<Payment>
  sales: CashboxReadTable<Sale>
  expenses: CashboxReadTable<Expense>
  transfers: CashboxReadTable<Transfer>
  withdrawals: CashboxReadTable<Withdrawal>
}

export async function getCashboxSummary(
  routeId: string,
  fechaDesde?: string,
  fechaHasta?: string,
  database: CashboxDatabase = db,
): Promise<CashboxSummary> {
  // Fecha LOCAL, la misma con la que `paymentService` sella `Payment.fecha`
  // (`today()`). Antes se usaba la fecha UTC: en husos por delante de UTC, entre la
  // medianoche local y la UTC, los cobros de "hoy" quedaban FUERA de la Base
  // (auditoría de actualización local, 2026-09-24). En Colombia (UTC−5) no se
  // manifestaba porque la fecha UTC nunca es anterior a la local.
  const desde = fechaDesde ?? '2000-01-01'
  const hasta = fechaHasta ?? todayLocal()

  // Capital
  const capitalMovs = await database.capitalMovements
    .where('routeId').equals(routeId).toArray()
  const capitalFiltrado = capitalMovs.filter(m => m.fecha >= desde && m.fecha <= hasta)
  const ingresoCapital = capitalFiltrado.reduce((sum, m) => sum + m.valor, 0)

  // Cobros (pagos recibidos)
  const payments = await database.payments
    .where('routeId').equals(routeId).toArray()
  const cobros = payments
    .filter(p => p.fecha >= desde && p.fecha <= hasta)
    .reduce((sum, p) => sum + p.valor, 0)

  // Préstamos entregados (ventas creadas). Las ventas aprobadas pero aún NO
  // desembolsadas no representan dinero entregado todavía → se excluyen.
  const allSales = await database.sales
    .where('routeId').equals(routeId).toArray()
  const sales = allSales.filter(s => s.disbursementStatus !== 'pendiente')
  const prestamosEntregados = sales
    .filter(s => s.fechaInicio >= desde && s.fechaInicio <= hasta)
    .reduce((sum, s) => sum + s.valorVenta, 0)

  // Gastos
  const expenses = await database.expenses
    .where('routeId').equals(routeId).toArray()
  const gastos = expenses
    .filter(e => e.fecha >= desde && e.fecha <= hasta)
    .reduce((sum, e) => sum + e.valor, 0)

  // Transferencias
  const transfersOut = await database.transfers
    .where('routeOrigenId').equals(routeId).toArray()
  const transferenciasSalidas = transfersOut
    .filter(t => t.fecha >= desde && t.fecha <= hasta)
    .reduce((sum, t) => sum + t.valor, 0)

  const transfersIn = await database.transfers
    .where('routeDestinoId').equals(routeId).toArray()
  const transferenciasEntradas = transfersIn
    .filter(t => t.fecha >= desde && t.fecha <= hasta)
    .reduce((sum, t) => sum + t.valor, 0)

  // Retiros
  const withdrawals = await database.withdrawals
    .where('routeId').equals(routeId).toArray()
  const retiros = withdrawals
    .filter(w => w.fecha >= desde && w.fecha <= hasta)
    .reduce((sum, w) => sum + w.valor, 0)

  // Saldo anterior (capital antes del rango)
  const capitalAnterior = capitalMovs
    .filter(m => m.fecha < desde)
    .reduce((sum, m) => sum + m.valor, 0)
  const cobrosAnteriores = payments
    .filter(p => p.fecha < desde)
    .reduce((sum, p) => sum + p.valor, 0)
  const prestamosAnteriores = sales
    .filter(s => s.fechaInicio < desde)
    .reduce((sum, s) => sum + s.valorVenta, 0)
  const gastosAnteriores = expenses
    .filter(e => e.fecha < desde)
    .reduce((sum, e) => sum + e.valor, 0)
  const transOutAnteriores = transfersOut
    .filter(t => t.fecha < desde)
    .reduce((sum, t) => sum + t.valor, 0)
  const transInAnteriores = transfersIn
    .filter(t => t.fecha < desde)
    .reduce((sum, t) => sum + t.valor, 0)
  const retirosAnteriores = withdrawals
    .filter(w => w.fecha < desde)
    .reduce((sum, w) => sum + w.valor, 0)

  const saldoAnterior =
    capitalAnterior + cobrosAnteriores + transInAnteriores
    - prestamosAnteriores - gastosAnteriores - transOutAnteriores - retirosAnteriores

  const saldoActual =
    saldoAnterior + ingresoCapital + cobros + transferenciasEntradas
    - prestamosEntregados - gastos - transferenciasSalidas - retiros

  return {
    routeId,
    saldoAnterior,
    ingresoCapital,
    cobros,
    prestamosEntregados,
    gastos,
    transferenciasEntradas,
    transferenciasSalidas,
    retiros,
    saldoActual,
  }
}

/**
 * Capital disponible de una ruta para entregar nuevos préstamos.
 * Es el saldo actual de caja (capital + cobros + transferencias entrantes
 * - préstamos entregados - gastos - transferencias salientes - retiros).
 * Una venta nueva no puede superar este valor.
 */
export async function getRouteAvailableCapital(routeId: string): Promise<number> {
  const summary = await getCashboxSummary(routeId)
  return summary.saldoActual
}

export async function getRoutesCurrentBalance(routeIds: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const routeId of routeIds) {
    const summary = await getCashboxSummary(routeId)
    result[routeId] = summary.saldoActual
  }
  return result
}

/**
 * Resumen financiero por ruta (revisión socio 25-jun): helper reutilizable que
 * separa "Base actual" (dinero disponible en caja) de "Cartera en calle" (lo
 * prestado pendiente por cobrar). Usar en todas las pantallas para evitar
 * cálculos distintos por vista.
 *
 *  - baseActual:      saldo de caja (reusa getRouteAvailableCapital / motor de caja).
 *  - carteraEnCalle:  Σ saldo de ventas activas YA desembolsadas (capital + interés).
 *                     NO incluye ventas pendientes de desembolso ni perdidas/cerradas.
 *  - totalControlado: baseActual + carteraEnCalle.
 *  - interesPorCobrarEstimado: estimación proporcional (saldo × interés / total).
 */
export async function getRouteFinancialSummary(routeId: string): Promise<RouteFinancialSummary> {
  const baseActual = (await getCashboxSummary(routeId)).saldoActual

  const sales = await db.sales.where('routeId').equals(routeId).toArray()
  // Solo ventas activas y desembolsadas (las 'pendiente' aún no salieron a la calle).
  const activas = sales.filter(s => s.status === 'activa' && s.disbursementStatus !== 'pendiente')

  const carteraEnCalle = activas.reduce((sum, s) => sum + Math.max(0, s.saldo), 0)

  // Interés por cobrar estimado: proporción del interés dentro del saldo de cada venta.
  const interesPorCobrarEstimado = Math.round(activas.reduce((sum, s) => {
    if (s.valorTotal <= 0) return sum
    return sum + (Math.max(0, s.saldo) * s.valorInteres) / s.valorTotal
  }, 0))

  const clientesActivos = new Set(activas.map(s => s.clientId)).size

  return {
    routeId,
    baseActual,
    carteraEnCalle,
    totalControlado: baseActual + carteraEnCalle,
    ventasActivas: activas.length,
    clientesActivos,
    interesPorCobrarEstimado,
  }
}

/** Versión por lote: resumen financiero de varias rutas (clave = routeId). */
export async function getRoutesFinancialSummary(routeIds: string[]): Promise<Record<string, RouteFinancialSummary>> {
  const result: Record<string, RouteFinancialSummary> = {}
  for (const routeId of routeIds) {
    result[routeId] = await getRouteFinancialSummary(routeId)
  }
  return result
}

// ============================================================
// CAJA PERSONAL DEL COBRADOR (revisión del socio — RQ-05)
// ------------------------------------------------------------
// La caja del Cobrador NO es la caja financiera de la ruta. Representa el
// EFECTIVO OPERATIVO bajo su responsabilidad:
//
//     recaudado − desembolsado − gastos = efectivo a entregar
//
// Esta función lee EXCLUSIVAMENTE lo atribuible a ese cobrador y NO toca
// `capitalMovements`, `transfers` ni `withdrawals`: el capital inicial y el
// consolidado de la ruta no se calculan aquí, así que no pueden filtrarse a la
// pantalla del cobrador ni siquiera por accidente. Ocultar una tarjeta no habría
// bastado: el dato no se obtiene.
// ============================================================

/** Superficie de datos de la caja personal: SOLO pagos, ventas y gastos. */
export interface CollectorCashDatabase {
  payments: CashboxReadTable<Payment>
  sales: CashboxReadTable<Sale>
  expenses: CashboxReadTable<Expense>
}

/**
 * Caja personal de un cobrador en una fecha.
 *
 *  · recaudado    Σ abonos VIGENTES con `collectorId` = él (excluye reversiones,
 *                 misma semántica canónica que la corrección controlada).
 *  · desembolsado Σ ventas que ÉL desembolsó ese día (`disbursedByCollectorId`),
 *                 por FECHA DE DESEMBOLSO, no por fecha de creación de la venta.
 *  · gastos       Σ gastos cargados a SU caja (`collectorId`), con compatibilidad
 *                 hacia atrás: los gastos anteriores a la separación solo llevan
 *                 `userId`, y se aceptan cuando ese usuario es él mismo.
 */
export async function getCollectorDailyCashSummary(
  params: { routeId: string; collectorId: string; fecha: string },
  database: CollectorCashDatabase = db,
): Promise<CollectorCashSummary> {
  const { routeId, collectorId, fecha } = params
  const vacio: CollectorCashSummary = {
    collectorId, routeId, fecha, recaudado: 0, desembolsado: 0, gastos: 0, efectivoAEntregar: 0,
  }
  // Fail-closed: sin cobrador o sin ruta no se calcula nada.
  if (!routeId || !collectorId) return vacio

  const [payments, sales, expenses] = await Promise.all([
    database.payments.where('routeId').equals(routeId).toArray(),
    database.sales.where('routeId').equals(routeId).toArray(),
    database.expenses.where('routeId').equals(routeId).toArray(),
  ])

  const recaudado = effectivePayments(payments)
    .filter(p => p.collectorId === collectorId && p.fecha === fecha)
    .reduce((sum, p) => sum + p.valor, 0)

  const desembolsado = sales
    .filter(s => s.disbursementStatus !== 'pendiente'
      && s.disbursedByCollectorId === collectorId
      && s.fechaDesembolso === fecha)
    .reduce((sum, s) => sum + s.valorVenta, 0)

  const gastos = expenses
    .filter(e => e.fecha === fecha && (e.collectorId ?? e.userId) === collectorId)
    .reduce((sum, e) => sum + e.valor, 0)

  return {
    collectorId, routeId, fecha,
    recaudado, desembolsado, gastos,
    efectivoAEntregar: recaudado - desembolsado - gastos,
  }
}

// ============================================================
// CAJA PERSONAL POR RANGO DE INSTANTES (cuadre por trabajador, v14)
// ------------------------------------------------------------
// Misma superficie de datos que la caja diaria (pagos, ventas, gastos: NUNCA
// capital, transferencias ni retiros) y el mismo criterio de responsable, pero el
// periodo es (desde, hasta] en INSTANTES ISO: el ciclo de efectivo de una persona
// empieza en su último cuadre, no a medianoche.
//
// `getCollectorDailyCashSummary` se conserva intacta: "Mi recaudo hoy" sigue siendo
// un KPI diario. Esta función responde otra pregunta: "¿cuánto efectivo tiene esta
// persona desde su último cuadre?".
// ============================================================
export interface CollectorCashRangeSummary {
  routeId: string
  userId: string
  desde: string
  hasta: string
  recaudado: number
  desembolsado: number
  gastos: number
  /** recaudado − desembolsado − gastos (SIN arrastre). */
  neto: number
}

export async function getCollectorCashSummary(
  params: { routeId: string; userId: string; desde: string; hasta: string; modelStart?: string },
  database: CollectorCashDatabase = db,
): Promise<CollectorCashRangeSummary> {
  const { routeId, userId, desde, hasta } = params
  const vacio: CollectorCashRangeSummary = { routeId, userId, desde, hasta, recaudado: 0, desembolsado: 0, gastos: 0, neto: 0 }
  // Fail-closed: sin persona, sin ruta o con un rango vacío no se calcula nada.
  if (!routeId || !userId || !(hasta > desde)) return vacio

  const [payments, sales, expenses] = await Promise.all([
    database.payments.where('routeId').equals(routeId).toArray(),
    database.sales.where('routeId').equals(routeId).toArray(),
    database.expenses.where('routeId').equals(routeId).toArray(),
  ])

  // Libro con signo, anclado al inicio del modelo (ver `personalPaymentLedger`).
  const recaudado = personalPaymentLedger(payments, params.modelStart ?? '')
    .filter(x => x.payment.collectorId === userId && inCycle(x.instante, desde, hasta))
    .reduce((sum, x) => sum + x.aporte, 0)

  const desembolsado = sales
    .filter(s => s.disbursementStatus !== 'pendiente'
      && s.disbursedByCollectorId === userId
      && inCycle(disbursementInstant(s), desde, hasta))
    .reduce((sum, s) => sum + s.valorVenta, 0)

  const gastos = expenses
    .filter(e => (e.collectorId ?? e.userId) === userId && inCycle(expenseInstant(e), desde, hasta))
    .reduce((sum, e) => sum + e.valor, 0)

  return { routeId, userId, desde, hasta, recaudado, desembolsado, gastos, neto: recaudado - desembolsado - gastos }
}

/**
 * ¿La ruta tiene capital suficiente para una venta de `valorVenta`?
 *
 * Devuelve SOLO el veredicto, nunca el monto. Permite conservar intacta la regla de
 * negocio "no vender por encima del capital disponible" en pantallas donde el
 * usuario no debe conocer la cifra financiera de la ruta (App Cobrador), sin
 * eliminar la validación ni dejar un error inexplicable.
 */
export async function hasCapitalForSale(routeId: string, valorVenta: number): Promise<boolean> {
  if (!routeId) return false
  if (!Number.isFinite(valorVenta) || valorVenta <= 0) return true
  const { saldoActual } = await getCashboxSummary(routeId)
  return valorVenta <= saldoActual
}
