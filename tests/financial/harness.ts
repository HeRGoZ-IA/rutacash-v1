// ============================================================
// HARNESS DE PRUEBAS FINANCIERAS — SOLO TEST, NO PRODUCCIÓN
// ------------------------------------------------------------
// Dexie necesita IndexedDB, que no existe en Node (verificado: `typeof indexedDB
// === 'undefined'` en Node v24). Instalar `fake-indexeddb` sería un cambio de
// dependencias, prohibido en esta etapa. Por eso este harness reproduce EN MEMORIA
// la superficie EXACTA de Dexie que usan los flujos de pago de producción:
//
//   db.installments.where('saleId').equals(id).toArray()
//   db.installments.update(id, changes)
//   db.payments.add(obj)
//   db.sales.update(id, changes)   /   db.sales.get(id)
//   db.transaction('rw', [...], fn)   → con ROLLBACK ante excepción (como Dexie)
//
// Semántica replicada deliberadamente:
//  · `toArray()` devuelve COPIAS (Dexie deserializa; mutar el resultado no toca la BD).
//  · `update()` hace merge superficial y devuelve 1 si existía, 0 si no.
//  · `transaction()` toma snapshot y RESTAURA todo si la callback lanza.
//
// Además permite INYECCIÓN DE FALLOS para probar atomicidad sin tocar producción.
// ============================================================
import type { Installment, Sale, Payment, PaymentFrequency } from '@/models/types'
import { generateInstallments, calculateTotalWithInterest } from '@/services/installmentEngine'

type Row = Record<string, any>

export class FakeTable<T extends Row> {
  private rows = new Map<string, T>()
  /**
   * Clave primaria de la tabla. Dexie permite declararla en el esquema y no siempre
   * es 'id': la ficha de control de empresa usa `companyId` (`companyControl:
   * 'companyId, status'`). El harness debe respetarlo o `get()` devolvería undefined
   * para filas que en el navegador sí existen.
   */
  constructor(private db: MemoryDb, readonly name: string, private readonly keyPath: string = 'id') {}

  private keyOf(obj: Row): string { return String(obj[this.keyPath]) }

  /** Dexie: Table.add — inserta; falla si la clave ya existe. */
  async add(obj: T): Promise<string> {
    this.db.note(`${this.name}.add`)
    this.db.maybeFail(`${this.name}.add`)
    const id = this.keyOf(obj)
    if (this.rows.has(id)) throw new Error(`ConstraintError: ${this.name} ${id} ya existe`)
    this.rows.set(id, structuredClone(obj))
    return id
  }

  /** Dexie: Table.put — inserta o reemplaza. */
  async put(obj: T): Promise<string> {
    this.db.note(`${this.name}.put`)
    this.db.maybeFail(`${this.name}.put`)
    const id = this.keyOf(obj)
    this.rows.set(id, structuredClone(obj))
    return id
  }

  async bulkAdd(objs: T[]): Promise<void> {
    for (const o of objs) await this.add(o)
  }

  /** Dexie: Table.update — merge superficial. Devuelve 1 si actualizó, 0 si no existía. */
  async update(id: string, changes: Partial<T>): Promise<number> {
    this.db.note(`${this.name}.update`)
    this.db.maybeFail(`${this.name}.update`)
    const cur = this.rows.get(String(id))
    if (!cur) return 0
    this.rows.set(String(id), { ...cur, ...structuredClone(changes) })
    return 1
  }

  /** Dexie: Table.delete — elimina por clave; no falla si no existe. */
  async delete(id: string): Promise<void> {
    this.db.note(`${this.name}.delete`)
    this.db.maybeFail(`${this.name}.delete`)
    this.rows.delete(String(id))
  }

  async get(id: string): Promise<T | undefined> {
    const r = this.rows.get(String(id))
    return r ? structuredClone(r) : undefined
  }

  async toArray(): Promise<T[]> {
    return [...this.rows.values()].map(r => structuredClone(r))
  }

