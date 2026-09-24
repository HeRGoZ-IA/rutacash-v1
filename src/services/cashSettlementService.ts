// ============================================================
// CUADRE REAL POR TRABAJADOR — SERVICIO (preview · cierre · reapertura · consulta)
// ------------------------------------------------------------
// Responde: "¿cuánto efectivo debía entregar ESTA persona en ESTA ruta, cuánto
// entregó realmente y qué diferencia quedó?". Es un documento distinto de la
// liquidación semanal (`WeeklySettlement`, cierre de la RUTA) y no la sustituye.
//
// GARANTÍAS:
//  · El ESPERADO lo calcula SIEMPRE este servicio en el instante del cierre. La
//    pantalla solo envía ruta, persona, entregado y motivo. `esperadoVisto` sirve
//    únicamente para detectar que las cifras cambiaron mientras se miraba la vista
//    previa (se rechaza); jamás se archiva ese valor.
//  · Nadie cierra su propio cuadre. Admin y Super Admin cierran; el Supervisor
//    cierra el de OTRO trabajador de sus rutas.
//  · Cerrar NO toca pagos, ventas ni gastos: solo añade un documento.
//  · Reabrir exige motivo, no borra nada y solo aplica al ÚLTIMO cuadre vigente de
//    esa persona en esa ruta. Volver a cerrar crea una versión nueva.
//
// OFICINA INACTIVA: no bloquea el cuadre. Una Oficina inactiva congela operaciones
// NUEVAS (cobrar, desembolsar); cuadrar no crea movimientos, solo registra la
// entrega de efectivo que ya existe — impedirlo dejaría dinero sin conciliar
// justo cuando se cierra una Oficina.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { logAction } from '@/services/auditService'
import { assertCan, AuthzError } from '@/services/authz'
import { getCollectorCashSummary } from '@/services/cashboxEngine'
import { can, filterAccessibleRoutes } from '@/lib/permissions'
import { getAssignedRouteIds } from '@/lib/roles'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import {
  MIN_CASH_REASON,
  carryOverFrom,
  closeCycleBlockedReason,
  computeExpected,
  isActiveCashSettlement,
  lastActiveCashSettlement,
  nextCashVersion,
  pendingShortages,
  reopenCashBlockedReason,
  settlementOutcome,
  validateDelivered,
  validateDifferenceReason,
  type CashSettlementResult,
} from '@/lib/cashSettlementRules'
import type { CashSettlement, Route, User } from '@/models/types'

export { MIN_CASH_REASON }

export type CashSettlementAuditSink = (params: Parameters<typeof logAction>[0]) => Promise<void>

export class CashSettlementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CashSettlementError'
  }
}

/** Instante de arranque del modelo personal de la empresa (v14). */
export async function cashModelStartOf(tenantId: string, database: RutaCashDB = db): Promise<string> {
  const t = await database.tenants.get(tenantId)
  return t?.cashModelStartAt || t?.createdAt || '1970-01-01T00:00:00.000Z'
}

async function settlementsOf(routeId: string, userId: string, database: RutaCashDB): Promise<CashSettlement[]> {
  return database.cashSettlements.where('[routeId+userId]').equals([routeId, userId]).toArray()
}

// ------------------------------------------------------------
// Validación del trabajador y de la ruta (común a preview y cierre)
// ------------------------------------------------------------
async function resolveTarget(
  tenantId: string, routeId: string, userId: string, database: RutaCashDB,
): Promise<{ route: Route; target: User }> {
  const route = await database.routes.get(routeId)
  if (!route) throw new CashSettlementError('La ruta indicada no existe.')
  if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
  const target = await database.users.get(userId)
  if (!target || target.tenantId !== tenantId) throw new CashSettlementError('El trabajador indicado no existe en esta empresa.')
  if (!hasPersonalCashbox(target.rol)) {
    throw new CashSettlementError('Solo Cobradores y Supervisores tienen efectivo personal que cuadrar.')
  }
  if (!getAssignedRouteIds(target).includes(routeId)) {
    throw new CashSettlementError('El trabajador no está asignado a esta ruta.')
  }
  return { route, target }
}

