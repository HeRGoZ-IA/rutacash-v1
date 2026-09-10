// ============================================================
// SELECTOR DE RUTA COMPARTIDO (Liquidación semanal y Reportes)
// ------------------------------------------------------------
// FUENTE ÚNICA de la UI de selección de ruta para los módulos que filtran por
// ruta. Recibe SIEMPRE una lista YA RECORTADA por el scoping central
// (`filterAccessibleRoutes` / `useAccessibleRoutes`): este componente NO decide
// permisos, solo presenta. La guarda real (`canAccessRoute`) vive en la pantalla
// y en el servicio, de modo que un valor manipulado nunca llega al cálculo.
//
// `allowAll`:
//   · false (por defecto) → la selección es OBLIGATORIA (Liquidación semanal).
//   · true                → añade "Todas las rutas", que significa exactamente
//                           "todas las rutas PERMITIDAS al usuario" (Reportes).
//
// No sustituye a los selectores históricos de otros módulos (Caja, Gastos,
// Retiros…): se introduce aquí para no crear una tercera variante y queda
// disponible para unificarlos más adelante.
// ============================================================
import { Select } from '@/components/ui/Input'
import type { Route } from '@/models/types'

/** Valor que representa "Todas las rutas permitidas" cuando `allowAll` está activo. */
export const ALL_ROUTES = ''

export interface RouteSelectorProps {
  /** Rutas accesibles por el usuario (ya filtradas por el scoping central). */
  routes: Route[]
  /** Ruta seleccionada; `ALL_ROUTES` ('') = todas las permitidas. */
  value: string
  onChange: (routeId: string) => void
  /** Si true, ofrece "Todas las rutas". Si false, la selección es obligatoria. */
  allowAll?: boolean
  label?: string
  className?: string
  disabled?: boolean
}

export function RouteSelector({
  routes,
  value,
  onChange,
  allowAll = false,
  label = 'Ruta',
  className = 'w-56',
  disabled,
}: RouteSelectorProps) {
  const options = routes.map(r => ({
    value: r.id,
    label: r.codigo ? `${r.nombre} · ${r.codigo}` : r.nombre,
  }))

  return (
    <Select
      label={label}
      required={!allowAll}
      value={value}
      disabled={disabled || routes.length === 0}
      onChange={e => onChange(e.target.value)}
      options={allowAll ? [{ value: ALL_ROUTES, label: 'Todas las rutas' }, ...options] : options}
      // Sin `allowAll` el placeholder obliga a elegir explícitamente una ruta.
      placeholder={allowAll ? undefined : 'Selecciona una ruta'}
      className={className}
    />
  )
}

/**
 * Nombre legible de una ruta para encabezados y exportaciones.
 * Devuelve el `routeId` si la ruta no está en la lista accesible (nunca lanza).
 */
export function routeLabel(routes: Route[], routeId: string): string {
  const r = routes.find(x => x.id === routeId)
  return r ? r.nombre : routeId
}

/** Marcas diacríticas combinantes (se construye desde texto ASCII, sin literales invisibles). */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

/**
 * Fragmento seguro para nombres de archivo (CSV) a partir del código o nombre de
 * la ruta. `ALL_ROUTES` → 'todas-las-rutas'.
 */
export function routeFileTag(routes: Route[], routeId: string): string {
  if (!routeId) return 'todas-las-rutas'
  const r = routes.find(x => x.id === routeId)
  const raw = r?.codigo || r?.nombre || routeId
  return raw
    .normalize('NFD').replace(COMBINING_MARKS, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'ruta'
}
