import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useLocation, Navigate } from 'react-router-dom'
import { Home, MapPin, DollarSign, Banknote, Calculator, LogOut, WifiOff, Wifi, ShieldAlert, ChevronDown } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { countPendingDisbursements } from '@/services/saleRequestService'
import { db } from '@/lib/db'
import { cn } from '@/lib/utils'
import { AppModeBanner } from '@/components/ui/AppModeBanner'
import { CountBadge } from '@/components/ui/CountBadge'
import type { Route } from '@/models/types'

export function CollectorLayout() {
  const { user, logout } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const { activeRouteId, setActiveRouteId } = useCollectorRoute()
  const [routes, setRoutes] = useState<Route[] | null>(null) // null = cargando
  const [pendingDisb, setPendingDisb] = useState(0)

  useEffect(() => { loadRoutes() }, [user])

  // Conteo de desembolsos pendientes de la ruta activa. Se refresca al cambiar de
  // ruta o de pantalla (p. ej. tras confirmar un desembolso y volver al dashboard).
  useEffect(() => {
    let alive = true
    if (activeRouteId) {
      countPendingDisbursements(activeRouteId).then(n => { if (alive) setPendingDisb(n) })
    } else {
      setPendingDisb(0)
    }
    return () => { alive = false }
  }, [activeRouteId, location.pathname])

  async function loadRoutes() {
    if (!user) { setRoutes([]); return }
    const ids = getAuthorizedRouteIds(user)
    const all = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    setRoutes(all.filter(r => ids.includes(r.id)))
  }

  const activeRoute = routes?.find(r => r.id === activeRouteId) ?? null

  // Con una sola ruta: se selecciona automáticamente (entra directo, ruta visible)
  useEffect(() => {
    if (routes && routes.length === 1 && (!activeRouteId || !routes.some(r => r.id === activeRouteId))) {
      setActiveRouteId(routes[0].id)
    }
  }, [routes, activeRouteId, setActiveRouteId])

  // Vocabulario cobrador: Recaudo, Desembolsos, Gastos, Cuadre.
  const navItems = [
    { path: '/collector/home', label: 'Inicio', icon: <Home className="w-5 h-5" />, badge: 0 },
    { path: '/collector/route', label: 'Recaudo', icon: <MapPin className="w-5 h-5" />, badge: 0 },
    { path: '/collector/disbursements', label: 'Desembolsos', icon: <Banknote className="w-5 h-5" />, badge: pendingDisb },
    { path: '/collector/expenses', label: 'Gastos', icon: <DollarSign className="w-5 h-5" />, badge: 0 },
    { path: '/collector/cashclose', label: 'Cuadre', icon: <Calculator className="w-5 h-5" />, badge: 0 },
  ]

  const onSelectPage = location.pathname === '/collector/select-route'

  // --- Estados de carga / sin rutas / gating de selección ---
  if (routes === null) {
    return <div className="flex items-center justify-center h-screen bg-gray-50"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  if (routes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 px-6 text-center max-w-md mx-auto">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mb-4">
          <ShieldAlert className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">No tienes rutas asignadas</h1>
        <p className="text-sm text-gray-500 mt-1">Contacta al administrador.</p>
        <button onClick={() => { logout(); navigate('/login') }} className="mt-6 flex items-center gap-2 text-primary-600 text-sm font-medium">
          <LogOut className="w-4 h-4" /> Cerrar sesión
        </button>
      </div>
    )
  }

  // Debe seleccionar ruta primero (varias rutas y ninguna activa válida)
  if (!activeRoute && !onSelectPage) {
    return <Navigate to="/collector/select-route" replace />
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50 max-w-md mx-auto">
      {/* Header */}
      <header className="bg-primary-700 text-white px-4 py-2.5 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
            <span className="text-white font-bold text-xs">RC</span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm leading-tight">RutaCash</p>
            {activeRoute && !onSelectPage ? (
              <button onClick={() => navigate('/collector/select-route')} className="flex items-center gap-1 text-primary-100 text-xs leading-tight hover:text-white transition-colors">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="truncate max-w-[150px]">{activeRoute.nombre}</span>
                {routes.length > 1 && <ChevronDown className="w-3 h-3 flex-shrink-0" />}
              </button>
            ) : (
              <p className="text-primary-200 text-xs leading-tight truncate">{user?.nombre}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className={cn('flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full', isOnline ? 'bg-emerald-500/25 text-emerald-100' : 'bg-red-500/25 text-red-100')}>
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {isOnline ? 'Online' : 'Offline'}
          </div>
          <button onClick={() => { logout(); navigate('/login') }} className="p-2 rounded-lg hover:bg-primary-600 transition-colors" aria-label="Cerrar sesión">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Mode banner */}
      <AppModeBanner />

      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-amber-500 text-white text-xs text-center py-1.5 font-medium">
          Sin conexión — guardando localmente
        </div>
      )}

      {/* Content */}
      <main className={cn('flex-1 overflow-y-auto', onSelectPage ? '' : 'pb-16')}>
        <Outlet />
      </main>

      {/* Bottom nav (oculto en selección de ruta) */}
      {!onSelectPage && (
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-gray-200 flex px-1 pb-[env(safe-area-inset-bottom)]">
          {navItems.map(item => (
            <NavLink key={item.path} to={item.path} className="flex-1">
              {({ isActive }) => (
                <div className="flex flex-col items-center gap-1 py-1.5">
                  <div className={cn(
                    'relative flex items-center justify-center w-12 h-7 rounded-full transition-colors',
                    isActive ? 'bg-primary-50 text-primary-600' : 'text-gray-400'
                  )}>
                    {item.icon}
                    {item.badge > 0 && <CountBadge count={item.badge} className="absolute -top-1.5 right-1.5" />}
                  </div>
                  <span className={cn('text-[10px] font-medium leading-none transition-colors', isActive ? 'text-primary-600' : 'text-gray-400')}>
                    {item.label}
                  </span>
                </div>
              )}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}