  /** Dexie: Table.where(index).equals(value).toArray() / .first() / .count() */
  where(index: string) {
    const match = (value: unknown) => [...this.rows.values()].filter(r => r[index] === value)
    return {
      equals: (value: unknown) => ({
        toArray: async (): Promise<T[]> => {
          this.db.note(`${this.name}.where(${index}).toArray`)
          return match(value).map(r => structuredClone(r))
        },
        first: async (): Promise<T | undefined> => {
          this.db.note(`${this.name}.where(${index}).first`)
          const r = match(value)[0]
          return r ? structuredClone(r) : undefined
        },
        count: async (): Promise<number> => match(value).length,
      }),
    }
  }

  /** Solo para el harness: sembrar sin registrar la operación ni disparar fallos. */
  _seed(objs: T[]) {
    for (const o of objs) this.rows.set(this.keyOf(o), structuredClone(o))
  }

  _snapshot(): Array<[string, T]> {
    return [...this.rows.entries()].map(([k, v]) => [k, structuredClone(v)] as [string, T])
  }

  _restore(snap: Array<[string, T]>) {
    this.rows = new Map(snap.map(([k, v]) => [k, structuredClone(v)]))
  }
}

export interface FaultConfig {
  /** Lanza al ejecutar la N-ésima operación indicada (1 = la primera). */
  op: string
  nth: number
  message?: string
}

export class MemoryDb {
  payments = new FakeTable<any>(this, 'payments')
  installments = new FakeTable<Installment>(this, 'installments')
  sales = new FakeTable<Sale>(this, 'sales')
  // Solo de lectura: las necesita el diagnóstico de conciliación para nombrar
  // clientes y rutas en el informe.
  clients = new FakeTable<any>(this, 'clients')
  routes = new FakeTable<any>(this, 'routes')
  // Arranque de instalación limpia y autenticación (tests/bootstrap.test.ts).
  tenants = new FakeTable<any>(this, 'tenants')
  // Oficinas (Empresa → Oficina → Ruta). Debe estar en TABLES para que el
  // zero-state siga siendo exhaustivo: una tabla ausente aquí deja de verificarse.
  offices = new FakeTable<any>(this, 'offices')
  users = new FakeTable<any>(this, 'users')
  expenseCategories = new FakeTable<any>(this, 'expenseCategories')
  expenses = new FakeTable<any>(this, 'expenses')
  noPaymentVisits = new FakeTable<any>(this, 'noPaymentVisits')
  // Motor de caja / liquidación semanal (CashboxDatabase).
  capitalMovements = new FakeTable<any>(this, 'capitalMovements')
  transfers = new FakeTable<any>(this, 'transfers')
  withdrawals = new FakeTable<any>(this, 'withdrawals')
  // Liquidaciones semanales PERSISTENTES (cierre y reapertura de periodo).
  weeklySettlements = new FakeTable<any>(this, 'weeklySettlements')
  // PLANO DE CONTROL SaaS (nivel plataforma). Están en TABLES para que el zero-state
  // siga siendo exhaustivo: una instalación CLEAN nace con estas tablas también en 0.
  // `companyControl` lleva `companyId` como clave primaria, igual que en el esquema.
  platformUsers = new FakeTable<any>(this, 'platformUsers')
  companyControl = new FakeTable<any>(this, 'companyControl', 'companyId')
  saasPayments = new FakeTable<any>(this, 'saasPayments')
  controlEvents = new FakeTable<any>(this, 'controlEvents')

  /** Nombres de todas las tablas, para conteos exhaustivos en las pruebas. */
  static readonly TABLES = [
    'users', 'tenants', 'offices', 'routes', 'clients', 'sales', 'installments',
    'payments', 'expenses', 'expenseCategories', 'noPaymentVisits',
    'capitalMovements', 'transfers', 'withdrawals', 'weeklySettlements',
    'platformUsers', 'companyControl', 'saasPayments', 'controlEvents',
  ] as const

