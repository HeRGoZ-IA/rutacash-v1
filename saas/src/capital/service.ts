// CAPITAL CENTRALIZADO Y CUSTODIA (Fase 3): Empresa → bolsa del Administrador →
// custodia del trabajador por ruta. Sin caja financiera de ruta.
//
// Dos barreras:
//   1. Aquí, con las reglas PURAS de CLEAN (`can`, `routeCashAuthorityError`,
//      `isTransferInScope`, caja personal): errores claros antes de escribir.
//   2. `adex.capital_post` (0009), la ÚNICA vía de escritura: relee responsable,
//      custodio, ruta, periodo y fondos BAJO BLOQUEO y escribe operación + patas +
//      posiciones en la transacción del comando. Lo que aquí se lee antes de bloquear
//      (p. ej. el responsable) puede cambiar; lo que decide es la segunda barrera.
//
// Equivalencias con C1 de CLEAN (src/services/centralCapitalService.ts):
//   deliverCapitalToWorker → WORKER_DELIVERY · returnCapitalFromWorker → WORKER_RETURN
//   reverseCapitalDelivery → REVERSAL · transferBaseBetweenWorkers → WORKER_TRANSFER
//   registrarLedger → COMPANY_* / ADMIN_*
// y, nuevo en el servidor, ROUTE_REASSIGNMENT: la devolución en una ruta y la entrega
// en otra del MISMO responsable en una sola operación (C1 lo hace en dos pasos).
//
// Ronda 53: el rol Socio no existe en ADEX Online. PARTNER_CONTRIBUTION queda solo como
// historia (ni se crea ni se anula; su contrapartida es la cuenta externa). Los traspasos
// entre Administradores (ADMIN_TRANSFER_*) tienen su propio módulo (adminTransfers.ts).
//
// Visibilidad: toda lectura pasa por RLS con el contexto activo. El Cobrador solo ve
// su custodia; nadie ve la bolsa de otro Administrador; los errores nunca llevan cifras.

import type pg from 'pg';
import { routeCashAuthorityError, type RouteCashOperation } from '@/lib/permissions';
import { hasPersonalCashbox } from '@/lib/collectorAttribution';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed, routeUnrestricted, toCleanUser, type MembershipFacts } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { oneOf, optId, optText, pathId, reqId, reqText } from '../structure/input.ts';
import { claimRequest, fulfillRequest } from './requests.ts';

export type CapitalKind =
  | 'COMPANY_DEPOSIT' | 'COMPANY_WITHDRAWAL' | 'ADMIN_ALLOCATION' | 'ADMIN_RETURN' | 'PARTNER_CONTRIBUTION'
  | 'WORKER_DELIVERY' | 'WORKER_RETURN' | 'WORKER_TRANSFER' | 'ROUTE_REASSIGNMENT' | 'REVERSAL' | 'LOAN_DISBURSEMENT'
  | 'COLLECTION' | 'WORKER_EXPENSE' | 'ROUTE_EXPENSE' | 'COMPANY_EXPENSE' | 'EXPENSE_REFUND'
  | 'SETTLEMENT_RETURN' | 'SETTLEMENT_SURPLUS' | 'ADMIN_TRANSFER_HOLD' | 'ADMIN_TRANSFER_APPLY' | 'ADMIN_TRANSFER_RELEASE'
  | 'DISBURSEMENT_ADJUSTMENT' | 'PRINCIPAL_RECLASSIFICATION'
  // R74 Base por Ruta (0034): solo con `companies.capital_model = 'route_base'` (ver routeBase.ts).
  | 'ROUTE_BASE_INJECTION' | 'ROUTE_BASE_WITHDRAWAL' | 'ROUTE_TRANSFER' | 'LEGACY_POOL_TO_ROUTE'
  // R74 (0035, D74-O4F): aportes de rutas a un gasto general, gasto con dinero propio y reembolso (generalFunding.ts).
  | 'GENERAL_EXPENSE_CONTRIBUTION' | 'GENERAL_EXPENSE_OWN_MONEY' | 'ADMIN_REIMBURSEMENT'
  // R74 (0036, RB-D3): conciliación de diferencias por el Administrador (conciliation.ts). No se anula.
  | 'DIFFERENCE_CONCILIATION';

/** Operaciones de la Base (0034): se escriben y se anulan con `adex.route_base_post`. */
export const ROUTE_BASE_KINDS: readonly string[] = ['ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE'];

/**
 * Recaudos y gastos (Fase 5) y asientos de un cuadre (Fase 6): se corrigen por su propio
 * comando (el cuadre, solo reabriéndolo), nunca por la anulación genérica.
 */
const OWN_CORRECTION_KINDS: readonly string[] = ['COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND',
  'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
  // R74 (0035): el gasto general se anula con /v1/expenses/:id/reverse; el reembolso, con /v1/capital/reimbursements/:id/reverse.
  'GENERAL_EXPENSE_CONTRIBUTION', 'GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT',
  // R74 (0036): una conciliación es definitiva (no se anula por la vía genérica).
  'DIFFERENCE_CONCILIATION'];

const COMPANY_KINDS: readonly string[] = ['COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN'];

export interface OpRow {
  id: string; operation_id: string; kind: CapitalKind; amount_minor: string; currency_code: string; route_id: string | null;
  to_route_id: string | null; admin_membership_id: string | null; worker_membership_id: string | null;
  counterpart_membership_id: string | null; sale_request_id: string | null; reverses_operation_id: string | null;
  reverses_kind: CapitalKind | null; reason: string; entry_date: string | Date; actor_membership_id: string; actor_role: string;
  created_at: Date;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

export function opView(r: OpRow) {
  return {
    id: r.id, operationId: r.operation_id, kind: r.kind, amountMinor: Number(r.amount_minor), currencyCode: r.currency_code,
    routeId: r.route_id, toRouteId: r.to_route_id, adminId: r.admin_membership_id, workerId: r.worker_membership_id,
    counterpartId: r.counterpart_membership_id, saleRequestId: r.sale_request_id, reversesOperationId: r.reverses_operation_id,
    reversesKind: r.reverses_kind, reason: r.reason, entryDate: ymd(r.entry_date), actorId: r.actor_membership_id,
    actorRole: r.actor_role, createdAt: r.created_at.toISOString(),
  };
}

// ---------- Entradas ----------

/** Importe en unidades menores: entero positivo, sin decimales (nunca coma flotante). */
export function amountOf(body: Record<string, unknown>): number {
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  }
  return v;
}

