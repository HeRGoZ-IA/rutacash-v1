// ============================================================
// ANULACIÓN AUDITABLE DE MOVIMIENTOS DE FONDOS (servicio de dominio)
// ------------------------------------------------------------
// Ajustes del socio 2026-10-02, punto 3: un capital, retiro o transferencia
// registrado por error no se edita ni se borra. Se ANULA:
//
//   original  → queda en el libro, marcado ANULADO (quién, cuándo, motivo, vínculo)
//   reversión → asiento espejo: mismo tipo y dirección, importe NEGADO, fecha de hoy
//
// Los agregados (motor de caja, conciliación, Caja socios, cuadres) suman
// algebraicamente: original + reversión = 0 sin filtrar estados. La reversión lleva
// la fecha de la ANULACIÓN, no la del original: no reescribe periodos cerrados.
//
// TRANSFERENCIAS: se anulan TODAS sus patas en una sola transacción — la
// transferencia, sus movimientos de Caja socios y, si el efectivo se entregó en
// mano, la custodia (devolución técnica de esa persona a la Route).
//
// REGLAS (revalidadas dentro de la transacción, sobre el registro releído):
//   · misma capacidad y alcance que para REGISTRAR ese tipo de movimiento;
//   · motivo obligatorio; solo se anula un movimiento vigente; una reversión no
//     es anulable (no hay cadenas A→B→A);
//   · si la anulación SACA dinero de una Route, rige la misma regla que un retiro:
//     no puede superar la caja no asignada (no toca efectivo en manos de nadie).
//     El dinero entregado en mano solo se revierte si esa persona aún lo tiene.
//
// v16 — CAPITAL POR ADMINISTRADOR: anular es CORREGIR ('correct'): lo hace el
// Administrador responsable de capital de la ruta o el SuperAdmin. La reversión se
// atribuye a la bolsa del responsable ACTUAL (`adminId`), que es quien responde por
// la ruta desde el último traspaso: anular un capital devuelve el dinero a su bolsa;
// anular un retiro lo saca de su bolsa (no puede superar su disponible). Una ruta
// sin responsable válido no admite anulaciones (fail closed).
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { authorizedRouteIdsOf, can, canAccessRoute, canOperateRouteCash, isTransferInScope, routeCapitalController } from '@/lib/permissions'
import { adminCapital } from '@/lib/capitalAllocation'
import { isReversible, normalizeReversalReason, reversalStateOf } from '@/lib/movementReversal'
import { assertCan, assertRouteAccess, assertRouteCashAuthority, AuthzError } from '@/services/authz'
import { loadCapitalRows, type CapitalControlDatabase } from '@/services/capitalControlService'
import { logAction } from '@/services/auditService'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { reconciliationTables } from '@/services/cashCustodyService'
import type {
  CapitalMovement, CashCustodyMovement, MovementReversalFields, PartnerCashMovement, Route, Transfer, User, Withdrawal,
} from '@/models/types'

export class MovementReversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MovementReversalError'
  }
}

export interface ReverseParams {
  actor: User | null | undefined
  tenantId: string
  movementId: string
  reason: string
}

