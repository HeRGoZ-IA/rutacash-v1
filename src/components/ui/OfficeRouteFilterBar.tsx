import { Building2 } from 'lucide-react'
import { OfficeSelector } from '@/components/ui/OfficeSelector'
import { RouteSelector } from '@/components/ui/RouteSelector'
import type { Office, Route } from '@/models/types'

/**
 * BARRA DE FILTRO OFICINA → RUTA compartida por los módulos administrativos.
 *
 * Una sola pieza para que las ocho pantallas se comporten igual: la Oficina
 * estrecha las rutas ofrecidas y el contexto activo queda siempre a la vista,
 * también cuando se llegó desde el panel de una Oficina.
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
  children?: React.ReactNode
}

export function OfficeRouteFilterBar({
  offices, officeId, onOfficeChange,
  routesInOffice, routeId, onRouteChange,
  hasUnassigned = false,
  requireRoute = false,
  contextLabel,
  showContext = false,
  children,
}: OfficeRouteFilterBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <OfficeSelector
          offices={offices}
          value={officeId}
          onChange={onOfficeChange}
          includeUnassigned={hasUnassigned}
          className="w-52"
        />
        <RouteSelector
          routes={routesInOffice}
          value={routeId}
          onChange={onRouteChange}
          allowAll={!requireRoute}
          className="w-52"
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
