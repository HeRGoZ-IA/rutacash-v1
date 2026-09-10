// ============================================================
// ATRIBUCIÓN DEL RECAUDO — REGISTRAR ≠ RESPONDER POR EL DINERO (PURO)
// ------------------------------------------------------------
// Antes, `Payment.collectorId` guardaba el id del usuario que DIGITABA el abono.
// Eso atribuía el dinero a quien lo escribió, no a quien lo recibió: si un
// Supervisor registraba un cobro de Fabio, el efectivo desaparecía de la caja de
// Fabio y aparecía en la del Supervisor, descuadrando el arqueo físico.
//
// Ahora se separan dos conceptos:
//   · collectorId     → COBRADOR RESPONSABLE (recibió el dinero).
//   · createdByUserId → usuario que REGISTRÓ la operación.
//
// Esta regla decide el `collectorId` y es deliberadamente CONSERVADORA: cuando el
// dato no se puede determinar sin adivinar, NO adivina — exige que se elija.
// ============================================================
import type { User, UserRole } from '@/models/types'

/** Datos mínimos para decidir la atribución (sin DB). */
export type CollectorCandidate = Pick<User, 'id' | 'rol' | 'status'>

export type CollectorAttributionSource =
  /** Lo eligió explícitamente quien registra. */
  | 'explicit'
  /** El propio cobrador registró su cobro. */
  | 'actor'
  /** La ruta tiene un único cobrador operativo: se preselecciona sin ambigüedad. */
  | 'single-route-collector'
  /** La ruta no tiene ningún cobrador: se conserva el comportamiento anterior. */
  | 'legacy-actor'

export type CollectorAttributionError =
  /** Varios cobradores en la ruta: hay que elegir, no se adivina. */
  | 'ambiguous'
  /** El cobrador indicado no es un cobrador activo de esa ruta. */
  | 'invalid'

export type CollectorAttribution =
  | { ok: true; collectorId: string; source: CollectorAttributionSource }
  | { ok: false; code: CollectorAttributionError; message: string }

export const COLLECTOR_ATTRIBUTION_MESSAGE: Record<CollectorAttributionError, string> = {
  ambiguous: 'Esta ruta tiene varios cobradores: indica quién recibió el dinero.',
  invalid: 'El cobrador indicado no es un cobrador activo de esta ruta.',
}

/**
 * Decide QUIÉN responde por el dinero de un recaudo.
 *
 * @param actor           usuario que está registrando la operación.
 * @param requested       cobrador elegido explícitamente (si la UI lo pidió).
 * @param routeCollectors usuarios con rol 'cobrador' asignados a la ruta de la venta.
 *
 * Orden de decisión:
 *  1. `requested` → debe ser un cobrador ACTIVO de la ruta; si no, se rechaza.
 *  2. El actor es COBRADOR → responde él mismo (caso normal de la app del cobrador).
 *  3. La ruta tiene EXACTAMENTE UN cobrador activo → se preselecciona.
 *  4. La ruta tiene VARIOS → 'ambiguous': se exige elección explícita. Nunca se
 *     atribuye al Admin/Supervisor solo por ser quien digitó.
 *  5. La ruta no tiene NINGÚN cobrador → se atribuye al actor (comportamiento
 *     legacy). Es el único caso sin alternativa razonable y queda marcado como tal.
 */
export function resolveResponsibleCollector(params: {
  actor: Pick<User, 'id' | 'rol'>
  requested?: string
  routeCollectors: CollectorCandidate[]
}): CollectorAttribution {
  const fail = (code: CollectorAttributionError): CollectorAttribution =>
    ({ ok: false, code, message: COLLECTOR_ATTRIBUTION_MESSAGE[code] })

  const activos = params.routeCollectors.filter(c => c.rol === 'cobrador' && c.status === 'activo')

  // 1) Elección explícita: debe ser válida.
  if (params.requested) {
    return activos.some(c => c.id === params.requested)
      ? { ok: true, collectorId: params.requested, source: 'explicit' }
      : fail('invalid')
  }

  // 2) El cobrador registra su propio recaudo.
  if (params.actor.rol === 'cobrador') {
    return { ok: true, collectorId: params.actor.id, source: 'actor' }
  }

  // 3) Un único cobrador en la ruta: no hay ambigüedad posible.
  if (activos.length === 1) {
    return { ok: true, collectorId: activos[0].id, source: 'single-route-collector' }
  }

  // 4) Varios cobradores: NO se adivina.
  if (activos.length > 1) return fail('ambiguous')

  // 5) Ruta sin cobradores: se conserva el comportamiento anterior.
  return { ok: true, collectorId: params.actor.id, source: 'legacy-actor' }
}

/**
 * ¿El rol puede tener CAJA PERSONAL de recaudo? Solo quien sale a cobrar.
 * El Supervisor también recauda en la calle (comparte la app operativa).
 */
export function hasPersonalCashbox(rol: UserRole): boolean {
  return rol === 'cobrador' || rol === 'supervisor'
}
