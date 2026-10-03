// ============================================================
// CORRECCIÓN CONTROLADA DE PAGOS (no destructiva)
// ------------------------------------------------------------
// El pago original NUNCA se elimina ni se sobrescribe. Una corrección crea:
//   1) Un asiento de REVERSIÓN (valor negativo) que anula contablemente al original.
//   2) Un pago CORREGIDO nuevo con el valor/fecha correctos.
// y marca el original como 'reversed', enlazando ambos. Tras la corrección se
// recalculan parcelas, saldo de la venta y (por agregación) caja/recaudo/cuadre.
//
// Periodo ABIERTO  → el Secretario corrige directamente.
// Periodo CERRADO  → el Secretario genera una SOLICITUD DE AJUSTE que aprueba un
//                    Administrador autorizado o el Super Admin; al aprobar se
//                    ejecuta la misma reversión + reemplazo.
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { formatCurrency, nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { can } from '@/lib/permissions'
import { normalizeReversalReason } from '@/lib/movementReversal'
import { AuthzError } from '@/services/authz'
import { reconciliationTables } from '@/services/cashCustodyService'
import { computeRouteCashReconciliation, type RouteCashReconciliation } from '@/services/routeCashReconciliation'
import { recalculateSaleFromPayments, calculateSaleBalance } from '@/services/installmentEngine'
import { dependentSyncStatus, effectivePayments as onlyEffective, isPaymentAnnullable, lastEffectivePaymentDate } from '@/lib/paymentState'
import { resolveSealedCompletionDate } from '@/lib/creditHistory'
import { protectingClosureFor } from '@/lib/settlementPeriods'
import type { Payment, PaymentAdjustmentRequest, Sale, User, WeeklySettlement } from '@/models/types'

/** Lectura mínima de liquidaciones que necesita la comprobación de periodo. */
export interface ClosedPeriodDatabase {
  weeklySettlements: {
    where(index: string): { equals(key: string): { toArray(): Promise<WeeklySettlement[]> } }
  }
}

/**
 * ¿El pago cae dentro de una liquidación/periodo CERRADO de su ruta?
 *
 * FECHA CONTABLE: se compara `payment.fecha` —el día al que pertenece el dinero—
 * y NO `createdAt`/`updatedAt`. Un pago registrado tarde pertenece a la semana en
 * que se cobró, así que debe quedar protegido por el cierre de ESA semana.
 *
 * La condición de "cierre que protege" vive en `@/lib/settlementPeriods`
 * (`protectingClosureFor`), de modo que una sola definición decide aquí, en el
 * historial y en la pantalla. Un periodo REABIERTO deja de proteger: ese es el
 * efecto que se busca al reabrirlo.
 *
 * La base es inyectable para poder probar la protección sin IndexedDB.
 */
export async function isPaymentInClosedPeriod(
  payment: Pick<Payment, 'routeId' | 'fecha'>,
  database: ClosedPeriodDatabase = db,
): Promise<boolean> {
  const settlements = await database.weeklySettlements.where('routeId').equals(payment.routeId).toArray()
  return protectingClosureFor(settlements, payment.routeId, payment.fecha) !== null
}

/**
 * Pagos "efectivos" de una venta: excluye originales revertidos y asientos de reversión.
 *
 * La definición vive ahora en `@/lib/paymentState` (pura, sin Dexie) para que también
 * puedan aplicarla las migraciones del esquema y los reportes sin dependencia circular.
 * Se REEXPORTA aquí para no romper a quien ya la importaba desde este servicio: sigue
 * habiendo una sola definición de qué cuenta contablemente.
 */
export { effectivePayments, isEffectivePayment, lastEffectivePaymentDate } from '@/lib/paymentState'

/**
 * FUNCIÓN CANÓNICA DE RECÁLCULO DEL CRÉDITO. Reconstruye parcelas, saldo, estado
 * y fecha de finalización de la venta DESDE CERO a partir de sus pagos vigentes
 * (orden determinista createdAt + id). No "deshace" campo a campo: la misma lista
 * de pagos vigentes produce siempre el mismo estado. La usan la corrección y la
 * anulación de pagos.
 *
 * ATOMICIDAD: debe invocarse SIEMPRE dentro de la misma transacción que escribe los
 * pagos (`executeCorrection`). Antes se ejecutaba fuera, de modo que un fallo aquí
 * dejaba los asientos de reversión/reemplazo guardados con las parcelas y el saldo
 * antiguos. Las tablas que toca (`sales`, `installments`, `payments`) ya están en el
 * ámbito de esa transacción, así que no requiere abrir una propia.
 *
 * Se conserva intacta la semántica existente: una venta 'perdida' o 'refinanciada'
 * NUNCA cambia de estado al recomputar.
 */
export async function recomputeSale(saleId: string, database: RutaCashDB = db): Promise<void> {
  const sale = await database.sales.get(saleId)
  if (!sale) return
  const installments = await database.installments.where('saleId').equals(saleId).toArray()
  const payments = await database.payments.where('saleId').equals(saleId).toArray()
  const vigentes = onlyEffective(payments)
  const recomputed = recalculateSaleFromPayments(installments, vigentes)
  for (const inst of recomputed) {
    await database.installments.update(inst.id, { pagado: inst.pagado, saldo: inst.saldo, status: inst.status, diasMora: inst.diasMora })
  }
  const newSaldo = calculateSaleBalance(recomputed)
  let status: Sale['status'] = sale.status
  if (sale.status === 'activa' || sale.status === 'finalizada') {
    status = newSaldo <= 0 ? 'finalizada' : 'activa'
  }

  // FECHA REAL DE FINALIZACIÓN: se conserva si ya estaba sellada; solo se limpia
  // cuando la corrección REABRE la venta (deja de estar finalizada), y se sella de
  // nuevo si vuelve a saldarse. Nunca se reescribe una fecha ya sellada mientras la
  // venta siga cerrada. Ver `resolveSealedCompletionDate`.
  const fechaFinalizacion = resolveSealedCompletionDate({
    status,
    sealed: sale.fechaFinalizacion,
    lastEffectivePaymentDate: lastEffectivePaymentDate(vigentes),
  })

  await database.sales.update(saleId, {
    saldo: Math.max(0, newSaldo), status, fechaFinalizacion, updatedAt: nowISO(),
  })
}

export interface CorrectionInput {
  newValor: number
  newFecha?: string
  reason: string
  observacion?: string
}

/**
 * Ejecuta la reversión + reemplazo de un pago (núcleo compartido por la corrección
 * directa y por la aprobación de una solicitud de ajuste). No valida permisos aquí:
 * lo hacen las funciones públicas `correctPayment` / `approvePaymentAdjustment`.
 * Devuelve los ids del asiento de reversión y del pago corregido.
 */
async function executeCorrection(original: Payment, actor: User, input: CorrectionInput): Promise<{ reversalId: string; correctedId: string }> {
  const reversalId = generateId()
  const correctedId = generateId()
  // Provisional: el instante definitivo se sella dentro de la transacción, bajo bloqueo.
  const ts = nowISO()

  const reversal: Payment = {
    id: reversalId,
    tenantId: original.tenantId, saleId: original.saleId, clientId: original.clientId,
    routeId: original.routeId, collectorId: original.collectorId,
    // AUTORÍA ≠ RESPONSABILIDAD: el dinero sigue siendo de quien lo recibió
    // (`collectorId` heredado, NUNCA se reatribuye al corrector), pero debe constar
    // quién ejecutó el asiento. Sin esto la reversión quedaba con
    // `createdByUserId: undefined`, que por la regla legacy equivale a `collectorId`
    // y borraba la traza de que la corrigió otra persona.
    createdByUserId: actor.id,
    valor: -original.valor, fecha: original.fecha, tipo: original.tipo,
    observacion: `Reversión de pago ${original.id}`,
    syncStatus: 'synced', createdAt: ts,
    state: 'reversal', reversesPaymentId: original.id,
    correctionReason: input.reason, correctedBy: actor.id, correctedAt: ts,
  }

  const corrected: Payment = {
    id: correctedId,
    tenantId: original.tenantId, saleId: original.saleId, clientId: original.clientId,
    routeId: original.routeId, collectorId: original.collectorId,
    // Mismo criterio que la reversión: responsable original, autor el corrector.
    createdByUserId: actor.id,
    valor: input.newValor, fecha: input.newFecha ?? original.fecha, tipo: original.tipo,
    observacion: input.observacion || original.observacion,
    syncStatus: 'synced', createdAt: ts,
    state: 'active', correctionOfPaymentId: original.id,
    correctionReason: input.reason, correctedBy: actor.id, correctedAt: ts,
  }

  // UNA SOLA TRANSACCIÓN: reversión + pago corregido + recómputo de parcelas y venta.
  // Si cualquier paso falla, Dexie revierte TODO: nunca quedan pagos corregidos
  // conviviendo con parcelas y saldo antiguos.
  await db.transaction('rw', [db.payments, db.installments, db.sales], async () => {
    // Instante sellado BAJO BLOQUEO (primera lectura dentro de la transacción): la
    // reversión y la corrección nunca quedan detrás de la frontera de un cuadre por
    // trabajador que se esté cerrando a la vez (ver `closeCashSettlement`).
    const fresco = await db.payments.get(original.id)
    const sello = nowISO()
    reversal.createdAt = reversal.correctedAt = sello
    corrected.createdAt = corrected.correctedAt = sello
    // CAUSALIDAD DE SINCRONIZACIÓN (punto 8): si el original aún no está confirmado,
    // la reversión y el reemplazo nacen pendientes y se confirman con él, nunca antes.
    reversal.syncStatus = corrected.syncStatus = dependentSyncStatus(fresco ?? original)
    await db.payments.update(original.id, {
      state: 'reversed', correctedByPaymentId: correctedId, reversalPaymentId: reversalId,
      correctionReason: input.reason, correctedBy: actor.id, correctedAt: sello,
    })
    await db.payments.add(reversal)
    await db.payments.add(corrected)
    await recomputeSale(original.saleId)
  })

  // La auditoría va FUERA: `auditLogs` no forma parte del ámbito de la transacción
  // y un fallo al auditar no debe revertir una corrección ya consolidada.
  await logAction({
    tenantId: original.tenantId, userId: actor.id, userRole: actor.rol, routeId: original.routeId,
    action: 'CORRECT_PAYMENT', entityType: 'Payment', entityId: original.id,
    descripcion: `Corrección de pago (reversión + reemplazo)`,
    before: { valor: original.valor, fecha: original.fecha },
    after: { valor: input.newValor, fecha: input.newFecha ?? original.fecha },
    motivo: input.reason,
    metadata: { reversalId, correctedId },
  })
  await logAction({
    tenantId: original.tenantId, userId: actor.id, userRole: actor.rol, routeId: original.routeId,
    action: 'REVERSE_PAYMENT', entityType: 'Payment', entityId: reversalId,
    descripcion: `Asiento de reversión del pago ${original.id}`, motivo: input.reason,
  })

  return { reversalId, correctedId }
}

/**
 * Corrección DIRECTA (periodo abierto). Valida permiso `payment.correct` en la
 * ruta y con el estado de periodo. En periodo cerrado, `can` exige la capacidad
 * de aprobar ajustes (admin/superadmin); un Secretario será rechazado aquí y debe
 * usar `requestPaymentAdjustment`.
 */
export async function correctPayment(actor: User, paymentId: string, input: CorrectionInput): Promise<{ success: boolean; error?: string; reversalId?: string; correctedId?: string }> {
  if (!input.reason?.trim()) return { success: false, error: 'El motivo es obligatorio' }
  if (!(input.newValor > 0)) return { success: false, error: 'El valor corregido debe ser mayor a 0' }
  const original = await db.payments.get(paymentId)
  if (!original) return { success: false, error: 'Pago no encontrado' }
  if (original.state === 'reversed' || original.state === 'reversal') return { success: false, error: 'Este pago ya fue corregido o es un asiento de reversión' }

  const periodClosed = await isPaymentInClosedPeriod(original)
  if (!can(actor, 'payment.correct', { routeId: original.routeId, tenantId: original.tenantId, periodClosed })) {
    return {
      success: false,
      error: periodClosed
        ? 'El pago está en un periodo cerrado. Genera una solicitud de ajuste para aprobación.'
        : 'No tienes permiso para corregir este pago.',
    }
  }
  const { reversalId, correctedId } = await executeCorrection(original, actor, input)
  return { success: true, reversalId, correctedId }
}

/**
 * SOLICITUD DE AJUSTE DE PAGO (periodo cerrado). La crea el Secretario cuando el
 * pago ya está en una liquidación cerrada. Debe aprobarla un Administrador
 * autorizado para la ruta o el Super Admin.
 */
export async function requestPaymentAdjustment(actor: User, paymentId: string, input: CorrectionInput): Promise<{ success: boolean; error?: string; requestId?: string }> {
  if (!input.reason?.trim()) return { success: false, error: 'El motivo es obligatorio' }
  if (!(input.newValor > 0)) return { success: false, error: 'El valor corregido debe ser mayor a 0' }
  const original = await db.payments.get(paymentId)
  if (!original) return { success: false, error: 'Pago no encontrado' }
  // El actor debe al menos poder corregir pagos de la ruta (Secretario/Admin/Superadmin).
  if (!can(actor, 'payment.correct', { routeId: original.routeId, tenantId: original.tenantId, periodClosed: false })) {
    return { success: false, error: 'No tienes permiso sobre pagos de esta ruta.' }
  }
  const req: PaymentAdjustmentRequest = {
    id: generateId(), tenantId: original.tenantId, routeId: original.routeId,
    paymentId: original.id, clientId: original.clientId, saleId: original.saleId,
    requestedBy: actor.id, requestedByRole: actor.rol, requestedAt: nowISO(),
    originalValor: original.valor, originalFecha: original.fecha,
    reason: input.reason, newValor: input.newValor, newFecha: input.newFecha, observacion: input.observacion,
    status: 'pending',
  }
  await db.paymentAdjustmentRequests.add(req)
  await logAction({
    tenantId: original.tenantId, userId: actor.id, userRole: actor.rol, routeId: original.routeId,
    action: 'REQUEST_PAYMENT_ADJUSTMENT', entityType: 'Payment', entityId: original.id,
    descripcion: 'Solicitud de ajuste de pago (periodo cerrado)',
    before: { valor: original.valor, fecha: original.fecha },
    after: { valor: input.newValor, fecha: input.newFecha ?? original.fecha },
    motivo: input.reason,
  })
  return { success: true, requestId: req.id }
}

/** Aprueba una solicitud de ajuste y ejecuta la reversión + reemplazo. */
export async function approvePaymentAdjustment(actor: User, requestId: string): Promise<{ success: boolean; error?: string }> {
  const req = await db.paymentAdjustmentRequests.get(requestId)
  if (!req) return { success: false, error: 'Solicitud no encontrada' }
  if (req.status !== 'pending') return { success: false, error: 'La solicitud ya fue procesada' }
  if (!can(actor, 'payment.approveAdjustment', { routeId: req.routeId, tenantId: req.tenantId })) {
    return { success: false, error: 'No tienes permiso para aprobar ajustes de esta ruta.' }
  }
  const original = await db.payments.get(req.paymentId)
  if (!original) return { success: false, error: 'Pago original no encontrado' }
  if (original.state === 'reversed' || original.state === 'reversal') return { success: false, error: 'El pago ya fue corregido' }

  const { reversalId, correctedId } = await executeCorrection(original, actor, {
    newValor: req.newValor, newFecha: req.newFecha, reason: req.reason, observacion: req.observacion,
  })
  await db.paymentAdjustmentRequests.update(requestId, {
    status: 'approved', reviewedBy: actor.id, reviewedAt: nowISO(),
    resultingReversalId: reversalId, resultingPaymentId: correctedId,
  })
  await logAction({
    tenantId: req.tenantId, userId: actor.id, userRole: actor.rol, routeId: req.routeId,
    action: 'APPROVE_PAYMENT_ADJUSTMENT', entityType: 'PaymentAdjustmentRequest', entityId: requestId,
    descripcion: 'Aprobación de solicitud de ajuste de pago', motivo: req.reason,
  })
  return { success: true }
}

/** Rechaza una solicitud de ajuste. No modifica el pago original. */
export async function rejectPaymentAdjustment(actor: User, requestId: string, rejectionReason: string): Promise<{ success: boolean; error?: string }> {
  const req = await db.paymentAdjustmentRequests.get(requestId)
  if (!req) return { success: false, error: 'Solicitud no encontrada' }
  if (req.status !== 'pending') return { success: false, error: 'La solicitud ya fue procesada' }
  if (!can(actor, 'payment.approveAdjustment', { routeId: req.routeId, tenantId: req.tenantId })) {
    return { success: false, error: 'No tienes permiso para procesar ajustes de esta ruta.' }
  }
  if (!rejectionReason?.trim()) return { success: false, error: 'Indica el motivo del rechazo' }
  await db.paymentAdjustmentRequests.update(requestId, {
    status: 'rejected', reviewedBy: actor.id, reviewedAt: nowISO(), rejectionReason: rejectionReason.trim(),
  })
  await logAction({
    tenantId: req.tenantId, userId: actor.id, userRole: actor.rol, routeId: req.routeId,
    action: 'REJECT_PAYMENT_ADJUSTMENT', entityType: 'PaymentAdjustmentRequest', entityId: requestId,
    descripcion: 'Rechazo de solicitud de ajuste de pago', motivo: rejectionReason.trim(),
  })
  return { success: true }
}

/** Solicitudes de ajuste pendientes de una empresa (para el badge del Administrador). */
export async function countPendingAdjustmentRequests(tenantId: string): Promise<number> {
  if (!tenantId) return 0
  const reqs = await db.paymentAdjustmentRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r => r.status === 'pending').length
}