  /**
   * Equivalente a `db.delete()` seguido de reabrir la base: deja TODAS las tablas
   * vacías, como queda IndexedDB tras `resetLocalAppData()` y la recarga.
   */
  async clearAll(): Promise<void> {
    for (const t of MemoryDb.TABLES) {
      (this as unknown as Record<string, FakeTable<any>>)[t]._restore([])
    }
    this.resetLog()
  }

  /** Conteo de filas por tabla. */
  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const t of MemoryDb.TABLES) {
      out[t] = (await (this as unknown as Record<string, FakeTable<any>>)[t].toArray()).length
    }
    return out
  }

  /** Bitácora ordenada de operaciones — evidencia del orden real de escrituras. */
  log: string[] = []
  private counters = new Map<string, number>()
  private fault: FaultConfig | null = null
  /** Profundidad de transacción activa (para verificar atomicidad). */
  private txDepth = 0
  /** Tablas DECLARADAS en el alcance de la transacción activa (contrato de Dexie). */
  private txScope: Set<string> | null = null

  note(op: string) {
    // El nombre de la tabla es el prefijo de la operación ("payments.add", ...).
    const tabla = op.split('.')[0]
    if (MemoryDb.TABLES.includes(tabla as never)) this.assertTableInTransaction(tabla)
    this.log.push(op)
  }

  /**
   * CONTRATO DE DEXIE: dentro de `db.transaction(mode, tablas, fn)` solo pueden
   * usarse las tablas DECLARADAS en el alcance. Dexie lanza
   * `NotFoundError: Table X not part of transaction` (ver Table.prototype._trans
   * y Transaction.prototype.table en dexie/dist/dexie.js) y el error NO es un
   * rechazo de negocio: aborta la operación entera.
   *
   * El harness replicaba todo Dexie MENOS esta regla, así que una tabla leída
   * fuera de alcance pasaba las pruebas y reventaba en el navegador. Ahora se
   * replica también.
   */
  private assertTableInTransaction(tabla: string) {
    if (this.txDepth === 0) return
    if (this.txScope === null) return          // alcance no declarado: no se exige
    if (this.txScope.has(tabla)) return
    const err = new Error(`Table ${tabla} not part of transaction`)
    err.name = 'NotFoundError'
    throw err
  }

  maybeFail(op: string) {
    if (!this.fault || this.fault.op !== op) return
    const n = (this.counters.get(op) ?? 0) + 1
    this.counters.set(op, n)
    if (n === this.fault.nth) {
      throw new Error(this.fault.message ?? `FALLO INYECTADO en ${op} #${n}`)
    }
  }

  injectFault(fault: FaultConfig | null) {
    this.fault = fault
    this.counters.clear()
  }

  /**
   * Dexie: db.transaction('rw', tablas, fn) con rollback total si fn lanza.
   *
   * Se replican DOS reglas de Dexie:
   *  · ALCANCE: solo las tablas declaradas pueden tocarse dentro (ver
   *    `assertTableInTransaction`). Una tabla fuera de alcance lanza NotFoundError.
   *  · ROLLBACK: se restauran TODAS las tablas del alcance, no un trío fijo.
   */
  async transaction<T>(_mode: string, tables: unknown, fn: () => PromiseLike<T>): Promise<T> {
    const declaradas = (Array.isArray(tables) ? tables : [tables])
      .map(t => (t as FakeTable<Row> | undefined)?.name)
      .filter((n): n is string => typeof n === 'string')
    const scopePrevio = this.txScope
    // Transacción anidada: Dexie exige que el alcance interno esté contenido en el
    // externo; aquí basta con conservar el más restrictivo (el externo).
    this.txScope = this.txDepth === 0
      ? (declaradas.length > 0 ? new Set(declaradas) : null)
      : scopePrevio

    this.log.push('transaction:begin')
    this.txDepth++
    const alcance = this.txScope ? [...this.txScope] : [...MemoryDb.TABLES]
    const tablas = (this as unknown as Record<string, FakeTable<Row>>)
    const snap = alcance
      .filter(t => tablas[t] instanceof FakeTable)
      .map(t => [t, tablas[t]._snapshot()] as const)
    try {
      const r = await fn()
      this.log.push('transaction:commit')
      return r
    } catch (err) {
      for (const [t, rows] of snap) tablas[t]._restore(rows)
      this.log.push('transaction:rollback')
      throw err
    } finally {
      this.txDepth--
      this.txScope = this.txDepth === 0 ? null : scopePrevio
    }
  }

  /** ¿Las escrituras registradas ocurrieron dentro de una transacción? */
  usedTransaction(): boolean {
    return this.log.includes('transaction:begin')
  }

  resetLog() {
    this.log = []
    this.counters.clear()
  }
}

