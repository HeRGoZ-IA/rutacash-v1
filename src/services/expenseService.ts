// ============================================================
// GASTOS — ESCRITURA CON INSTANTE SELLADO BAJO BLOQUEO
// ------------------------------------------------------------
// El cuadre por trabajador corta por INSTANTE (`createdAt`) con la convención
// (desde, hasta]. Si el instante de un gasto se sellara ANTES de obtener el bloqueo
// de la tabla, un cierre concurrente (otra pestaña) podría leer sin verlo y el gasto
// quedaría con instante ≤ `hasta` pero confirmado después: en NINGÚN ciclo.
// Sellando dentro de la transacción, tras una primera lectura, el gasto o bien se
// confirma antes de que el cierre lea, o espera a que termine y obtiene un instante
// posterior a su frontera (ver `closeCashSettlement`).
//
// CLASIFICACIÓN (ajustes del socio 2026-10-02, punto 9) — `createExpense` es la
// ÚNICA puerta de las pantallas. Valida aquí (la pantalla no es autoridad):
//   · Forma: `expenseShapeError` (sin estados ambiguos).
//   · Empresa del actor, categoría de la empresa, valor > 0.
//   · 'empresa'    → `expense.register` + `cashbox.viewConsolidated` (gasto fuera
//                    de las rutas: lo registra quien gestiona la empresa).
//   · 'ruta'       → `expense.register` + `cashCustody.manage` sobre la ruta (quien
//                    administra su caja). Ruta de la empresa y Oficina activa.
//   · 'trabajador' → `expense.register` sobre la ruta; la persona debe poder tener
//                    efectivo en ella (`custodianBlockedReason`). Cargarlo a OTRA
//                    persona exige `cashCustody.manage`: el Cobrador solo registra
//                    los suyos; Supervisor y Admin pueden indicar a quién.
//   · Fondos, releídos DENTRO de la transacción: un gasto de trabajador no supera
//     su efectivo en manos (`transferableCash`, sin el arrastre de faltantes); uno
//     de ruta no supera lo Sin asignar (`disponible`). Nunca una posición imposible.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO, today } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { can } from '@/lib/permissions'
import { expenseShapeError } from '@/lib/expenseAttribution'
import { assertCan, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { assertRouteOperationalContext } from '@/services/officeService'
import { custodianBlockedReason, reconciliationTables, transferableCash } from '@/services/cashCustodyService'
import { personalCashPosition } from '@/services/cashSettlementService'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import type { Expense, ExpenseScope, SyncStatus, User } from '@/models/types'

export async function addExpenseStamped(expense: Omit<Expense, 'createdAt'>, database: RutaCashDB = db): Promise<Expense> {
  return database.transaction('rw', [database.expenses], async () => {
    await database.expenses.get(expense.id)            // primera lectura: bloqueo obtenido
    const fila: Expense = { ...expense, createdAt: nowISO() }
    await database.expenses.add(fila)
    return fila
  })
}

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpenseError'
  }
}

export interface CreateExpenseParams {
  actor: User | null | undefined
  tenantId: string
  scope: ExpenseScope
  routeId?: string
  /** Trabajador que pagó (solo 'trabajador'). */
  collectorId?: string
  categoryId: string
  valor: number
  descripcion?: string
  receiptPhotoDataUrl?: string
  /** Fecha contable (por defecto, hoy). */
  fecha?: string
  syncStatus?: SyncStatus
}

/** ¿Puede el actor registrar gastos de este tipo? (para ofrecer opciones en la UI). */
export function canRegisterExpenseScope(actor: User | null | undefined, scope: ExpenseScope, routeId?: string): boolean {
  if (!actor) return false
  const tenantId = actor.tenantId
  if (scope === 'empresa') return can(actor, 'expense.register', { tenantId }) && can(actor, 'cashbox.viewConsolidated', { tenantId })
  if (!can(actor, 'expense.register', { tenantId, routeId })) return false
  // Ruta, o trabajador ajeno: administra la caja de la ruta.
  return can(actor, 'cashCustody.manage', { tenantId, routeId })
}

