// ============================================================
// FILTRO TRANSVERSAL OFICINA → RUTA (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// Patrón único que usan TODOS los módulos administrativos:
//
//     Oficina seleccionada
//       ↓ rutas YA autorizadas del usuario
//       ↓ filtradas por officeId
//       ↓ ruta seleccionada (opcional)
//       ↓ datos
//
// La Oficina SIEMPRE estrecha el alcance; nunca lo amplía. Todas las funciones de
// aquí parten de `accessibleRoutes` —el resultado de `filterAccessibleRoutes`— así
// que es imposible que un filtro devuelva una ruta que el usuario no tuviera ya.
//
// "Todas las oficinas" NO significa todas las rutas de la empresa: significa todas
// las rutas AUTORIZADAS del usuario (para el Super Admin, que no está limitado por
// rutas, eso coincide con todas las del tenant).
// ============================================================
import type { Office, Route } from '@/models/types'
import { ALL_OFFICES, NO_OFFICE, NO_OFFICE_LABEL, filterRoutesByOffice } from '@/lib/officeGrouping'

/** Valor de `routeId` que representa "todas las rutas del filtro actual". */
export const ALL_ROUTES_IN_FILTER = ''

/**
 * Resuelve el `officeId` que llega por la URL.
 *
 * DEGRADACIÓN SEGURA: un id que no pertenezca al catálogo de la empresa (otra
 * empresa, un id inventado, una Oficina borrada) se IGNORA y se cae a "todas las
 * oficinas". Nunca se amplía el alcance: aunque se aceptara, el filtro se aplica
 * sobre rutas ya autorizadas y no podría revelar ninguna ajena.
 *
 * `NO_OFFICE` se acepta siempre: es una agrupación derivada, no un registro.
 */
export function resolveOfficeParam(raw: string | null | undefined, tenantOffices: Office[]): string {
  if (!raw) return ALL_OFFICES
  if (raw === NO_OFFICE) return NO_OFFICE
  return tenantOffices.some(o => o.id === raw) ? raw : ALL_OFFICES
}

/** Rutas accesibles que quedan dentro del filtro de Oficina. */
export function routesInOfficeFilter(accessibleRoutes: Route[], officeId: string): Route[] {
  return filterRoutesByOffice(accessibleRoutes, officeId)
}

/**
 * Conjunto FINAL de rutas visibles: alcance del usuario ∩ Oficina ∩ ruta elegida.
 *
 * Una `routeId` que no esté dentro del filtro produce un conjunto VACÍO, nunca un
 * acceso: es la misma disciplina que `resolveReportRouteIds`.
 */
export function visibleRouteIds(params: {
  accessibleRoutes: Route[]
  officeId: string
  routeId?: string
}): Set<string> {
  const enOficina = routesInOfficeFilter(params.accessibleRoutes, params.officeId)
  if (!params.routeId) return new Set(enOficina.map(r => r.id))
  return new Set(enOficina.filter(r => r.id === params.routeId).map(r => r.id))
}

/** Recorta cualquier fila con `routeId` al conjunto visible. */
export function filterRowsByVisibleRoutes<T extends { routeId: string }>(rows: T[], visibles: Set<string>): T[] {
  return rows.filter(r => visibles.has(r.routeId))
}

/**
 * ¿La ruta seleccionada sigue perteneciendo al filtro de Oficina?
 * Si no, quien llama debe LIMPIARLA: dejarla activa pero invisible produciría
 * listados vacíos sin explicación y botones apuntando a una ruta fantasma.
 */
export function routeStillInFilter(accessibleRoutes: Route[], officeId: string, routeId: string): boolean {
  if (!routeId) return true
  return routesInOfficeFilter(accessibleRoutes, officeId).some(r => r.id === routeId)
}

// ------------------------------------------------------------
// Etiquetas (una sola fuente de texto para toda la app)
// ------------------------------------------------------------

/** Nombre de la Oficina de una ruta. Nunca lanza; "Sin Oficina" si no tiene. */
export function officeLabelOf(route: Pick<Route, 'officeId'> | undefined, officeById: Map<string, Office>): string {
  if (!route?.officeId) return NO_OFFICE_LABEL
  return officeById.get(route.officeId)?.nombre ?? route.officeId
}

/** "Leticia / Ruta Centro" — contexto completo de una fila en un listado. */
export function routeOfficeLabel(
  routeId: string | undefined,
  routeById: Map<string, Route>,
  officeById: Map<string, Office>,
): string {
  const route = routeId ? routeById.get(routeId) : undefined
  if (!route) return routeId ?? '—'
  return `${officeLabelOf(route, officeById)} / ${route.nombre}`
}

/** Texto del contexto activo: "Oficina: Leticia · Todas las rutas autorizadas". */
export function filterContextLabel(params: {
  officeId: string
  officeById: Map<string, Office>
  routeId?: string
  routeById: Map<string, Route>
}): string {
  const oficina = params.officeId === ALL_OFFICES
    ? 'Todas las oficinas'
    : params.officeId === NO_OFFICE
      ? NO_OFFICE_LABEL
      : (params.officeById.get(params.officeId)?.nombre ?? params.officeId)
  const ruta = params.routeId
    ? (params.routeById.get(params.routeId)?.nombre ?? params.routeId)
    : 'Todas las rutas autorizadas'
  return `Oficina: ${oficina} · ${ruta}`
}

/** Índices en memoria: evita una consulta por fila (N+1) en los listados. */
export function buildLookups(routes: Route[], offices: Office[]) {
  return {
    routeById: new Map(routes.map(r => [r.id, r])),
    officeById: new Map(offices.map(o => [o.id, o])),
  }
}
