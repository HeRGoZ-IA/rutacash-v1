// ============================================================
// PERIODOS DE LIQUIDACIÓN — LÓGICA PURA
// ------------------------------------------------------------
// Módulo SIN acceso a base de datos: recibe filas ya recortadas por alcance y
// decide sobre ellas. Aquí vive todo lo que significa "cerrar", "reabrir",
// "versionar" y "leer el histórico" de una liquidación semanal.
//
// REGLA CENTRAL (por qué existe este módulo):
// Hasta ahora la liquidación era solo un CÁLCULO en pantalla. Nada se archivaba,
// así que ningún periodo estaba realmente cerrado y la protección de correcciones
// sobre periodos cerrados —que ya existía en `paymentCorrectionService`— nunca
// llegaba a activarse. Un cierro persistido es lo que la enciende.
//
// LO QUE ESTE MÓDULO NO HACE:
//  · No concede acceso. El alcance sigue naciendo de `User.authorizedRouteIds`.
//  · No deriva Oficina para operar: `Route.officeId` sigue siendo la única fuente
//    operativa. El snapshot de Oficina de un cierre es METADATA histórica del
//    documento, jamás un criterio de filtrado ni de permisos.
// ============================================================
import { NO_OFFICE_LABEL } from './officeGrouping'
import type { Office, Route, WeeklySettlement } from '@/models/types'

/** Estado normalizado. `undefined` = 'cerrada' (liquidaciones anteriores a v12). */
export type SettlementStatus = 'abierta' | 'cerrada' | 'reabierta'

export function settlementStatus(s: Pick<WeeklySettlement, 'status'>): SettlementStatus {
  return s.status ?? 'cerrada'
}

/**
 * ¿Este documento PROTEGE su periodo? Solo un cierre vigente protege.
 * Un cierre 'reabierta' se conserva como histórico pero deja de proteger: ese es
 * exactamente el propósito de reabrir.
 */
export function isProtectingClosure(s: Pick<WeeklySettlement, 'status'>): boolean {
  return settlementStatus(s) === 'cerrada'
}

/** ¿La fecha contable `fecha` (YYYY-MM-DD) cae dentro del rango del documento? */
export function coversDate(
  s: Pick<WeeklySettlement, 'semanaInicio' | 'semanaFin'>,
  fecha: string,
): boolean {
  return fecha >= s.semanaInicio && fecha <= s.semanaFin
}

/**
 * Cierre VIGENTE que protege esa fecha en esa ruta, o `null`.
 * Es la misma condición que usa `isPaymentInClosedPeriod`, expresada aquí en puro
 * para poder probarla sin IndexedDB y para que la UI pueda anticiparla.
 */
export function protectingClosureFor(
  settlements: WeeklySettlement[],
  routeId: string,
  fecha: string,
): WeeklySettlement | null {
  return settlements.find(s => s.routeId === routeId && isProtectingClosure(s) && coversDate(s, fecha)) ?? null
}

/** ¿Dos rangos de fechas se solapan (aunque sea un día)? */
export function periodsOverlap(
  a: Pick<WeeklySettlement, 'semanaInicio' | 'semanaFin'>,
  b: Pick<WeeklySettlement, 'semanaInicio' | 'semanaFin'>,
): boolean {
  return a.semanaInicio <= b.semanaFin && b.semanaInicio <= a.semanaFin
}

// ------------------------------------------------------------
// Validación del rango a cerrar
// ------------------------------------------------------------
/**
 * Rango válido para cerrar. Devuelve el mensaje de error o `null` si es válido.
 * No se valida "que sea lunes a sábado": la empresa puede liquidar rangos
 * distintos y el motor financiero no asume días de la semana.
 */
export function validateClosePeriod(semanaInicio: string, semanaFin: string): string | null {
  if (!semanaInicio || !semanaFin) return 'Indica la fecha de inicio y de fin de la semana a cerrar.'
  if (semanaFin < semanaInicio) return 'La fecha de fin no puede ser anterior a la de inicio.'
  return null
}

/**
 * ¿Se puede cerrar este rango en esta ruta? Devuelve el mensaje de bloqueo o `null`.
 *
 * Se bloquea el SOLAPAMIENTO, no solo el rango idéntico: cerrar 1–6 y luego 3–9
 * dejaría dos cierres vigentes protegiendo los mismos días con cifras distintas.
 * Un cierre REABIERTO no bloquea: reabrir existe justamente para volver a cerrar.
 */
