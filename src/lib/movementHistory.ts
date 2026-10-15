// ============================================================
// HISTORIAL UNIFICADO DE MOVIMIENTOS — PROYECCIÓN (PURO, Ronda 5/6)
// ------------------------------------------------------------
// NO es un segundo libro: cada entrada es la VISTA de un registro financiero real
// (fuente + id). Nada se guarda; todo se proyecta en cada consulta.
//
// FUENTES (tablas) y lo que aportan:
//   capitalLedger         empresa ↔ externo, empresa ↔ Admin, cambio de responsable
//   capitalMovements      bolsa del Admin → ruta (colocación) y sus anulaciones
//   withdrawals           ruta → bolsa del Admin (retiro) y sus anulaciones
//   transfers             ruta ↔ ruta, ruta ↔ socio, socio ↔ socio y sus anulaciones
//   cashCustodyMovements  entregas, devoluciones y traspasos de Base
//   expenses              gastos (empresa con/sin bolsa, ruta, trabajador), anulación, reintegro
//   partnerCashMovements  movimientos manuales de Caja socios
//
// IDENTIDAD CANÓNICA: `${fuente}:${id}`. Nunca se deduplica por importe, fecha o
// nombres: dos operaciones reales del mismo valor son dos entradas.
// UNA OPERACIÓN, UNA ENTRADA: las PATAS enlazadas a una transferencia por
// `relatedTransferId` (su movimiento de Caja socios, su entrega en mano) se
// muestran DENTRO de la transferencia, no como entradas aparte.
// CORRECCIONES: una anulación o un reintegro es una entrada propia (con su
// referencia) enlazada al original (`corrigeA`); el original queda «anulado».
// Recaudos y desembolsos NO se incluyen: viven en Pagos/Ventas y en el cuadre,
// con su propio ciclo de estados (ver informe de la Ronda 5/6).
// Sin Dexie ni React.
// ============================================================
import { expenseFundingOf, poolExpenseStateOf } from '@/lib/expenseFunding'
import { expenseAttribution } from '@/lib/expenseAttribution'
import type {
  CentralCapitalKind,
  CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, Expense, PartnerCashMovement, Transfer, Withdrawal,
} from '@/models/types'

export type HistorySource = 'capitalLedger' | 'capitalMovements' | 'withdrawals' | 'transfers' | 'cashCustodyMovements' | 'expenses' | 'partnerCashMovements'
export type HistoryCategory = 'capital' | 'custodia' | 'transferencia' | 'gasto' | 'socios' | 'correccion'
export type HistoryState = 'vigente' | 'anulado' | 'correccion' | 'historico'
export type AccountKind = 'externo' | 'bolsa-empresa' | 'bolsa-admin' | 'caja-ruta' | 'trabajador' | 'socio' | 'sin-bolsa' | 'proveedor'

export interface HistoryAccount { kind: AccountKind; id?: string; routeId?: string }

/** Registro enlazado a la misma operación (no es una operación aparte). */
export interface HistoryLeg {
  key: string
  clase: 'caja-socios' | 'entrega-en-mano' | 'devolucion-tecnica'
  importe: number
  /** Socio o trabajador del registro enlazado. */
  personaId?: string
  movimiento?: 'ingreso' | 'salida'
}

export interface HistoryEntry {
  /** Identidad canónica `${fuente}:${id}` (= referencia real del registro). */
  key: string
  fuente: HistorySource
  id: string
  categoria: HistoryCategory
  tipo: string
  /** Importe registrado (con su signo si es una corrección: el asiento negado). */
  importe: number
  origen: HistoryAccount
  destino: HistoryAccount
  routeIds: string[]
  workerIds: string[]
  /** Administradores cuya bolsa o responsabilidad aparece en el registro. */
  adminIds: string[]
  partnerIds: string[]
  registradoPor?: string
  /** Instante real del registro. */
  createdAt: string
  /** Fecha contable. */
  fecha: string
  concepto?: string
  estado: HistoryState
  corrigeA?: string
  corregidoPor: string[]
  patas: HistoryLeg[]
  /** Datos adicionales verificables (etiqueta → valor). */
  extra: [string, string][]
}

export interface HistorySources {
  ledger: CapitalLedgerEntry[]
  capitalMovements: CapitalMovement[]
  withdrawals: Withdrawal[]
  transfers: Transfer[]
  custody: CashCustodyMovement[]
  expenses: Expense[]
  partnerCash: PartnerCashMovement[]
  /** ¿El usuario tiene caja personal? (atribución de gastos históricos). */
  hasCashbox?: (userId: string) => boolean
}

