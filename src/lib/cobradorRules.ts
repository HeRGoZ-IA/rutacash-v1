// ============================================================
// INTEGRIDAD DE COBRADORES EN RUTAS (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// Invariante del modelo: TODA ruta debe conservar al menos un Cobrador asignado y
// tener EXACTAMENTE un Cobrador responsable (route.cobradorId), que debe ser un
// cobrador ACTIVO del mismo tenant e incluido entre los usuarios asignados.
//
// Estas funciones NO tocan Dexie: deciden (1) si una acción de RETIRO puede
// aplicarse al borrador en el instante del clic, y (2) si el borrador cumple el
// invariante antes de guardar (misma validación en UI y en el servicio).
// ============================================================
import type { User } from '@/models/types'

/** Datos mínimos de un usuario necesarios para validar el invariante (sin DB). */
export type CobradorLike = Pick<User, 'id' | 'rol' | 'status' | 'tenantId'>

export type CobradorRemovalBlock = 'last-cobrador' | 'responsible-needs-replacement' | null

/**
 * Decide, EN EL INSTANTE DEL CLIC, si se puede RETIRAR (del borrador) a un usuario:
 *  - No es cobrador → null (esta regla no aplica; el retiro sigue su curso normal).
 *  - Es el ÚNICO cobrador asignado → 'last-cobrador' (bloqueado, no modificar borrador).
 *  - Es el responsable y hay otros cobradores → 'responsible-needs-replacement'.
 *  - Cualquier otro cobrador → null (retiro permitido).
 * `assignedCobradorIds` debe incluir al propio usuario que se intenta retirar.
 */
export function cobradorRemovalBlock(params: {
  isCobrador: boolean
  assignedCobradorIds: string[]
  responsibleId?: string
  userId: string
}): CobradorRemovalBlock {
  if (!params.isCobrador) return null
  if (params.assignedCobradorIds.length <= 1) return 'last-cobrador'
  if (params.userId === params.responsibleId) return 'responsible-needs-replacement'
  return null
}

export const COBRADOR_REMOVAL_MESSAGE: Record<Exclude<CobradorRemovalBlock, null>, string> = {
  'last-cobrador': 'La ruta debe conservar al menos un Cobrador asignado. Asigna otro Cobrador antes de retirar al actual.',
  'responsible-needs-replacement': 'Antes de retirar al Cobrador responsable debes seleccionar otro responsable para la ruta.',
}

export type CobradorInvariantError =
  | 'no-cobrador'
  | 'no-responsible'
  | 'responsible-not-assigned'
  | 'responsible-invalid'

export const COBRADOR_INVARIANT_MESSAGE: Record<CobradorInvariantError, string> = {
  'no-cobrador': 'La ruta debe conservar al menos un Cobrador asignado.',
  'no-responsible': 'La ruta debe tener un Cobrador responsable. Selecciónalo antes de guardar.',
  'responsible-not-assigned': 'El Cobrador responsable debe estar entre los usuarios asignados a la ruta.',
  'responsible-invalid': 'El Cobrador responsable debe ser un Cobrador activo de la misma empresa.',
}

export type CobradorInvariantResult =
  | { ok: true }
  | { ok: false; code: CobradorInvariantError; message: string }

/**
 * Valida que el BORRADOR de una ruta cumpla el invariante antes de guardar. Se usa
 * tanto en la UI (bloqueo con mensaje) como en el servicio (defensa/rollback). NO
 * corrige silenciosamente: solo informa el motivo del rechazo.
 */
export function validateCobradorInvariant(params: {
  routeTenantId: string
  assignedUserIds: string[]
  cobradorId?: string
  userById: (id: string) => CobradorLike | undefined
}): CobradorInvariantResult {
  const fail = (code: CobradorInvariantError): CobradorInvariantResult => ({ ok: false, code, message: COBRADOR_INVARIANT_MESSAGE[code] })
  const cobradores = params.assignedUserIds.filter(id => params.userById(id)?.rol === 'cobrador')
  if (cobradores.length === 0) return fail('no-cobrador')
  if (!params.cobradorId) return fail('no-responsible')
  if (!params.assignedUserIds.includes(params.cobradorId)) return fail('responsible-not-assigned')
  const resp = params.userById(params.cobradorId)
  if (!resp || resp.rol !== 'cobrador' || resp.status !== 'activo' || resp.tenantId !== params.routeTenantId) return fail('responsible-invalid')
  return { ok: true }
}
