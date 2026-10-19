// PROYECCIÓN DE LECTURA DEL SERVIDOR con la forma de las tablas de CLEAN.
//
// Las pantallas originales de CLEAN leen con `db.<tabla>.where(...).toArray()`. En ADEX
// Online esas lecturas se responden con lo que devuelve la API, convertido al modelo de
// CLEAN (`mappers.ts`). Reglas que no se negocian:
//
//   · SOLO MEMORIA Y SOLO LECTURA. Nada se guarda en el dispositivo y ninguna escritura
//     se aplica aquí: `add/put/update/delete` lanzan `OnlineWriteBlocked`. Las operaciones
//     reales van por comandos de la API (servicios del puente) y después se invalida.
//   · SIN LIBRO PARALELO. Los registros de capital (libro, capital, retiros,
//     transferencias, custodia) son VISTAS de las operaciones del libro central del
//     servidor (capitalRecords.ts): sirven para listar y consultar, nunca para sumar
//     saldos. Los saldos y cifras los dan los agregados del servidor en los servicios del
//     puente. Lo que el servidor no tiene (Caja socios, auditoría local…) lanza `ServerGap`.
//   · ALCANCE DEL SERVIDOR. Cada listado llega ya recortado por empresa y rutas del
//     contexto activo (RLS + autorización): aquí no se amplía nada.
//   · Refresco: cada tabla se carga una vez por revisión; la revisión sube tras cada
//     comando confirmado y cada 20 s con la pestaña visible (sin WebSockets).

import { ApiFailure } from '../lib/client.ts';
import { buildCapitalRecords, fetchOperations, type CapitalRecords } from './capitalRecords.ts';
import { api, useRuntime } from './session.ts';
import {
  cashSettlementFrom, categoryFrom, clientFrom, expenseFrom, weeklySettlementFrom, installmentFrom, officeFrom, paymentFrom, routeFrom, saleFrom, saleRequestFrom, tenantFrom, userFrom,
  type CompanyView,
} from './mappers.ts';

/** Una escritura local que CLEAN haría sobre IndexedDB y que ADEX Online no permite. */
export class OnlineWriteBlocked extends Error {
  constructor(table: string, op: string) {
    super(`Esta operación todavía no está conectada al servidor en ADEX Online (${table}.${op}). No se guardó nada.`);
    this.name = 'OnlineWriteBlocked';
  }
}