const k = (fuente: HistorySource, id: string) => `${fuente}:${id}`
const LEDGER_TIPO: Record<CapitalLedgerEntry['tipo'], string> = {
  COMPANY_DEPOSIT: 'Ingreso de capital a la empresa',
  COMPANY_WITHDRAWAL: 'Retiro de capital de la empresa',
  ADMIN_ALLOCATION: 'Asignación de capital a Administrador',
  ADMIN_RETURN: 'Devolución de capital al SuperAdmin',
  ROUTE_CONTROL_TRANSFER: 'Cambio de responsable de capital',
  PARTNER_CONTRIBUTION: 'Aporte de socio a la bolsa del Administrador',
}

/**
 * Capital centralizado (C2): nombre real de un capital o retiro enlazado a su
 * operación. Un retorno de cuadre o un cobro por transferencia no es un "retiro".
 */
const CENTRAL_TIPO: Record<CentralCapitalKind, string> = {
  ENTREGA_TRABAJADOR: 'Entrega de capital a trabajador (desde la bolsa)',
  ANULACION_ENTREGA: 'Anulación de entrega de capital',
  DEVOLUCION_TRABAJADOR: 'Devolución de capital de trabajador a la bolsa',
  CUADRE: 'Efectivo de cuadre devuelto a la bolsa',
  REAPERTURA_CUADRE: 'Reapertura de cuadre: el efectivo vuelve al trabajador',
  COBRO_NO_PERSONAL: 'Cobro no en efectivo enviado a la bolsa',
  ANULACION_COBRO: 'Anulación de cobro no en efectivo',
  DESEMBOLSO_ADMIN: 'Préstamo del Administrador pagado con su bolsa',
  GASTO_RUTA: 'Gasto de ruta pagado con la bolsa',
}
const NOTA_CENTRAL: [string, string] = ['Efecto', 'Capital centralizado: mueve la bolsa del responsable; la caja de la ruta no cambia']

