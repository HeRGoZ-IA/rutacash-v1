import { useState, useEffect } from 'react'
import { Calculator, TrendingUp, TrendingDown, Banknote, Wallet, MapPin } from 'lucide-react'
import { getCollectorDailyCashSummary, getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import type { CollectorCashSummary, RouteFinancialSummary } from '@/models/types'

/**
 * CUADRE DEL DÍA — CAJA PERSONAL.
 *
 * Regla vigente (revisión del socio): lo que se cuadra es el EFECTIVO OPERATIVO bajo
 * la responsabilidad de quien está en sesión, NO la caja financiera de la ruta:
 *
 *     recaudado por él − desembolsado por él − sus gastos = efectivo a entregar
 *
 * El CAPITAL de la ruta (capital inicial, base actual, movimientos de capital) ya NO
 * se muestra al Cobrador y —más importante— ya NO se consulta: `getCollectorDailyCashSummary`
 * ni siquiera lee `capitalMovements`. El bloque financiero de la ruta solo se calcula
 * para quien tiene `cashbox.viewRoute` (Supervisor, Administrador, Super Admin), ya que
 * esta pantalla es compartida por la capa operativa.
 */
export default function CollectorCashClosePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [cash, setCash] = useState<CollectorCashSummary | null>(null)
  const [route, setRoute] = useState<RouteFinancialSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null
  // Solo quien puede ver la caja FINANCIERA de la ruta obtiene ese bloque.
  const verCajaRuta = can(user, 'cashbox.viewRoute', { routeId: routeId ?? undefined })

  useEffect(() => { load() }, [user, routeId, verCajaRuta])

  async function load() {
    if (!user || !routeId) { setLoading(false); return }
    setLoading(true)
    const resumen = await getCollectorDailyCashSummary({ routeId, collectorId: user.id, fecha: today() })
    setCash(resumen)
    // Fail-closed: si no tiene la capacidad, el dato financiero NO se pide.
    setRoute(verCajaRuta ? await getRouteFinancialSummary(routeId) : null)
    setLoading(false)
  }

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  const recaudado = cash?.recaudado ?? 0
  const desembolsado = cash?.desembolsado ?? 0
  const gastos = cash?.gastos ?? 0
  const aEntregar = cash?.efectivoAEntregar ?? 0

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Mi caja</h1>
        <p className="text-xs text-gray-500">{formatDate(today())} · efectivo bajo tu responsabilidad</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-card divide-y divide-gray-50">
        <Row icon={<TrendingUp className="w-4 h-4 text-emerald-600" />} label="Recaudado por ti" value={`+${formatCurrency(recaudado, currency)}`} color="text-emerald-600" />
        <Row icon={<Banknote className="w-4 h-4 text-primary-600" />} label="Desembolsado por ti" value={`-${formatCurrency(desembolsado, currency)}`} color="text-primary-600" />
        <Row icon={<TrendingDown className="w-4 h-4 text-red-500" />} label="Tus gastos" value={`-${formatCurrency(gastos, currency)}`} color="text-red-500" />
      </div>

      <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <div className="flex items-center gap-2 text-primary-200 text-sm">
          <Calculator className="w-4 h-4" /> Efectivo a entregar
        </div>
        <p className="text-3xl font-bold mt-1">{formatCurrency(aEntregar, currency)}</p>
        <p className="text-primary-200 text-xs mt-2">Recaudado − desembolsado − gastos</p>
      </div>

      {/* Caja FINANCIERA de la ruta: solo para roles con `cashbox.viewRoute`. */}
      {verCajaRuta && route && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Caja de la ruta</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-400"><Wallet className="w-3.5 h-3.5" /> Base actual</div>
              <p className="text-lg font-bold text-primary-700 mt-1">{formatCurrency(route.baseActual, currency)}</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-400"><MapPin className="w-3.5 h-3.5" /> Cartera Activa</div>
              <p className="text-lg font-bold text-indigo-600 mt-1">{formatCurrency(route.carteraEnCalle, currency)}</p>
            </div>
          </div>
        </div>
      )}
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