// ------------------------------------------------------------
// Constructores de escenarios
// ------------------------------------------------------------

export interface ScenarioOptions {
  valorVenta: number
  tasaInteres?: number
  numeroCuotas: number
  frecuencia?: PaymentFrequency
  fechaInicio?: string
  paymentDays?: number[]
  /** Marca las N primeras parcelas como totalmente pagadas (simula historial). */
  parcelasPagadas?: number
  /** Abono ya aplicado a la primera parcela no pagada. */
  abonoPrevioParcelaActual?: number
  status?: Sale['status']
  disbursementStatus?: Sale['disbursementStatus']
}

export interface Scenario {
  db: MemoryDb
  sale: Sale
  installments: Installment[]
}

const SALE_ID = 'sale-test-001'
const TENANT_ID = 'tenant-test'
const ROUTE_ID = 'route-test'
const CLIENT_ID = 'client-test'

/** Construye una venta con parcelas coherentes dentro de una BD en memoria. */
export function buildScenario(opts: ScenarioOptions): Scenario {
  const tasaInteres = opts.tasaInteres ?? 20
  const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: opts.valorVenta, tasaInteres })
  const valorCuota = Math.round(valorTotal / opts.numeroCuotas)
  const installments = generateInstallments({
    saleId: SALE_ID,
    valorTotal,
    numeroCuotas: opts.numeroCuotas,
    valorCuota,
    frecuencia: opts.frecuencia ?? 'diaria',
    fechaInicio: opts.fechaInicio ?? '2026-08-19',
    paymentDays: opts.paymentDays,
  })

  const yaPagadas = opts.parcelasPagadas ?? 0
  for (let i = 0; i < yaPagadas && i < installments.length; i++) {
    installments[i].pagado = installments[i].valor
    installments[i].saldo = 0
    installments[i].status = 'pagada'
  }
  if (opts.abonoPrevioParcelaActual && yaPagadas < installments.length) {
    const actual = installments[yaPagadas]
    actual.pagado = opts.abonoPrevioParcelaActual
    actual.saldo = actual.valor - opts.abonoPrevioParcelaActual
    actual.status = 'parcial'
  }

  const saldo = installments.reduce((s, i) => s + i.saldo, 0)

  const sale: Sale = {
    id: SALE_ID,
    tenantId: TENANT_ID,
    routeId: ROUTE_ID,
    clientId: CLIENT_ID,
    createdByUserId: 'user-test',
    valorVenta: opts.valorVenta,
    tasaInteres,
    valorInteres,
    valorTotal,
    saldo,
    numeroCuotas: opts.numeroCuotas,
    valorCuota,
    frecuenciaPago: opts.frecuencia ?? 'diaria',
    paymentDays: opts.paymentDays,
    fechaInicio: opts.fechaInicio ?? '2026-08-19',
    fechaFinalEstimada: '2026-12-31',
    status: opts.status ?? 'activa',
    disbursementStatus: opts.disbursementStatus,
    createdAt: '2026-08-19T08:00:00.000Z',
    updatedAt: '2026-08-19T08:00:00.000Z',
  }

  const db = new MemoryDb()
  db.sales._seed([sale])
  db.installments._seed(installments)
  db.clients._seed([{ id: CLIENT_ID, tenantId: TENANT_ID, routeId: ROUTE_ID, nombre: 'Cliente de prueba', documento: '123' }])
  db.routes._seed([{ id: ROUTE_ID, tenantId: TENANT_ID, nombre: 'Ruta Norte' }])
  db.resetLog()

  return { db, sale: structuredClone(sale), installments: structuredClone(installments) }
}