// ------------------------------------------------------------
// VISTA PREVIA
// ------------------------------------------------------------
export interface CashSettlementPreview {
  tenantId: string
  routeId: string
  routeName: string
  userId: string
  userName: string
  userRol: User['rol']
  desde: string
  hasta: string
  origenDesde: CashSettlement['origenDesde']
  previousSettlementId?: string
  arrastreAnterior: number
  recaudado: number
  desembolsado: number
  gastos: number
  esperado: number
  /** Instante de arranque del modelo personal (referencia para la UI). */
  modelStart: string
}

async function computeCycle(
  tenantId: string, route: Route, target: User, hasta: string, database: RutaCashDB,
): Promise<{ preview: CashSettlementPreview; existentes: CashSettlement[] }> {
  const modelStart = await cashModelStartOf(tenantId, database)
  const existentes = await settlementsOf(route.id, target.id, database)
  const previo = lastActiveCashSettlement(existentes, route.id, target.id)
  const desde = previo?.hasta ?? modelStart
  const arrastreAnterior = carryOverFrom(previo)
  const mov = await getCollectorCashSummary({ routeId: route.id, userId: target.id, desde, hasta, modelStart }, database)
  const preview: CashSettlementPreview = {
    tenantId, routeId: route.id, routeName: route.nombre,
    userId: target.id, userName: target.nombre, userRol: target.rol,
    desde, hasta,
    origenDesde: previo ? 'ultimo-cierre' : 'inicio-modelo',
    previousSettlementId: previo?.id,
    arrastreAnterior,
    recaudado: mov.recaudado,
    desembolsado: mov.desembolsado,
    gastos: mov.gastos,
    esperado: computeExpected({ arrastreAnterior, ...mov }),
    modelStart,
  }
  return { preview, existentes }
}

/**
 * Lo que la persona debería entregar AHORA. No persiste nada.
 * Sobre uno mismo exige `cashSettlement.viewOwn` (Mi efectivo); sobre otro,
 * `cashSettlement.view`. Ambos contra la ruta.
 */
export async function previewCashSettlement(
  params: { actor: User | null | undefined; tenantId: string; routeId: string; userId: string; hasta?: string },
  database: RutaCashDB = db,
): Promise<CashSettlementPreview> {
  const { actor, tenantId, routeId, userId } = params
  const propio = actor?.id === userId
  assertCan(actor, propio ? 'cashSettlement.viewOwn' : 'cashSettlement.view', { routeId, tenantId })
  const { route, target } = await resolveTarget(tenantId, routeId, userId, database)
  const { preview } = await computeCycle(tenantId, route, target, params.hasta ?? nowISO(), database)
  return preview
}

// ------------------------------------------------------------
// CIERRE
// ------------------------------------------------------------
export interface CloseCashSettlementParams {
  actor: User | null | undefined
  tenantId: string
  routeId: string
  userId: string
  /** Efectivo físicamente recibido. */
  entregado: number
  /** Obligatorio si hay faltante o sobrante. */
  motivo?: string
  /**
   * Esperado que el usuario tenía en pantalla. NO es fuente de verdad: si difiere
   * del que calcula el servicio, se rechaza para que revise las cifras nuevas.
   */
  esperadoVisto?: number
}

