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
 *
 * Ajuste fino (revisión KPIs): valor en `text-sm` para que montos grandes como
 * "$ 1.940.000" quepan en la columna de 1/3 en móvil sin desbordarse ni cortarse.
 * Altura reducida (h-16) y padding horizontal más ajustado (px-1.5) para dar un
 * poco más de ancho útil al número, manteniendo simetría entre las 3 tarjetas.
 */
export function KpiCard({ value, label, color = 'primary' }: KpiCardProps) {
  const s = STYLE[color]
  return (
    <div className={cn('rounded-2xl shadow-card border h-16 px-1.5 py-2 flex flex-col items-center', s.bg, s.border)}>
      <div className="flex-1 flex items-center justify-center min-h-0 w-full">
        <p className={cn('text-sm font-bold leading-none tabular-nums truncate max-w-full text-center', s.value)}>
          {value}
        </p>
      </div>
      <p className="text-[11px] font-medium text-gray-500 leading-tight text-center">{label}</p>
    </div>
  )
}