/**
 * Solicitudes de ajuste pendientes que ESTE usuario puede APROBAR.
 *
 * Mismo principio que `countPendingSaleRequestsForUser`: el badge debe valer lo
 * mismo que la lista. Aquí la capacidad es `payment.approveAdjustment`, que el
 * Secretario NO tiene: él ORIGINA los ajustes, los aprueba un Administrador. Con
 * este contador, el Secretario obtiene 0 por la propia regla de permisos, sin
 * necesidad de una excepción escrita en la pantalla.
 */
export async function countPendingAdjustmentRequestsForUser(
  user: User | null | undefined,
  tenantId: string,
): Promise<number> {
  if (!user || !tenantId) return 0
  const reqs = await db.paymentAdjustmentRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r =>
    r.status === 'pending' && can(user, 'payment.approveAdjustment', { routeId: r.routeId, tenantId }),
  ).length
}

// ============================================================
// ANULACIÓN ADMINISTRATIVA DE UN PAGO (ajustes del socio 2026-10-02, punto 7)
// ------------------------------------------------------------
// Un pago registrado por error (duplicado, valor mal digitado, cliente
// equivocado, registro accidental) no se borra ni se edita: se ANULA.
//
//   original  → queda en `payments`, state 'reversed', con `reversalPaymentId`,
//               motivo, quién y cuándo (`correctionReason/correctedBy/correctedAt`)
//   reversión → asiento espejo state 'reversal', valor −X, `reversesPaymentId`,
//               MISMA fecha contable y MISMO responsable (`collectorId`) que el
//               original; `createdAt` = instante de la anulación
//   crédito   → `recomputeSale`: parcelas, saldo, estado y fecha de finalización
//               se reconstruyen desde los pagos vigentes (reabre si estaba saldado)
//
// Es la misma convención que ya usaba la corrección (reversión sin reemplazo):
//   · Base de la ruta / motor de caja: suman con signo → +X −X = 0.
//   · Reportes y vistas de cobro: excluyen el par (pagos vigentes).
//   · Caja personal (cuadre): libro con signo POR INSTANTE → el −X cae en el ciclo
//     en que se anula; un cuadre ya cerrado nunca se reescribe.
//
// EFECTIVO FÍSICO (revalidado dentro de la transacción, antes y después):
//   · la Base de la ruta no puede quedar negativa;
//   · si el −X cae en la caja de una persona, esa persona debe tener aún ese
//     efectivo en manos (misma regla que la anulación de fondos, punto 3: el
//     dinero entregado en mano solo se revierte si esa persona aún lo tiene).
//     Si ya lo cuadró o lo usó, primero se le entrega Base por la diferencia;
//   · si cae en la caja de la ruta (pago sin caja personal), no puede superar lo
//     sin asignar;
//   · la conciliación debe seguir cuadrando.
// ============================================================
export class PaymentAnnulmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAnnulmentError'
  }
}

