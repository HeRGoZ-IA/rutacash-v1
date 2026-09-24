import { useState, useEffect } from 'react'
import { Calculator, TrendingUp, TrendingDown, Banknote, Wallet, MapPin, Landmark, Info } from 'lucide-react'
import { getCollectorDailyCashSummary, getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useDataRevision } from '@/hooks/useDataRevision'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import type { CollectorCashSummary, RouteFinancialSummary } from '@/models/types'

/**
 * MI EFECTIVO — CIERRE DEL DÍA DE LA CAJA PERSONAL.
 *
 * Lo que se cuadra aquí es el EFECTIVO OPERATIVO bajo la responsabilidad de quien
 * está en sesión, NO la caja financiera de la ruta:
 *
 *     recaudado por él − desembolsado por él − sus gastos = efectivo a entregar
 *
 * DOS DINEROS DISTINTOS, DOS BLOQUES DISTINTOS (Fase 1):
 * La pantalla se llamaba "Mi caja" y, justo debajo del total personal, mostraba
 * "Base actual" de la ruta. Dos cifras de naturaleza completamente distinta bajo un
 * mismo título posesivo: el Supervisor podía leer la Base de la ruta como si fuera
 * dinero suyo. Ahora la separación es explícita:
 *
 *   · "Mi efectivo"     → lo que ESTA persona debe entregar. Su responsabilidad.
 *   · "Caja de la Ruta" → información financiera de la RUTA. No es su dinero.
 *
 * El CAPITAL de la ruta no se muestra al Cobrador y —más importante— ni siquiera se
 * consulta: `getCollectorDailyCashSummary` no lee `capitalMovements`. El bloque de
 * ruta solo se calcula para quien tiene `cashbox.viewRoute` (Supervisor,
 * Administrador, Super Admin), porque esta pantalla es compartida por la capa
 * operativa. Ocultar la tarjeta no habría bastado: el dato no se pide.
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

  // Un cobro, desembolso o gasto confirmado en esta u otra pestaña recalcula.
  const revision = useDataRevision()
  useEffect(() => { load(revision > 0) }, [user, routeId, verCajaRuta, revision])

  async function load(silent = false) {
    if (!user || !routeId) { setLoading(false); return }
    if (!silent) setLoading(true)
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
    <div className="p-4 space-y-6">
      {/* ================= BLOQUE 1 — MI EFECTIVO (responsabilidad personal) ====== */}
      <section className="space-y-4">
        <div>
          <h1 className="font-bold text-gray-900">Mi efectivo</h1>
          <p className="text-xs text-gray-500">{formatDate(today())} · dinero bajo tu responsabilidad</p>
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
      </section>

      {/* ============ BLOQUE 2 — CAJA DE LA RUTA (NO es dinero del usuario) ======= */}
      {/* Separado a propósito: es información financiera de la RUTA. Solo se
          muestra —y solo se consulta— con `cashbox.viewRoute`. */}
      {verCajaRuta && route && (
        <section className="space-y-3 border-t border-gray-200 pt-5">
          <div className="flex items-start gap-2">
            <Landmark className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Caja de la Ruta</h2>
              <p className="text-xs text-gray-500">Información financiera de la ruta</p>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2">
            <Info className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800">
              Este dinero <span className="font-semibold">no forma parte de tu efectivo</span>: pertenece a la ruta
              y no entra en lo que debes entregar.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-400"><Wallet className="w-3.5 h-3.5" /> Base de la ruta</div>
              <p className="text-lg font-bold text-primary-700 mt-1">{formatCurrency(route.baseActual, currency)}</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-400"><MapPin className="w-3.5 h-3.5" /> Cartera activa</div>
              <p className="text-lg font-bold text-indigo-600 mt-1">{formatCurrency(route.carteraEnCalle, currency)}</p>
            </div>
          </div>
        </section>
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