export function closureBlockedReason(
  settlements: WeeklySettlement[],
  routeId: string,
  semanaInicio: string,
  semanaFin: string,
): string | null {
  const rango = validateClosePeriod(semanaInicio, semanaFin)
  if (rango) return rango

  const choque = settlements.find(
    s => s.routeId === routeId && isProtectingClosure(s) && periodsOverlap(s, { semanaInicio, semanaFin }),
  )
  if (!choque) return null

  if (choque.semanaInicio === semanaInicio && choque.semanaFin === semanaFin) {
    return 'Esta semana ya está cerrada. Para modificarla debes reabrirla primero.'
  }
  return `El rango se solapa con una semana ya cerrada (${choque.semanaInicio} a ${choque.semanaFin}). Reábrela o elige otro rango.`
}

/**
 * Versión que le corresponde a un cierre nuevo del MISMO rango en la MISMA ruta.
 * Cerrar → reabrir → corregir → volver a cerrar produce v1, v2, v3… y cada
 * documento anterior se conserva intacto.
 */
export function nextClosureVersion(
  settlements: WeeklySettlement[],
  routeId: string,
  semanaInicio: string,
  semanaFin: string,
): number {
  const previas = settlements.filter(
    s => s.routeId === routeId && s.semanaInicio === semanaInicio && s.semanaFin === semanaFin,
  )
  if (previas.length === 0) return 1
  return Math.max(...previas.map(s => s.version ?? 1)) + 1
}

/** Documentos del mismo periodo y ruta que quedan sustituidos por el cierre nuevo. */
export function supersededClosures(
  settlements: WeeklySettlement[],
  routeId: string,
  semanaInicio: string,
  semanaFin: string,
): WeeklySettlement[] {
  return settlements.filter(
    s =>
      s.routeId === routeId &&
      s.semanaInicio === semanaInicio &&
      s.semanaFin === semanaFin &&
      !s.supersededBy,
  )
}

// ------------------------------------------------------------
// Snapshot histórico de Oficina
// ------------------------------------------------------------
export interface OfficeSnapshot {
  officeIdAtClose?: string
  officeNameAtClose: string
  officeCodeAtClose?: string
}

/**
 * Oficina de la ruta EN EL MOMENTO DEL CIERRE, congelada en el documento.
 *
 * Por qué: si mañana la ruta se mueve a otra Oficina, la liquidación cerrada debe
 * seguir diciendo dónde se cerró. Recalcularla desde `Route.officeId` reescribiría
 * el pasado cada vez que alguien reorganiza el catálogo.
 *
 * Esto NO reintroduce `officeId` operativo en los movimientos: no hay Oficina en
 * pagos, ventas, cuotas ni gastos. Es un campo de METADATA dentro del documento de
 * cierre, y ninguna consulta de alcance lo lee.
 *
 * Una ruta Sin Oficina guarda `officeIdAtClose: undefined` y el nombre
 * "Sin Oficina": no se inventa ninguna Oficina real.
 */
export function officeSnapshotOf(
  route: Pick<Route, 'officeId'> | null | undefined,
  offices: Office[],
): OfficeSnapshot {
  const officeId = route?.officeId
  if (!officeId) return { officeNameAtClose: NO_OFFICE_LABEL }
  const office = offices.find(o => o.id === officeId)
  // Oficina referenciada pero ausente del catálogo: se guarda el id para no perder
  // el rastro, con un nombre honesto en lugar de fingir que era "Sin Oficina".
  if (!office) return { officeIdAtClose: officeId, officeNameAtClose: 'Oficina eliminada' }
  return { officeIdAtClose: office.id, officeNameAtClose: office.nombre, officeCodeAtClose: office.codigo }
}

/**
 * Oficina que MUESTRA un documento de cierre. Prioriza SIEMPRE el snapshot: es el
 * dato histórico. Solo si el documento no lo tiene (cierres heredados de antes de
 * v12) se cae a un guion, nunca a la Oficina actual de la ruta.
 */
export function closureOfficeLabel(s: WeeklySettlement): string {
  return s.officeNameAtClose ?? '—'
}

// ------------------------------------------------------------
// Historial
// ------------------------------------------------------------
export interface SettlementHistoryRow {
  settlement: WeeklySettlement
  routeName: string
  routeCode: string
  officeLabel: string
  status: SettlementStatus
  version: number
  /** Ha sido sustituido por un cierre posterior del mismo periodo. */
  superseded: boolean
}

/**
 * Historial ordenado: semana más reciente primero y, dentro de la misma semana,
 * la versión más alta primero. Recibe SOLO liquidaciones ya recortadas por alcance.
 */
