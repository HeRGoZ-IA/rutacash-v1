// ============================================================
// ¿QUIÉN RECIBIÓ EL DINERO? — SELECTOR DEL RESPONSABLE DEL EFECTIVO
// ------------------------------------------------------------
// Registrar un abono NO es lo mismo que haberlo cobrado, pero SOLO un actor
// administrativo puede estar digitando dinero que recibió otra persona.
//
// Regla definitiva (2026-09-24, aprobada por negocio):
//   · El actor TIENE CAJA PERSONAL
//     (Cobrador o Supervisor)          → no se muestra NADA. Responde él mismo,
//                                        siempre, sin preguntar.
//   · Actor SIN caja personal (Admin)
//       · la ruta tiene UN cobrador   → se preselecciona y se informa.
//       · la ruta tiene VARIOS        → se EXIGE elegir.
//       · la ruta no tiene ninguno    → no se muestra (queda a nombre del actor).
//
// El servicio revalida la elección: esta pantalla es comodidad, no la garantía.
// ============================================================
import { useEffect, useState } from 'react'
import { UserCheck } from 'lucide-react'
import { Select } from '@/components/ui/Input'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { getAssignedRouteIds } from '@/lib/roles'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import type { User } from '@/models/types'

interface Props {
  /** Ruta de la venta que se está cobrando. */
  routeId: string | null | undefined
  /** Responsable elegido ('' = ninguno todavía). */
  value: string
  onChange: (collectorId: string) => void
}

/**
 * COBRADORES activos asignados a una ruta (fuente única: authorizedRouteIds).
 * Es el conjunto que alimenta las reglas automáticas de atribución del Admin.
 */
export async function loadRouteCollectors(tenantId: string, routeId: string): Promise<User[]> {
  const users = await db.users.where('tenantId').equals(tenantId).toArray()
  return users
    .filter(u => u.rol === 'cobrador' && u.status === 'activo' && getAssignedRouteIds(u).includes(routeId))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
}

export function CollectorPicker({ routeId, value, onChange }: Props) {
  const { user } = useAuth()
  const [collectors, setCollectors] = useState<User[]>([])

  /** Cobrador y Supervisor responden por su propio cobro: nunca ven el selector. */
  const actorRespondePorSiMismo = Boolean(user) && hasPersonalCashbox(user!.rol)

  useEffect(() => {
    let alive = true
    if (!user || !routeId || actorRespondePorSiMismo) { setCollectors([]); return }
    loadRouteCollectors(user.tenantId, routeId).then(list => {
      if (!alive) return
      setCollectors(list)
      // Un solo destino posible: se preselecciona, no hay ambigüedad.
      if (list.length === 1 && !value) onChange(list[0].id)
    })
    return () => { alive = false }
  }, [user, routeId, actorRespondePorSiMismo])

  // Quien tiene caja personal responde por su recaudo: no hay nada que elegir.
  if (!user || actorRespondePorSiMismo) return null
  // Ruta sin cobradores: lo atribuye el servicio (legacy).
  if (collectors.length === 0) return null

  // Un único destino posible: se informa, no se pregunta.
  if (collectors.length === 1) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
        <UserCheck className="w-3.5 h-3.5 flex-shrink-0" />
        El dinero se registrará a nombre de <span className="font-semibold text-gray-800">{collectors[0].nombre}</span>
      </div>
    )
  }

  return (
    <Select
      label="¿Quién recibió el dinero?"
      required
      value={value}
      onChange={e => onChange(e.target.value)}
      options={collectors.map(c => ({ value: c.id, label: c.nombre }))}
      placeholder="Selecciona el responsable"
      hint="Esta ruta tiene varios cobradores: el abono se cargará a la caja del que indiques."
    />
  )
}
