// ============================================================
// CAJA PRINCIPAL DEL ADMINISTRADOR — ESTADO DE CUENTA DE LA BOLSA (PURO, Ronda 3/6)
// ------------------------------------------------------------
// NO es otra bolsa ni otro libro. Las cifras oficiales salen de `adminCapital`
// (`capitalAllocation`, Ronda 2/6). Este módulo solo:
//   · CLASIFICA los registros reales que ya alimentan esa fórmula (libro de
//     capital, capital colocado, retiros de rutas y gastos imputados) para que el
//     Administrador vea qué aumentó o redujo su disponible;
//   · y EXPLICA la conciliación con las partidas del modelo, sin ajustes.
//
// CONCILIACIÓN (identidad del modelo, no un cuadre forzado):
//   recibido del SuperAdmin (asignaciones − devoluciones)
//   + aportes de socios (C1: `PARTNER_CONTRIBUTION`)
//   + capital recibido con rutas − capital entregado con rutas   (cambio de
//     responsable / migración v16: `ROUTE_CONTROL_TRANSFER`)
//   = disponible + capital neto en rutas + gastos netos
// `diferencia` se calcula y se muestra; nunca se compensa.
//
// Los traslados Ruta → Ruta del mismo Administrador no cambian ninguna de estas
// cifras (mueven capital entre sus rutas): no aparecen como movimiento de la bolsa.
// Sin Dexie ni React.
// ============================================================
import { adminCapital, type AdminCapital, type CapitalRows } from '@/lib/capitalAllocation'
import { expenseFundingOf, poolExpenseStateOf } from '@/lib/expenseFunding'
import { reversalStateOf } from '@/lib/movementReversal'
import type { CapitalLedgerEntry, CapitalMovement, CentralCapitalLink, Expense, Withdrawal } from '@/models/types'

export type PoolMovementKind =
  | 'asignacion'       // SuperAdmin → bolsa
  | 'devolucionSA'     // bolsa → SuperAdmin
  | 'aporteSocio'      // socio → bolsa (C1; su anulación es el asiento negado)
  | 'colocacion'       // bolsa → ruta
  | 'retiroRuta'       // ruta → bolsa (devolución de capital desde una ruta)
  | 'rutaRecibida'     // capital de una ruta que pasa a esta bolsa (cambio de responsable)
  | 'rutaEntregada'    // capital de una ruta que sale de esta bolsa (cambio de responsable)
  | 'gasto'            // gasto administrativo
  | 'anulacionGasto'   // anulación de un gasto (asiento negado)
  | 'reintegro'        // reintegro de un gasto (asiento negado)
  // Capital centralizado (C1/C2): mismos registros (capital/retiro), clasificados
  // por la operación real para que un retorno de cuadre no parezca un retiro.
  | 'entregaTrabajador'    // bolsa → trabajador (y su anulación)
  | 'devolucionTrabajador' // trabajador → bolsa
  | 'retornoCuadre'        // efectivo entregado en un cuadre → bolsa (y su reapertura)
  | 'cobroNoPersonal'      // cobro por transferencia o recibido por un Admin → bolsa (y su anulación)
  | 'desembolsoAdmin'      // préstamo entregado por el Admin/SuperAdmin con la bolsa
  | 'gastoRuta'            // gasto de la ruta pagado con la bolsa

export type PoolMovementState = 'vigente' | 'anulado' | 'reversion'

export interface PoolMovement {
  /** Id del registro real (referencia de la operación). */
  id: string
  kind: PoolMovementKind
  /** Fecha contable del registro. */
  fecha: string
  /** Instante en que se registró. */
  createdAt: string
  /** Efecto con signo sobre la partida que afecta (+ entra, − sale). */
  monto: number
  /** Qué partida de la bolsa mueve: el disponible o el capital en rutas. */
  afecta: 'disponible' | 'enRutas'
  estado: PoolMovementState
  routeId?: string
  /** Otro Administrador implicado (cambio de responsable). */
  relatedAdminId?: string
  /** Quién lo registró. */
  actorId?: string
  descripcion?: string
  categoryId?: string
  /** Original al que corrige (reversión, anulación o reintegro). */
  corrigeId?: string
}

