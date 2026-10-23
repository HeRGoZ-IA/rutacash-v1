// BASE POR RUTA (R74, migración 0034) · capa de datos de las pantallas nuevas.
//
// El MODELO DE CAPITAL es de la empresa (`GET /v1/capital/model`): `admin_pool` (toda empresa real
// hoy, p. ej. BlueLine) conserva EXACTAMENTE las pantallas anteriores; `route_base` y `migrating`
// usan las pantallas de Base por Ruta. Si la API no conoce el endpoint (versión anterior) o falla,
// la pantalla se queda en `admin_pool`: nunca se ofrece un flujo nuevo sin confirmarlo el servidor.
//
// Todas las cifras son del servidor (`/v1/capital/route-panel`, `/v1/capital/handovers`, …); aquí
// solo se convierten unidades y se suman filas del mismo panel cuando se filtra por oficina.
// Comandos de dinero con id de operación por formulario abierto (`money`): un reintento nunca duplica.

import { useEffect, useState } from 'react';
import { money } from '../commands.ts';
import { serverView, subscribe } from '../projection.ts';
import { useRuntime } from '../session.ts';

export type CapitalModel = 'admin_pool' | 'migrating' | 'route_base';

export interface ModelInfo {
  model: CapitalModel;
  routeBaseSince: string | null;
  activations: { id: string; fromModel: string; toModel: string; evidence: string; backupReference: string | null; companyBalanceNote: string | null;
    unassignedPools: unknown; actorId: string; createdAt: string }[];
}

export function fetchModel(): Promise<ModelInfo> {
  return serverView<ModelInfo>('/v1/capital/model');
}

/**
 * Modelo de capital de la empresa activa. `null` mientras se consulta la primera vez. Ante un error
 * (API anterior sin el endpoint, red) responde `admin_pool`: las pantallas actuales, sin regresión.
 */
export function useCapitalModel(): CapitalModel | null {
  const companyId = useRuntime((s) => s.ctx?.company.id ?? '');
  const [model, setModel] = useState<CapitalModel | null>(() => (companyId && lastKnown.company === companyId ? lastKnown.model : null));
  useEffect(() => {
    if (!companyId) { setModel(null); return; }
    let alive = true;
    const read = () => {
      fetchModel()
        .then((m) => { if (!alive) return; lastKnown = { company: companyId, model: m.model }; setModel(m.model); })
        .catch(() => { if (alive) setModel((cur) => cur ?? 'admin_pool'); });
    };
    read();
    const off = subscribe(() => read());
    return () => { alive = false; off(); };
  }, [companyId]);
  return model;
}
let lastKnown: { company: string; model: CapitalModel } = { company: '', model: 'admin_pool' };

/** ¿Pantallas de Base por Ruta? (`migrating` también: las bolsas están congeladas). */
export const isRouteBaseUi = (m: CapitalModel | null) => m === 'route_base' || m === 'migrating';

// ---------------------------------------------------------------------------
// Panel por ruta (Caja principal consolidada / panel del SuperAdmin)
// ---------------------------------------------------------------------------

export type PanelAlert = 'NO_VALID_CONTROLLER' | 'ROUTE_IN_HANDOVER' | 'HANDOVER_DIFFERENCE' | 'NEGATIVE_CUSTODY' | 'CARRIED_SHORTAGE'
  | 'SURPLUS_IN_CONTROL' | 'NEGATIVE_OPERATING_RESULT' | 'NEGATIVE_FLOW_GROWTH' | 'INSUFFICIENT_LIQUIDITY';

export interface BaseBlock {
  openingMinor: number; injectionsMinor: number; withdrawalsMinor: number; transfersInMinor: number; transfersOutMinor: number;
  unassignedAssignedMinor: number; deliveredToWorkersMinor: number; returnsReceivedMinor: number; reassignmentsNetMinor: number;
  collectionsReceivedMinor: number; disbursedMinor: number; routeExpensesMinor: number; otherMinor: number; closingMinor: number; contributionsNetMinor: number;
}

