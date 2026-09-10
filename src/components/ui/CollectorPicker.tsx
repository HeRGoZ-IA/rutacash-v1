// ============================================================
// ¿QUIÉN RECIBIÓ EL DINERO? — SELECTOR DE COBRADOR RESPONSABLE
// ------------------------------------------------------------
// Registrar un abono NO es lo mismo que haberlo cobrado. Cuando quien registra no
// es cobrador (Administrador, Supervisor, Super Admin) hay que saber a qué caja
// personal se carga el efectivo.
//
// El componente se comporta según el caso, para no molestar cuando no hay duda:
//   · El actor ES cobrador           → no se muestra (responde él).
//   · La ruta tiene UN cobrador      → se preselecciona y se informa, sin pedir nada.
//   · La ruta tiene VARIOS           → se EXIGE elegir: nunca se adivina.
//   · La ruta no tiene cobradores    → no se muestra (queda a nombre del actor).
//
// El servicio revalida la elección: esta pantalla es comodidad, no la garantía.
// ============================================================
import { useEffect, useState } from 'react'
import { UserCheck } from 'lucide-react'
import { Select } from '@/components/ui/Input'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { getAssignedRouteIds } from '@/lib/roles'
import type { User } from '@/models/types'

interface Props {
  /** Ruta de la venta que se está cobrando. */
  routeId: string | null | undefined
  /** Cobrador elegido ('' = ninguno todavía). */
  value: string
  onChange: (collectorId: string) => void
}

/** Cobradores ACTIVOS asignados a una ruta (fuente única: authorizedRouteIds). */
export async function loadRouteCollectors(tenantId: string, routeId: string): Promise<User[]> {
  const users = await db.users.where('tenantId').equals(tenantId).toArray()
  return users
    .filter(u => u.rol === 'cobrador' && u.status === 'activo' && getAssignedRouteIds(u).includes(routeId))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
}

export function CollectorPicker({ routeId, value, onChange }: Props) {
  const { user } = useAuth()
  const [collectors, setCollectors] = useState<User[]>([])

  useEffect(() => {
    let alive = true
    if (!user || !routeId || user.rol === 'cobrador') { setCollectors([]); return }
    loadRouteCollectors(user.tenantId, routeId).then(list => {
      if (!alive) return
      setCollectors(list)
      // Un solo cobrador: se preselecciona, no hay ambigüedad posible.
      if (list.length === 1 && !value) onChange(list[0].id)
    })
    return () => { alive = false }
  }, [user, routeId])

  // El propio cobrador responde por su recaudo: no hay nada que elegir.
  if (!user || user.rol === 'cobrador') return null
  // Ruta sin cobradores: el servicio lo atribuye al actor (comportamiento legacy).
  if (collectors.length === 0) return null

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
      placeholder="Selecciona el cobrador"
      hint="Esta ruta tiene varios cobradores: el abono se cargará a la caja del que indiques."
    />
  )
}
