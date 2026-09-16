// ============================================================
// LIQUIDACIONES SEMANALES PERSISTENTES — CIERRE Y REAPERTURA DE PERIODO
// ------------------------------------------------------------
// Este servicio convierte la liquidación semanal de un CÁLCULO EN PANTALLA en un
// DOCUMENTO ARCHIVADO. Es el eslabón que faltaba: la protección de correcciones
// sobre periodos cerrados ya existía completa en `paymentCorrectionService`
// (`isPaymentInClosedPeriod` → Solicitud de ajuste), pero nunca se activaba porque
// nadie escribía en `weeklySettlements`. Con el cierre persistido, esa cadena
// entera empieza a funcionar sin tocar su lógica.
//
// GARANTÍAS DE ESTE SERVICIO:
//  · Los importes archivados los produce el MOTOR FINANCIERO en el instante del
//    cierre (`generateWeeklySettlement`), nunca la pantalla. La UI no puede
//    archivar cifras propias.
//  · Un cierre NUNCA se sobrescribe. Reabrir marca el documento como 'reabierta' y
//    lo conserva; volver a cerrar crea una VERSIÓN NUEVA que apunta a la anterior.
//  · Reabrir exige MOTIVO y lo guarda para siempre.
//  · El alcance se valida en el servicio (`settlement.close` / `settlement.reopen`
//    con `routeId`), no solo en la pantalla.
//
// OFICINA: el documento guarda un SNAPSHOT histórico (`officeIdAtClose`,
// `officeNameAtClose`, `officeCodeAtClose`). Es metadata del cierre, no una fuente
// de alcance: `Route.officeId` sigue siendo el único officeId operativo y ningún
// filtro de acceso lee estos campos. Existen porque una ruta puede cambiar de
// Oficina y una semana ya cerrada no debe cambiar de Oficina retroactivamente.
//
// La base es inyectable (mismo patrón que `paymentService`, `routeService` y
// `officeService`) para poder probar el servicio real sin IndexedDB.
// ============================================================
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { assertCan, AuthzError } from '@/services/authz'
import { filterAccessibleRoutes } from '@/lib/permissions'
import { generateWeeklySettlement } from '@/services/weeklySettlementEngine'
import type { CashboxDatabase } from '@/services/cashboxEngine'
import {
  closureBlockedReason,
  isProtectingClosure,
  nextClosureVersion,
  officeSnapshotOf,
  settlementStatus,
  supersededClosures,
} from '@/lib/settlementPeriods'
import type { Office, Route, User, WeeklySettlement } from '@/models/types'

// ------------------------------------------------------------
// Contrato de base de datos
// ------------------------------------------------------------
export interface SettlementDatabase extends CashboxDatabase {
  weeklySettlements: {
    add(item: WeeklySettlement): Promise<unknown>
    get(key: string): Promise<WeeklySettlement | undefined>
    update(key: string, changes: Partial<WeeklySettlement>): Promise<number>
    where(index: string): { equals(key: string): { toArray(): Promise<WeeklySettlement[]> } }
  }
  routes: {
    get(key: string): Promise<Route | undefined>
    where(index: string): { equals(key: string): { toArray(): Promise<Route[]> } }
  }
  offices: {
    where(index: string): { equals(key: string): { toArray(): Promise<Office[]> } }
  }
  transaction<U>(mode: 'rw', tables: unknown, scope: () => PromiseLike<U>): Promise<U>
}

export type SettlementAuditSink = (params: Parameters<typeof logAction>[0]) => Promise<void>

/** Motivo de reapertura: mínimo exigido para que sea una explicación, no un punto. */
export const MIN_REOPEN_REASON = 10

export class SettlementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementError'
  }
}

// ------------------------------------------------------------
// CIERRE DE PERIODO
// ------------------------------------------------------------
export interface CloseSettlementParams {
  actor: User | null | undefined
  tenantId: string
  routeId: string
  semanaInicio: string
  semanaFin: string
}

