// ============================================================
// CAPITAL CENTRALIZADO (C1) — PRIMITIVAS DE BOLSA (dentro de una transacción)
// ------------------------------------------------------------
// Las usan los servicios existentes (cuadre, pagos, desembolso, gastos) y el
// servicio de capital centralizado, SIEMPRE dentro de su propia transacción Dexie,
// que debe incluir `centralLedgerTables`. No abren transacciones ni auditan: el
// llamador decide la atomicidad y la traza.
//
//   creditControllerPool   ruta → bolsa del responsable (Withdrawal con adminId)
//   debitControllerPool    bolsa del responsable → ruta (CapitalMovement con adminId),
//                          con el disponible RELEÍDO aquí: nunca bolsa negativa
//   reverseCentralWithdrawal / reverseCentralCapitalMovement
//                          asiento espejo (importe negado, `reversesId`) con la misma
//                          convención que `movementReversalService`; la bolsa
//                          afectada es la del responsable ACTUAL
//
// Este módulo no importa servicios de custodia, cuadre ni fondos (evita ciclos).
// ============================================================
import { generateId } from '@/lib/utils'
import { nowISO, today } from '@/lib/formatters'
import { adminCapital } from '@/lib/capitalAllocation'
import { CENTRAL_CAPITAL_MESSAGES, isCentralCapitalActive } from '@/lib/centralCapital'
import { NO_CAPITAL_CONTROLLER_MESSAGE, routeCapitalController } from '@/lib/permissions'
import { loadCapitalRows, type CapitalControlDatabase } from '@/services/capitalControlService'
import type { RutaCashDB } from '@/lib/db'
import type { CapitalMovement, CentralCapitalLink, User, Withdrawal } from '@/models/types'

export class CentralCapitalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CentralCapitalError'
  }
}

/** Tablas que debe incluir la transacción del llamador (bolsas + responsable + periodo). */
export function centralLedgerTables(database: RutaCashDB) {
  return [
    database.tenants, database.routes, database.users, database.capitalLedger, database.capitalMovements,
    database.withdrawals, database.transfers, database.expenses, database.weeklySettlements,
  ]
}

/** ¿La empresa opera con capital centralizado? (lectura; dentro o fuera de transacción). */
export async function centralCapitalActiveFor(tenantId: string, database: Pick<RutaCashDB, 'tenants'>): Promise<boolean> {
  return isCentralCapitalActive(await database.tenants.get(tenantId))
}

/** Responsable de capital VÁLIDO de la ruta, releído; sin él, nada procede (fail closed). */
export async function controllerForCentral(database: RutaCashDB, tenantId: string, routeId: string): Promise<User> {
  const [route, users] = await Promise.all([
    database.routes.get(routeId),
    database.users.where('tenantId').equals(tenantId).toArray(),
  ])
  if (!route || route.tenantId !== tenantId) throw new CentralCapitalError('La ruta no existe en esta empresa.')
  const controller = routeCapitalController(route, users)
  if (!controller) throw new CentralCapitalError(NO_CAPITAL_CONTROLLER_MESSAGE)
  return controller
}

/** Disponible de la bolsa del Administrador, releído dentro de la transacción. */
export async function poolAvailable(database: RutaCashDB, tenantId: string, adminId: string): Promise<number> {
  return adminCapital(adminId, await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)).disponible
}

interface PoolMoveParams {
  tenantId: string
  routeId: string
  amount: number
  actor: Pick<User, 'id'>
  link: CentralCapitalLink
  /** Id del movimiento (determinista para idempotencia). */
  id: string
  /** Fecha contable (por defecto hoy). La del hecho que lo origina. */
  fecha?: string
  descripcion: string
  /** Responsable ya resuelto por el llamador (si no, se relee). */
  controller?: User
}

/** Ruta → bolsa del responsable. `amount` > 0. */
export async function creditControllerPool(database: RutaCashDB, p: PoolMoveParams): Promise<Withdrawal> {
  if (!(p.amount > 0)) throw new CentralCapitalError('El importe que vuelve a la bolsa debe ser mayor a 0.')
  const controller = p.controller ?? await controllerForCentral(database, p.tenantId, p.routeId)
  const w: Withdrawal = {
    id: p.id, tenantId: p.tenantId, routeId: p.routeId, valor: p.amount, descripcion: p.descripcion,
    fecha: p.fecha ?? today(), userId: p.actor.id, createdAt: nowISO(), adminId: controller.id, centralLink: p.link,
  }
  await database.withdrawals.add(w)
  return w
}