/** Proyecta TODOS los registros (ya acotados por permisos) a entradas del historial. */
export function buildMovementHistory(s: HistorySources): HistoryEntry[] {
  const out: HistoryEntry[] = []
  const base = (fuente: HistorySource, id: string, createdAt: string, fecha: string): Pick<HistoryEntry, 'key' | 'fuente' | 'id' | 'createdAt' | 'fecha' | 'corregidoPor' | 'patas' | 'extra' | 'partnerIds'> =>
    ({ key: k(fuente, id), fuente, id, createdAt, fecha, corregidoPor: [], patas: [], extra: [], partnerIds: [] })

  // ---------- Libro de capital ----------
  for (const e of s.ledger) {
    const admins = [e.fromAdminId, e.toAdminId].filter(Boolean) as string[]
    const origen: HistoryAccount = e.tipo === 'COMPANY_DEPOSIT' ? { kind: 'externo' }
      : e.tipo === 'PARTNER_CONTRIBUTION' ? { kind: 'socio', id: e.partnerId }
      : e.tipo === 'COMPANY_WITHDRAWAL' || e.tipo === 'ADMIN_ALLOCATION' ? { kind: 'bolsa-empresa' }
        : e.fromAdminId ? { kind: 'bolsa-admin', id: e.fromAdminId } : { kind: 'sin-bolsa' }
    const destino: HistoryAccount = e.tipo === 'COMPANY_WITHDRAWAL' ? { kind: 'externo' }
      : e.tipo === 'COMPANY_DEPOSIT' || e.tipo === 'ADMIN_RETURN' ? { kind: 'bolsa-empresa' }
        : e.toAdminId ? { kind: 'bolsa-admin', id: e.toAdminId } : { kind: 'sin-bolsa' }
    out.push({
      ...base('capitalLedger', e.id, e.createdAt, e.fecha), categoria: 'capital', tipo: LEDGER_TIPO[e.tipo],
      importe: e.amount, origen, destino, routeIds: e.routeId ? [e.routeId] : [], workerIds: [], adminIds: admins,
      registradoPor: e.actorUserId, concepto: e.descripcion, estado: 'vigente',
      extra: e.tipo === 'ROUTE_CONTROL_TRANSFER' ? [['Efecto', 'Capital colocado en la ruta que cambia de bolsa (no es dinero nuevo)']] : [],
    })
  }

  // ---------- Colocaciones y retiros (con sus anulaciones) ----------
  for (const m of s.capitalMovements) {
    const rev = !!m.reversesId
    out.push({
      ...base('capitalMovements', m.id, m.createdAt, m.fecha), categoria: rev ? 'correccion' : 'capital',
      tipo: m.centralLink ? CENTRAL_TIPO[m.centralLink.kind] : rev ? 'Anulación de colocación de capital' : 'Colocación de capital en ruta',
      importe: m.valor, extra: m.centralLink ? [NOTA_CENTRAL] : [],
      origen: rev ? { kind: 'caja-ruta', routeId: m.routeId } : m.adminId ? { kind: 'bolsa-admin', id: m.adminId } : { kind: 'sin-bolsa' },
      destino: rev ? (m.adminId ? { kind: 'bolsa-admin', id: m.adminId } : { kind: 'sin-bolsa' }) : { kind: 'caja-ruta', routeId: m.routeId },
      routeIds: [m.routeId], workerIds: [], adminIds: m.adminId ? [m.adminId] : [], registradoPor: m.userId,
      concepto: rev ? m.reversalReason : m.descripcion, estado: rev ? 'correccion' : m.reversalId ? 'anulado' : 'vigente',
      corrigeA: m.reversesId ? k('capitalMovements', m.reversesId) : undefined,
    })
  }
  for (const w of s.withdrawals) {
    const rev = !!w.reversesId
    out.push({
      ...base('withdrawals', w.id, w.createdAt, w.fecha), categoria: rev ? 'correccion' : 'capital',
      tipo: w.centralLink ? CENTRAL_TIPO[w.centralLink.kind] : rev ? 'Anulación de retiro de capital' : 'Retiro de capital de ruta',
      importe: w.valor, extra: w.centralLink ? [NOTA_CENTRAL] : [],
      origen: rev ? (w.adminId ? { kind: 'bolsa-admin', id: w.adminId } : { kind: 'sin-bolsa' }) : { kind: 'caja-ruta', routeId: w.routeId },
      destino: rev ? { kind: 'caja-ruta', routeId: w.routeId } : w.adminId ? { kind: 'bolsa-admin', id: w.adminId } : { kind: 'sin-bolsa' },
      routeIds: [w.routeId], workerIds: [], adminIds: w.adminId ? [w.adminId] : [], registradoPor: w.userId,
      concepto: rev ? w.reversalReason : w.descripcion, estado: rev ? 'correccion' : w.reversalId ? 'anulado' : 'vigente',
      corrigeA: w.reversesId ? k('withdrawals', w.reversesId) : undefined,
    })
  }

  // ---------- Transferencias (con sus patas) ----------
  const transferIds = new Set(s.transfers.map(t => t.id))
  for (const t of s.transfers) {
    const rev = !!t.reversesId
    const ep = (type: string | undefined, routeId?: string, socioId?: string): HistoryAccount =>
      (type ?? 'route') === 'partner' ? { kind: 'socio', id: socioId } : routeId ? { kind: 'caja-ruta', routeId } : { kind: 'externo' }
    let origen = ep(t.origenType, t.routeOrigenId || undefined, t.socioOrigenId)
    let destino = ep(t.destinoType, t.routeDestinoId, t.socioDestinoId)
    const custodia = s.custody.filter(c => c.relatedTransferId === t.id)
    const socios = s.partnerCash.filter(p => p.relatedTransferId === t.id)
    // Entrega en mano: el destino real es la persona dentro de la ruta destino.
    const enMano = custodia.find(c => c.tipo === 'BASE_ASSIGNMENT' && c.toUserId)
    if (enMano && !rev) destino = { kind: 'trabajador', id: enMano.toUserId, routeId: t.routeDestinoId }
    if (rev) { const o = origen; origen = destino; destino = o }
    out.push({
      ...base('transfers', t.id, t.createdAt, t.fecha), categoria: rev ? 'correccion' : 'transferencia',
      tipo: rev ? 'Anulación de transferencia'
        : origen.kind === 'socio' || destino.kind === 'socio' ? 'Transferencia con socio' : 'Transferencia entre rutas',
      importe: t.valor, origen, destino,
      routeIds: [t.routeOrigenId, t.routeDestinoId].filter(Boolean) as string[],
      workerIds: custodia.flatMap(c => [c.toUserId, c.fromUserId]).filter(Boolean) as string[],
      adminIds: t.adminId ? [t.adminId] : [], partnerIds: [t.socioOrigenId, t.socioDestinoId].filter(Boolean) as string[],
      registradoPor: t.userId, concepto: rev ? t.reversalReason : t.descripcion,
      estado: rev ? 'correccion' : t.reversalId ? 'anulado' : 'vigente',
      corrigeA: t.reversesId ? k('transfers', t.reversesId) : undefined,
      patas: [
        ...socios.map((p): HistoryLeg => ({ key: k('partnerCashMovements', p.id), clase: 'caja-socios', importe: p.amount, personaId: p.partnerId, movimiento: p.type })),
        ...custodia.map((c): HistoryLeg => c.tipo === 'BASE_ASSIGNMENT'
          ? { key: k('cashCustodyMovements', c.id), clase: 'entrega-en-mano', importe: c.amount, personaId: c.toUserId }
          : { key: k('cashCustodyMovements', c.id), clase: 'devolucion-tecnica', importe: c.amount, personaId: c.fromUserId }),
      ],
    })
  }

  // ---------- Base y custodia (las patas de transferencias ya están dentro) ----------
  for (const c of s.custody) {
    if (c.relatedTransferId && transferIds.has(c.relatedTransferId)) continue
    const tipo = c.origen === 'admin-pool'
      ? (c.reversesId ? 'Anulación de entrega de capital (custodia)' : c.tipo === 'BASE_ASSIGNMENT' ? 'Capital entregado al trabajador (custodia)' : 'Capital devuelto por el trabajador (custodia)')
      : c.tipo === 'BASE_ASSIGNMENT' ? 'Entrega de Base a trabajador'
        : c.tipo === 'BASE_RETURN' ? 'Devolución de Base a la caja de la ruta' : 'Traspaso de efectivo entre trabajadores'
    out.push({
      ...base('cashCustodyMovements', c.id, c.createdAt, c.fecha), categoria: 'custodia', tipo, importe: c.amount,
      origen: c.fromUserId ? { kind: 'trabajador', id: c.fromUserId, routeId: c.routeId } : { kind: 'caja-ruta', routeId: c.routeId },
      destino: c.toUserId ? { kind: 'trabajador', id: c.toUserId, routeId: c.routeId } : { kind: 'caja-ruta', routeId: c.routeId },
      routeIds: [c.routeId], workerIds: [c.fromUserId, c.toUserId].filter(Boolean) as string[], adminIds: [],
      registradoPor: c.createdByUserId, concepto: c.motivo, estado: c.reversesId ? 'correccion' : c.reversalId ? 'anulado' : 'vigente',
      extra: [['Efecto', 'Cambia quién responde por el efectivo; la Base de la ruta no cambia']],
    })
  }

  // ---------- Gastos ----------
  for (const x of s.expenses) {
    const f = expenseFundingOf(x)
    const st = poolExpenseStateOf(x)
    const correccion = st === 'anulacion' || st === 'reintegro'
    // De ruta o de trabajador: MISMA atribución que el motor de caja (incluye la
    // regla de los históricos sin clasificar).
    const atr = f.kind === 'ruta' ? expenseAttribution(x, s.hasCashbox) : undefined
    const titular = atr?.scope === 'trabajador' ? atr.cashHolderId : undefined
    const cuenta: HistoryAccount = f.kind === 'admin' ? { kind: 'bolsa-admin', id: f.adminId }
      : f.kind === 'empresa' ? { kind: 'bolsa-empresa' }
        : f.kind === 'historico' ? { kind: 'sin-bolsa' }
          : titular ? { kind: 'trabajador', id: titular, routeId: x.routeId } : { kind: 'caja-ruta', routeId: x.routeId }
    const tipo = st === 'anulacion' ? 'Anulación de gasto' : st === 'reintegro' ? 'Reintegro de gasto'
      : f.kind === 'ruta' ? (titular ? 'Gasto de trabajador' : 'Gasto de ruta')
        : f.kind === 'historico' ? 'Gasto de empresa (histórico, sin bolsa)' : 'Gasto administrativo'
    out.push({
      ...base('expenses', x.id, x.createdAt, x.fecha), categoria: correccion ? 'correccion' : 'gasto', tipo,
      importe: x.valor,
      origen: correccion ? { kind: 'proveedor' } : cuenta,
      destino: correccion ? cuenta : { kind: 'proveedor' },
      routeIds: x.routeId ? [x.routeId] : [], workerIds: titular ? [titular] : [],
      adminIds: f.kind === 'admin' ? [f.adminId] : [], registradoPor: x.userId,
      concepto: correccion ? x.reversalReason ?? x.descripcion : x.descripcion,
      estado: correccion ? 'correccion' : st === 'anulado' ? 'anulado' : st === 'historico' ? 'historico' : 'vigente',
      corrigeA: x.reversesId ? k('expenses', x.reversesId) : x.refundsExpenseId ? k('expenses', x.refundsExpenseId) : undefined,
      extra: [
        ...(x.categoryId ? [['Categoría', x.categoryId] as [string, string]] : []),
        ...(x.referencia ? [['Referencia del soporte', x.referencia] as [string, string]] : []),
      ],
    })
  }

  // ---------- Caja socios: solo movimientos MANUALES (los de transferencias son patas) ----------
  for (const p of s.partnerCash) {
    if (p.relatedTransferId) continue
    const entra = p.type === 'ingreso'
    out.push({
      ...base('partnerCashMovements', p.id, p.createdAt, p.fecha), categoria: p.reversesId ? 'correccion' : 'socios',
      tipo: entra ? 'Ingreso en Caja socios' : 'Salida de Caja socios', importe: p.amount,
      origen: entra ? { kind: 'externo' } : { kind: 'socio', id: p.partnerId },
      destino: entra ? { kind: 'socio', id: p.partnerId } : { kind: 'externo' },
      routeIds: [], workerIds: [], adminIds: [], partnerIds: [p.partnerId], registradoPor: p.createdBy,
      concepto: p.description, estado: p.reversesId ? 'correccion' : p.reversalId ? 'anulado' : 'vigente',
      corrigeA: p.reversesId ? k('partnerCashMovements', p.reversesId) : undefined,
      extra: [['Categoría', p.category]],
    })
  }

  // Enlaces inversos: el original sabe qué lo corrigió.
  const porKey = new Map(out.map(e => [e.key, e]))
  for (const e of out) if (e.corrigeA) porKey.get(e.corrigeA)?.corregidoPor.push(e.key)
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key))
}

