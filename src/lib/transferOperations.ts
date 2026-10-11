// ============================================================
// TRANSFERENCIAS UNIFICADAS — CATÁLOGO Y VISTA PREVIA (PURO, Ronda 4/6)
// ------------------------------------------------------------
// Capa de PRESENTACIÓN: identifica la operación y arma su vista previa con los
// saldos que entregan los servicios. No escribe, no decide permisos (los decide
// el servicio de cada operación) y no recalcula fórmulas financieras.
//
// Operaciones (todas EXISTENTES; cada una delega en su servicio):
//   entregar-base  caja sin asignar de la ruta → trabajador   assignBaseToWorker
//   devolver-base  trabajador → caja sin asignar de la ruta   returnBaseFromWorker
//   ruta-ruta      ruta → ruta (mismo responsable de capital) registerTransfer
//   colocar        bolsa del Administrador → ruta             registerCapital
//   retirar        ruta → bolsa del Administrador             registerWithdrawal
//
// VISTA PREVIA HONESTA. Solo se muestra un "después" que la operación produce de
// forma EXACTA a partir del "antes":
//   · Caja sin asignar de una ruta: entregar/colocar/recibir mueve exactamente el
//     importe (no se muestra el "disponible" del destino: está acotado por la Base y
//     entregar Base no cambia la Base).
//   · Disponible de la ruta ORIGEN de una transferencia o un retiro: Base y caja sin
//     asignar bajan lo mismo → baja exactamente el importe.
//   · Posición de un trabajador y bolsa del Administrador: lineales.
// Un saldo desconocido (`null`) se muestra como "se calcula al registrar".
// ============================================================

import { can, canOperateRouteCash } from '@/lib/permissions'
import type { Route, User } from '@/models/types'

export type TransferOperationKind = 'entregar-base' | 'devolver-base' | 'ruta-ruta' | 'colocar' | 'retirar'
export type TransferCategory = 'base' | 'rutas' | 'capital'

export interface TransferOperationDef {
  kind: TransferOperationKind
  categoria: TransferCategory
  titulo: string
  ayuda: string
  /** Verbo de la frase de confirmación: «Se entregarán R$ X desde … hacia …». */
  verbo: string
  /** Servicio existente que la registra. */
  servicio: string
}

export const TRANSFER_OPERATIONS: Record<TransferOperationKind, TransferOperationDef> = {
  'entregar-base': {
    kind: 'entregar-base', categoria: 'base', titulo: 'Entregar Base a un trabajador',
    ayuda: 'De la caja sin asignar de una ruta a un cobrador o supervisor de esa misma ruta. La Base de la ruta no cambia: cambia quién tiene el efectivo.',
    verbo: 'Se entregarán', servicio: 'assignBaseToWorker',
  },
  'devolver-base': {
    kind: 'devolver-base', categoria: 'base', titulo: 'Recibir devolución de Base',
    ayuda: 'Un trabajador devuelve efectivo a la caja sin asignar de su ruta. Lo registra quien lo recibe, nunca el propio trabajador.',
    verbo: 'Se recibirán', servicio: 'returnBaseFromWorker',
  },
  'ruta-ruta': {
    kind: 'ruta-ruta', categoria: 'rutas', titulo: 'Transferir entre rutas',
    ayuda: 'De la caja de una ruta a otra ruta de la que también eres responsable de capital. El total de tu bolsa no cambia.',
    verbo: 'Se transferirán', servicio: 'registerTransfer',
  },
  colocar: {
    kind: 'colocar', categoria: 'capital', titulo: 'Distribuir capital a una ruta',
    ayuda: 'Sale de tu bolsa (Caja principal) y entra a la caja sin asignar de la ruta. No es un gasto.',
    verbo: 'Se colocarán', servicio: 'registerCapital',
  },
  retirar: {
    kind: 'retirar', categoria: 'capital', titulo: 'Retirar capital de una ruta',
    ayuda: 'Sale de la caja sin asignar de la ruta y vuelve a tu bolsa. Lo que tienen los trabajadores no se puede retirar.',
    verbo: 'Se retirarán', servicio: 'registerWithdrawal',
  },
}

export const TRANSFER_CATEGORIES: { categoria: TransferCategory; titulo: string; ayuda: string; kinds: TransferOperationKind[] }[] = [
  { categoria: 'base', titulo: 'Entregar o devolver Base', ayuda: 'Efectivo entre la caja de una ruta y sus trabajadores.', kinds: ['entregar-base', 'devolver-base'] },
  { categoria: 'rutas', titulo: 'Transferir entre rutas', ayuda: 'Entre rutas de las que eres responsable de capital.', kinds: ['ruta-ruta'] },
  { categoria: 'capital', titulo: 'Distribuir o retirar capital', ayuda: 'Entre tu bolsa (Caja principal) y tus rutas.', kinds: ['colocar', 'retirar'] },
]

/**
 * ¿En qué rutas puede `actor` iniciar `kind`? MISMAS reglas que el servicio de cada
 * operación (capacidad + autoridad sobre la caja de la ruta, v16):
 *   entregar-base  cashCustody.manage + 'structural'  (assignBaseToWorker)
 *   devolver-base  cashCustody.manage + 'settle'      (returnBaseFromWorker)
 *   ruta-ruta      transfer.create    + 'structural'  (registerTransfer, en ambas rutas)
 *   colocar/retirar capital.manage    + 'structural'  (= canManageRouteFunds)
 * Solo para OFRECER opciones: el servicio revalida todo dentro de su transacción.
 */
