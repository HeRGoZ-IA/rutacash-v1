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
//   · Fondos, releídos DENTRO de la transacción: un gasto de RUTA no supera lo Sin
//     asignar (`disponible`): sale de la caja de la ruta, que es capital.
//   · Un gasto de TRABAJADOR NO se limita a su efectivo en manos (incidente
//     2026-10-08, comportamiento histórico anterior a e7708c2): el combustible del
//     día se paga aunque el cobrador ya haya desembolsado o entregado lo recaudado.
//     Su posición puede quedar NEGATIVA: se muestra y se arrastra tal cual (nunca
//     se compensa con Base, capital ni custodia) y se concilia en su cuadre. Un
//     negativo no ofrece efectivo traspasable ni devolvible (`transferableCash`).
//   · Idempotencia: `operationId` identifica la operación; un reintento técnico con
//     los mismos datos devuelve el gasto ya guardado, sin duplicarlo.
//
// GASTOS ADMINISTRATIVOS EN LA BOLSA (Ronda 2/6, 2026-10-11; D9–D12):
//   · Todo gasto NUEVO de 'empresa' declara la bolsa que lo paga (`funding`):
//       Administrador → solo SU bolsa (el servicio lo exige; nunca otra ni la de
//                       la empresa).
//       SuperAdmin    → la bolsa de la empresa (D10) o la de un Administrador
//                       ACTIVO de la empresa (D11); queda quién lo registró.
//   · Fondos: el gasto no supera el disponible de esa bolsa, releído DENTRO de una
//     transacción que bloquea las tablas de capital (gasto y colocación
//     concurrentes no gastan el mismo dinero). Sin saldo negativo: la excepción del
//     gasto del trabajador NO aplica a las bolsas.
//   · Históricos (sin `funding`) se conservan tal cual: no se imputan ni se corrigen
//     por esta vía (D9).
//   · Corrección (D12, `expense.correct`): anulación total o reintegro parcial, como
//     asientos negados ENLAZADOS al original. Nunca se edita ni borra un gasto.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { nowISO, today } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { can, canOperateRouteCash, filterByAccessibleRoute } from '@/lib/permissions'
import { expenseShapeError } from '@/lib/expenseAttribution'
import { assertCan, assertRouteCashAuthority, AuthzError } from '@/services/authz'
import { logAction } from '@/services/auditService'
import { assertRouteOperationalContext } from '@/services/officeService'
import { custodianBlockedReason, reconciliationTables } from '@/services/cashCustodyService'
import { closedPeriodBlockedReason } from '@/services/periodGuard'
import { computeRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { capitalTables, loadCapitalRows, type CapitalControlDatabase } from '@/services/capitalControlService'
import { adminCapital, computeCapitalStructure } from '@/lib/capitalAllocation'
import { canViewCompanyExpense, expenseFundingOf, poolExpenseStateOf, refundedAmountOf } from '@/lib/expenseFunding'
import { normalizeReversalReason } from '@/lib/movementReversal'
import type { Expense, ExpenseFunding, ExpenseScope, Route, SyncStatus, User } from '@/models/types'

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
  /**
   * Identificador de la OPERACIÓN (lo genera la pantalla al abrir el formulario y
   * lo reutiliza en cada reintento). Se usa como id del gasto: repetir la misma
   * operación devuelve el gasto ya guardado en lugar de crear otro.
   */
  operationId?: string
  /** Bolsa que paga un gasto de 'empresa' (obligatoria para gastos nuevos de empresa). */
  funding?: { source: 'admin'; adminId: string } | { source: 'empresa' }
  /** Referencia del soporte (factura, recibo). */
  referencia?: string
}

/** ¿`previo` es la misma operación que `fila`? (reintento técnico legítimo) */
function mismaOperacion(previo: Expense, fila: Omit<Expense, 'createdAt'>): boolean {
  return previo.tenantId === fila.tenantId && previo.routeId === fila.routeId && previo.scope === fila.scope
    && previo.collectorId === fila.collectorId && previo.categoryId === fila.categoryId
    && previo.valor === fila.valor && previo.userId === fila.userId
    && previo.funding === fila.funding && previo.fundingAdminId === fila.fundingAdminId
    && !previo.reversesId && !previo.refundsExpenseId
}

export class ExpenseFundingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpenseFundingError'
  }
}

/**
 * ¿Qué bolsas puede usar `actor` para un gasto de empresa? (UI; el servicio revalida.)
 *   · Administrador activo → solo la suya.
 *   · SuperAdmin → la de la empresa y la de cada Administrador ACTIVO de la empresa.
 */
