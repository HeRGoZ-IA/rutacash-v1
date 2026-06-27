import { useState, useEffect } from 'react'
import { Calculator, TrendingUp, TrendingDown, Banknote, Wallet, MapPin } from 'lucide-react'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate, today } from '@/lib/formatters'

/**
 * Cuadre del cobrador (resumen del día).
 * Regla documentada (simple, día actual y ruta activa):
 *   Saldo esperado en caja = abonos cobrados - ventas desembolsadas - gastos
 * Es coherente con el motor de caja (cobros - préstamos - gastos), pero acotado
 * al día y sin capital/transferencias/retiros (que el admin maneja aparte).
 */
export default function CollectorCashClosePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [data, setData] = useState({ abonos: 0, ventas: 0, gastos: 0, baseActual: 0, carteraEnCalle: 0 })
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null

  useEffect(() => { load() }, [user, routeId])

  async function load() {
    if (!user || !routeId) { setLoading(false); return }
    setLoading(true)
    const todayStr = today()
    const [payments, sales, expenses, summary] = await Promise.all([
      db.payments.where('routeId').equals(routeId).and(p => p.fecha === todayStr).toArray(),
      db.sales.where('routeId').equals(routeId).toArray(),
      db.expenses.where('routeId').equals(routeId).and(e => e.fecha === todayStr).toArray(),
      getRouteFinancialSummary(routeId),
    ])
    const ventasHoy = sales.filter(s => s.createdAt.slice(0, 10) === todayStr && s.disbursementStatus !== 'pendiente')
    setData({
      abonos: payments.reduce((s, p) => s + p.valor, 0),
      ventas: ventasHoy.reduce((s, x) => s + x.valorVenta, 0),
      gastos: expenses.reduce((s, e) => s + e.valor, 0),
      baseActual: summary.baseActual,
      carteraEnCalle: summary.carteraEnCalle,
    })
    setLoading(false)
  }

  const saldoEsperado = data.abonos - data.ventas - data.gastos

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Cuadre</h1>
        <p className="text-xs text-gray-500">{formatDate(today())} · resumen del día</p>
      </div>

      {/* Revisión socio 25-jun — Base actual y Cartera en calle de la ruta */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-400"><Wallet className="w-3.5 h-3.5" /> Base actual</div>
          <p className="text-lg font-bold text-primary-700 mt-1">{formatCurrency(data.baseActual, currency)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-400"><MapPin className="w-3.5 h-3.5" /> Cartera en calle</div>
          <p className="text-lg font-bold text-indigo-600 mt-1">{formatCurrency(data.carteraEnCalle, currency)}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card divide-y divide-gray-50">
        <Row icon={<TrendingUp className="w-4 h-4 text-emerald-600" />} label="Abonos cobrados" value={`+${formatCurrency(data.abonos, currency)}`} color="text-emerald-600" />
        <Row icon={<Banknote className="w-4 h-4 text-primary-600" />} label="Ventas desembolsadas" value={`-${formatCurrency(data.ventas, currency)}`} color="text-primary-600" />
        <Row icon={<TrendingDown className="w-4 h-4 text-red-500" />} label="Gastos" value={`-${formatCurrency(data.gastos, currency)}`} color="text-red-500" />
      </div>

      <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <div className="flex items-center gap-2 text-primary-200 text-sm">
          <Calculator className="w-4 h-4" /> Saldo esperado en caja
        </div>
        <p className="text-3xl font-bold mt-1">{formatCurrency(saldoEsperado, currency)}</p>
        <p className="text-primary-200 text-xs mt-2">Abonos − ventas desembolsadas − gastos</p>
      </div>
    </div>
  )
}

function Row({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex items-center gap-3">
        {icon}
        <span className="text-sm font-medium text-gray-700">{label}</span>
      </div>
      <span className={`text-sm font-bold ${color}`}>{value}</span>
    </div>
  )
}
