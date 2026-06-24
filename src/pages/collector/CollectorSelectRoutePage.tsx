import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapPin, ChevronRight, ArrowRight } from 'lucide-react'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { formatCurrency } from '@/lib/formatters'
import { isSaleDisbursed } from '@/services/installmentEngine'
import type { Route } from '@/models/types'

interface RouteSummary {
  route: Route
  clientes: number
  ventasActivas: number
  cartera: number
}

export default function CollectorSelectRoutePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId, setActiveRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const [summaries, setSummaries] = useState<RouteSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) { setLoading(false); return }
    const ids = getAuthorizedRouteIds(user)
    const all = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    const mine = all.filter(r => ids.includes(r.id))
    const result: RouteSummary[] = []
    for (const route of mine) {
      const sales = (await db.sales.where('routeId').equals(route.id).and(s => s.status === 'activa').toArray()).filter(isSaleDisbursed)
      result.push({
        route,
        clientes: new Set(sales.map(s => s.clientId)).size,
        ventasActivas: sales.length,
        cartera: sales.reduce((sum, s) => sum + s.saldo, 0),
      })
    }
    setSummaries(result)
    setLoading(false)
  }

  function enter(routeId: string) {
    setActiveRouteId(routeId)
    navigate('/collector/home')
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
        <div className="space-y-3">
          {summaries.map(({ route, clientes, ventasActivas, cartera }) => {
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

                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-gray-700">{clientes}</p>
                    <p className="text-xs text-gray-400">Clientes</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-primary-600">{ventasActivas}</p>
                    <p className="text-xs text-gray-400">Ventas</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-amber-600 leading-tight">{formatCurrency(cartera, currency)}</p>
                    <p className="text-xs text-gray-400">Cartera</p>
                  </div>
                </div>

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
      )}
    </div>
  )
}