export async function closeCashSettlement(
  params: CloseCashSettlementParams,
  database: RutaCashDB = db,
  auditSink: CashSettlementAuditSink = logAction,
): Promise<CashSettlement> {
  const { actor, tenantId, routeId, userId } = params

  // 1) Permiso CON ruta y empresa.
  assertCan(actor, 'cashSettlement.close', { routeId, tenantId })
  // 2) Nadie se cuadra a sí mismo: quien entrega no puede ser quien recibe.
  if (actor!.id === userId) {
    throw new CashSettlementError('No puedes cerrar tu propio cuadre: debe hacerlo otra persona autorizada.')
  }
  // 3) Ruta, empresa, trabajador con caja personal asignado a la ruta.
  const { route, target } = await resolveTarget(tenantId, routeId, userId, database)
  // 4) Entregado.
  const errEntregado = validateDelivered(params.entregado)
  if (errEntregado) throw new CashSettlementError(errEntregado)
  const entregado = Number(params.entregado)

  // 5) Cifras recalculadas AHORA por el motor, nunca las de la pantalla.
  const hasta = nowISO()
  const { preview, existentes } = await computeCycle(tenantId, route, target, hasta, database)
  const bloqueo = closeCycleBlockedReason(existentes, routeId, userId, preview.desde, hasta)
  if (bloqueo) throw new CashSettlementError(bloqueo)
  if (params.esperadoVisto !== undefined && params.esperadoVisto !== preview.esperado) {
    throw new CashSettlementError(
      'Las cifras cambiaron desde la vista previa (hubo movimientos nuevos). Revisa el nuevo esperado antes de cerrar.',
    )
  }

  // 6) Diferencia y motivo.
  const outcome = settlementOutcome(preview.esperado, entregado)
  const motivo = (params.motivo ?? '').trim()
  const errMotivo = validateDifferenceReason(outcome.diferencia, motivo)
  if (errMotivo) throw new CashSettlementError(errMotivo)

  const { version, sustituye } = nextCashVersion(existentes, routeId, userId, preview.desde)
  const documento: CashSettlement = {
    id: generateId(),
    tenantId, routeId, userId,
    desde: preview.desde,
    hasta,
    origenDesde: preview.origenDesde,
    previousSettlementId: preview.previousSettlementId,
    arrastreAnterior: preview.arrastreAnterior,
    recaudado: preview.recaudado,
    desembolsado: preview.desembolsado,
    gastos: preview.gastos,
    esperado: preview.esperado,
    entregado,
    diferencia: outcome.diferencia,
    faltante: outcome.faltante,
    sobrante: outcome.sobrante,
    motivo: motivo || undefined,
    status: 'cerrada',
    version,
    createdAt: hasta,
    closedAt: hasta,
    closedByUserId: actor!.id,
  }

  // 7) Escritura atómica. Se revalida DENTRO de la transacción que nadie cerró este
  //    mismo ciclo entre la lectura y la escritura (dos pestañas del mismo navegador).
  await database.transaction('rw', [database.cashSettlements], async () => {
    const actuales = await settlementsOf(routeId, userId, database)
    const ultimo = lastActiveCashSettlement(actuales, routeId, userId)
    if ((ultimo?.id ?? null) !== (preview.previousSettlementId ?? null)
      || closeCycleBlockedReason(actuales, routeId, userId, preview.desde, hasta)) {
      throw new CashSettlementError('Otro usuario cerró este cuadre hace un momento. Recarga la vista previa.')
    }
    await database.cashSettlements.add(documento)
    for (const previo of sustituye) {
      await database.cashSettlements.update(previo.id, { supersededBy: documento.id })
    }
  })

  await auditSink({
    tenantId,
    userId: actor!.id,
    userRole: actor!.rol,
    routeId,
    action: 'CASH_SETTLEMENT_CLOSED',
    entityType: 'cashSettlement',
    entityId: documento.id,
    descripcion:
      `Cuadre de ${target.nombre} en "${route.nombre}" (v${version}): esperado ${documento.esperado}, ` +
      `entregado ${entregado}, ${outcome.resultado === 'exacto' ? 'cuadre exacto'
        : outcome.resultado === 'faltante' ? `FALTANTE ${outcome.faltante}` : `SOBRANTE ${outcome.sobrante}`}.`,
    after: {
      desde: documento.desde, hasta: documento.hasta, arrastreAnterior: documento.arrastreAnterior,
      recaudado: documento.recaudado, desembolsado: documento.desembolsado, gastos: documento.gastos,
      esperado: documento.esperado, entregado, diferencia: documento.diferencia, version,
    },
    motivo: documento.motivo,
    metadata: { trabajador: userId, sustituye: sustituye.map(s => s.id) },
  })

  return documento
}

