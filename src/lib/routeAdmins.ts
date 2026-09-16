// ============================================================
// ADMINISTRADORES DE UNA RUTA (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// MODELO: una empresa puede tener VARIOS Administradores, y una misma ruta puede
// tener MÁS DE UNO. Los Administradores son usuarios generales de la empresa: no
// pertenecen a ninguna Oficina y su acceso nace solo de `authorizedRouteIds`.
//
// FUENTE ÚNICA de la relación Admin ↔ Ruta: `User.authorizedRouteIds`. No existe
// `Route.adminId` ni `Route.adminIds`, y no deben crearse: la tarjeta de la ruta,
// el editor y el panel de Oficina resuelven todos desde aquí, así que no pueden
// contradecirse.
//
// POR QUÉ EXISTE ESTE MÓDULO (incidente de la advertencia falsa):
// La pantalla de rutas calculaba los Administradores "que quedan" mirando solo el
// BORRADOR de usuarios asignados. Ese borrador únicamente contiene usuarios que el
// actor puede gestionar, y un Administrador NO puede gestionar a otros
// Administradores (`MANAGEABLE_ROLES.admin` no incluye 'admin'). Resultado: al
// editar una ruta que SÍ tenía Administrador, el borrador salía vacío de admins y
// saltaba «Esta ruta ACTIVA quedará sin ningún Administrador responsable», aunque
// nadie hubiera tocado nada y el guardado no fuera a quitar a nadie.
//
// La corrección es calcular los administradores EFECTIVOS DESPUÉS DE GUARDAR, que
// es la única cifra con la que tiene sentido decidir la advertencia:
//
//     efectivos = (admins asignables que quedan marcados en el borrador)
//               ∪ (admins NO asignables que ya estaban y que el guardado no toca)
//
// El segundo conjunto es real, no una concesión: `computeRouteAssignmentDiff` solo
// retira usuarios dentro de `assignableUserIds`, así que un admin fuera del alcance
// del actor conserva su asignación pase lo que pase.
// ============================================================
import type { User } from '@/models/types'

/** Datos mínimos de un usuario para resolver los Administradores de una ruta. */
export type RouteAdminLike = Pick<User, 'id' | 'nombre' | 'rol' | 'status' | 'tenantId' | 'authorizedRouteIds' | 'routeId'>

/** Rutas de un usuario (incluye el `routeId` legado). Mismo criterio que permissions. */
function routesOf(u: RouteAdminLike): string[] {
  const ids = new Set(u.authorizedRouteIds ?? [])
  if (u.routeId) ids.add(u.routeId)
  return [...ids]
}

/**
 * Administradores ACTUALMENTE asignados a una ruta.
 *
 * Solo cuentan los ACTIVOS: un usuario inactivo no opera en ninguna parte del
 * sistema (`createRouteWithAdmins` rechaza administradores inactivos y el
 * invariante de cobradores exige responsable activo), así que tampoco puede
 * sostener la responsabilidad de una ruta. Un administrador inactivo no se
 * desasigna ni se toca: simplemente no se cuenta como responsable efectivo.
 */
export function routeAdmins(
  users: RouteAdminLike[],
  routeId: string,
  tenantId?: string,
): RouteAdminLike[] {
  return users.filter(u =>
    u.rol === 'admin' &&
    u.status === 'activo' &&
    (!tenantId || u.tenantId === tenantId) &&
    routesOf(u).includes(routeId),
  )
}

export interface EffectiveAdminsParams {
  routeId: string
  /** Usuarios de la empresa. */
  users: RouteAdminLike[]
  /** Ids que el actor PUEDE togglear en esta pantalla (alcance real del guardado). */
  assignableUserIds: string[]
  /** Borrador: usuarios marcados como asignados a la ruta. */
  draftAssignedUserIds: string[]
  tenantId?: string
}

/**
 * Administradores que tendrá la ruta DESPUÉS de guardar el borrador actual.
 *
 * Es la cifra con la que se decide cualquier advertencia de "ruta sin
 * Administrador": mirar solo el borrador da falsos positivos cuando el actor no
 * puede gestionar a los administradores que ya están asignados.
 */
export function effectiveAdminIdsAfterSave(params: EffectiveAdminsParams): string[] {
  const asignable = new Set(params.assignableUserIds)
  const marcados = new Set(params.draftAssignedUserIds)

  return params.users
    .filter(u =>
      u.rol === 'admin' &&
      u.status === 'activo' &&
      (!params.tenantId || u.tenantId === params.tenantId),
    )
    .filter(u => asignable.has(u.id)
      // Dentro del alcance del actor: decide el borrador.
      ? marcados.has(u.id)
      // Fuera de su alcance: el guardado no lo toca, así que sigue como está.
      : routesOf(u).includes(params.routeId))
    .map(u => u.id)
}

/**
 * ¿Debe pedirse confirmación por dejar una ruta ACTIVA sin ningún Administrador?
 *
 * Solo cuando el guardado REALMENTE quita al último: la ruta está activa, tenía
 * administradores efectivos y no le queda ninguno. Una ruta que ya estaba sin
 * Administrador no vuelve a preguntar (para eso está la advertencia ámbar
 * informativa del formulario, que no bloquea).
 */
export function shouldConfirmRouteWithoutAdmin(params: {
  routeStatus: string
  adminIdsBefore: string[]
  effectiveAdminIdsAfterSave: string[]
}): boolean {
  if (params.routeStatus !== 'activa') return false
  if (params.adminIdsBefore.length === 0) return false
  return params.effectiveAdminIdsAfterSave.length === 0
}

/** Etiqueta correcta para 0, 1 o varios Administradores (nunca singular en plural). */
export function routeAdminsLabel(nombres: string[]): string {
  if (nombres.length === 0) return 'Sin Administrador asignado'
  if (nombres.length === 1) return `Administrador: ${nombres[0]}`
  return `Administradores: ${nombres.join(', ')}`
}
