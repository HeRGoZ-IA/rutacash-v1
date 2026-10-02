// ============================================================
// CONTEXTO DE CRÉDITO ACTIVO DE UNA SOLICITUD (PURO)
// ------------------------------------------------------------
// Ajuste del socio 2026-10-02, punto 2: quien autoriza (Secretario) debe ver, antes
// de decidir, que el cliente tiene crédito(s) activo(s) y en qué estado están.
//
// Dos planos que NO se mezclan:
//   · AL SOLICITAR — lo que provocó la autorización: `activeCreditSaleIds` (y, desde
//     2026-10-02, `activeCreditSnapshot` con saldo/total/estado de ese instante).
//   · AHORA — el crédito leído en vivo cuando se toma la decisión. Puede haberse
//     abonado, cancelado, o puede haber aparecido otro crédito activo después.
//
// No decide nada sobre la venta: la regla del segundo crédito sigue en
// `decideSaleOrigination`. Esto solo arma lo que se muestra. Sin Dexie ni React.
// ============================================================
import { isActiveCredit } from '@/lib/activeCredit'
import type { ActiveCreditSnapshot, Sale, SaleRequest } from '@/models/types'

export type ActiveCreditSale = Pick<Sale,
  'id' | 'tenantId' | 'clientId' | 'routeId' | 'status' | 'saldo' | 'valorTotal' | 'valorVenta' | 'fechaInicio' | 'saleRequestId'>

export interface ActiveCreditContextItem {
  saleId: string
  /** Estaba entre los créditos activos al crear la solicitud. */
  atRequest: boolean
  /** Valores al solicitar (solo si la solicitud los fotografió). */
  snapshot?: ActiveCreditSnapshot
  /** Estado actual. Ausente si no existe o el usuario no puede ver esa ruta. */
  current?: ActiveCreditSale
  /** El crédito es de una ruta fuera del alcance del usuario: solo se informa que existe. */
  restricted: boolean
  /** Sigue activo ahora (para `restricted`, según la propia venta). */
  activeNow: boolean
  /** El saldo actual difiere del fotografiado al solicitar. */
  saldoChanged: boolean
}

export interface ActiveCreditContext {
  /** La solicitud se originó con crédito(s) activo(s) del cliente. */
  flaggedAtRequest: boolean
  /** Créditos activos del cliente AHORA (incluye los posteriores a la solicitud). */
  activeNowCount: number
  items: ActiveCreditContextItem[]
}

/**
 * Arma el contexto de crédito activo de una solicitud.
 *
 * `clientSales` son las ventas del cliente; aquí se vuelven a filtrar por cliente y
 * EMPRESA de la solicitud (nunca se mezcla información de otra empresa) y se excluye
 * la venta que nace de esta misma solicitud. `canSeeRoute` recorta el detalle
 * financiero a las rutas del usuario. Devuelve `null` si no hay nada que mostrar
 * (sin crédito al solicitar ni ahora): ni caja vacía ni "0 créditos".
 */
export function buildActiveCreditContext(
  request: Pick<SaleRequest, 'id' | 'tenantId' | 'clientId' | 'activeCreditSaleIds' | 'activeCreditSnapshot'>,
  clientSales: ActiveCreditSale[],
  canSeeRoute: (routeId: string) => boolean = () => true,
): ActiveCreditContext | null {
  const ventas = new Map(clientSales
    .filter(s => s.clientId === request.clientId && s.tenantId === request.tenantId && s.saleRequestId !== request.id)
    .map(s => [s.id, s]))
  const fotos = new Map((request.activeCreditSnapshot ?? []).map(f => [f.saleId, f]))
  const idsAlSolicitar = request.activeCreditSaleIds ?? []

  const item = (saleId: string, atRequest: boolean): ActiveCreditContextItem => {
    const venta = ventas.get(saleId)
    const restricted = !!venta && !canSeeRoute(venta.routeId)
    const snapshot = fotos.get(saleId)
    const current = venta && !restricted ? venta : undefined
    return {
      saleId, atRequest, snapshot, current, restricted,
      activeNow: !!venta && isActiveCredit(venta),
      saldoChanged: !!snapshot && !!current && snapshot.saldo !== current.saldo,
    }
  }

  const items = idsAlSolicitar.map(id => item(id, true))
  // Créditos activos que aparecieron DESPUÉS de la solicitud: también pesan en la decisión.
  for (const s of ventas.values()) {
    if (isActiveCredit(s) && !idsAlSolicitar.includes(s.id)) items.push(item(s.id, false))
  }
  if (items.length === 0) return null
  return {
    flaggedAtRequest: idsAlSolicitar.length > 0,
    activeNowCount: items.filter(i => i.activeNow).length,
    items,
  }
}
