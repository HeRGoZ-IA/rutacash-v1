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
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { can } from '@/lib/permissions'
import { recalculateSaleFromPayments, calculateSaleBalance } from '@/services/installmentEngine'
import type { Payment, PaymentAdjustmentRequest, Sale, User } from '@/models/types'

/** ¿El pago cae dentro de una liquidación/periodo CERRADO de su ruta? */
export async function isPaymentInClosedPeriod(payment: Payment): Promise<boolean> {
  const settlements = await db.weeklySettlements.where('routeId').equals(payment.routeId).toArray()
  return settlements.some(
    s => (s.status ?? 'cerrada') === 'cerrada' && payment.fecha >= s.semanaInicio && payment.fecha <= s.semanaFin
  )
}

/** Pagos "efectivos" de una venta: excluye originales revertidos y asientos de reversión. */
function effectivePayments(payments: Payment[]): Payment[] {
  return payments.filter(p => p.state !== 'reversed' && p.state !== 'reversal')
}

/** Recalcula parcelas y saldo/estado de la venta a partir de sus pagos efectivos. */
async function recomputeSale(saleId: string): Promise<void> {
  const sale = await db.sales.get(saleId)
  if (!sale) return
  const [installments, payments] = await Promise.all([
    db.installments.where('saleId').equals(saleId).toArray(),
    db.payments.where('saleId').equals(saleId).toArray(),
  ])
  const recomputed = recalculateSaleFromPayments(installments, effectivePayments(payments))
  for (const inst of recomputed) {
    await db.installments.update(inst.id, { pagado: inst.pagado, saldo: inst.saldo, status: inst.status, diasMora: inst.diasMora })
  }
  const newSaldo = calculateSaleBalance(recomputed)
  let status: Sale['status'] = sale.status
  if (sale.status === 'activa' || sale.status === 'finalizada') {
    status = newSaldo <= 0 ? 'finalizada' : 'activa'
  }
  await db.sales.update(saleId, { saldo: Math.max(0, newSaldo), status, updatedAt: nowISO() })
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
  const ts = nowISO()

  const reversal: Payment = {
    id: reversalId,
    tenantId: original.tenantId, saleId: original.saleId, clientId: original.clientId,
    routeId: original.routeId, collectorId: original.collectorId,
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
    valor: input.newValor, fecha: input.newFecha ?? original.fecha, tipo: original.tipo,
    observacion: input.observacion || original.observacion,
    syncStatus: 'synced', createdAt: ts,
    state: 'active', correctionOfPaymentId: original.id,
    correctionReason: input.reason, correctedBy: actor.id, correctedAt: ts,
  }

  await db.transaction('rw', [db.payments, db.installments, db.sales], async () => {
    await db.payments.update(original.id, {
      state: 'reversed', correctedByPaymentId: correctedId,
      correctionReason: input.reason, correctedBy: actor.id, correctedAt: ts,
    })
    await db.payments.add(reversal)
    await db.payments.add(corrected)
  })
  // Fuera de la transacción de escritura de pagos: recomputar la venta.
  await recomputeSale(original.saleId)

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