export interface PoolStatement {
  adminId: string
  /** Cifras OFICIALES (fórmula única de la Ronda 2/6). */
  capital: AdminCapital
  partidas: {
    asignaciones: number
    devolucionesSA: number
    /** Neto recibido del SuperAdmin = asignaciones − devoluciones. */
    recibidoSA: number
    /** Aportes netos de socios (C1). */
    aportesSocios: number
    rutasRecibidas: number
    rutasEntregadas: number
    colocado: number
    retiradoDeRutas: number
  }
  conciliacion: {
    /** recibidoSA + aportesSocios + rutasRecibidas − rutasEntregadas. */
    entradas: number
    /** disponible + enRutas + gastos. */
    explicado: number
    diferencia: number
  }
  movimientos: PoolMovement[]
}

/** Filas completas que entrega `loadCapitalRows` (las mismas de la fórmula). */
export interface PoolSources extends CapitalRows {
  ledger: CapitalLedgerEntry[]
  capitalMovements: CapitalMovement[]
  withdrawals: Withdrawal[]
  expenses?: Expense[]
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const estadoDe = (m: { reversalId?: string; reversesId?: string }): PoolMovementState => reversalStateOf(m)

export function buildPoolStatement(adminId: string, rows: PoolSources): PoolStatement {
  const capital = adminCapital(adminId, rows)
  const movimientos: PoolMovement[] = []

  for (const e of rows.ledger) {
    const base = { id: e.id, fecha: e.fecha, createdAt: e.createdAt, actorId: e.actorUserId, descripcion: e.descripcion, estado: estadoDe(e) }
    if (e.tipo === 'ADMIN_ALLOCATION' && e.toAdminId === adminId) movimientos.push({ ...base, kind: 'asignacion', monto: e.amount, afecta: 'disponible' })
    if (e.tipo === 'ADMIN_RETURN' && e.fromAdminId === adminId) movimientos.push({ ...base, kind: 'devolucionSA', monto: -e.amount, afecta: 'disponible' })
    if (e.tipo === 'PARTNER_CONTRIBUTION' && e.toAdminId === adminId) {
      movimientos.push({ ...base, kind: 'aporteSocio', monto: e.amount, afecta: 'disponible', routeId: e.routeId, corrigeId: e.reversesId })
    }
    if (e.tipo === 'ROUTE_CONTROL_TRANSFER' && e.toAdminId === adminId) {
      movimientos.push({ ...base, kind: 'rutaRecibida', monto: e.amount, afecta: 'enRutas', routeId: e.routeId, relatedAdminId: e.fromAdminId })
    }
    if (e.tipo === 'ROUTE_CONTROL_TRANSFER' && e.fromAdminId === adminId) {
      movimientos.push({ ...base, kind: 'rutaEntregada', monto: -e.amount, afecta: 'enRutas', routeId: e.routeId, relatedAdminId: e.toAdminId })
    }
  }
  for (const m of rows.capitalMovements.filter(x => x.adminId === adminId)) {
    movimientos.push({
      id: m.id, kind: centralPoolKind(m.centralLink, 'colocacion'), fecha: m.fecha, createdAt: m.createdAt, monto: -m.valor, afecta: 'disponible',
      estado: estadoDe(m), routeId: m.routeId, actorId: m.userId, descripcion: m.descripcion, corrigeId: m.reversesId,
    })
  }
  for (const w of rows.withdrawals.filter(x => x.adminId === adminId)) {
    movimientos.push({
      id: w.id, kind: centralPoolKind(w.centralLink, 'retiroRuta'), fecha: w.fecha, createdAt: w.createdAt, monto: w.valor, afecta: 'disponible',
      estado: estadoDe(w), routeId: w.routeId, actorId: w.userId, descripcion: w.descripcion, corrigeId: w.reversesId,
    })
  }
  for (const x of rows.expenses ?? []) {
    const f = expenseFundingOf(x)
    if (f.kind !== 'admin' || f.adminId !== adminId) continue
    const st = poolExpenseStateOf(x)
    movimientos.push({
      id: x.id, kind: st === 'anulacion' ? 'anulacionGasto' : st === 'reintegro' ? 'reintegro' : 'gasto',
      fecha: x.fecha, createdAt: x.createdAt, monto: -x.valor, afecta: 'disponible',
      estado: st === 'anulado' ? 'anulado' : st === 'anulacion' ? 'reversion' : 'vigente',
      actorId: x.userId, descripcion: x.descripcion, categoryId: x.categoryId, corrigeId: x.reversesId ?? x.refundsExpenseId,
    })
  }
  movimientos.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fecha.localeCompare(a.fecha))

