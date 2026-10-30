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
//     comando confirmado y cuando la huella de actividad del servidor cambia (sondeo de
//     20 s, ver «POLÍTICA DE ACTUALIZACIÓN» al final; sin WebSockets).

import { ApiFailure } from '../lib/client.ts';
import { buildCapitalRecords, fetchOperations, type CapitalRecords } from './capitalRecords.ts';
import { todayIn } from './consultasModel.ts';
import { api, useRuntime } from './session.ts';
import {
  adjustmentFrom, cashSettlementFrom, controllerEventFrom, categoryFrom, clientFrom, companyFromContext, expenseFrom, weeklySettlementFrom, installmentFrom, noPaymentVisitFrom, officeFrom, paymentFrom, pendingSaleFrom,
  routeFrom, saleFrom, saleRequestFrom, tenantFrom, userFrom,
  type CompanyView,
} from './mappers.ts';
import type { Installment, SaleRequest } from '@clean/models/types';
import { updateInstallmentStatuses } from '@clean/services/installmentEngine';
import { resetFreshness, withOfflineCopy } from '../offline/cache.ts';

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

/**
 * Listado PAGINADO del servidor (cursor `before` = «createdAt|id», orden más reciente
 * primero): se piden páginas hasta agotar la lista o llegar a `maxRows`. Si se llega al
 * tope, la tabla queda marcada como incompleta (`truncated`) en vez de fingir que está entera.
 */
