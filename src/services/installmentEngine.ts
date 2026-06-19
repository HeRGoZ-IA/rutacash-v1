// ============================================================
// Motor de cuotas - lógica financiera pura, sin dependencias UI
// ============================================================
import { v4 as uuidv4 } from 'uuid'
import { parseISO, addDays, addWeeks, addMonths, format, differenceInDays, isAfter } from 'date-fns'
import type { Installment, PaymentFrequency, Payment, InstallmentStatus } from '@/models/types'

export function generateInstallments(params: {
  saleId: string
  valorTotal: number
  numeroCuotas: number
  valorCuota: number
  frecuencia: PaymentFrequency
  fechaInicio: string
}): Installment[] {
  const { saleId, valorTotal, numeroCuotas, valorCuota, frecuencia, fechaInicio } = params
  const installments: Installment[] = []
  let fechaBase = parseISO(fechaInicio)

  for (let i = 1; i <= numeroCuotas; i++) {
    let fechaVenc: Date
    switch (frecuencia) {
      case 'diaria':
        fechaVenc = addDays(fechaBase, i - 1)
        break
      case 'semanal':
        fechaVenc = addWeeks(fechaBase, i - 1)
        break
      case 'quincenal':
        fechaVenc = addDays(fechaBase, (i - 1) * 15)
        break
      case 'mensual':
        fechaVenc = addMonths(fechaBase, i - 1)
        break
      default:
        fechaVenc = addDays(fechaBase, i - 1)
    }

    // Última cuota absorbe diferencia de redondeo
    const valor = i === numeroCuotas
      ? Math.round(valorTotal - valorCuota * (numeroCuotas - 1))
      : valorCuota

    installments.push({
      id: uuidv4(),
      saleId,
      numero: i,
      fechaVencimiento: format(fechaVenc, 'yyyy-MM-dd'),
      valor,
      pagado: 0,
      saldo: valor,
      status: 'pendiente',
      diasMora: 0,
    })
  }
  return installments
}

export function calculateOverdueDays(installment: Installment, today = new Date()): number {
  if (installment.status === 'pagada') return 0
  const venc = parseISO(installment.fechaVencimiento)
  if (isAfter(today, venc)) {
    return differenceInDays(today, venc)
  }
  return 0
}

export function updateInstallmentStatuses(
  installments: Installment[],
  today = new Date()
): Installment[] {
  return installments
    .sort((a, b) => a.numero - b.numero)
    .map((inst) => {
      const diasMora = calculateOverdueDays(inst, today)
      let status: InstallmentStatus = inst.status
      if (status !== 'pagada') {
        if (inst.pagado === 0 && diasMora > 0) status = 'vencida'
        else if (inst.pagado > 0 && inst.saldo > 0) status = 'parcial'
        else if (inst.saldo === 0) status = 'pagada'
        else status = 'pendiente'
      }
      return { ...inst, diasMora, status }
    })
}

export function applyPaymentToInstallments(
  installments: Installment[],
  valorPago: number
): { updatedInstallments: Installment[]; saldoRestante: number } {
  const sorted = [...installments].sort((a, b) => a.numero - b.numero)
  let remaining = valorPago

  const updated = sorted.map((inst) => {
    if (remaining <= 0 || inst.status === 'pagada') return inst
    const toApply = Math.min(remaining, inst.saldo)
    remaining -= toApply
    const newPagado = inst.pagado + toApply
    const newSaldo = inst.valor - newPagado
    const newStatus: InstallmentStatus = newSaldo <= 0 ? 'pagada' : 'parcial'
    return {
      ...inst,
      pagado: Math.round(newPagado),
      saldo: Math.max(0, Math.round(newSaldo)),
      status: newStatus,
    }
  })

  return {
    updatedInstallments: updateInstallmentStatuses(updated),
    saldoRestante: remaining,
  }
}

export function calculateCurrentInstallment(installments: Installment[]): Installment | null {
  const sorted = [...installments].sort((a, b) => a.numero - b.numero)
  return sorted.find((i) => i.status !== 'pagada') ?? null
}

export function calculateSaleBalance(installments: Installment[]): number {
  return installments.reduce((sum, i) => sum + i.saldo, 0)
}

export function recalculateSaleFromPayments(
  originalInstallments: Installment[],
  payments: Payment[]
): Installment[] {
  // Reinicia cuotas y re-aplica pagos en orden cronológico
  let reset = originalInstallments.map((i) => ({
    ...i,
    pagado: 0,
    saldo: i.valor,
    status: 'pendiente' as InstallmentStatus,
    diasMora: 0,
  }))

  const sortedPayments = [...payments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )

  for (const payment of sortedPayments) {
    const result = applyPaymentToInstallments(reset, payment.valor)
    reset = result.updatedInstallments
  }

  return updateInstallmentStatuses(reset)
}

export function calculateInstallmentValue(params: {
  valorTotal: number
  numeroCuotas: number
}): number {
  return Math.round(params.valorTotal / params.numeroCuotas)
}

export function calculateTotalWithInterest(params: {
  valorVenta: number
  tasaInteres: number
}): { valorInteres: number; valorTotal: number } {
  const valorInteres = Math.round(params.valorVenta * (params.tasaInteres / 100))
  return {
    valorInteres,
    valorTotal: params.valorVenta + valorInteres,
  }
}

export function estimateFinalDate(params: {
  fechaInicio: string
  numeroCuotas: number
  frecuencia: PaymentFrequency
}): string {
  const base = parseISO(params.fechaInicio)
  const n = params.numeroCuotas - 1
  let end: Date
  switch (params.frecuencia) {
    case 'diaria': end = addDays(base, n); break
    case 'semanal': end = addWeeks(base, n); break
    case 'quincenal': end = addDays(base, n * 15); break
    case 'mensual': end = addMonths(base, n); break
    default: end = addDays(base, n); break
  }
  return format(end, 'yyyy-MM-dd')
}
