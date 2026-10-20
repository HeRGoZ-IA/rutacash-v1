import { Building2 } from 'lucide-react'
import { OfficeSelector } from '@/components/ui/OfficeSelector'
import { RouteSelector } from '@/components/ui/RouteSelector'
import type { Office, Route } from '@/models/types'

/**
 * BARRA DE FILTRO OFICINA → RUTA compartida por los módulos administrativos.
 *
 * Una sola pieza para que las pantallas se comporten igual: la Oficina estrecha las
 * rutas ofrecidas y el contexto activo queda siempre a la vista, también cuando se
 * llegó desde el panel de una Oficina.
 *
 * DISTRIBUCIÓN (Ronda 48 · H-06): antes cada control ocupaba una fila completa y la
 * tabla empezaba muy abajo. Ahora:
 *   · escritorio (lg): UNA fila — buscador (si lo hay) con más ancho, Oficina, Ruta y
 *     los filtros extra (`children`) con anchos acotados que no cortan los nombres;
 *   · tableta (md): buscador en su fila y el resto en tres columnas;
 *   · móvil (< 640 px): una columna, sin recortar «Todas las oficinas» ni nombres
 *     largos; desde 640 px, dos columnas.
 * Los filtros extra deben traer su propio ancho para escritorio (p. ej. un `Select`
 * con `containerClassName="lg:w-44"`).
 *
 * No decide permisos: recibe las Oficinas y rutas ya recortadas por
 * `useOfficeRouteFilter`, que a su vez parte del scoping central.
 */
export interface OfficeRouteFilterBarProps {
  offices: Office[]
  officeId: string
  onOfficeChange: (id: string) => void
  /** Rutas accesibles YA recortadas por la Oficina elegida. */
  routesInOffice: Route[]
  routeId: string
  onRouteChange: (id: string) => void
  hasUnassigned?: boolean
  /** true = elegir ruta es obligatorio (Liquidación). Por defecto ofrece "Todas". */
  requireRoute?: boolean
  /** Texto del contexto activo; se muestra solo si hay filtro de Oficina. */
  contextLabel?: string
  showContext?: boolean
  /** Buscador de la pantalla (Ronda 48): va primero y con más ancho. */
  search?: React.ReactNode
  /** Filtros adicionales de la pantalla (p. ej. Estado), en la misma fila. */
  children?: React.ReactNode
}

// Selector dentro de la barra: ancho de la celda en móvil/tableta; en escritorio
// crece entre 11 y 16 rem para que «Todas las oficinas» o un nombre largo no se corten.
const SELECTOR_BOX = 'min-w-0 lg:flex-1 lg:min-w-[11rem] lg:max-w-[16rem]'

export function OfficeRouteFilterBar({
  offices, officeId, onOfficeChange,
  routesInOffice, routeId, onRouteChange,
  hasUnassigned = false,
  requireRoute = false,
  contextLabel,
  showContext = false,
  search,
  children,
}: OfficeRouteFilterBarProps) {
  return (
    <div className="space-y-2" data-testid="office-route-filter-bar">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:flex lg:flex-wrap lg:items-end">
        {search && (
          <div className="sm:col-span-2 md:col-span-3 lg:flex-[2] lg:min-w-[16rem]">{search}</div>
        )}
        <OfficeSelector
          offices={offices}
          value={officeId}
          onChange={onOfficeChange}
          includeUnassigned={hasUnassigned}
          containerClassName={SELECTOR_BOX}
        />
        <RouteSelector
          routes={routesInOffice}
          value={routeId}
          onChange={onRouteChange}
          allowAll={!requireRoute}
          containerClassName={SELECTOR_BOX}
        />
        {children}
      </div>

      {/* Contexto activo: al llegar desde una Oficina el usuario debe ver de dónde
          viene el recorte, no encontrarse un listado corto sin explicación. */}
      {showContext && contextLabel && (
        <div className="flex items-center gap-2 text-xs text-primary-700 bg-primary-50 border border-primary-100 rounded-lg px-3 py-1.5 w-fit">
          <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{contextLabel}</span>
        </div>
      )}
    </div>
  )
}