export function payablePoolsFor(actor: User | null | undefined, users: User[]): ({ source: 'empresa' } | { source: 'admin'; adminId: string })[] {
  if (!actor || !canRegisterExpenseScope(actor, 'empresa')) return []
  if (actor.rol === 'admin') return [{ source: 'admin', adminId: actor.id }]
  if (actor.rol !== 'superadmin') return []
  return [
    { source: 'empresa' },
    ...users.filter(u => u.tenantId === actor.tenantId && u.rol === 'admin' && u.status === 'activo')
      .map(u => ({ source: 'admin' as const, adminId: u.id })),
  ]
}

/**
 * Bolsa VALIDADA para el gasto (fuera de la transacción; el disponible se mide
 * dentro). Lanza si el actor no puede cargar a esa bolsa.
 */
async function resolverBolsa(
  actor: User, tenantId: string, funding: CreateExpenseParams['funding'], database: RutaCashDB,
): Promise<{ funding: ExpenseFunding; fundingAdminId?: string }> {
  if (!funding) throw new ExpenseFundingError('Indica qué bolsa paga este gasto administrativo.')
  if (actor.rol === 'admin') {
    if (funding.source !== 'admin' || funding.adminId !== actor.id) {
      throw new AuthzError('Un Administrador solo registra gastos de su propia bolsa.')
    }
    return { funding: 'admin', fundingAdminId: actor.id }
  }
  if (actor.rol !== 'superadmin') throw new AuthzError('Solo el SuperAdmin y los Administradores registran gastos administrativos.')
  if (funding.source === 'empresa') return { funding: 'empresa' }
  const admin = await database.users.get(funding.adminId)
  if (!admin || admin.tenantId !== tenantId || admin.rol !== 'admin') throw new ExpenseFundingError('El Administrador indicado no existe en esta empresa.')
  if (admin.status !== 'activo') throw new ExpenseFundingError('No se pueden cargar gastos a la bolsa de un Administrador inactivo.')
  return { funding: 'admin', fundingAdminId: admin.id }
}

/** Disponible de la bolsa (llamar DENTRO de la transacción con `capitalTables`). */
async function disponibleDeBolsa(tenantId: string, bolsa: { funding: ExpenseFunding; fundingAdminId?: string }, database: RutaCashDB): Promise<number> {
  const rows = await loadCapitalRows(tenantId, database as unknown as CapitalControlDatabase)
  return bolsa.funding === 'admin'
    ? adminCapital(bolsa.fundingAdminId!, rows).disponible
    : computeCapitalStructure(rows, []).company.disponible
}

const tablasDeBolsa = (database: RutaCashDB) =>
  [...new Set([...(capitalTables(database as unknown as CapitalControlDatabase) as never[]), database.expenses])]

const nombreBolsa = (b: { funding: ExpenseFunding; fundingAdminId?: string }) =>
  b.funding === 'empresa' ? 'la bolsa de la empresa' : `la bolsa del Administrador ${b.fundingAdminId}`

/**
 * ¿Puede el actor registrar gastos de este tipo? (para ofrecer opciones en la UI).
 *
 * v16: 'ruta' lo paga la CAJA de la ruta → solo su Administrador responsable de
 * capital ('structural'). 'trabajador' cargado a OTRA persona → nivel de cuadre
 * ('settle': responsable, SuperAdmin, Supervisor de la ruta). Sin `ctx` (ruta y
 * usuarios) no se puede comprobar al responsable: falla cerrado.
 */
