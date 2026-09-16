// ============================================================
// OFICINA COMO UNIDAD DE GESTIÓN (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// Todo lo que decide qué se ve dentro de una Oficina vive aquí, en funciones
// puras que reciben rutas YA RECORTADAS por el scoping central.
//
// LA REGLA QUE ESTE MÓDULO PROTEGE:
//   Entrar a una Oficina NO concede ninguna ruta. Los indicadores, las alertas y
//   los usuarios relacionados se calculan SIEMPRE sobre `accessibleOfficeRoutes`
//   (rutas de la Oficina que el usuario ya tenía autorizadas), nunca sobre todas
//   las rutas de la Oficina.
//
// La única excepción es el CONTEO ESTRUCTURAL "3 de 5 rutas visibles", que existe
// precisamente para no aparentar que un consolidado parcial es el total. Ese total
// es un número; no da acceso a los datos de las rutas que faltan.
// ============================================================
import type { Office, Route, User, UserRole } from '@/models/types'
import { authorizedRouteIdsOf } from '@/lib/permissions'
import { officeCoverage, type OfficeCoverage } from '@/lib/officeGrouping'

/** Rutas de la Oficina indicada dentro de un conjunto YA accesible. */
export function officeRoutesOf<T extends { officeId?: string }>(accessibleRoutes: T[], officeId: string): T[] {
  return accessibleRoutes.filter(r => r.officeId === officeId)
}

/** Rutas sin Oficina dentro de un conjunto YA accesible. */
export function unassignedRoutesOf<T extends { officeId?: string }>(accessibleRoutes: T[]): T[] {
  return accessibleRoutes.filter(r => !r.officeId)
}

// ------------------------------------------------------------
// Estado operativo de una ruta (DERIVADO, nunca persistido)
// ------------------------------------------------------------
export type RouteOperationalState = 'operativa' | 'sin-cobrador' | 'inactiva'

/**
 * Estado operativo de una ruta a partir de datos que YA existen. No se inventa
 * ningún estado comercial nuevo ni se persiste nada:
 *   · `inactiva`      → `Route.status !== 'activa'` (regla existente).
 *   · `sin-cobrador`  → sin cobradores asignados ni responsable (regla de RQ-01).
 *   · `operativa`     → el resto.
 * La ruta inactiva tiene prioridad: es el impedimento más fuerte.
 */
export function routeOperationalState(params: {
  status: Route['status']
  assignedCobradorIds: string[]
  cobradorId?: string
}): RouteOperationalState {
  if (params.status !== 'activa') return 'inactiva'
  if (params.assignedCobradorIds.length === 0 && !params.cobradorId) return 'sin-cobrador'
  return 'operativa'
}

export const ROUTE_STATE_LABEL: Record<RouteOperationalState, string> = {
  operativa: 'Operativa',
  'sin-cobrador': 'Sin Cobrador asignado',
  inactiva: 'Inactiva',
}

// ------------------------------------------------------------
// Indicadores de la Oficina
// ------------------------------------------------------------
export interface OfficeRouteFacts {
  routeId: string
  nombre: string
  state: RouteOperationalState
  clientesActivos: number
  ventasActivas: number
  desembolsosPendientes: number
  carteraEnCalle: number
}

export interface OfficeKpis {
  rutasVisibles: number
  rutasOperativas: number
  rutasSinCobrador: number
  rutasInactivas: number
  clientesActivos: number
  ventasActivas: number
  desembolsosPendientes: number
  carteraEnCalle: number
}

/**
 * Indicadores de la Oficina. Se agregan EXCLUSIVAMENTE los hechos de las rutas
 * accesibles que se le pasen: esta función no puede ver ninguna otra ruta, que es
 * justamente la garantía que se quiere.
 */
export function officeKpis(facts: OfficeRouteFacts[]): OfficeKpis {
  return {
    rutasVisibles: facts.length,
    rutasOperativas: facts.filter(f => f.state === 'operativa').length,
    rutasSinCobrador: facts.filter(f => f.state === 'sin-cobrador').length,
    rutasInactivas: facts.filter(f => f.state === 'inactiva').length,
    clientesActivos: facts.reduce((n, f) => n + f.clientesActivos, 0),
    ventasActivas: facts.reduce((n, f) => n + f.ventasActivas, 0),
    desembolsosPendientes: facts.reduce((n, f) => n + f.desembolsosPendientes, 0),
    carteraEnCalle: facts.reduce((n, f) => n + f.carteraEnCalle, 0),
  }
}

/** Resumen legible del estado operativo: "5 rutas · 4 operativas · 1 sin Cobrador". */
export function officeStateSummary(k: OfficeKpis): string {
  const partes = [`${k.rutasVisibles} ruta(s)`]
  if (k.rutasOperativas > 0) partes.push(`${k.rutasOperativas} operativa(s)`)
  if (k.rutasSinCobrador > 0) partes.push(`${k.rutasSinCobrador} sin Cobrador`)
  if (k.rutasInactivas > 0) partes.push(`${k.rutasInactivas} inactiva(s)`)
  return partes.join(' · ')
}

// ------------------------------------------------------------
// Alcance: nunca aparentar que un consolidado parcial es el total
// ------------------------------------------------------------
export interface OfficeScope extends OfficeCoverage {
  /** Texto para la cabecera. Vacío de adorno cuando la cobertura es completa. */
  label: string
}

