// ============================================================
// Motor de cuotas - lógica financiera pura, sin dependencias UI
// ============================================================
import { v4 as uuidv4 } from 'uuid'
import { parseISO, addDays, addWeeks, addMonths, format, differenceInDays, isAfter } from 'date-fns'
import type { Installment, PaymentFrequency, Payment, InstallmentStatus } from '@/models/types'

// ------------------------------------------------------------
// Días de pago (paymentDays): 0=domingo, 1=lunes ... 6=sábado
// ------------------------------------------------------------

/** Devuelve la misma fecha si su día de semana está permitido; si no, avanza al siguiente día permitido. */
function nextAllowedDay(date: Date, allowed: number[]): Date {
  let d = date
  // allowed siempre tiene >=1 elemento → como mucho 6 saltos. Guard de seguridad anti-bucle.
  for (let guard = 0; guard < 8; guard++) {
    if (allowed.includes(d.getDay())) return d
    d = addDays(d, 1)
  }
  return d
}

/**
 * Calcula las fechas de vencimiento de las cuotas.
 * - Si paymentDays es undefined/vacío → comportamiento original (compatibilidad con ventas antiguas).
 * - Si paymentDays tiene días → las fechas caen únicamente en esos días (según la frecuencia).
 *
 * Reglas por frecuencia cuando hay paymentDays:
 *  - diaria:    se recorre el calendario y solo se cuentan los días permitidos (saltea no permitidos).
 *  - semanal:   se ancla en el primer día permitido en/después de fechaInicio y se suma 1 semana por cuota.
 *               (si hay varios días seleccionados, el "primer día permitido alcanzado" es el día semanal principal).
 *  - quincenal: se mantiene la cadencia de 15 días; si la fecha cae en día no permitido se mueve al siguiente permitido.
 *  - mensual:   se mantiene la cadencia mensual; si la fecha cae en día no permitido se mueve al siguiente permitido.
 */
export function computeInstallmentDates(params: {
  fechaInicio: string
  numeroCuotas: number
  frecuencia: PaymentFrequency
  paymentDays?: number[]
}): string[] {
  const { fechaInicio, numeroCuotas, frecuencia, paymentDays } = params
  const fechaBase = parseISO(fechaInicio)
  const allowed = paymentDays && paymentDays.length > 0 ? paymentDays : null
  const dates: Date[] = []

  if (!allowed) {
    // Comportamiento original (sin días de pago)
    for (let i = 1; i <= numeroCuotas; i++) {
      switch (frecuencia) {
        case 'diaria': dates.push(addDays(fechaBase, i - 1)); break
        case 'semanal': dates.push(addWeeks(fechaBase, i - 1)); break
        case 'quincenal': dates.push(addDays(fechaBase, (i - 1) * 15)); break
        case 'mensual': dates.push(addMonths(fechaBase, i - 1)); break
        default: dates.push(addDays(fechaBase, i - 1))
      }
    }
    return dates.map(d => format(d, 'yyyy-MM-dd'))
  }

  switch (frecuencia) {
    case 'semanal': {
      const anchor = nextAllowedDay(fechaBase, allowed)
      for (let i = 0; i < numeroCuotas; i++) dates.push(addWeeks(anchor, i))
      break
    }
    case 'quincenal': {
      for (let i = 0; i < numeroCuotas; i++) dates.push(nextAllowedDay(addDays(fechaBase, i * 15), allowed))
      break
    }
    case 'mensual': {
      for (let i = 0; i < numeroCuotas; i++) dates.push(nextAllowedDay(addMonths(fechaBase, i), allowed))
      break
    }
    case 'diaria':
    default: {
      let cursor = nextAllowedDay(fechaBase, allowed)
      for (let i = 0; i < numeroCuotas; i++) {
        dates.push(cursor)
        cursor = nextAllowedDay(addDays(cursor, 1), allowed)
      }
      break
    }
  }
  return dates.map(d => format(d, 'yyyy-MM-dd'))
}