export function canRegisterExpenseScope(
  actor: User | null | undefined,
  scope: ExpenseScope,
  routeId?: string,
  ctx?: { route?: Route; users?: User[] },
): boolean {
  if (!actor) return false
  const tenantId = actor.tenantId
  if (scope === 'empresa') return can(actor, 'expense.register', { tenantId }) && can(actor, 'cashbox.viewConsolidated', { tenantId })
  if (!can(actor, 'expense.register', { tenantId, routeId })) return false
  if (!can(actor, 'cashCustody.manage', { tenantId, routeId })) return false
  if (!ctx?.route || !ctx.users) return false
  return canOperateRouteCash(actor, ctx.route, scope === 'ruta' ? 'structural' : 'settle', ctx.users)
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
  let bolsa: { funding: ExpenseFunding; fundingAdminId?: string } | undefined
  if (scope === 'empresa') {
    assertCan(actor, 'expense.register', { tenantId })
    assertCan(actor, 'cashbox.viewConsolidated', { tenantId })
    // Ronda 2/6: todo gasto NUEVO de empresa se paga con una bolsa concreta.
    bolsa = await resolverBolsa(actor, tenantId, params.funding, database)
    // Precisión monetaria del capital: enteros (mismo criterio que las bolsas).
    if (Math.round(valor) !== valor) throw new ExpenseError('El valor del gasto debe ser un entero.')
    if ((params.descripcion ?? '').trim().length < 3) throw new ExpenseError('Indica el concepto del gasto administrativo.')
  } else {
    if (params.funding) throw new ExpenseError('Solo los gastos de empresa se pagan con una bolsa: los de ruta y de trabajador salen de su caja.')
    assertCan(actor, 'expense.register', { tenantId, routeId })
    const route = await database.routes.get(routeId!)
    if (!route) throw new ExpenseError('La ruta indicada no existe.')
    if (route.tenantId !== tenantId) throw new AuthzError('La ruta no pertenece a esta empresa.')
    await assertRouteOperationalContext(routeId!)
    const usuarios = await database.users.where('tenantId').equals(tenantId).toArray()
    if (scope === 'ruta') {
      assertCan(actor, 'cashCustody.manage', { tenantId, routeId })
      // v16: lo paga la caja de la ruta → solo su Administrador responsable.
      assertRouteCashAuthority(actor, route, 'structural', usuarios)
    } else {
      persona = await database.users.get(collectorId!)
      const bloqueo = custodianBlockedReason(persona, routeId!, tenantId)
      if (bloqueo) throw new ExpenseError(bloqueo.replace('recibir Base física', 'responder por un gasto'))
      if (collectorId !== actor.id) {
        if (!can(actor, 'cashCustody.manage', { tenantId, routeId })) {
          throw new AuthzError('Los gastos que registras quedan a tu cargo: no puedes cargarlos a otra persona.')
        }
        // Cargar a otra persona es operar con su efectivo: nivel de cuadre (v16).
        assertRouteCashAuthority(actor, route, 'settle', usuarios)
      }
    }
  }

  const operacion = params.operationId === undefined ? generateId() : params.operationId.trim()
  if (!operacion) throw new ExpenseError('Identificador de operación inválido.')

  const fila: Omit<Expense, 'createdAt'> = {
    id: operacion, tenantId, routeId, scope, collectorId,
    categoryId: params.categoryId, valor,
    descripcion: params.descripcion?.trim() || undefined,
    receiptPhotoDataUrl: params.receiptPhotoDataUrl,
    referencia: params.referencia?.trim() || undefined,
    fecha: params.fecha || today(),
    userId: actor.id,
    syncStatus: params.syncStatus ?? 'synced',
    ...(bolsa ? { funding: bolsa.funding, fundingAdminId: bolsa.fundingAdminId } : {}),
  }

  let guardado!: Expense
  let reintento = false
  // Empresa: las tablas de CAPITAL entran en el bloqueo (el gasto compite por el
  // disponible de la bolsa con colocaciones, devoluciones y otros gastos).
  // Con ruta, los cierres semanales entran en el bloqueo (D7).
  const tablas = scope === 'empresa' ? tablasDeBolsa(database) : [...reconciliationTables(database), database.weeklySettlements]
  await database.transaction('rw', tablas, async () => {
    const previo = await database.expenses.get(fila.id)  // primera lectura: bloqueo obtenido
    const ahora = nowISO()
    if (previo) {
      // Reintento técnico de la MISMA operación: ya está guardada, no se duplica.
      if (!mismaOperacion(previo, fila)) throw new ExpenseError('Ese identificador de operación ya corresponde a otro gasto.')
      guardado = previo
      reintento = true
      return
    }
    // D7 (Ronda 6/6C): un gasto de ruta o de trabajador no entra en una semana ya
    // cerrada de la ruta (cambiaría esa liquidación sin reabrirla).
    if (scope !== 'empresa' && routeId) {
      const cerrado = await closedPeriodBlockedReason(routeId, fila.fecha, database)
      if (cerrado) throw new ExpenseError(cerrado)
    }
    // Gasto de TRABAJADOR: sin tope de efectivo en manos (ver cabecera); su posición
    // puede quedar negativa y se concilia en el cuadre.
    if (scope === 'ruta') {
      const r = await computeRouteCashReconciliation({ tenantId, routeId: routeId!, hasta: ahora }, database)
      if (valor > r.disponible) {
        throw new ExpenseError(`El gasto supera el efectivo sin asignar de la ruta (${r.disponible}).`)
      }
    }
    // Bolsa: nunca negativa (sin la excepción del gasto del trabajador).
    if (bolsa) {
      const disponible = await disponibleDeBolsa(tenantId, bolsa, database)
      if (valor > disponible) {
        throw new ExpenseFundingError(`El gasto supera el disponible de ${nombreBolsa(bolsa)} (disponible: ${disponible}).`)
      }
    }
    guardado = { ...fila, createdAt: ahora }
    await database.expenses.add(guardado)
  })
  if (reintento) return guardado

  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, routeId,
    action: 'CREATE_EXPENSE', entityType: 'expense', entityId: guardado.id,
    descripcion: `Gasto de ${scope}${collectorId ? ` a cargo de ${persona?.nombre ?? collectorId}` : ''}${bolsa ? ` pagado con ${nombreBolsa(bolsa)}` : ''}: ${valor}.`,
    after: { scope, routeId, collectorId, valor, categoryId: guardado.categoryId, fecha: guardado.fecha, funding: guardado.funding, fundingAdminId: guardado.fundingAdminId },
  }).catch(() => undefined)
  return guardado
}

