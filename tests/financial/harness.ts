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
  constructor(private db: MemoryDb, private name: string) {}

  /** Dexie: Table.add — inserta; falla si la clave ya existe. */
  async add(obj: T): Promise<string> {
    this.db.note(`${this.name}.add`)
    this.db.maybeFail(`${this.name}.add`)
    const id = String(obj.id)
    if (this.rows.has(id)) throw new Error(`ConstraintError: ${this.name} ${id} ya existe`)
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
    for (const o of objs) this.rows.set(String(o.id), structuredClone(o))
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
  users = new FakeTable<any>(this, 'users')
  expenseCategories = new FakeTable<any>(this, 'expenseCategories')

  /** Bitácora ordenada de operaciones — evidencia del orden real de escrituras. */
  log: string[] = []
  private counters = new Map<string, number>()
  private fault: FaultConfig | null = null
  /** Profundidad de transacción activa (para verificar atomicidad). */
  private txDepth = 0

  note(op: string) {
    this.log.push(op)
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

  /** Dexie: db.transaction('rw', tablas, fn) con rollback total si fn lanza. */
  async transaction<T>(_mode: string, _tables: any, fn: () => PromiseLike<T>): Promise<T> {
    this.note('transaction:begin')
    this.txDepth++
    const snap = {
      payments: this.payments._snapshot(),
      installments: this.installments._snapshot(),
      sales: this.sales._snapshot(),
    }
    try {
      const r = await fn()
      this.note('transaction:commit')
      return r
    } catch (err) {
      this.payments._restore(snap.payments)
      this.installments._restore(snap.installments)
      this.sales._restore(snap.sales)
      this.note('transaction:rollback')
      throw err
    } finally {
      this.txDepth--
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