/**
 * Bolsa del responsable → ruta. Rechaza si la bolsa no alcanza o si la ruta quedó
 * BLOQUEADA al activar (C2: inconsistente o sin responsable, hasta su liberación).
 * `amount` > 0.
 */
export async function debitControllerPool(database: RutaCashDB, p: PoolMoveParams): Promise<CapitalMovement> {
  if (!(p.amount > 0)) throw new CentralCapitalError('El importe que sale de la bolsa debe ser mayor a 0.')
  if ((await database.tenants.get(p.tenantId))?.centralCapitalRouteBlocks?.[p.routeId]) {
    throw new CentralCapitalError(CENTRAL_CAPITAL_MESSAGES.rutaBloqueada)
  }
  const controller = p.controller ?? await controllerForCentral(database, p.tenantId, p.routeId)
  const disponible = await poolAvailable(database, p.tenantId, controller.id)
  if (p.amount > disponible) {
    throw new CentralCapitalError(`La bolsa del Administrador responsable (${controller.nombre}) no alcanza (disponible: ${disponible}; requerido: ${p.amount}).`)
  }
  const m: CapitalMovement = {
    id: p.id, tenantId: p.tenantId, routeId: p.routeId, tipo: 'ingresoCapital', valor: p.amount, descripcion: p.descripcion,
    fecha: p.fecha ?? today(), userId: p.actor.id, createdAt: nowISO(), adminId: controller.id, centralLink: p.link,
  }
  await database.capitalMovements.add(m)
  return m
}

interface ReverseParams {
  actor: Pick<User, 'id'>
  motivo: string
  link: CentralCapitalLink
  fecha?: string
}

const marcaAnulado = (reversalId: string, actor: Pick<User, 'id'>, ahora: string, motivo: string) => ({
  reversalId, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo,
})

/**
 * Anula un retiro centralizado: el dinero SALE de la bolsa del responsable actual y
 * vuelve a la ruta. Solo procede si esa bolsa aún lo tiene (nunca negativa).
 */
export async function reverseCentralWithdrawal(database: RutaCashDB, original: Withdrawal, p: ReverseParams): Promise<Withdrawal> {
  if (original.reversalId || original.reversesId) throw new CentralCapitalError('Ese movimiento ya fue anulado o es una reversión.')
  const controller = await controllerForCentral(database, original.tenantId, original.routeId)
  const disponible = await poolAvailable(database, original.tenantId, controller.id)
  if (original.valor > disponible) {
    throw new CentralCapitalError(`La bolsa del Administrador responsable (${controller.nombre}) ya no tiene ese dinero para revertirlo (disponible: ${disponible}; requerido: ${original.valor}).`)
  }
  const ahora = nowISO()
  const reversal: Withdrawal = {
    id: generateId(), tenantId: original.tenantId, routeId: original.routeId, valor: -original.valor,
    descripcion: `Reversión: ${p.motivo}`, fecha: p.fecha ?? today(), userId: p.actor.id, createdAt: ahora,
    reversesId: original.id, reversalReason: p.motivo, adminId: controller.id, centralLink: p.link,
  }
  await database.withdrawals.add(reversal)
  await database.withdrawals.put({ ...original, ...marcaAnulado(reversal.id, p.actor, ahora, p.motivo) })
  return reversal
}

/** Anula un capital centralizado: el dinero VUELVE a la bolsa del responsable actual. */
export async function reverseCentralCapitalMovement(database: RutaCashDB, original: CapitalMovement, p: ReverseParams): Promise<CapitalMovement> {
  if (original.reversalId || original.reversesId) throw new CentralCapitalError('Ese movimiento ya fue anulado o es una reversión.')
  const controller = await controllerForCentral(database, original.tenantId, original.routeId)
  const ahora = nowISO()
  const reversal: CapitalMovement = {
    id: generateId(), tenantId: original.tenantId, routeId: original.routeId, tipo: original.tipo, valor: -original.valor,
    descripcion: `Reversión: ${p.motivo}`, fecha: p.fecha ?? today(), userId: p.actor.id, createdAt: ahora,
    reversesId: original.id, reversalReason: p.motivo, adminId: controller.id, centralLink: p.link,
  }
  await database.capitalMovements.add(reversal)
  await database.capitalMovements.put({ ...original, ...marcaAnulado(reversal.id, p.actor, ahora, p.motivo) })
  return reversal
}