// ============================================================
// CORRECCIÓN DE GASTOS ADMINISTRATIVOS (D12) — `expense.correct`
// ------------------------------------------------------------
// Solo gastos IMPUTADOS a una bolsa (los de ruta/trabajador tienen efectos en
// cuadres y cierres: fuera de este procedimiento; los históricos no se tocan, D9).
//   · Administrador: solo los de SU bolsa. SuperAdmin: los de cualquier bolsa.
//   · ANULACIÓN: asiento espejo (importe negado, misma bolsa, `reversesId`), el
//     original queda ANULADO con quién, cuándo y motivo. Una vez; nunca una
//     corrección; no con reintegros previos (se reintegra el resto).
//   · REINTEGRO: dinero devuelto (proveedor, devolución): importe negado enlazado
//     (`refundsExpenseId`), con tope en lo no reintegrado; idempotente.
// Ambos SUMAN disponible: no necesitan fondos. La bolsa no tiene cierres periódicos
// (los cierres son de rutas y cuadres, que un gasto de empresa no toca).
// ============================================================
export interface CorrectExpenseParams {
  actor: User | null | undefined
  tenantId: string
  expenseId: string
  reason: string
}

/** ¿Puede `actor` corregir este gasto? (para la UI; el servicio revalida). */
export function canCorrectPoolExpense(actor: User | null | undefined, e: Expense): boolean {
  if (!actor || e.tenantId !== actor.tenantId || !can(actor, 'expense.correct', { tenantId: e.tenantId })) return false
  if (poolExpenseStateOf(e) !== 'vigente') return false
  const f = expenseFundingOf(e)
  if (actor.rol === 'superadmin') return f.kind === 'admin' || f.kind === 'empresa'
  return actor.rol === 'admin' && f.kind === 'admin' && f.adminId === actor.id
}

/** Original corregible, releído DENTRO de la transacción. */
async function originalCorregible(actor: User, tenantId: string, expenseId: string, database: RutaCashDB): Promise<{ original: Expense; todos: Expense[] }> {
  const original = await database.expenses.get(expenseId)
  if (!original || original.tenantId !== tenantId) throw new ExpenseError('El gasto no existe.')
  const estado = poolExpenseStateOf(original)
  if (estado === 'historico') throw new ExpenseError('Es un gasto histórico sin bolsa: se conserva tal cual y no se corrige por esta vía.')
  if (estado === 'ruta') throw new ExpenseError('Los gastos de ruta o de trabajador no se corrigen desde la bolsa.')
  if (estado === 'anulado') throw new ExpenseError('Este gasto ya fue anulado.')
  if (estado === 'anulacion' || estado === 'reintegro') throw new ExpenseError('Una anulación o un reintegro no se pueden corregir.')
  if (!canCorrectPoolExpense(actor, original)) throw new AuthzError('No puedes corregir gastos de esa bolsa.')
  const todos = await database.expenses.where('tenantId').equals(tenantId).toArray()
  return { original, todos }
}

