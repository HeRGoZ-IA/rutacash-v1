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
//
// CAPITAL CENTRALIZADO (C2, `modo.central`): la caja de la ruta ya no es una bolsa.
//   entregar-capital  bolsa del Administrador → trabajador        deliverCapitalToWorker
//   devolver-capital  trabajador → bolsa del Administrador        returnCapitalFromWorker
//   retirar / entregar-base  SOLO para vaciar el saldo heredado de la antigua caja,
//                     y solo en rutas que lo tienen (títulos propios).
//   ruta-ruta, colocar y devolver-base no se ofrecen (harían crecer la caja de la ruta).
// ============================================================

import { can, canOperateRouteCash } from '@/lib/permissions'
import type { Route, User } from '@/models/types'

export type TransferOperationKind = 'entregar-base' | 'devolver-base' | 'ruta-ruta' | 'colocar' | 'retirar' | 'entregar-capital' | 'devolver-capital'
export type TransferCategory = 'base' | 'rutas' | 'capital' | 'centralizado' | 'heredado'

/** Modo del asistente: v16 (por defecto) o capital centralizado con su saldo heredado por ruta. */
export interface TransferMode {
  central: boolean
  /** "Sin asignar" por ruta (saldo heredado). Solo se ofrecen las operaciones de vaciado donde es > 0. */
  heredado?: Record<string, number>
}

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
  'entregar-capital': {
    kind: 'entregar-capital', categoria: 'centralizado', titulo: 'Entregar capital a un trabajador',
    ayuda: 'De tu bolsa (Caja principal) a un cobrador o supervisor, identificando la ruta. Queda a su cargo en esa ruta. No crea ningún préstamo.',
    verbo: 'Se entregarán', servicio: 'deliverCapitalToWorker',
  },
  'devolver-capital': {
    kind: 'devolver-capital', categoria: 'centralizado', titulo: 'Recibir devolución de capital',
    ayuda: 'Un trabajador devuelve efectivo de una ruta y vuelve a la bolsa del Administrador responsable. Lo registra quien lo recibe, nunca el propio trabajador.',
    verbo: 'Se recibirán', servicio: 'returnCapitalFromWorker',
  },
}

/** Títulos de las operaciones de vaciado del saldo heredado (modo centralizado). */
const TITULOS_HEREDADO: Partial<Record<TransferOperationKind, Pick<TransferOperationDef, 'titulo' | 'ayuda'>>> = {
  retirar: {
    titulo: 'Traspasar saldo heredado a mi bolsa',
    ayuda: 'Sale del saldo que quedó en la antigua caja de la ruta y vuelve a tu bolsa. Solo puede bajar ese saldo, nunca aumentarlo.',
  },
  'entregar-base': {
    titulo: 'Entregar saldo heredado a un trabajador',
    ayuda: 'Entrega a un trabajador de la ruta efectivo del saldo heredado de la antigua caja. No usa tu bolsa.',
  },
}

/** Definición de la operación según el modo (los títulos del saldo heredado cambian). */
export function operationDef(kind: TransferOperationKind, modo?: TransferMode): TransferOperationDef {
  const base = TRANSFER_OPERATIONS[kind]
  return modo?.central && TITULOS_HEREDADO[kind] ? { ...base, ...TITULOS_HEREDADO[kind] } : base
}

export const TRANSFER_CATEGORIES: { categoria: TransferCategory; titulo: string; ayuda: string; kinds: TransferOperationKind[] }[] = [
  { categoria: 'base', titulo: 'Entregar o devolver Base', ayuda: 'Efectivo entre la caja de una ruta y sus trabajadores.', kinds: ['entregar-base', 'devolver-base'] },
  { categoria: 'rutas', titulo: 'Transferir entre rutas', ayuda: 'Entre rutas de las que eres responsable de capital.', kinds: ['ruta-ruta'] },
  { categoria: 'capital', titulo: 'Distribuir o retirar capital', ayuda: 'Entre tu bolsa (Caja principal) y tus rutas.', kinds: ['colocar', 'retirar'] },
]

export const CENTRAL_TRANSFER_CATEGORIES: typeof TRANSFER_CATEGORIES = [
  { categoria: 'centralizado', titulo: 'Capital de trabajadores', ayuda: 'Entre tu bolsa y los cobradores o supervisores de tus rutas.', kinds: ['entregar-capital', 'devolver-capital'] },
  { categoria: 'heredado', titulo: 'Saldo heredado de la caja de ruta', ayuda: 'Vaciar lo que quedó en la antigua caja de una ruta.', kinds: ['retirar', 'entregar-base'] },
]

export function transferCategories(modo?: TransferMode): typeof TRANSFER_CATEGORIES {
  return modo?.central ? CENTRAL_TRANSFER_CATEGORIES : TRANSFER_CATEGORIES
}

