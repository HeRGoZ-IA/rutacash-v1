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

/** Último modelo conocido de la empresa ACTIVA (para funciones puras, p. ej. reportes); `admin_pool` si no se sabe. */
export function currentCapitalModel(): CapitalModel {
  const company = useRuntime.getState().ctx?.company.id ?? '';
  return company && lastKnown.company === company ? lastKnown.model : 'admin_pool';
}

/** ¿Pantallas de Base por Ruta? (`migrating` también: las bolsas están congeladas). */
export const isRouteBaseUi = (m: CapitalModel | null) => m === 'route_base' || m === 'migrating';

// ---------------------------------------------------------------------------
// Panel por ruta (Caja principal consolidada / panel del SuperAdmin)
// ---------------------------------------------------------------------------

export type PanelAlert = 'NO_VALID_CONTROLLER' | 'ROUTE_IN_HANDOVER' | 'HANDOVER_DIFFERENCE' | 'NEGATIVE_CUSTODY' | 'CARRIED_SHORTAGE'
  | 'SURPLUS_IN_CONTROL' | 'NEGATIVE_OPERATING_RESULT' | 'NEGATIVE_FLOW_GROWTH' | 'INSUFFICIENT_LIQUIDITY' | 'PENDING_DIFFERENCES';

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
  /** 0035: salidas de la Base hacia gastos generales y reembolsos del periodo (NO entran en el resultado de la ruta). */
  generalFunding?: { generalExpenseContributionsMinor: number; adminReimbursementsMinor: number };
  /**
   * 0036 (conciliación de faltantes y sobrantes por el Administrador): bloque opcional. La pantalla lo muestra
   * SOLO si el servidor lo envía; mientras tanto se ven el faltante arrastrado y el sobrante en control.
   */
  differences?: Partial<DifferenceFigures>;
}

/** Cifras de diferencias de una ruta (0036, `adex.route_difference_summary`). Nunca efectivo ni resultado. */
export interface DifferenceFigures {
  pendingCount: number; pendingShortageMinor: number; pendingSurplusMinor: number; workerOwedMinor: number;
  conciliatedCount: number; conciliatedShortageMinor: number; workerOwesDecidedMinor: number; surplusToBaseMinor: number;
  surplusReturnedMinor: number; conciliatedNetMinor: number;
}

export interface PoolRow { adminId: string; name: string | null; balanceMinor: number }

export interface AdminGeneralRow {
  adminId: string; name: string | null; totalMinor: number; operativoMinor: number; bienDuraderoMinor: number; otroMinor: number;
  routesFundedMinor: number; ownMoneyMinor: number;
}
export interface CompanyGeneral {
  totalMinor: number; operativoMinor: number; bienDuraderoMinor: number; otroMinor: number;
  byFunding: { routesMinor: number; ownMoneyMinor: number; adminPoolMinor: number; companyAccountMinor: number };
}
export interface PendingReimbursements { totalMinor: number; isCash: false; admins: { adminId: string; name: string | null; pendingMinor: number }[] }