/**
 * Alcance del usuario sobre la Oficina.
 *
 * `totales` es un CONTEO ESTRUCTURAL (cuántas rutas tiene la Oficina en la
 * empresa). Saber que existen 5 rutas no da acceso a ninguna: los datos siguen
 * calculándose solo sobre las visibles. Cuando la cobertura es completa no se
 * añade ninguna coletilla.
 */
export function officeScope(visibles: number, totales: number): OfficeScope {
  const cov = officeCoverage(visibles, totales)
  return {
    ...cov,
    label: cov.parcial
      ? `${visibles} de ${totales} rutas visibles — rutas autorizadas`
      : `${visibles} ruta(s) visible(s)`,
  }
}

// ------------------------------------------------------------
// Usuarios RELACIONADOS (no "usuarios de la Oficina")
// ------------------------------------------------------------
export interface RelatedUser {
  id: string
  nombre: string
  rol: UserRole
  /** Rutas que el usuario tiene DENTRO de esta Oficina (nunca las de otras). */
  routes: { id: string; nombre: string }[]
}

/**
 * Usuarios con rutas asignadas EN ESTA OFICINA.
 *
 * No existen "usuarios de la Oficina": los usuarios son generales de la empresa.
 * La relación se DERIVA de `authorizedRouteIds ∩ rutas de la Oficina`. Si alguien
 * también trabaja en otra Oficina, aquí se muestran solo sus rutas de esta — no se
 * le oculta, simplemente no se mezclan alcances.
 *
 * El Super Admin no se lista: su acceso es global y no representa una asignación.
 */
export function relatedUsersOfOffice(
  users: User[],
  officeRoutes: Pick<Route, 'id' | 'nombre'>[],
  tenantId?: string,
): RelatedUser[] {
  const routeById = new Map(officeRoutes.map(r => [r.id, r.nombre]))
  const out: RelatedUser[] = []

  for (const u of users) {
    if (u.rol === 'superadmin') continue
    if (tenantId && u.tenantId !== tenantId) continue
    const suyas = authorizedRouteIdsOf(u).filter(id => routeById.has(id))
    if (suyas.length === 0) continue
    out.push({
      id: u.id,
      nombre: u.nombre,
      rol: u.rol,
      routes: suyas
        .map(id => ({ id, nombre: routeById.get(id)! }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    })
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre))
}

/**
 * Nueva lista de rutas autorizadas tras editar las asignaciones DESDE una Oficina.
 *
 * REGLA CRÍTICA: solo se tocan las rutas de ESTA Oficina. Las rutas del usuario en
 * otras Oficinas —y las que tenga Sin Oficina— se conservan intactas. Editar las
 * asignaciones de Leticia jamás puede hacerle perder su ruta de Río.
 *
 * @param current       `authorizedRouteIds` actuales del usuario.
 * @param officeRouteIds Rutas de la Oficina sobre las que se está decidiendo.
 * @param selected      Rutas de esa Oficina que quedan marcadas.
 */
export function applyOfficeRouteSelection(
  current: string[],
  officeRouteIds: string[],
  selected: string[],
): string[] {
  const enEstaOficina = new Set(officeRouteIds)
  const elegidas = new Set(selected.filter(id => enEstaOficina.has(id)))
  // Se conserva TODO lo que no pertenece a esta Oficina, en su orden original.
  const fuera = current.filter(id => !enEstaOficina.has(id))
  return [...fuera, ...officeRouteIds.filter(id => elegidas.has(id))]
}

// ------------------------------------------------------------
// Alertas DERIVADAS (sin persistencia nueva)
// ------------------------------------------------------------
export type OfficeAlertKind = 'sin-cobrador' | 'ruta-inactiva' | 'desembolsos-pendientes' | 'oficina-inactiva'

export interface OfficeAlert {
  kind: OfficeAlertKind
  severity: 'warning' | 'error'
  /** Ruta implicada, si la alerta es de una ruta concreta. */
  routeId?: string
  mensaje: string
}

/**
 * Alertas de la Oficina, derivadas de datos que ya existen. No hay tabla de
 * alertas ni estado nuevo: se recalculan al abrir la pantalla.
 */
export function officeAlerts(params: {
  office: Pick<Office, 'nombre' | 'status'>
  facts: OfficeRouteFacts[]
}): OfficeAlert[] {
  const out: OfficeAlert[] = []

  if (params.office.status === 'inactiva') {
    out.push({
      kind: 'oficina-inactiva',
      severity: 'error',
      mensaje: `${params.office.nombre} está inactiva: sus rutas no admiten operaciones nuevas. La consulta histórica sigue disponible.`,
    })
  }
  for (const f of params.facts) {
    if (f.state === 'sin-cobrador') {
      out.push({ kind: 'sin-cobrador', severity: 'warning', routeId: f.routeId, mensaje: `${f.nombre} — Sin Cobrador asignado` })
    }
    if (f.state === 'inactiva') {
      out.push({ kind: 'ruta-inactiva', severity: 'warning', routeId: f.routeId, mensaje: `${f.nombre} — Ruta inactiva` })
    }
    if (f.desembolsosPendientes > 0) {
      out.push({
        kind: 'desembolsos-pendientes', severity: 'warning', routeId: f.routeId,
        mensaje: `${f.nombre} — ${f.desembolsosPendientes} desembolso(s) pendiente(s)`,
      })
    }
  }
  return out
}