async function paged(path: string, key: string, maxRows: number): Promise<Row[]> {
  const out: Row[] = [];
  let before: string | null = null;
  const gen = generation;
  for (;;) {
    // Cambio de contexto a mitad del listado: no se piden más páginas con la sesión nueva.
    if (gen !== generation) throw new StaleContext();
    const sep = path.includes('?') ? '&' : '?';
    const q = `${path}${sep}limit=1000${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    let page: Row[];
    try {
      page = ((await api().get<Record<string, unknown>>(q))[key] ?? []) as Row[];
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 403) return out;
      throw e;
    }
    out.push(...page);
    if (page.length < 1000) return out;
    if (out.length >= maxRows) { truncated.add(path); return out; }
    const last = page[page.length - 1]!;
    before = `${last['createdAt']}|${last['id']}`;
  }
}

/** Topes de los listados del servidor: si se alcanzan, la tabla puede estar incompleta. */
const LIST_CAPS: Record<string, number> = { '/v1/credit-requests': 500, '/v1/settlements?limit=500': 500,
  '/v1/no-payment-visits?limit=1000': 1000 };
/** Filas máximas que se traen de un listado paginado por revisión (recaudos, gastos). */
const MAX_ROWS = 20_000;
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
  tenants: async () => {
    if (!can('settings.access')) return [tenantFrom(companyFromContext())];
    try {
      return [tenantFrom(await api().get<CompanyView>('/v1/company'))];
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 403) return [tenantFrom(companyFromContext())];
      throw e;
    }
  },
  users: async () => {
    if (can('user.viewAll')) return (await list('/v1/members', 'members')).map(userFrom);
    // Roles de campo (Supervisor, Cobrador, Socio, Secretario): la propia membresía y,
    // si cuadra a otros, los trabajadores de sus rutas con su nombre real (mismo listado
    // que usa el cuadre: `GET /v1/settlements/workers`). Nunca se amplía el alcance.
    const ctx = useRuntime.getState().ctx!;
    const self = userFrom({ membershipId: ctx.membershipId, role: ctx.role, status: 'activo', displayName: ctx.displayName ?? '', routeIds: ctx.routeIds });
    if (!can('cashSettlement.view')) return [self];
    const byId = new Map<string, Row>([[self.id, self as unknown as Row]]);
    const lists = await mapLimit([...ctx.routeIds], 4, (routeId) => settleableWorkers(routeId).catch(() => null));
    lists.forEach((l, i) => {
      // Responsable de capital válido de la ruta (lo necesita la regla original de quién cuadra).
      if (l?.controllerId && l.controllerValid && l.controllerId !== self.id) {
        const prev = byId.get(l.controllerId);
        const routeIds = new Set<string>(prev ? (prev['authorizedRouteIds'] as string[]) : []);
        routeIds.add(ctx.routeIds[i]!);
        byId.set(l.controllerId, userFrom({ membershipId: l.controllerId, role: 'admin', status: 'activo', displayName: l.controllerName ?? '', routeIds: [...routeIds] }) as unknown as Row);
      }
      for (const w of l?.workers ?? []) {
        if (w.workerId === self.id) continue;
        const prev = byId.get(w.workerId);
        const routeIds = new Set<string>(prev ? (prev['authorizedRouteIds'] as string[]) : []);
        if (w.assigned) routeIds.add(ctx.routeIds[i]!);
        byId.set(w.workerId, userFrom({ membershipId: w.workerId, role: w.role, status: w.status, displayName: w.name, routeIds: [...routeIds] }) as unknown as Row);
      }
    });
    return [...byId.values()];
  },
  routes: async () => (await list('/v1/routes', 'routes')).map(routeFrom),
  offices: async () => (await list('/v1/offices', 'offices')).map(officeFrom),
  // Clientes por páginas de 1000 (orden por nombre del servidor, desplazamiento).
  clients: async () => {
    if (!can('client.view')) return [];
    const out: Row[] = [];
    for (let offset = 0; offset < MAX_ROWS; offset += 1000) {
      const page = await list(`/v1/clients?limit=1000&offset=${offset}`, 'clients');
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out.map(clientFrom);
  },
  sales: async () => {
    if (!can('sale.viewActive') && !can('sale.viewHistory')) return [];
    const credits = (await paged('/v1/credits', 'credits', MAX_ROWS)).map(saleFrom);
    // Aprobadas sin desembolsar = ventas «pendientes de desembolso» de CLEAN (ver pendingSaleFrom).
    const requests = (await table('saleRequests')) as SaleRequest[];
    const pending = requests.filter((r) => r.status === 'approved' && !r.saleId).map(pendingSaleFrom);
    return [...credits, ...pending];
  },
  // Cuotas en UNA consulta por ruta (`GET /v1/installments`), no una por crédito.
  installments: async () => {
    if (!can('sale.viewActive')) return [];
    const routes = (await table('routes')).map((r) => String(r['id']));
    const parts = await mapLimit(routes, 4, async (routeId) => {
      const body = await api().get<{ installments: Row[] }>(`/v1/installments?routeId=${encodeURIComponent(routeId)}`);
      return (body.installments ?? []).map((i) => installmentFrom(String(i['saleId']), i));
    });
    // Estado y días de mora con la regla ORIGINAL de CLEAN a la fecha de hoy (el servidor
    // solo los recalcula al cobrar): mismos importes, mismo resultado que CLEAN.
    const bySale = new Map<string, Installment[]>();
    for (const i of parts.flat()) {
      const l = bySale.get(i.saleId) ?? [];
      l.push(i);
      bySale.set(i.saleId, l);
    }
    return [...bySale.values()].flatMap((l) => updateInstallmentStatuses(l)) as unknown as Row[];
  },
  payments: async () => (can('payment.viewHistory') ? (await paged('/v1/collections', 'collections', MAX_ROWS)).map(paymentFrom) : []),
  expenses: async () => (can('expense.register') || can('expense.correct') ? (await paged('/v1/expenses', 'expenses', MAX_ROWS)).map(expenseFrom) : []),
  // Historial de responsables de capital de cada ruta (eventos que el servidor registra al cambiarlo).
  routeCapitalControllerEvents: async () => (can('capital.manage') || can('capital.assignController')
    ? (await list('/v1/capital/controller-events', 'events')).map(controllerEventFrom) : []),
  paymentAdjustmentRequests: async () => (can('payment.correct') || can('payment.approveAdjustment')
    ? (await list('/v1/payment-adjustments', 'adjustments')).map(adjustmentFrom) : []),
  noPaymentVisits: async () => (can('payment.viewHistory') ? (await list('/v1/no-payment-visits?limit=1000', 'visits')).map(noPaymentVisitFrom) : []),
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
  // Caja socios: SOLO la pata de los aportes del libro central (ver capitalRecords.ts, D1).
  partnerCashMovements: async () => (await capitalRecords()).partnerCashMovements,
  // Cuadres por trabajador del servidor (misma entidad que `cashSettlements` de CLEAN).
  cashSettlements: async () => (can('cashSettlement.view') || can('cashSettlement.viewOwn')
    ? (await list('/v1/settlements?limit=500', 'settlements')).map(cashSettlementFrom) : []),
};

/** Registros de capital del libro central, una sola lectura por revisión para las cinco tablas. */
async function loadCapital(): Promise<CapitalRecords> {
  const routes = (await table('routes')).map((r) => String(r['id']));
  const { operations, truncated: cut } = await fetchOperations(routes);
  if (cut) truncated.add('/v1/capital/operations');
  return buildCapitalRecords(operations, cut);
}
export function capitalRecords(): Promise<CapitalRecords> {
  return cached('capital', loadCapital);
}

/**
 * Cobros o gastos con fecha DESDE `from` (filtro de fecha del servidor, mismo alcance y mismos
 * registros que la tabla completa). Para las cifras de un periodo reciente (Dashboard: hoy,
 * semana, 7 días) sin descargar todo el historial.
 */
const SINCE = {
  payments: { path: '/v1/collections', key: 'collections', map: paymentFrom, can: () => can('payment.viewHistory') },
  expenses: { path: '/v1/expenses', key: 'expenses', map: expenseFrom, can: () => can('expense.register') || can('expense.correct') },
} as const;
export function since(kind: keyof typeof SINCE, from: string): Promise<Row[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return Promise.reject(new Error(`fecha inválida: ${from}`));
  const s = SINCE[kind];
  return cached(`since:${kind}:${from}`, async () => (s.can() ? (await paged(`${s.path}?from=${from}`, s.key, MAX_ROWS)).map((r) => s.map(r) as unknown as Row) : []));
}

/** Tablas del libro local de CLEAN SIN equivalente directo (ver cabecera). */
export const GAP_TABLES = [
  'cashboxMovements', 'auditLogs',
  'platformUsers', 'companyControl', 'saasPayments', 'controlEvents',
] as const;

export const ALL_TABLES = [...Object.keys(LOADERS), ...GAP_TABLES];

// ---------------------------------------------------------------------------
// VISTAS AGREGADAS DEL SERVIDOR (no son tablas de CLEAN). Se usan en los servicios del
// puente para las cifras que CLEAN calculaba con su libro local: el servidor ya las
// calcula sobre su libro (custodia, liquidación, resumen de capital). Mismo ciclo de
// caché que las tablas: una lectura por revisión.
// ---------------------------------------------------------------------------
export function serverView<T>(path: string): Promise<T> {
  return cached(`view:${path}`, () => api().get<T>(path));
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

export interface SettleableWorker { workerId: string; name: string; role: string; status: string; assigned: boolean; own: boolean; positionMinor: number; carriedMinor: number; availableMinor: number }
export interface SettleableWorkers { routeId: string; routeName: string; controllerId: string | null; controllerName: string | null; controllerValid: boolean; workers: SettleableWorker[]; routeTotalPositionMinor: number; routeTotalAvailableMinor: number }

/** Trabajadores cuadrables de una ruta con su posición de custodia (`cashSettlement.view`). */
export function settleableWorkers(routeId: string): Promise<SettleableWorkers> {
  return serverView<SettleableWorkers>(`/v1/settlements/workers?routeId=${encodeURIComponent(routeId)}`);
}

export function calendar(): Promise<Calendar> {
  return serverView<Calendar>('/v1/periods/calendar');
}

export function liquidation(routeId: string, from: string, to: string): Promise<Liquidation> {
  return serverView<Liquidation>(`/v1/periods/liquidation?routeId=${encodeURIComponent(routeId)}&from=${from}&to=${to}`);
}

export { mapLimit };

let revision = 0;
/** Sube en cada `reset()` (cambio de contexto o cierre de sesión). */
let generation = 0;

/** Una lectura empezada con otro contexto (empresa o rol): su resultado se descarta. */
export class StaleContext extends Error {
  constructor() { super('Lectura de un contexto anterior: descartada.'); this.name = 'StaleContext'; }
}

interface Entry { rev: number; promise: Promise<unknown>; load: () => Promise<unknown>; used: number }
/** Caché de la proyección por revisión: tablas (`table:`), vistas (`view:`), capital y rangos (`since:`). */
const cache = new Map<string, Entry>();
/** Momento del último cambio de pantalla (ver `refreshIfChanged`). */
let navigatedAt = 0;

function cached<T>(key: string, rawLoad: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.rev === revision) { hit.used = now; return hit.promise as Promise<T>; }
  const gen = generation;
  // Ronda 62: para el Cobrador, lo leído se guarda cifrado y, SIN CONEXIÓN, se responde con esa
  // copia (offline/cache.ts). Para los demás roles es la lectura de siempre.
  const load = () => withOfflineCopy(key, rawLoad);
  const promise = load().then((v) => { if (gen !== generation) throw new StaleContext(); return v; });
  const entry: Entry = { rev: revision, promise, load, used: now };
  cache.set(key, entry);
  promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return promise;
}

type Listener = (tables: Set<string>) => void;
const listeners = new Set<Listener>();

export function currentRevision(): number { return revision; }

/** Filas de una tabla (cargadas una vez por revisión). */
export function table(name: string): Promise<Row[]> {
  const loader = LOADERS[name];
  if (!loader) return Promise.reject(new ServerGap(name));
  return cached(`table:${name}`, loader);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Algo cambió en el servidor (comando confirmado o refresco): se vuelve a leer. */
export function invalidate(tables: readonly string[] = ALL_TABLES): void {
  revision++;
  cache.clear();
  primeMarker();
  const set = new Set(tables);
  for (const l of listeners) l(set);
}

/** Vacía la proyección (cambio de contexto o cierre de sesión): nada de otra empresa queda en memoria. */
export function reset(): void {
  generation++;
  cache.clear();
  truncated.clear();
  resetFreshness();
  invalidate();
}

/** La pantalla cambió: lo que la pantalla anterior leyó ya no se refresca (se relee al pedirlo). */
export function markNavigation(): void { navigatedAt = Date.now(); }

/** Precarga en paralelo de las tablas que casi todas las pantallas leen (latencia del servidor). */
export function prefetch(): void {
  const base = ['routes', 'users', 'offices', 'clients', 'sales', 'saleRequests', 'expenseCategories', 'tenants'];
  // Ronda 62: el Cobrador precarga TODO lo que necesita para cobrar sin conexión (así queda en la
  // copia de consulta aunque no haya abierto cada pantalla), y la vista del calendario.
  const collector = useRuntime.getState().ctx?.role === 'cobrador' ? ['installments', 'payments', 'noPaymentVisits', 'expenses'] : [];
  for (const t of [...base, ...collector]) table(t).catch(() => { /* la pantalla lo reintentará */ });
}

/**
 * Refresco SIN parpadeo de lo que la PANTALLA ACTUAL usa: vuelve a leer del servidor las
 * entradas leídas desde el último cambio de pantalla y SOLO si algo cambió publica una
 * revisión nueva (con los datos ya leídos). Lo que leyeron pantallas anteriores se descarta:
 * se volverá a leer, ya actualizado, cuando una pantalla lo pida. Con `somethingChanged`
 * (la huella del servidor cambió) se publica la revisión aunque lo releído sea igual, para que
 * los componentes que usan datos descartados los relean.
 */
export async function refreshIfChanged(somethingChanged = false): Promise<void> {
  const rev0 = revision;
  const gen0 = generation;
  const current = [...cache.entries()].filter(([, e]) => e.rev === rev0);
  const live = current.filter(([, e]) => e.used >= navigatedAt);
  const dropped = current.length - live.length;
  const before = await Promise.all(live.map(([, e]) => e.promise.catch(() => null)));
  const after = await mapLimit(live, 4, ([, e]) => e.load().catch(() => null));
  if (revision !== rev0 || generation !== gen0) return; // un comando o un cambio de contexto ya publicó otra revisión
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changed = live.filter(([, e], i) => after[i] !== null && !same(before[i], after[i])).map(([k]) => k);
  if (changed.length === 0 && !(somethingChanged && dropped > 0)) return;
  revision++;
  cache.clear();
  live.forEach(([k, e], i) => { if (after[i] !== null) cache.set(k, { rev: revision, promise: Promise.resolve(after[i]), load: e.load, used: e.used }); });
  // Vistas agregadas, capital y rangos alimentan cifras de cualquier pantalla.
  const onlyTables = changed.length > 0 && dropped === 0 && changed.every((k) => k.startsWith('table:'));
  const touched = onlyTables ? new Set(changed.map((k) => k.slice('table:'.length))) : new Set<string>(ALL_TABLES);
  for (const l of listeners) l(touched);
}

/**
 * POLÍTICA DE ACTUALIZACIÓN (Ronda 33):
 *   · Cada 20 s con la pestaña visible, y al volver a ella: se pide la huella de actividad de
 *     la empresa (`GET /v1/changes`, unos bytes). Si no cambió, no se descarga nada más.
 *   · Si cambió (o han pasado 5 min, red de seguridad), se relee lo de la pantalla actual.
 *   · Nunca dos refrescos a la vez; un refresco empezado con otro contexto no se aplica.
 *   · Tras cada comando propio se invalida todo (`invalidate`), como antes.
 * Una API sin `/v1/changes` (anterior a la Ronda 33) se trata como «cambió»: el refresco
 * se comporta como antes, limitado a la pantalla actual.
 */
const FULL_EVERY_MS = 5 * 60_000;
let lastMarker: string | null | undefined;
let lastFullAt = 0;
let markerSupported = true;
let refreshing = false;

async function changeMarker(): Promise<string | null | undefined> {
  if (!markerSupported) return undefined;
  try {
    return (await api().get<{ marker: string | null }>('/v1/changes')).marker;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) markerSupported = false;
    return undefined;
  }
}

/**
 * Huella de referencia al empezar a leer (contexto nuevo o tras un comando): lo que cambie
 * después se detecta en el siguiente sondeo. Si no llega, el siguiente sondeo relee.
 */
function primeMarker(): void {
  lastMarker = undefined;
  lastFullAt = Date.now();
  if (!useRuntime.getState().ctx) return;
  const gen = generation;
  const rev = revision;
  void changeMarker().then((m) => { if (gen === generation && rev === revision && lastMarker === undefined) lastMarker = m; });
}

export async function pollOnce(): Promise<void> {
  if (refreshing) return;
  // Ronda 62: sin red no hay nada que sondear (la copia de consulta ya responde las lecturas).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  refreshing = true;
  try {
    const gen = generation;
    const marker = await changeMarker();
    if (gen !== generation) return;
    const due = Date.now() - lastFullAt >= FULL_EVERY_MS;
    const known = marker !== undefined && lastMarker !== undefined;
    if (known && marker === lastMarker && !due) return;
    const changedMarker = !known || marker !== lastMarker;
    await refreshIfChanged(changedMarker);
    if (gen !== generation) return;
    if (marker !== undefined) lastMarker = marker;
    lastFullAt = Date.now();
  } finally {
    refreshing = false;
  }
}

/**
 * CAMBIO DE DÍA (Errores, 2026-10-29): «hoy» (pagó hoy, cobrar hoy, cuotas atrasadas, rangos
 * de Consultas y Caja) se calcula en el navegador. Si la app queda abierta o en segundo plano
 * de un día a otro sin señal, o nadie registró nada (datos releídos iguales), la pantalla seguía
 * mostrando el día anterior hasta volver a iniciar sesión. Al cambiar la fecha del dispositivo
 * o la de la empresa, se relee todo como tras un comando.
 */
let lastDay: string | null = null;
function dayKey(): string {
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Sin empresa elegida aún se repite la fecha del dispositivo (elegirla no cuenta como cambio salvo otro huso).
  const tz = useRuntime.getState().ctx?.company.timezone;
  return `${local}|${tz ? todayIn(tz, d) : local}`;
}

/** true si cambió el día desde la última comprobación (y ya se pidió releer todo). */
export function checkDayChange(): boolean {
  const day = dayKey();
  const changed = lastDay !== null && day !== lastDay;
  lastDay = day;
  if (changed) invalidate();
  return changed;
}

let poller = 0;
export function startPolling(ms = 20_000): void {
  window.clearInterval(poller);
  lastDay = dayKey();
  const tick = () => {
    if (document.visibilityState !== 'visible' || !useRuntime.getState().ctx) return;
    if (!checkDayChange()) void pollOnce();
  };
  poller = window.setInterval(tick, ms);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('focus', tick);
}