export interface PanelRoute {
  routeId: string; name: string; code: string | null; status: string; handoverState: 'normal' | 'en_entrega' | string;
  lastHandover: { id: string; status: string; from_membership_id: string | null; to_membership_id: string; base_at_start_minor: number; started_at: string;
    expected_base_minor: number | null; counted_minor: number | null; difference_minor: number | null; confirmed_at: string | null } | null;
  controller: { id: string | null; name: string | null; valid: boolean };
  baseMinor: number; contributionsNetMinor: number;
  custody: { grossMinor: number; negativeMinor: number; deliverableMinor: number; carriedShortageMinor: number; positions: number };
  cashMinor: number; surplusInControlMinor: number;
  portfolio: { principalPlacedMinor: number; outstandingWithInterestMinor: number };
  approvedNotDisbursedMinor: number;
  period: { collectionsMinor: number; interestCollectedMinor: number; principalDisbursedMinor: number;
    expenses: { operativoMinor: number; bienDuraderoMinor: number; otroMinor: number }; base: BaseBlock | null };
  operatingResultMinor: number; operatingFlowMinor: number; capitalNeedMinor: number | null;
  states: { negativeOperatingResult: boolean; negativeFlowFromGrowth: boolean; insufficientLiquidity: boolean | null };
  alerts: PanelAlert[];
}

export interface PoolRow { adminId: string; name: string | null; balanceMinor: number }

export interface RoutePanel {
  model: CapitalModel; routeBaseSince: string | null; from: string; to: string; routes: PanelRoute[];
  general: {
    expenses: { administratorMinor: number; companyMinor: number; operativoMinor: number; bienDuraderoMinor: number; otroMinor: number };
    unassignedPools?: PoolRow[]; adminPools?: PoolRow[]; companyAccountMinor: number | null;
  };
  totals: { baseMinor: number; custodyMinor: number; deliverableCustodyMinor: number; cashMinor: number; portfolioPrincipalMinor: number;
    operatingResultMinor: number; operatingFlowMinor: number };
}