export function settlementHistory(
  settlements: WeeklySettlement[],
  routes: Route[],
  _offices: Office[] = [],
): SettlementHistoryRow[] {
  const porRuta = new Map(routes.map(r => [r.id, r]))
  return settlements
    .map(s => {
      const route = porRuta.get(s.routeId)
      return {
        settlement: s,
        routeName: route?.nombre ?? '—',
        routeCode: route?.codigo ?? '',
        // Oficina HISTÓRICA del documento, no la actual de la ruta.
        officeLabel: closureOfficeLabel(s),
        status: settlementStatus(s),
        version: s.version ?? 1,
        superseded: Boolean(s.supersededBy),
      }
    })
    .sort((a, b) => {
      if (a.settlement.semanaInicio !== b.settlement.semanaInicio) {
        return b.settlement.semanaInicio < a.settlement.semanaInicio ? -1 : 1
      }
      if (a.version !== b.version) return b.version - a.version
      return (b.settlement.createdAt ?? '') < (a.settlement.createdAt ?? '') ? -1 : 1
    })
}

/** Cierres VIGENTES (no sustituidos y no reabiertos) de un conjunto de rutas. */
export function activeClosures(settlements: WeeklySettlement[]): WeeklySettlement[] {
  return settlements.filter(s => isProtectingClosure(s) && !s.supersededBy)
}

// ------------------------------------------------------------
// Distintivos de estado (UI)
// ------------------------------------------------------------
export interface PeriodBadge {
  label: string
  tone: 'closed' | 'reopened' | 'open'
}

export function periodBadge(s: Pick<WeeklySettlement, 'status'>): PeriodBadge {
  const estado = settlementStatus(s)
  if (estado === 'reabierta') return { label: 'Período reabierto', tone: 'reopened' }
  if (estado === 'abierta') return { label: 'Período abierto', tone: 'open' }
  return { label: 'Período cerrado', tone: 'closed' }
}

// ------------------------------------------------------------
// Semanas pendientes de cierre
// ------------------------------------------------------------
export interface PendingSettlementRoute {
  routeId: string
  routeName: string
  officeLabel: string
  /** Última semana cerrada de la ruta, o null si nunca se ha cerrado. */
  lastClosedUntil: string | null
}

/**
 * Rutas SIN cierre vigente para la semana indicada. Alimenta el indicador de
 * "liquidaciones pendientes" del panel de empresa.
 *
 * `officeLabelOf` se recibe como función para que este módulo no tenga que
 * conocer el catálogo de Oficinas ni derivar nada por su cuenta.
 */
export function pendingSettlements(
  routes: Route[],
  settlements: WeeklySettlement[],
  semanaInicio: string,
  semanaFin: string,
  officeLabelOf: (routeId: string) => string,
): PendingSettlementRoute[] {
  return routes
    .filter(
      r =>
        !settlements.some(
          s =>
            s.routeId === r.id &&
            isProtectingClosure(s) &&
            s.semanaInicio === semanaInicio &&
            s.semanaFin === semanaFin,
        ),
    )
    .map(r => {
      const cerradas = settlements
        .filter(s => s.routeId === r.id && isProtectingClosure(s))
        .map(s => s.semanaFin)
        .sort()
      return {
        routeId: r.id,
        routeName: r.nombre,
        officeLabel: officeLabelOf(r.id),
        lastClosedUntil: cerradas.length > 0 ? cerradas[cerradas.length - 1] : null,
      }
    })
}

// ------------------------------------------------------------
// CSV desde el documento persistido
// ------------------------------------------------------------
/**
 * Fila de CSV de una liquidación CERRADA, construida ÍNTEGRAMENTE desde el
 * documento archivado: importes, estado, versión y Oficina histórica.
 *
 * No se recalcula nada. Si se recalculase, un pago corregido después del cierre
 * cambiaría el CSV de una semana ya cerrada y el documento dejaría de ser prueba
 * de nada. La Oficina sale del snapshot, no de `Route.officeId` actual.
 */
export function closedSettlementCsvRow(s: WeeklySettlement, routeName: string, routeCode: string) {
  return {
    Ruta: routeName,
    'Código ruta': routeCode,
    'Oficina (al cierre)': closureOfficeLabel(s),
    'Código oficina (al cierre)': s.officeCodeAtClose ?? '',
    'Semana inicio': s.semanaInicio,
    'Semana fin': s.semanaFin,
    Estado: periodBadge(s).label,
    Versión: s.version ?? 1,
    'Cerrada el': s.closedAt ?? '',
    'Reabierta el': s.reopenedAt ?? '',
    'Motivo de reapertura': s.reopenReason ?? '',
    'Saldo anterior': s.saldoAnterior,
    'Ingreso capital': s.ingresoCapital,
    Cobros: s.cobros,
    'Préstamos entregados': s.prestamosEntregados,
    Gastos: s.gastos,
    'Transferencias entrada': s.transferenciasEntradas,
    'Transferencias salida': s.transferenciasSalidas,
    Retiros: s.retiros,
    'Saldo final': s.saldoFinal,
  }
}
