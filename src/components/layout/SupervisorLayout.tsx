import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { LogOut, ArrowLeft, Wifi, WifiOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { cn } from '@/lib/utils'
import { AppModeBanner } from '@/components/ui/AppModeBanner'

/**
 * Paquete 3 — Layout simple para el rol Supervisor.
 * Reutiliza el estilo de la app del cobrador (móvil, centrado), sin acceso
 * al panel admin. Muestra botón "Atrás" cuando no está en el home.
 */
export function SupervisorLayout() {
  const { user, logout } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()
  const location = useLocation()

  const isHome = location.pathname === '/supervisor/home'

  return (
    <div className="flex flex-col h-screen bg-gray-50 max-w-md mx-auto">
      {/* Header */}
      <header className="bg-primary-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {!isHome && (
            <button onClick={() => navigate('/supervisor/home')} className="p-1.5 rounded-lg hover:bg-primary-600 flex-shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0">
            <p className="font-bold text-sm">RutaCash · Supervisor</p>
            <p className="text-primary-200 text-xs truncate">{user?.nombre}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className={cn('flex items-center gap-1 text-xs px-2 py-1 rounded-full', isOnline ? 'bg-emerald-500/30 text-emerald-200' : 'bg-red-500/30 text-red-200')}>
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {isOnline ? 'Online' : 'Offline'}
          </div>
          <button onClick={() => { logout(); navigate('/login') }} className="p-1.5 rounded-lg hover:bg-primary-600">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <AppModeBanner />

      <main className="flex-1 overflow-y-auto pb-6">
        <Outlet />
      </main>
    </div>
  )
}