// ------------------------------------------------------------
// Filtros (sobre entradas YA acotadas por permisos)
// ------------------------------------------------------------
export interface HistoryFilters {
  desde?: string
  hasta?: string
  categoria?: HistoryCategory
  routeId?: string
  adminId?: string
  workerId?: string
  partnerId?: string
  cuenta?: AccountKind
  estado?: HistoryState
  /** Prefijo o fragmento de la referencia (id). */
  referencia?: string
}

export function filterMovementHistory(entries: HistoryEntry[], f: HistoryFilters): HistoryEntry[] {
  const ref = f.referencia?.trim().toLowerCase()
  return entries.filter(e =>
    (!f.desde || e.fecha >= f.desde) && (!f.hasta || e.fecha <= f.hasta)
    && (!f.categoria || e.categoria === f.categoria)
    && (!f.routeId || e.routeIds.includes(f.routeId) || e.origen.routeId === f.routeId || e.destino.routeId === f.routeId)
    && (!f.adminId || e.adminIds.includes(f.adminId))
    && (!f.workerId || e.workerIds.includes(f.workerId))
    && (!f.partnerId || e.partnerIds.includes(f.partnerId))
    && (!f.cuenta || e.origen.kind === f.cuenta || e.destino.kind === f.cuenta)
    && (!f.estado || e.estado === f.estado)
    && (!ref || e.id.toLowerCase().includes(ref) || e.key.toLowerCase().includes(ref)))
}