// ------------------------------------------------------------
// Lectores de estado financiero (para aserciones e invariantes)
// ------------------------------------------------------------

export interface FinancialState {
  saleSaldo: number
  saleStatus: Sale['status']
  totalAplicadoAParcelas: number
  totalRegistradoEnPayments: number
  parcelas: Array<{ numero: number; valor: number; pagado: number; saldo: number; status: string }>
  ultimaParcelaPagada: number
  parcelaActual: number | null
}

export async function readFinancialState(db: MemoryDb): Promise<FinancialState> {
  const insts = (await db.installments.toArray()).sort((a, b) => a.numero - b.numero)
  const pays = await db.payments.toArray()
  const sale = await db.sales.get(SALE_ID)
  const pagadas = insts.filter(i => i.status === 'pagada' || (i.pagado > 0 && i.saldo <= 0))
  const actual = insts.find(i => i.status !== 'pagada')
  return {
    saleSaldo: sale?.saldo ?? NaN,
    saleStatus: sale?.status ?? 'activa',
    totalAplicadoAParcelas: insts.reduce((s, i) => s + i.pagado, 0),
    totalRegistradoEnPayments: pays.reduce((s, p) => s + p.valor, 0),
    parcelas: insts.map(i => ({ numero: i.numero, valor: i.valor, pagado: i.pagado, saldo: i.saldo, status: i.status })),
    ultimaParcelaPagada: pagadas.reduce((m, i) => Math.max(m, i.numero), 0),
    parcelaActual: actual?.numero ?? null,
  }
}

/**
 * TRANSCRIPCIÓN del cálculo de `cobros` de cashboxEngine.getCashboxSummary
 * (src/services/cashboxEngine.ts, líneas 22-26):
 *
 *   const payments = await db.payments.where('routeId').equals(routeId).toArray()
 *   const cobros = payments
 *     .filter(p => p.fecha >= desde && p.fecha <= hasta)
 *     .reduce((sum, p) => sum + p.valor, 0)
 *
 * Sin tope, sin filtro por `state`, sin contraste contra lo aplicado a parcelas.
 */
export async function computeCobrosComoCaja(db: MemoryDb, routeId = ROUTE_ID): Promise<number> {
  const payments = await db.payments.toArray()
  return payments.filter((p: Payment) => p.routeId === routeId).reduce((sum: number, p: Payment) => sum + p.valor, 0)
}

export const TEST_IDS = { SALE_ID, TENANT_ID, ROUTE_ID, CLIENT_ID }

// ------------------------------------------------------------
// Escenario de CAJA / LIQUIDACIÓN (varias rutas en la misma empresa)
// ------------------------------------------------------------
/**
 * Movimientos de una ruta para probar el aislamiento del motor de caja.
 * Todas las cifras son explícitas: cada prueba declara exactamente lo que siembra.
 */
export interface RouteMovements {
  routeId: string
  nombre?: string
  codigo?: string
  tenantId?: string
  capital?: Array<{ fecha: string; valor: number }>
  pagos?: Array<{ fecha: string; valor: number; collectorId?: string; state?: string; clientId?: string; saleId?: string }>
  ventas?: Array<{ fechaInicio: string; valorVenta: number; createdByUserId?: string; collectorId?: string; disbursementStatus?: Sale['disbursementStatus']; status?: Sale['status'] }>
  gastos?: Array<{ fecha: string; valor: number; userId?: string; collectorId?: string }>
  retiros?: Array<{ fecha: string; valor: number }>
  transferenciasSalida?: Array<{ fecha: string; valor: number; routeDestinoId?: string }>
  transferenciasEntrada?: Array<{ fecha: string; valor: number; routeOrigenId?: string }>
}

