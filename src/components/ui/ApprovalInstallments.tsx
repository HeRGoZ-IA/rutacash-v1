import { Input } from '@/components/ui/Input'
import { formatCurrency } from '@/lib/formatters'
import { calculateInstallmentValue, calculateTotalWithInterest } from '@/services/installmentEngine'

function minorDigits(currency: string): number {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { return 2 }
}

/**
 * Ronda 73 · SOC-04 / SOC-07: número de parcelas modificable en la autorización y resumen de la
 * obligación que se aprobará (total y valor de parcela con el MISMO motor que el servidor). Así
 * quien autoriza ve exactamente lo que se desembolsará con la tasa y las parcelas elegidas.
 */
export function ApprovalInstallments({ amount, rate, count, onCount, currency, requested }: {
  amount: number
  rate: number
  count: number
  onCount: (n: number) => void
  currency: string
  /** Parcelas solicitadas (se muestran si cambian). */
  requested: number
}) {
  const valid = Number.isInteger(count) && count >= 1 && count <= 1000
  // Mismo cálculo que el servidor: en unidades menores de la moneda (ISO 4217).
  const factor = 10 ** minorDigits(currency)
  const totalMinor = calculateTotalWithInterest({ valorVenta: Math.round(amount * factor), tasaInteres: rate }).valorTotal
  const valorTotal = totalMinor / factor
  const cuota = valid ? calculateInstallmentValue({ valorTotal: totalMinor, numeroCuotas: count }) / factor : 0
  return (
    <div className="space-y-2">
      <Input label="N° de parcelas" type="number" inputMode="numeric" min={1} max={1000} step={1}
        value={Number.isFinite(count) ? String(count) : ''} onChange={e => onCount(Math.trunc(Number(e.target.value)))}
        error={valid ? undefined : 'Indica un número entero entre 1 y 1000'}
        hint={count !== requested ? `Solicitadas: ${requested}` : undefined} />
      <div className="rounded-xl bg-primary-50/60 border border-primary-100 px-3 py-2 text-sm flex flex-wrap justify-between gap-2">
        <span className="text-gray-600">Total a pagar <span className="font-semibold text-gray-900">{formatCurrency(valorTotal, currency)}</span></span>
        <span className="text-gray-600">{valid ? count : '—'} × <span className="font-semibold text-gray-900">{valid ? formatCurrency(cuota, currency) : '—'}</span></span>
      </div>
    </div>
  )
}
