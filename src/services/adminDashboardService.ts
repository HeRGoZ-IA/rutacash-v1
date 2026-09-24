// ============================================================
// DASHBOARD ADMINISTRATIVO — CÁLCULO DE KPIs (sin React)
// ------------------------------------------------------------
// Vivía dentro de `DashboardPage` y por eso no podía probarse: la auditoría de
// actualización local (2026-09-24) necesitaba demostrar con Dexie real que un pago
// registrado por Cobrador o Supervisor aparece en el Dashboard del Admin. Se movió
// aquí SIN cambiar la semántica de ninguna cifra.
//
// REGLAS QUE SE CONSERVAN (y que la auditoría verificó):
//  · Todo se recorta por las RUTAS AUTORIZADAS del usuario ANTES de sumar.
//  · El recaudo se agrega por `routeId`, NUNCA por `collectorId`: un cobro del
//    Supervisor cuenta para la ruta exactamente igual que uno del Cobrador. Quién
//    responde por el efectivo es otra pregunta (caja personal / cuadre).
//  · Los pagos se suman en bruto. Es EQUIVALENTE a `effectivePayments()`: una
//    corrección deja original (+X) y reversión (−X) con la MISMA fecha, que se
//    netean; el pago corregido (+Y) es el único que queda. Probado en LOCAL-SYNC.
// ============================================================
import { format, subDays } from 'date-fns'
import { es } from 'date-fns/locale'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { filterAccessibleRoutes } from '@/lib/permissions'
import { getWeekEnd, getWeekStart } from '@/lib/formatters'
import type { User } from '@/models/types'

export interface DashboardData {
  baseActualTotal: number
  carteraEnCalle: number
  totalControlado: number
  recaudoHoy: number
  recaudoSemana: number
  ventasActivas: number
  clientesActivos: number
  gastosSemana: number
  pagosPendientesSync: number
  rutasConMora: number
  topRoutes: { nombre: string; cobrado: number }[]
  recaudoDiario: { dia: string; valor: number }[]
  alertas: { tipo: string; mensaje: string; severity: 'warning' | 'error' | 'info' }[]
}

/**
 * KPIs del Dashboard de empresa para `user`. `now` solo existe para poder fijar el
 * reloj en las pruebas; en producción es el instante actual.
 */
export async function getAdminDashboardData(
  params: { user: User | null | undefined; tenantId: string; now?: Date },
): Promise<DashboardData> {
  const { user, tenantId } = params
  const now = params.now ?? new Date()
  const todayStr = format(now, 'yyyy-MM-dd')
  const weekStart = getWeekStart(now)
  const weekEnd = getWeekEnd(now)

  // RESTRICCIÓN POR RUTAS: el alcance limita TODAS las agregaciones ANTES de sumar.
  const routes = filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(tenantId).toArray())
  const scope = new Set(routes.map(r => r.id))

  // Sales (solo de rutas autorizadas)
  const allSales = (await db.sales.where('tenantId').equals(tenantId).toArray()).filter(s => scope.has(s.routeId))
  const ventasActivas = allSales.filter(s => s.status === 'activa')

  // Base actual vs Cartera en calle (consolidado). Mismo helper por ruta que el
  // resto de pantallas para no tener cálculos distintos por vista.
  let baseActualTotal = 0
  let carteraEnCalle = 0
  for (const r of routes) {
    const s = await getRouteFinancialSummary(r.id)
    baseActualTotal += s.baseActual
    carteraEnCalle += s.carteraEnCalle
  }
  const totalControlado = baseActualTotal + carteraEnCalle

  // Payments (solo de rutas autorizadas). Por RUTA, sin mirar el responsable.
  const allPayments = (await db.payments.where('tenantId').equals(tenantId).toArray()).filter(p => scope.has(p.routeId))
  const recaudoHoy = allPayments
    .filter(p => p.fecha === todayStr)
    .reduce((s, p) => s + p.valor, 0)
  const recaudoSemana = allPayments
    .filter(p => p.fecha >= weekStart && p.fecha <= weekEnd)
    .reduce((s, p) => s + p.valor, 0)

  // Clients (solo de rutas autorizadas)
  const allClients = (await db.clients.where('tenantId').equals(tenantId).toArray()).filter(c => scope.has(c.routeId))
  const clientesActivos = allClients.filter(c => c.status === 'activo').length

  // Expenses (solo de rutas autorizadas)
  const allExpenses = (await db.expenses.where('tenantId').equals(tenantId).toArray()).filter(e => scope.has(e.routeId))
  const gastosSemana = allExpenses
    .filter(e => e.fecha >= weekStart && e.fecha <= weekEnd)
    .reduce((s, e) => s + e.valor, 0)

  // Pending sync (de los pagos en alcance)
  const pagosPendientesSync = allPayments.filter(p => p.syncStatus === 'pending').length

  // Rutas con mora
  const installments = await db.installments.toArray()
  const rutasConMoraSet = new Set<string>()
  const salesMap = new Map(allSales.map(s => [s.id, s]))
  for (const inst of installments) {
    if (inst.status === 'vencida' && inst.diasMora > 0) {
      const sale = salesMap.get(inst.saleId)
      if (sale) rutasConMoraSet.add(sale.routeId)
    }
  }

  // Top routes
  const routePayments: Record<string, number> = {}
  for (const p of allPayments.filter(p => p.fecha >= weekStart && p.fecha <= weekEnd)) {
    routePayments[p.routeId] = (routePayments[p.routeId] ?? 0) + p.valor
  }
  const routeMap = new Map(routes.map(r => [r.id, r]))
  const topRoutes = Object.entries(routePayments)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, cobrado]) => ({ nombre: routeMap.get(id)?.nombre ?? id, cobrado }))

  // Recaudo diario 7 días
  const recaudoDiario = Array.from({ length: 7 }, (_, i) => {
    const date = format(subDays(now, 6 - i), 'yyyy-MM-dd')
    const label = format(subDays(now, 6 - i), 'EEE', { locale: es })
    const valor = allPayments
      .filter(p => p.fecha === date)
      .reduce((s, p) => s + p.valor, 0)
    return { dia: label, valor }
  })

  // Alertas
  const alertas: DashboardData['alertas'] = []
  if (pagosPendientesSync > 0) {
    alertas.push({ tipo: 'sync', mensaje: `${pagosPendientesSync} pagos pendientes de sincronizar`, severity: 'warning' })
  }
  // Ruta sin Cobrador = estado VÁLIDO (pendiente de asignación), no un error:
  // la ruta existe, simplemente no tiene operación de cobro todavía.
  const rutasSinCobrador = routes.filter(r => !r.cobradorId && r.status === 'activa')
  if (rutasSinCobrador.length > 0) {
    alertas.push({ tipo: 'ruta', mensaje: `${rutasSinCobrador.length} ruta(s) sin Cobrador asignado: sin operación de cobro hasta asignarlo`, severity: 'warning' })
  }
  if (rutasConMoraSet.size > 0) {
    alertas.push({ tipo: 'mora', mensaje: `${rutasConMoraSet.size} ruta(s) tienen clientes en mora`, severity: 'warning' })
  }

  return {
    baseActualTotal,
    carteraEnCalle,
    totalControlado,
    recaudoHoy,
    recaudoSemana,
    ventasActivas: ventasActivas.length,
    clientesActivos,
    gastosSemana,
    pagosPendientesSync,
    rutasConMora: rutasConMoraSet.size,
    topRoutes,
    recaudoDiario,
    alertas,
  }
}
