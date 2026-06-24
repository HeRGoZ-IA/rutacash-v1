import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapPin, ChevronRight, ShieldAlert } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import type { Route } from '@/models/types'

interface RouteSummary {
  route: Route
  clientes: number
  ventasActivas: number
  cartera: number
}

export default function SupervisorHomePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const navigate = useNavigate()
  const [summaries, setSummaries] = useState<RouteSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) { setLoading(false); return }
    const authorizedIds = getAuthorizedRouteIds(user)
    if (authorizedIds.length === 0) { setSummaries([]); setLoading(false); return }

    const allRoutes = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    // Solo rutas autorizadas (y que sigan existiendo).
    const routes = allRoutes.filter(r => authorizedIds.includes(r.id))

    const result: RouteSummary[] = []
    for (const route of routes) {
      const sales = await db.sales.where('routeId').equals(route.id).and(s => s.status === 'activa').toArray()
      const clientes = new Set(sales.map(s => s.clientId)).size
      const cartera = sales.reduce((sum, s) => sum + s.saldo, 0)
      result.push({ route, clientes, ventasActivas: sales.length, cartera })
    }
    setSummaries(result)
    setLoading(false)
  }

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches'

  return (
    <div className="p-4 space-y-5">
      {/* Greeting */}
      <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <p className="text-primary-200 text-sm">{greeting},</p>
        <h1 className="text-xl font-bold mt-0.5">{user?.nombre}</h1>
        <p className="text-primary-200 text-xs mt-1">{formatDate(today())}</p>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Rutas autorizadas</p>

        {loading ? (
          <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : summaries.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="w-8 h-8" />}
            title="No tienes rutas autorizadas"
            description="Contacta al administrador para que te asigne rutas."
          />
        ) : (
          <div className="space-y-2.5">
            {summaries.map(({ route, clientes, ventasActivas, cartera }) => (
              <button
                key={route.id}
                onClick={() => navigate(`/supervisor/route/${route.id}`)}
                className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-card hover:border-primary-200 transition-colors p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <MapPin className="w-4 h-4 text-primary-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm truncate">{route.nombre}</p>
                      <p className="text-xs text-gray-400">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-300 mt-1 flex-shrink-0" />
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-gray-700">{clientes}</p>
                    <p className="text-xs text-gray-400">Clientes</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-primary-600">{ventasActivas}</p>
                    <p className="text-xs text-gray-400">Activos</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-amber-600 leading-tight">{formatCurrency(cartera, currency)}</p>
                    <p className="text-xs text-gray-400">Cartera</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
