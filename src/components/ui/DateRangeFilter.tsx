import { X } from 'lucide-react'

/**
 * Filtro de rango de fechas compacto (Ajustes post-Revisión 2).
 * Replica el estilo compacto usado en Reportes: una sola fila en desktop,
 * labels cortos "Desde"/"Hasta" y altura reducida. En mobile se apila con
 * `flex-wrap` pero sin ocupar campos full-width.
 *
 * `children` permite anteponer selects/inputs propios de cada vista (p. ej. la
 * ruta en Gastos) dentro de la misma fila compacta.
 */
export function DateRangeFilter({
  desde, hasta, onDesde, onHasta, onClear,
  desdeLabel = 'Desde', hastaLabel = 'Hasta', children,
}: {
  desde: string
  hasta: string
  onDesde: (v: string) => void
  onHasta: (v: string) => void
  onClear?: () => void
  desdeLabel?: string
  hastaLabel?: string
  children?: React.ReactNode
}) {
  const inputCls = 'h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'
  return (
    <div className="flex flex-wrap gap-3 items-end">
      {children}
      <div>
        <label className="block text-xs text-gray-500 mb-1">{desdeLabel}</label>
        <input type="date" value={desde} onChange={e => onDesde(e.target.value)} className={inputCls} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">{hastaLabel}</label>
        <input type="date" value={hasta} onChange={e => onHasta(e.target.value)} className={inputCls} />
      </div>
      {(desde || hasta) && onClear && (
        <button onClick={onClear} type="button"
          className="h-9 inline-flex items-center gap-1 px-2.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg">
          <X className="w-3.5 h-3.5" /> Limpiar
        </button>
      )}
    </div>
  )
}
