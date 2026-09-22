// ============================================================
// BADGES DE PENDIENTES — CONTADORES REACTIVOS CON ALCANCE
// ------------------------------------------------------------
// Dos garantías, y las dos importan:
//
//  1. ALCANCE. El número del globo se calcula con la MISMA regla de acceso que la
//     pantalla que se abre al pulsarlo (`countPending*ForUser`). Antes se contaba
//     toda la empresa: un Administrador autorizado en 2 de 5 rutas veía "5" y al
//     entrar encontraba 2. Badge y lista no pueden discrepar nunca.
//
//  2. REACTIVIDAD EN EL MISMO DISPOSITIVO. `useLiveQuery` reejecuta la consulta
//     cuando cambian las tablas leídas, así que si un Cobrador envía una solicitud
//     en otra pestaña del MISMO navegador, el Secretario ve subir su globo sin
//     navegar ni recargar. No hay backend: esto solo funciona dentro de una misma
//     IndexedDB, que es exactamente el escenario A de la auditoría (§23).
//     Entre DISPOSITIVOS distintos no llega nada, y eso no lo arregla un hook.
//
// FAIL-SOFT DELIBERADO: si la consulta falla, el contador vale 0 y la navegación
// sigue funcionando. Un globo es información accesoria; jamás debe tumbar el menú
// por el que se mueve toda la aplicación.
// ============================================================
import { useLiveQuery } from 'dexie-react-hooks'
import { countPendingSaleRequestsForUser } from '@/services/saleRequestService'
import { countPendingAdjustmentRequestsForUser } from '@/services/paymentCorrectionService'
import type { User } from '@/models/types'

/** Solicitudes de venta pendientes que este usuario puede gestionar. Reactivo. */
export function usePendingSaleRequests(user: User | null | undefined, tenantId: string): number {
  const n = useLiveQuery(
    async () => {
      try {
        return await countPendingSaleRequestsForUser(user, tenantId)
      } catch {
        return 0
      }
    },
    [user?.id, user?.rol, tenantId, (user?.authorizedRouteIds ?? []).join(',')],
    0,
  )
  return n ?? 0
}

/** Solicitudes de ajuste de pago pendientes que este usuario puede APROBAR. Reactivo. */
export function usePendingAdjustmentRequests(user: User | null | undefined, tenantId: string): number {
  const n = useLiveQuery(
    async () => {
      try {
        return await countPendingAdjustmentRequestsForUser(user, tenantId)
      } catch {
        return 0
      }
    },
    [user?.id, user?.rol, tenantId, (user?.authorizedRouteIds ?? []).join(',')],
    0,
  )
  return n ?? 0
}
