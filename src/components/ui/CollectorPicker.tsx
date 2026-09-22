// ============================================================
// ¿QUIÉN RECIBIÓ EL DINERO? — SELECTOR DEL RESPONSABLE DEL EFECTIVO
// ------------------------------------------------------------
// Registrar un abono NO es lo mismo que haberlo cobrado. Cuando quien registra no
// es el único destino posible del efectivo hay que saber a qué caja personal se
// carga el dinero.
//
// El componente se comporta según el caso, para no molestar cuando no hay duda:
//   · El actor ES cobrador            → no se muestra (responde él, sin fricción).
//   · El actor tiene CAJA PERSONAL
//     y NO es cobrador (Supervisor)   → se EXIGE elegir entre "Yo" y los cobradores
//                                       de la ruta. Sin preselección: el Supervisor
//                                       no se queda el dinero por ser quien digita,
//                                       ni se lo lleva el cobrador por ser el habitual.
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
 * Se conserva el nombre porque es el conjunto que alimenta las reglas automáticas
 * de atribución; el Supervisor actor se añade aparte en el propio selector.
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

  /**
   * El actor puede quedarse el dinero cuando tiene caja personal y no es cobrador
   * (el cobrador ni siquiera ve este componente). Es el caso del SUPERVISOR que
   * está operando la ruta: hasta la Fase 1 le era IMPOSIBLE indicarse a sí mismo.
   */
  const actorPuedeResponder = Boolean(user) && user!.rol !== 'cobrador' && hasPersonalCashbox(user!.rol)

  useEffect(() => {
    let alive = true
    if (!user || !routeId || user.rol === 'cobrador') { setCollectors([]); return }
    loadRouteCollectors(user.tenantId, routeId).then(list => {
      if (!alive) return
      setCollectors(list)
      // Un solo destino posible: se preselecciona, no hay ambigüedad.
      // Si el actor TAMBIÉN puede responder, hay dos destinos y no se adivina
      // ninguno: se deja vacío para forzar la decisión.
      if (list.length === 1 && !value && !actorPuedeResponder) onChange(list[0].id)
    })
    return () => { alive = false }
  }, [user, routeId, actorPuedeResponder])

  // El propio cobrador responde por su recaudo: no hay nada que elegir.
  if (!user || user.rol === 'cobrador') return null
  // Ruta sin cobradores y actor sin caja personal: lo atribuye el servicio (legacy).
  if (collectors.length === 0 && !actorPuedeResponder) return null

  // Opciones: el actor (cuando puede responder) + los cobradores de la ruta.
  const options = [
    ...(actorPuedeResponder ? [{ value: user.id, label: `Yo — ${user.nombre}` }] : []),
    ...collectors.map(c => ({ value: c.id, label: c.nombre })),
  ]

  // Un único destino posible y NO es el actor: se informa, no se pregunta.
  if (!actorPuedeResponder && collectors.length === 1) {
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
      options={options}
      placeholder="Selecciona el responsable"
      hint={
        actorPuedeResponder
          ? 'Si el efectivo lo recibiste tú, elígete a ti. Si lo recibió el cobrador, elígelo a él: el dinero se cargará a esa caja.'
          : 'Esta ruta tiene varios cobradores: el abono se cargará a la caja del que indiques.'
      }
    />
  )
}
