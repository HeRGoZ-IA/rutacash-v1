import { cn } from '@/lib/utils'

type KpiColor = 'amber' | 'emerald' | 'primary'

// Tono fuerte para el valor + fondo/borde tenues por color semántico.
const STYLE: Record<KpiColor, { value: string; bg: string; border: string }> = {
  amber: { value: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-100' },
  emerald: { value: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
  primary: { value: 'text-primary-600', bg: 'bg-primary-50', border: 'border-primary-100' },
}

interface KpiCardProps {
  value: string | number
  label: string
  color?: KpiColor
}

/**
 * Tarjeta KPI uniforme (App Cobrador).
 * Estructura idéntica en los 3: mismo ancho/alto/padding/alineación.
 * El valor queda centrado (área flexible) y la etiqueta anclada cerca del fondo.
 */
export function KpiCard({ value, label, color = 'primary' }: KpiCardProps) {
  const s = STYLE[color]
  return (
    <div className={cn('rounded-2xl shadow-card border h-20 px-2 py-2 flex flex-col items-center', s.bg, s.border)}>
      <div className="flex-1 flex items-center justify-center min-h-0">
        <p className={cn('text-2xl font-bold leading-none tabular-nums truncate max-w-full', s.value)}>
          {value}
        </p>
      </div>
      <p className="text-[12px] font-medium text-gray-500 leading-tight text-center">{label}</p>
    </div>
  )
}
