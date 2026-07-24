import { useState, useEffect } from 'react'
import { Download, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useTenant } from '@/hooks/useTenant'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { getCashboxSummary } from '@/services/cashboxEngine'
import { formatCurrency } from '@/lib/formatters'
import { toast } from '@/components/ui/Toast'
import type { CashboxSummary } from '@/models/types'

/**
 * Reportes del SOCIO: consolidado de caja por ruta autorizada, con exportación CSV.
 * Solo lectura; el socio genera y exporta reportes de SUS rutas.
 */
export default function SocioReportsPage() {
  const { routes } = useAccessibleRoutes()
  const { currency } = useTenant()
  const [rows, setRows] = useState<Array<{ nombre: string; s: CashboxSummary }>>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    if (routes.length === 0) { setRows([]); return }
    setLoading(true)
    Promise.all(routes.map(async r => ({ nombre: r.nombre, s: await getCashboxSummary(r.id) }))).then(list => {
      if (alive) { setRows(list); setLoading(false) }
    })
    return () => { alive = false }
  }, [routes])

  function exportCsv() {
    if (rows.length === 0) return
    const headers = ['Ruta', 'Saldo anterior', 'Ingreso capital', 'Cobros', 'Prestamos', 'Gastos', 'Transf. entradas', 'Transf. salidas', 'Retiros', 'Saldo actual']
    const lines = rows.map(({ nombre, s }) => [nombre, s.saldoAnterior, s.ingresoCapital, s.cobros, s.prestamosEntregados, s.gastos, s.transferenciasEntradas, s.transferenciasSalidas, s.retiros, s.saldoActual].join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reporte-caja-socio.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Reporte exportado')
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reportes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Consolidado de caja de tus rutas autorizadas</p>
        </div>
        <Button onClick={exportCsv} disabled={rows.length === 0} icon={<Download className="w-4 h-4" />}>Exportar CSV</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<BarChart3 className="w-8 h-8" />} title="Sin datos" description="No hay rutas autorizadas para reportar." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-3">Ruta</th>
                <th className="text-right px-4 py-3">Cobros</th>
                <th className="text-right px-4 py-3">Préstamos</th>
                <th className="text-right px-4 py-3">Gastos</th>
                <th className="text-right px-4 py-3">Saldo actual</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map(({ nombre, s }) => (
                <tr key={nombre}>
                  <td className="px-4 py-3 font-medium text-gray-800">{nombre}</td>
                  <td className="px-4 py-3 text-right text-emerald-600">{formatCurrency(s.cobros, currency)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(s.prestamosEntregados, currency)}</td>
                  <td className="px-4 py-3 text-right text-red-500">{formatCurrency(s.gastos, currency)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-primary-700">{formatCurrency(s.saldoActual, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
