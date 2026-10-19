// PUENTE de `src/lib/db.ts` (CLEAN) para ADEX Online.
//
// Misma forma de uso que la base Dexie de CLEAN (`db.routes.where('tenantId').equals(x)
// .toArray()`, `db.users.get(id)`…), pero respondida por la PROYECCIÓN DE LECTURA del
// servidor (`runtime/projection.ts`): solo memoria, solo lectura. Cualquier escritura
// lanza `OnlineWriteBlocked`: en ADEX Online el dinero y las altas se confirman SIEMPRE
// con un comando de la API (servicios del puente), nunca en el dispositivo.

import type {
  AuditLog, CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, CashSettlement, CashboxMovement, Client, Expense, ExpenseCategory,
  Installment, NoPaymentVisit, Office, PartnerCashMovement, Payment, PaymentAdjustmentRequest, Route, RouteCapitalControllerEvent, Sale,
  SaleRequest, Tenant, Transfer, User, WeeklySettlement, Withdrawal,
} from '@clean/models/types';
import { ALL_TABLES, GAP_TABLES, OnlineWriteBlocked, ServerGap, table as load } from '../../runtime/projection.ts';
import { gapCount, writeAdapter } from '../../runtime/writes.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pred<T> = (x: T) => boolean;

function valueOf(row: any, key: string): any {
  if (key.startsWith('[') && key.endsWith(']')) return key.slice(1, -1).split('+').map((k) => row?.[k]);
  return row?.[key];
}
function same(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}
function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

export class Collection<T> {
  constructor(
    private readonly tableName: string,
    private readonly preds: Pred<T>[] = [],
    private readonly desc = false,
    private readonly order: string | null = null,
    private readonly lim: number | null = null,
    private readonly off = 0,
  ) {}
  private next(o: Partial<{ preds: Pred<T>[]; desc: boolean; order: string | null; lim: number | null; off: number }>): Collection<T> {
    return new Collection<T>(this.tableName, o.preds ?? this.preds, o.desc ?? this.desc, o.order !== undefined ? o.order : this.order,
      o.lim !== undefined ? o.lim : this.lim, o.off ?? this.off);
  }
  and(fn: Pred<T>): Collection<T> { return this.next({ preds: [...this.preds, fn] }); }
  filter(fn: Pred<T>): Collection<T> { return this.and(fn); }
  reverse(): Collection<T> { return this.next({ desc: !this.desc }); }
  limit(n: number): Collection<T> { return this.next({ lim: n }); }
  offset(n: number): Collection<T> { return this.next({ off: n }); }
  async toArray(): Promise<T[]> {
    let rows = ((await load(this.tableName)) as T[]).filter((r) => this.preds.every((p) => p(r)));
    if (this.order) rows = [...rows].sort((a, b) => cmp(valueOf(a, this.order!), valueOf(b, this.order!)));
    if (this.desc) rows = [...rows].reverse();
    rows = rows.slice(this.off, this.lim === null ? undefined : this.off + this.lim);
    // Copias: una pantalla que mute el objeto no altera la proyección compartida.
    return rows.map((r) => ({ ...r }));
  }
  async count(): Promise<number> { return (await this.toArray()).length; }
  async first(): Promise<T | undefined> { return (await this.toArray())[0]; }
  async last(): Promise<T | undefined> { const a = await this.toArray(); return a[a.length - 1]; }
  async sortBy(key: string): Promise<T[]> {
    const rows = await this.next({ desc: false }).toArray();
    rows.sort((a, b) => cmp(valueOf(a, key), valueOf(b, key)));
    return this.desc ? rows.reverse() : rows;
  }
  async each(fn: (x: T) => void): Promise<void> { (await this.toArray()).forEach(fn); }
  async primaryKeys(): Promise<string[]> { return (await this.toArray()).map((r: any) => r.id); }
  async keys(): Promise<string[]> { return this.primaryKeys(); }
  async modify(_changes: unknown): Promise<never> { throw new OnlineWriteBlocked(this.tableName, 'modify'); }
  async delete(): Promise<never> { throw new OnlineWriteBlocked(this.tableName, 'delete'); }
}

