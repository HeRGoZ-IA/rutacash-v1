// ============================================================
// COBRADORES EN RUTAS (PURO, sin dependencias de DB) — testeable.
// ------------------------------------------------------------
// REGLA FUNCIONAL VIGENTE (revisión del socio — creación libre de rutas):
//   · Una RUTA puede EXISTIR sin Administrador y sin Cobrador. La ausencia de
//     responsables NO la vuelve inválida: la deja "pendiente de asignación".
//   · El Cobrador responsable (`route.cobradorId`) es OPCIONAL. Si se indica uno,
//     debe ser coherente: cobrador ACTIVO del mismo tenant e incluido entre los
//     usuarios asignados. Esa coherencia es lo único que aún se valida.
//   · Lo que SÍ exige Cobrador es la OPERACIÓN DE COBRO, no la existencia de la
//     ruta (ver `ROUTE_NO_COBRADOR_OPERATION_MESSAGE`).
//
// Regla ANTERIOR, ya derogada: "toda ruta debe conservar al menos un Cobrador".
// Se eliminó conscientemente el bloqueo por 'no-cobrador'/'no-responsible' y el
// bloqueo de retiro del último cobrador.
//
// Estas funciones NO tocan Dexie: deciden (1) si una acción de RETIRO puede
// aplicarse al borrador en el instante del clic, (2) si el borrador es coherente
// antes de guardar (misma validación en UI y en el servicio) y (3) qué
// advertencias mostrar cuando la ruta nace sin responsables.
// ============================================================
import type { User } from '@/models/types'

/** Datos mínimos de un usuario necesarios para validar la coherencia (sin DB). */
export type CobradorLike = Pick<User, 'id' | 'rol' | 'status' | 'tenantId'>

export type CobradorRemovalBlock = 'responsible-needs-replacement' | null

/**
 * Decide, EN EL INSTANTE DEL CLIC, si se puede RETIRAR (del borrador) a un usuario:
 *  - No es cobrador → null (esta regla no aplica; el retiro sigue su curso normal).
 *  - Es el responsable y QUEDAN otros cobradores → 'responsible-needs-replacement'
 *    (no se adivina cuál de los demás pasa a responder por el dinero).
 *  - Es el ÚNICO cobrador asignado → null: la ruta queda SIN Cobrador, que es un
 *    estado válido ("pendiente de asignación"). Quien llama debe limpiar el
 *    responsable al aplicar el retiro.
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
  if (params.assignedCobradorIds.length <= 1) return null   // la ruta puede quedarse sin Cobrador
  if (params.userId === params.responsibleId) return 'responsible-needs-replacement'
  return null
}

export const COBRADOR_REMOVAL_MESSAGE: Record<Exclude<CobradorRemovalBlock, null>, string> = {
  'responsible-needs-replacement': 'Antes de retirar al Cobrador responsable debes seleccionar otro responsable para la ruta.',
}

export type CobradorInvariantError =
  | 'responsible-not-assigned'
  | 'responsible-invalid'

export const COBRADOR_INVARIANT_MESSAGE: Record<CobradorInvariantError, string> = {
  'responsible-not-assigned': 'El Cobrador responsable debe estar entre los usuarios asignados a la ruta.',
  'responsible-invalid': 'El Cobrador responsable debe ser un Cobrador activo de la misma empresa.',
}

export type CobradorInvariantResult =
  | { ok: true }
  | { ok: false; code: CobradorInvariantError; message: string }

/**
 * Valida que el BORRADOR de una ruta sea COHERENTE antes de guardar. Se usa tanto
 * en la UI (aviso de error con mensaje) como en el servicio (defensa/rollback).
 *
 * Ya NO exige responsables: sin cobradores asignados y sin responsable, el
 * resultado es `ok` (ruta pendiente de asignación). Solo cuando se DESIGNA un
 * responsable se comprueba que sea un cobrador activo del tenant y que esté
 * asignado a la ruta. NO corrige silenciosamente: solo informa el motivo.
 */
export function validateCobradorInvariant(params: {
  routeTenantId: string
  assignedUserIds: string[]
  cobradorId?: string
  userById: (id: string) => CobradorLike | undefined
}): CobradorInvariantResult {
  const fail = (code: CobradorInvariantError): CobradorInvariantResult => ({ ok: false, code, message: COBRADOR_INVARIANT_MESSAGE[code] })
  // Ruta sin Cobrador responsable: estado VÁLIDO (pendiente de asignación).
  if (!params.cobradorId) return { ok: true }
  if (!params.assignedUserIds.includes(params.cobradorId)) return fail('responsible-not-assigned')
  const resp = params.userById(params.cobradorId)
  if (!resp || resp.rol !== 'cobrador' || resp.status !== 'activo' || resp.tenantId !== params.routeTenantId) return fail('responsible-invalid')
  return { ok: true }
}

// ============================================================
// RUTA SIN RESPONSABLES — ADVERTENCIAS (nunca bloqueos)
// ============================================================

/** Etiqueta única para una ruta sin Cobrador responsable (listados, tarjetas, editor). */
export const ROUTE_NO_COBRADOR_LABEL = 'Sin Cobrador asignado'

/** Etiqueta única para una ruta sin Administrador responsable. */
export const ROUTE_NO_ADMIN_LABEL = 'Sin Administrador asignado'

/**
 * Motivo por el que una ruta SIN Cobrador no puede operar cobros. La ruta existe;
 * lo que falla —de forma controlada y comprensible— es la operación financiera.
 */
export const ROUTE_NO_COBRADOR_OPERATION_MESSAGE =
  'Esta ruta no tiene Cobrador asignado: no puede registrar cobros hasta que se le asigne uno.'

/** ¿La ruta tiene operación de cobro habilitada? (necesita Cobrador, no Administrador). */
export function routeCanOperateCollection(params: { assignedCobradorIds: string[]; cobradorId?: string }): boolean {
  return params.assignedCobradorIds.length > 0 || !!params.cobradorId
}

/**
 * Advertencias que se muestran al crear/guardar una ruta sin responsables.
 * Son INFORMATIVAS: nunca deshabilitan el botón ni impiden guardar. Si faltan
 * ambos responsables se devuelven las dos (advertencia combinada).
 */
export function routeAssignmentWarnings(params: {
  hasAdmin: boolean
  hasCobrador: boolean
  /** Oficina del borrador. `undefined` no se evalúa (pantallas que no la ofrecen). */
  hasOffice?: boolean
  mode?: 'create' | 'edit'
}): string[] {
  const verbo = params.mode === 'edit' ? 'quedará' : 'se creará'
  const out: string[] = []
  if (params.hasOffice === false) out.push(`Esta ruta ${verbo} sin Oficina asignada. Podrás asignarla posteriormente.`)
  if (!params.hasAdmin) out.push(`Esta ruta ${verbo} sin Administrador asignado. Podrás asignarlo posteriormente.`)
  if (!params.hasCobrador) out.push(`Esta ruta ${verbo} sin Cobrador asignado. No tendrá operación de cobro hasta que se asigne uno.`)
  return out
}