/** Operaciones que existen en cada modo. */
export function operationsOfMode(modo?: TransferMode): TransferOperationKind[] {
  return modo?.central
    ? ['entregar-capital', 'devolver-capital', 'retirar', 'entregar-base']
    : ['entregar-base', 'devolver-base', 'ruta-ruta', 'colocar', 'retirar']
}

/**
 * ¿En qué rutas puede `actor` iniciar `kind`? MISMAS reglas que el servicio de cada
 * operación (capacidad + autoridad sobre la caja de la ruta, v16):
 *   entregar-base  cashCustody.manage + 'structural'  (assignBaseToWorker)
 *   devolver-base  cashCustody.manage + 'settle'      (returnBaseFromWorker)
 *   ruta-ruta      transfer.create    + 'structural'  (registerTransfer, en ambas rutas)
 *   colocar/retirar capital.manage    + 'structural'  (= canManageRouteFunds)
 * Solo para OFRECER opciones: el servicio revalida todo dentro de su transacción.
 */
export function routesForOperation(
  kind: TransferOperationKind, actor: User | null | undefined, routes: Route[], users: User[], tenantId: string, modo?: TransferMode,
): Route[] {
  if (!operationsOfMode(modo).includes(kind)) return []
  // Modo centralizado: el vaciado del saldo heredado solo donde ese saldo existe.
  const conHeredado = (r: Route) => !modo?.central || (kind !== 'retirar' && kind !== 'entregar-base') || (modo.heredado?.[r.id] ?? 0) > 0
  return routes.filter(r => {
    if (!conHeredado(r)) return false
    if (kind === 'entregar-base') return can(actor, 'cashCustody.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
    if (kind === 'devolver-base' || kind === 'devolver-capital') return can(actor, 'cashCustody.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'settle', users)
    if (kind === 'ruta-ruta') return can(actor, 'transfer.create', { tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
    if (kind === 'entregar-capital') {
      return can(actor, 'capital.manage', { routeId: r.id, tenantId }) && can(actor, 'cashCustody.manage', { routeId: r.id, tenantId })
        && canOperateRouteCash(actor, r, 'structural', users)
    }
    return can(actor, 'capital.manage', { routeId: r.id, tenantId }) && canOperateRouteCash(actor, r, 'structural', users)
  })
}

/** Operaciones que el actor puede iniciar en al menos una ruta (Ruta → Ruta: dos). */
export function availableOperations(actor: User | null | undefined, routes: Route[], users: User[], tenantId: string, modo?: TransferMode): TransferOperationKind[] {
  return operationsOfMode(modo)
    .filter(k => routesForOperation(k, actor, routes, users, tenantId, modo).length >= (k === 'ruta-ruta' ? 2 : 1))
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
    case 'entregar-capital':
      origen = { cuenta: nombres.bolsa ?? 'Mi bolsa (Caja principal)', antes: bolsa ?? null, despues: mas(bolsa, -v) }
      destino = { cuenta: `A cargo de ${nombres.trabajador ?? ''} · ${nombres.ruta ?? ''}`, antes: pos(ruta), despues: mas(pos(ruta), v) }
      limite = bolsa ?? null
      break
    case 'devolver-capital':
      origen = { cuenta: `A cargo de ${nombres.trabajador ?? ''} · ${nombres.ruta ?? ''}`, antes: pos(ruta), despues: mas(pos(ruta), -v) }
      destino = { cuenta: nombres.bolsa ?? 'Bolsa del Administrador responsable', antes: bolsa ?? null, despues: mas(bolsa, v) }
      limite = pos(ruta) == null ? null : Math.max(0, pos(ruta)!)
      break
  }
  return { origen, destino, limite, excede: limite != null && v > limite }
}

/** Frase inequívoca de confirmación. */
export function confirmationSentence(kind: TransferOperationKind, importe: string, origen: string, destino: string): string {
  return `${TRANSFER_OPERATIONS[kind].verbo} ${importe} desde ${origen} hacia ${destino}.`
}

/** Etiqueta del botón de cada operación en una tarjeta de ruta. */
export function operationButtonLabel(kind: TransferOperationKind, modo?: TransferMode): string {
  if (modo?.central && kind === 'retirar') return 'Traspasar heredado a mi bolsa'
  if (modo?.central && kind === 'entregar-base') return 'Entregar del heredado'
  const etiquetas: Record<TransferOperationKind, string> = {
    'entregar-base': 'Entregar Base', 'devolver-base': 'Recibir devolución', 'ruta-ruta': 'Transferir a otra ruta',
    colocar: 'Colocar capital', retirar: 'Retirar capital', 'entregar-capital': 'Entregar capital', 'devolver-capital': 'Recibir devolución de capital',
  }
  return etiquetas[kind]
}
