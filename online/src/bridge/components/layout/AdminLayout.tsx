// ADEX Online: COPIA del AdminLayout original de CLEAN (src/components/layout/AdminLayout.tsx).
// La estructura, las clases, la navegación y los textos son los originales. Cambios, todos
// marcados con «ADEX Online:» y justificados por las mejoras del SaaS:
//   1. Banner sin conexión: CLEAN guardaba localmente; ADEX Online no guarda nada en el
//      dispositivo, así que el texto dice la verdad.
//   2. Banner «Activando el servidor» (primera petición tras un rato sin uso) y banner de
//      Empresa Demo (datos ficticios), con la misma forma que el banner sin conexión.
//   3. Bloque de usuario: «Cambiar empresa o rol» (DS-05: una membresía activa, sin permisos
//      acumulados), con el mismo estilo que «Cerrar sesión». Solo aparece si la persona
//      tiene más de una membresía: con una sola, el menú es idéntico al de CLEAN.
//   4. Ronda 59 · DINERO: Administrador = Caja principal, Gastos, Transferencias, Notificaciones,
//      Consultas; SuperAdmin = Capital, Gastos, Notificaciones, Consultas. Sin Retiros (saldo
//      heredado de antiguas cajas de ruta) ni Historial aparte: los historiales están en Consultas.
//   5. Ronda 67: CARTERA del SuperAdmin = solo Clientes (consulta). Ventas Activas, Autorizaciones y
//      Ajustes de pago son del Administrador (sus URL también están protegidas en CleanOnlineApp).
//      «Mapa» (Cartera) es solo del Administrador.
//   6. Ronda 74 · Base por Ruta: con `route_base`, «Capital» del SuperAdmin se llama «Panel de rutas»
//      (panel de solo lectura; ya no mueve capital). Con `admin_pool`, el menú no cambia.
import { useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Users, MapPin, CreditCard,
  ArrowLeftRight, TrendingDown, BarChart3, CalendarRange,
  Settings, LogOut, Menu, Wifi, WifiOff, DollarSign, ClipboardCheck, Receipt, Building2, Bell, Search, Map as MapIcon, Scale } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { cn } from '@/lib/utils'
import { initials } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'
import { CountBadge } from '@/components/ui/CountBadge'
import { usePendingSaleRequests, usePendingAdjustmentRequests } from '@/hooks/usePendingBadges'
import { hasOperationalRoutes, ROLE_LABELS } from '@/lib/permissions'
import { AdminNoRoutes } from '@/components/layout/AdminNoRoutes'
import { BrandLogo } from '@/components/ui/BrandLogo'
// ADEX Online: contexto y sesión del servidor.
import { Repeat, Loader2 } from 'lucide-react'
import { leaveContext, useRuntime } from '../../../runtime/session.ts'
import { useNotificationCount } from '../../../runtime/capitalRequests.ts'
import { isRouteBaseUi, useCapitalModel } from '../../../runtime/routeBase/api.ts'

interface NavItem {
  path: string
  label: string
  icon: React.ReactNode
  roles?: string[]
  /** Ronda 50: sección del menú (mismos nombres y rutas; solo se agrupan). */
  group?: NavGroup
}

type NavGroup = 'Estructura' | 'Cartera' | 'Dinero' | 'Control'
const GROUP_ORDER: (NavGroup | undefined)[] = [undefined, 'Estructura', 'Cartera', 'Dinero', 'Control']

