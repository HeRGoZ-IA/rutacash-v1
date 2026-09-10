// ============================================================
// RUTACASH — GENERADORES DE REPORTES (PUROS, sin dependencias de Dexie ni UI)
// ------------------------------------------------------------
// La pantalla de Reportes SOLO lee de la base y pinta: toda la regla de filtrado
// (scoping por rutas + ruta elegida + rango de fechas + semántica de pagos) vive
// aquí, de modo que sea verificable sin renderizar React.
//
// ORDEN DE FILTRADO — INVARIANTE DEL MÓDULO (fail-closed):
//
//        rutas permitidas al usuario   (getAccessibleRouteIdSet)
//                  ↓
//        ruta seleccionada             (resolveReportRouteIds)
//                  ↓
//        rango de fechas
//                  ↓
//        cálculo / exportación
//
// Nunca al revés: `resolveReportRouteIds` INTERSECTA la selección con el alcance,
// así que un `routeId` manipulado o heredado de otra empresa produce un conjunto
// VACÍO (cero filas), jamás un acceso.
// ============================================================
import { effectivePayments } from '@/services/paymentCorrectionService'
import { formatDate } from '@/lib/formatters'
import type {
  Client, Expense, ExpenseCategory, Payment, Route, Sale,
} from '@/models/types'

export type ReportType = 'pagos' | 'ventas' | 'gastos' | 'caja_diaria'

export const REPORT_OPTIONS: { value: ReportType; label: string }[] = [
  { value: 'pagos', label: 'Pagos recibidos' },
  { value: 'ventas', label: 'Ventas / Créditos' },
  { value: 'gastos', label: 'Gastos' },
  { value: 'caja_diaria', label: 'Caja diaria por ruta' },
]

/** Valor de "Todas las rutas" en el selector (= todas las PERMITIDAS al usuario). */
export const ALL_ACCESSIBLE_ROUTES = ''

/**
 * Rutas efectivas de un reporte: intersección entre lo que el usuario tiene
 * permitido y lo que eligió en el selector.
 *
 *  - selección vacía ('')            → todas las rutas permitidas.
 *  - selección dentro del alcance    → solo esa ruta.
 *  - selección FUERA del alcance     → conjunto vacío (fail-closed, sin datos).
 */
export function resolveReportRouteIds(accessible: Set<string> | string[], selected: string): Set<string> {
  const allowed = accessible instanceof Set ? accessible : new Set(accessible)
  if (!selected) return new Set(allowed)
  return allowed.has(selected) ? new Set([selected]) : new Set<string>()
}

export interface ReportFilters {
  /** Rutas efectivas ya resueltas por `resolveReportRouteIds`. */
  routeIds: Set<string>
  fechaDesde: string
  fechaHasta: string
}

/** Datos crudos de la empresa; el servicio se encarga de recortarlos. */
export interface ReportSources {
  payments: Payment[]
  sales: Sale[]
  expenses: Expense[]
  clients: Client[]
  routes: Route[]
  categories: ExpenseCategory[]
}

export type ReportRow = Record<string, unknown>

const inRange = (fecha: string, f: ReportFilters) => fecha >= f.fechaDesde && fecha <= f.fechaHasta

/** Recorta cualquier registro con `routeId` al conjunto de rutas efectivas. */
function scopeRows<T extends { routeId: string }>(rows: T[], routeIds: Set<string>): T[] {
  return rows.filter(r => routeIds.has(r.routeId))
}

function nameMaps(src: ReportSources) {
  return {
    clientName: (id: string) => src.clients.find(c => c.id === id)?.nombre ?? id,
    routeName: (id: string) => src.routes.find(r => r.id === id)?.nombre ?? id,
    catName: (id: string) => src.categories.find(c => c.id === id)?.nombre ?? id,
  }
}

// ------------------------------------------------------------
// PAGOS RECIBIDOS
// ------------------------------------------------------------
/**
 * Solo movimientos VIGENTES. Se aplica `effectivePayments` (misma definición
 * canónica que usan la conciliación y la corrección controlada): un pago
 * corregido dejaba de aparecer como TRES filas (original + asiento de reversión
 * negativo + pago corregido) y ahora aparece únicamente como el pago vigente.
 * El total no cambia —original y reversión ya se neteaban—, pero el listado y el
 * CSV dejan de mostrar movimientos anulados como si estuvieran vivos.
 */