function prepare(params: ReverseParams): { actor: User; motivo: string } {
  if (!params.actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new MovementReversalError('Indica el motivo de la anulación.')
  return { actor: params.actor, motivo }
}

function assertVigente(m: MovementReversalFields | undefined, tenantId: string, tenantOf: (m: MovementReversalFields) => string): void {
  if (!m || tenantOf(m) !== tenantId) throw new MovementReversalError('El movimiento no existe.')
  const estado = reversalStateOf(m)
  if (estado === 'anulado') throw new MovementReversalError('Este movimiento ya fue anulado.')
  if (estado === 'reversion') throw new MovementReversalError('Una reversión no se puede anular.')
}

/** Alcance de las anulaciones de fondos: conciliación + libro de capital. */
function reversalTables(database: RutaCashDB) {
  return [...new Set([...reconciliationTables(database), database.capitalLedger, database.routeCapitalControllerEvents])]
}

/**
 * Autoridad de CORRECCIÓN sobre la caja de la ruta (datos releídos dentro de la
 * transacción). Devuelve el responsable actual: la reversión se atribuye a su bolsa.
 */
async function responsableParaCorregir(actor: User, routeId: string, tenantId: string, database: RutaCashDB): Promise<User> {
  const [route, users] = await Promise.all([
    database.routes.get(routeId),
    database.users.where('tenantId').equals(tenantId).toArray(),
  ])
  assertRouteCashAuthority(actor, route, 'correct', users)
  return routeCapitalController(route, users)!
}

/** Campos que se escriben en el ORIGINAL al anularlo. */
const marcaAnulado = (reversalId: string, actor: User, ahora: string, motivo: string): MovementReversalFields => ({
  reversalId, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo,
})

/** La anulación saca `monto` de la caja NO asignada de la Route: misma regla que un retiro. */
async function assertFondosParaRevertir(database: RutaCashDB, tenantId: string, routeId: string, monto: number, hasta: string) {
  if (monto <= 0) return
  const r = await computeRouteCashReconciliation({ tenantId, routeId, hasta }, database)
  if (monto > r.disponible) {
    throw new MovementReversalError(`La ruta ya no tiene ese dinero disponible para revertir (disponible: ${r.disponible}).`)
  }
}

async function auditar(actor: User, tenantId: string, routeId: string | undefined, entityType: string, entityId: string, valor: number, reversalId: string, motivo: string) {
  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, routeId, action: 'MOVEMENT_REVERSED',
    entityType, entityId, descripcion: `Movimiento anulado (${valor}): ${motivo}`, motivo,
    before: { valor, estado: 'vigente' }, after: { estado: 'anulado', reversalId },
  }).catch(() => undefined)
}

// ------------------------------------------------------------
// CAPITAL
// ------------------------------------------------------------
export async function reverseCapitalMovement(
  params: ReverseParams, database: RutaCashDB = db,
): Promise<{ original: CapitalMovement; reversal: CapitalMovement }> {
  const { actor, motivo } = prepare(params)
  const { tenantId, movementId } = params
  const previo = await database.capitalMovements.get(movementId)
  if (!previo || previo.tenantId !== tenantId) throw new MovementReversalError('El movimiento no existe.')
  assertCan(actor, 'capital.manage', { routeId: previo.routeId, tenantId })
  assertRouteAccess(actor, previo.routeId)

  let original!: CapitalMovement
  let reversal!: CapitalMovement
  await database.transaction('rw', reversalTables(database), async () => {
    const m = await database.capitalMovements.get(movementId)
    assertVigente(m, tenantId, x => (x as CapitalMovement).tenantId)
    const responsable = await responsableParaCorregir(actor, m!.routeId, tenantId, database)
    const ahora = nowISO()
    await assertFondosParaRevertir(database, tenantId, m!.routeId, m!.valor, ahora)
    // El capital anulado vuelve a la bolsa del responsable ACTUAL.
    reversal = {
      id: generateId(), tenantId, routeId: m!.routeId, tipo: m!.tipo, valor: -m!.valor,
      descripcion: `Reversión: ${motivo}`, fecha: today(), userId: actor.id, createdAt: ahora,
      reversesId: m!.id, reversalReason: motivo, adminId: responsable.id,
    }
    original = { ...m!, ...marcaAnulado(reversal.id, actor, ahora, motivo) }
    await database.capitalMovements.add(reversal)
    await database.capitalMovements.put(original)
  })
  await auditar(actor, tenantId, original.routeId, 'capitalMovement', original.id, original.valor, reversal.id, motivo)
  return { original, reversal }
}

