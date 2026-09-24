import { ShieldAlert } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { can } from '@/lib/permissions'
import { WorkerCashSettlementPanel } from '@/components/settlement/WorkerCashSettlementPanel'

/**
 * CUADRE DE OTROS TRABAJADORES — capa operativa (Supervisor).
 *
 * El Supervisor cuadra el efectivo de OTRO trabajador de su ruta ACTIVA (el
 * servicio rechaza el propio y revalida ruta, empresa y trabajador). El Cobrador no
 * tiene `cashSettlement.view`: esta pantalla no le muestra nada.
 */
export default function CollectorWorkerSettlementsPage() {
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const routeId = activeRouteId ?? ''

  if (!routeId || !can(user, 'cashSettlement.view', { routeId, tenantId })) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center text-gray-500">
        <ShieldAlert className="w-8 h-8 mb-2 text-gray-400" />
        <p className="text-sm">No tienes acceso al cuadre de trabajadores en esta ruta.</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Cuadre de trabajadores</h1>
        <p className="text-xs text-gray-500">Registra lo que entrega cada trabajador de la ruta. Tu propio cuadre lo cierra otra persona.</p>
      </div>
      <WorkerCashSettlementPanel routeId={routeId} />
    </div>
  )
}