/** Lectura de una tabla del libro local de CLEAN que no tiene equivalente directo en la API. */
export class ServerGap extends Error {
  readonly table: string;
  constructor(table: string) {
    super(`Dato no disponible en el servidor con la forma de CLEAN (${table}). Pendiente de conexión.`);
    this.name = 'ServerGap';
    this.table = table;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
type Loader = () => Promise<Row[]>;

const can = (c: string) => useRuntime.getState().ctx?.capabilities.includes(c) ?? false;

/** Lista del servidor; 403 = fuera del alcance del rol → lista vacía (nunca se amplía). */
async function list(path: string, key: string): Promise<Row[]> {
  try {
    const body = await api().get<Record<string, unknown>>(path);
    const rows = (body[key] ?? []) as Row[];
    if (LIST_CAPS[path] !== undefined && rows.length >= LIST_CAPS[path]!) truncated.add(path);
    return rows;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 403) return [];
    throw e;
  }
}

/** Topes de los listados del servidor: si se alcanzan, la tabla puede estar incompleta. */
const LIST_CAPS: Record<string, number> = { '/v1/clients?limit=1000': 1000, '/v1/credits': 500, '/v1/credit-requests': 500, '/v1/collections?limit=500': 500, '/v1/expenses?limit=500': 500, '/v1/settlements?limit=500': 500 };
export const truncated = new Set<string>();

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const LOADERS: Record<string, Loader> = {
  tenants: async () => [tenantFrom(await api().get<CompanyView>('/v1/company'))],
  users: async () => {
    if (can('user.viewAll')) return (await list('/v1/members', 'members')).map(userFrom);
    const ctx = useRuntime.getState().ctx!;
    return [userFrom({ membershipId: ctx.membershipId, role: ctx.role, status: 'activo', displayName: '', routeIds: ctx.routeIds })];
  },
  routes: async () => (await list('/v1/routes', 'routes')).map(routeFrom),
  offices: async () => (await list('/v1/offices', 'offices')).map(officeFrom),
  clients: async () => (can('client.view') ? (await list('/v1/clients?limit=1000', 'clients')).map(clientFrom) : []),
  sales: async () => (can('sale.viewActive') || can('sale.viewHistory') ? (await list('/v1/credits', 'credits')).map(saleFrom) : []),
  installments: async () => {
    const sales = await table('sales');
    const parts = await mapLimit(sales, 4, async (s) => {
      const body = await api().get<{ installments: Row[] }>(`/v1/credits/${s['id']}`);
      return (body.installments ?? []).map((i) => installmentFrom(String(s['id']), i));
    });
    return parts.flat();
  },
  payments: async () => (can('payment.viewHistory') ? (await list('/v1/collections?limit=500', 'collections')).map(paymentFrom) : []),
  expenses: async () => (can('expense.register') || can('expense.correct') ? (await list('/v1/expenses?limit=500', 'expenses')).map(expenseFrom) : []),
  expenseCategories: async () => (await list('/v1/expense-categories', 'categories')).map(categoryFrom),
  saleRequests: async () => (can('authorization.access') || can('sale.createRequest') ? (await list('/v1/credit-requests', 'requests')).map(saleRequestFrom) : []),
  // Cierres de periodo del servidor (misma entidad que `weeklySettlements` de CLEAN). Solo
  // se trasladan los importes que tienen el mismo significado; el resto queda sin valor.
  weeklySettlements: async () => (can('cashbox.viewRoute') ? (await list('/v1/periods', 'closures')).map(weeklySettlementFrom) : []),
  // Registros del capital centralizado: vistas del libro central del servidor (ver capitalRecords.ts).
  capitalLedger: async () => (await capitalRecords()).capitalLedger,
  capitalMovements: async () => (await capitalRecords()).capitalMovements,
  withdrawals: async () => (await capitalRecords()).withdrawals,
  transfers: async () => (await capitalRecords()).transfers,
  cashCustodyMovements: async () => (await capitalRecords()).cashCustodyMovements,
  // Cuadres por trabajador del servidor (misma entidad que `cashSettlements` de CLEAN).
  cashSettlements: async () => (can('cashSettlement.view') || can('cashSettlement.viewOwn')
    ? (await list('/v1/settlements?limit=500', 'settlements')).map(cashSettlementFrom) : []),
};

/** Registros de capital del libro central, una sola lectura por revisión para las cinco tablas. */
let capitalCache: { rev: number; promise: Promise<CapitalRecords> } | null = null;
async function loadCapital(): Promise<CapitalRecords> {
  const routes = (await table('routes')).map((r) => String(r['id']));
  const { operations, truncated: cut } = await fetchOperations(routes);
  if (cut) truncated.add('/v1/capital/operations');
  return buildCapitalRecords(operations, cut);
}
export function capitalRecords(): Promise<CapitalRecords> {
  if (capitalCache && capitalCache.rev === revision) return capitalCache.promise;
  const promise = loadCapital();
  capitalCache = { rev: revision, promise };
  promise.catch(() => { if (capitalCache?.promise === promise) capitalCache = null; });
  return promise;
}

/** Tablas del libro local de CLEAN SIN equivalente directo (ver cabecera). */
export const GAP_TABLES = [
  'cashboxMovements', 'auditLogs', 'partnerCashMovements',
  'paymentAdjustmentRequests', 'routeCapitalControllerEvents', 'noPaymentVisits',
  'platformUsers', 'companyControl', 'saasPayments', 'controlEvents',
] as const;

export const ALL_TABLES = [...Object.keys(LOADERS), ...GAP_TABLES];

// ---------------------------------------------------------------------------
// VISTAS AGREGADAS DEL SERVIDOR (no son tablas de CLEAN). Se usan en los servicios del
// puente para las cifras que CLEAN calculaba con su libro local: el servidor ya las
// calcula sobre su libro (custodia, liquidación, resumen de capital). Mismo ciclo de
// caché que las tablas: una lectura por revisión.
// ---------------------------------------------------------------------------
const views = new Map<string, { rev: number; promise: Promise<unknown> }>();

export function serverView<T>(path: string): Promise<T> {
  const hit = views.get(path);
  if (hit && hit.rev === revision) return hit.promise as Promise<T>;
  const promise = api().get<T>(path);
  views.set(path, { rev: revision, promise });
  promise.catch(() => { if (views.get(path)?.promise === promise) views.delete(path); });
  return promise;
}

export interface CustodyPosition { routeId: string; workerId: string; workerName: string; role: string; balanceMinor: number; carriedMinor: number; transferableMinor: number }
export interface Calendar { businessDate: string; timezone: string; suggested: { weekStart: string; weekEnd: string } }
export interface Liquidation {
  routeId: string; from: string; to: string; ended: boolean; closable: boolean;
  custody: { openingMinor: number; closingMinor: number; collectionsMinor: number; disbursementsMinor: number; workerExpensesMinor: number; deliveriesMinor: number };
  pool: { collectionsReceivedMinor: number; routeExpensesMinor: number; deliveredToWorkersMinor: number; returnsReceivedMinor: number };
  credit: { principalCollectedMinor: number; interestCollectedMinor: number; principalDisbursedMinor: number; expensesMinor: number };
  closures: { status: string }[];
}

/** Posiciones de custodia (efectivo en manos de cada trabajador por ruta). 403 → ninguna visible. */
export async function custodyPositions(): Promise<CustodyPosition[]> {
  try {
    return (await serverView<{ positions: CustodyPosition[] }>('/v1/capital/custody')).positions;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 403) return [];
    throw e;
  }
}

