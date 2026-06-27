// ============================================================
// App Cobrador — creación de ventas y solicitudes de venta
// Reutiliza el motor financiero existente (installmentEngine).
// ============================================================
import { db } from '@/lib/db'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import {
  calculateTotalWithInterest, calculateInstallmentValue,
  estimateFinalDate, generateInstallments,
} from '@/services/installmentEngine'
import type {
  Sale, Installment, SaleRequest, PaymentFrequency, DisbursementStatus,
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
 * Venta DIRECTA del cobrador (autorizada y dentro de límite): queda desembolsada
 * y activa para recaudo de inmediato. Crea venta + parcelas en transacción.
 */
export async function createDirectSale(input: SaleInputs): Promise<Sale> {
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
  }
}

/** Crea una Solicitud de venta (estado pending). No crea venta todavía. */
export async function createSaleRequest(input: SaleInputs): Promise<SaleRequest> {
  const request = buildSaleRequest(input)
  await db.saleRequests.add(request)
  return request
}

/**
 * Aprueba una solicitud: crea la venta + parcelas con disbursementStatus 'pendiente'
 * (queda lista pero NO cobrable hasta que el cobrador confirme el desembolso) y
 * marca la solicitud como 'approved' enlazando la venta. Todo en una transacción.
 */
export async function approveSaleRequest(request: SaleRequest, reviewerId: string, notes?: string): Promise<Sale> {
  const route = await db.routes.get(request.routeId)
  const input: SaleInputs = {
    tenantId: request.tenantId, officeId: route?.officeId ?? '', routeId: request.routeId,
    clientId: request.clientId, createdByUserId: request.collectorId,
    valorVenta: request.amount, tasaInteres: request.interestRate, numeroCuotas: request.installmentsCount,
    frecuenciaPago: request.frequency, fechaInicio: request.startDate, paymentDays: request.paymentDays ?? [],
  }
  const { sale, installments } = buildSaleWithInstallments(input, 'pendiente', request.id)
  await db.transaction('rw', [db.sales, db.installments, db.saleRequests], async () => {
    await db.sales.add(sale)
    await db.installments.bulkAdd(installments)
    await db.saleRequests.update(request.id, {
      status: 'approved', reviewedAt: nowISO(), reviewedBy: reviewerId,
      approvalNotes: notes || undefined, saleId: sale.id,
    })
  })
  return sale
}

/** Rechaza una solicitud con motivo. No crea venta. */
export async function rejectSaleRequest(request: SaleRequest, reviewerId: string, reason: string): Promise<void> {
  await db.saleRequests.update(request.id, {
    status: 'rejected', reviewedAt: nowISO(), reviewedBy: reviewerId, rejectionReason: reason,
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
export async function confirmDisbursement(saleId: string): Promise<void> {
  const sale = await db.sales.get(saleId)
  if (!sale) throw new Error('Venta no encontrada')
  await db.transaction('rw', [db.sales, db.saleRequests], async () => {
    await db.sales.update(saleId, { disbursementStatus: 'desembolsado', updatedAt: nowISO() })
    if (sale.saleRequestId) {
      await db.saleRequests.update(sale.saleRequestId, { status: 'disbursed' })
    }
  })
}