const navItems: NavItem[] = [
  { path: '/admin/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  // Oficinas = CATÁLOGO/agrupación. No sustituye a Rutas: las rutas siguen siendo
  // accesibles directamente, sin obligar a pasar por una Oficina.
  { path: '/admin/offices', label: 'Oficinas', icon: <Building2 className="w-4 h-4" />, roles: ['admin', 'superadmin'], group: 'Estructura' },
  { path: '/admin/routes', label: 'Rutas', icon: <MapPin className="w-4 h-4" />, group: 'Estructura' },
  { path: '/admin/clients', label: 'Clientes', icon: <Users className="w-4 h-4" />, group: 'Cartera' },
  { path: '/admin/active-sales', label: 'Ventas Activas', icon: <CreditCard className="w-4 h-4" />, roles: ['admin'], group: 'Cartera' },
  { path: '/admin/sale-authorizations', label: 'Autorizaciones', icon: <ClipboardCheck className="w-4 h-4" />, roles: ['admin'], group: 'Cartera' },
  { path: '/admin/payment-adjustments', label: 'Ajustes de pago', icon: <Receipt className="w-4 h-4" />, roles: ['admin'], group: 'Cartera' },
  // Ronda 67: mapa de clientes y actividad de las rutas del Administrador (no es seguimiento en tiempo real).
  { path: '/admin/mapa', label: 'Mapa', icon: <MapIcon className="w-4 h-4" />, roles: ['admin'], group: 'Cartera' },
  // Ronda 3/6: para el Administrador, Capital es su CAJA PRINCIPAL (misma página y bolsa).
  { path: '/admin/capital', label: 'Caja principal', icon: <DollarSign className="w-4 h-4" />, roles: ['admin'], group: 'Dinero' },
  { path: '/admin/capital', label: 'Capital', icon: <DollarSign className="w-4 h-4" />, roles: ['superadmin'], group: 'Dinero' },
  { path: '/admin/expenses', label: 'Gastos', icon: <TrendingDown className="w-4 h-4" />, group: 'Dinero' },
  // Ronda 59: Transferencias es del Administrador; el SuperAdmin opera su capital en Capital.
  { path: '/admin/transfers', label: 'Transferencias', icon: <ArrowLeftRight className="w-4 h-4" />, roles: ['admin'], group: 'Dinero' },
  { path: '/admin/notificaciones', label: 'Notificaciones', icon: <Bell className="w-4 h-4" />, roles: ['admin', 'superadmin'], group: 'Dinero' },
  // Ronda 59: «Caja» pasa a Consultas (movimientos, caja por ruta, historial y filtros).
  { path: '/admin/consultas', label: 'Consultas', icon: <Search className="w-4 h-4" />, roles: ['admin', 'superadmin'], group: 'Dinero' },
  { path: '/admin/reports', label: 'Reportes', icon: <BarChart3 className="w-4 h-4" />, group: 'Control' },
  { path: '/admin/weekly-settlement', label: 'Liquidación', icon: <CalendarRange className="w-4 h-4" />, group: 'Control' },
  // R74 (0036): faltantes y sobrantes; los concilia el Administrador responsable (el SuperAdmin, solo lectura).
  { path: '/admin/diferencias', label: 'Diferencias', icon: <Scale className="w-4 h-4" />, roles: ['admin', 'superadmin'], group: 'Control' },
  { path: '/admin/users', label: 'Usuarios', icon: <Users className="w-4 h-4" />, roles: ['admin', 'superadmin'], group: 'Estructura' },
  { path: '/admin/settings', label: 'Configuración', icon: <Settings className="w-4 h-4" /> },
]

export function AdminLayout() {
  const { user, tenant, logout } = useAuth()
  const isOnline = useOnlineStatus()
  const navigate = useNavigate()
  const location = useLocation()
  const isSuperadmin = user?.rol === 'superadmin'
  const roleLabel = user ? ROLE_LABELS[user.rol] : ''
  // YA NO EXISTE «Volver a Empresas». Con la separación Plataforma/Empresa, un Super
  // Admin pertenece a UNA empresa y no hay ninguna lista de empresas a la que volver:
  // la gestión de empresas es del Owner y vive en otro portal, con otra sesión.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Badges: solicitudes de venta y de ajuste de pago pendientes por revisar.
  // Recortados por RUTAS AUTORIZADAS (antes contaban toda la empresa) y reactivos
  // dentro del mismo dispositivo. Ver `usePendingBadges`.
  const tenantId = tenant?.id ?? user?.tenantId ?? ''
  const pendingAuth = usePendingSaleRequests(user, tenantId)
  const pendingAdj = usePendingAdjustmentRequests(user, tenantId)

  // Ronda 59: solo lo que requiere actuar (solicitudes a atender y confirmaciones).
  const pendingNotices = useNotificationCount()
  const badges: Record<string, number> = {
    '/admin/sale-authorizations': pendingAuth,
    '/admin/payment-adjustments': pendingAdj,
    '/admin/notificaciones': pendingNotices,
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }
  // ADEX Online: cambiar de membresía (vuelve al selector de empresa y rol).
  const waking = useRuntime((s) => s.waking)
  const isDemo = useRuntime((s) => s.ctx?.company.isDemo === true)
  const multiMembership = useRuntime((s) => s.membershipCount > 1)
  const handleSwitch = () => {
    void leaveContext().then(() => navigate('/contexto'))
  }

  const capitalModel = useCapitalModel()
  const visibleItems = navItems.filter(
    (item) => !item.roles || !user?.rol || item.roles.includes(user.rol)
  ).map((item) => (isRouteBaseUi(capitalModel) && item.path === '/admin/capital' && item.label === 'Capital' ? { ...item, label: 'Panel de rutas' } : item))
  // Ronda 50: secciones en orden fijo; Configuración siempre al final.
  const settings = visibleItems.filter((i) => i.path === '/admin/settings')
  const sections = GROUP_ORDER
    .map((g) => ({ group: g, items: visibleItems.filter((i) => i.group === g && i.path !== '/admin/settings') }))
    .filter((s) => s.items.length > 0)
  const renderItem = (item: NavItem) => (
    <NavLink
      key={`${item.path}-${item.label}`}
      to={item.path}
      onClick={() => setSidebarOpen(false)}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-1.5 lg:py-1 rounded-xl text-sm font-medium transition-colors',
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
  )

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo + rol real (nunca "Admin" fijo: refleja ROLE_LABELS del usuario) */}
      <div className="px-5 py-4 border-b border-primary-800/40">
        <div>
          <BrandLogo variant="on-dark" className="h-10 lg:h-12 -ml-1.5" />
          {!tenant && <p className="text-primary-300 text-xs opacity-70 mt-0.5">{roleLabel}</p>}
        </div>
      </div>

      {/* Empresa activa + rol (encabezado del contexto).
          "Volver a Empresas" vive en el ENCABEZADO superior (junto al título), no en
          el menú ni como botón flotante. */}
      {tenant && (
        <div className="mx-3 mt-3 px-3 py-2.5 bg-primary-800/70 rounded-xl">
          <p className="text-white text-xs font-medium truncate">{tenant.nombre}</p>
          <p className="text-primary-300 text-[11px] leading-tight">{roleLabel}</p>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-2.5" aria-label="Menú principal" data-testid="admin-nav">
        {sections.map(({ group, items }) => (
          <div key={group ?? 'inicio'} className={group ? 'mt-2 first:mt-0' : ''} role={group ? 'group' : undefined} aria-label={group}>
            {group && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-primary-300/80">{group}</p>}
            <div className="space-y-0.5">{items.map(renderItem)}</div>
          </div>
        ))}
        {settings.length > 0 && <div className="mt-2 pt-2 border-t border-primary-800/40 space-y-0.5">{settings.map(renderItem)}</div>}
      </nav>

      {/* User */}
      <div className="px-3 py-3 border-t border-primary-800/40">
        <div className="flex items-center gap-3 mb-2 px-2">
          <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {initials(user?.nombre ?? 'U')}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-medium truncate">{formatPersonName(user?.nombre)}</p>
            <p className="text-gray-400 text-xs">{roleLabel}</p>
          </div>
        </div>
        {/* ADEX Online: cambiar de empresa o rol (DS-05). Mismo estilo que «Cerrar sesión». */}
        {multiMembership && (
          <button
            onClick={handleSwitch}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-400 hover:text-white hover:bg-primary-800 rounded-xl text-sm transition-colors"
          >
            <Repeat className="w-4 h-4" />
            Cambiar empresa o rol
          </button>
        )}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-400 hover:text-white hover:bg-primary-800 rounded-xl text-sm transition-colors"
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
        {/* ADEX Online: Empresa Demo (todos los datos son ficticios). */}
        {isDemo && (
          <div className="bg-primary-600 text-white text-xs text-center py-1.5 font-medium flex items-center justify-center gap-2">
            Empresa Demo · todos los clientes y movimientos son ficticios
          </div>
        )}

        {/* Offline banner */}
        {!isOnline && (
          <div className="bg-amber-500 text-white text-xs text-center py-1.5 font-medium flex items-center justify-center gap-2">
            <WifiOff className="w-3.5 h-3.5" />
            {/* ADEX Online: nada se guarda en el dispositivo (CLEAN: «los cambios se guardan localmente»). */}
            Sin conexión con el servidor — nada se guarda en este dispositivo; reintente al volver la conexión
          </div>
        )}
        {/* ADEX Online: «activando» solo si el servicio no responde ni a /healthz; si responde, la consulta tarda. */}
        {isOnline && waking && (
          <div className="bg-primary-600 text-white text-xs text-center py-1.5 font-medium flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {waking === 'starting'
              ? 'Activando el servidor: la primera conexión puede tardar hasta un minuto. No repita la operación.'
              : 'Consultando el servidor: la respuesta está tardando más de lo normal. No repita la operación.'}
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
