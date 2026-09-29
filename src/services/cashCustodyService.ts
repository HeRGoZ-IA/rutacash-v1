// ============================================================
// BASE FÍSICA POR TRABAJADOR — SERVICIO DE CUSTODIA (v15)
// ------------------------------------------------------------
// Registra quién tiene físicamente el efectivo de una Route:
//
//   assignBaseToWorker        Route → persona   (BASE_ASSIGNMENT)
//   returnBaseFromWorker      persona → Route   (BASE_RETURN)
//   transferBaseBetweenWorkers persona → persona (PERSON_TO_PERSON)
//
// PRINCIPIO: redistribuye RESPONSABILIDAD, no crea dinero. El libro de la Route
// (`getCashboxSummary`) no cambia; cambia cuánto está sin asignar y cuánto en
// manos de cada persona (`routeCashReconciliation`).
//
// VALIDACIONES EN SERVICIO (la pantalla nunca es la única barrera):
//   · `cashCustody.manage` sobre la Route y la empresa (Cobrador nunca).
//   · Route de la empresa; Oficina activa para ENTREGAR (operación nueva). La
//     DEVOLUCIÓN se admite con Oficina inactiva: concilia efectivo existente, igual
//     que el cuadre.
//   · Receptor elegible: misma empresa, activo, con caja personal (Cobrador o
//     Supervisor) y asignado a la Route. Nunca se infiere de `Route.cobradorId`,
//     del rol del actor ni del usuario en sesión.
//   · Admin / Super Admin NO reciben Base: no tienen caja personal. ("Modo
//     Supervisor" para ellos no existe en el repositorio; cuando exista, la
//     elegibilidad se amplía AQUÍ, en `custodianBlockedReason`, sin tocar el ledger,
//     que ya es por `userId`.)
//   · Nadie REDUCE su propia responsabilidad: la devolución o el traspaso que
//     descarga a X lo registra otra persona (mismo principio que "nadie cierra su
//     propio cuadre").
//   · Fondos: la entrega no supera la caja NO asignada de la Route; la devolución
//     y el traspaso no superan la posición de quien entrega. Se validan DENTRO de la
//     transacción: dos entregas simultáneas no pueden gastar el mismo efectivo.
//   · Instante sellado dentro de la transacción (frontera del cuadre: el cierre
//     incluye esta tabla en su bloqueo).
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { getAssignedRouteIds } from '@/lib/roles'
import { assertCan, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { assertRouteOperationalContext } from '@/services/officeService'
import { personalCashPosition } from '@/services/cashSettlementService'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import type { CashCustodyMovement, CashCustodyType, Route, User } from '@/models/types'

export class CashCustodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CashCustodyError'
  }
}

/** Tablas que lee la conciliación: todas entran al bloqueo de la escritura. */
export function reconciliationTables(database: RutaCashDB = db) {
  return [
    database.cashCustodyMovements, database.cashSettlements, database.payments, database.sales,
    database.expenses, database.capitalMovements, database.transfers, database.withdrawals,
    database.tenants, database.users, database.routes,
  ]
}

/**
 * ¿Por qué `user` NO puede recibir Base en `routeId`? `null` = elegible.
 * Fuente única de elegibilidad (pantallas y servicio).
 */
export function custodianBlockedReason(user: User | null | undefined, routeId: string, tenantId: string): string | null {
  if (!user || user.tenantId !== tenantId) return 'La persona indicada no existe en esta empresa.'
  if (user.status !== 'activo') return 'La persona indicada está inactiva.'
  if (!hasPersonalCashbox(user.rol)) return 'Solo Cobradores y Supervisores pueden recibir Base física.'
  if (!getAssignedRouteIds(user).includes(routeId)) return 'La persona no está asignada a esta ruta.'
  return null
}

function validarMonto(amount: unknown): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0 || Math.round(n) !== n) throw new CashCustodyError('El monto debe ser un valor entero mayor a 0.')
  return n
}

function validarMotivo(motivo: string | undefined): string {
  const m = (motivo ?? '').trim()
  if (m.length < 3) throw new CashCustodyError('Indica el motivo del movimiento.')
  return m
}

async function rutaDeLaEmpresa(routeId: string, tenantId: string, database: RutaCashDB): Promise<Route> {
  const route = await database.routes.get(routeId)
  if (!route) throw new CashCustodyError('La ruta indicada no existe.')
  if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
  return route
}

interface CustodyParams {
  actor: User | null | undefined
  tenantId: string
  routeId: string
  amount: number
  motivo: string
}

async function registrar(
  tipo: CashCustodyType,
  params: CustodyParams & { fromUserId?: string; toUserId?: string; origen?: CashCustodyMovement['origen']; relatedTransferId?: string },
  database: RutaCashDB,
  /** Validación de fondos con los datos leídos DENTRO de la transacción. */
  validarFondos: (hasta: string) => Promise<void>,
): Promise<CashCustodyMovement> {
  const { actor, tenantId, routeId } = params
  const amount = validarMonto(params.amount)
  const motivo = validarMotivo(params.motivo)
  let mov!: CashCustodyMovement
  await database.transaction('rw', reconciliationTables(database), async () => {
    await database.cashCustodyMovements.where('routeId').equals(routeId).count()   // bloqueo obtenido
    const ahora = nowISO()
    await validarFondos(ahora)
    mov = {
      id: generateId(), tenantId, routeId, tipo, amount,
      fromUserId: params.fromUserId, toUserId: params.toUserId,
      origen: params.origen ?? 'route-cash', relatedTransferId: params.relatedTransferId,
      motivo, fecha: today(), createdAt: ahora, createdByUserId: actor!.id,
    }
    await database.cashCustodyMovements.add(mov)
  })
  await logAction({
    tenantId, userId: actor!.id, userRole: actor!.rol, routeId,
    action: `CASH_CUSTODY_${tipo}`, entityType: 'cashCustodyMovement', entityId: mov.id,
    descripcion: `${tipo}: ${amount}${mov.fromUserId ? ` de ${mov.fromUserId}` : ' de la caja de la ruta'}${mov.toUserId ? ` a ${mov.toUserId}` : ' a la caja de la ruta'}.`,
    after: { amount, fromUserId: mov.fromUserId, toUserId: mov.toUserId, origen: mov.origen, relatedTransferId: mov.relatedTransferId },
    motivo,
  }).catch(() => undefined)
  return mov
}

