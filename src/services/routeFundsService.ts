// ============================================================
// FONDOS DE LA ROUTE — CAPITAL · TRANSFERENCIAS · RETIROS (servicio de dominio)
// ------------------------------------------------------------
// Hasta 2026-09-29 estas tres operaciones las escribía la PANTALLA directamente
// (`db.capitalMovements.add`, `db.transfers.add`, `db.withdrawals.add`): el permiso
// y la ruta se comprobaban en el componente, un retiro podía superar los fondos y
// una transferencia con socio podía quedar a medias (transferencia sin su
// movimiento de Caja socios). Ahora todo pasa por aquí.
//
// SEMÁNTICA:
//   · Capital (Socio/empresa → Route): dinero NUEVO para la Route (aporte / Base
//     nueva). Suma al capital estructural.
//   · Transferencia:
//       Socio → Route   aporte de un socio (entra dinero a la Route).
//       Route → Route   TRASLADO INTERNO: una Route baja lo que otra sube; el total
//                       de la empresa no cambia (no es capital nuevo).
//       Route → Socio   salida de la Route hacia un socio.
//       Socio → Socio   solo Caja socios.
//     Si el efectivo transferido se entrega EN MANO a una persona de la Route
//     destino, la entrega queda enlazada (`CashCustodyMovement.relatedTransferId`)
//     en la MISMA transacción: Route +X y persona +X como responsabilidad, sin
//     duplicar (la custodia no cambia el libro).
//   · Retiro: salida estructural de la caja NO asignada de la Route. No afecta a
//     ninguna persona: devolver efectivo personal es `returnBaseFromWorker` o el
//     cuadre, nunca un retiro.
//
// REVALIDACIÓN EN SERVICIO: actor, capacidad, empresa, rutas (y socios) en
// alcance, Oficina activa (operación nueva), monto entero > 0, fecha válida no
// futura, fondos disponibles (dentro de la transacción) y autoría/instante sellados
// por el servicio — la pantalla no aporta `userId` ni `createdAt`.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { authorizedRouteIdsOf, can, isTransferInScope } from '@/lib/permissions'
import { assertCan, assertRouteAccess, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { assertRouteOperationalContext } from '@/services/officeService'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { custodianBlockedReason, reconciliationTables } from '@/services/cashCustodyService'
import type {
  CapitalMovement, CashCustodyMovement, PartnerCashMovement, Route, Transfer, TransferEntityType, User, Withdrawal,
} from '@/models/types'

export class RouteFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteFundsError'
  }
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

function validarMonto(valor: unknown): number {
  const n = Number(valor)
  if (!Number.isFinite(n) || n <= 0 || Math.round(n) !== n) throw new RouteFundsError('El valor debe ser un entero mayor a 0.')
  return n
}

function validarFecha(fecha: string | undefined): string {
  const f = fecha || today()
  if (!FECHA.test(f) || Number.isNaN(new Date(`${f}T00:00:00`).getTime())) throw new RouteFundsError('La fecha no es válida.')
  if (f > today()) throw new RouteFundsError('La fecha no puede ser futura.')
  return f
}