export function buildPagosReport(src: ReportSources, f: ReportFilters): ReportRow[] {
  const { clientName, routeName } = nameMaps(src)
  return effectivePayments(scopeRows(src.payments, f.routeIds))
    .filter(p => inRange(p.fecha, f))
    .map(p => ({
      Fecha: formatDate(p.fecha),
      Cliente: clientName(p.clientId),
      Ruta: routeName(p.routeId),
      Valor: p.valor,
      Tipo: p.tipo,
      Observación: p.observacion ?? '',
      Sync: p.syncStatus,
    }))
}

// ------------------------------------------------------------
// VENTAS / CRÉDITOS
// ------------------------------------------------------------
/**
 * NOTA DE SEMÁNTICA (documentada, no modificada): este reporte filtra por
 * `createdAt` (cuándo se registró la venta), mientras que el motor de caja usa
 * `fechaInicio` (fecha contable de arranque del crédito) para "préstamos
 * entregados". Una misma venta puede caer en semanas distintas según el módulo.
 * Se conserva el comportamiento histórico a propósito; unificarlo es una decisión
 * funcional pendiente.
 */
export function buildVentasReport(src: ReportSources, f: ReportFilters): ReportRow[] {
  const { clientName, routeName } = nameMaps(src)
  return scopeRows(src.sales, f.routeIds)
    .filter(s => inRange(s.createdAt.slice(0, 10), f))
    .map(s => ({
      Fecha: formatDate(s.createdAt),
      Cliente: clientName(s.clientId),
      Ruta: routeName(s.routeId),
      'Valor venta': s.valorVenta,
      'Total+interés': s.valorTotal,
      Saldo: s.saldo,
      Estado: s.status,
      Cuotas: s.numeroCuotas,
      Frecuencia: s.frecuenciaPago,
      'Fecha inicio': formatDate(s.fechaInicio),
      'Fecha fin estimada': formatDate(s.fechaFinalEstimada),
      // Fecha REAL de finalización: solo existe si el crédito se saldó. "—" cuando
      // no aplica o no se pudo determinar. Nunca se sustituye por la estimada.
      'Fecha finalización real': s.fechaFinalizacion ? formatDate(s.fechaFinalizacion) : '—',
    }))
}

// ------------------------------------------------------------
// GASTOS
// ------------------------------------------------------------
export function buildGastosReport(src: ReportSources, f: ReportFilters): ReportRow[] {
  const { routeName, catName } = nameMaps(src)
  return scopeRows(src.expenses, f.routeIds)
    .filter(e => inRange(e.fecha, f))
    .map(e => ({
      Fecha: formatDate(e.fecha),
      Ruta: routeName(e.routeId),
      Categoría: catName(e.categoryId),
      Valor: e.valor,
      Descripción: e.descripcion ?? '',
    }))
}

// ------------------------------------------------------------
// CAJA DIARIA POR RUTA
// ------------------------------------------------------------
export function buildCajaDiariaReport(src: ReportSources, f: ReportFilters): ReportRow[] {
  const { routeName } = nameMaps(src)
  const byDate: Record<string, { cobros: number; gastos: number }> = {}

  for (const p of effectivePayments(scopeRows(src.payments, f.routeIds)).filter(p => inRange(p.fecha, f))) {
    const key = `${p.fecha}|${p.routeId}`
    if (!byDate[key]) byDate[key] = { cobros: 0, gastos: 0 }
    byDate[key].cobros += p.valor
  }
  for (const e of scopeRows(src.expenses, f.routeIds).filter(e => inRange(e.fecha, f))) {
    const key = `${e.fecha}|${e.routeId}`
    if (!byDate[key]) byDate[key] = { cobros: 0, gastos: 0 }
    byDate[key].gastos += e.valor
  }

  return Object.entries(byDate)
    .map(([key, v]) => {
      const [fecha, routeId] = key.split('|')
      return {
        Fecha: formatDate(fecha),
        Ruta: routeName(routeId),
        Cobros: v.cobros,
        Gastos: v.gastos,
        Neto: v.cobros - v.gastos,
      }
    })
    .sort((a, b) => String(a.Fecha).localeCompare(String(b.Fecha)))
}

// ------------------------------------------------------------
// Punto único de entrada
// ------------------------------------------------------------
export function buildReport(type: ReportType, src: ReportSources, f: ReportFilters): ReportRow[] {
  switch (type) {
    case 'pagos': return buildPagosReport(src, f)
    case 'ventas': return buildVentasReport(src, f)
    case 'gastos': return buildGastosReport(src, f)
    case 'caja_diaria': return buildCajaDiariaReport(src, f)
    default: return []
  }
}
