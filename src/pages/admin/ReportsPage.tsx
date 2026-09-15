import { useState, useEffect } from 'react'
import { BarChart3, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/EmptyState'
import { RouteSelector, ALL_ROUTES, routeFileTag } from '@/components/ui/RouteSelector'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { useAccessibleOffices } from '@/hooks/useAccessibleOffices'
import { OfficeSelector, officeFileTag } from '@/components/ui/OfficeSelector'
import { ALL_OFFICES, NO_OFFICE, filterRoutesByOffice, narrowRouteIdsByOffice, officeNameByRouteId, officeCoverage, officeScopeLabel } from '@/lib/officeGrouping'
import { getAccessibleRouteIdSet } from '@/lib/scope'
import {
  buildReport, resolveReportRouteIds, REPORT_OPTIONS,
  type ReportType, type ReportRow,
} from '@/services/reportService'
import { formatCurrency, today, getWeekStart } from '@/lib/formatters'
import { downloadCSV } from '@/lib/utils'

export default function ReportsPage() {
  const { tenantId } = useTenant()
  const { user } = useAuth()
  // Rutas ACCESIBLES por el usuario (scoping central). El Administrador solo ve
  // sus rutas autorizadas; el Super Admin, todas las de la empresa seleccionada.
  const { routes } = useAccessibleRoutes()
  // Oficinas DERIVADAS de las rutas accesibles: ver una Oficina no concede ninguna ruta.
  const { offices, hasUnassigned } = useAccessibleOffices()
  // '' = "Todas las oficinas" → todas las OFICINAS PERMITIDAS, nunca más.
  const [officeId, setOfficeId] = useState<string>(ALL_OFFICES)
  const [reportType, setReportType] = useState<ReportType>('pagos')
  // '' = "Todas las rutas" → significa TODAS LAS PERMITIDAS, nunca todas las del sistema.
  const [routeId, setRouteId] = useState<string>(ALL_ROUTES)
  const [fechaDesde, setFechaDesde] = useState(getWeekStart())
  const [fechaHasta, setFechaHasta] = useState(today())
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<ReportRow[]>([])
  /** Ruta con la que se generó el listado actual (para el CSV y el encabezado). */
  const [generatedRouteId, setGeneratedRouteId] = useState<string>(ALL_ROUTES)
  /** Oficina con la que se generó el listado actual (para el CSV). */
  const [generatedOfficeId, setGeneratedOfficeId] = useState<string>(ALL_OFFICES)

  // Rutas ofrecidas en el selector: las accesibles, recortadas por la Oficina elegida.
  const routesInOffice = filterRoutesByOffice(routes, officeId)
  // Total de rutas que la Oficina tiene en la EMPRESA (no las accesibles): sirve
  // únicamente para advertir de que el consolidado mostrado es parcial.
  const [routeCountByOffice, setRouteCountByOffice] = useState<Record<string, number>>({})
  const allRoutesOfOffice = (id: string) => routeCountByOffice[id] ?? 0

  useEffect(() => {
    if (!tenantId) return
    db.routes.where('tenantId').equals(tenantId).toArray().then(all => {
      const conteo: Record<string, number> = {}
      for (const r of all) if (r.officeId) conteo[r.officeId] = (conteo[r.officeId] ?? 0) + 1
      setRouteCountByOffice(conteo)
    })
  }, [tenantId])

  /** Al cambiar de Oficina, una ruta que quede fuera del filtro se descarta. */
  function changeOffice(next: string) {
    setOfficeId(next)
    if (routeId !== ALL_ROUTES && !filterRoutesByOffice(routes, next).some(r => r.id === routeId)) {
      setRouteId(ALL_ROUTES)
    }
  }

  async function generateReport() {
    setLoading(true)
    try {
      // 1) RESTRICCIÓN POR RUTAS (fail-closed): alcance real del usuario.
      const scope = await getAccessibleRouteIdSet(user, tenantId)
      // 2) RUTA SELECCIONADA: se INTERSECTA con el alcance. Una ruta fuera del
      //    alcance produce un conjunto vacío, nunca un acceso.
      // 2.a) OFICINA: estrecha el alcance ANTES de resolver la ruta. Nunca lo amplía:
      //      se parte de `scope` (rutas autorizadas) y se filtra dentro de él.
      const scopeEnOficina = narrowRouteIdsByOffice(scope, routes, officeId)
      // 2.b) RUTA SELECCIONADA: se INTERSECTA con el alcance ya recortado. Una ruta
      //      fuera del alcance produce un conjunto vacío, nunca un acceso.
      const routeIds = resolveReportRouteIds(scopeEnOficina, routeId)

      if (routeId && routeIds.size === 0) {
        toast.error('No tienes acceso a la ruta seleccionada.')
        setRows([])
        return
      }

      // 3) Datos de la empresa; el servicio aplica rutas efectivas y rango de fechas.
      const [payments, sales, expenses, clients, allRoutes, categories] = await Promise.all([
        db.payments.where('tenantId').equals(tenantId).toArray(),
        db.sales.where('tenantId').equals(tenantId).toArray(),
        db.expenses.where('tenantId').equals(tenantId).toArray(),
        db.clients.where('tenantId').equals(tenantId).toArray(),
        db.routes.where('tenantId').equals(tenantId).toArray(),
        db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      ])

      const data = buildReport(
        reportType,
        { payments, sales, expenses, clients, routes: allRoutes, categories },
        { routeIds, fechaDesde, fechaHasta },
      )

      setRows(data)
      setGeneratedRouteId(routeId)
      setGeneratedOfficeId(officeId)
      if (data.length === 0) toast.info('No hay datos para el período y la ruta seleccionados')
      else toast.success(`${data.length} registro(s) generados`)
    } catch { toast.error('Error al generar reporte') } finally { setLoading(false) }
  }

  function exportCSV() {
    if (!rows.length) { toast.warning('Genera el reporte primero'); return }
    // El CSV se construye desde `rows`, que YA está filtrado por ruta y fechas:
    // no puede contener registros de una ruta distinta a la generada.
    const tag = routeFileTag(routes, generatedRouteId)
    const officeTag = generatedOfficeId === ALL_OFFICES ? '' : `${officeFileTag(offices, generatedOfficeId)}_`
    downloadCSV(rowsConOficina, `reporte_${reportType}_${officeTag}${tag}_${fechaDesde}_${fechaHasta}.csv`)
    toast.success('CSV descargado')
  }

  /**
   * Columna "Oficina" añadida a cada fila. Se DERIVA de la ruta de la fila
   * (`routeId → Route.officeId`): ninguna venta, pago o gasto guarda la Oficina, de
   * modo que mover una ruta de Oficina reagrupa el reporte sin reescribir historia.
   * Las filas sin `routeId` (agregados) se dejan intactas.
   */
  const officeByRoute = officeNameByRouteId(routes, offices)
  const rowsConOficina = rows.map(r => {
    const rid = typeof r.routeId === 'string' ? r.routeId : undefined
    return rid ? { ...r, Oficina: officeByRoute.get(rid) ?? '' } : r
  })

  const alcance = generatedRouteId
    ? routes.find(r => r.id === generatedRouteId)?.nombre ?? generatedRouteId
    : 'Todas tus rutas'

  /**
   * Rótulo honesto del alcance por Oficina. Si el usuario solo ve parte de las rutas
   * de la Oficina elegida, el texto lo dice: un consolidado parcial NUNCA debe
   * parecer el total de la Oficina.
   */
  const alcanceOficina = (() => {
    if (generatedOfficeId === ALL_OFFICES) return null
    if (generatedOfficeId === NO_OFFICE) return 'Rutas sin oficina'
    const office = offices.find(o => o.id === generatedOfficeId)
    if (!office) return null
    const visibles = routes.filter(r => r.officeId === office.id).length
    const totales = allRoutesOfOffice(office.id)
    return officeScopeLabel(office.nombre, officeCoverage(visibles, totales))
  })()

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Reportes</h1><p className="text-sm text-gray-500 mt-0.5">Genera y exporta reportes en CSV</p></div>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <Select label="Tipo de reporte" value={reportType} onChange={e => setReportType(e.target.value as ReportType)}
            options={REPORT_OPTIONS} className="w-56" />
          {/* OFICINA: filtro PREVIO. Solo estrecha las rutas ya autorizadas. */}
          <OfficeSelector offices={offices} value={officeId} onChange={changeOffice}
            includeUnassigned={hasUnassigned} className="w-56" />
          {/* "Todas las rutas" = todas las AUTORIZADAS dentro del filtro de Oficina. */}
          <RouteSelector routes={routesInOffice} value={routeId} onChange={setRouteId} allowAll className="w-56" />
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Desde</label>
            <input type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
              className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Hasta</label>
            <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
              className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
          <Button onClick={generateReport} loading={loading} icon={<BarChart3 className="w-4 h-4" />}>Generar</Button>
          {rows.length > 0 && (
            <Button variant="secondary" onClick={exportCSV} icon={<Download className="w-4 h-4" />}>Exportar CSV</Button>
          )}
        </div>

        {routes.length === 0 && (
          <p className="text-xs text-amber-600">No tienes rutas autorizadas: no hay datos que reportar.</p>
        )}

        {loading ? (
          <LoadingState message="Generando reporte..." />
        ) : rows.length > 0 ? (
          <div className="overflow-x-auto">
            <p className="text-xs text-gray-500 mb-2">
              {rows.length} registro(s) · Ruta: <span className="font-medium text-gray-700">{alcance}</span>
              {alcanceOficina && <> · Oficina: <span className="font-medium text-gray-700">{alcanceOficina}</span></>}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {Object.keys(rows[0]).map(h => (
                    <th key={h} className="text-left text-xs font-semibold text-gray-500 px-3 py-2 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.slice(0, 100).map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {Object.values(row).map((val, j) => (
                      <td key={j} className="px-3 py-2 text-gray-700 whitespace-nowrap">
                        {typeof val === 'number' && String(Object.keys(row)[j]).toLowerCase().includes('valor') || String(Object.keys(row)[j]).toLowerCase().includes('cobro') || String(Object.keys(row)[j]).toLowerCase().includes('gasto') || String(Object.keys(row)[j]).toLowerCase().includes('neto') || String(Object.keys(row)[j]).toLowerCase().includes('saldo')
                          ? formatCurrency(val as number)
                          : String(val)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 100 && <p className="text-xs text-gray-400 mt-2">Mostrando los primeros 100 de {rows.length}. Exporta CSV para ver todos.</p>}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400">
            <FileText className="w-10 h-10 mb-3" />
            <p className="text-sm">Elige el tipo de reporte, la ruta y el rango de fechas, luego haz clic en Generar</p>
          </div>
        )}
      </div>
    </div>
  )
}
