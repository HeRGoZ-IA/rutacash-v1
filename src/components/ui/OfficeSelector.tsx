// ============================================================
// SELECTOR DE OFICINA COMPARTIDO (Reportes, Liquidación, Caja…)
// ------------------------------------------------------------
// Espejo de `RouteSelector`, con la misma disciplina: recibe SIEMPRE Oficinas ya
// derivadas de las rutas accesibles (`useAccessibleOffices`) y NO decide permisos.
// Elegir una Oficina solo ESTRECHA el conjunto de rutas ya permitidas; jamás lo
// amplía. La guarda real sigue viviendo en el scoping por ruta y en los servicios.
// ============================================================
import { Select } from '@/components/ui/Input'
import { ALL_OFFICES, NO_OFFICE, NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import type { Office } from '@/models/types'

export { ALL_OFFICES, NO_OFFICE }

export interface OfficeSelectorProps {
  /** Oficinas visibles (derivadas de las rutas accesibles). */
  offices: Office[]
  /** `ALL_OFFICES` ('') = todas; `NO_OFFICE` = rutas sin Oficina; o un id. */
  value: string
  onChange: (officeId: string) => void
  /** Ofrecer el grupo "Sin Oficina" (solo si el usuario tiene rutas así). */
  includeUnassigned?: boolean
  label?: string
  className?: string
  disabled?: boolean
}

export function OfficeSelector({
  offices,
  value,
  onChange,
  includeUnassigned = false,
  label = 'Oficina',
  className = 'w-56',
  disabled,
}: OfficeSelectorProps) {
  const options = [
    { value: ALL_OFFICES, label: 'Todas las oficinas' },
    ...offices
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map(o => ({
        value: o.id,
        label: o.status === 'inactiva'
          ? `${o.nombre} (inactiva)`
          : (o.codigo ? `${o.nombre} · ${o.codigo}` : o.nombre),
      })),
    ...(includeUnassigned ? [{ value: NO_OFFICE, label: NO_OFFICE_LABEL }] : []),
  ]

  return (
    <Select
      label={label}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      options={options}
      className={className}
    />
  )
}

/** Fragmento seguro para nombres de archivo (CSV) a partir de la Oficina elegida. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

export function officeFileTag(offices: Office[], officeId: string): string {
  if (officeId === ALL_OFFICES) return 'todas-las-oficinas'
  if (officeId === NO_OFFICE) return 'sin-oficina'
  const o = offices.find(x => x.id === officeId)
  const raw = o?.codigo || o?.nombre || officeId
  return raw
    .normalize('NFD').replace(COMBINING_MARKS, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'oficina'
}