export function generateInstallments(params: {
  saleId: string
  valorTotal: number
  numeroCuotas: number
  valorCuota: number
  frecuencia: PaymentFrequency
  fechaInicio: string
  paymentDays?: number[]
}): Installment[] {
  const { saleId, valorTotal, numeroCuotas, valorCuota, frecuencia, fechaInicio, paymentDays } = params
  const fechas = computeInstallmentDates({ fechaInicio, numeroCuotas, frecuencia, paymentDays })
  const installments: Installment[] = []

  for (let i = 1; i <= numeroCuotas; i++) {
    // Última cuota absorbe diferencia de redondeo
    const valor = i === numeroCuotas
      ? Math.round(valorTotal - valorCuota * (numeroCuotas - 1))
      : valorCuota

    installments.push({
      id: uuidv4(),
      saleId,
      numero: i,
      fechaVencimiento: fechas[i - 1],
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
  paymentDays?: number[]
}): string {
  const fechas = computeInstallmentDates(params)
  return fechas[fechas.length - 1] ?? params.fechaInicio
}

// ------------------------------------------------------------
// Helpers para el listado del cobrador (días de pago)
// ------------------------------------------------------------

/** ¿Hoy es un día de cobro programado para esta venta? Sin paymentDays = todos los días (compatibilidad). */
export function isPaymentDayToday(paymentDays: number[] | undefined, today = new Date()): boolean {
  if (!paymentDays || paymentDays.length === 0) return true
  return paymentDays.includes(today.getDay())
}

/** ¿La venta tiene cuotas vencidas (saldo pendiente con vencimiento anterior a hoy)? */
export function hasOverdueBalance(installments: Installment[], todayStr: string): boolean {
  return installments.some(i => i.saldo > 0 && i.fechaVencimiento < todayStr)
}

/**
 * Regla del cobrador: una venta es "a cobrar hoy" si hoy es día programado
 * O si arrastra saldo vencido (las cuotas vencidas siempre son cobrables, sea o no día programado).
 */
export function isSaleDueToday(
  paymentDays: number[] | undefined,
  installments: Installment[],
  today = new Date(),
  todayStr = format(today, 'yyyy-MM-dd')
): boolean {
  return isPaymentDayToday(paymentDays, today) || hasOverdueBalance(installments, todayStr)
}

// ------------------------------------------------------------
// App Cobrador — desembolso y estado de cobro (verde/amarillo/rojo)
// ------------------------------------------------------------

/**
 * ¿La venta está desembolsada (cobrable)?
 * Las ventas antiguas no tienen `disbursementStatus` → se consideran desembolsadas.
 * Solo `disbursementStatus === 'pendiente'` bloquea el cobro.
 */
export function isSaleDisbursed(sale: { disbursementStatus?: 'pendiente' | 'desembolsado' }): boolean {
  return sale.disbursementStatus !== 'pendiente'
}

/** Cantidad de parcelas con saldo y vencimiento anterior a hoy. */
export function countOverdueInstallments(installments: Installment[], todayStr: string): number {
  return installments.filter(i => i.saldo > 0 && i.fechaVencimiento < todayStr).length
}

/** Mayor número de días de atraso entre las parcelas con saldo pendiente. */
export function getMaxOverdueDays(installments: Installment[], today = new Date()): number {
  return installments.reduce((max, i) => i.saldo > 0 ? Math.max(max, calculateOverdueDays(i, today)) : max, 0)
}

export type CollectionStatus = 'verde' | 'amarillo' | 'rojo'

/**
 * Estado visual de cobro (regla inicial, documentada — el socio la afinará):
 * - verde: sin parcelas vencidas.
 * - amarillo: 1 a 3 días de atraso.
 * - rojo: más de 3 días de atraso.
 */
export function getCollectionStatus(installments: Installment[], today = new Date()): CollectionStatus {
  const dias = getMaxOverdueDays(installments, today)
  if (dias <= 0) return 'verde'
  if (dias <= 3) return 'amarillo'
  return 'rojo'
}
