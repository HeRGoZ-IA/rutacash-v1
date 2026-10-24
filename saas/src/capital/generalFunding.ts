// FINANCIACIÓN DE GASTOS GENERALES (R74, migración 0035, decisión D74-O4F del propietario).
//
//   · Alcance (a quién beneficia) y fuente (qué cuenta pagó) son independientes. Alcances generales:
//     `administrador` (gasto general de UN Administrador: varias de sus rutas) y `empresa`.
//   · Fuente `routes` (A y C1): aportes explícitos [{routeId, amountMinor}] de rutas donde el Administrador
//     que registra es el responsable de capital válido; la suma es el gasto; sale de la Base de cada ruta.
//     Solo con `capital_model = 'route_base'`. Regla DEFINITIVA del propietario: nunca rutas de OTRO
//     Administrador (ni en A, ni en C1, ni en reembolsos): `adex.general_contribution_route_allowed`.
//   · Fuente `own_money` (C2): el Administrador pagó con dinero propio → obligación de la empresa con él
//     (`admin_payable`), siempre reembolsable, sin aprobación, NUNCA efectivo. Ambos modelos de capital.
//   · Reembolso: con `route_base`, aportes explícitos de rutas de QUIEN PAGA; con `admin_pool`, desde su
//     bolsa. Nunca más que lo pendiente. Anulable por quien pagó.
// Solo el Administrador mueve este dinero (el SuperAdmin nunca; Secretario, Supervisor y Cobrador no).
// Segunda barrera en PostgreSQL (`adex.general_expense_post`, `adex.admin_reimbursement_post`, …). Sin cifras
// de saldos ajenos en los errores.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from '../structure/common.ts';
import { pathId, reqId, reqText } from '../structure/input.ts';
import { ID_RE } from '../authz/context.ts';
import { requireOperationId, routeOf, visibleEntries } from './service.ts';
import { requireControlsAllRoutes } from './conciliation.ts';

type Body = Record<string, unknown>;

export interface Contribution { routeId: string; amountMinor: number }

export const REIMBURSE_FIELDS = ['adminId', 'contributions', 'amountMinor', 'reason'] as const;

/** Solo el Administrador (el SuperAdmin supervisa; el resto no mueve dinero de la empresa). */
export function requireGeneralFundingActor(ctx: ActiveContext): void {
  if (ctx.role !== 'admin') {
    throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only an administrator moves money for general expenses and reimbursements');
  }
}

/**
 * `contributions`: lista de 1..20 objetos `{routeId, amountMinor}` (sin otros campos), rutas distintas e
 * importes enteros > 0. `undefined`/`null` → null. Error: 400 CONTRIBUTIONS_INVALID (mismo código que AX429).
 */
export function parseContributions(body: Body, key = 'contributions'): Contribution[] | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  const bad = (msg: string) => new ApiError(400, 'CONTRIBUTIONS_INVALID', msg, { field: key });
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) throw bad('contributions must be a list of 1 to 20 {routeId, amountMinor}');
  const out: Contribution[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad('each contribution is an object {routeId, amountMinor}');
    const keys = Object.keys(item as object);
    if (keys.some((k) => k !== 'routeId' && k !== 'amountMinor')) throw bad('unknown field in a contribution');
    const { routeId, amountMinor } = item as { routeId?: unknown; amountMinor?: unknown };
    if (typeof routeId !== 'string' || !ID_RE.test(routeId)) throw bad('routeId is invalid');
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw bad('amountMinor must be a positive integer (minor units)');
    out.push({ routeId, amountMinor });
  }
  if (new Set(out.map((c) => c.routeId)).size !== out.length) throw bad('a route contributes only once');
  return out;
}

export const sumOf = (cs: readonly Contribution[]) => cs.reduce((t, c) => t + c.amountMinor, 0);

/** Modelo de capital de la empresa del contexto. */
export async function capitalModelOf(client: pg.PoolClient, ctx: ActiveContext): Promise<string> {
  return (await client.query<{ m: string }>('select capital_model m from adex.companies where id = $1', [ctx.companyId])).rows[0]?.m ?? 'admin_pool';
}

/** Las rutas de los aportes existen y son visibles para el actor (la autoridad la valida PostgreSQL: AX430). */
export async function contributionRoutes(client: pg.PoolClient, ctx: ActiveContext, cs: readonly Contribution[]) {
  const names = new Map<string, string>();
  for (const c of cs) names.set(c.routeId, (await routeOf(client, ctx, c.routeId)).name);
  return names;
}

/** Entradas visibles de varias operaciones (una por aporte). */
export async function entriesOf(client: pg.PoolClient, ctx: ActiveContext, opIds: readonly string[]) {
  const out = [];
  for (const id of opIds) out.push(...(await visibleEntries(client, ctx, id)).map((e) => ({ operationId: id, ...e })));
  return out;
}