export interface RoutePanel {
  model: CapitalModel; routeBaseSince: string | null; from: string; to: string; routes: PanelRoute[];
  general: {
    expenses: { administratorMinor: number; companyMinor: number; operativoMinor: number; bienDuraderoMinor: number; otroMinor: number };
    unassignedPools?: PoolRow[]; adminPools?: PoolRow[]; companyAccountMinor: number | null;
    // 0035 (O8): gastos generales del Administrador y de la empresa del periodo, aparte de las rutas.
    administratorGeneral?: AdminGeneralRow[]; companyGeneral?: CompanyGeneral;
    /** Σ saldos a favor de Administradores: obligación de la empresa, NUNCA efectivo. */
    pendingAdminReimbursements?: PendingReimbursements;
    reimbursementsPaid?: { totalMinor: number; fromRoutesMinor: number; fromAdminPoolMinor: number };
  };
  totals: { baseMinor: number; custodyMinor: number; deliverableCustodyMinor: number; cashMinor: number; portfolioPrincipalMinor: number;
    operatingResultMinor: number; operatingFlowMinor: number };
  consolidated?: { routesOperatingResultMinor: number; generalOperatingExpensesMinor: number; generalDurableGoodsMinor: number;
    resultAfterGeneralExpensesMinor: number; pendingAdminReimbursementsMinor: number };
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
    surplusMinor: s((r) => r.surplusInControlMinor),
    generalContributionsMinor: s((r) => r.generalFunding?.generalExpenseContributionsMinor ?? 0),
    reimbursementsMinor: s((r) => r.generalFunding?.adminReimbursementsMinor ?? 0),
    // 0036: solo si el servidor publica el bloque (si ninguna fila lo trae, null).
    differences: rows.some((r) => r.differences) ? {
      pendingCount: s((r) => r.differences?.pendingCount ?? 0),
      shortagePendingMinor: s((r) => r.differences?.pendingShortageMinor ?? 0), surplusPendingMinor: s((r) => r.differences?.pendingSurplusMinor ?? 0),
      workerOwedMinor: s((r) => r.differences?.workerOwedMinor ?? 0),
      shortageConciliatedMinor: s((r) => (r.differences?.conciliatedShortageMinor ?? 0) + (r.differences?.workerOwesDecidedMinor ?? 0)),
      surplusConciliatedMinor: s((r) => (r.differences?.surplusToBaseMinor ?? 0) + (r.differences?.surplusReturnedMinor ?? 0)),
    } : null,
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
// Gastos generales y reembolsos (0035, D74-O4F): A / C1 con aportes de rutas, C2 con dinero propio
// ---------------------------------------------------------------------------

export type Nature = 'operativo' | 'bien_duradero' | 'otro';
export const NATURE_LABEL: Record<Nature, string> = { operativo: 'Operativo', bien_duradero: 'Bien duradero', otro: 'Otro' };
export const natureLabel = (n: string | null | undefined) => (n && n in NATURE_LABEL ? NATURE_LABEL[n as Nature] : 'Operativo');

export interface Contribution { routeId: string; amountMinor: number }
export interface ContributionView { routeId: string | null; routeName: string | null; amountMinor: number; operationId: string }

/** Vista de un gasto del servidor (`/v1/expenses`), con los campos de 0035. */
export interface ServerExpense {
  id: string; scope: 'empresa' | 'ruta' | 'trabajador' | 'administrador' | null; routeId: string | null; workerId: string | null; categoryId: string;
  amountMinor: number; description: string | null; reference: string | null; expenseDate: string; registeredBy: string;
  funding: string | null; fundingAdminId: string | null; state: string; reversesId: string | null; refundsExpenseId: string | null;
  reversalId: string | null; reversedAt: string | null; reversedBy: string | null; reversalReason: string | null; ledgerOperationId: string | null;
  createdAt: string; adminId: string | null; nature: string | null; contributions: ContributionView[]; isReimbursable: boolean;
}
/** ¿Gasto general con las fuentes nuevas (aportes de rutas o dinero propio)? */
export const isGeneralFunded = (e: { funding?: string | null; scope?: string | null }) =>
  e.funding === 'routes' || e.funding === 'own_money' || e.scope === 'administrador';

export interface ServerCategory { id: string; name: string; icon: string | null; active: boolean; nature: Nature }
export const fetchCategories = async () => (await serverView<{ categories: ServerCategory[] }>('/v1/expense-categories')).categories;

/** Gastos generales con las fuentes nuevas (los dos alcances; el servidor recorta por RLS). */
export async function fetchGeneralExpenses(): Promise<ServerExpense[]> {
  const [a, e] = await Promise.all([
    serverView<{ expenses: ServerExpense[] }>('/v1/expenses?scope=administrador&limit=1000'),
    serverView<{ expenses: ServerExpense[] }>('/v1/expenses?scope=empresa&limit=1000'),
  ]);
  return [...a.expenses, ...e.expenses.filter(isGeneralFunded)].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

export const createGeneralExpense = (b: {
  scope: 'administrador' | 'empresa'; fundingSource: 'routes' | 'own_money'; categoryId: string; amountMinor: number; description: string;
  reference?: string; contributions?: Contribution[];
}, opId: string) => money<{ expense: ServerExpense; pendingMinor?: number }>('POST', '/v1/expenses', {
  scope: b.scope, fundingSource: b.fundingSource, categoryId: b.categoryId, amountMinor: b.amountMinor, description: b.description.trim(),
  ...(b.reference?.trim() ? { reference: b.reference.trim() } : {}),
  ...(b.fundingSource === 'routes' ? { contributions: b.contributions } : {}),
}, opId);

export const reverseExpense = (id: string, reason: string, opId: string) =>
  money<{ original: ServerExpense; reversal: ServerExpense }>('POST', `/v1/expenses/${encodeURIComponent(id)}/reverse`, { reason: reason.trim() }, opId);

export interface AdminPayable {
  adminId: string; name: string; status: string; pendingMinor: number; ownMoneyExpensesMinor: number; reimbursedMinor: number; lastMovementAt: string | null;
}
export interface Payables { isCash: false; totalPendingMinor: number; admins: AdminPayable[] }
export const fetchPayables = () => serverView<Payables>('/v1/capital/admin-payables');

export interface Reimbursement {
  id: string; operationId: string; adminId: string; payerId: string; amountMinor: number; source: 'routes' | 'admin_pool' | string; reason: string;
  entryDate: string; createdAt: string; state: 'vigente' | 'anulado' | string; reversedAt: string | null; reversedBy: string | null;
  reversalReason: string | null; contributions: ContributionView[];
}
export const fetchReimbursements = async () => (await serverView<{ reimbursements: Reimbursement[] }>('/v1/capital/reimbursements')).reimbursements;

/** route_base: `contributions` (de rutas de QUIEN PAGA); admin_pool: `amountMinor` desde su bolsa. */
export const reimburseAdmin = (b: { adminId: string; reason: string; contributions?: Contribution[]; amountMinor?: number }, opId: string) =>
  money<{ reimbursement: Reimbursement; pendingBeforeMinor: number; pendingAfterMinor: number }>('POST', '/v1/capital/reimbursements', {
    adminId: b.adminId, reason: b.reason.trim(),
    ...(b.contributions ? { contributions: b.contributions } : {}), ...(b.amountMinor != null ? { amountMinor: b.amountMinor } : {}),
  }, opId);

export const reverseReimbursement = (id: string, reason: string, opId: string) =>
  money<{ reimbursement: Reimbursement; pendingAfterMinor: number }>('POST', `/v1/capital/reimbursements/${encodeURIComponent(id)}/reverse`, { reason: reason.trim() }, opId);

// ---------------------------------------------------------------------------
// Diferencias y conciliación (0036, RB-D3): el Administrador responsable concilia sin aprobación superior
// ---------------------------------------------------------------------------

export type SourceKind = 'handover' | 'settlement_shortage' | 'settlement_surplus';
export type Resolution = 'route_shortage' | 'worker_owes' | 'surplus_to_base' | 'surplus_returned';
export interface DifferenceItem {
  sourceKind: SourceKind; sourceId: string; sourceLabel: string | null; routeId: string; routeName: string; workerId: string | null; workerName: string | null;
  holderId: string | null; holderName: string | null; kind: 'faltante' | 'sobrante'; expectedMinor: number; countedMinor: number; differenceMinor: number;
  pendingMinor: number; workerOwedMinor: number; carriedMinor: number; pending: boolean; occurredAt: string; businessDate: string; controllerId: string | null;
  allowedResolutions: Resolution[]; resolutions: { code: Resolution; label: string }[];
}
export interface DifferencesPage {
  items: DifferenceItem[];
  summary: { pendingCount: number; pendingShortageMinor: number; pendingSurplusMinor: number; workerOwedMinor: number; isCash: false };
}
export type DifferenceBlocker = 'ONLY_ADMINISTRATOR' | 'NO_VALID_CONTROLLER' | 'NOT_ROUTE_CONTROLLER' | 'PERIOD_CLOSED' | 'OWN_CASH' | 'ROUTE_IN_HANDOVER'
  | 'CAPITAL_MIGRATION_IN_PROGRESS';
export interface DifferencePreview extends Omit<DifferenceItem, 'routeName' | 'workerName' | 'holderName' | 'pending' | 'occurredAt' | 'businessDate' | 'sourceLabel'> {
  resolution: Resolution | null; resolutionLabel: string | null; allowedAmountsMinor: number[]; amountMinor: number | null; capitalModel: CapitalModel;
  legs: { kind: string; routeId: string | null; membershipId?: string | null; sign: 1 | -1 }[]; movesMoney: boolean; canResolve: boolean; blockers: DifferenceBlocker[];
}
export interface Conciliation {
  id: string; operationId: string; routeId: string; routeName: string | null; sourceKind: SourceKind; sourceLabel: string; sourceId: string | null;
  workerId: string | null; workerName: string | null; holderId: string | null; expectedMinor: number; countedMinor: number; differenceMinor: number;
  amountMinor: number; resolution: Resolution; resolutionLabel: string; carriedAfterMinor: number | null; reason: string; ledgerOperationId: string | null;
  movesMoney: boolean; capitalModel: string; entryDate: string; actorId: string; actorName: string | null; createdAt: string;
}

export const fetchDifferences = (status: 'pending' | 'all' = 'pending', routeId?: string) =>
  serverView<DifferencesPage>(`/v1/capital/differences?status=${status}${routeId ? `&routeId=${encodeURIComponent(routeId)}` : ''}`);
export const previewDifference = (sourceKind: SourceKind, sourceId: string, resolution: Resolution | null) =>
  serverView<DifferencePreview>(`/v1/capital/differences/preview?sourceKind=${sourceKind}&sourceId=${encodeURIComponent(sourceId)}${resolution ? `&resolution=${resolution}` : ''}`);
export const resolveDifference = (b: { sourceKind: SourceKind; sourceId: string; resolution: Resolution; amountMinor: number; reason: string }, opId: string) =>
  money<{ conciliation: Conciliation }>('POST', '/v1/capital/differences/resolve', { ...b, reason: b.reason.trim() }, opId);
export const fetchConciliations = async (routeId?: string) =>
  (await serverView<{ conciliations: Conciliation[] }>(`/v1/capital/conciliations?limit=200${routeId ? `&routeId=${encodeURIComponent(routeId)}` : ''}`)).conciliations;

/** RB-D1: cuentas pendientes de un Administrador antes de desactivarlo. */
export interface DeactivationCheck {
  applies: boolean; canDeactivate: boolean; legacy?: boolean;
  blockers: { code: string; message: string; amountMinor?: number; count?: number; routes?: unknown[]; items?: unknown[] }[];
}
export const fetchDeactivationCheck = (membershipId: string) =>
  serverView<DeactivationCheck>(`/v1/members/${encodeURIComponent(membershipId)}/deactivation-check`);

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
