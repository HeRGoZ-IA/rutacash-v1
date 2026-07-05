/**
 * Días de pago como badges/chips (Ajuste parcelas/ventas/tooltip).
 * Reemplaza el texto corrido "Lun, Mar, Mié…" por chips coherentes con RutaCash.
 * Orden fijo: Lun, Mar, Mié, Jue, Vie, Sáb, Dom.
 */

// 0=domingo ... 6=sábado
const DAY_LABEL: Record<number, string> = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' }
const sortDays = (days: number[]) => [...days].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))

export function PaymentDaysBadges({ days, size = 'md' }: { days?: number[]; size?: 'sm' | 'md' }) {
  if (!days || days.length === 0) {
    return <span className="text-xs text-gray-500">Según frecuencia original</span>
  }
  const cls = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs'
  return (
    <div className="inline-flex flex-wrap gap-1.5 align-middle">
      {sortDays(days).map(d => (
        <span key={d} className={`inline-flex items-center rounded-full bg-primary-50 text-primary-700 border border-primary-100 font-medium ${cls}`}>
          {DAY_LABEL[d]}
        </span>
      ))}
    </div>
  )
}
