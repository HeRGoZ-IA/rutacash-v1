import { ShieldAlert } from 'lucide-react'
import { ChangePasswordCard } from '@/components/auth/ChangePasswordCard'
import { useAuth } from '@/hooks/useAuth'

/**
 * Pantalla informativa para un Administrador SIN rutas autorizadas (FAIL CLOSED).
 * Cero rutas = cero acceso operativo: no se consultan clientes, ventas, pagos, caja,
 * gastos, transferencias, reportes ni totales. Solo cuenta + cambio de contraseña.
 */
export function AdminNoRoutes() {
  const { user } = useAuth()
  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">No tienes rutas autorizadas</h1>
        <p className="text-sm text-gray-600 mt-2">
          Solicita al Super Admin la asignación de una o más rutas para acceder a la operación.
        </p>
        <p className="text-xs text-gray-400 mt-3">Sesión: {user?.nombre} · {user?.email}</p>
      </div>
      <ChangePasswordCard />
    </div>
  )
}
