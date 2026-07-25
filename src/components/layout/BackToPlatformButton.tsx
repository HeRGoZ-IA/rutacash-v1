import { useNavigate } from 'react-router-dom'
import { Building2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * Botón FLOTANTE "Volver a Empresas" (patrón tipo pestaña lateral, estilo Agente F).
 * Fijo en el borde derecho; en estado cerrado es compacto (solo icono) y al pasar el
 * cursor / enfocar se expande hacia la izquierda mostrando el texto.
 *
 * Visibilidad: SOLO role='superadmin' y cuando hay un tenant activo (operando dentro
 * de una empresa). No aparece en /platform ni para otros roles.
 *
 * Reutiliza `exitTenantContext()` (no duplica lógica): limpia tenant + ruta activa,
 * conserva la sesión y navega a /platform. z-30 → por debajo de modales (z-50),
 * toasts (z-100) y overlay del menú móvil; nunca tapa contenido importante.
 *
 * Posición: esquina superior derecha, JUSTO DEBAJO del bloque de estado/usuario
 * (indicador "En línea" + avatar del header, ~56px, más el banner de modo ~28px en
 * DEMO). `top-[5.5rem]` (88px) lo deja bajo ese bloque sin invadir los KPIs.
 */
export function BackToPlatformButton() {
  const { user, tenant, exitTenantContext } = useAuth()
  const navigate = useNavigate()

  if (user?.rol !== 'superadmin' || !tenant) return null

  const handleBack = () => {
    exitTenantContext()
    navigate('/platform')
  }

  return (
    <div className="fixed right-0 top-[5.5rem] z-30 print:hidden">
      <button
        onClick={handleBack}
        title="Volver al listado de empresas"
        aria-label="Volver al listado de empresas"
        className="group flex items-center rounded-l-2xl bg-primary-600 hover:bg-primary-700 text-white shadow-lg ring-1 ring-primary-900/10 pl-3 pr-3 py-2.5 transition-colors"
      >
        <Building2 className="w-5 h-5 flex-shrink-0" />
        <span className="max-w-0 opacity-0 overflow-hidden whitespace-nowrap text-sm font-medium transition-all duration-200 group-hover:max-w-[170px] group-hover:opacity-100 group-hover:ml-2 group-focus:max-w-[170px] group-focus:opacity-100 group-focus:ml-2">
          Volver a Empresas
        </span>
      </button>
    </div>
  )
}