class WhereClause<T> {
  constructor(private readonly t: ServerTable<T>, private readonly key: string) {}
  private c(fn: (v: any) => boolean): Collection<T> { return this.t.filter((r: T) => fn(valueOf(r, this.key))); }
  equals(v: any) { return this.c((x) => same(x, v)); }
  notEqual(v: any) { return this.c((x) => !same(x, v)); }
  anyOf(...vs: any[]) { const list = (vs.length === 1 && Array.isArray(vs[0]) ? vs[0] : vs) as any[]; return this.c((x) => list.some((v) => same(x, v))); }
  noneOf(vs: any[]) { return this.c((x) => !vs.some((v) => same(x, v))); }
  above(v: any) { return this.c((x) => cmp(x, v) > 0); }
  aboveOrEqual(v: any) { return this.c((x) => cmp(x, v) >= 0); }
  below(v: any) { return this.c((x) => cmp(x, v) < 0); }
  belowOrEqual(v: any) { return this.c((x) => cmp(x, v) <= 0); }
  between(a: any, b: any, incLower = true, incUpper = false) {
    return this.c((x) => (incLower ? cmp(x, a) >= 0 : cmp(x, a) > 0) && (incUpper ? cmp(x, b) <= 0 : cmp(x, b) < 0));
  }
  startsWith(p: string) { return this.c((x) => typeof x === 'string' && x.startsWith(p)); }
  startsWithIgnoreCase(p: string) { return this.c((x) => typeof x === 'string' && x.toLowerCase().startsWith(p.toLowerCase())); }
  equalsIgnoreCase(v: string) { return this.c((x) => typeof x === 'string' && x.toLowerCase() === v.toLowerCase()); }
}

const GAPS = new Set<string>(GAP_TABLES);

export class ServerTable<T> {
  constructor(readonly name: string) {}
  where(key: string | Record<string, unknown>): WhereClause<T> & Collection<T> {
    if (typeof key === 'object') return this.filter((r: any) => Object.entries(key).every(([k, v]) => same(r?.[k], v))) as any;
    // Tabla del libro local sin equivalente: solo se admite CONTAR historia por ruta
    // (`writes.gapCount`); leer filas sigue siendo un `ServerGap`.
    if (GAPS.has(this.name)) {
      const table = this.name;
      // Colección de solo-conteo: `.and()/.filter()` conservan el conteo de historia; leer
      // filas sigue fallando como dato pendiente.
      const gapCollection = (v: unknown): any => {
        const c: any = {
          and: () => c, filter: () => c, reverse: () => c, limit: () => c, offset: () => c,
          count: () => gapCount(table, key, v),
          toArray: () => Promise.reject(new ServerGap(table)), first: () => Promise.reject(new ServerGap(table)),
          sortBy: () => Promise.reject(new ServerGap(table)), each: () => Promise.reject(new ServerGap(table)),
        };
        return c;
      };
      return { equals: gapCollection, anyOf: () => gapCollection(undefined) } as any;
    }
    return new WhereClause<T>(this, key) as any;
  }
  filter(fn: Pred<T>): Collection<T> { return new Collection<T>(this.name, [fn]); }
  orderBy(key: string): Collection<T> { return new Collection<T>(this.name, [], false, key); }
  reverse(): Collection<T> { return new Collection<T>(this.name, [], true); }
  limit(n: number): Collection<T> { return new Collection<T>(this.name).limit(n); }
  toArray(): Promise<T[]> { return new Collection<T>(this.name).toArray(); }
  count(): Promise<number> { return new Collection<T>(this.name).count(); }
  toCollection(): Collection<T> { return new Collection<T>(this.name); }
  each(fn: (x: T) => void): Promise<void> { return new Collection<T>(this.name).each(fn); }
  async get(key: string | Record<string, unknown>): Promise<T | undefined> {
    if (key === undefined || key === null) return undefined;
    if (typeof key === 'object') return this.where(key).first();
    const row = ((await load(this.name)) as any[]).find((r) => r.id === key);
    return row ? { ...row } : undefined;
  }
  async bulkGet(keys: string[]): Promise<(T | undefined)[]> { return Promise.all(keys.map((k) => this.get(k))); }
  // Escrituras: solo las de la lista blanca de `runtime/writes.ts` (traducidas a un
  // comando de la API). Cualquier otra falla cerrada.
  async add(row: T): Promise<unknown> {
    const w = writeAdapter(this.name, 'add');
    if (!w) throw new OnlineWriteBlocked(this.name, 'add');
    return w(row as Record<string, unknown>);
  }
  async put(_row: T): Promise<never> { throw new OnlineWriteBlocked(this.name, 'put'); }
  async update(id: string, changes: Partial<T> | Record<string, unknown>): Promise<number> {
    const w = writeAdapter(this.name, 'update');
    if (!w) throw new OnlineWriteBlocked(this.name, 'update');
    await w(id, changes as Record<string, unknown>);
    return 1;
  }
  async delete(id: string): Promise<void> {
    const w = writeAdapter(this.name, 'delete');
    if (!w) throw new OnlineWriteBlocked(this.name, 'delete');
    await w(id);
  }
  async bulkAdd(_rows: T[]): Promise<never> { throw new OnlineWriteBlocked(this.name, 'bulkAdd'); }
  async bulkPut(_rows: T[]): Promise<never> { throw new OnlineWriteBlocked(this.name, 'bulkPut'); }
  async bulkDelete(_keys: string[]): Promise<never> { throw new OnlineWriteBlocked(this.name, 'bulkDelete'); }
  async clear(): Promise<never> { throw new OnlineWriteBlocked(this.name, 'clear'); }
}