// ============================================================
// Reembolsos
// ============================================================

interface ReimbursementRow {
  id: string; operation_id: string; admin_membership_id: string; payer_membership_id: string; amount_minor: string; source: string;
  reason: string; entry_date: string | Date; created_at: Date; reversed_at: Date | null; reversed_by_membership_id: string | null;
  reversal_reason: string | null;
}
const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

async function contributionsOf(client: pg.PoolClient, ctx: ActiveContext, col: 'expense_id' | 'reimbursement_id', ids: readonly string[]) {
  const map = new Map<string, { routeId: string | null; routeName: string | null; amountMinor: number; operationId: string }[]>();
  if (!ids.length) return map;
  const r = await client.query<{ k: string; route_id: string | null; name: string | null; amount_minor: string; operation_id: string }>(
    `select g.${col} k, g.route_id, ro.name, g.amount_minor, g.operation_id
       from adex.general_funding_contributions g left join adex.routes ro on ro.company_id = g.company_id and ro.id = g.route_id
      where g.company_id = $1 and g.${col} = any($2) order by g.route_id nulls first`, [ctx.companyId, [...ids]]);
  for (const x of r.rows) {
    const list = map.get(x.k) ?? [];
    list.push({ routeId: x.route_id, routeName: x.name, amountMinor: Number(x.amount_minor), operationId: x.operation_id });
    map.set(x.k, list);
  }
  return map;
}

/** Aportes por gasto (para las vistas de gastos). */
export const expenseContributions = (client: pg.PoolClient, ctx: ActiveContext, ids: readonly string[]) => contributionsOf(client, ctx, 'expense_id', ids);

function reimbursementView(r: ReimbursementRow, contributions: { routeId: string | null; routeName: string | null; amountMinor: number; operationId: string }[]) {
  return {
    id: r.id, operationId: r.operation_id, adminId: r.admin_membership_id, payerId: r.payer_membership_id, amountMinor: Number(r.amount_minor),
    source: r.source, reason: r.reason, entryDate: ymd(r.entry_date), createdAt: r.created_at.toISOString(),
    state: r.reversed_at ? 'anulado' : 'vigente', reversedAt: r.reversed_at?.toISOString() ?? null, reversedBy: r.reversed_by_membership_id,
    reversalReason: r.reversal_reason, contributions,
  };
}

async function loadReimbursement(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  const r = (await client.query<ReimbursementRow>('select * from adex.admin_reimbursements where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!r) throw new ApiError(404, 'NOT_FOUND');
  return reimbursementView(r, (await contributionsOf(client, ctx, 'reimbursement_id', [r.id])).get(r.id) ?? []);
}

/**
 * Reembolso a un Administrador (todo o parte de lo pendiente).
 *   route_base: `contributions` obligatorias (rutas donde el actor es responsable); `amountMinor` opcional (= suma).
 *   admin_pool: `amountMinor` obligatorio, sin `contributions` (sale de la bolsa del actor).
 */
export async function reimburseAdmin(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const opId = requireOperationId(operationId);
  requireGeneralFundingActor(ctx);
  need(ctx, 'cashbox.viewConsolidated');
  const adminId = reqId(body, 'adminId');
  const contributions = parseContributions(body);
  const amountRaw = body['amountMinor'];
  let amount: number | null = null;
  if (amountRaw !== undefined && amountRaw !== null) {
    if (typeof amountRaw !== 'number' || !Number.isSafeInteger(amountRaw) || amountRaw <= 0) {
      throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
    }
    amount = amountRaw;
  }
  if (contributions && amount !== null && sumOf(contributions) !== amount) {
    throw new ApiError(400, 'CONTRIBUTIONS_INVALID', 'the contributions must add up to amountMinor', { field: 'contributions' });
  }
  if (!contributions && amount === null) throw new ApiError(400, 'INVALID_INPUT', 'contributions (route base) or amountMinor (administrator pools) is required');
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const model = await capitalModelOf(client, ctx);
  if (model === 'route_base' && !contributions) throw new ApiError(400, 'CONTRIBUTIONS_INVALID', 'with the route base model the reimbursement comes from route contributions', { field: 'contributions' });
  if (model !== 'route_base' && contributions) throw new ApiError(400, 'CONTRIBUTIONS_INVALID', 'without the route base model the reimbursement is paid from your pool: send amountMinor only', { field: 'contributions' });
  const names = contributions ? await contributionRoutes(client, ctx, contributions) : new Map<string, string>();
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.admin_reimbursement_post($1, $2, $3, $4, $5) r',
    [opId, adminId, amount, contributions ? JSON.stringify(contributions) : null, reason])).rows[0]!.r;
  const admin = (await client.query<{ display_name: string }>('select display_name from adex.memberships where company_id = $1 and id = $2', [ctx.companyId, adminId])).rows[0];
  const total = Number(r['amountMinor']);
  await audit(client, ctx, {
    action: 'ADMIN_REIMBURSEMENT_PAID', entityType: 'admin_reimbursement', entityId: String(r['reimbursementId']), routeId: null, reason,
    description: `Reembolso de ${total} a ${admin?.display_name ?? adminId}`
      + (contributions ? ` con aportes de ${contributions.map((c) => `${names.get(c.routeId) ?? c.routeId} (${c.amountMinor})`).join(', ')}` : ' desde la bolsa del Administrador')
      + `. Pendiente: ${String(r['pendingBeforeMinor'])} → ${String(r['pendingAfterMinor'])}.`,
    after: { adminId, amountMinor: total, contributions: r['contributions'], source: r['source'], pendingAfterMinor: r['pendingAfterMinor'] },
    metadata: { operationId: opId, ledgerOperationIds: r['operationIds'] },
  });
  return {
    reimbursement: await loadReimbursement(client, ctx, String(r['reimbursementId'])),
    pendingBeforeMinor: Number(r['pendingBeforeMinor']), pendingAfterMinor: Number(r['pendingAfterMinor']),
    entries: await entriesOf(client, ctx, r['operationIds'] as string[]),
  };
}