export const reasonOf = (body: Record<string, unknown>) => {
  const r = reqText(body, 'reason', 300);
  if (r.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  return r;
};

// ---------- Hechos releídos en la transacción ----------

export interface RouteFacts { id: string; name: string; controller: string | null }

/** Ruta del alcance del actor (una ajena es indistinguible de una inexistente). */
export async function routeOf(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<RouteFacts> {
  if (!routeUnrestricted(ctx) && !ctx.routeIds.includes(id)) throw new ApiError(404, 'NOT_FOUND');
  const r = await client.query<{ id: string; name: string; capital_controller_membership_id: string | null }>(
    'select id, name, capital_controller_membership_id from adex.routes where company_id = $1 and id = $2', [ctx.companyId, id]);
  const row = r.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND');
  return { id: row.id, name: row.name, controller: row.capital_controller_membership_id };
}

/** `routeCashAuthorityError` de CLEAN con el responsable y las asignaciones del servidor. */
export function requireAuthority(ctx: ActiveContext, route: RouteFacts, op: RouteCashOperation, members: Map<string, MembershipFacts>): void {
  const users = [...members.values()].map(toCleanUser);
  const controller = route.controller ? members.get(route.controller) : undefined;
  if (!controller || controller.role !== 'admin' || controller.status !== 'activo' || !controller.routeIds.includes(route.id)) {
    throw new ApiError(409, 'CAPITAL_CONTROLLER_MISSING', 'the route has no valid capital controller');
  }
  const err = routeCashAuthorityError(toCleanUser(ctx), { id: route.id, tenantId: ctx.companyId, capitalControllerAdminId: route.controller ?? undefined }, op, users);
  if (err) throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', err);
}

/** `custodianBlockedReason` de CLEAN: activa, con caja personal y asignada a la ruta. */
export function requireCustodian(members: Map<string, MembershipFacts>, id: string, routeId: string): MembershipFacts {
  const m = members.get(id);
  if (!m) throw new ApiError(404, 'NOT_FOUND');
  if (m.status !== 'activo' || !hasPersonalCashbox(m.role) || !m.routeIds.includes(routeId)) throw new ApiError(400, 'CUSTODIAN_INVALID');
  return m;
}

function requireWorker(members: Map<string, MembershipFacts>, id: string): MembershipFacts {
  const m = members.get(id);
  if (!m) throw new ApiError(404, 'NOT_FOUND');
  if (!hasPersonalCashbox(m.role)) throw new ApiError(400, 'CUSTODIAN_INVALID');
  return m;
}

/** Nadie reduce su propia custodia (la registra otra persona). */
function notSelf(ctx: ActiveContext, workerId: string): void {
  if (workerId === ctx.membershipId) throw new ApiError(403, 'SELF_REDUCTION_FORBIDDEN');
}

// ---------- Escritura (segunda barrera) ----------

interface PostParams {
  kind: CapitalKind; amount?: number | null; reason: string; route?: string | null; worker?: string | null; counterpart?: string | null;
  toRoute?: string | null; admin?: string | null; saleRequest?: string | null; reverses?: string | null;
}

export function requireOperationId(operationId: string | null): string {
  if (!operationId) throw new ApiError(400, 'OPERATION_ID_REQUIRED');
  return operationId;
}

async function post(client: pg.PoolClient, operationId: string, p: PostParams): Promise<OpRow> {
  const r = await client.query<OpRow>(
    'select * from adex.capital_post($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
    [operationId, p.kind, p.amount ?? null, p.reason, p.route ?? null, p.worker ?? null, p.counterpart ?? null, p.toRoute ?? null,
      p.admin ?? null, p.saleRequest ?? null, p.reverses ?? null]);
  return r.rows[0]!;
}

/** Patas de la operación VISIBLES para el actor (RLS: nunca la bolsa ajena). */
export async function visibleEntries(client: pg.PoolClient, ctx: ActiveContext, opId: string) {
  const r = await client.query<{ leg: number; kind: string; membership_id: string | null; route_id: string | null; amount_minor: string; balance_after_minor: string }>(
    `select e.leg, a.kind, a.membership_id, a.route_id, e.amount_minor, e.balance_after_minor
       from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = $2 order by e.leg`, [ctx.companyId, opId]);
  return r.rows.map((x) => ({
    leg: x.leg, account: { kind: x.kind, membershipId: x.membership_id, routeId: x.route_id },
    amountMinor: Number(x.amount_minor), balanceAfterMinor: Number(x.balance_after_minor),
  }));
}

export const ACTIONS: Record<CapitalKind, string> = {
  COMPANY_DEPOSIT: 'COMPANY_CAPITAL_DEPOSIT', COMPANY_WITHDRAWAL: 'COMPANY_CAPITAL_WITHDRAWAL',
  ADMIN_ALLOCATION: 'ADMIN_CAPITAL_ALLOCATED', ADMIN_RETURN: 'ADMIN_CAPITAL_RETURNED',
  PARTNER_CONTRIBUTION: 'PARTNER_CONTRIBUTION_REGISTERED', WORKER_DELIVERY: 'CENTRAL_CAPITAL_DELIVERED',
  WORKER_RETURN: 'CENTRAL_CAPITAL_RETURNED', WORKER_TRANSFER: 'CASH_CUSTODY_PERSON_TO_PERSON',
  ROUTE_REASSIGNMENT: 'CENTRAL_CAPITAL_REASSIGNED', REVERSAL: 'CAPITAL_OPERATION_REVERSED', LOAN_DISBURSEMENT: 'CONFIRM_DISBURSEMENT',
  COLLECTION: 'REGISTER_PAYMENT', WORKER_EXPENSE: 'CREATE_EXPENSE', ROUTE_EXPENSE: 'CREATE_EXPENSE', COMPANY_EXPENSE: 'CREATE_EXPENSE',
  EXPENSE_REFUND: 'EXPENSE_REFUNDED', SETTLEMENT_RETURN: 'CASH_SETTLEMENT_CLOSED', SETTLEMENT_SURPLUS: 'CASH_SETTLEMENT_CLOSED',
  ADMIN_TRANSFER_HOLD: 'ADMIN_TRANSFER_REGISTERED', ADMIN_TRANSFER_APPLY: 'ADMIN_TRANSFER_APPLIED', ADMIN_TRANSFER_RELEASE: 'ADMIN_TRANSFER_RELEASED',
  DISBURSEMENT_ADJUSTMENT: 'RECTIFY_CREDIT', PRINCIPAL_RECLASSIFICATION: 'RECTIFY_CREDIT',
  ROUTE_BASE_INJECTION: 'ROUTE_BASE_INJECTED', ROUTE_BASE_WITHDRAWAL: 'ROUTE_BASE_WITHDRAWN', ROUTE_TRANSFER: 'ROUTE_BASE_TRANSFERRED',
  LEGACY_POOL_TO_ROUTE: 'UNASSIGNED_CAPITAL_ASSIGNED',
  GENERAL_EXPENSE_CONTRIBUTION: 'CREATE_EXPENSE', GENERAL_EXPENSE_OWN_MONEY: 'CREATE_EXPENSE', ADMIN_REIMBURSEMENT: 'ADMIN_REIMBURSEMENT_PAID',
  DIFFERENCE_CONCILIATION: 'DIFFERENCE_CONCILIATED',
};

/** Escribe, audita (misma transacción) y responde con lo que el actor puede ver. */
async function execute(client: pg.PoolClient, ctx: ActiveContext, operationId: string | null, p: PostParams, description: string) {
  const op = await post(client, requireOperationId(operationId), p);
  const view = opView(op);
  await audit(client, ctx, {
    action: ACTIONS[p.kind], entityType: 'capital_operation', entityId: op.id, routeId: op.route_id, description, reason: p.reason,
    after: { kind: view.kind, amountMinor: view.amountMinor, currencyCode: view.currencyCode, routeId: view.routeId, toRouteId: view.toRouteId,
      adminId: view.adminId, workerId: view.workerId, counterpartId: view.counterpartId, saleRequestId: view.saleRequestId,
      reversesOperationId: view.reversesOperationId, entryDate: view.entryDate },
    metadata: { operationId: op.operation_id },
  });
  return { operation: view, entries: await visibleEntries(client, ctx, op.id) };
}

// ============================================================
// Comandos
// ============================================================

/** Capital nuevo de la empresa (aporte externo). SuperAdmin. */
export async function companyDeposit(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  need(ctx, 'capital.allocateAdmins');
  const amount = amountOf(body);
  return execute(client, ctx, operationId, { kind: 'COMPANY_DEPOSIT', amount, reason: reasonOf(body) }, `Capital ${amount} depositado en la empresa.`);
}

/** Salida de capital de la empresa: solo lo NO asignado a Administradores. SuperAdmin. */
export async function companyWithdrawal(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  need(ctx, 'capital.allocateAdmins');
  const amount = amountOf(body);
  return execute(client, ctx, operationId, { kind: 'COMPANY_WITHDRAWAL', amount, reason: reasonOf(body) }, `Capital ${amount} retirado de la empresa.`);
}

async function requireAdmin(client: pg.PoolClient, ctx: ActiveContext, adminId: string, mustBeActive: boolean): Promise<MembershipFacts> {
  const a = (await loadMembers(client, ctx, [adminId])).get(adminId);
  if (!a || a.role !== 'admin') throw new ApiError(404, 'NOT_FOUND');
  if (mustBeActive && a.status !== 'activo') throw new ApiError(409, 'MEMBER_INACTIVE');
  return a;
}

/**
 * Ronda 59: un comando de capital que ATIENDE una solicitud (`requestId`). La solicitud se bloquea
 * antes de escribir y se enlaza después, en la misma transacción: si algo falla no queda nada.
 */
async function attending<T extends { operation: { id: string } }>(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>,
  kind: Parameters<typeof claimRequest>[3], run: () => Promise<T>): Promise<T & { request?: unknown }> {
  const requestId = optId(body, 'requestId');
  if (requestId) await claimRequest(client, ctx, requestId, kind);
  const out = await run();
  return requestId ? { ...out, request: await fulfillRequest(client, ctx, requestId, { operation: out.operation.id }) } : out;
}

/** Empresa → bolsa del Administrador. SuperAdmin; no supera el disponible de la empresa. Puede atender una solicitud de capital. */
export async function allocateToAdmin(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  need(ctx, 'capital.allocateAdmins');
  const admin = await requireAdmin(client, ctx, reqId(body, 'adminId'), true);
  const amount = amountOf(body);
  return attending(client, ctx, body, 'admin_allocation', () => execute(client, ctx, operationId,
    { kind: 'ADMIN_ALLOCATION', amount, reason: reasonOf(body), admin: admin.membershipId },
    `Capital ${amount} asignado a la bolsa de ${admin.displayName}.`));
}

/**
 * Bolsa del Administrador → empresa; solo lo disponible (no lo que está en custodia).
 *   · SuperAdmin: recoge capital de un Administrador.
 *   · Administrador (Ronda 59): DEVUELVE capital de SU bolsa, sin aprobación del SuperAdmin
 *     (entrega voluntaria); puede atender una solicitud de devolución.
 */
export async function returnFromAdmin(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const sa = allowed(ctx, 'capital.allocateAdmins');
  if (!sa) {
    need(ctx, 'capital.manage');
    if (ctx.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED');
    const own = optId(body, 'adminId') ?? ctx.membershipId;
    if (own !== ctx.membershipId) throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'an administrator only returns capital from their own pool');
  } else if (optId(body, 'requestId')) {
    throw new ApiError(409, 'REQUEST_MISMATCH', 'a return request is attended by the administrator who holds the capital');
  }
  const admin = await requireAdmin(client, ctx, sa ? reqId(body, 'adminId') : ctx.membershipId, false);
  const amount = amountOf(body);
  return attending(client, ctx, body, 'admin_return', () => execute(client, ctx, operationId,
    { kind: 'ADMIN_RETURN', amount, reason: reasonOf(body), admin: admin.membershipId },
    sa ? `Capital ${amount} recogido de la bolsa de ${admin.displayName}.` : `Capital ${amount} devuelto por ${admin.displayName} a la empresa (entrega voluntaria).`));
}

export const OWN_RETURN_FIELDS = ['routeId', 'amountMinor', 'concept', 'note', 'requestId'] as const;
const CONCEPT_TEXT = { recaudo: 'Entrega de recaudo', base: 'Devolución de base' } as const;

/**
 * Ronda 59 · ENTREGA VOLUNTARIA del Cobrador: efectivo de SU custodia en una ruta suya → bolsa del
 * responsable de capital de la ruta. Sin aprobación del Administrador (queda avisado y puede anularla
 * si no la recibió). Recaudo y devolución de Base se distinguen por su concepto (motivo y auditoría);
 * el asiento es el mismo `WORKER_RETURN` que registra el Administrador. Nunca supera el efectivo que
 * tiene (ni baja de su arrastre). Puede atender una solicitud de entrega.
 */
export async function returnOwnCash(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  if (ctx.role !== 'cobrador') throw new ApiError(403, 'PERMISSION_DENIED');
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  const concept = oneOf(body, 'concept', ['recaudo', 'base'] as const);
  const note = optText(body, 'note', 200);
  const amount = amountOf(body);
  const reason = note ? `${CONCEPT_TEXT[concept]}: ${note}` : CONCEPT_TEXT[concept];
  return attending(client, ctx, body, 'worker_return', () => execute(client, ctx, operationId,
    { kind: 'WORKER_RETURN', amount, reason, route: route.id, worker: ctx.membershipId },
    `${CONCEPT_TEXT[concept]} ${amount} de ${ctx.displayName} (${route.name}) a la bolsa del responsable (entrega voluntaria).`));
}

/**
 * Bolsa del responsable → custodia del trabajador en ESA ruta. No crea venta ni
 * deuda; la referencia a una solicitud es opcional. El importe lo decide el
 * Administrador (anticipo del día, venta completa o solo la diferencia).
 */
export async function deliverToWorker(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  const routeId = route.id;
  need(ctx, 'capital.manage', { routeId });
  need(ctx, 'cashCustody.manage', { routeId });
  const members = await loadMembers(client, ctx);
  requireAuthority(ctx, route, 'structural', members);
  const worker = requireCustodian(members, reqId(body, 'workerId'), routeId);
  // R74 (DS-05): nadie se entrega capital a SU propia custodia, tampoco con otra membresía
  // (p. ej. el Administrador responsable que además es Cobrador). PostgreSQL lo repite (AX419).
  const self = (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, worker.membershipId])).rows[0]!.s;
  if (self) throw new ApiError(403, 'SELF_DELIVERY_FORBIDDEN', 'nobody delivers capital to their own custody');
  const saleRequestId = optId(body, 'saleRequestId');
  const amount = amountOf(body);
  return execute(client, ctx, operationId,
    { kind: 'WORKER_DELIVERY', amount, reason: reasonOf(body), route: routeId, worker: worker.membershipId, saleRequest: saleRequestId },
    `Capital ${amount} entregado a ${worker.displayName} en ${route.name}.`);
}

