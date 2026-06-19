import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Home, MapPin, DollarSign, RefreshCw, LogOut, WifiOff, Wifi } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { cn } from '@/lib/utils'
import { AppModeBanner } from '@/components/ui/AppModeBanner'

export function CollectorLayout() {
  const { user, logout } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()

  const navItems = [
    { path: '/collector/home', label: 'Inicio', icon: <Home className="w-5 h-5" /> },
    { path: '/collector/route', label: 'Ruta', icon: <MapPin className="w-5 h-5" /> },
    { path: '/collector/expenses', label: 'Gastos', icon: <DollarSign className="w-5 h-5" /> },
    { path: '/collector/sync', label: 'Sync', icon: <RefreshCw className="w-5 h-5" /> },
  ]

  return (
    <div className="flex flex-col h-screen bg-gray-50 max-w-md mx-auto">
      {/* Header */}
      <header className="bg-primary-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="font-bold text-sm">RutaCash</p>
          <p className="text-primary-200 text-xs">{user?.nombre}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className={cn('flex items-center gap-1 text-xs px-2 py-1 rounded-full', isOnline ? 'bg-emerald-500/30 text-emerald-200' : 'bg-red-500/30 text-red-200')}>
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {isOnline ? 'Online' : 'Offline'}
          </div>
          <button onClick={() => { logout(); navigate('/login') }} className="p-1.5 rounded-lg hover:bg-primary-600">
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
      <main className="flex-1 overflow-y-auto pb-16">
        <Outlet />
      </main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-gray-200 flex">
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                'flex-1 flex flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors',
                isActive ? 'text-primary-600' : 'text-gray-400'
              )
            }
          >
            {item.icon}
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
