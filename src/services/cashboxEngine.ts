// ============================================================
// Motor de caja - calcula saldos desde movimientos
// ============================================================
import { db } from '@/lib/db'
import type { CashboxSummary } from '@/models/types'

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

  // Préstamos entregados (ventas creadas)
  const sales = await db.sales
    .where('routeId').equals(routeId).toArray()
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

export async function getRoutesCurrentBalance(routeIds: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const routeId of routeIds) {
    const summary = await getCashboxSummary(routeId)
    result[routeId] = summary.saldoActual
  }
  return result
}
