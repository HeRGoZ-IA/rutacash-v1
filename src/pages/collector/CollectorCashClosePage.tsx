import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Calculator, TrendingUp, TrendingDown, Banknote, Wallet, MapPin, Landmark, Info, AlertTriangle, ChevronRight,
} from 'lucide-react'
import { getCollectorDailyCashSummary, getRouteFinancialSummary } from '@/services/cashboxEngine'
import {
  previewCashSettlement, listCashSettlementsForUser, type CashSettlementPreview,
} from '@/services/cashSettlementService'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useOpBase } from '@/hooks/useOpBase'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import type { CashSettlement, CollectorCashSummary, RouteFinancialSummary } from '@/models/types'

/**
 * MI EFECTIVO — CICLO PERSONAL DESDE EL ÚLTIMO CUADRE (v14).
 *
 * Lo que se muestra aquí es el EFECTIVO OPERATIVO bajo la responsabilidad de quien
 * está en sesión, NO la caja financiera de la ruta. Desde el cuadre por trabajador
 * ya no es "lo de hoy": es todo lo ocurrido desde su último cuadre vigente, más el
 * faltante que quedó pendiente en él:
 *
 *     faltante pendiente + recaudado − desembolsado − gastos = efectivo a entregar
 *
 * Lo calcula `previewCashSettlement`, el MISMO servicio que usará quien cierre el
 * cuadre: el trabajador y quien lo cuadra ven la misma cifra. "Mi recaudo hoy" se
 * conserva aparte como KPI diario (`getCollectorDailyCashSummary`).
 *
 * DOS DINEROS DISTINTOS, DOS BLOQUES DISTINTOS (Fase 1):
 *   · "Mi efectivo"     → lo que ESTA persona debe entregar. Su responsabilidad.
 *   · "Caja de la Ruta" → información financiera de la RUTA. No es su dinero.
 *
 * El CAPITAL de la ruta no se muestra al Cobrador y —más importante— ni siquiera se
 * consulta: el motor personal no lee `capitalMovements`. El bloque de ruta solo se
 * calcula para quien tiene `cashbox.viewRoute` (Supervisor, Administrador, Super
 * Admin). Ocultar la tarjeta no habría bastado: el dato no se pide.
 */
export default function CollectorCashClosePage() {
  const { user } = useAuth()
  const { currency, tenantId } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const base = useOpBase()
  const [ciclo, setCiclo] = useState<CashSettlementPreview | null>(null)
  const [hoy, setHoy] = useState<CollectorCashSummary | null>(null)
  const [misCuadres, setMisCuadres] = useState<CashSettlement[]>([])
  const [route, setRoute] = useState<RouteFinancialSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null
  // Solo quien puede ver la caja FINANCIERA de la ruta obtiene ese bloque.
  const verCajaRuta = can(user, 'cashbox.viewRoute', { routeId: routeId ?? undefined })
  // El Supervisor cuadra a OTROS trabajadores de la ruta desde aquí.
  const cuadraOtros = can(user, 'cashSettlement.close', { routeId: routeId ?? undefined, tenantId })

  // Un cobro, desembolso, gasto o cuadre confirmado en esta u otra pestaña recalcula.
  const revision = useDataRevision()
  useEffect(() => { load(revision > 0) }, [user, routeId, verCajaRuta, revision])

  async function load(silent = false) {
    if (!user || !routeId) { setLoading(false); return }
    if (!silent) setLoading(true)
    try {
      setCiclo(await previewCashSettlement({ actor: user, tenantId: user.tenantId, routeId, userId: user.id }))
    } catch {
      setCiclo(null)
    }
    setHoy(await getCollectorDailyCashSummary({ routeId, collectorId: user.id, fecha: today() }))
    setMisCuadres((await listCashSettlementsForUser(user, user.tenantId))
      .filter(c => c.userId === user.id && c.routeId === routeId).slice(0, 5))
    // Fail-closed: si no tiene la capacidad, el dato financiero NO se pide.
    setRoute(verCajaRuta ? await getRouteFinancialSummary(routeId) : null)
    setLoading(false)
  }

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  const money = (n: number) => formatCurrency(n, currency)

  return (
    <div className="p-4 space-y-6">
      {/* ================= BLOQUE 1 — MI EFECTIVO (responsabilidad personal) ====== */}
      <section className="space-y-4">
        <div>
          <h1 className="font-bold text-gray-900">Mi efectivo</h1>
          <p className="text-xs text-gray-500">
            Dinero bajo tu responsabilidad
            {ciclo && <> desde {ciclo.origenDesde === 'ultimo-cierre' ? 'tu último cuadre' : 'el inicio del modelo personal'} ({formatDateTime(ciclo.desde)})</>}
          </p>
        </div>

        {ciclo && (
          <>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-card divide-y divide-gray-50">
              {ciclo.arrastreAnterior > 0 && (
                <Row icon={<AlertTriangle className="w-4 h-4 text-amber-600" />} label="Faltante pendiente del cuadre anterior" value={`+${money(ciclo.arrastreAnterior)}`} color="text-amber-600" />
              )}
              <Row icon={<TrendingUp className="w-4 h-4 text-emerald-600" />} label="Recaudado por ti" value={`+${money(ciclo.recaudado)}`} color="text-emerald-600" />
              <Row icon={<Banknote className="w-4 h-4 text-primary-600" />} label="Desembolsado por ti" value={`-${money(ciclo.desembolsado)}`} color="text-primary-600" />
              <Row icon={<TrendingDown className="w-4 h-4 text-red-500" />} label="Tus gastos" value={`-${money(ciclo.gastos)}`} color="text-red-500" />
            </div>

            <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
              <div className="flex items-center gap-2 text-primary-200 text-sm">
                <Calculator className="w-4 h-4" /> Efectivo a entregar
              </div>
              <p className="text-3xl font-bold mt-1">{money(ciclo.esperado)}</p>
              <p className="text-primary-200 text-xs mt-2">Faltante pendiente + recaudado − desembolsado − gastos, desde tu último cuadre</p>
            </div>
          </>
        )}

        {/* KPI DIARIO — separado a propósito de "Mi efectivo". */}
        {hoy && (
          <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-white px-4 py-3">
            <span className="text-sm text-gray-600">Mi recaudo hoy · {formatDate(today())}</span>
            <span className="text-sm font-bold text-emerald-600">{money(hoy.recaudado)}</span>
          </div>
        )}

        {misCuadres.length > 0 && (
          <div className="space-y-1.5">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Mis últimos cuadres</h2>
            {misCuadres.map(c => (
              <div key={c.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-100 px-3 py-2 text-xs">
                <span className="text-gray-600">{formatDateTime(c.closedAt)}{c.status === 'reabierta' ? ' · reabierto' : ''}</span>
                <span className={c.diferencia < 0 ? 'font-semibold text-red-600' : c.diferencia > 0 ? 'font-semibold text-amber-600' : 'font-semibold text-emerald-600'}>
                  {c.diferencia === 0 ? 'Exacto' : c.diferencia < 0 ? `Faltante ${money(c.faltante)}` : `Sobrante ${money(c.sobrante)}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {cuadraOtros && (
          <Link to={`${base}/worker-settlements`}
            className="flex items-center justify-between rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-sm font-medium text-primary-700">
            Cuadrar a otro trabajador de la ruta <ChevronRight className="w-4 h-4" />
          </Link>
        )}
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