/**
 * Custodia del trabajador → bolsa del responsable. Autoridad `settle` (responsable o
 * Supervisor de la ruta; R74: ya no el SuperAdmin); nadie registra su propia devolución. No supera
 * la custodia (la posición puede saldar el faltante arrastrado, como en CLEAN).
 */
export async function returnFromWorker(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  const routeId = route.id;
  need(ctx, 'cashCustody.manage', { routeId });
  const members = await loadMembers(client, ctx);
  requireAuthority(ctx, route, 'settle', members);
  const worker = requireWorker(members, reqId(body, 'workerId'));
  notSelf(ctx, worker.membershipId);
  const amount = amountOf(body);
  return execute(client, ctx, operationId, { kind: 'WORKER_RETURN', amount, reason: reasonOf(body), route: routeId, worker: worker.membershipId },
    `Devolución ${amount} de ${worker.displayName} (${route.name}) a la bolsa del responsable.`);
}

/** Traspaso entre trabajadores de la MISMA ruta (no toca ninguna bolsa). */
export async function transferBetweenWorkers(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  const routeId = route.id;
  need(ctx, 'cashCustody.manage', { routeId });
  const members = await loadMembers(client, ctx);
  requireAuthority(ctx, route, 'settle', members);
  const from = requireWorker(members, reqId(body, 'fromWorkerId'));
  if (!from.routeIds.includes(routeId)) throw new ApiError(400, 'CUSTODIAN_INVALID');
  const to = requireCustodian(members, reqId(body, 'toWorkerId'), routeId);
  if (from.membershipId === to.membershipId) throw new ApiError(400, 'INVALID_INPUT', 'origin and destination must differ');
  notSelf(ctx, from.membershipId);
  const amount = amountOf(body);
  return execute(client, ctx, operationId,
    { kind: 'WORKER_TRANSFER', amount, reason: reasonOf(body), route: routeId, worker: from.membershipId, counterpart: to.membershipId },
    `Traspaso ${amount} de ${from.displayName} a ${to.displayName} en ${route.name}.`);
}