export class RutaCashDB {
  /** Versión de esquema (CLEAN la lee para sus respaldos). No hay esquema local en ADEX Online. */
  readonly verno = 0;
  tenants = new ServerTable<Tenant>('tenants');
  offices = new ServerTable<Office>('offices');
  routes = new ServerTable<Route>('routes');
  users = new ServerTable<User>('users');
  clients = new ServerTable<Client>('clients');
  sales = new ServerTable<Sale>('sales');
  installments = new ServerTable<Installment>('installments');
  payments = new ServerTable<Payment>('payments');
  noPaymentVisits = new ServerTable<NoPaymentVisit>('noPaymentVisits');
  expenseCategories = new ServerTable<ExpenseCategory>('expenseCategories');
  expenses = new ServerTable<Expense>('expenses');
  capitalMovements = new ServerTable<CapitalMovement>('capitalMovements');
  transfers = new ServerTable<Transfer>('transfers');
  withdrawals = new ServerTable<Withdrawal>('withdrawals');
  cashboxMovements = new ServerTable<CashboxMovement>('cashboxMovements');
  weeklySettlements = new ServerTable<WeeklySettlement>('weeklySettlements');
  auditLogs = new ServerTable<AuditLog>('auditLogs');
  saleRequests = new ServerTable<SaleRequest>('saleRequests');
  partnerCashMovements = new ServerTable<PartnerCashMovement>('partnerCashMovements');
  paymentAdjustmentRequests = new ServerTable<PaymentAdjustmentRequest>('paymentAdjustmentRequests');
  cashSettlements = new ServerTable<CashSettlement>('cashSettlements');
  cashCustodyMovements = new ServerTable<CashCustodyMovement>('cashCustodyMovements');
  capitalLedger = new ServerTable<CapitalLedgerEntry>('capitalLedger');
  routeCapitalControllerEvents = new ServerTable<RouteCapitalControllerEvent>('routeCapitalControllerEvents');
  platformUsers = new ServerTable<unknown>('platformUsers');
  companyControl = new ServerTable<unknown>('companyControl');
  saasPayments = new ServerTable<unknown>('saasPayments');
  controlEvents = new ServerTable<unknown>('controlEvents');

  get tables(): ServerTable<unknown>[] { return ALL_TABLES.map((n) => (this as any)[n]).filter(Boolean); }
  table(name: string): ServerTable<unknown> { return (this as any)[name]; }

  /** Las transacciones de lectura se ejecutan tal cual; una escritura dentro fallará cerrada. */
  async transaction<R>(...args: any[]): Promise<R> {
    const fn = args[args.length - 1] as () => R | Promise<R>;
    return fn();
  }
}

export const db = new RutaCashDB();

export async function clearAndResetDB(): Promise<never> {
  throw new OnlineWriteBlocked('db', 'clearAndResetDB');
}