// ------------------------------------------------------------
// RETIROS
// ------------------------------------------------------------
export async function reverseWithdrawal(
  params: ReverseParams, database: RutaCashDB = db,
): Promise<{ original: Withdrawal; reversal: Withdrawal }> {
  const { actor, motivo } = prepare(params)
  const { tenantId, movementId } = params
  const previo = await database.withdrawals.get(movementId)
  if (!previo || previo.tenantId !== tenantId) throw new MovementReversalError('El movimiento no existe.')
  assertCan(actor, 'capital.manage', { routeId: previo.routeId, tenantId })
  assertRouteAccess(actor, previo.routeId)

  let original!: Withdrawal
  let reversal!: Withdrawal
  await database.transaction('rw', reversalTables(database), async () => {
    const w = await database.withdrawals.get(movementId)
    assertVigente(w, tenantId, x => (x as Withdrawal).tenantId)
    const responsable = await responsableParaCorregir(actor, w!.routeId, tenantId, database)
    const ahora = nowISO()
    // Anular un retiro DEVUELVE el dinero a la Route desde la bolsa del responsable
    // actual: no puede superar su disponible (nunca bolsa negativa).
    const disponible = adminCapital(responsable.id, await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)).disponible
    if (w!.valor > disponible) {
      throw new MovementReversalError(`El responsable de la ruta (${responsable.nombre}) no tiene ese capital disponible para devolverlo a la ruta (disponible: ${disponible}).`)
    }
    reversal = {
      id: generateId(), tenantId, routeId: w!.routeId, valor: -w!.valor,
      descripcion: `Reversión: ${motivo}`, fecha: today(), userId: actor.id, createdAt: ahora,
      reversesId: w!.id, reversalReason: motivo, adminId: responsable.id,
    }
    original = { ...w!, ...marcaAnulado(reversal.id, actor, ahora, motivo) }
    await database.withdrawals.add(reversal)
    await database.withdrawals.put(original)
  })
  await auditar(actor, tenantId, original.routeId, 'withdrawal', original.id, original.valor, reversal.id, motivo)
  return { original, reversal }
}

// ------------------------------------------------------------
// TRANSFERENCIAS (todas las patas, una transacción)
// ------------------------------------------------------------
export interface TransferReversalResult {
  original: Transfer
  reversal: Transfer
  partnerReversals: PartnerCashMovement[]
  custodyReversals: CashCustodyMovement[]
}

