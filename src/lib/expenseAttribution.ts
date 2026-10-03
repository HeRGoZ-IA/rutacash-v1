// ============================================================
// ATRIBUCIÓN ECONÓMICA DE GASTOS — REGISTRAR ≠ RESPONDER (PURO)
// ------------------------------------------------------------
// Ajustes del socio 2026-10-02, punto 9. El socio vio en Gastos de Fabio el
// Transporte y la Papelería que había registrado el Admin. La pantalla listaba
// TODOS los gastos de la ruta, y la caja personal decidía con `collectorId ??
// userId`: un gasto "de ruta" quedaba cargado a quien lo REGISTRÓ si ese usuario
// tenía caja (Supervisor). El creador no decide nada: decide la ATRIBUCIÓN.
//
// FUENTE ÚNICA: toda pregunta "¿a qué caja se carga este gasto?" o "¿este gasto es
// de esta persona?" pasa por aquí (motor de caja, cuadre, pantallas, reportes).
//
// HISTÓRICOS (sin `scope`): no se reinterpretan. Se resuelven con la MISMA regla
// que regía cuando se registraron (`collectorId ?? userId`), de modo que ni los
// cuadres cerrados ni las posiciones abiertas cambian:
//   · con `collectorId`          → del trabajador (v10 lo rellenó para cobradores).
//   · sin `collectorId`          → de la ruta; su caja personal es la de `userId`
//                                  solo si ese usuario la tenía (un Admin no tiene:
//                                  no se carga a nadie). Así queda el Transporte
//                                  del socio: ruta, nunca de Fabio.
// ============================================================
import type { Expense, ExpenseScope } from '@/models/types'

export interface ExpenseAttribution {
  scope: ExpenseScope
  /** Caja personal a la que se carga (`undefined` = ninguna). */
  cashHolderId?: string
  /** Gasto anterior a la clasificación explícita. */
  legacy: boolean
}

type Atribuible = Pick<Expense, 'scope' | 'routeId' | 'collectorId' | 'userId'>

/**
 * @param hasCashbox opcional, solo para PRESENTAR históricos: si quien registró un
 *   gasto histórico sin `collectorId` tenía caja personal, ese gasto se le cargaba
 *   (regla legacy) y se etiqueta como de trabajador. No cambia `cashHolderId`.
 */
export function expenseAttribution(e: Atribuible, hasCashbox?: (userId: string) => boolean): ExpenseAttribution {
  if (e.scope === 'trabajador') return { scope: 'trabajador', cashHolderId: e.collectorId, legacy: false }
  if (e.scope === 'ruta' || e.scope === 'empresa') return { scope: e.scope, legacy: false }
  // Histórico: misma regla que tenía el motor de caja antes del punto 9.
  if (e.collectorId) return { scope: 'trabajador', cashHolderId: e.collectorId, legacy: true }
  const cashHolderId = e.userId || undefined
  const deTrabajador = !!e.routeId && !!cashHolderId && !!hasCashbox?.(cashHolderId)
  return { scope: deTrabajador ? 'trabajador' : e.routeId ? 'ruta' : 'empresa', cashHolderId, legacy: true }
}

/** Caja personal que este gasto reduce (`undefined` = ninguna). */
export function expenseCashHolderId(e: Atribuible): string | undefined {
  return expenseAttribution(e).cashHolderId
}

/** ¿El gasto se carga al efectivo de `userId`? (lo que esa persona debe ver). */
export function isExpenseOf(e: Atribuible, userId: string): boolean {
  return !!userId && expenseCashHolderId(e) === userId
}

export const EXPENSE_SCOPE_LABEL: Record<ExpenseScope, string> = {
  empresa: 'Empresa',
  ruta: 'Ruta',
  trabajador: 'Trabajador',
}

/**
 * Forma válida de un gasto NUEVO. Hace imposibles los estados ambiguos
 * (trabajador sin persona, empresa con ruta o con persona, ruta con persona).
 * Devuelve el motivo del rechazo o `null`.
 */
export function expenseShapeError(e: Pick<Expense, 'scope' | 'routeId' | 'collectorId'>): string | null {
  switch (e.scope) {
    case 'empresa':
      if (e.routeId) return 'Un gasto de empresa no pertenece a ninguna ruta.'
      if (e.collectorId) return 'Un gasto de empresa no se carga a ningún trabajador.'
      return null
    case 'ruta':
      if (!e.routeId) return 'Indica la ruta del gasto.'
      if (e.collectorId) return 'Un gasto de ruta no se carga a ningún trabajador: clasifícalo como gasto de trabajador.'
      return null
    case 'trabajador':
      if (!e.routeId) return 'Indica la ruta del trabajador.'
      if (!e.collectorId) return 'Indica el trabajador que pagó el gasto.'
      return null
    default:
      return 'Indica a quién corresponde el gasto (empresa, ruta o trabajador).'
  }
}