export function fetchPanel(from: string, to: string): Promise<RoutePanel> {
  return serverView<RoutePanel>(`/v1/capital/route-panel?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

/** Gastos de la ruta en el periodo (las tres naturalezas). */
export const routeExpenses = (r: PanelRoute) => r.period.expenses.operativoMinor + r.period.expenses.bienDuraderoMinor + r.period.expenses.otroMinor;

/** Totales de un subconjunto de filas (filtro por oficina): solo sumas de cifras del servidor. */
export function sumRows(rows: PanelRoute[]) {
  const s = (f: (r: PanelRoute) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    baseMinor: s((r) => r.baseMinor), custodyMinor: s((r) => r.custody.grossMinor), deliverableMinor: s((r) => r.custody.deliverableMinor),
    negativeCustodyMinor: s((r) => r.custody.negativeMinor), shortageMinor: s((r) => r.custody.carriedShortageMinor),
    cashMinor: s((r) => r.cashMinor), principalPlacedMinor: s((r) => r.portfolio.principalPlacedMinor),
    outstandingMinor: s((r) => r.portfolio.outstandingWithInterestMinor), collectionsMinor: s((r) => r.period.collectionsMinor),
    interestMinor: s((r) => r.period.interestCollectedMinor), disbursedMinor: s((r) => r.period.principalDisbursedMinor),
    expensesMinor: s(routeExpenses), withdrawalsMinor: s((r) => r.period.base?.withdrawalsMinor ?? 0), injectionsMinor: s((r) => r.period.base?.injectionsMinor ?? 0),
    resultMinor: s((r) => r.operatingResultMinor), flowMinor: s((r) => r.operatingFlowMinor),
  };
}

// ---------------------------------------------------------------------------
// Entrega controlada (O5)
// ---------------------------------------------------------------------------

export interface Handover {
  id: string; routeId: string; fromId: string | null; toId: string; status: 'pendiente' | 'confirmada' | 'sustituida';
  baseAtStartMinor: number; custodyAtStartMinor: number; startedAt: string; expectedBaseMinor: number | null; countedMinor: number | null;
  differenceMinor: number | null; note: string | null; confirmedAt: string | null; currentBaseMinor: number | null;
}

export async function fetchHandovers(q: { routeId?: string; status?: Handover['status'] } = {}): Promise<Handover[]> {
  const p = new URLSearchParams();
  if (q.routeId) p.set('routeId', q.routeId);
  if (q.status) p.set('status', q.status);
  const s = p.toString();
  return (await serverView<{ handovers: Handover[] }>(`/v1/capital/handovers${s ? `?${s}` : ''}`)).handovers;
}

export function confirmHandover(routeId: string, body: { countedMinor: number; expectedSeenMinor: number; note?: string }, operationId: string) {
  return money<{ differenceMinor: number; result: 'exacto' | 'faltante' | 'sobrante' }>('POST', `/v1/capital/handovers/${encodeURIComponent(routeId)}/confirm`,
    { countedMinor: body.countedMinor, expectedSeenMinor: body.expectedSeenMinor, ...(body.note?.trim() ? { note: body.note.trim() } : {}) }, operationId);
}

// ---------------------------------------------------------------------------
// Comandos de la Base (solo el Administrador responsable de la ruta)
// ---------------------------------------------------------------------------

export interface Destination { routeId: string; name: string; code: string | null; controllerId: string; controllerName: string; inScope: boolean }

export async function fetchDestinations(): Promise<Destination[]> {
  return (await serverView<{ routes: Destination[] }>('/v1/capital/route-base/transfer-destinations')).routes;
}

type Op = { operation: { id: string } };
export const injectBase = (b: { routeId: string; amountMinor: number; reason: string; sourceNote?: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/route-base/injections', { routeId: b.routeId, amountMinor: b.amountMinor, reason: b.reason.trim(), ...(b.sourceNote?.trim() ? { sourceNote: b.sourceNote.trim() } : {}) }, opId);
export const withdrawBase = (b: { routeId: string; amountMinor: number; reason: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/route-base/withdrawals', { ...b, reason: b.reason.trim() }, opId);
export const transferBase = (b: { fromRouteId: string; toRouteId: string; amountMinor: number; reason: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/route-base/transfers', { ...b, reason: b.reason.trim() }, opId);
export const assignUnassigned = (b: { routeId: string; amountMinor: number; reason: string; evidence: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/route-base/unassigned-assignments', { ...b, reason: b.reason.trim(), evidence: b.evidence.trim() }, opId);
/** Entrega de Base a un trabajador: el comando de siempre; con `route_base` sale de la Base de la ruta. */
export const deliverToWorker = (b: { routeId: string; workerId: string; amountMinor: number; reason: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/deliveries', { ...b, reason: b.reason.trim() }, opId);
/** Recepción de devolución de un trabajador: vuelve a la Base de la ruta. */
export const receiveFromWorker = (b: { routeId: string; workerId: string; amountMinor: number; reason: string }, opId: string) =>
  money<Op>('POST', '/v1/capital/returns', { ...b, reason: b.reason.trim() }, opId);

// ---------------------------------------------------------------------------
// Activación (O6, SuperAdmin)
// ---------------------------------------------------------------------------

export interface PrereqCheck { name: string; ok: boolean; detail: unknown; documentable?: boolean }
export interface Prerequisites { model: CapitalModel; ok: boolean; checks: PrereqCheck[]; unassignedPools: (PoolRow & { status?: string })[] }

export const fetchPrerequisites = () => serverView<Prerequisites>('/v1/capital/model/prerequisites');
export const transitionModel = (b: { target: CapitalModel; evidence: string; backupReference?: string; companyBalanceNote?: string }, opId: string) =>
  money<{ model: CapitalModel; fromModel: string }>('POST', '/v1/capital/model', {
    target: b.target, evidence: b.evidence.trim(),
    ...(b.backupReference?.trim() ? { backupReference: b.backupReference.trim() } : {}),
    ...(b.companyBalanceNote?.trim() ? { companyBalanceNote: b.companyBalanceNote.trim() } : {}),
  }, opId);