export function calendar(): Promise<Calendar> {
  return serverView<Calendar>('/v1/periods/calendar');
}

export function liquidation(routeId: string, from: string, to: string): Promise<Liquidation> {
  return serverView<Liquidation>(`/v1/periods/liquidation?routeId=${encodeURIComponent(routeId)}&from=${from}&to=${to}`);
}

export { mapLimit };

let revision = 0;
const cache = new Map<string, { rev: number; promise: Promise<Row[]> }>();
type Listener = (tables: Set<string>) => void;
const listeners = new Set<Listener>();

export function currentRevision(): number { return revision; }

/** Filas de una tabla (cargadas una vez por revisión). */
export function table(name: string): Promise<Row[]> {
  const loader = LOADERS[name];
  if (!loader) return Promise.reject(new ServerGap(name));
  const hit = cache.get(name);
  if (hit && hit.rev === revision) return hit.promise;
  const promise = loader();
  cache.set(name, { rev: revision, promise });
  promise.catch(() => { if (cache.get(name)?.promise === promise) cache.delete(name); });
  return promise;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Algo cambió en el servidor (comando confirmado o refresco): se vuelve a leer. */
export function invalidate(tables: readonly string[] = ALL_TABLES): void {
  revision++;
  cache.clear();
  views.clear();
  const set = new Set(tables);
  for (const l of listeners) l(set);
}

/** Vacía la proyección (cambio de contexto o cierre de sesión): nada de otra empresa queda en memoria. */
export function reset(): void {
  cache.clear();
  truncated.clear();
  invalidate();
}

/** Precarga en paralelo de las tablas que casi todas las pantallas leen (latencia del servidor). */
export function prefetch(): void {
  for (const t of ['routes', 'users', 'offices', 'clients', 'sales', 'saleRequests', 'expenseCategories', 'tenants']) table(t).catch(() => { /* la pantalla lo reintentará */ });
}

/**
 * Refresco periódico SIN parpadeo: vuelve a leer del servidor lo que las pantallas tienen
 * cargado y SOLO si algo cambió publica una revisión nueva (con los datos ya leídos). Si
 * nada cambió no se avisa a nadie: ninguna pantalla vuelve a cargar ni muestra su
 * indicador de carga (en CLEAN las pantallas solo se refrescaban cuando había cambios).
 */
let refreshing = false;
export async function refreshIfChanged(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const rev0 = revision;
    const tableNames = [...cache.keys()].filter((n) => cache.get(n)!.rev === rev0);
    const viewPaths = [...views.keys()].filter((p) => views.get(p)!.rev === rev0);
    const withCapital = capitalCache?.rev === rev0;
    const before = {
      tables: await Promise.all(tableNames.map((n) => cache.get(n)!.promise.catch(() => null))),
      views: await Promise.all(viewPaths.map((p) => views.get(p)!.promise.catch(() => null))),
      capital: withCapital ? await capitalCache!.promise.then((c) => c.operations).catch(() => null) : null,
    };
    const after = {
      tables: await Promise.all(tableNames.map((n) => LOADERS[n]!().catch(() => null))),
      views: await Promise.all(viewPaths.map((p) => api().get(p).catch(() => null))),
      capital: withCapital ? await loadCapital().catch(() => null) : null,
    };
    if (revision !== rev0) return; // un comando ya publicó una revisión nueva
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const changed = new Set(tableNames.filter((_, i) => after.tables[i] !== null && !same(before.tables[i], after.tables[i])));
    const viewsChanged = viewPaths.some((_, i) => after.views[i] !== null && !same(before.views[i], after.views[i]));
    const capitalChanged = withCapital && after.capital !== null && !same(before.capital, after.capital.operations);
    if (changed.size === 0 && !viewsChanged && !capitalChanged) return;
    revision++;
    cache.clear();
    views.clear();
    capitalCache = null;
    tableNames.forEach((n, i) => { if (after.tables[i]) cache.set(n, { rev: revision, promise: Promise.resolve(after.tables[i]!) }); });
    viewPaths.forEach((p, i) => { if (after.views[i]) views.set(p, { rev: revision, promise: Promise.resolve(after.views[i]) }); });
    if (after.capital) capitalCache = { rev: revision, promise: Promise.resolve(after.capital) };
    // Las vistas agregadas (custodia, liquidación, resumen) alimentan cifras de cualquier pantalla.
    const touched = viewsChanged || capitalChanged ? new Set<string>(ALL_TABLES) : changed;
    for (const l of listeners) l(touched);
  } finally {
    refreshing = false;
  }
}

let poller = 0;
export function startPolling(ms = 20_000): void {
  window.clearInterval(poller);
  const tick = () => {
    if (document.visibilityState === 'visible' && useRuntime.getState().ctx) void refreshIfChanged();
  };
  poller = window.setInterval(tick, ms);
  document.addEventListener('visibilitychange', tick);
}
