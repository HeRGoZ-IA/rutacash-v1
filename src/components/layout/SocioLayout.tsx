import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Users, BarChart3, Wallet, UserCog, LogOut, Wifi, WifiOff } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { cn } from '@/lib/utils'
import { initials } from '@/lib/formatters'
import { AppModeBanner } from '@/components/ui/AppModeBanner'

/**
 * Layout del SOCIO (perfil de consulta / solo lectura).
 * Navegación propia: Resumen, Clientes, Reportes, Mi caja, Cuenta. No expone
 * ninguna acción operativa (crear/editar/pagos/transferencias).
 */
const nav = [
  { to: '/socio/resumen', label: 'Resumen', icon: <LayoutDashboard className="w-4 h-4" /> },
  { to: '/socio/clientes', label: 'Clientes', icon: <Users className="w-4 h-4" /> },
  { to: '/socio/reportes', label: 'Reportes', icon: <BarChart3 className="w-4 h-4" /> },
  { to: '/socio/caja', label: 'Mi caja', icon: <Wallet className="w-4 h-4" /> },
  { to: '/socio/cuenta', label: 'Cuenta', icon: <UserCog className="w-4 h-4" /> },
]

export function SocioLayout() {
  const { user, tenant, logout } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-primary-900 text-white flex-shrink-0">
        <div className="px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-primary-600 rounded-xl flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-sm">RC</span>
            </div>
            <div className="min-w-0">
              <p className="font-bold text-sm leading-tight">RutaCash · Socio</p>
              <p className="text-primary-300 text-xs truncate">{tenant?.nombre ?? user?.nombre}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className={cn('flex items-center gap-1 text-[11px] px-2 py-1 rounded-full', isOnline ? 'bg-emerald-500/25 text-emerald-100' : 'bg-red-500/25 text-red-100')}>
              {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {isOnline ? 'Online' : 'Offline'}
            </div>
            <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center text-white text-xs font-bold">{initials(user?.nombre ?? 'S')}</div>
            <button onClick={() => { logout(); navigate('/login') }} className="p-2 rounded-lg hover:bg-primary-800" aria-label="Cerrar sesión">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        <nav className="px-2 md:px-4 flex gap-1 overflow-x-auto">
          {nav.map(n => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => cn(
                'flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
                isActive ? 'border-white text-white' : 'border-transparent text-primary-300 hover:text-white'
              )}>
              {n.icon}{n.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <AppModeBanner />

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
