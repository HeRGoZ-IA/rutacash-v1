// ============================================================
// AGRUPACIÓN POR OFICINA (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// LA REGLA QUE ESTE MÓDULO EXISTE PARA PROTEGER:
//
//     accessibleOffices  =  Oficinas presentes en accessibleRoutes
//
// y NUNCA a la inversa. Ninguna función de aquí recibe una Oficina y devuelve sus
// rutas: todas reciben rutas YA RECORTADAS por el scoping central
// (`filterAccessibleRoutes` / `useAccessibleRoutes`) y solo las agrupan o filtran.
// Así es imposible que pertenecer a una Oficina amplíe el acceso: la Oficina solo
// puede ESTRECHAR un conjunto que ya estaba permitido.
// ============================================================
import type { Office, Route } from '@/models/types'

/** Valor del selector para "Todas las oficinas" (no filtra). */
export const ALL_OFFICES = ''

/**
 * Valor del selector para "Sin Oficina". No puede ser '' (eso es "todas") ni
 * `undefined` (no viaja por un <select>), así que se usa un centinela explícito
 * que jamás puede coincidir con un id real.
 */
export const NO_OFFICE = '__sin_oficina__'

/** Etiqueta única para las rutas que no pertenecen a ninguna Oficina. */
export const NO_OFFICE_LABEL = 'Sin Oficina'

/**
 * Oficinas visibles para el usuario: las que aparecen en SUS rutas accesibles.
 * DERIVADO — nunca se consulta la tabla de oficinas para construir esto.
 */
export function accessibleOfficeIdsOf(accessibleRoutes: Pick<Route, 'officeId'>[]): Set<string> {
  const ids = new Set<string>()
  for (const r of accessibleRoutes) if (r.officeId) ids.add(r.officeId)
  return ids
}

/** ¿Alguna de las rutas accesibles está Sin Oficina? (para ofrecer ese grupo). */
export function hasRoutesWithoutOffice(accessibleRoutes: Pick<Route, 'officeId'>[]): boolean {
  return accessibleRoutes.some(r => !r.officeId)
}

/**
 * Recorta rutas por la Oficina elegida. `ALL_OFFICES` no filtra; `NO_OFFICE` deja
 * solo las que no tienen Oficina. Opera SIEMPRE sobre lo ya accesible.
 */
export function filterRoutesByOffice<T extends { officeId?: string }>(routes: T[], selected: string): T[] {
  if (selected === ALL_OFFICES) return routes
  if (selected === NO_OFFICE) return routes.filter(r => !r.officeId)
  return routes.filter(r => r.officeId === selected)
}

/** Igual que `filterRoutesByOffice`, pero devolviendo el conjunto de ids resultante. */
export function narrowRouteIdsByOffice(
  routeIds: Set<string>,
  routes: Pick<Route, 'id' | 'officeId'>[],
  selected: string,
): Set<string> {
  if (selected === ALL_OFFICES) return new Set(routeIds)
  const permitidas = filterRoutesByOffice(routes.filter(r => routeIds.has(r.id)), selected)
  return new Set(permitidas.map(r => r.id))
}

export interface OfficeGroup {
  /** `null` = grupo "Sin Oficina". */
  office: Office | null
  /** Clave estable para listas de React y para el selector. */
  key: string
  label: string
  routes: Route[]
}

/**
 * Agrupa rutas ACCESIBLES por Oficina, en orden alfabético, con "Sin Oficina"
 * siempre al final. Solo aparecen las Oficinas que tienen alguna ruta accesible:
 * una Oficina de la que el usuario no ve ninguna ruta no debe insinuarse siquiera.
 *
 * Una Oficina referenciada por una ruta pero ausente de `offices` (dato
 * inconsistente) se representa igualmente, con su id como etiqueta, en vez de
 * hacer desaparecer la ruta del listado.
 */
export function groupRoutesByOffice(routes: Route[], offices: Office[]): OfficeGroup[] {
  const officeById = new Map(offices.map(o => [o.id, o]))
  const conOficina = new Map<string, Route[]>()
  const sinOficina: Route[] = []

  for (const r of routes) {
    if (!r.officeId) { sinOficina.push(r); continue }
    const lista = conOficina.get(r.officeId) ?? []
    lista.push(r)
    conOficina.set(r.officeId, lista)
  }

  const ordenarRutas = (list: Route[]) => [...list].sort((a, b) => a.nombre.localeCompare(b.nombre))

  const grupos: OfficeGroup[] = [...conOficina.entries()]
    .map(([id, list]) => {
      const office = officeById.get(id) ?? null
      return {
        office,
        key: id,
        label: office?.nombre ?? id,
        routes: ordenarRutas(list),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  if (sinOficina.length > 0) {
    grupos.push({ office: null, key: NO_OFFICE, label: NO_OFFICE_LABEL, routes: ordenarRutas(sinOficina) })
  }
  return grupos
}

/**
 * Cobertura del usuario sobre una Oficina: cuántas de sus rutas ve realmente.
 * Sirve para NO presentar como total un consolidado que es parcial.
 */
export interface OfficeCoverage {
  visibles: number
  totales: number
  parcial: boolean
}

export function officeCoverage(visibles: number, totales: number): OfficeCoverage {
  return { visibles, totales, parcial: totales > visibles }
}

/**
 * Rótulo honesto de un consolidado por Oficina. Si el usuario solo ve parte de las
 * rutas, el texto lo dice; nunca se presenta una cifra parcial como si fuera el
 * total de la Oficina.
 */
export function officeScopeLabel(nombre: string, coverage: OfficeCoverage): string {
  if (!coverage.parcial) return nombre
  return `${nombre} — ${coverage.visibles} de ${coverage.totales} rutas (rutas autorizadas)`
}

/** Nombre de Oficina de una ruta, para etiquetas y exportaciones. Nunca lanza. */
export function officeLabelForRoute(
  route: Pick<Route, 'officeId'> | undefined,
  offices: Office[],
): string {
  if (!route?.officeId) return NO_OFFICE_LABEL
  return offices.find(o => o.id === route.officeId)?.nombre ?? route.officeId
}

/** Mapa `routeId → nombre de Oficina`, para listados y CSV sin duplicar datos. */
export function officeNameByRouteId(routes: Route[], offices: Office[]): Map<string, string> {
  const officeById = new Map(offices.map(o => [o.id, o.nombre]))
  return new Map(routes.map(r => [
    r.id,
    r.officeId ? (officeById.get(r.officeId) ?? r.officeId) : NO_OFFICE_LABEL,
  ]))
}
