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
// Lo que NO cambia: NUNCA se adivina. El Supervisor no se autoasigna el dinero por
// el mero hecho de digitar, igual que el Admin nunca lo hizo. Cuando hay más de un
// destino posible, se EXIGE una decisión explícita.
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
  /** El propio cobrador registró su cobro. */
  | 'actor'
  /** La ruta tiene un único cobrador operativo: se preselecciona sin ambigüedad. */
  | 'single-route-collector'
  /** La ruta no tiene ningún responsable posible: se conserva el comportamiento anterior. */
  | 'legacy-actor'

export type CollectorAttributionError =
  /** Varios cobradores en la ruta: hay que elegir, no se adivina. */
  | 'ambiguous'
  /**
   * El actor TIENE caja personal pero NO es el único destino posible (Supervisor
   * operando una ruta que ya tiene cobradores). No se adivina si el dinero lo
   * recibió él o el cobrador: se exige decidirlo.
   */
  | 'must-choose'
  /** El responsable indicado no es un usuario válido con caja personal en esa ruta. */
  | 'invalid'

export type CollectorAttribution =
  | { ok: true; collectorId: string; source: CollectorAttributionSource }
  | { ok: false; code: CollectorAttributionError; message: string }

export const COLLECTOR_ATTRIBUTION_MESSAGE: Record<CollectorAttributionError, string> = {
  ambiguous: 'Esta ruta tiene varios cobradores: indica quién recibió el dinero.',
  'must-choose': 'Indica quién recibió el dinero: tú o el cobrador de la ruta.',
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
 *  1. `requested` → debe ser un responsable VÁLIDO: usuario activo con caja
 *     personal asignado a la ruta, o el propio actor si tiene caja personal.
 *     Cualquier otro (Admin, Secretario, usuario de otra ruta, inactivo) se rechaza.
 *  2. El actor es COBRADOR → responde él mismo. Es su recaudo y su caja: no se le
 *     añade fricción (decisión D-1).
 *  3. El actor tiene caja personal pero NO es cobrador (Supervisor) y la ruta TIENE
 *     cobradores activos → 'must-choose'. Dos destinos plausibles, ninguno
 *     adivinable: el Supervisor pudo cobrar él o estar digitando lo de otro.
 *  4. La ruta tiene EXACTAMENTE UN cobrador activo → se preselecciona (caso del
 *     Administrador, que no tiene caja personal y por tanto no compite).
 *  5. La ruta tiene VARIOS → 'ambiguous': se exige elección explícita. Nunca se
 *     atribuye al Admin solo por ser quien digitó.
 *  6. La ruta no tiene NINGÚN cobrador → se atribuye al actor (comportamiento
 *     legacy). Es el único caso sin alternativa razonable y queda marcado como tal.
 */
export function resolveResponsibleCollector(params: {
  actor: Pick<User, 'id' | 'rol'>
  requested?: string
  routeCollectors: CollectorCandidate[]
}): CollectorAttribution {
  const fail = (code: CollectorAttributionError): CollectorAttribution =>
    ({ ok: false, code, message: COLLECTOR_ATTRIBUTION_MESSAGE[code] })

  /** Cobradores activos de la ruta: base de las reglas automáticas. */
  const cobradores = params.routeCollectors.filter(c => c.rol === 'cobrador' && c.status === 'activo')
  /** Responsables válidos: cobradores y supervisores ACTIVOS de la ruta. */
  const elegibles = params.routeCollectors.filter(isEligibleCashHolder)
  const actorPuedeResponder = hasPersonalCashbox(params.actor.rol)

  // 1) Elección explícita: debe ser válida.
  //    El ACTOR cuenta como destino válido si tiene caja personal, aunque no
  //    figure en la lista de la ruta (p. ej. un Supervisor que la está operando).
  if (params.requested) {
    const esElegibleDeLaRuta = elegibles.some(c => c.id === params.requested)
    const esElActorConCaja = params.requested === params.actor.id && actorPuedeResponder
    return esElegibleDeLaRuta || esElActorConCaja
      ? { ok: true, collectorId: params.requested, source: 'explicit' }
      : fail('invalid')
  }

  // 2) El cobrador registra su propio recaudo: sin fricción.
  if (params.actor.rol === 'cobrador') {
    return { ok: true, collectorId: params.actor.id, source: 'actor' }
  }

  // 3) Supervisor operando una ruta CON cobradores: hay dos destinos plausibles.
  //    No se adivina ninguno — ni él por ser actor, ni el cobrador por ser el
  //    habitual. Se exige decidir. Sin cobradores en la ruta no hay nada que
  //    elegir y la decisión cae sola en el paso 6.
  if (actorPuedeResponder && cobradores.length > 0) return fail('must-choose')

  // 4) Un único cobrador en la ruta: no hay ambigüedad posible.
  if (cobradores.length === 1) {
    return { ok: true, collectorId: cobradores[0].id, source: 'single-route-collector' }
  }

  // 5) Varios cobradores: NO se adivina.
  if (cobradores.length > 1) return fail('ambiguous')

  // 6) Ruta sin cobradores: se conserva el comportamiento anterior.
  return { ok: true, collectorId: params.actor.id, source: 'legacy-actor' }
}
