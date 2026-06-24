import { Input } from './Input'
import { formatCurrencyInput, parseCurrencyInput, getCurrencySymbol } from '@/lib/formatters'

interface MoneyInputProps {
  /** Valor numérico real (lo que se guarda en el modelo). 0 = vacío. */
  value: number
  /** Devuelve siempre un número (0 cuando el campo queda vacío). */
  onValueChange: (value: number) => void
  /** Código de moneda principal configurada (COP, USD, ...). */
  currency?: string
  label?: string
  required?: boolean
  hint?: string
  error?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  autoFocus?: boolean
  min?: number
}

/**
 * Input de dinero con formato moneda.
 * - Muestra separadores de miles y el símbolo de la moneda configurada.
 * - Internamente trabaja con NÚMEROS enteros; nunca guarda strings en el modelo.
 * - Permite dejar el campo vacío temporalmente (value 0 → input vacío).
 */
export function MoneyInput({
  value, onValueChange, currency = 'COP', placeholder = '0', ...rest
}: MoneyInputProps) {
  const symbol = getCurrencySymbol(currency)
  const display = formatCurrencyInput(value, currency)

  return (
    <Input
      {...rest}
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      value={display}
      onChange={e => onValueChange(parseCurrencyInput(e.target.value))}
      leftIcon={<span className="text-xs font-semibold text-gray-500">{symbol}</span>}
    />
  )
}
