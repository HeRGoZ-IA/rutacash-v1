import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { routeCapitalController } from '@/lib/permissions'
import type { Route, User } from '@/models/types'

/**
 * Responsable de capital de una ruta (v16), visible donde se opera su caja para
 * que nadie confunda "estar asignado" con "manejar el dinero". Sin responsable
 * válido se muestra en ámbar: las operaciones de caja están bloqueadas.
 */
export function CapitalControllerBadge({ route, users, currentUserId, className = '' }: {
  route: Pick<Route, 'id' | 'tenantId' | 'capitalControllerAdminId'> | undefined
  users: User[]
  currentUserId?: string
  className?: string
}) {
  if (!route) return null
  const responsable = routeCapitalController(route, users)
  if (!responsable) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium text-amber-700 ${className}`} data-testid="capital-controller-none">
        <ShieldAlert className="w-3.5 h-3.5" /><span>Sin responsable de capital</span>
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-gray-500 ${className}`} data-testid="capital-controller">
      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
      {/* Un solo nodo de texto: dentro de inline-flex, el espacio entre dos hijos se
          pierde y "capital:Nombre" llegaría así a lectores de pantalla y al copiar. */}
      <span>Responsable de capital: <span className="font-medium text-gray-700">{responsable.id === currentUserId ? 'Tú' : responsable.nombre}</span></span>
    </span>
  )
}