let _seq = 0
const nextId = (p: string) => `${p}-${++_seq}`

/**
 * Base en memoria con varias rutas y sus movimientos. Sirve para verificar que el
 * cálculo de una ruta NUNCA incorpora movimientos de otra.
 */
export function buildCashboxScenario(routes: RouteMovements[], tenantId = TENANT_ID): MemoryDb {
  const db = new MemoryDb()
  for (const r of routes) {
    const tid = r.tenantId ?? tenantId
    db.routes._seed([{ id: r.routeId, tenantId: tid, nombre: r.nombre ?? r.routeId, codigo: r.codigo ?? r.routeId, status: 'activa' }])
    db.capitalMovements._seed((r.capital ?? []).map(c => ({
      id: nextId('cap'), tenantId: tid, routeId: r.routeId, tipo: 'ingresoCapital',
      valor: c.valor, fecha: c.fecha, userId: 'u-seed', createdAt: c.fecha,
    })))
    db.payments._seed((r.pagos ?? []).map(p => ({
      id: nextId('pay'), tenantId: tid, routeId: r.routeId,
      saleId: p.saleId ?? nextId('sale'), clientId: p.clientId ?? nextId('cli'),
      collectorId: p.collectorId ?? 'u-cob-default',
      valor: p.valor, fecha: p.fecha, tipo: 'efectivo', syncStatus: 'synced',
      createdAt: `${p.fecha}T10:00:00.000Z`, state: p.state ?? 'active',
    })))
    db.sales._seed((r.ventas ?? []).map(v => ({
      id: nextId('sale'), tenantId: tid, routeId: r.routeId, clientId: nextId('cli'),
      createdByUserId: v.createdByUserId ?? 'u-seed',
      collectorId: v.collectorId,
      valorVenta: v.valorVenta, tasaInteres: 20, valorInteres: 0, valorTotal: v.valorVenta,
      saldo: v.valorVenta, numeroCuotas: 1, valorCuota: v.valorVenta, frecuenciaPago: 'diaria',
      fechaInicio: v.fechaInicio, fechaFinalEstimada: v.fechaInicio,
      status: v.status ?? 'activa', disbursementStatus: v.disbursementStatus,
      createdAt: `${v.fechaInicio}T09:00:00.000Z`, updatedAt: `${v.fechaInicio}T09:00:00.000Z`,
    })) as unknown as Sale[])
    db.expenses._seed((r.gastos ?? []).map(g => ({
      id: nextId('exp'), tenantId: tid, routeId: r.routeId, categoryId: 'cat-1',
      valor: g.valor, fecha: g.fecha, userId: g.userId ?? 'u-seed', collectorId: g.collectorId,
      syncStatus: 'synced', createdAt: `${g.fecha}T11:00:00.000Z`,
    })))
    db.withdrawals._seed((r.retiros ?? []).map(w => ({
      id: nextId('wd'), tenantId: tid, routeId: r.routeId,
      valor: w.valor, fecha: w.fecha, userId: 'u-seed', createdAt: w.fecha,
    })))
    db.transfers._seed([
      ...(r.transferenciasSalida ?? []).map(t => ({
        id: nextId('tr'), tenantId: tid, routeOrigenId: r.routeId, routeDestinoId: t.routeDestinoId ?? '',
        origenType: 'route', destinoType: 'route', valor: t.valor, fecha: t.fecha, userId: 'u-seed', createdAt: t.fecha,
      })),
      ...(r.transferenciasEntrada ?? []).map(t => ({
        id: nextId('tr'), tenantId: tid, routeOrigenId: t.routeOrigenId ?? '', routeDestinoId: r.routeId,
        origenType: 'route', destinoType: 'route', valor: t.valor, fecha: t.fecha, userId: 'u-seed', createdAt: t.fecha,
      })),
    ])
  }
  db.resetLog()
  return db
}
