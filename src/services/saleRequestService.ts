// ============================================================
// App Cobrador — creación de ventas y solicitudes de venta
// Reutiliza el motor financiero existente (installmentEngine).
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { can } from '@/lib/permissions'
import { assertCan } from '@/services/authz'
import {
  calculateTotalWithInterest, calculateInstallmentValue,
  estimateFinalDate, generateInstallments,
} from '@/services/installmentEngine'
import type {
  Sale, Installment, SaleRequest, PaymentFrequency, DisbursementStatus, User,
} from '@/models/types'

export interface SaleInputs {
  tenantId: string
  /** Legacy opcional (oficinas eliminadas). */
  officeId?: string
  routeId: string
  clientId: string
  createdByUserId: string
  valorVenta: number
  tasaInteres: number
  numeroCuotas: number
  frecuenciaPago: PaymentFrequency
  fechaInicio: string
  paymentDays: number[]
}

/** Calcula los campos financieros derivados de una venta (sin tocar la base). */
export function computeSaleFinancials(input: Pick<SaleInputs, 'valorVenta' | 'tasaInteres' | 'numeroCuotas' | 'frecuenciaPago' | 'fechaInicio' | 'paymentDays'>) {
  const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: input.valorVenta, tasaInteres: input.tasaInteres })
  const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: input.numeroCuotas })
  const fechaFinalEstimada = estimateFinalDate({ fechaInicio: input.fechaInicio, numeroCuotas: input.numeroCuotas, frecuencia: input.frecuenciaPago, paymentDays: input.paymentDays })
  return { valorInteres, valorTotal, valorCuota, fechaFinalEstimada }
}

/** Construye (en memoria) la venta y sus parcelas. No persiste. */
export function buildSaleWithInstallments(
  input: SaleInputs,
  disbursementStatus: DisbursementStatus,
  saleRequestId?: string,
): { sale: Sale; installments: Installment[] } {
  const saleId = generateId()
  const { valorInteres, valorTotal, valorCuota, fechaFinalEstimada } = computeSaleFinancials(input)
  const installments = generateInstallments({
    saleId, valorTotal, numeroCuotas: input.numeroCuotas, valorCuota,
    frecuencia: input.frecuenciaPago, fechaInicio: input.fechaInicio, paymentDays: input.paymentDays,
  })
  const sale: Sale = {
    id: saleId, tenantId: input.tenantId, officeId: input.officeId, routeId: input.routeId,
    clientId: input.clientId, createdByUserId: input.createdByUserId,
    valorVenta: input.valorVenta, tasaInteres: input.tasaInteres, valorInteres, valorTotal,
    saldo: valorTotal, numeroCuotas: input.numeroCuotas, valorCuota,
    frecuenciaPago: input.frecuenciaPago, paymentDays: input.paymentDays,
    fechaInicio: input.fechaInicio, fechaFinalEstimada, status: 'activa',
    disbursementStatus, saleRequestId,
    createdAt: nowISO(), updatedAt: nowISO(),
  }
  return { sale, installments }
}

/**
 * Venta DIRECTA (desembolsada y activa de inmediato). VALIDACIÓN EN SERVICIO
 * (modelo de roles y permisos): quien la ejecuta debe tener la capacidad
 * `sale.createDirect` sobre la ruta. Hoy solo la poseen Administrador y Super Admin.
 * Un Cobrador/Supervisor/Secretario será RECHAZADO aquí aunque intente saltarse la UI.
 * `actor` es opcional únicamente para compatibilidad con seeds/tests internos.
 */
export async function createDirectSale(input: SaleInputs, actor?: User): Promise<Sale> {
  if (actor && !can(actor, 'sale.createDirect', { routeId: input.routeId, tenantId: input.tenantId })) {
    throw new Error('No autorizado: este perfil no puede crear ventas directas. La venta debe enviarse como solicitud.')
  }
  const { sale, installments } = buildSaleWithInstallments(input, 'desembolsado')
  await db.transaction('rw', [db.sales, db.installments], async () => {
    await db.sales.add(sale)
    await db.installments.bulkAdd(installments)
  })
  return sale
}