/**
 * Reasignación entre rutas del MISMO responsable: la custodia de una ruta vuelve a
 * su bolsa y sale hacia la custodia de otra ruta, en una sola operación (cada ruta
 * conserva su atribución). Solo el responsable de ambas; el trabajador no se mueve
 * dinero a sí mismo. Responsables distintos: decisión D2 abierta → 409.
 */
export async function reassignBetweenRoutes(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const fromRouteId = reqId(body, 'fromRouteId');
  const toRouteId = reqId(body, 'toRouteId');
  if (fromRouteId === toRouteId) throw new ApiError(400, 'INVALID_INPUT', 'routes must differ');
  // Ruta fuera del alcance = inexistente (404) antes de cualquier otra respuesta.
  const [from, to] = [await routeOf(client, ctx, fromRouteId), await routeOf(client, ctx, toRouteId)];
  for (const routeId of [fromRouteId, toRouteId]) {
    need(ctx, 'capital.manage', { routeId });
    need(ctx, 'cashCustody.manage', { routeId });
  }
  const members = await loadMembers(client, ctx);
  if (from.controller !== to.controller) {
    throw new ApiError(409, 'DECISION_PENDING_D2', 'moving cash between routes of different capital controllers depends on decision D2');
  }
  requireAuthority(ctx, from, 'structural', members);
  requireAuthority(ctx, to, 'structural', members);
  const worker = requireWorker(members, reqId(body, 'fromWorkerId'));
  const recipient = requireCustodian(members, reqId(body, 'toWorkerId'), toRouteId);
  notSelf(ctx, worker.membershipId);
  const amount = amountOf(body);
  return execute(client, ctx, operationId,
    { kind: 'ROUTE_REASSIGNMENT', amount, reason: reasonOf(body), route: fromRouteId, toRoute: toRouteId, worker: worker.membershipId, counterpart: recipient.membershipId },
    `Reasignación ${amount}: ${worker.displayName} (${from.name}) → ${recipient.displayName} (${to.name}).`);
}

/**
 * Anulación con asiento espejo (nunca se borra ni se reescribe la original):
 *   · entrega: solo si el trabajador aún conserva ese efectivo en la ruta;
 *   · devolución, aporte, asignación, devolución a la empresa, depósito: solo si la
 *     cuenta que recibió aún lo tiene (sin sobregiro);
 *   · retiro de la empresa: NO (reintroduciría dinero; se registra un depósito);
 *   · una anulación no se anula; cada operación se anula una sola vez.
 */