/**
 * Route → persona. La Base sale de la caja NO asignada de la Route (no de lo que ya
 * tienen otras personas) y queda bajo la responsabilidad de `recipientUserId`.
 */
export async function assignBaseToWorker(
  params: CustodyParams & { recipientUserId: string; origen?: CashCustodyMovement['origen']; relatedTransferId?: string },
  database: RutaCashDB = db,
): Promise<CashCustodyMovement> {
  const { actor, tenantId, routeId, recipientUserId } = params
  assertCan(actor, 'cashCustody.manage', { routeId, tenantId })
  await rutaDeLaEmpresa(routeId, tenantId, database)
  await assertRouteOperationalContext(routeId)
  const bloqueo = custodianBlockedReason(await database.users.get(recipientUserId), routeId, tenantId)
  if (bloqueo) throw new CashCustodyError(bloqueo)
  return registrar('BASE_ASSIGNMENT', { ...params, toUserId: recipientUserId }, database, async (hasta) => {
    const r = await computeRouteCashReconciliation({ tenantId, routeId, hasta }, database)
    if (Number(params.amount) > r.disponible) {
      throw new CashCustodyError(`La ruta no tiene ese efectivo sin asignar (disponible: ${r.disponible}).`)
    }
  })
}

/**
 * Persona → Route. Reduce la responsabilidad de `fromUserId`; la Route recupera el
 * efectivo en su caja no asignada. Lo registra OTRA persona (quien lo recibe).
 */
export async function returnBaseFromWorker(
  params: CustodyParams & { fromUserId: string },
  database: RutaCashDB = db,
): Promise<CashCustodyMovement> {
  const { actor, tenantId, routeId, fromUserId } = params
  assertCan(actor, 'cashCustody.manage', { routeId, tenantId })
  await rutaDeLaEmpresa(routeId, tenantId, database)
  if (actor!.id === fromUserId) {
    throw new CashCustodyError('No puedes registrar tu propia devolución: debe recibirla otra persona autorizada.')
  }
  const persona = await database.users.get(fromUserId)
  if (!persona || persona.tenantId !== tenantId) throw new CashCustodyError('La persona indicada no existe en esta empresa.')
  return registrar('BASE_RETURN', { ...params, fromUserId }, database, async (hasta) => {
    const pos = await personalCashPosition({ tenantId, routeId, userId: fromUserId, hasta }, database)
    if (Number(params.amount) > pos.esperado) {
      throw new CashCustodyError(`La devolución supera el efectivo a cargo de ${persona.nombre} (${Math.max(0, pos.esperado)}).`)
    }
  })
}

/** Persona → persona dentro de la misma Route (p. ej. un Supervisor refuerza a un Cobrador). */
export async function transferBaseBetweenWorkers(
  params: CustodyParams & { fromUserId: string; toUserId: string },
  database: RutaCashDB = db,
): Promise<CashCustodyMovement> {
  const { actor, tenantId, routeId, fromUserId, toUserId } = params
  assertCan(actor, 'cashCustody.manage', { routeId, tenantId })
  await rutaDeLaEmpresa(routeId, tenantId, database)
  await assertRouteOperationalContext(routeId)
  if (fromUserId === toUserId) throw new CashCustodyError('Quien entrega y quien recibe deben ser personas distintas.')
  if (actor!.id === fromUserId) {
    throw new CashCustodyError('No puedes registrar un traspaso que reduce tu propia responsabilidad: debe registrarlo otra persona.')
  }
  const origen = await database.users.get(fromUserId)
  if (!origen || origen.tenantId !== tenantId) throw new CashCustodyError('La persona que entrega no existe en esta empresa.')
  const bloqueo = custodianBlockedReason(await database.users.get(toUserId), routeId, tenantId)
  if (bloqueo) throw new CashCustodyError(bloqueo)
  return registrar('PERSON_TO_PERSON', { ...params, fromUserId, toUserId }, database, async (hasta) => {
    const pos = await personalCashPosition({ tenantId, routeId, userId: fromUserId, hasta }, database)
    if (Number(params.amount) > pos.esperado) {
      throw new CashCustodyError(`El traspaso supera el efectivo a cargo de ${origen.nombre} (${Math.max(0, pos.esperado)}).`)
    }
  })
}

/** Movimientos de custodia de una persona en una Route (consulta; más reciente primero). */
export async function listCustodyMovements(routeId: string, database: RutaCashDB = db): Promise<CashCustodyMovement[]> {
  const movs = await database.cashCustodyMovements.where('routeId').equals(routeId).toArray()
  return movs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