export interface AnnulPaymentParams {
  actor: User | null | undefined
  tenantId: string
  paymentId: string
  reason: string
}

/** ¿`actor` puede anular `payment`? La regla de periodo cerrado se revalida en el servicio. */
export function canAnnulPayment(
  actor: User | null | undefined,
  payment: Pick<Payment, 'routeId' | 'tenantId' | 'state' | 'valor'>,
): boolean {
  return isPaymentAnnullable(payment) && can(actor, 'payment.reverse', { routeId: payment.routeId, tenantId: payment.tenantId })
}

function assertAnnulmentKeepsCashPossible(
  antes: RouteCashReconciliation, despues: RouteCashReconciliation, responsableId: string, valor: number,
): void {
  if (despues.libro.saldo < 0 && despues.libro.saldo < antes.libro.saldo) {
    throw new PaymentAnnulmentError(
      `La Base de la ruta no alcanza para anular este pago (Base: ${formatCurrency(antes.libro.saldo)}).`,
    )
  }
  const pA = antes.personas.find(p => p.userId === responsableId)
  const pD = despues.personas.find(p => p.userId === responsableId)
  if (pD && pD.posicion < 0 && pD.posicion < (pA?.posicion ?? 0)) {
    const enManos = Math.max(0, pA?.posicion ?? 0)
    throw new PaymentAnnulmentError(
      `${pD.nombre} ya no tiene en manos el efectivo de este pago (en manos: ${formatCurrency(enManos)}). ` +
      `Antes de anular, entrégale Base desde la caja de la ruta por ${formatCurrency(valor - enManos)}.`,
    )
  }
  if (despues.noAsignado < 0 && despues.noAsignado < antes.noAsignado) {
    throw new PaymentAnnulmentError(
      `La caja de la ruta no tiene ese efectivo sin asignar (sin asignar: ${formatCurrency(Math.max(0, antes.noAsignado))}).`,
    )
  }
  if (antes.cuadra && !despues.cuadra) {
    throw new PaymentAnnulmentError('La anulación descuadraría la conciliación de la ruta. No se aplicó.')
  }
}