function exigirActor(actor: User | null | undefined): User {
  if (!actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  return actor
}

async function rutaDeLaEmpresa(routeId: string, tenantId: string, database: RutaCashDB): Promise<Route> {
  const route = await database.routes.get(routeId)
  if (!route) throw new RouteFundsError('La ruta indicada no existe.')
  if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
  return route
}

async function auditar(params: Parameters<typeof logAction>[0]) {
  await logAction(params).catch(() => undefined)
}

// ------------------------------------------------------------
// CAPITAL
// ------------------------------------------------------------
export async function registerCapital(
  params: { actor: User | null | undefined; tenantId: string; routeId: string; valor: number; descripcion?: string; fecha?: string },
  database: RutaCashDB = db,
): Promise<CapitalMovement> {
  const actor = exigirActor(params.actor)
  const { tenantId, routeId } = params
  assertCan(actor, 'capital.manage', { routeId, tenantId })
  // `capital.manage` no es una capacidad acotada por ruta en `can()`: la ruta
  // autorizada se exige aquí de forma explícita (un Admin solo mueve SUS rutas).
  assertRouteAccess(actor, routeId)
  await rutaDeLaEmpresa(routeId, tenantId, database)
  await assertRouteOperationalContext(routeId)
  const valor = validarMonto(params.valor)
  const fecha = validarFecha(params.fecha)
  let mov!: CapitalMovement
  await database.transaction('rw', [database.capitalMovements], async () => {
    await database.capitalMovements.where('routeId').equals(routeId).count()
    mov = {
      id: generateId(), tenantId, routeId, tipo: 'ingresoCapital', valor,
      descripcion: params.descripcion?.trim() || undefined, fecha, userId: actor.id, createdAt: nowISO(),
    }
    await database.capitalMovements.add(mov)
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'CAPITAL_REGISTERED',
    entityType: 'capitalMovement', entityId: mov.id, descripcion: `Capital ${valor} a la ruta (${fecha}).`,
    after: { valor, fecha },
  })
  return mov
}

// ------------------------------------------------------------
// TRANSFERENCIAS
// ------------------------------------------------------------
export interface TransferEndpoint { type: TransferEntityType; id: string }

export type TransferKind = 'aporte-socio' | 'traslado-interno' | 'salida-a-socio' | 'entre-socios'

export function classifyTransfer(origen: TransferEndpoint, destino: TransferEndpoint): TransferKind {
  if (origen.type === 'partner' && destino.type === 'route') return 'aporte-socio'
  if (origen.type === 'route' && destino.type === 'route') return 'traslado-interno'
  if (origen.type === 'route' && destino.type === 'partner') return 'salida-a-socio'
  return 'entre-socios'
}

export interface RegisterTransferParams {
  actor: User | null | undefined
  tenantId: string
  origen: TransferEndpoint
  destino: TransferEndpoint
  valor: number
  descripcion?: string
  fecha?: string
  /** Entrega en mano del efectivo a una persona de la Route destino (opcional). */
  entregarA?: { userId: string; motivo?: string }
}

export async function registerTransfer(
  params: RegisterTransferParams,
  database: RutaCashDB = db,
): Promise<{ transfer: Transfer; kind: TransferKind; partnerMovements: PartnerCashMovement[]; custody?: CashCustodyMovement }> {
  const actor = exigirActor(params.actor)
  const { tenantId, origen, destino } = params
  assertCan(actor, 'transfer.create', { tenantId })
  if (origen.type === destino.type && origen.id === destino.id) throw new RouteFundsError('Origen y destino no pueden ser iguales.')
  const valor = validarMonto(params.valor)
  const fecha = validarFecha(params.fecha)

  // Extremos: existen en ESTA empresa y están en el alcance del actor.
  const users = await database.users.where('tenantId').equals(tenantId).toArray()
  const nombreDe = async (e: TransferEndpoint): Promise<string> => {
    if (e.type === 'route') {
      const r = await rutaDeLaEmpresa(e.id, tenantId, database)
      await assertRouteOperationalContext(e.id)
      return `Ruta ${r.nombre}`
    }
    const socio = users.find(u => u.id === e.id && u.rol === 'socio')
    if (!socio) throw new RouteFundsError('El socio indicado no existe en esta empresa.')
    return `Socio ${socio.nombre}`
  }
  const origenNombre = await nombreDe(origen)
  const destinoNombre = await nombreDe(destino)

  const transfer: Transfer = {
    id: generateId(), tenantId,
    origenType: origen.type, destinoType: destino.type,
    routeOrigenId: origen.type === 'route' ? origen.id : '',
    routeDestinoId: destino.type === 'route' ? destino.id : undefined,
    socioOrigenId: origen.type === 'partner' ? origen.id : undefined,
    socioDestinoId: destino.type === 'partner' ? destino.id : undefined,
    valor, descripcion: params.descripcion?.trim() || undefined, fecha, userId: actor.id, createdAt: '',
  }
  const partnerRoutes = (socioId: string) => authorizedRouteIdsOf(users.find(u => u.id === socioId))
  if (!isTransferInScope(actor, transfer, partnerRoutes)) {
    throw new AuthzError('No puedes transferir desde/hacia una ruta o socio fuera de tu alcance.')
  }

  // Entrega en mano: solo en una Route destino, a una persona elegible, con permiso.
  if (params.entregarA) {
    if (destino.type !== 'route') throw new RouteFundsError('Solo puede entregarse en mano el efectivo que llega a una ruta.')
    assertCan(actor, 'cashCustody.manage', { routeId: destino.id, tenantId })
    const bloqueo = custodianBlockedReason(users.find(u => u.id === params.entregarA!.userId), destino.id, tenantId)
    if (bloqueo) throw new RouteFundsError(bloqueo)
  }

  const kind = classifyTransfer(origen, destino)
  const partnerMovements: PartnerCashMovement[] = []
  let custody: CashCustodyMovement | undefined
  // Transferencia + Caja socios + entrega en mano: TODO o NADA.
  await database.transaction('rw', [...reconciliationTables(database), database.partnerCashMovements], async () => {
    await database.transfers.where('routeOrigenId').equals(transfer.routeOrigenId).count()   // bloqueo
    const ahora = nowISO()
    if (origen.type === 'route') {
      const r = await computeRouteCashReconciliation({ tenantId, routeId: origen.id, hasta: ahora }, database)
      if (valor > r.disponible) throw new RouteFundsError(`La ruta origen no tiene fondos suficientes (disponible: ${r.disponible}).`)
    }
    transfer.createdAt = ahora
    await database.transfers.add(transfer)
    const desc = params.descripcion?.trim() ? ` · ${params.descripcion.trim()}` : ''
    if (origen.type === 'partner') {
      partnerMovements.push({
        id: generateId(), tenantId, partnerId: origen.id, type: 'salida', category: 'transferencia', amount: valor,
        description: `Transferencia a ${destinoNombre}${desc}`, relatedTransferId: transfer.id, fecha, createdAt: ahora, createdBy: actor.id,
      })
    }
    if (destino.type === 'partner') {
      partnerMovements.push({
        id: generateId(), tenantId, partnerId: destino.id, type: 'ingreso', category: 'transferencia', amount: valor,
        description: `Transferencia de ${origenNombre}${desc}`, relatedTransferId: transfer.id, fecha, createdAt: ahora, createdBy: actor.id,
      })
    }
    if (partnerMovements.length) await database.partnerCashMovements.bulkAdd(partnerMovements)
    if (params.entregarA && destino.type === 'route') {
      custody = {
        id: generateId(), tenantId, routeId: destino.id, tipo: 'BASE_ASSIGNMENT', amount: valor,
        toUserId: params.entregarA.userId, origen: 'transfer', relatedTransferId: transfer.id,
        motivo: params.entregarA.motivo?.trim() || `Entrega en mano de la transferencia desde ${origenNombre}`,
        fecha: today(), createdAt: ahora, createdByUserId: actor.id,
      }
      await database.cashCustodyMovements.add(custody)
    }
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol,
    routeId: transfer.routeDestinoId || transfer.routeOrigenId || undefined,
    action: 'TRANSFER_REGISTERED', entityType: 'transfer', entityId: transfer.id,
    descripcion: `Transferencia (${kind}) ${valor}: ${origenNombre} → ${destinoNombre}${custody ? `, entregada en mano a ${custody.toUserId}` : ''}.`,
    after: { valor, fecha, kind, entregadoA: custody?.toUserId },
  })
  return { transfer, kind, partnerMovements, custody }
}

// ------------------------------------------------------------
// RETIROS
// ------------------------------------------------------------
/**
 * Retiro ESTRUCTURAL de la Route. No puede superar la caja NO asignada (lo que
 * está en manos de trabajadores no se puede retirar desde la oficina) ni el saldo
 * del libro. Validado dentro de la transacción: dos retiros simultáneos no pueden
 * gastar el mismo dinero.
 */
export async function registerWithdrawal(
  params: { actor: User | null | undefined; tenantId: string; routeId: string; valor: number; descripcion?: string; fecha?: string },
  database: RutaCashDB = db,
): Promise<Withdrawal> {
  const actor = exigirActor(params.actor)
  const { tenantId, routeId } = params
  assertCan(actor, 'capital.manage', { routeId, tenantId })
  // `capital.manage` no es una capacidad acotada por ruta en `can()`: la ruta
  // autorizada se exige aquí de forma explícita (un Admin solo mueve SUS rutas).
  assertRouteAccess(actor, routeId)
  await rutaDeLaEmpresa(routeId, tenantId, database)
  await assertRouteOperationalContext(routeId)
  const valor = validarMonto(params.valor)
  const fecha = validarFecha(params.fecha)
  let w!: Withdrawal
  await database.transaction('rw', reconciliationTables(database), async () => {
    await database.withdrawals.where('routeId').equals(routeId).count()   // bloqueo
    const ahora = nowISO()
    const r = await computeRouteCashReconciliation({ tenantId, routeId, hasta: ahora }, database)
    if (valor > r.disponible) throw new RouteFundsError(`El retiro supera los fondos disponibles de la ruta (disponible: ${r.disponible}).`)
    w = { id: generateId(), tenantId, routeId, valor, descripcion: params.descripcion?.trim() || undefined, fecha, userId: actor.id, createdAt: ahora }
    await database.withdrawals.add(w)
  })
  await auditar({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'WITHDRAWAL_REGISTERED',
    entityType: 'withdrawal', entityId: w.id, descripcion: `Retiro ${valor} de la ruta (${fecha}).`, after: { valor, fecha },
  })
  return w
}

/** Fondos disponibles de una Route (para mostrar antes de retirar o transferir). */
export async function getRouteAvailableFunds(tenantId: string, routeId: string, database: RutaCashDB = db): Promise<number> {
  return (await computeRouteCashReconciliation({ tenantId, routeId }, database)).disponible
}

/** ¿El actor puede registrar capital / retiros en la ruta? (para la UI). */
export const canManageRouteFunds = (actor: User | null | undefined, routeId: string, tenantId: string) =>
  can(actor, 'capital.manage', { routeId, tenantId })
