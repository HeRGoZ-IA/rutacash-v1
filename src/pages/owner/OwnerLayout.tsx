import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Building2, Receipt, Settings, LogOut, Info, Menu, X } from 'lucide-react'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { CONTROL_PLANE_IS_SHARED, CONTROL_PLANE_SCOPE_NOTICE } from '@/platform/controlPlane'
import { BrandLogo } from '@/components/ui/BrandLogo'

/**
 * MARCO DEL PORTAL OWNER.
 *
 * Deliberadamente distinto del panel de empresa: no se reutiliza `AdminLayout`. El
 * menú solo contiene gestión SaaS —Dashboard, Empresas, Cobros— y no existe ninguna
 * entrada a clientes, ventas, pagos, cartera, caja, documentos o cobradores. No es
 * que estén ocultas: no están.
 *
 * El aviso de alcance no es decorativo: mientras no haya backend compartido, lo que
 * se ve aquí es lo ocurrido EN ESTE DISPOSITIVO. Decirlo en pantalla es parte de no
 * fingir una sincronización que no existe.
 */
export function OwnerLayout() {
  const { owner, logout } = useOwnerAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // Ronda 50: en móvil y tableta el menú se despliega con un botón (antes desbordaba).
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { setMenuOpen(false) }, [pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])
  const salir = () => { logout(); navigate('/owner/login') }

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
      isActive ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
    }`

  const links = (
    <>
      <NavLink to="/owner" end className={link}>
        <LayoutDashboard className="w-4 h-4" /> Dashboard
      </NavLink>
      <NavLink to="/owner/empresas" className={link}>
        <Building2 className="w-4 h-4" /> Empresas
      </NavLink>
      <NavLink to="/owner/cobros" className={link}>
        <Receipt className="w-4 h-4" /> Cobros
      </NavLink>
      <NavLink to="/owner/configuracion" className={link}>
        <Settings className="w-4 h-4" /> Configuración
      </NavLink>
    </>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="relative bg-white border-b border-gray-200 px-4 lg:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <BrandLogo variant="primary" className="h-9 -ml-1 flex-shrink-0" />
          <p className="text-xs text-gray-500 border-l border-gray-200 pl-3 hidden sm:block">Gestión de la plataforma</p>
        </div>

        <nav className="hidden lg:flex items-center gap-1" aria-label="Menú del Owner">
          {links}
        </nav>

        <div className="hidden lg:flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-medium text-gray-800 leading-tight">{owner?.nombre}</p>
            <p className="text-xs text-gray-500">Owner</p>
          </div>
          <button type="button" onClick={salir} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
            <LogOut className="w-4 h-4" /> Salir
          </button>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          aria-expanded={menuOpen}
          aria-controls="owner-menu"
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
          className="lg:hidden -mr-2 p-2.5 rounded-xl text-gray-600 hover:bg-gray-100"
          data-testid="owner-menu-toggle"
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>

        {menuOpen && (
          <div id="owner-menu" className="lg:hidden absolute inset-x-0 top-full z-40 bg-white border-b border-gray-200 shadow-lg px-4 py-3 space-y-3">
            <nav className="flex flex-col gap-1" aria-label="Menú del Owner">{links}</nav>
            <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 leading-tight truncate">{owner?.nombre}</p>
                <p className="text-xs text-gray-500">Owner</p>
              </div>
              <button type="button" onClick={salir} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm text-gray-600 hover:bg-gray-100">
                <LogOut className="w-4 h-4" /> Salir
              </button>
            </div>
          </div>
        )}
      </header>

      {!CONTROL_PLANE_IS_SHARED && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 lg:px-6 py-2 flex items-center gap-2">
          <Info className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <p className="text-xs text-amber-800">{CONTROL_PLANE_SCOPE_NOTICE}</p>
        </div>
      )}

      <main className="p-4 lg:p-6">
        <Outlet />
      </main>
    </div>
  )
}
