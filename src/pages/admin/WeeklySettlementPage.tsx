import { useState, useEffect } from 'react'
import { CalendarRange, Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { getAllRoutesWeeklySettlement } from '@/services/weeklySettlementEngine'
import { formatCurrency, formatDate, getWeekStart, getWeekEnd } from '@/lib/formatters'
import { downloadCSV } from '@/lib/utils'
import type { WeeklySettlement, Office, Route } from '@/models/types'

export default function WeeklySettlementPage() {
  const { tenantId, officeId } = useTenant()
  const [offices, setOffices] = useState<Office[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [selectedOffice, setSelectedOffice] = useState(officeId)
  const [semanaInicio, setSemanaInicio] = useState(getWeekStart())
  const [semanaFin, setSemanaFin] = useState(getWeekEnd())
  const [settlements, setSettlements] = useState<WeeklySettlement[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadMeta() }, [tenantId])

  async function loadMeta() {
    const [ofs, rts] = await Promise.all([
      db.offices.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setOffices(ofs)
    setRoutes(rts)
    if (!officeId && ofs.length > 0) setSelectedOffice(ofs[0].id)
  }

  async function generate() {
    if (!selectedOffice) { toast.error('Selecciona una oficina'); return }
    setLoading(true)
    try {
      const data = await getAllRoutesWeeklySettlement({ tenantId, officeId: selectedOffice, semanaInicio, semanaFin })
      setSettlements(data)
      toast.success(`Liquidación generada: ${data.length} ruta(s)`)
    } catch { toast.error('Error al generar liquidación') } finally { setLoading(false) }
  }

  function exportCSV() {
    if (!settlements.length) { toast.warning('Genera primero'); return }
    const routeMap = new Map(routes.map(r => [r.id, r]))
    const rows = settlements.map(s => ({
      Ruta: routeMap.get(s.routeId)?.nombre ?? s.routeId,
      'Semana inicio': formatDate(s.semanaInicio),
      'Semana fin': formatDate(s.semanaFin),
      'Saldo anterior': s.saldoAnterior,
      'Ingreso capital': s.ingresoCapital,
      Cobros: s.cobros,
      'Préstamos entregados': s.prestamosEntregados,
      Gastos: s.gastos,
      'Transferencias entrada': s.transferenciasEntradas,
      'Transferencias salida': s.transferenciasSalidas,
      Retiros: s.retiros,
      'Saldo final': s.saldoFinal,
    }))
    downloadCSV(rows, `liquidacion_${semanaInicio}_${semanaFin}.csv`)
    toast.success('CSV descargado')
  }

  const totalSaldo = settlements.reduce((s, l) => s + l.saldoFinal, 0)
  const totalCobros = settlements.reduce((s, l) => s + l.cobros, 0)
  const totalGastos = settlements.reduce((s, l) => s + l.gastos, 0)
  const routeMap = new Map(routes.map(r => [r.id, r]))

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Liquidación Semanal</h1><p className="text-sm text-gray-500 mt-0.5">Lunes a Sábado</p></div>
        <div className="flex gap-2">
          {settlements.length > 0 && <Button variant="secondary" onClick={exportCSV} icon={<Download className="w-4 h-4" />}>CSV</Button>}
          <Button onClick={generate} loading={loading} icon={<RefreshCw className="w-4 h-4" />}>Generar</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <Select value={selectedOffice} onChange={e => setSelectedOffice(e.target.value)}
          options={offices.map(o => ({ value: o.id, label: o.nombre }))} placeholder="Seleccionar oficina" className="w-56" />
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Inicio semana</label>
          <input type="date" value={semanaInicio} onChange={e => setSemanaInicio(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Fin semana</label>
          <input type="date" value={semanaFin} onChange={e => setSemanaFin(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      {loading ? (
        <LoadingState message="Calculando liquidación..." />
      ) : settlements.length > 0 ? (
        <div className="space-y-4">
          {/* Totals */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-primary-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Total cobros</p>
              <p className="text-xl font-bold text-primary-700 mt-1">{formatCurrency(totalCobros)}</p>
            </div>
            <div className="bg-red-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Total gastos</p>
              <p className="text-xl font-bold text-red-600 mt-1">{formatCurrency(totalGastos)}</p>
            </div>
            <div className="bg-emerald-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Saldo total</p>
              <p className="text-xl font-bold text-emerald-700 mt-1">{formatCurrency(totalSaldo)}</p>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Ruta</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Saldo ant.</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Capital</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Cobros</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Préstamos</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Gastos</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Trans.</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Retiros</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Saldo final</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {settlements.map(s => (
                    <tr key={s.id ?? s.routeId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{routeMap.get(s.routeId)?.nombre ?? s.routeId}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{formatCurrency(s.saldoAnterior)}</td>
                      <td className="px-4 py-3 text-right text-emerald-600">{formatCurrency(s.ingresoCapital)}</td>
                      <td className="px-4 py-3 text-right text-emerald-600 hidden md:table-cell">{formatCurrency(s.cobros)}</td>
                      <td className="px-4 py-3 text-right text-blue-600 hidden md:table-cell">{formatCurrency(s.prestamosEntregados)}</td>
                      <td className="px-4 py-3 text-right text-red-500 hidden lg:table-cell">{formatCurrency(s.gastos)}</td>
                      <td className="px-4 py-3 text-right text-gray-600 hidden lg:table-cell">{formatCurrency(s.transferenciasEntradas - s.transferenciasSalidas)}</td>
                      <td className="px-4 py-3 text-right text-amber-600 hidden lg:table-cell">{formatCurrency(s.retiros)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-bold ${s.saldoFinal >= 0 ? 'text-primary-700' : 'text-red-600'}`}>{formatCurrency(s.saldoFinal)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <CalendarRange className="w-10 h-10 mb-3" />
          <p className="text-sm">Selecciona una oficina y el rango de semana, luego haz clic en Generar</p>
        </div>
      )}
    </div>
  )
}