// ------------------------------------------------------------
// REAPERTURA
// ------------------------------------------------------------
export async function reopenCashSettlement(
  params: { actor: User | null | undefined; settlementId: string; motivo: string },
  database: RutaCashDB = db,
  auditSink: CashSettlementAuditSink = logAction,
): Promise<CashSettlement> {
  const { actor, settlementId } = params
  const motivo = (params.motivo ?? '').trim()
  const doc = await database.cashSettlements.get(settlementId)
  if (!doc) throw new CashSettlementError('El cuadre indicado no existe.')
  // Permiso con la ruta y la empresa del DOCUMENTO, no las de la pantalla.
  assertCan(actor, 'cashSettlement.reopen', { routeId: doc.routeId, tenantId: doc.tenantId })
  if (motivo.length < MIN_CASH_REASON) {
    throw new CashSettlementError(`Debes explicar el motivo de la reapertura (mínimo ${MIN_CASH_REASON} caracteres).`)
  }
  const bloqueo = reopenCashBlockedReason(doc, await settlementsOf(doc.routeId, doc.userId, database))
  if (bloqueo) throw new CashSettlementError(bloqueo)

  const cambios: Partial<CashSettlement> = {
    status: 'reabierta', reopenedAt: nowISO(), reopenedByUserId: actor!.id, reopenReason: motivo,
  }
  await database.transaction('rw', [database.cashSettlements], async () => {
    await database.cashSettlements.update(settlementId, cambios)
  })
  await auditSink({
    tenantId: doc.tenantId,
    userId: actor!.id,
    userRole: actor!.rol,
    routeId: doc.routeId,
    action: 'CASH_SETTLEMENT_REOPENED',
    entityType: 'cashSettlement',
    entityId: settlementId,
    descripcion: `Cuadre v${doc.version} REABIERTO. El siguiente cierre vuelve a partir de ${doc.desde}.`,
    before: { status: 'cerrada' },
    after: { status: 'reabierta' },
    motivo,
    metadata: { trabajador: doc.userId },
  })
  return { ...doc, ...cambios }
}

// ------------------------------------------------------------
// CONSULTA CON ALCANCE
// ------------------------------------------------------------
/**
 * Cuadres visibles para `actor`: los de sus rutas autorizadas si tiene
 * `cashSettlement.view`; si solo tiene `cashSettlement.viewOwn`, únicamente los
 * suyos. Fail-closed: sin rutas, nada.
 */
export async function listCashSettlementsForUser(
  actor: User | null | undefined,
  tenantId: string,
  database: RutaCashDB = db,
): Promise<CashSettlement[]> {
  if (!actor) return []
  const rutas = filterAccessibleRoutes(actor, await database.routes.where('tenantId').equals(tenantId).toArray())
  const todas = await database.cashSettlements.where('tenantId').equals(tenantId).toArray()
  return todas
    .filter(s => rutas.some(r => r.id === s.routeId))
    .filter(s => can(actor, 'cashSettlement.view', { routeId: s.routeId, tenantId })
      || (s.userId === actor.id && can(actor, 'cashSettlement.viewOwn', { routeId: s.routeId, tenantId })))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt))
}

/** Trabajadores cuadrables de una ruta: con caja personal y asignados a ella. */
export async function listSettleableWorkers(
  actor: User | null | undefined,
  tenantId: string,
  routeId: string,
  database: RutaCashDB = db,
): Promise<{ user: User; esPropio: boolean }[]> {
  if (!can(actor, 'cashSettlement.view', { routeId, tenantId })) return []
  const users = await database.users.where('tenantId').equals(tenantId).toArray()
  return users
    .filter(u => hasPersonalCashbox(u.rol) && getAssignedRouteIds(u).includes(routeId))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(u => ({ user: u, esPropio: u.id === actor!.id }))
}

/** Trabajadores con FALTANTE pendiente (último cuadre vigente con diferencia < 0). */
export async function getPendingShortagesForUser(
  actor: User | null | undefined,
  tenantId: string,
  database: RutaCashDB = db,
): Promise<CashSettlement[]> {
  const visibles = (await listCashSettlementsForUser(actor, tenantId, database))
    .filter(s => can(actor, 'cashSettlement.view', { routeId: s.routeId, tenantId }))
  return pendingShortages(visibles)
}

/** Etiqueta del resultado de un cuadre. */
export function cashResultOf(s: Pick<CashSettlement, 'diferencia'>): CashSettlementResult {
  return s.diferencia === 0 ? 'exacto' : s.diferencia < 0 ? 'faltante' : 'sobrante'
}

export { isActiveCashSettlement }
