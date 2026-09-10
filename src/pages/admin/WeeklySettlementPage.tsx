import { useState, useEffect } from 'react'
import { CalendarRange, Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/EmptyState'
import { RouteSelector, routeFileTag } from '@/components/ui/RouteSelector'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateWeeklySettlementForUser } from '@/services/weeklySettlementEngine'
import { filterAccessibleRoutes, canAccessRoute } from '@/lib/permissions'
import { formatCurrency, formatDate, getWeekStart, getWeekEnd } from '@/lib/formatters'
import { downloadCSV } from '@/lib/utils'
import type { WeeklySettlement, Route } from '@/models/types'

/**
 * LIQUIDACIÓN SEMANAL — SIEMPRE DE UNA RUTA.
 * La ruta es obligatoria: no existe modo "todas las rutas", porque una liquidación
 * consolidada mezclaría cajas independientes. El orden de filtrado es
 * rutas permitidas → ruta seleccionada → cálculo, y el servicio revalida el
 * alcance (fail-closed) antes de leer un solo movimiento.
 */
export default function WeeklySettlementPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeId, setRouteId] = useState('')
  const [semanaInicio, setSemanaInicio] = useState(getWeekStart())
  const [semanaFin, setSemanaFin] = useState(getWeekEnd())
  const [settlement, setSettlement] = useState<WeeklySettlement | null>(null)
  /** Ruta con la que se generó la liquidación mostrada (para encabezado y CSV). */
  const [generatedRoute, setGeneratedRoute] = useState<Route | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadMeta() }, [tenantId, user])

  async function loadMeta() {
    // RESTRICCIÓN POR RUTAS: el selector solo ofrece rutas autorizadas.
    const rts = filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(tenantId).toArray())
    setRoutes(rts)
    // Con una sola ruta accesible, se preselecciona (sigue siendo obligatoria).
    if (rts.length === 1) setRouteId(rts[0].id)
  }

  async function generate() {
    if (!routeId) { toast.error('Selecciona la ruta que deseas liquidar.'); return }
    // Guarda de datos en la pantalla; el servicio la repite (defensa en profundidad).
    if (!canAccessRoute(user, routeId)) { toast.error('No tienes acceso a esa ruta.'); return }
    setLoading(true)
    try {
      const data = await generateWeeklySettlementForUser({ user, tenantId, routeId, semanaInicio, semanaFin })
      if (!data) {
        setSettlement(null)
        setGeneratedRoute(null)
        toast.error('No tienes acceso a esa ruta.')
        return
      }
      setSettlement(data)
      setGeneratedRoute(routes.find(r => r.id === routeId) ?? null)
      toast.success(`Liquidación generada: ${routes.find(r => r.id === routeId)?.nombre ?? 'ruta'}`)
    } catch { toast.error('Error al generar liquidación') } finally { setLoading(false) }
  }

  function exportCSV() {
    if (!settlement) { toast.warning('Genera primero'); return }
    // Una sola fila: la de la ruta liquidada. Imposible que contenga otra ruta.
    const rows = [{
      Ruta: generatedRoute?.nombre ?? settlement.routeId,
      'Código ruta': generatedRoute?.codigo ?? '',
      'Semana inicio': formatDate(settlement.semanaInicio),
      'Semana fin': formatDate(settlement.semanaFin),
      'Saldo anterior': settlement.saldoAnterior,
      'Ingreso capital': settlement.ingresoCapital,
      Cobros: settlement.cobros,
      'Préstamos entregados': settlement.prestamosEntregados,
      Gastos: settlement.gastos,
      'Transferencias entrada': settlement.transferenciasEntradas,
      'Transferencias salida': settlement.transferenciasSalidas,
      Retiros: settlement.retiros,
      'Saldo final': settlement.saldoFinal,
    }]
    downloadCSV(rows, `liquidacion_${routeFileTag(routes, settlement.routeId)}_${semanaInicio}_${semanaFin}.csv`)
    toast.success('CSV descargado')
  }

  const Row = ({ label, value, tone = 'text-gray-700' }: { label: string; value: number; tone?: string }) => (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{formatCurrency(value, currency)}</span>
    </div>
  )

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Liquidación Semanal</h1><p className="text-sm text-gray-500 mt-0.5">Lunes a Sábado · por ruta</p></div>
        <div className="flex gap-2">
          {settlement && <Button variant="secondary" onClick={exportCSV} icon={<Download className="w-4 h-4" />}>CSV</Button>}
          <Button onClick={generate} loading={loading} disabled={!routeId} icon={<RefreshCw className="w-4 h-4" />}>Generar</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        {/* Ruta OBLIGATORIA: sin "Todas las rutas". */}
        <RouteSelector routes={routes} value={routeId} onChange={setRouteId} className="w-64" />
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

      {routes.length === 0 && (
        <p className="text-sm text-amber-600">No tienes rutas autorizadas: no hay nada que liquidar.</p>
      )}

      {loading ? (
        <LoadingState message="Calculando liquidación..." />
      ) : settlement ? (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-600">
            Ruta: {generatedRoute?.nombre ?? settlement.routeId}
            {generatedRoute?.codigo ? ` · ${generatedRoute.codigo}` : ''}
            {' · '}{formatDate(settlement.semanaInicio)} – {formatDate(settlement.semanaFin)}
          </h2>

          {/* KPI de ESTA ruta */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-primary-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Cobros</p>
              <p className="text-xl font-bold text-primary-700 mt-1">{formatCurrency(settlement.cobros, currency)}</p>
            </div>
            <div className="bg-red-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Gastos</p>
              <p className="text-xl font-bold text-red-600 mt-1">{formatCurrency(settlement.gastos, currency)}</p>
            </div>
            <div className="bg-emerald-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Saldo final</p>
              <p className={`text-xl font-bold mt-1 ${settlement.saldoFinal >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                {formatCurrency(settlement.saldoFinal, currency)}
              </p>
            </div>
          </div>

          {/* Detalle completo de la ruta liquidada */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden divide-y divide-gray-50">
            <Row label="Saldo anterior" value={settlement.saldoAnterior} />
            <Row label="(+) Ingreso capital" value={settlement.ingresoCapital} tone="text-emerald-600" />
            <Row label="(+) Cobros" value={settlement.cobros} tone="text-emerald-600" />
            <Row label="(+) Transferencias recibidas" value={settlement.transferenciasEntradas} tone="text-emerald-600" />
            <Row label="(−) Préstamos entregados" value={settlement.prestamosEntregados} tone="text-blue-600" />
            <Row label="(−) Gastos" value={settlement.gastos} tone="text-red-500" />
            <Row label="(−) Transferencias enviadas" value={settlement.transferenciasSalidas} tone="text-red-500" />
            <Row label="(−) Retiros" value={settlement.retiros} tone="text-amber-600" />
            <div className="flex items-center justify-between px-4 py-3.5 bg-gray-50">
              <span className="text-sm font-semibold text-gray-800">Saldo final</span>
              <span className={`text-base font-bold ${settlement.saldoFinal >= 0 ? 'text-primary-700' : 'text-red-600'}`}>
                {formatCurrency(settlement.saldoFinal, currency)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <CalendarRange className="w-10 h-10 mb-3" />
          <p className="text-sm">Selecciona la ruta y el rango de la semana, luego haz clic en Generar</p>
        </div>
      )}
    </div>
  )
}