export async function reverseOperation(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  pathId(id);
  const r = await client.query<OpRow>('select * from adex.capital_operations where company_id = $1 and id = $2', [ctx.companyId, id]);
  const orig = r.rows[0];
  if (!orig) throw new ApiError(404, 'NOT_FOUND');
  // Un crédito desembolsado no se «anula»: el dinero está en manos del cliente (cobros y castigo, fases 4–5).
  if (orig.kind === 'LOAN_DISBURSEMENT') throw new ApiError(409, 'REVERSAL_NOT_ALLOWED');
  // Ronda 73: el ajuste de una rectificación se corrige con otra rectificación del crédito.
  if (orig.kind === 'DISBURSEMENT_ADJUSTMENT' || orig.kind === 'PRINCIPAL_RECLASSIFICATION') throw new ApiError(409, 'REVERSAL_NOT_ALLOWED', 'rectify the credit again instead');
  // Un aporte histórico de socio (Ronda 53) ya no tiene contrapartida a la que volver.
  if (orig.kind === 'PARTNER_CONTRIBUTION') throw new ApiError(409, 'REVERSAL_NOT_ALLOWED', 'historical partner contributions cannot be reversed');
  // R74 Base por Ruta (0034): solo la inyección se anula, con su propio comando (`adex.route_base_post`).
  if (ROUTE_BASE_KINDS.includes(orig.kind) || (orig.kind === 'REVERSAL' && ROUTE_BASE_KINDS.includes(orig.reverses_kind ?? ''))) {
    const { reverseRouteBase } = await import('./routeBase.ts');
    return reverseRouteBase(client, ctx, orig, reasonOf(body), operationId);
  }
  // Un recaudo o un gasto se anula con su comando (recalcula el crédito o enlaza el gasto).
  if (OWN_CORRECTION_KINDS.includes(orig.kind) || (orig.kind === 'REVERSAL' && OWN_CORRECTION_KINDS.includes(orig.reverses_kind ?? ''))) {
    throw new ApiError(409, 'REVERSAL_NOT_ALLOWED', 'use the command of the operation (collection, expense, settlement or administrator transfer)');
  }
  if (COMPANY_KINDS.includes(orig.kind)) need(ctx, 'capital.allocateAdmins');
  else need(ctx, 'capital.manage', { routeId: orig.route_id ?? undefined });
  if (orig.route_id && !COMPANY_KINDS.includes(orig.kind)) {
    const members = await loadMembers(client, ctx);
    const route = await routeOf(client, ctx, orig.route_id);
    if (orig.kind !== 'REVERSAL') {
      requireAuthority(ctx, route, 'correct', members);
      // R74 (0037): con el periodo de hoy cerrado, 409 con la reapertura como camino (no un rechazo sin salida).
      const { requireOpenPeriods } = await import('./corrections.ts');
      await requireOpenPeriods(client, ctx, [orig.route_id, orig.to_route_id].filter((x): x is string => !!x));
    }
  }
  const reason = reasonOf(body);
  return execute(client, ctx, operationId, { kind: 'REVERSAL', reason, reverses: orig.id },
    `Anulación de ${orig.kind} ${Number(orig.amount_minor)}.`);
}

// ============================================================
// Consultas (todas filtradas por RLS en el contexto activo)
// ============================================================

/** Posiciones de custodia visibles: el Cobrador, solo la suya. */
export async function listCustody(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const r = await client.query<{ route_id: string; membership_id: string; display_name: string; role: string; balance_minor: string; carried_minor: string; updated_at: Date }>(
    `select a.route_id, a.membership_id, m.display_name, m.role, a.balance_minor, a.carried_minor, a.updated_at
       from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
      where a.company_id = $1 and a.kind = 'custody' ${routeId ? 'and a.route_id = $2' : ''}
      order by a.route_id, m.display_name, a.membership_id`, routeId ? [ctx.companyId, routeId] : [ctx.companyId]);
  return r.rows.map((x) => ({
    routeId: x.route_id, workerId: x.membership_id, workerName: x.display_name, role: x.role,
    balanceMinor: Number(x.balance_minor), carriedMinor: Number(x.carried_minor),
    // Lo que puede traspasar o anularse: billetes, no deuda arrastrada (`transferableCash`).
    transferableMinor: Math.max(0, Number(x.balance_minor) - Number(x.carried_minor)),
    updatedAt: x.updated_at.toISOString(),
  }));
}

export async function listOperations(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 100) || 100, 1), 500);
  const r = await client.query<OpRow>(
    `select * from adex.capital_operations where company_id = $1 ${routeId ? 'and (route_id = $3 or to_route_id = $3)' : ''}
      order by created_at desc, id limit $2`, routeId ? [ctx.companyId, limit, routeId] : [ctx.companyId, limit]);
  return r.rows.map(opView);
}