/** Nombre legible de una cuenta (mismo texto en el historial y en el comprobante). */
export function accountLabel(a: HistoryAccount, nombres: { user: (id?: string) => string; route: (id?: string) => string }): string {
  switch (a.kind) {
    case 'externo': return 'Externo (fuera del sistema)'
    case 'bolsa-empresa': return 'Bolsa de la empresa'
    case 'bolsa-admin': return `Bolsa de ${nombres.user(a.id)}`
    case 'caja-ruta': return `Caja de la ruta ${nombres.route(a.routeId)}`
    case 'trabajador': return `En manos de ${nombres.user(a.id)}${a.routeId ? ` · ruta ${nombres.route(a.routeId)}` : ''}`
    case 'socio': return `Caja socios · ${nombres.user(a.id)}`
    case 'sin-bolsa': return 'Sin bolsa registrada (anterior al modelo)'
    case 'proveedor': return 'Pago de gasto (sale del sistema)'
  }
}

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  externo: 'Externo', 'bolsa-empresa': 'Bolsa de la empresa', 'bolsa-admin': 'Bolsa de Administrador', 'caja-ruta': 'Caja de ruta',
  trabajador: 'Trabajador', socio: 'Caja socios', 'sin-bolsa': 'Sin bolsa registrada', proveedor: 'Pago de gasto',
}

export const HISTORY_CATEGORY_LABEL: Record<HistoryCategory, string> = {
  capital: 'Capital', custodia: 'Base y custodia', transferencia: 'Transferencia', gasto: 'Gasto', socios: 'Caja socios', correccion: 'Corrección',
}
export const HISTORY_STATE_LABEL: Record<HistoryState, string> = {
  vigente: 'Vigente', anulado: 'Anulado', correccion: 'Corrección (anulación o reintegro)', historico: 'Histórico sin bolsa',
}