export async function annulPayment(
  params: AnnulPaymentParams, database: RutaCashDB = db,
): Promise<{ original: Payment; reversal: Payment }> {
  if (!params.actor) throw new AuthzError('Acción no autorizada: falta el usuario.')
  const actor = params.actor
  const motivo = normalizeReversalReason(params.reason)
  if (!motivo) throw new PaymentAnnulmentError('Indica el motivo de la anulación.')
  const { tenantId, paymentId } = params

  let original!: Payment
  let reversal!: Payment
  let periodClosed = false
  await database.transaction('rw', [...reconciliationTables(database), database.installments, database.weeklySettlements], async () => {
    // 1–3. Lectura fresca bajo bloqueo: existe, es de la empresa, sigue vigente.
    const p = await database.payments.get(paymentId)
    if (!p || p.tenantId !== tenantId) throw new PaymentAnnulmentError('El pago no existe.')
    if (p.state === 'reversal') throw new PaymentAnnulmentError('Una reversión no se puede anular.')
    if (p.state === 'reversed') throw new PaymentAnnulmentError('Este pago ya fue anulado o corregido.')
    if (!isPaymentAnnullable(p)) throw new PaymentAnnulmentError('Este pago no se puede anular.')
    // 4–5. Capacidad y alcance sobre la ruta REAL del pago (y periodo cerrado).
    periodClosed = await isPaymentInClosedPeriod(p, database)
    if (!can(actor, 'payment.reverse', { routeId: p.routeId, tenantId, periodClosed })) {
      throw new AuthzError('No tienes permiso para anular pagos de esta ruta.')
    }
    const sale = await database.sales.get(p.saleId)
    if (!sale || sale.tenantId !== tenantId) throw new PaymentAnnulmentError('El crédito del pago no existe.')

    const sello = nowISO()
    const antes = await computeRouteCashReconciliation({ tenantId, routeId: p.routeId, hasta: sello }, database)

    // 6–8. Asiento espejo + marca del original + recálculo canónico del crédito.
    reversal = {
      id: generateId(),
      tenantId, saleId: p.saleId, clientId: p.clientId, routeId: p.routeId,
      // Responsable heredado (se descuenta a quien recibió el dinero); autor = quien anula.
      collectorId: p.collectorId, createdByUserId: actor.id,
      valor: -p.valor, fecha: p.fecha, tipo: p.tipo,
      observacion: `Anulación del pago ${p.id}`,
      // Hereda la confirmación del original (punto 8): la reversión de un pago aún
      // pendiente queda pendiente y se confirma junto con él, nunca antes.
      syncStatus: dependentSyncStatus(p), createdAt: sello,
      state: 'reversal', reversesPaymentId: p.id,
      correctionReason: motivo, correctedBy: actor.id, correctedAt: sello,
    }
    original = {
      ...p, state: 'reversed', reversalPaymentId: reversal.id,
      correctionReason: motivo, correctedBy: actor.id, correctedAt: sello,
    }
    await database.payments.add(reversal)
    await database.payments.put(original)
    await recomputeSale(p.saleId, database)

    // 9. Efectivo físico posible tras la anulación; si no, rollback completo.
    const despues = await computeRouteCashReconciliation({ tenantId, routeId: p.routeId, hasta: sello }, database)
    assertAnnulmentKeepsCashPossible(antes, despues, p.collectorId, p.valor)
  })

  // 10. Auditoría fuera de la transacción (`auditLogs` no está en su ámbito). La
  // traza mínima —quién, cuándo, motivo, vínculos— ya quedó atómica en los pagos.
  await logAction({
    tenantId, userId: actor.id, userRole: actor.rol, routeId: original.routeId,
    action: 'ANNUL_PAYMENT', entityType: 'Payment', entityId: original.id,
    descripcion: `Pago anulado (${original.valor}): ${motivo}`, motivo,
    before: { valor: original.valor, fecha: original.fecha, estado: 'vigente' },
    after: { estado: 'anulado', reversalId: reversal.id },
    metadata: { reversalId: reversal.id, saleId: original.saleId, collectorId: original.collectorId, periodClosed },
  }).catch(() => undefined)

  return { original, reversal }
}
