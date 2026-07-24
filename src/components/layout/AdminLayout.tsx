import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Users, MapPin, CreditCard, Wallet,
  ArrowLeftRight, TrendingDown, Archive, BarChart3, CalendarRange,
  Settings, LogOut, Menu, Wifi, WifiOff, DollarSign, ClipboardCheck, Receipt, ArrowLeft
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { cn } from '@/lib/utils'
import { initials } from '@/lib/formatters'
import { AppModeBanner } from '@/components/ui/AppModeBanner'
import { CountBadge } from '@/components/ui/CountBadge'
import { countPendingSaleRequests } from '@/services/saleRequestService'
import { countPendingAdjustmentRequests } from '@/services/paymentCorrectionService'
import { hasOperationalRoutes, ROLE_LABELS } from '@/lib/permissions'
import { AdminNoRoutes } from '@/components/layout/AdminNoRoutes'

interface NavItem {
  path: string
  label: string
  icon: React.ReactNode
  roles?: string[]
}

const navItems: NavItem[] = [
  { path: '/admin/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { path: '/admin/routes', label: 'Rutas', icon: <MapPin className="w-4 h-4" /> },
  { path: '/admin/clients', label: 'Clientes', icon: <Users className="w-4 h-4" /> },
  { path: '/admin/active-sales', label: 'Ventas Activas', icon: <CreditCard className="w-4 h-4" /> },
  { path: '/admin/sale-authorizations', label: 'Autorizaciones', icon: <ClipboardCheck className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/payment-adjustments', label: 'Ajustes de pago', icon: <Receipt className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/capital', label: 'Capital', icon: <DollarSign className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/expenses', label: 'Gastos', icon: <TrendingDown className="w-4 h-4" /> },
  { path: '/admin/transfers', label: 'Transferencias', icon: <ArrowLeftRight className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/withdrawals', label: 'Retiros', icon: <Wallet className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/cashbox', label: 'Caja', icon: <Archive className="w-4 h-4" /> },
  { path: '/admin/reports', label: 'Reportes', icon: <BarChart3 className="w-4 h-4" /> },
  { path: '/admin/weekly-settlement', label: 'Liquidación', icon: <CalendarRange className="w-4 h-4" /> },
  { path: '/admin/users', label: 'Usuarios', icon: <Users className="w-4 h-4" />, roles: ['admin', 'superadmin'] },
  { path: '/admin/settings', label: 'Configuración', icon: <Settings className="w-4 h-4" /> },
]

export function AdminLayout() {
  const { user, tenant, logout, exitTenantContext } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const isSuperadmin = user?.rol === 'superadmin'
  const roleLabel = user ? ROLE_LABELS[user.rol] : ''

  // Volver a Empresas (solo Super Admin): limpia el tenant y navega a /platform,
  // conservando la sesión de Super Admin.
  const backToPlatform = () => { exitTenantContext(); navigate('/platform') }
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pendingAuth, setPendingAuth] = useState(0)
  const [pendingAdj, setPendingAdj] = useState(0)

  // Badges: solicitudes de venta y de ajuste de pago pendientes por revisar.
  const tenantId = tenant?.id ?? user?.tenantId ?? ''
  useEffect(() => {
    let alive = true
    countPendingSaleRequests(tenantId).then(n => { if (alive) setPendingAuth(n) })
    countPendingAdjustmentRequests(tenantId).then(n => { if (alive) setPendingAdj(n) })
    return () => { alive = false }
  }, [tenantId, location.pathname])

  const badges: Record<string, number> = {
    '/admin/sale-authorizations': pendingAuth,
    '/admin/payment-adjustments': pendingAdj,
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const visibleItems = navItems.filter(
    (item) => !item.roles || !user?.rol || item.roles.includes(user.rol)
  )

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo + rol real (nunca "Admin" fijo: refleja ROLE_LABELS del usuario) */}
      <div className="px-5 py-5 border-b border-primary-800/40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-primary-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">RC</span>
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">RutaCash</p>
            <p className="text-primary-300 text-xs opacity-70">{roleLabel}</p>
          </div>
        </div>
      </div>

      {/* Volver a Empresas (solo Super Admin operando dentro de una empresa) */}
      {isSuperadmin && (
        <button
          onClick={() => { backToPlatform(); setSidebarOpen(false) }}
          className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-primary-200 hover:bg-primary-800 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Volver a Empresas
        </button>
      )}

      {/* Empresa activa + rol (encabezado del contexto) */}
      {tenant && (
        <div className="mx-3 mt-3 px-3 py-2.5 bg-primary-800/70 rounded-xl">
          <p className="text-white text-xs font-medium truncate">{tenant.nombre}</p>
          <p className="text-primary-300 text-[11px] leading-tight">{roleLabel}</p>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {visibleItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-300 hover:bg-primary-800 hover:text-white'
              )
            }
          >
            {item.icon}
            <span className="flex-1">{item.label}</span>
            {badges[item.path] > 0 && <CountBadge count={badges[item.path]} />}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div className="px-3 py-4 border-t border-primary-800/40">
        <div className="flex items-center gap-3 mb-3 px-2">
          <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials(user?.nombre ?? 'U')}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-medium truncate">{user?.nombre}</p>
            <p className="text-gray-400 text-xs">{roleLabel}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white hover:bg-primary-800 rounded-xl text-sm transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Cerrar sesión
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar Desktop */}
      <aside className="hidden lg:flex flex-col w-56 bg-primary-900 flex-shrink-0">
        <SidebarContent />
      </aside>

      {/* Sidebar Mobile Overlay */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="fixed left-0 top-0 bottom-0 w-64 bg-primary-900 z-50 lg:hidden flex flex-col">
            <SidebarContent />
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-14 bg-white border-b border-gray-200 flex items-center gap-3 px-4 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 rounded-lg hover:bg-gray-100 text-gray-500"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0 flex items-center gap-2">
            {isSuperadmin && (
              <button onClick={backToPlatform}
                className="lg:hidden flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700 flex-shrink-0">
                <ArrowLeft className="w-4 h-4" /> Empresas
              </button>
            )}
            {tenant && (
              <span className="text-sm font-medium text-gray-600 truncate">{tenant.nombre}{isSuperadmin ? ' · Super Admin' : ''}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
                isOnline
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-red-50 text-red-600'
              )}
            >
              {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span className="hidden sm:inline">{isOnline ? 'En línea' : 'Sin conexión'}</span>
            </div>

            <div className="w-8 h-8 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 text-xs font-bold">
              {initials(user?.nombre ?? 'U')}
            </div>
          </div>
        </header>

        {/* Mode banner */}
        <AppModeBanner />

        {/* Offline banner */}
        {!isOnline && (
          <div className="bg-amber-500 text-white text-xs text-center py-1.5 font-medium flex items-center justify-center gap-2">
            <WifiOff className="w-3.5 h-3.5" />
            Sin conexión — los cambios se guardan localmente
          </div>
        )}

        {/* Page content. FAIL CLOSED: un Administrador sin rutas autorizadas no accede
            a ninguna pantalla operativa; solo ve la pantalla informativa + su cuenta. */}
        <main className="flex-1 overflow-y-auto">
          {user?.rol === 'admin' && !hasOperationalRoutes(user) ? <AdminNoRoutes /> : <Outlet />}
        </main>
      </div>
    </div>
  )
}
