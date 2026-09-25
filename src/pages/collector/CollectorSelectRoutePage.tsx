import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { MapPin, ChevronRight, ArrowRight } from 'lucide-react'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { can } from '@/lib/permissions'
import { formatCurrency } from '@/lib/formatters'
import { isSaleDisbursed } from '@/services/installmentEngine'
import { getRouteAvailableCapital } from '@/services/cashboxEngine'
import { groupRoutesByOffice } from '@/lib/officeGrouping'
import type { Office, Route } from '@/models/types'

interface RouteSummary {
  route: Route
  clientes: number
  ventasActivas: number
  cartera: number
  /**
   * BASE de la ruta (saldo de caja). `undefined` cuando el usuario NO tiene
   * `cashbox.viewRoute`: no es que se oculte, es que NO SE PIDE. Esta tarjeta la
   * comparten Cobrador y Supervisor, y el Cobrador no debe conocer la cifra
   * financiera de la ruta ni por accidente.
   */
  base?: number
}

export default function CollectorSelectRoutePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId, setActiveRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const base = useOpBase()
  const [summaries, setSummaries] = useState<RouteSummary[]>([])
  // Oficinas SOLO para agrupar visualmente. Elegir una Oficina no existe como paso
  // ni habilita rutas: las rutas mostradas son exactamente las autorizadas.
  const [offices, setOffices] = useState<Office[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) { setLoading(false); return }
    const ids = getAuthorizedRouteIds(user)
    const all = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    const mine = all.filter(r => ids.includes(r.id))
    setOffices(await db.offices.where('tenantId').equals(user.tenantId).toArray())
    const result: RouteSummary[] = []
    for (const route of mine) {
      const sales = (await db.sales.where('routeId').equals(route.id).and(s => s.status === 'activa').toArray()).filter(isSaleDisbursed)
      // BASE: solo para quien puede ver la caja financiera de ESA ruta (Supervisor,
      // Admin, Super Admin). Fail-closed: sin la capacidad el dato ni se consulta.
      const verBase = can(user, 'cashbox.viewRoute', { routeId: route.id, tenantId: user.tenantId })
      result.push({
        route,
        clientes: new Set(sales.map(s => s.clientId)).size,
        ventasActivas: sales.length,
        cartera: sales.reduce((sum, s) => sum + s.saldo, 0),
        base: verBase ? await getRouteAvailableCapital(route.id) : undefined,
      })
    }
    setSummaries(result)
    setLoading(false)
  }

  function enter(routeId: string) {
    setActiveRouteId(routeId)
    navigate(`${base}/home`)
  }

  return (
    <div className="p-4 space-y-5">
      <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <p className="text-primary-200 text-sm">Hola, {user?.nombre}</p>
        <h1 className="text-xl font-bold mt-0.5">Selecciona tu ruta</h1>
        <p className="text-primary-200 text-xs mt-1">Elige la ruta que vas a trabajar hoy</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : (
        <div className="space-y-5">
          {groupRoutesByOffice(summaries.map(s => s.route), offices).map(grupo => (
          <div key={grupo.key} className="space-y-3">
            {/* Encabezado de Oficina: orientación, no un filtro ni un paso previo.
                Con una sola ruta la autoselección del layout sigue entrando directo. */}
            {(offices.length > 0 || grupo.key !== '__sin_oficina__') && summaries.length > 1 && (
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-500 px-1">{grupo.label}</p>
            )}
          {grupo.routes.map(r => summaries.find(s => s.route.id === r.id)!).map(({ route, clientes, ventasActivas, cartera, base }) => {
            const isActive = route.id === activeRouteId
            const single = summaries.length === 1
            return (
              <div key={route.id} className={`bg-white rounded-2xl border shadow-card p-4 ${isActive ? 'border-primary-300' : 'border-gray-100'}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <MapPin className="w-5 h-5 text-primary-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm truncate">{route.nombre}</p>
                      <p className="text-xs text-gray-400">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                    </div>
                  </div>
                  {isActive && <span className="text-[10px] font-semibold text-primary-600 bg-primary-50 rounded-full px-2 py-0.5">Activa</span>}
                </div>

                {/* Indicadores de la ruta. Con permiso de caja se PRIORIZA la Base
                    (lo que el Supervisor necesita al entrar); la Cartera sigue
                    visible debajo, no se pierde. Sin permiso, la tarjeta es
                    exactamente la de siempre: Clientes · Ventas · Cartera. */}
                {/* Importes: tamaño fluido y corte seguro para que cifras de 8+ dígitos
                    (p. ej. $ 12.500.000) no se salgan del recuadro en 360 px. */}
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-gray-700">{clientes}</p>
                    <p className="text-xs text-gray-400">Clientes</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-primary-600">{ventasActivas}</p>
                    <p className="text-xs text-gray-400">Ventas</p>
                  </div>
                  {base === undefined ? (
                    <div className="bg-gray-50 rounded-xl p-2 text-center">
                      <p className="text-[clamp(11px,3.4vw,14px)] font-bold text-amber-600 leading-tight break-all">{formatCurrency(cartera, currency)}</p>
                      <p className="text-xs text-gray-400">Cartera</p>
                    </div>
                  ) : (
                    <div className="bg-primary-50 rounded-xl p-2 text-center">
                      <p className="text-[clamp(11px,3.4vw,14px)] font-bold text-primary-700 leading-tight break-all">{formatCurrency(base, currency)}</p>
                      <p className="text-xs text-primary-500">Base</p>
                    </div>
                  )}
                </div>

                {base !== undefined && (
                  <div className="mt-2 flex items-center justify-between rounded-xl bg-gray-50 px-3 py-1.5">
                    <span className="text-xs text-gray-400">Cartera</span>
                    <span className="text-xs font-semibold text-amber-600">{formatCurrency(cartera, currency)}</span>
                  </div>
                )}

                <button
                  onClick={() => enter(route.id)}
                  className="mt-3 w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2"
                >
                  {single ? <>Entrar a la ruta <ArrowRight className="w-4 h-4" /></> : <>Trabajar esta ruta <ChevronRight className="w-4 h-4" /></>}
                </button>
              </div>
            )
          })}
          </div>
          ))}
        </div>
      )}
    </div>
  )
}