export async function createExpense(params: CreateExpenseParams, database: RutaCashDB = db): Promise<Expense> {
  const { actor, tenantId, scope } = params
  const routeId = params.routeId || undefined
  const collectorId = params.collectorId || undefined
  const forma = expenseShapeError({ scope, routeId, collectorId })
  if (forma) throw new ExpenseError(forma)
  if (!actor || actor.tenantId !== tenantId) throw new AuthzError('Acción no autorizada para esta empresa.')

  const valor = Number(params.valor)
  if (!Number.isFinite(valor) || valor <= 0) throw new ExpenseError('El valor del gasto debe ser mayor a 0.')
  const categoria = await database.expenseCategories.get(params.categoryId)
  if (!categoria || categoria.tenantId !== tenantId) throw new ExpenseError('Selecciona una categoría válida.')

  let persona: User | undefined
  if (scope === 'empresa') {
    assertCan(actor, 'expense.register', { tenantId })
    assertCan(actor, 'cashbox.viewConsolidated', { tenantId })
  } else {
    assertCan(actor, 'expense.register', { tenantId, routeId })
    const route = await database.routes.get(routeId!)
    if (!route) throw new ExpenseError('La ruta indicada no existe.')
    if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
    await assertRouteOperationalContext(routeId!)
    if (scope === 'ruta') {
      assertCan(actor, 'cashCustody.manage', { tenantId, routeId })
    } else {
      persona = await database.users.get(collectorId!)
      const bloqueo = custodianBlockedReason(persona, routeId!, tenantId)
      if (bloqueo) throw new ExpenseError(bloqueo.replace('recibir Base física', 'responder por un gasto'))
      if (collectorId !== actor.id && !can(actor, 'cashCustody.manage', { tenantId, routeId })) {
        throw new AuthzError('Los gastos que registras quedan a tu cargo: no puedes cargarlos a otra persona.')
      }
    }
  }

  const fila: Omit<Expense, 'createdAt'> = {
    id: generateId(), tenantId, routeId, scope, collectorId,
    categoryId: params.categoryId, valor,
    descripcion: params.descripcion?.trim() || undefined,
    receiptPhotoDataUrl: params.receiptPhotoDataUrl,
    fecha: params.fecha || today(),
    userId: actor.id,
    syncStatus: params.syncStatus ?? 'synced',
  }

  let guardado!: Expense
  const tablas = scope === 'empresa' ? [database.expenses] : reconciliationTables(database)
  await database.transaction('rw', tablas, async () => {
    await database.expenses.get(fila.id)                // primera lectura: bloqueo obtenido
    const ahora = nowISO()
    if (scope === 'trabajador') {
      const pos = await personalCashPosition({ tenantId, routeId: routeId!, userId: collectorId!, hasta: ahora }, database)
      const enMano = transferableCash(pos)
      if (valor > enMano) {
        throw new ExpenseError(`El gasto supera el efectivo en manos de ${persona!.nombre} (${enMano}).`)
      }
    } else if (scope === 'ruta') {
      const r = await computeRouteCashReconciliation({ tenantId, routeId: routeId!, hasta: ahora }, database)
      if (valor > r.disponible) {
        throw new ExpenseError(`El gasto supera el efectivo sin asignar de la ruta (${r.disponible}).`)
      }
    }
    guardado = { ...fila, createdAt: ahora }
    await database.expenses.add(guardado)
  })

  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, routeId,
    action: 'CREATE_EXPENSE', entityType: 'expense', entityId: guardado.id,
    descripcion: `Gasto de ${scope}${collectorId ? ` a cargo de ${persona?.nombre ?? collectorId}` : ''}: ${valor}.`,
    after: { scope, routeId, collectorId, valor, categoryId: guardado.categoryId, fecha: guardado.fecha },
  }).catch(() => undefined)
  return guardado
}