export async function getOperation(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  const r = await client.query<OpRow>('select * from adex.capital_operations where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return { operation: opView(r.rows[0]), entries: await visibleEntries(client, ctx, id) };
}

interface AdminPool {
  adminId: string; name: string; status: string;
  availableMinor: number; allocatedNetMinor: number; partnerContributionsMinor: number;
  deliveredToWorkersMinor: number; returnedFromWorkersMinor: number; reassignedNetMinor: number;
  /** Gastos de ruta y administrativos pagados con la bolsa (neto de anulaciones y reintegros). */
  expensesPaidMinor: number;
  /** Cobros que no entraron a ninguna caja personal (C1) y desembolsos administrativos. */
  collectionsReceivedMinor: number; disbursedFromPoolMinor: number;
  /** Efectivo en custodia de trabajadores en las rutas que HOY controla. No es disponible. */
  custodyUnderResponsibilityMinor: number;
  /** Traspasos entre Administradores ya aplicados (neto: recibidos − enviados). */
  adminTransfersNetMinor: number;
  /** Capital comprometido en traspasos PENDIENTES que salen de esta bolsa (ya no está en el disponible). */
  pendingTransfersOutMinor: number;
}

/** Bolsas de Administradores (flujos por tipo) y posición de la empresa. */
async function adminPools(client: pg.PoolClient, ctx: ActiveContext, onlyAdmin: string | null): Promise<AdminPool[]> {
  const r = await client.query<{
    membership_id: string; display_name: string; status: string; balance: string;
    allocated: string; contributions: string; delivered: string; returned: string; reassigned: string; custody: string;
    expenses: string; collections: string; disbursed: string; transfers: string; pending_out: string;
  }>(
    // Las patas se agregan POR CUENTA (lateral sobre el índice company_id + account_id): con un
    // join y group by, el planificador podía recorrer el libro de todas las empresas evaluando
    // la RLS fila a fila (minutos en staging). Mismas sumas, mismos filtros.
    `select a.membership_id, m.display_name, m.status, a.balance_minor balance,
            f.allocated, f.contributions, f.delivered, f.returned, f.reassigned, f.expenses, f.collections, f.disbursed,
            coalesce(f.applied_in, 0) - coalesce((select sum(t.amount_minor) from adex.admin_transfers t where t.company_id = a.company_id
                       and t.origin_admin_membership_id = a.membership_id and t.state = 'applied'), 0) transfers,
            coalesce((select sum(t.amount_minor) from adex.admin_transfers t where t.company_id = a.company_id
                       and t.origin_admin_membership_id = a.membership_id and t.state = 'pending'), 0) pending_out,
            coalesce((select sum(c.balance_minor) from adex.capital_accounts c join adex.routes ro on ro.company_id = c.company_id and ro.id = c.route_id
                       where c.company_id = a.company_id and c.kind = 'custody' and ro.capital_controller_membership_id = a.membership_id), 0) custody
       from adex.capital_accounts a
       join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
       cross join lateral (
         select coalesce(sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) in ('ADMIN_ALLOCATION', 'ADMIN_RETURN')), 0) allocated,
                coalesce(sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'PARTNER_CONTRIBUTION'), 0) contributions,
                coalesce(-sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'WORKER_DELIVERY'), 0) delivered,
                coalesce(sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'WORKER_RETURN'), 0) returned,
                coalesce(sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'ROUTE_REASSIGNMENT'), 0) reassigned,
                coalesce(-sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) in ('ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND')), 0) expenses,
                coalesce(sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'COLLECTION'), 0) collections,
                coalesce(-sum(e.amount_minor) filter (where coalesce(o.reverses_kind, o.kind) = 'LOAN_DISBURSEMENT'), 0) disbursed,
                -- Traspasos recibidos y APLICADOS (lo enviado se descuenta arriba con sus traspasos aplicados).
                coalesce(sum(e.amount_minor) filter (where o.kind = 'ADMIN_TRANSFER_APPLY'), 0) applied_in
           from adex.capital_entries e
           join adex.capital_operations o on o.company_id = e.company_id and o.id = e.operation_id
          where e.company_id = a.company_id and e.account_id = a.id) f
      where a.company_id = $1 and a.kind = 'admin' ${onlyAdmin ? 'and a.membership_id = $2' : ''}
      order by m.display_name, a.membership_id`, onlyAdmin ? [ctx.companyId, onlyAdmin] : [ctx.companyId]);
  return r.rows.map((x) => ({
    adminId: x.membership_id, name: x.display_name, status: x.status, availableMinor: Number(x.balance),
    allocatedNetMinor: Number(x.allocated), partnerContributionsMinor: Number(x.contributions),
    deliveredToWorkersMinor: Number(x.delivered), returnedFromWorkersMinor: Number(x.returned), reassignedNetMinor: Number(x.reassigned),
    expensesPaidMinor: Number(x.expenses), collectionsReceivedMinor: Number(x.collections), disbursedFromPoolMinor: Number(x.disbursed),
    custodyUnderResponsibilityMinor: Number(x.custody),
    adminTransfersNetMinor: Number(x.transfers), pendingTransfersOutMinor: Number(x.pending_out),
  }));
}

/**
 * Resumen de capital. SuperAdmin: empresa, todas las bolsas y la custodia. Un
 * Administrador: SOLO su bolsa (nunca la de otro ni la de la empresa). El resto, 403.
 */
export async function capitalSummary(client: pg.PoolClient, ctx: ActiveContext) {
  if (allowed(ctx, 'capital.allocateAdmins')) {
    const t = (await client.query<{ kind: string; total: string }>(
      `select kind, sum(balance_minor)::text total from adex.capital_accounts where company_id = $1 group by kind`, [ctx.companyId])).rows;
    const total = (k: string) => Number(t.find((x) => x.kind === k)?.total ?? 0);
    const admins = await adminPools(client, ctx, null);
    // Aportes HISTÓRICOS de socio (Ronda 53): su contrapartida es ya la cuenta externa; se
    // informan aparte para que el neto externo siga siendo depósitos − retiros.
    const historicPartner = admins.reduce((s, a) => s + a.partnerContributionsMinor, 0);
    return {
      currencyCode: ctx.company.currencyCode, minorUnits: ctx.company.minorUnits,
      company: {
        availableMinor: total('company'),
        // Lo que entró a la cadena desde fuera: depósitos − retiros, y aportes históricos de socio.
        externalNetInMinor: -total('external') - historicPartner, partnerContributionsMinor: historicPartner,
        adminPoolsMinor: total('admin'), custodyMinor: total('custody'),
        // Capital prestado pendiente de cobro (cartera de las rutas): deuda de clientes, no efectivo.
        portfolioMinor: total('portfolio'),
        // Fase 5: interés efectivamente cobrado y gastos registrados (neto de correcciones).
        interestCollectedMinor: -total('income'), expensesMinor: total('expense'),
        // Fase 6: sobrantes de cuadres en control (recibidos, sin identificar). NO es capital
        // disponible ni se gasta; su destino es una decisión pendiente (F6-D02).
        unidentifiedSurplusMinor: total('suspense'),
        // Ronda 53: capital comprometido en traspasos entre Administradores pendientes.
        inTransitMinor: total('transit'),
      },
      admins,
    };
  }
  need(ctx, 'capital.manage');
  return { currencyCode: ctx.company.currencyCode, minorUnits: ctx.company.minorUnits, admins: await adminPools(client, ctx, ctx.membershipId) };
}

/**
 * Conciliación reproducible (SuperAdmin): saldos materializados = Σ patas; cada
 * operación cuadra; sin sobregiros; y conservación:
 *   −externa = empresa + Σ bolsas + tránsito + Σ custodias + …
 * (lo que entró a la cadena está en alguna cuenta; ninguna operación lo crea ni lo destruye).
 */
export async function capitalReconciliation(client: pg.PoolClient, ctx: ActiveContext) {
  need(ctx, 'capital.allocateAdmins');
  const q = async (sql: string) => Number((await client.query<{ n: string }>(sql, [ctx.companyId])).rows[0]!.n);
  // Comprobaciones que recorren el libro: en una sola función (0019) que corre como el
  // propietario del esquema, solo para el SuperAdmin del contexto. Mismas consultas.
  const ledger = (await client.query<{ r: Record<string, string | number> }>('select adex.capital_ledger_checks() r')).rows[0]!.r;
  const l = (k: string) => Number(ledger[k]);
  const mismatched = l('mismatched');
  const unbalanced = l('unbalanced');
  // Contrapartidas (externa, interés) miden lo que entró; la custodia solo puede
  // quedar negativa por un gasto del trabajador (73209ce), comprobado pata a pata.
  const overdrawn = await q(`select count(*)::text n from adex.capital_accounts where company_id = $1 and kind not in ('external', 'income', 'custody', 'unidentified', 'route_funding', 'admin_payable', 'route_difference') and balance_minor < 0`);
  const negativeCustody = l('negativeCustody');
  const foreignCurrency = await q(
    `select count(*)::text n from adex.capital_operations o join adex.companies c on c.id = o.company_id
      where o.company_id = $1 and o.currency_code <> c.currency_code`);
  const conservation = await q(`select coalesce(sum(balance_minor), 0)::text n from adex.capital_accounts where company_id = $1`);
  // Crédito ↔ libro: cada desembolso con su crédito (mismo importe y ruta) y viceversa.
  // Ronda 73: el capital vigente de un crédito rectificado = desembolso + Σ ajustes (pata de la cartera, con signo).
  const unmatched = await q(
    `select count(*)::text n from adex.capital_operations o
      where o.company_id = $1 and o.kind = 'LOAN_DISBURSEMENT'
        and not exists (select 1 from adex.sales s where s.company_id = o.company_id and s.id = o.sale_id and s.ledger_operation_id = o.id
                          and s.sale_value_minor = o.amount_minor + coalesce((select sum(e.amount_minor) from adex.capital_operations j
                                join adex.capital_entries e on e.company_id = j.company_id and e.operation_id = j.id
                                join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id and a.kind = 'portfolio'
                               where j.company_id = s.company_id and j.sale_id = s.id and j.kind = 'DISBURSEMENT_ADJUSTMENT'), 0)
                          and s.route_id = o.route_id and s.disbursement_status = 'desembolsado')`);
  const orphanCredits = await q(
    `select count(*)::text n from adex.sales s
      where s.company_id = $1 and s.ledger_operation_id is not null
        and not exists (select 1 from adex.capital_operations o where o.company_id = s.company_id and o.id = s.ledger_operation_id
                          and o.kind = 'LOAN_DISBURSEMENT' and o.sale_id = s.id)`);
  const duplicated = await q(
    `select count(*)::text n from (select sale_request_id from adex.sales where company_id = $1 and sale_request_id is not null
                                    group by sale_request_id having count(*) > 1) d`);
  // Cartera de cada ruta = capital prestado de sus créditos con asiento − capital ya cobrado.
  const portfolio = await q(
    `select count(*)::text n from adex.capital_accounts a
      where a.company_id = $1 and a.kind = 'portfolio'
        and a.balance_minor <> coalesce((select sum(s.sale_value_minor) from adex.sales s
                                          where s.company_id = a.company_id and s.route_id = a.route_id and s.ledger_operation_id is not null), 0)
                             - coalesce((select sum(p.principal_minor) from adex.payments p join adex.sales s on s.company_id = p.company_id and s.id = p.sale_id
                                          where p.company_id = a.company_id and s.route_id = a.route_id and s.ledger_operation_id is not null), 0)
                             -- Bloque A post-R73 (0032): capital reclasificado por rectificaciones con pagos.
                             - coalesce((select sum(s.principal_reclassified_minor) from adex.sales s
                                          where s.company_id = a.company_id and s.route_id = a.route_id and s.ledger_operation_id is not null), 0)`);
  // Fase 5 · recaudos: cada crédito con asiento cumple, con sus pagos (originales y anulaciones),
  //   saldo = Σ cuotas = total − Σ pagos; capital reconocido = round(pagado × capital / total);
  //   y cada pago tiene su asiento COLLECTION (o su anulación) por el mismo importe y ruta.
  const creditDrift = await q(
    `select count(*)::text n from adex.sales s
       left join lateral (select coalesce(sum(p.amount_minor), 0)::bigint paid, coalesce(sum(p.principal_minor), 0)::bigint principal
                            from adex.payments p where p.company_id = s.company_id and p.sale_id = s.id) p on true
       left join lateral (select coalesce(sum(i.balance_minor), 0) bal from adex.installments i where i.company_id = s.company_id and i.sale_id = s.id) i on true
      where s.company_id = $1 and s.ledger_operation_id is not null
        and (s.balance_minor <> i.bal or s.balance_minor <> s.total_value_minor - p.paid
             or p.principal + s.principal_reclassified_minor <> adex.credit_principal_of(p.paid, s.sale_value_minor, s.total_value_minor))`);
  const unmatchedPayments = await q(
    `select count(*)::text n from adex.payments p
       join adex.sales s on s.company_id = p.company_id and s.id = p.sale_id
      where p.company_id = $1 and s.ledger_operation_id is not null
        and not exists (select 1 from adex.capital_operations o where o.company_id = p.company_id and o.id = p.ledger_operation_id and o.payment_id = p.id
                          and o.amount_minor = abs(p.amount_minor) and o.route_id = p.route_id and coalesce(o.reverses_kind, o.kind) = 'COLLECTION')`);
  // Fase 5 · gastos: cada gasto con asiento coincide con él, y la cuenta de gastos de
  // cada ruta (o de empresa) es la suma de sus gastos netos.
  // R74 (0035): un gasto general con aportes de rutas tiene UNA operación por ruta (todas con su `expense_id`):
  // su suma es el gasto y la primera es la enlazada (el detalle por aporte lo comprueba `generalFundingDrift`).
  const unmatchedExpenses = await q(
    `select count(*)::text n from adex.expenses x
      where x.company_id = $1 and x.ledger_operation_id is not null
        and not (case when x.funding = 'routes'
                      then exists (select 1 from adex.capital_operations o where o.company_id = x.company_id and o.id = x.ledger_operation_id and o.expense_id = x.id)
                           and abs(x.amount_minor) = (select coalesce(sum(o.amount_minor), 0) from adex.capital_operations o
                                                       where o.company_id = x.company_id and o.expense_id = x.id)
                      else exists (select 1 from adex.capital_operations o where o.company_id = x.company_id and o.id = x.ledger_operation_id and o.expense_id = x.id
                                     and o.amount_minor = abs(x.amount_minor) and o.route_id is not distinct from x.route_id) end)`);
  const expenseAccounts = await q(
    `select count(*)::text n from adex.capital_accounts a
      where a.company_id = $1 and a.kind = 'expense'
        and a.balance_minor <> coalesce((select sum(x.amount_minor) from adex.expenses x where x.company_id = a.company_id
                                           and x.route_id is not distinct from a.route_id and x.ledger_operation_id is not null), 0)`);
  // Fase 6 · cuadres: el arrastre de cada custodia es el faltante de su último cuadre
  // vigente (0 sin cuadres); ninguna pata ajena al gasto del trabajador ni al retorno del
  // cuadre la dejó por debajo de su arrastre; cada cuadre coincide con el libro (posición
  // = Σ patas hasta su corte; retorno y sobrante = sus asientos, netos de su reapertura).
  const carriedDrift = l('carriedDrift');
  const settlementDrift = l('settlementDrift');
  // Sobrantes en control = Σ sobrantes de cuadres vigentes, por ruta; su contrapartida, igual con signo contrario.
  const surplusDrift = l('surplusDrift');
  // Cierres de periodo: lo archivado no cambia (nadie fecha asientos en un periodo cerrado).
  const closedDrift = l('closedDrift');
  // Ronda 53: la cuenta de tránsito es exactamente lo comprometido en traspasos pendientes.
  const transitDrift = await q(
    `select count(*)::text n from (select coalesce((select sum(balance_minor) from adex.capital_accounts where company_id = $1 and kind = 'transit'), 0)
        <> coalesce((select sum(amount_minor) from adex.admin_transfers where company_id = $1 and state = 'pending'), 0) bad) x where bad`);
  // Bloque A post-R73: el interés reconocido de cada ruta = Σ interés de sus pagos − Σ capital
  // reclasificado por rectificaciones (la cuenta de interés lleva saldo negativo).
  const incomeDrift = await q(
    `select count(*)::text n from adex.capital_accounts a
      where a.company_id = $1 and a.kind = 'income' and a.route_id is not null
        and -a.balance_minor <> coalesce((select sum(p.interest_minor) from adex.payments p join adex.sales s on s.company_id = p.company_id and s.id = p.sale_id
                                           where p.company_id = a.company_id and s.route_id = a.route_id and s.ledger_operation_id is not null), 0)
                              - coalesce((select sum(s.principal_reclassified_minor) from adex.sales s
                                           where s.company_id = a.company_id and s.route_id = a.route_id and s.ledger_operation_id is not null), 0)`);
  const checks = [
    { name: 'positions-match-ledger', ok: mismatched === 0, detail: mismatched },
    { name: 'operations-balanced', ok: unbalanced === 0, detail: unbalanced },
    { name: 'no-overdraft', ok: overdrawn === 0, detail: overdrawn },
    { name: 'single-currency', ok: foreignCurrency === 0, detail: foreignCurrency },
    { name: 'capital-conserved', ok: conservation === 0, detail: conservation },
    { name: 'disbursements-have-credit', ok: unmatched === 0, detail: unmatched },
    { name: 'credits-have-disbursement', ok: orphanCredits === 0, detail: orphanCredits },
    { name: 'one-credit-per-request', ok: duplicated === 0, detail: duplicated },
    { name: 'portfolio-matches-credits', ok: portfolio === 0, detail: portfolio },
    { name: 'negative-custody-only-by-worker-expense', ok: negativeCustody === 0, detail: negativeCustody },
    { name: 'credits-match-installments-and-payments', ok: creditDrift === 0, detail: creditDrift },
    { name: 'payments-have-ledger-entry', ok: unmatchedPayments === 0, detail: unmatchedPayments },
    { name: 'expenses-have-ledger-entry', ok: unmatchedExpenses === 0, detail: unmatchedExpenses },
    { name: 'expense-accounts-match-expenses', ok: expenseAccounts === 0, detail: expenseAccounts },
    { name: 'carried-matches-last-settlement', ok: carriedDrift === 0, detail: carriedDrift },
    { name: 'settlements-match-ledger', ok: settlementDrift === 0, detail: settlementDrift },
    { name: 'surplus-control-matches-settlements', ok: surplusDrift === 0, detail: surplusDrift },
    { name: 'closed-periods-unchanged', ok: closedDrift === 0, detail: closedDrift },
    { name: 'transit-matches-pending-transfers', ok: transitDrift === 0, detail: transitDrift },
    { name: 'income-matches-interest', ok: incomeDrift === 0, detail: incomeDrift },
    // R74 Base por Ruta (0034): ninguna ruta consume dinero de otra; desde el corte las bolsas no reciben
    // nada (solo se reparte «sin asignar») y cada operación que no cruza rutas suma cero dentro de cada ruta.
    { name: 'legs-in-route-scope', ok: l('routeScope') === 0, detail: l('routeScope') },
    { name: 'no-admin-pool-inflow-after-cutover', ok: l('adminInflowAfterCutover') === 0, detail: l('adminInflowAfterCutover') },
    { name: 'route-conservation', ok: l('routeConservation') === 0, detail: l('routeConservation') },
    // R74 (0035, D74-O4F): aportes de rutas y reembolsos cuadran con el libro; el saldo a favor de cada Administrador
    // = Σ gastos con dinero propio − Σ reembolsos vigentes (nunca efectivo).
    ...(ledger['generalFundingDrift'] === undefined ? [] : [
      { name: 'general-funding-matches-contributions', ok: l('generalFundingDrift') === 0, detail: l('generalFundingDrift') },
      { name: 'admin-payables-match-expenses-and-reimbursements', ok: l('adminPayableDrift') === 0, detail: l('adminPayableDrift') },
    ]),
    // R74 (0036, RB-D3): cada conciliación con movimiento tiene su operación y viceversa; el «faltante/sobrante conciliado»
    // de cada ruta = Σ faltantes reconocidos − Σ sobrantes incorporados (nunca efectivo).
    ...(ledger['conciliationDrift'] === undefined ? [] : [
      { name: 'differences-match-conciliations', ok: l('conciliationDrift') === 0, detail: l('conciliationDrift') },
    ]),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}


/**
 * Historial de responsables de capital (`listRouteControllerHistory` de CLEAN): los eventos
 * que el servidor registra al asignar o cambiar el responsable de una ruta. SuperAdmin:
 * todos los de sus rutas; Administrador: los suyos (como origen o destino). Solo lectura.
 */
export async function listControllerEvents(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const sa = allowed(ctx, 'capital.assignController');
  if (!sa) need(ctx, 'capital.manage');
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  if (routeId) { params.push(routeId); where += ` and route_id = $${params.length}`; }
  if (!sa) { params.push(ctx.membershipId); where += ` and (from_admin_membership_id = $${params.length} or to_admin_membership_id = $${params.length})`; }
  const r = await client.query<{ id: string; route_id: string; kind: string; from_admin_membership_id: string | null; to_admin_membership_id: string | null;
    capital_transferred_minor: string; base_at_change_minor: string | null; ledger_entry_id: string | null; reason: string | null; created_at: Date;
    actor_membership_id: string | null; actor_system: string | null; actor_role: string | null }>(
    `select * from adex.route_capital_controller_events where ${where} order by created_at desc, id limit 500`, params);
  return r.rows.map((e) => ({
    id: e.id, routeId: e.route_id, kind: e.kind, fromAdminId: e.from_admin_membership_id, toAdminId: e.to_admin_membership_id,
    capitalTransferredMinor: Number(e.capital_transferred_minor), baseAtChangeMinor: e.base_at_change_minor === null ? null : Number(e.base_at_change_minor),
    ledgerEntryId: e.ledger_entry_id, reason: e.reason, createdAt: e.created_at.toISOString(), actorId: e.actor_membership_id,
    actorSystem: e.actor_system, actorRole: e.actor_role,
  }));
}
