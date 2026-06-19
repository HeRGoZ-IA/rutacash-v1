import { useState, useEffect } from 'react'
import { MapPin, DollarSign, Users, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { formatCurrency, formatDate, today, getWeekStart, getWeekEnd } from '@/lib/formatters'

export default function CollectorHomePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [stats, setStats] = useState({ pendientes: 0, cobradoHoy: 0, ventasActivas: 0 })
  const [route, setRoute] = useState<{ nombre: string } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user?.routeId) { setLoading(false); return }
    const r = await db.routes.get(user.routeId)
    setRoute(r ?? null)
    const sales = await db.sales.where('routeId').equals(user.routeId).and(s => s.status === 'activa').toArray()
    const todayStr = today()
    const payments = await db.payments.where('routeId').equals(user.routeId).and(p => p.fecha === todayStr).toArray()
    const cobradoHoy = payments.reduce((s, p) => s + p.valor, 0)
    // Pendientes = clientes con cuota de hoy sin pago
    const installments = await db.installments.toArray()
    const salePaidToday = new Set(payments.map(p => p.saleId))
    const pendientes = sales.filter(s => !salePaidToday.has(s.id)).length
    setStats({ pendientes, cobradoHoy, ventasActivas: sales.length })
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
        {route && (
          <div className="flex items-center gap-1.5 mt-2 text-primary-200 text-sm">
            <MapPin className="w-3.5 h-3.5" />
            {route.nombre}
          </div>
        )}
        <p className="text-primary-200 text-xs mt-1">{formatDate(today())}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl p-4 shadow-card border border-gray-100 text-center">
          <p className="text-2xl font-bold text-amber-500">{stats.pendientes}</p>
          <p className="text-xs text-gray-500 mt-0.5">Pendientes</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-card border border-gray-100 text-center">
          <p className="text-lg font-bold text-emerald-600 leading-tight">{formatCurrency(stats.cobradoHoy)}</p>
          <p className="text-xs text-gray-500 mt-0.5">Cobrado hoy</p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-card border border-gray-100 text-center">
          <p className="text-2xl font-bold text-primary-600">{stats.ventasActivas}</p>
          <p className="text-xs text-gray-500 mt-0.5">Activos</p>
        </div>
      </div>

      {/* Action button */}
      <Button
        fullWidth
        size="xl"
        onClick={() => navigate('/collector/route')}
        icon={<MapPin className="w-5 h-5" />}
        className="h-14 text-base rounded-2xl"
      >
        Iniciar ruta
      </Button>

      {/* Quick actions */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Acciones rápidas</p>
        {[
          { label: 'Ver mi ruta completa', path: '/collector/route', icon: <MapPin className="w-4 h-4 text-primary-500" /> },
          { label: 'Registrar gasto', path: '/collector/expenses', icon: <DollarSign className="w-4 h-4 text-red-500" /> },
          { label: 'Sincronizar pagos', path: '/collector/sync', icon: <Users className="w-4 h-4 text-emerald-500" /> },
        ].map(a => (
          <button
            key={a.path}
            onClick={() => navigate(a.path)}
            className="w-full flex items-center justify-between bg-white rounded-xl px-4 py-3.5 shadow-card border border-gray-100 hover:border-primary-200 transition-colors"
          >
            <div className="flex items-center gap-3">
              {a.icon}
              <span className="text-sm font-medium text-gray-700">{a.label}</span>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-300" />
          </button>
        ))}
      </div>
    </div>
  )
}
