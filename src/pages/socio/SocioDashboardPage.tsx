import { useState, useEffect } from 'react'
import { ShieldAlert, TrendingUp, Wallet, Users, CreditCard } from 'lucide-react'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { useTenant } from '@/hooks/useTenant'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { formatCurrency } from '@/lib/formatters'
import type { RouteFinancialSummary, Route } from '@/models/types'

/**
 * Resumen consolidado del SOCIO (solo lectura) para sus rutas autorizadas.
 * Base actual, cartera en calle, total controlado, ventas y clientes activos,
 * interés por cobrar estimado. Sin acciones operativas.
 */
export default function SocioDashboardPage() {
  const { routes, loading } = useAccessibleRoutes()
  const { currency } = useTenant()
  const [summaries, setSummaries] = useState<Record<string, RouteFinancialSummary>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    if (routes.length === 0) { setSummaries({}); return }
    setBusy(true)
    Promise.all(routes.map(r => getRouteFinancialSummary(r.id))).then(list => {
      if (!alive) return
      const map: Record<string, RouteFinancialSummary> = {}
      list.forEach(s => { map[s.routeId] = s })
      setSummaries(map)
      setBusy(false)
    })
    return () => { alive = false }
  }, [routes])

  if (loading) return <Spinner />

  if (routes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mb-4">
          <ShieldAlert className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">No tienes rutas autorizadas</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-sm">Cuando el administrador te asigne rutas, verás aquí el resumen consolidado.</p>
      </div>
    )
  }

  const totals = Object.values(summaries).reduce((acc, s) => ({
    base: acc.base + s.baseActual,
    cartera: acc.cartera + s.carteraEnCalle,
    total: acc.total + s.totalControlado,
    ventas: acc.ventas + s.ventasActivas,
    clientes: acc.clientes + s.clientesActivos,
    interes: acc.interes + s.interesPorCobrarEstimado,
  }), { base: 0, cartera: 0, total: 0, ventas: 0, clientes: 0, interes: 0 })

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Resumen consolidado</h1>
        <p className="text-sm text-gray-500 mt-0.5">{routes.length} ruta(s) autorizada(s){busy ? ' · calculando…' : ''}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={<Wallet className="w-4 h-4" />} label="Base actual (caja)" value={formatCurrency(totals.base, currency)} color="emerald" />
        <Kpi icon={<TrendingUp className="w-4 h-4" />} label="Cartera en calle" value={formatCurrency(totals.cartera, currency)} color="amber" />
        <Kpi icon={<CreditCard className="w-4 h-4" />} label="Total controlado" value={formatCurrency(totals.total, currency)} color="primary" />
        <Kpi icon={<Users className="w-4 h-4" />} label="Clientes activos" value={String(totals.clientes)} color="primary" />
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Detalle por ruta</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {routes.map((r: Route) => {
            const s = summaries[r.id]
            return (
              <div key={r.id} className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-gray-900 text-sm">{r.nombre}</p>
                  <span className="text-xs text-gray-400">{r.codigo}</span>
                </div>
                {s ? (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <Line label="Base actual" value={formatCurrency(s.baseActual, currency)} />
                    <Line label="Cartera en calle" value={formatCurrency(s.carteraEnCalle, currency)} />
                    <Line label="Total controlado" value={formatCurrency(s.totalControlado, currency)} />
                    <Line label="Interés x cobrar" value={formatCurrency(s.interesPorCobrarEstimado, currency)} />
                    <Line label="Ventas activas" value={String(s.ventasActivas)} />
                    <Line label="Clientes activos" value={String(s.clientesActivos)} />
                  </div>
                ) : <p className="text-xs text-gray-400">Calculando…</p>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-1.5">
      <p className="text-[11px] text-gray-400 leading-tight">{label}</p>
      <p className="font-semibold text-gray-800 text-xs">{value}</p>
    </div>
  )
}

function Kpi({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: 'emerald' | 'amber' | 'primary' }) {
  const c = color === 'emerald' ? 'text-emerald-600 bg-emerald-50 border-emerald-100'
    : color === 'amber' ? 'text-amber-600 bg-amber-50 border-amber-100'
    : 'text-primary-600 bg-primary-50 border-primary-100'
  return (
    <div className={`rounded-2xl border shadow-card p-3 ${c}`}>
      <div className="flex items-center gap-1.5 mb-1 opacity-80">{icon}<span className="text-[11px] font-medium text-gray-500">{label}</span></div>
      <p className="text-base font-bold tabular-nums truncate">{value}</p>
    </div>
  )
}

function Spinner() {
  return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
}