export async function reverseTransfer(
  params: ReverseParams, database: RutaCashDB = db,
): Promise<TransferReversalResult> {
  const { actor, motivo } = prepare(params)
  const { tenantId, movementId } = params
  const previo = await database.transfers.get(movementId)
  if (!previo || previo.tenantId !== tenantId) throw new MovementReversalError('El movimiento no existe.')
  assertCan(actor, 'transfer.create', { tenantId })
  const users = await database.users.where('tenantId').equals(tenantId).toArray()
  if (!isTransferInScope(actor, previo, socioId => authorizedRouteIdsOf(users.find(u => u.id === socioId)))) {
    throw new AuthzError('No puedes anular una transferencia desde/hacia una ruta o socio fuera de tu alcance.')
  }

  const result = {} as TransferReversalResult
  await database.transaction('rw', [...reversalTables(database), database.partnerCashMovements], async () => {
    const t = await database.transfers.get(movementId)
    assertVigente(t, tenantId, x => (x as Transfer).tenantId)
    // v16: corrige el responsable de CADA ruta implicada (o el SuperAdmin).
    const responsables: User[] = []
    for (const routeId of [t!.routeOrigenId, t!.routeDestinoId].filter(Boolean) as string[]) {
      responsables.push(await responsableParaCorregir(actor, routeId, tenantId, database))
    }
    const esTraslado = !!t!.routeOrigenId && !!t!.routeDestinoId
    if (esTraslado && responsables[0].id !== responsables[1].id) {
      throw new MovementReversalError('Las dos rutas tienen hoy responsables de capital distintos: anular este traslado movería capital entre sus bolsas. El SuperAdmin debe resolverlo reasignando capital.')
    }
    const ahora = nowISO()
    const fecha = today()
    const reversalId = generateId()

    // Patas enlazadas (vigentes) de ESTA transferencia.
    const patasSocio = (await database.partnerCashMovements.where('relatedTransferId').equals(t!.id).toArray())
      .filter(m => m.tenantId === tenantId && isReversible(m))
    const patasCustodia = (await database.cashCustodyMovements.where('relatedTransferId').equals(t!.id).toArray())
      .filter(m => m.tenantId === tenantId && m.tipo === 'BASE_ASSIGNMENT' && isReversible(m))

    // Route destino: pierde la transferencia. Lo entregado en mano sale de la persona
    // (si aún lo tiene); el resto, de la caja no asignada (regla de retiro).
    if (t!.routeDestinoId) {
      const r = await computeRouteCashReconciliation({ tenantId, routeId: t!.routeDestinoId, hasta: ahora }, database)
      for (const c of patasCustodia) {
        const tiene = r.personas.find(p => p.userId === c.toUserId)?.posicion ?? 0
        if (tiene < c.amount) {
          throw new MovementReversalError(`El efectivo de esta transferencia se entregó en mano y esa persona ya no lo tiene (tiene: ${tiene}). Registra primero su devolución o cuadre.`)
        }
      }
      const desdeCaja = t!.valor - patasCustodia.reduce((s, c) => s + c.amount, 0)
      if (desdeCaja > r.disponible) {
        throw new MovementReversalError(`La ruta destino ya no tiene ese dinero disponible para revertir (disponible: ${r.disponible}).`)
      }
    }

    const reversal: Transfer = {
      ...t!, id: reversalId, valor: -t!.valor, descripcion: `Reversión: ${motivo}`, fecha, userId: actor.id, createdAt: ahora,
      reversesId: t!.id, reversalReason: motivo,
      reversalId: undefined, reversedAt: undefined, reversedByUserId: undefined,
      adminId: esTraslado ? responsables[0].id : undefined,
    }
    const partnerReversals: PartnerCashMovement[] = patasSocio.map(m => ({
      id: generateId(), tenantId, partnerId: m.partnerId, type: m.type, category: m.category, amount: -m.amount,
      description: `Reversión de transferencia: ${motivo}`, relatedTransferId: reversalId, fecha, createdAt: ahora, createdBy: actor.id,
      reversesId: m.id, reversalReason: motivo,
    }))
    const custodyReversals: CashCustodyMovement[] = patasCustodia.map(c => ({
      id: generateId(), tenantId, routeId: c.routeId, tipo: 'BASE_RETURN', amount: c.amount,
      fromUserId: c.toUserId, origen: 'transfer', relatedTransferId: reversalId,
      motivo: `Anulación de transferencia: ${motivo}`, fecha, createdAt: ahora, createdByUserId: actor.id,
      reversesId: c.id, reversalReason: motivo,
    }))

    await database.transfers.add(reversal)
    await database.transfers.put({ ...t!, ...marcaAnulado(reversalId, actor, ahora, motivo) })
    if (partnerReversals.length) {
      await database.partnerCashMovements.bulkAdd(partnerReversals)
      await database.partnerCashMovements.bulkPut(patasSocio.map((m, i) => ({ ...m, ...marcaAnulado(partnerReversals[i].id, actor, ahora, motivo) })))
    }
    if (custodyReversals.length) {
      await database.cashCustodyMovements.bulkAdd(custodyReversals)
      await database.cashCustodyMovements.bulkPut(patasCustodia.map((c, i) => ({ ...c, ...marcaAnulado(custodyReversals[i].id, actor, ahora, motivo) })))
    }
    Object.assign(result, {
      original: { ...t!, ...marcaAnulado(reversalId, actor, ahora, motivo) }, reversal, partnerReversals, custodyReversals,
    })
  })
  await auditar(actor, tenantId, result.original.routeDestinoId || result.original.routeOrigenId || undefined,
    'transfer', result.original.id, result.original.valor, result.reversal.id, motivo)
  return result
}

// ------------------------------------------------------------
// Para la UI: ¿mostrar "Anular movimiento"? (el servicio revalida siempre)
// ------------------------------------------------------------
export function canReverseRouteFund(
  actor: User | null | undefined,
  m: { routeId: string; tenantId: string } & MovementReversalFields,
  routes: Route[],
  users: User[],
): boolean {
  return isReversible(m) && can(actor, 'capital.manage', { routeId: m.routeId, tenantId: m.tenantId }) && canAccessRoute(actor, m.routeId)
    && canOperateRouteCash(actor, routes.find(r => r.id === m.routeId), 'correct', users)
}

export function canReverseTransfer(
  actor: User | null | undefined, t: Transfer, partnerRouteIds: (socioId: string) => string[], routes: Route[], users: User[],
): boolean {
  const rutas = [t.routeOrigenId, t.routeDestinoId].filter(Boolean) as string[]
  return isReversible(t) && can(actor, 'transfer.create', { tenantId: t.tenantId }) && isTransferInScope(actor, t, partnerRouteIds)
    && rutas.every(id => canOperateRouteCash(actor, routes.find(r => r.id === id), 'correct', users))
}
