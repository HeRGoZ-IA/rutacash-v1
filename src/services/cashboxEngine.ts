// ============================================================
// Motor de caja - calcula saldos desde movimientos
// ============================================================
import { db } from '@/lib/db'
import type { CashboxSummary, RouteFinancialSummary } from '@/models/types'

export async function getCashboxSummary(
  routeId: string,
  fechaDesde?: string,
  fechaHasta?: string
): Promise<CashboxSummary> {
  const today = new Date().toISOString().slice(0, 10)
  const desde = fechaDesde ?? '2000-01-01'
  const hasta = fechaHasta ?? today

  // Capital
  const capitalMovs = await db.capitalMovements
    .where('routeId').equals(routeId).toArray()
  const capitalFiltrado = capitalMovs.filter(m => m.fecha >= desde && m.fecha <= hasta)
  const ingresoCapital = capitalFiltrado.reduce((sum, m) => sum + m.valor, 0)

  // Cobros (pagos recibidos)
  const payments = await db.payments
    .where('routeId').equals(routeId).toArray()
  const cobros = payments
    .filter(p => p.fecha >= desde && p.fecha <= hasta)
    .reduce((sum, p) => sum + p.valor, 0)

  // Préstamos entregados (ventas creadas). Las ventas aprobadas pero aún NO
  // desembolsadas no representan dinero entregado todavía → se excluyen.
  const allSales = await db.sales
    .where('routeId').equals(routeId).toArray()
  const sales = allSales.filter(s => s.disbursementStatus !== 'pendiente')
  const prestamosEntregados = sales
    .filter(s => s.fechaInicio >= desde && s.fechaInicio <= hasta)
    .reduce((sum, s) => sum + s.valorVenta, 0)

  // Gastos
  const expenses = await db.expenses
    .where('routeId').equals(routeId).toArray()
  const gastos = expenses
    .filter(e => e.fecha >= desde && e.fecha <= hasta)
    .reduce((sum, e) => sum + e.valor, 0)

  // Transferencias
  const transfersOut = await db.transfers
    .where('routeOrigenId').equals(routeId).toArray()
  const transferenciasSalidas = transfersOut
    .filter(t => t.fecha >= desde && t.fecha <= hasta)
    .reduce((sum, t) => sum + t.valor, 0)

  const transfersIn = await db.transfers
    .where('routeDestinoId').equals(routeId).toArray()
  const transferenciasEntradas = transfersIn
    .filter(t => t.fecha >= desde && t.fecha <= hasta)
    .reduce((sum, t) => sum + t.valor, 0)

  // Retiros
  const withdrawals = await db.withdrawals
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