  const de = (k: PoolMovementKind) => sum(movimientos.filter(m => m.kind === k).map(m => m.monto))
  const asignaciones = de('asignacion')
  const devolucionesSA = -de('devolucionSA')
  const aportesSocios = de('aporteSocio')
  const rutasRecibidas = de('rutaRecibida')
  const rutasEntregadas = -de('rutaEntregada')
  const entradas = asignaciones - devolucionesSA + aportesSocios + rutasRecibidas - rutasEntregadas
  const explicado = capital.disponible + capital.enRutas + capital.gastos
  return {
    adminId, capital,
    partidas: {
      asignaciones, devolucionesSA, recibidoSA: asignaciones - devolucionesSA, aportesSocios,
      rutasRecibidas, rutasEntregadas,
      // Totales de los registros reales (incluye las operaciones centralizadas).
      colocado: sum(rows.capitalMovements.filter(x => x.adminId === adminId).map(x => x.valor)),
      retiradoDeRutas: sum(rows.withdrawals.filter(x => x.adminId === adminId).map(x => x.valor)),
    },
    conciliacion: { entradas, explicado, diferencia: entradas - explicado },
    movimientos,
  }
}

/** Tipo de movimiento de la bolsa según su operación centralizada (o el genérico v16). */
export function centralPoolKind(link: CentralCapitalLink | undefined, generico: 'colocacion' | 'retiroRuta'): PoolMovementKind {
  switch (link?.kind) {
    case 'ENTREGA_TRABAJADOR': case 'ANULACION_ENTREGA': return 'entregaTrabajador'
    case 'DEVOLUCION_TRABAJADOR': return 'devolucionTrabajador'
    case 'CUADRE': case 'REAPERTURA_CUADRE': return 'retornoCuadre'
    case 'COBRO_NO_PERSONAL': case 'ANULACION_COBRO': return 'cobroNoPersonal'
    case 'DESEMBOLSO_ADMIN': return 'desembolsoAdmin'
    case 'GASTO_RUTA': return 'gastoRuta'
    default: return generico
  }
}

const KINDS_GASTO: PoolMovementKind[] = ['gasto', 'anulacionGasto', 'reintegro']

/**
 * Gasto administrativo NETO del período [desde, hasta] por fecha contable (incluye
 * anulaciones y reintegros fechados en él). Es un RESUMEN del período: la
 * conciliación usa siempre el acumulado (`capital.gastos`).
 */
export function poolExpensesInPeriod(movs: PoolMovement[], desde?: string, hasta?: string): { neto: number; registros: number } {
  const enRango = movs.filter(m => KINDS_GASTO.includes(m.kind) && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta))
  // `+ 0`: sin gastos, la suma negada sería -0 y se mostraría «−0».
  return { neto: -sum(enRango.map(m => m.monto)) + 0, registros: enRango.filter(m => m.kind === 'gasto').length }
}

export const POOL_MOVEMENT_LABEL: Record<PoolMovementKind, string> = {
  asignacion: 'Capital recibido del SuperAdmin',
  devolucionSA: 'Capital devuelto al SuperAdmin',
  aporteSocio: 'Aporte de socio',
  colocacion: 'Capital colocado en ruta',
  retiroRuta: 'Capital retirado de ruta',
  rutaRecibida: 'Capital recibido con una ruta',
  rutaEntregada: 'Capital entregado con una ruta',
  gasto: 'Gasto administrativo',
  anulacionGasto: 'Anulación de gasto',
  reintegro: 'Reintegro de gasto',
  entregaTrabajador: 'Capital entregado a trabajador',
  devolucionTrabajador: 'Devolución de capital de trabajador',
  retornoCuadre: 'Efectivo recibido en cuadre',
  cobroNoPersonal: 'Cobro no en efectivo (transferencia)',
  desembolsoAdmin: 'Préstamo entregado desde la bolsa',
  gastoRuta: 'Gasto de ruta pagado con la bolsa',
}
