import { useState } from 'react'
import { Users } from 'lucide-react'
import { getRouteAssignmentsByRole, ASSIGNMENT_ROLE_ORDER, hasAnyAssignment } from '@/lib/routeAssignments'
import type { User } from '@/models/types'

/**
 * Resumen de USUARIOS ASIGNADOS a una ruta para la tarjeta general.
 * Fuente única: `authorizedRouteIds` (via getRouteAssignmentsByRole). Agrupa por rol en
 * el orden Administrador → Socio → Supervisor → Cobrador → Secretario; alfabético dentro
 * de cada rol; máximo 2 por rol con "+N más" y un "Ver todos" para expandir. Marca al
 * cobrador RESPONSABLE (route.cobradorId). Nunca muestra "Sin cobrador" si hay otros
 * usuarios asignados.
 */
export function RouteAssignedUsers({ users, routeId, tenantId, responsibleCobradorId }: {
  users: User[]
  routeId: string
  tenantId: string
  responsibleCobradorId?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const a = getRouteAssignmentsByRole(users, routeId, tenantId)
  const groups = ASSIGNMENT_ROLE_ORDER.map(g => ({ ...g, list: a[g.key] })).filter(g => g.list.length > 0)
  const hasOverflow = groups.some(g => g.list.length > 2)

  if (!hasAnyAssignment(a)) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <Users className="w-3.5 h-3.5" /> Sin usuarios asignados
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Usuarios asignados</p>
        {hasOverflow && (
          <button type="button" onClick={() => setExpanded(e => !e)} className="text-xs text-primary-600 hover:underline">
            {expanded ? 'Ver menos' : 'Ver todos'}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {groups.map(g => {
          const shown = expanded ? g.list : g.list.slice(0, 2)
          const extra = g.list.length - shown.length
          return (
            <div key={g.key} className="text-xs leading-snug">
              <span className="font-medium text-gray-600">{g.list.length === 1 ? g.singular : g.plural}: </span>
              <span className="text-gray-700">
                {shown.map((u, i) => (
                  <span key={u.id}>
                    {u.nombre}
                    {g.rol === 'cobrador' && u.id === responsibleCobradorId && (
                      <span className="text-[10px] font-medium text-primary-600"> (responsable)</span>
                    )}
                    {i < shown.length - 1 ? ', ' : ''}
                  </span>
                ))}
                {extra > 0 && <span className="text-gray-400"> +{extra} más</span>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
