import { useState, useEffect } from 'react'
import { Archive, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { getCashboxSummary } from '@/services/cashboxEngine'
import { formatCurrency, getWeekStart, getWeekEnd, formatDate } from '@/lib/formatters'
import type { Route, CashboxSummary } from '@/models/types'

export default function CashboxPage() {
  const { tenantId, officeId } = useTenant()
  const [routes, setRoutes] = useState<Route[]>([])
  const [selectedRoute, setSelectedRoute] = useState('')
  const [summary, setSummary] = useState<CashboxSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [fechaDesde, setFechaDesde] = useState(getWeekStart())
  const [fechaHasta, setFechaHasta] = useState(getWeekEnd())

  useEffect(() => { loadRoutes() }, [tenantId])
  useEffect(() => { if (selectedRoute) loadSummary() }, [selectedRoute, fechaDesde, fechaHasta])

  async function loadRoutes() {
    const rts = await db.routes.where('tenantId').equals(tenantId).toArray()
    setRoutes(rts)
    if (rts.length > 0) setSelectedRoute(rts[0].id)
  }

  async function loadSummary() {
    if (!selectedRoute) return
    setLoading(true)
    const s = await getCashboxSummary(selectedRoute, fechaDesde, fechaHasta)
    setSummary(s)
    setLoading(false)
  }

  const routeName = routes.find(r => r.id === selectedRoute)?.nombre ?? ''

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Caja</h1><p className="text-sm text-gray-500 mt-0.5">Resumen de movimientos por ruta</p></div>
        <Button variant="secondary" onClick={loadSummary} icon={<RefreshCw className="w-4 h-4" />}>Actualizar</Button>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <Select value={selectedRoute} onChange={e => setSelectedRoute(e.target.value)}
          options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" className="w-48" />
        <div>
          <label className="block text-xs text-gray-500 mb-1">Desde</label>
          <input type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Hasta</label>
          <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      {loading ? (
        <LoadingState message="Calculando caja..." />
      ) : summary ? (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-600">Caja: {routeName} · {formatDate(fechaDesde)} – {formatDate(fechaHasta)}</h2>

          {/* Summary table */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            <div className="divide-y divide-gray-50">
              <CashboxRow label="Saldo anterior" value={summary.saldoAnterior} type="neutral" />
              <CashboxRow label="(+) Ingreso capital" value={summary.ingresoCapital} type="positive" />
              <CashboxRow label="(+) Cobros recibidos" value={summary.cobros} type="positive" />
              <CashboxRow label="(+) Transferencias entrantes" value={summary.transferenciasEntradas} type="positive" />
              <CashboxRow label="(-) Préstamos entregados" value={summary.prestamosEntregados} type="negative" />
              <CashboxRow label="(-) Gastos" value={summary.gastos} type="negative" />
              <CashboxRow label="(-) Transferencias salientes" value={summary.transferenciasSalidas} type="negative" />
              <CashboxRow label="(-) Retiros" value={summary.retiros} type="negative" />
            </div>
            <div className="px-4 py-4 bg-primary-50 border-t-2 border-primary-200">
              <div className="flex justify-between items-center">
                <span className="font-bold text-gray-900">SALDO ACTUAL</span>
                <span className={`text-xl font-bold ${summary.saldoActual >= 0 ? 'text-primary-700' : 'text-red-600'}`}>
                  {formatCurrency(summary.saldoActual)}
                </span>
              </div>
            </div>
          </div>

          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniKPI label="Total cobrado" value={formatCurrency(summary.cobros)} color="green" />
            <MiniKPI label="Total gastos" value={formatCurrency(summary.gastos)} color="red" />
            <MiniKPI label="Préstamos" value={formatCurrency(summary.prestamosEntregados)} color="blue" />
            <MiniKPI label="Retiros" value={formatCurrency(summary.retiros)} color="yellow" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <Archive className="w-10 h-10 mb-3" />
          <p className="text-sm">Selecciona una ruta para ver su caja</p>
        </div>
      )}
    </div>
  )
}

function CashboxRow({ label, value, type }: { label: string; value: number; type: 'positive' | 'negative' | 'neutral' }) {
  const color = type === 'positive' ? 'text-emerald-600' : type === 'negative' ? 'text-red-500' : 'text-gray-700'
  const prefix = type === 'positive' ? '+' : type === 'negative' ? '-' : ''
  return (
    <div className="flex justify-between items-center px-4 py-3">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-medium ${color}`}>{prefix}{formatCurrency(Math.abs(value))}</span>
    </div>
  )
}

function MiniKPI({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = { green: 'bg-emerald-50 text-emerald-700', red: 'bg-red-50 text-red-600', blue: 'bg-blue-50 text-blue-700', yellow: 'bg-amber-50 text-amber-700' }
  return (
    <div className={`rounded-xl p-3 ${colors[color]}`}>
      <p className="text-xs opacity-70">{label}</p>
      <p className="font-bold text-sm mt-0.5">{value}</p>
    </div>
  )
}
