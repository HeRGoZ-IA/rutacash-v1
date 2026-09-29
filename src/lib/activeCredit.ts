// ============================================================
// CRÉDITO ACTIVO Y ORIGEN DE UNA VENTA — REGLA CENTRAL (PURA)
// ------------------------------------------------------------
// Incidente 2026-09 (docs/INCIDENTE_SEGUNDO_CREDITO_ACTIVO_2026-09.md): un cliente
// con un crédito activo recibió otro sin pasar por autorización. La regla "un
// Cobrador no otorga un segundo crédito a quien ya tiene uno activo" no estaba en
// ningún servicio: solo existía la alerta de pantalla (decisión del 25-jun: "alerta
// fuerte + confirmación, no bloquear") y la ausencia de `sale.createDirect` en el
// Cobrador. Quien llamara al servicio sin actor, o cualquier actor con venta
// directa, creaba la segunda venta sin que nadie la revisara.
//
// Aquí vive la decisión ÚNICA "¿esta venta puede ser directa, debe ir como
// solicitud o está prohibida?". La usan el servicio (dentro de su transacción) y
// las pantallas (para ofrecer el botón correcto). Sin Dexie ni React.
//
// ALCANCE DEL CRÉDITO ACTIVO: por CLIENTE, en toda la empresa. El documento del
// cliente es único por empresa (sin importar la ruta) y `findActiveSaleForClient`
// siempre buscó por `clientId` en todas las rutas; un cliente movido de ruta sigue
// teniendo su crédito anterior. No se introduce un alcance "por ruta".
// ============================================================
import type { Sale, SaleStatus, User } from '@/models/types'

/**
 * Estados que significan "crédito VIGENTE". Fuente única: no escribir
 * `status === 'activa'` suelto para esta decisión.
 *
 * Una venta 'activa' cuenta tanto desembolsada como pendiente de desembolso (ya
 * fue aprobada: el cliente la tiene comprometida). 'finalizada' (pagada),
 * 'refinanciada' (sustituida por otra) y 'perdida' (castigada) no bloquean.
 */
export const ACTIVE_SALE_STATUSES: readonly SaleStatus[] = ['activa']

export function isActiveCredit(sale: Pick<Sale, 'status'>): boolean {
  return (ACTIVE_SALE_STATUSES as readonly string[]).includes(sale.status)
}

/** Créditos activos de un cliente dentro de una lista de ventas (cualquier ruta). */
export function activeCreditsOf<T extends Pick<Sale, 'clientId' | 'status' | 'tenantId'>>(
  sales: T[], clientId: string, tenantId: string,
): T[] {
  return sales.filter(s => s.clientId === clientId && s.tenantId === tenantId && isActiveCredit(s))
}

export type SaleOrigination =
  | { kind: 'direct' }
  | { kind: 'authorization'; reason: 'active-credit' | 'no-direct-capability' }
  | { kind: 'forbidden' }

/**
 * Decide cómo puede originarse una venta.
 *
 *  · Sin `sale.createDirect` ni `sale.createRequest` → prohibida.
 *  · COBRADOR con el cliente ya con ≥ 1 crédito activo → SOLICITUD, siempre. Se usa
 *    el ROL además de la capacidad a propósito: la regla es de negocio sobre el
 *    Cobrador y debe seguir en pie aunque algún día se le conceda venta directa
 *    para clientes sin crédito.
 *  · Con `sale.createDirect` (Supervisor, Admin, Super Admin) → directa, aunque el
 *    cliente tenga crédito activo: es la autoridad comercial vigente (la pantalla
 *    sigue pidiendo confirmación).
 *  · Solo `sale.createRequest` → solicitud.
 *
 * El límite de venta directa y el capital NO se deciden aquí: siguen en el
 * servicio (`directSaleLimit`, `hasCapitalForSale`).
 */
export function decideSaleOrigination(params: {
  actor: Pick<User, 'rol'>
  canCreateDirect: boolean
  canCreateRequest: boolean
  activeCredits: number
}): SaleOrigination {
  const { actor, canCreateDirect, canCreateRequest, activeCredits } = params
  if (!canCreateDirect && !canCreateRequest) return { kind: 'forbidden' }
  if (actor.rol === 'cobrador' && activeCredits > 0) {
    return canCreateRequest ? { kind: 'authorization', reason: 'active-credit' } : { kind: 'forbidden' }
  }
  if (canCreateDirect) return { kind: 'direct' }
  return { kind: 'authorization', reason: 'no-direct-capability' }
}
