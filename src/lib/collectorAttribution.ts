// ============================================================
// ATRIBUCIÓN DEL EFECTIVO — REGISTRAR ≠ RESPONDER POR EL DINERO (PURO)
// ------------------------------------------------------------
// Antes, `Payment.collectorId` guardaba el id del usuario que DIGITABA el abono.
// Eso atribuía el dinero a quien lo escribió, no a quien lo recibió: si un
// Supervisor registraba un cobro de Fabio, el efectivo desaparecía de la caja de
// Fabio y aparecía en la del Supervisor, descuadrando el arqueo físico.
//
// Se separan dos conceptos:
//   · collectorId     → RESPONSABLE DEL EFECTIVO (recibió/maneja el dinero).
//   · createdByUserId → usuario que REGISTRÓ la operación.
//
// AMPLIACIÓN (Fase 1, decisión D-1): el RESPONSABLE DEL EFECTIVO ya no es
// necesariamente un `cobrador`. Un SUPERVISOR que opera una ruta recibe dinero de
// verdad y debe poder quedarse con él en su caja. La auditoría demostró que antes
// era IMPOSIBLE: el Supervisor no podía indicarse a sí mismo ni siquiera de forma
// explícita (`COLLECTOR_INVALID`), así que su efectivo se cargaba al cobrador
// habitual. Ver docs/AUDITORIA_CUADRE_CAJA_SUPERVISOR_2026-09.md §29 CASO B.
//
// REGLA DEFINITIVA (2026-09-24, aprobada por negocio — sustituye la regla
// `must-choose` de la Fase 1): QUIEN TIENE CAJA PERSONAL Y REGISTRA UN COBRO
// RESPONDE POR ÉL. El Cobrador que cobra y el SUPERVISOR que cobra quedan como
// responsables de su propio registro, siempre y sin selector — aunque la ruta
// tenga uno, varios o ningún cobrador activo. Solo los actores administrativos
// (sin caja personal) pueden necesitar indicar a quién se carga el dinero, y a
// ellos NUNCA se les adivina ni se les autoasigna.
// ============================================================
import type { User, UserRole } from '@/models/types'

/**
 * ¿El rol puede tener CAJA PERSONAL de efectivo? Solo quien sale a la calle.
 *
 * FUENTE ÚNICA. Toda decisión del tipo "¿este usuario puede responder por el
 * efectivo?" debe pasar por aquí. No escribir `rol === 'cobrador'` suelto en los
 * flujos de dinero: esa dispersión es lo que dejó al Supervisor fuera de su propia
 * caja en cobros, desembolsos y gastos, cada uno con una regla distinta.
 *
 * Admin y Super Admin NO tienen caja personal aunque puedan registrar operaciones:
 * administran dinero, no lo cargan encima. Secretario y Socio tampoco operan caja.
 */
export function hasPersonalCashbox(rol: UserRole): boolean {
  return rol === 'cobrador' || rol === 'supervisor'
}

/** Datos mínimos para decidir la atribución (sin DB). */
export type CollectorCandidate = Pick<User, 'id' | 'rol' | 'status'>

/**
 * ¿Este usuario de la ruta puede quedar como responsable del efectivo?
 * Debe estar ACTIVO y su rol debe tener caja personal.
 */
export function isEligibleCashHolder(c: CollectorCandidate): boolean {
  return c.status === 'activo' && hasPersonalCashbox(c.rol)
}

export type CollectorAttributionSource =
  /** Lo eligió explícitamente quien registra. */
  | 'explicit'
  /** Quien registró tiene caja personal (Cobrador o Supervisor) y responde por su cobro. */
  | 'actor'
  /** La ruta tiene un único cobrador operativo: se preselecciona sin ambigüedad. */
  | 'single-route-collector'
  /** La ruta no tiene ningún responsable posible: se conserva el comportamiento anterior. */
  | 'legacy-actor'

