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
          Un Administrador solo opera sobre las rutas que tenga asignadas. Mientras no
          tengas ninguna, no se muestran clientes, ventas, caja ni reportes.
        </p>
        <p className="text-xs text-gray-400 mt-3">Sesión: {user?.nombre} · {user?.email}</p>
      </div>

      {/* Camino de salida explícito: sin esto el usuario no sabe qué falta. */}
      <div className="bg-white border border-gray-100 shadow-card rounded-2xl p-5">
        <h2 className="font-semibold text-gray-900 text-sm mb-3">Cómo se desbloquea</h2>
        <ol className="space-y-2.5 text-sm text-gray-600 list-decimal list-inside">
          <li>El <span className="font-medium text-gray-800">Super Admin</span> inicia sesión y entra a la empresa.</li>
          <li>Crea al menos un <span className="font-medium text-gray-800">Cobrador</span> en Gestión de usuarios.</li>
          <li>Crea la primera <span className="font-medium text-gray-800">Ruta</span>, indicándote a ti como Administrador responsable y al Cobrador como responsable de cobro.</li>
          <li>Al guardar, esta pantalla desaparece y tu operación queda habilitada.</li>
        </ol>
        <p className="text-xs text-gray-400 mt-3">
          Es una medida de seguridad deliberada: sin ruta asignada no hay acceso a datos financieros.
        </p>
      </div>

      <ChangePasswordCard />
    </div>
  )
}