/** Anulación de un reembolso registrado por error (solo quien pagó; el dinero vuelve a cada Base o a su bolsa). */
export async function reverseReimbursement(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Body, operationId: string | null) {
  const opId = requireOperationId(operationId);
  requireGeneralFundingActor(ctx);
  const prev = await loadReimbursement(client, ctx, id);
  // R74 (0036, RB-D7): desde rutas, el responsable VIGENTE de TODAS las rutas aportantes (lista si son de varios).
  if (prev.source === 'routes') {
    const routes = (await client.query<{ r: string[] }>('select adex.general_funding_routes(null, $1) r', [prev.id])).rows[0]!.r;
    await requireControlsAllRoutes(client, ctx, routes);
  }
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.admin_reimbursement_reverse($1, $2, $3) r', [opId, prev.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ADMIN_REIMBURSEMENT_REVERSED', entityType: 'admin_reimbursement', entityId: prev.id, routeId: null, reason,
    description: `Reembolso anulado (${prev.amountMinor}): ${reason}`,
    before: { estado: 'vigente', amountMinor: prev.amountMinor }, after: { estado: 'anulado', pendingAfterMinor: r['pendingAfterMinor'] },
    metadata: { operationId: opId, ledgerOperationIds: r['operationIds'] },
  });
  return { reimbursement: await loadReimbursement(client, ctx, prev.id), pendingAfterMinor: Number(r['pendingAfterMinor']),
    entries: await entriesOf(client, ctx, r['operationIds'] as string[]) };
}

/** Reembolsos visibles (RLS: SuperAdmin todos; Administrador los que recibió o pagó). */
export async function listReimbursements(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  const adminId = q.get('adminId');
  if (adminId !== null) { pathId(adminId); params.push(adminId); where += ` and admin_membership_id = $${params.length}`; }
  const r = await client.query<ReimbursementRow>(`select * from adex.admin_reimbursements where ${where} order by created_at desc, id limit 500`, params);
  const cs = await contributionsOf(client, ctx, 'reimbursement_id', r.rows.map((x) => x.id));
  return r.rows.map((x) => reimbursementView(x, cs.get(x.id) ?? []));
}

export async function getReimbursement(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  return loadReimbursement(client, ctx, id);
}

/**
 * Saldos a favor de los Administradores («reembolsos pendientes»): obligación de la empresa, NUNCA efectivo.
 * SuperAdmin: todos; Administrador: el suyo.
 */
export async function adminPayables(client: pg.PoolClient, ctx: ActiveContext) {
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ admin_id: string; name: string; status: string; pending_minor: string; own_money_expenses_minor: string;
    reimbursed_minor: string; last_movement_at: Date | null }>('select * from adex.admin_payables()');
  const admins = r.rows.map((x) => ({
    adminId: x.admin_id, name: x.name, status: x.status, pendingMinor: Number(x.pending_minor),
    ownMoneyExpensesMinor: Number(x.own_money_expenses_minor), reimbursedMinor: Number(x.reimbursed_minor),
    lastMovementAt: x.last_movement_at?.toISOString() ?? null,
  }));
  return { isCash: false, totalPendingMinor: admins.reduce((t, a) => t + a.pendingMinor, 0), admins };
}