/**
 * CIERRA una semana de UNA ruta y archiva el documento.
 *
 * Orden deliberado: permisos → ruta y empresa → validación del periodo → cálculo
 * del motor → snapshot de Oficina → escritura. Todas las lecturas ocurren ANTES de
 * la transacción, porque una transacción de Dexie solo puede tocar las tablas que
 * declara y el cálculo financiero lee ocho tablas distintas.
 */
export async function closeSettlement(
  params: CloseSettlementParams,
  database: SettlementDatabase = db as unknown as SettlementDatabase,
  auditSink: SettlementAuditSink = logAction,
): Promise<WeeklySettlement> {
  const { actor, tenantId, routeId, semanaInicio, semanaFin } = params

  // 1) PERMISO CON RUTA: cerrar es una acción sobre una ruta concreta. `can()` la
  //    valida contra `authorizedRouteIds`; no basta con tener el rol.
  assertCan(actor, 'settlement.close', { routeId, tenantId })

  // 2) La ruta debe existir y pertenecer a la empresa indicada.
  const route = await database.routes.get(routeId)
  if (!route) throw new SettlementError('La ruta indicada no existe.')
  if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')

  // 3) Estado actual del periodo en esa ruta.
  const existentes = await database.weeklySettlements.where('routeId').equals(routeId).toArray()
  const bloqueo = closureBlockedReason(existentes, routeId, semanaInicio, semanaFin)
  if (bloqueo) throw new SettlementError(bloqueo)

  // 4) IMPORTES: los produce el motor financiero AHORA, no la pantalla.
  const calculo = await generateWeeklySettlement({ tenantId, routeId, semanaInicio, semanaFin }, database)

  // 5) SNAPSHOT DE OFICINA. Se congela el nombre y el código del momento; una ruta
  //    Sin Oficina se archiva como "Sin Oficina" sin inventar ninguna.
  const offices = await database.offices.where('tenantId').equals(tenantId).toArray()
  const snapshot = officeSnapshotOf(route, offices)

  const version = nextClosureVersion(existentes, routeId, semanaInicio, semanaFin)
  const sustituidos = supersededClosures(existentes, routeId, semanaInicio, semanaFin)

  const documento: WeeklySettlement = {
    ...calculo,
    status: 'cerrada',
    createdByUserId: actor?.id,
    closedAt: nowISO(),
    closedByUserId: actor?.id,
    version,
    ...snapshot,
  }

  // 6) ESCRITURA ATÓMICA: el documento nuevo y el enlace de los sustituidos viajan
  //    juntos. Si algo falla no queda un cierre huérfano ni un histórico a medias.
  await database.transaction('rw', [database.weeklySettlements], async () => {
    await database.weeklySettlements.add(documento)
    for (const previo of sustituidos) {
      await database.weeklySettlements.update(previo.id, { supersededBy: documento.id })
    }
  })

  await auditSink({
    tenantId,
    userId: actor?.id ?? 'sistema',
    userRole: actor?.rol,
    routeId,
    action: 'SETTLEMENT_CLOSED',
    entityType: 'weeklySettlement',
    entityId: documento.id,
    descripcion:
      `Semana ${semanaInicio} a ${semanaFin} CERRADA en la ruta "${route.nombre}" ` +
      `(versión ${version}, oficina al cierre: ${snapshot.officeNameAtClose}). ` +
      `Saldo final ${documento.saldoFinal}.`,
    after: {
      semanaInicio,
      semanaFin,
      version,
      saldoFinal: documento.saldoFinal,
      officeNameAtClose: snapshot.officeNameAtClose,
    },
    metadata: { sustituye: sustituidos.map(s => s.id) },
  })

  return documento
}

// ------------------------------------------------------------
// REAPERTURA CONTROLADA
// ------------------------------------------------------------
export interface ReopenSettlementParams {
  actor: User | null | undefined
  settlementId: string
  /** OBLIGATORIO. Se conserva de forma permanente en el documento. */
  motivo: string
}

/**
 * REABRE un periodo cerrado. No borra ni recalcula nada: marca el documento como
 * 'reabierta' y guarda quién, cuándo y por qué.
 *
 * Efecto inmediato: el documento deja de proteger sus fechas, así que los pagos de
 * esa semana vuelven a ser corregibles directamente (sin Solicitud de ajuste)
 * hasta que la semana se cierre de nuevo. Por eso el motivo es obligatorio.
 */