/** Construye (en memoria) una Solicitud de venta. No persiste. */
export function buildSaleRequest(input: SaleInputs): SaleRequest {
  const { valorTotal, valorCuota } = computeSaleFinancials(input)
  return {
    id: generateId(), tenantId: input.tenantId, clientId: input.clientId,
    routeId: input.routeId, collectorId: input.createdByUserId,
    amount: input.valorVenta, interestRate: input.tasaInteres, totalAmount: valorTotal,
    installmentsCount: input.numeroCuotas, installmentValue: valorCuota,
    frequency: input.frecuenciaPago, startDate: input.fechaInicio, paymentDays: input.paymentDays,
    status: 'pending', requestedAt: nowISO(),
    // Trazabilidad: condiciones SOLICITADAS congeladas (no se sobrescriben al aprobar).
    requestedBy: input.createdByUserId,
    requestedInterestRate: input.tasaInteres,
    requestedFrequency: input.frecuenciaPago,
    requestedPaymentDays: input.paymentDays,
  }
}

/**
 * Crea una Solicitud de venta (estado pending). VALIDA EN SERVICIO que el actor
 * tenga `sale.createRequest` sobre la ruta (fail-closed) cuando se pasa `actor`.
 */
export async function createSaleRequest(input: SaleInputs, actor?: User): Promise<SaleRequest> {
  if (actor) assertCan(actor, 'sale.createRequest', { routeId: input.routeId, tenantId: input.tenantId })
  const request = buildSaleRequest(input)
  await db.saleRequests.add(request)
  return request
}

/**
 * Cambios de condiciones permitidos por el autorizador (Secretario/Admin/Superadmin):
 * porcentaje (tasa), frecuencia y días de pago, además de confirmación telefónica.
 */
export interface ApprovalOverrides {
  notes?: string
  interestRate?: number
  frequency?: PaymentFrequency
  paymentDays?: number[]
  phoneConfirmed?: boolean
  phoneConfirmationNote?: string
}

/**
 * Aprueba una solicitud: crea la venta + parcelas con disbursementStatus 'pendiente'
 * (lista pero NO cobrable hasta confirmar el desembolso) y marca la solicitud como
 * 'approved'. Registra las condiciones FINALES sin sobrescribir las SOLICITADAS
 * (evidencia antes/después). El importe NO se modifica en la autorización.
 */
export async function approveSaleRequest(request: SaleRequest, actor: User, overrides?: ApprovalOverrides): Promise<Sale> {
  // Guard de datos: solo quien puede APROBAR autorizaciones en ESA ruta.
  assertCan(actor, 'authorization.approve', { routeId: request.routeId, tenantId: request.tenantId })
  if (overrides && (overrides.interestRate !== undefined || overrides.frequency !== undefined || overrides.paymentDays !== undefined)) {
    assertCan(actor, 'authorization.modifyConditions', { routeId: request.routeId, tenantId: request.tenantId })
  }
  const reviewerId = actor.id
  const route = await db.routes.get(request.routeId)
  // Condiciones finales = override ?? condición solicitada.
  const finalInterest = overrides?.interestRate ?? request.interestRate
  const finalFrequency = overrides?.frequency ?? request.frequency
  const finalPaymentDays = overrides?.paymentDays ?? request.paymentDays ?? []

  const input: SaleInputs = {
    tenantId: request.tenantId, officeId: route?.officeId ?? '', routeId: request.routeId,
    clientId: request.clientId, createdByUserId: request.collectorId,
    valorVenta: request.amount, tasaInteres: finalInterest, numeroCuotas: request.installmentsCount,
    frecuenciaPago: finalFrequency, fechaInicio: request.startDate, paymentDays: finalPaymentDays,
  }
  const { sale, installments } = buildSaleWithInstallments(input, 'pendiente', request.id)
  await db.transaction('rw', [db.sales, db.installments, db.saleRequests], async () => {
    await db.sales.add(sale)
    await db.installments.bulkAdd(installments)
    await db.saleRequests.update(request.id, {
      status: 'approved', reviewedAt: nowISO(), reviewedBy: reviewerId,
      approvalNotes: overrides?.notes || undefined, saleId: sale.id,
      // Congelar solicitadas si no existían (solicitudes antiguas) y registrar finales.
      requestedInterestRate: request.requestedInterestRate ?? request.interestRate,
      requestedFrequency: request.requestedFrequency ?? request.frequency,
      requestedPaymentDays: request.requestedPaymentDays ?? request.paymentDays,
      approvedInterestRate: finalInterest,
      approvedFrequency: finalFrequency,
      approvedPaymentDays: finalPaymentDays,
      phoneConfirmed: overrides?.phoneConfirmed ?? request.phoneConfirmed,
      phoneConfirmationNote: overrides?.phoneConfirmationNote ?? request.phoneConfirmationNote,
      // Reflejar en los campos base las condiciones finales aplicadas.
      interestRate: finalInterest, frequency: finalFrequency, paymentDays: finalPaymentDays,
    })
  })
  return sale
}