export async function reverseAdminExpense(params: CorrectExpenseParams, database: RutaCashDB = db): Promise<{ original: Expense; reversal: Expense }> {
  const { actor, tenantId } = params
  if (!actor || actor.tenantId !== tenantId) throw new AuthzError('Acción no autorizada para esta empresa.')
  assertCan(actor, 'expense.correct', { tenantId })
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new ExpenseError('Indica el motivo de la anulación.')
  let original!: Expense
  let reversal!: Expense
  await database.transaction('rw', tablasDeBolsa(database), async () => {
    const r = await originalCorregible(actor, tenantId, params.expenseId, database)
    if (refundedAmountOf(r.original.id, r.todos) > 0) {
      throw new ExpenseError('Este gasto ya tiene reintegros: registra un reintegro por el valor restante en lugar de anularlo.')
    }
    const ahora = nowISO()
    reversal = {
      ...r.original, id: generateId(), valor: -r.original.valor, descripcion: `Anulación: ${motivo}`,
      receiptPhotoDataUrl: undefined, referencia: undefined, fecha: today(), userId: actor.id, createdAt: ahora, syncStatus: 'synced',
      reversesId: r.original.id, reversalReason: motivo,
      reversalId: undefined, reversedAt: undefined, reversedByUserId: undefined, refundsExpenseId: undefined,
    }
    original = { ...r.original, reversalId: reversal.id, reversedAt: ahora, reversedByUserId: actor.id, reversalReason: motivo }
    await database.expenses.add(reversal)
    await database.expenses.put(original)
  })
  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, action: 'MOVEMENT_REVERSED', entityType: 'expense', entityId: original.id,
    descripcion: `Gasto administrativo anulado (${original.valor}): ${motivo}`, motivo,
    before: { valor: original.valor, estado: 'vigente' }, after: { estado: 'anulado', reversalId: reversal.id, funding: original.funding, fundingAdminId: original.fundingAdminId },
  }).catch(() => undefined)
  return { original, reversal }
}

export async function refundAdminExpense(
  params: CorrectExpenseParams & { amount: number; operationId?: string }, database: RutaCashDB = db,
): Promise<Expense> {
  const { actor, tenantId } = params
  if (!actor || actor.tenantId !== tenantId) throw new AuthzError('Acción no autorizada para esta empresa.')
  assertCan(actor, 'expense.correct', { tenantId })
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new ExpenseError('Indica el motivo del reintegro.')
  const amount = Number(params.amount)
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount) !== amount) throw new ExpenseError('El reintegro debe ser un entero mayor a 0.')
  const id = params.operationId === undefined ? generateId() : params.operationId.trim()
  if (!id) throw new ExpenseError('Identificador de operación inválido.')
  let fila!: Expense
  let reintento = false
  await database.transaction('rw', tablasDeBolsa(database), async () => {
    const previo = await database.expenses.get(id)
    if (previo) {
      if (previo.refundsExpenseId !== params.expenseId || previo.valor !== -amount || previo.tenantId !== tenantId) {
        throw new ExpenseError('Ese identificador de operación ya corresponde a otro movimiento.')
      }
      fila = previo
      reintento = true
      return
    }
    const r = await originalCorregible(actor, tenantId, params.expenseId, database)
    const restante = r.original.valor - refundedAmountOf(r.original.id, r.todos)
    if (amount > restante) throw new ExpenseError(`El reintegro supera lo que queda por reintegrar de este gasto (${restante}).`)
    fila = {
      ...r.original, id, valor: -amount, descripcion: `Reintegro: ${motivo}`,
      receiptPhotoDataUrl: undefined, referencia: undefined, fecha: today(), userId: actor.id, createdAt: nowISO(), syncStatus: 'synced',
      refundsExpenseId: r.original.id, reversalReason: motivo,
      reversesId: undefined, reversalId: undefined, reversedAt: undefined, reversedByUserId: undefined,
    }
    await database.expenses.add(fila)
  })
  if (reintento) return fila
  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, action: 'EXPENSE_REFUNDED', entityType: 'expense', entityId: params.expenseId,
    descripcion: `Reintegro de ${amount} al gasto administrativo: ${motivo}`, motivo,
    after: { reintegroId: fila.id, amount, funding: fila.funding, fundingAdminId: fila.fundingAdminId },
  }).catch(() => undefined)
  return fila
}

// ============================================================
// CONSULTA CON ALCANCE (pantalla de Gastos y Reportes)
// ============================================================
/**
 * Gastos que `actor` puede ver: los de rutas de su alcance (regla existente) y,
 * de los de EMPRESA, solo los permitidos por `canViewCompanyExpense` (cada
 * Administrador su bolsa; el SuperAdmin todos). Fuente única: ninguna pantalla lee
 * `db.expenses` por empresa sin pasar por aquí.
 */
export async function listVisibleExpenses(
  params: { actor: User | null | undefined; tenantId: string }, database: RutaCashDB = db,
): Promise<Expense[]> {
  const { actor, tenantId } = params
  if (!actor || actor.tenantId !== tenantId) return []
  const todos = await database.expenses.where('tenantId').equals(tenantId).toArray()
  const deRutas = filterByAccessibleRoute(actor, todos.filter((e): e is Expense & { routeId: string } => !!e.routeId))
  const deEmpresa = todos.filter(e => !e.routeId && canViewCompanyExpense(actor, e))
  return [...deRutas, ...deEmpresa]
}