export async function reopenSettlement(
  params: ReopenSettlementParams,
  database: SettlementDatabase = db as unknown as SettlementDatabase,
  auditSink: SettlementAuditSink = logAction,
): Promise<WeeklySettlement> {
  const { actor, settlementId } = params
  const motivo = (params.motivo ?? '').trim()

  const documento = await database.weeklySettlements.get(settlementId)
  if (!documento) throw new SettlementError('La liquidación indicada no existe.')

  // Permiso CON la ruta y la empresa del documento, no las que diga la pantalla.
  assertCan(actor, 'settlement.reopen', { routeId: documento.routeId, tenantId: documento.tenantId })

  // MOTIVO OBLIGATORIO: se valida después del permiso para no revelar la
  // existencia del documento a quien no puede tocarlo.
  if (motivo.length < MIN_REOPEN_REASON) {
    throw new SettlementError(
      `Debes explicar el motivo de la reapertura (mínimo ${MIN_REOPEN_REASON} caracteres).`,
    )
  }

  if (!isProtectingClosure(documento)) {
    const estado = settlementStatus(documento)
    throw new SettlementError(
      estado === 'reabierta'
        ? 'Esta liquidación ya está reabierta.'
        : 'Solo se puede reabrir una liquidación cerrada.',
    )
  }
  if (documento.supersededBy) {
    throw new SettlementError(
      'Esta versión ya fue sustituida por un cierre posterior. Reabre la versión vigente.',
    )
  }

  const cambios: Partial<WeeklySettlement> = {
    status: 'reabierta',
    reopenedAt: nowISO(),
    reopenedByUserId: actor?.id,
    reopenReason: motivo,
  }

  await database.transaction('rw', [database.weeklySettlements], async () => {
    await database.weeklySettlements.update(settlementId, cambios)
  })

  await auditSink({
    tenantId: documento.tenantId,
    userId: actor?.id ?? 'sistema',
    userRole: actor?.rol,
    routeId: documento.routeId,
    action: 'SETTLEMENT_REOPENED',
    entityType: 'weeklySettlement',
    entityId: settlementId,
    descripcion:
      `Semana ${documento.semanaInicio} a ${documento.semanaFin} REABIERTA ` +
      `(versión ${documento.version ?? 1}). Los pagos de esas fechas vuelven a ser corregibles.`,
    before: { status: settlementStatus(documento) },
    after: { status: 'reabierta' },
    motivo,
  })

  return { ...documento, ...cambios }
}

// ------------------------------------------------------------
// CONSULTA CON ALCANCE
// ------------------------------------------------------------
/**
 * Liquidaciones que el usuario PUEDE ver: las de sus rutas autorizadas y de su
 * empresa. Fail-closed: sin rutas autorizadas, lista vacía.
 *
 * El recorte es por RUTA. La Oficina histórica del documento no participa en el
 * filtro: es una etiqueta, no una llave.
 */
export async function listSettlementsForUser(
  user: User | null | undefined,
  tenantId: string,
  database: SettlementDatabase = db as unknown as SettlementDatabase,
): Promise<{ settlements: WeeklySettlement[]; routes: Route[] }> {
  if (!user) return { settlements: [], routes: [] }
  const routes = filterAccessibleRoutes(user, await database.routes.where('tenantId').equals(tenantId).toArray())
  if (routes.length === 0) return { settlements: [], routes: [] }

  const permitidas = new Set(routes.map(r => r.id))
  const todas = await database.weeklySettlements.where('tenantId').equals(tenantId).toArray()
  return { settlements: todas.filter(s => permitidas.has(s.routeId)), routes }
}

/** Liquidaciones de UNA ruta ya autorizada (historial de la pantalla de cierre). */
export async function listSettlementsOfRoute(
  routeId: string,
  database: SettlementDatabase = db as unknown as SettlementDatabase,
): Promise<WeeklySettlement[]> {
  if (!routeId) return []
  return database.weeklySettlements.where('routeId').equals(routeId).toArray()
}
