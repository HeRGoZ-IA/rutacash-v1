// ============================================================
// VISIÓN EJECUTIVA DE OFICINAS (PURO, sin DB) — testeable.
// ------------------------------------------------------------
// Construye el comparativo entre Oficinas y el resumen de empresa a partir de los
// hechos operativos que ya calcula `officeOperations`.
//
// REGLA: cada fila se arma SOLO con las rutas accesibles de esa Oficina. Nunca se
// compara información que el usuario no puede ver, y cuando su alcance es parcial
// la fila lo declara ("2/4 rutas") en vez de aparentar el total de la Oficina.
//
// "Sin Oficina" aparece como una fila más cuando el usuario tiene rutas sueltas:
// es una agrupación derivada, no un registro.
// ============================================================
import type { Office, Route } from '@/models/types'
import { NO_OFFICE, NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import { officeOpsTotals, type OfficeOpsTotals, type RouteOpsFacts } from '@/lib/officeOperations'

export interface OfficeComparisonRow {
  /** Id de la Oficina, o `NO_OFFICE` para el grupo derivado. */
  officeId: string
  nombre: string
  codigo?: string
  status: Office['status'] | null
  /** Rutas de esta Oficina que el usuario VE. */
  rutasVisibles: number
  /** Rutas que la Oficina tiene en la empresa (conteo estructural). */
  rutasTotales: number
  /** true si el usuario no ve todas: la fila no representa el total de la Oficina. */
  parcial: boolean
  /** "2/4 rutas" cuando es parcial; "3 rutas" cuando es completo. */
  alcance: string
  totals: OfficeOpsTotals
  alertas: number
}

/**
 * Comparativo entre Oficinas.
 *
 * `facts` son los hechos operativos de las rutas ACCESIBLES (uno por ruta), y
 * `allRoutes` sirve únicamente para el conteo estructural que permite detectar el
 * alcance parcial. Ese conteo es un número: no expone datos de rutas ajenas.
 */
export function officeComparison(params: {
  facts: RouteOpsFacts[]
  accessibleRoutes: Pick<Route, 'id' | 'officeId'>[]
  allRoutes: Pick<Route, 'id' | 'officeId'>[]
  offices: Office[]
  alertCountByOffice?: Record<string, number>
}): OfficeComparisonRow[] {
  const officeOf = new Map(params.accessibleRoutes.map(r => [r.id, r.officeId]))
  const factsByOffice = new Map<string, RouteOpsFacts[]>()

  for (const f of params.facts) {
    const clave = officeOf.get(f.routeId) || NO_OFFICE
    const lista = factsByOffice.get(clave) ?? []
    lista.push(f)
    factsByOffice.set(clave, lista)
  }

  const totalesEnEmpresa = (officeId: string) => officeId === NO_OFFICE
    ? params.allRoutes.filter(r => !r.officeId).length
    : params.allRoutes.filter(r => r.officeId === officeId).length

  const filas: OfficeComparisonRow[] = []
  for (const [officeId, lista] of factsByOffice) {
    const office = params.offices.find(o => o.id === officeId)
    const visibles = lista.length
    const totales = totalesEnEmpresa(officeId)
    const parcial = totales > visibles
    filas.push({
      officeId,
      nombre: officeId === NO_OFFICE ? NO_OFFICE_LABEL : (office?.nombre ?? officeId),
      codigo: office?.codigo,
      status: office?.status ?? null,
      rutasVisibles: visibles,
      rutasTotales: totales,
      parcial,
      alcance: parcial ? `${visibles}/${totales} rutas` : `${visibles} ruta(s)`,
      totals: officeOpsTotals(lista),
      alertas: params.alertCountByOffice?.[officeId] ?? 0,
    })
  }

  // Alfabético, con "Sin Oficina" siempre al final.
  return filas.sort((a, b) => {
    if (a.officeId === NO_OFFICE) return 1
    if (b.officeId === NO_OFFICE) return -1
    return a.nombre.localeCompare(b.nombre)
  })
}

export interface CompanyOfficesSummary {
  /** Oficinas con alguna ruta visible para el usuario. */
  oficinasVisibles: number
  rutasVisibles: number
  rutasSinOficina: number
  totals: OfficeOpsTotals
  alertas: number
}

/**
 * Resumen de empresa. Es exactamente la suma de las filas del comparativo, para
 * que el total nunca contradiga el desglose que se muestra encima.
 */
export function companyOfficesSummary(filas: OfficeComparisonRow[]): CompanyOfficesSummary {
  const sinOficina = filas.find(f => f.officeId === NO_OFFICE)
  return {
    oficinasVisibles: filas.filter(f => f.officeId !== NO_OFFICE).length,
    rutasVisibles: filas.reduce((n, f) => n + f.rutasVisibles, 0),
    rutasSinOficina: sinOficina?.rutasVisibles ?? 0,
    totals: officeOpsTotals(filas.flatMap(f => comoFacts(f))),
    alertas: filas.reduce((n, f) => n + f.alertas, 0),
  }
}

/**
 * Reconvierte los totales de una fila en un "hecho" agregable, para que el resumen
 * de empresa se calcule con el MISMO agregador que las filas y no pueda divergir.
 */
function comoFacts(fila: OfficeComparisonRow): RouteOpsFacts[] {
  return [{ routeId: fila.officeId, nombre: fila.nombre, ...fila.totals }]
}

// ------------------------------------------------------------
// Exportación CSV (lo que el usuario VE, nada más)
// ------------------------------------------------------------
/** Texto del alcance para el CSV; deja explícito cuando es parcial. */
export function alcanceCsv(visibles: number, totales: number): string {
  return totales > visibles
    ? `${visibles} de ${totales} rutas autorizadas`
    : `${visibles} ruta(s) (alcance completo)`
}

/** Fila única con el resumen de la Oficina. */
export function officeSummaryCsvRows(params: {
  office: Pick<Office, 'nombre' | 'codigo' | 'status'>
  fecha: string
  visibles: number
  totales: number
  totals: OfficeOpsTotals
  alertas: number
}): Record<string, unknown>[] {
  return [{
    Oficina: params.office.nombre,
    Codigo: params.office.codigo ?? '',
    Estado: params.office.status === 'activa' ? 'Activa' : 'Inactiva',
    Fecha: params.fecha,
    Alcance: alcanceCsv(params.visibles, params.totales),
    'Rutas visibles': params.visibles,
    Clientes: params.totals.clientesActivos,
    'Ventas activas': params.totals.ventasActivas,
    Cartera: params.totals.carteraActiva,
    'Cartera vencida': params.totals.carteraVencida,
    'Clientes con atraso': params.totals.clientesConAtraso,
    'A cobrar hoy': params.totals.aCobrarHoy,
    'Recaudado hoy': params.totals.recaudadoHoy,
    'Pendiente hoy': params.totals.pendienteHoy,
    'Cumplimiento %': params.totals.cumplimiento,
    Gastos: params.totals.gastosHoy,
    'Desembolsos pendientes': params.totals.desembolsosPendientes,
    Alertas: params.alertas,
  }]
}

/** Una fila por ruta VISIBLE de la Oficina. */
export function officeRoutesCsvRows(params: {
  office: Pick<Office, 'nombre'>
  fecha: string
  facts: RouteOpsFacts[]
}): Record<string, unknown>[] {
  return params.facts.map(f => ({
    Oficina: params.office.nombre,
    Fecha: params.fecha,
    Ruta: f.nombre,
    Clientes: f.clientesActivos,
    'Ventas activas': f.ventasActivas,
    'Parcelas pendientes': f.parcelasPendientes,
    Cartera: f.carteraActiva,
    'Cartera vencida': f.carteraVencida,
    'Clientes con atraso': f.clientesConAtraso,
    'A cobrar hoy': f.aCobrarHoy,
    'Recaudado hoy': f.recaudadoHoy,
    'Pendiente hoy': f.pendienteHoy,
    'Cumplimiento %': f.cumplimiento,
    Gastos: f.gastosHoy,
    'Desembolsos pendientes': f.desembolsosPendientes,
  }))
}

// ------------------------------------------------------------
// Actividad reciente (derivada de la auditoría existente)
// ------------------------------------------------------------
/** Forma mínima de un registro de auditoría para la actividad de Oficina. */
export interface ActivityRowLike {
  id: string
  createdAt: string
  action: string
  descripcion: string
  routeId?: string
  userId: string
}

export interface OfficeActivityEntry extends ActivityRowLike {
  routeNombre?: string
  actorNombre?: string
}

/**
 * Actividad reciente de una Oficina.
 *
 * MISMO PRINCIPIO DE ALCANCE que todo lo demás: se parte de las rutas ACCESIBLES
 * de la Oficina y se filtran los registros por ellas. Nunca al revés. Un registro
 * de una ruta que el usuario no tiene autorizada no aparece, aunque pertenezca a
 * esta Oficina; y uno sin `routeId` (acción de empresa) tampoco se atribuye aquí.
 *
 * No se crea ninguna tabla nueva: se lee la auditoría que ya existe.
 */
export function officeActivity(params: {
  rows: ActivityRowLike[]
  /** Rutas accesibles DE ESTA OFICINA. */
  officeRouteIds: string[]
  routeNameById?: Map<string, string>
  userNameById?: Map<string, string>
  limit?: number
}): OfficeActivityEntry[] {
  const permitidas = new Set(params.officeRouteIds)
  return params.rows
    .filter(r => !!r.routeId && permitidas.has(r.routeId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, params.limit ?? 15)
    .map(r => ({
      ...r,
      routeNombre: r.routeId ? params.routeNameById?.get(r.routeId) : undefined,
      actorNombre: params.userNameById?.get(r.userId),
    }))
}