export type CollectorAttributionError =
  /** Varios cobradores en la ruta: hay que elegir, no se adivina. */
  | 'ambiguous'
  /**
   * El actor TIENE caja personal (Cobrador/Supervisor) e intentó cargar el cobro a
   * OTRA persona. Por regla de negocio quien cobra con caja personal responde por
   * su propio registro: no puede desviarlo a otra caja.
   */
  | 'actor-owns-cash'
  /** El responsable indicado no es un usuario válido con caja personal en esa ruta. */
  | 'invalid'

export type CollectorAttribution =
  | { ok: true; collectorId: string; source: CollectorAttributionSource }
  | { ok: false; code: CollectorAttributionError; message: string }

export const COLLECTOR_ATTRIBUTION_MESSAGE: Record<CollectorAttributionError, string> = {
  ambiguous: 'Esta ruta tiene varios cobradores: indica quién recibió el dinero.',
  'actor-owns-cash': 'Los cobros que registras quedan bajo tu responsabilidad: no pueden cargarse a otra persona.',
  invalid: 'El responsable indicado no puede responder por el efectivo de esta ruta.',
}

/**
 * Decide QUIÉN responde por el dinero de un recaudo.
 *
 * @param actor           usuario que está registrando la operación.
 * @param requested       responsable elegido explícitamente (si la UI lo pidió).
 * @param routeCollectors usuarios ASIGNADOS a la ruta de la venta. El nombre se
 *                        conserva por compatibilidad, pero ya no son solo
 *                        cobradores: incluye a cualquier usuario con caja personal
 *                        (ver `hasPersonalCashbox`).
 *
 * Orden de decisión:
 *  1. El actor TIENE CAJA PERSONAL (Cobrador o Supervisor) → responde él mismo,
 *     SIEMPRE. No se consulta a los cobradores de la ruta ni cuántos hay. Si la
 *     UI envía otro responsable se rechaza ('actor-owns-cash'): el dinero que
 *     registra quien sale a la calle no se desvía a otra caja.
 *  2. Actor administrativo con `requested` → debe ser responsable VÁLIDO: usuario
 *     activo con caja personal asignado a la ruta. Cualquier otro (el propio
 *     Admin, Secretario, usuario de otra ruta, inactivo) se rechaza.
 *  3. La ruta tiene EXACTAMENTE UN cobrador activo → se preselecciona.
 *  4. La ruta tiene VARIOS → 'ambiguous': se exige elección explícita. Nunca se
 *     atribuye al Admin solo por ser quien digitó.
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

  // 1) Quien tiene caja personal responde por lo que registra. Sin selector, sin
  //    depender de cuántos cobradores tenga la ruta ni de si siguen activos.
  if (hasPersonalCashbox(params.actor.rol)) {
    if (params.requested && params.requested !== params.actor.id) return fail('actor-owns-cash')
    return { ok: true, collectorId: params.actor.id, source: 'actor' }
  }

  /** Cobradores activos de la ruta: base de las reglas automáticas. */
  const cobradores = params.routeCollectors.filter(c => c.rol === 'cobrador' && c.status === 'activo')
  /** Responsables válidos: cobradores y supervisores ACTIVOS de la ruta. */
  const elegibles = params.routeCollectors.filter(isEligibleCashHolder)

  // 2) Elección explícita de un actor administrativo: debe ser válida.
  if (params.requested) {
    return elegibles.some(c => c.id === params.requested)
      ? { ok: true, collectorId: params.requested, source: 'explicit' }
      : fail('invalid')
  }

  // 3) Un único cobrador en la ruta: no hay ambigüedad posible.
  if (cobradores.length === 1) {
    return { ok: true, collectorId: cobradores[0].id, source: 'single-route-collector' }
  }

  // 4) Varios cobradores: NO se adivina.
  if (cobradores.length > 1) return fail('ambiguous')

  // 5) Ruta sin cobradores: se conserva el comportamiento anterior.
  return { ok: true, collectorId: params.actor.id, source: 'legacy-actor' }
}