/** Rechaza una solicitud con motivo. No crea venta. Valida capacidad en servicio. */
export async function rejectSaleRequest(request: SaleRequest, actor: User, reason: string): Promise<void> {
  assertCan(actor, 'authorization.reject', { routeId: request.routeId, tenantId: request.tenantId })
  await db.saleRequests.update(request.id, {
    status: 'rejected', reviewedAt: nowISO(), reviewedBy: actor.id, rejectionReason: reason,
  })
}

/**
 * Cuenta las ventas pendientes por desembolsar en una ruta (App Cobrador).
 * Fuente única de verdad para el badge del dashboard y del menú inferior.
 */
export async function countPendingDisbursements(routeId: string): Promise<number> {
  if (!routeId) return 0
  const sales = await db.sales.where('routeId').equals(routeId).toArray()
  return sales.filter(s => s.status === 'activa' && s.disbursementStatus === 'pendiente').length
}

/**
 * Devuelve la venta activa de un cliente, si existe (revisión socio 25-jun).
 * "Activa" = estado 'activa', ya sea desembolsada o pendiente de desembolso.
 * Se usa para advertir al crear una segunda venta al mismo cliente.
 */
export async function findActiveSaleForClient(clientId: string): Promise<Sale | null> {
  if (!clientId) return null
  const sales = await db.sales.where('clientId').equals(clientId).toArray()
  return sales.find(s => s.status === 'activa') ?? null
}

/** Cuenta las solicitudes de venta pendientes por revisar (Administrador). */
export async function countPendingSaleRequests(tenantId: string): Promise<number> {
  if (!tenantId) return 0
  const reqs = await db.saleRequests.where('tenantId').equals(tenantId).toArray()
  return reqs.filter(r => r.status === 'pending').length
}

/**
 * Confirma el desembolso de una venta aprobada: la venta queda desembolsada
 * (cobrable) y la solicitud asociada pasa a 'disbursed'.
 */
export async function confirmDisbursement(saleId: string, actor?: User): Promise<void> {
  const sale = await db.sales.get(saleId)
  if (!sale) throw new Error('Venta no encontrada')
  if (actor) assertCan(actor, 'sale.confirmDisbursement', { routeId: sale.routeId, tenantId: sale.tenantId })
  await db.transaction('rw', [db.sales, db.saleRequests], async () => {
    await db.sales.update(saleId, { disbursementStatus: 'desembolsado', updatedAt: nowISO() })
    if (sale.saleRequestId) {
      await db.saleRequests.update(sale.saleRequestId, { status: 'disbursed' })
    }
  })
}
