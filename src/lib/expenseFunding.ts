// ============================================================
// GASTOS ADMINISTRATIVOS — ¿QUÉ BOLSA LOS PAGA? (PURO, Ronda 2/6)
// ------------------------------------------------------------
// Decisión aprobada: cada Administrador usa UNA bolsa para distribuir capital a
// sus rutas y pagar sus gastos administrativos. Un gasto de 'empresa' (sin ruta ni
// trabajador) lo paga:
//   · la bolsa de un Administrador  (`funding: 'admin'`, `fundingAdminId`), o
//   · la bolsa de la empresa         (`funding: 'empresa'`, gastos del SuperAdmin, D10).
//
// HISTÓRICOS (D9): un gasto de empresa SIN `funding` es anterior al modelo de
// imputación. No pertenece a ninguna bolsa, no entra en ninguna fórmula y nunca se
// le asigna una por defecto. El corte es el CAMPO, no la fecha.
//
// CORRECCIONES (D12): anulación (`reversesId`, importe negado) y reintegro
// (`refundsExpenseId`, importe negado) copian la bolsa del original. Las sumas son
// ALGEBRAICAS: original + corrección = neto, sin filtrar estados (mismo criterio
// que `movementReversal`).
//
// FUENTE ÚNICA para fórmulas de capital, servicio, pantallas y reportes. Sin Dexie.
// ============================================================
import type { Expense, User } from '@/models/types'

type Imputable = Pick<Expense, 'scope' | 'routeId' | 'funding' | 'fundingAdminId'>

export type ExpenseFundingOf =
  | { kind: 'admin'; adminId: string }
  | { kind: 'empresa' }
  /** Gasto de empresa anterior al modelo: sin bolsa (D9). */
  | { kind: 'historico' }
  /** Gasto de ruta o de trabajador: lo paga una caja de ruta, no una bolsa. */
  | { kind: 'ruta' }

/** ¿De qué bolsa sale este gasto? */
export function expenseFundingOf(e: Imputable): ExpenseFundingOf {
  if (e.routeId) return { kind: 'ruta' }
  if (e.funding === 'admin' && e.fundingAdminId) return { kind: 'admin', adminId: e.fundingAdminId }
  if (e.funding === 'empresa') return { kind: 'empresa' }
  return { kind: 'historico' }
}

/** ¿El gasto está imputado a una bolsa (Admin o empresa)? */
export const isPoolExpense = (e: Imputable): boolean => {
  const k = expenseFundingOf(e).kind
  return k === 'admin' || k === 'empresa'
}

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0)

/** Gastos NETOS de la bolsa de `adminId` (originales + anulaciones + reintegros). */
export function adminPoolExpenses(adminId: string, expenses: readonly (Imputable & Pick<Expense, 'valor'>)[]): number {
  return sum(expenses.filter(e => { const f = expenseFundingOf(e); return f.kind === 'admin' && f.adminId === adminId }), e => e.valor)
}

/** Gastos NETOS de la bolsa de la empresa. */
export function companyPoolExpenses(expenses: readonly (Imputable & Pick<Expense, 'valor'>)[]): number {
  return sum(expenses.filter(e => expenseFundingOf(e).kind === 'empresa'), e => e.valor)
}

// ------------------------------------------------------------
// Estado de un gasto (presentación y reglas de corrección)
// ------------------------------------------------------------
export type PoolExpenseState = 'vigente' | 'anulado' | 'anulacion' | 'reintegro' | 'historico' | 'ruta'

export function poolExpenseStateOf(e: Expense): PoolExpenseState {
  const f = expenseFundingOf(e).kind
  if (f === 'ruta') return 'ruta'
  if (f === 'historico') return 'historico'
  if (e.reversesId) return 'anulacion'
  if (e.refundsExpenseId) return 'reintegro'
  if (e.reversalId) return 'anulado'
  return 'vigente'
}

/** Lo ya reintegrado de `original` (positivo). */
export function refundedAmountOf(originalId: string, all: readonly Expense[]): number {
  return -sum(all.filter(e => e.refundsExpenseId === originalId), e => e.valor)
}

export const POOL_STATE_LABEL: Record<PoolExpenseState, string> = {
  vigente: 'Vigente', anulado: 'Anulado', anulacion: 'Anulación', reintegro: 'Reintegro',
  historico: 'Histórico · sin bolsa', ruta: '',
}

// ------------------------------------------------------------
// Visibilidad de los gastos de empresa (sin ruta)
// ------------------------------------------------------------
/**
 * ¿Puede `actor` ver este gasto de EMPRESA? (Los de ruta y trabajador siguen su
 * regla de alcance por ruta, fuera de aquí.)
 *   · SuperAdmin: todos los de su empresa.
 *   · Administrador: los de SU bolsa y los históricos que él mismo registró.
 *     Nunca los de otra bolsa ni los de la empresa.
 *   · Resto: ninguno.
 */
export function canViewCompanyExpense(actor: Pick<User, 'id' | 'rol' | 'tenantId'> | null | undefined, e: Expense): boolean {
  if (!actor || e.tenantId !== actor.tenantId || e.routeId) return false
  if (actor.rol === 'superadmin') return true
  if (actor.rol !== 'admin') return false
  const f = expenseFundingOf(e)
  if (f.kind === 'admin') return f.adminId === actor.id
  if (f.kind === 'historico') return e.userId === actor.id
  return false
}
