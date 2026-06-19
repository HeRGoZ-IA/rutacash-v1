import { useState } from 'react'
import { BarChart3, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate, today, getWeekStart, getWeekEnd } from '@/lib/formatters'
import { downloadCSV } from '@/lib/utils'

type ReportType = 'pagos' | 'ventas' | 'gastos' | 'caja_diaria'

export default function ReportsPage() {
  const { tenantId } = useTenant()
  const [reportType, setReportType] = useState<ReportType>('pagos')
  const [fechaDesde, setFechaDesde] = useState(getWeekStart())
  const [fechaHasta, setFechaHasta] = useState(today())
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])

  async function generateReport() {
    setLoading(true)
    try {
      let data: Record<string, unknown>[] = []

      if (reportType === 'pagos') {
        const payments = await db.payments.where('tenantId').equals(tenantId).toArray()
        const filtered = payments.filter(p => p.fecha >= fechaDesde && p.fecha <= fechaHasta)
        const clients = await db.clients.where('tenantId').equals(tenantId).toArray()
        const routes = await db.routes.where('tenantId').equals(tenantId).toArray()
        const clientMap = new Map(clients.map(c => [c.id, c]))
        const routeMap = new Map(routes.map(r => [r.id, r]))
        data = filtered.map(p => ({
          Fecha: formatDate(p.fecha),
          Cliente: clientMap.get(p.clientId)?.nombre ?? p.clientId,
          Ruta: routeMap.get(p.routeId)?.nombre ?? p.routeId,
          Valor: p.valor,
          Tipo: p.tipo,
          Observación: p.observacion ?? '',
          Sync: p.syncStatus,
        }))
      }

      if (reportType === 'ventas') {
        const sales = await db.sales.where('tenantId').equals(tenantId).toArray()
        const filtered = sales.filter(s => s.createdAt.slice(0, 10) >= fechaDesde && s.createdAt.slice(0, 10) <= fechaHasta)
        const clients = await db.clients.where('tenantId').equals(tenantId).toArray()
        const routes = await db.routes.where('tenantId').equals(tenantId).toArray()
        const clientMap = new Map(clients.map(c => [c.id, c]))
        const routeMap = new Map(routes.map(r => [r.id, r]))
        data = filtered.map(s => ({
          Fecha: formatDate(s.createdAt),
          Cliente: clientMap.get(s.clientId)?.nombre ?? s.clientId,
          Ruta: routeMap.get(s.routeId)?.nombre ?? s.routeId,
          'Valor venta': s.valorVenta,
          'Total+interés': s.valorTotal,
          Saldo: s.saldo,
          Estado: s.status,
          Cuotas: s.numeroCuotas,
          Frecuencia: s.frecuenciaPago,
          'Fecha inicio': formatDate(s.fechaInicio),
          'Fecha fin estimada': formatDate(s.fechaFinalEstimada),
        }))
      }

      if (reportType === 'gastos') {
        const expenses = await db.expenses.where('tenantId').equals(tenantId).toArray()
        const filtered = expenses.filter(e => e.fecha >= fechaDesde && e.fecha <= fechaHasta)
        const cats = await db.expenseCategories.where('tenantId').equals(tenantId).toArray()
        const routes = await db.routes.where('tenantId').equals(tenantId).toArray()
        const catMap = new Map(cats.map(c => [c.id, c]))
        const routeMap = new Map(routes.map(r => [r.id, r]))
        data = filtered.map(e => ({
          Fecha: formatDate(e.fecha),
          Ruta: routeMap.get(e.routeId)?.nombre ?? e.routeId,
          Categoría: catMap.get(e.categoryId)?.nombre ?? e.categoryId,
          Valor: e.valor,
          Descripción: e.descripcion ?? '',
        }))
      }

      if (reportType === 'caja_diaria') {
        const payments = await db.payments.where('tenantId').equals(tenantId).toArray()
        const expenses = await db.expenses.where('tenantId').equals(tenantId).toArray()
        const routes = await db.routes.where('tenantId').equals(tenantId).toArray()
        const routeMap = new Map(routes.map(r => [r.id, r]))

        const byDate: Record<string, Record<string, number>> = {}
        for (const p of payments.filter(p => p.fecha >= fechaDesde && p.fecha <= fechaHasta)) {
          const key = `${p.fecha}|${p.routeId}`
          if (!byDate[key]) byDate[key] = { cobros: 0, gastos: 0 }
          byDate[key].cobros += p.valor
        }
        for (const e of expenses.filter(e => e.fecha >= fechaDesde && e.fecha <= fechaHasta)) {
          const key = `${e.fecha}|${e.routeId}`
          if (!byDate[key]) byDate[key] = { cobros: 0, gastos: 0 }
          byDate[key].gastos += e.valor
        }
        data = Object.entries(byDate).map(([key, v]) => {
          const [fecha, routeId] = key.split('|')
          return {
            Fecha: formatDate(fecha),
            Ruta: routeMap.get(routeId)?.nombre ?? routeId,
            Cobros: v.cobros,
            Gastos: v.gastos,
            Neto: v.cobros - v.gastos,
          }
        }).sort((a, b) => String(a.Fecha).localeCompare(String(b.Fecha)))
      }

      setRows(data)
      if (data.length === 0) toast.info('No hay datos para el período seleccionado')
      else toast.success(`${data.length} registro(s) generados`)
    } catch { toast.error('Error al generar reporte') } finally { setLoading(false) }
  }

  function exportCSV() {
    if (!rows.length) { toast.warning('Genera el reporte primero'); return }
    downloadCSV(rows, `reporte_${reportType}_${fechaDesde}_${fechaHasta}.csv`)
    toast.success('CSV descargado')
  }

  const reportOptions = [
    { value: 'pagos', label: 'Pagos recibidos' },
    { value: 'ventas', label: 'Ventas / Créditos' },
    { value: 'gastos', label: 'Gastos' },
    { value: 'caja_diaria', label: 'Caja diaria por ruta' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Reportes</h1><p className="text-sm text-gray-500 mt-0.5">Genera y exporta reportes en CSV</p></div>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <Select label="Tipo de reporte" value={reportType} onChange={e => setReportType(e.target.value as ReportType)}
            options={reportOptions} className="w-56" />
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

        {loading ? (
          <LoadingState message="Generando reporte..." />
        ) : rows.length > 0 ? (
          <div className="overflow-x-auto">
            <p className="text-xs text-gray-500 mb-2">{rows.length} registro(s) encontrado(s)</p>
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
            <p className="text-sm">Configura el reporte y haz clic en Generar</p>
          </div>
        )}
      </div>
    </div>
  )
}
