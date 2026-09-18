import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Building2, Receipt, Settings, LogOut, Info } from 'lucide-react'
import { useOwnerAuth } from '@/hooks/useOwnerAuth'
import { CONTROL_PLANE_IS_SHARED, CONTROL_PLANE_SCOPE_NOTICE } from '@/platform/controlPlane'

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

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
      isActive ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
    }`

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-gray-900 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">RC</span>
          </div>
          <div>
            <p className="font-bold text-gray-900 leading-tight">RutaCash</p>
            <p className="text-xs text-gray-500">Gestión de la plataforma</p>
          </div>
        </div>

        <nav className="flex items-center gap-1">
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
        </nav>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-gray-800 leading-tight">{owner?.nombre}</p>
            <p className="text-xs text-gray-400">Owner</p>
          </div>
          <button
            onClick={() => { logout(); navigate('/owner/login') }}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
          >
            <LogOut className="w-4 h-4" /> Salir
          </button>
        </div>
      </header>

      {!CONTROL_PLANE_IS_SHARED && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-2">
          <Info className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <p className="text-xs text-amber-800">{CONTROL_PLANE_SCOPE_NOTICE}</p>
        </div>
      )}

      <main className="p-6">
        <Outlet />
      </main>
    </div>
  )
}