export function routesForOperation(kind: TransferOperationKind, actor: User | null | undefined, routes: Route[], users: User[], tenantId: string): Route[] {
  return routes.filter(r => {
    if (kind === 'entregar-base') return can(actor, 'cashCustody.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
    if (kind === 'devolver-base') return can(actor, 'cashCustody.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'settle', users)
    if (kind === 'ruta-ruta') return can(actor, 'transfer.create', { tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
    return can(actor, 'capital.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
  })
}

/** Operaciones que el actor puede iniciar en al menos una ruta (Ruta → Ruta: dos). */
export function availableOperations(actor: User | null | undefined, routes: Route[], users: User[], tenantId: string): TransferOperationKind[] {
  return (Object.keys(TRANSFER_OPERATIONS) as TransferOperationKind[])
    .filter(k => routesForOperation(k, actor, routes, users, tenantId).length >= (k === 'ruta-ruta' ? 2 : 1))
}

/** Saldos de una ruta tal como los entrega la conciliación (`getRouteCashReconciliation`). */
export interface RouteBalances {
  /** Lo que se puede entregar, transferir o retirar desde la caja. */
  disponible: number
  /** Caja sin asignar (no está en manos de nadie). */
  sinAsignar: number
  /** Posición de cada trabajador en la ruta. */
  posiciones: Record<string, number>
}

export interface AccountPreview {
  cuenta: string
  antes: number | null
  despues: number | null
}

export interface OperationPreview {
  origen: AccountPreview
  destino: AccountPreview
  /** Máximo que el servicio aceptará (`null` = desconocido; el servicio decide). */
  limite: number | null
  excede: boolean
}

const mas = (n: number | null | undefined, x: number) => (n == null ? null : n + x)

/**
 * Vista previa de `kind` por `importe` con los saldos conocidos. Las etiquetas de
 * cuenta llegan ya resueltas (nombres de ruta, trabajador y bolsa).
 */
export function previewTransferOperation(params: {
  kind: TransferOperationKind
  importe: number
  ruta?: RouteBalances | null
  rutaDestino?: RouteBalances | null
  trabajadorId?: string
  /** Disponible de la bolsa del Administrador (Caja principal). */
  bolsa?: number | null
  nombres: { ruta?: string; rutaDestino?: string; trabajador?: string; bolsa?: string }
}): OperationPreview {
  const { kind, importe, ruta, rutaDestino, trabajadorId, bolsa, nombres } = params
  const pos = (r: RouteBalances | null | undefined) => (r && trabajadorId ? r.posiciones[trabajadorId] ?? 0 : null)
  const sinAsig = (r: RouteBalances | null | undefined) => (r ? r.sinAsignar : null)
  const disp = (r: RouteBalances | null | undefined) => (r ? r.disponible : null)
  const v = Math.max(0, Number(importe) || 0)
  let origen: AccountPreview
  let destino: AccountPreview
  let limite: number | null
  switch (kind) {
    case 'entregar-base':
      origen = { cuenta: `Caja sin asignar · ${nombres.ruta ?? ''}`, antes: sinAsig(ruta), despues: mas(sinAsig(ruta), -v) }
      destino = { cuenta: `En manos de ${nombres.trabajador ?? ''}`, antes: pos(ruta), despues: mas(pos(ruta), v) }
      limite = disp(ruta)
      break
    case 'devolver-base':
      origen = { cuenta: `En manos de ${nombres.trabajador ?? ''}`, antes: pos(ruta), despues: mas(pos(ruta), -v) }
      destino = { cuenta: `Caja sin asignar · ${nombres.ruta ?? ''}`, antes: sinAsig(ruta), despues: mas(sinAsig(ruta), v) }
      limite = pos(ruta) == null ? null : Math.max(0, pos(ruta)!)
      break
    case 'ruta-ruta':
      origen = { cuenta: `Disponible · ${nombres.ruta ?? ''}`, antes: disp(ruta), despues: mas(disp(ruta), -v) }
      destino = trabajadorId
        ? { cuenta: `En manos de ${nombres.trabajador ?? ''} · ${nombres.rutaDestino ?? ''}`, antes: pos(rutaDestino), despues: mas(pos(rutaDestino), v) }
        : { cuenta: `Caja sin asignar · ${nombres.rutaDestino ?? ''}`, antes: sinAsig(rutaDestino), despues: mas(sinAsig(rutaDestino), v) }
      limite = disp(ruta)
      break
    case 'colocar':
      origen = { cuenta: nombres.bolsa ?? 'Mi bolsa (Caja principal)', antes: bolsa ?? null, despues: mas(bolsa, -v) }
      destino = { cuenta: `Caja sin asignar · ${nombres.ruta ?? ''}`, antes: sinAsig(ruta), despues: mas(sinAsig(ruta), v) }
      limite = bolsa ?? null
      break
    case 'retirar':
      origen = { cuenta: `Disponible · ${nombres.ruta ?? ''}`, antes: disp(ruta), despues: mas(disp(ruta), -v) }
      destino = { cuenta: nombres.bolsa ?? 'Mi bolsa (Caja principal)', antes: bolsa ?? null, despues: mas(bolsa, v) }
      limite = disp(ruta)
      break
  }
  return { origen, destino, limite, excede: limite != null && v > limite }
}

/** Frase inequívoca de confirmación. */
export function confirmationSentence(kind: TransferOperationKind, importe: string, origen: string, destino: string): string {
  return `${TRANSFER_OPERATIONS[kind].verbo} ${importe} desde ${origen} hacia ${destino}.`
}
