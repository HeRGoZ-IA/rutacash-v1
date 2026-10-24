// CORRECCIONES DEL RESPONSABLE DE CAPITAL (R74, migración 0037, regla definitiva del propietario).
//
//   La autoridad financiera máxima de una ruta es su Administrador responsable de capital (UNO por ruta). En SUS
//   rutas corrige y anula, también lo que él mismo registró, sin aprobación de nadie. Este módulo evita los
//   rechazos sin salida:
//     · Dependencias estructuradas (`details.dependencies: [{kind, id, label, amountMinor, action, …}]`): un
//       reembolso que impide anular un gasto con dinero propio, un periodo cerrado (reapertura explícita de 0016),
//       una operación conjunta con responsables distintos (anulación coordinada).
//     · Vista previa (`GET /v1/corrections/preview`): qué cambia en Base, custodias, cartera, gasto u obligación
//       ANTES de confirmar, y qué camino tiene la anulación (directa, en cadena, coordinada o bloqueada).
//     · Anulación coordinada (`/v1/capital/joint-reversals`): propone un responsable de una ruta afectada, cada
//       otro responsable confirma SU parte y la última confirmación asienta TODO en una transacción (PostgreSQL:
//       `adex.joint_reversal_*`). Quien propone cancela. Sin SuperAdmin, sin auditor, sin reasignaciones.
//   Segunda barrera siempre en PostgreSQL. Nunca saldos de rutas ajenas: solo nombres e importes de la operación.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { oneOf, pathId, reqId, reqText } from '../structure/input.ts';
import { requireOperationId } from './service.ts';

type Body = Record<string, unknown>;

export interface Dependency {
  kind: 'reimbursement' | 'closed_period' | 'joint_controllers' | 'cash_in_use';
  id: string;
  label: string;
  amountMinor: number | null;
  /** Qué ofrece la interfaz: anular el reembolso, reabrir el periodo, proponer/confirmar la anulación coordinada… */
  action: 'reverse_reimbursement' | 'reopen_period' | 'propose_joint_reversal' | 'confirm_joint_reversal' | 'view_joint_reversal' | 'ask_controller' | 'none';
  [k: string]: unknown;
}

/** Id de operación derivado y estable para los pasos de una anulación en cadena (un reintento repite los mismos). */
export function derivedOperationId(operationId: string, label: string): string {
  const h = createHash('md5').update(`${operationId}:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ============================================================
// Dependencias
// ============================================================

/** Periodos cerrados que hoy impiden asentar en esas rutas (la anulación se asienta hoy): reapertura explícita. */
export async function closedPeriodDependencies(client: pg.PoolClient, ctx: ActiveContext, routeIds: readonly string[]): Promise<Dependency[]> {
  if (!routeIds.length) return [];
  const r = await client.query<{ id: string; route_id: string; name: string; week_start: string; week_end: string }>(
    `select w.id, w.route_id, ro.name, w.week_start::text, w.week_end::text
       from adex.weekly_settlements w join adex.routes ro on ro.company_id = w.company_id and ro.id = w.route_id
      where w.company_id = $1 and w.route_id = any($2) and coalesce(w.status, 'cerrada') = 'cerrada' and w.superseded_by is null
        and adex.business_today(w.company_id) between w.week_start and w.week_end
      order by ro.name, w.id`, [ctx.companyId, [...routeIds]]);
  if (!r.rows.length) return [];
  const mine = new Set((await routeControllers(client, r.rows.map((x) => x.route_id))).filter((x) => x.isActor).map((x) => x.routeId));
  return r.rows.map((x) => ({
    kind: 'closed_period', id: x.id, label: `Periodo del ${x.week_start} al ${x.week_end} cerrado en ${x.name}`, amountMinor: null,
    action: mine.has(x.route_id) ? 'reopen_period' : 'ask_controller', routeId: x.route_id, routeName: x.name, weekStart: x.week_start, weekEnd: x.week_end,
  }));
}

/** Rechaza con la reapertura como camino si hoy alguna de esas rutas tiene el periodo cerrado. */
export async function requireOpenPeriods(client: pg.PoolClient, ctx: ActiveContext, routeIds: readonly string[]): Promise<void> {
  const deps = await closedPeriodDependencies(client, ctx, routeIds);
  if (deps.length) {
    throw new ApiError(409, 'PERIOD_CLOSED', 'the period of a route of this operation is closed: reopen it first (with a reason)', { dependencies: deps });
  }
}

export interface JointTarget { kind: 'expense' | 'reimbursement' | 'route_transfer'; id: string; amountMinor: number; label: string }

/** Rutas de una operación y su responsable vigente (solo nombres; función de 0036). */
export async function routeControllers(client: pg.PoolClient, routeIds: readonly string[]) {
  if (!routeIds.length) return [];
  const r = await client.query<{ route_id: string; name: string; controller_id: string | null; controller_name: string | null; is_actor: boolean }>(
    'select * from adex.joint_operation_controllers($1)', [[...routeIds]]);
  return r.rows.map((x) => ({ routeId: x.route_id, name: x.name, controllerId: x.controller_id, controllerName: x.controller_name, isActor: x.is_actor }));
}

/** ¿Está aplicada 0037 (anulación coordinada, obligaciones por gasto)? Una API sobre un esquema anterior responde como antes. */
export async function controllerAuthorityApplied(client: pg.PoolClient): Promise<boolean> {
  return (await client.query<{ ok: boolean }>("select to_regprocedure('adex.joint_reversal_confirm(uuid,text)') is not null ok")).rows[0]!.ok;
}

/** Propuesta coordinada pendiente para un objetivo (si el actor la ve). */
async function pendingProposal(client: pg.PoolClient, ctx: ActiveContext, target: JointTarget) {
  if (!(await controllerAuthorityApplied(client))) return null;
  const r = await client.query<{ id: string }>(
    `select id from adex.joint_reversal_proposals where company_id = $1 and target_kind = $2 and target_id = $3 and status = 'pending'`,
    [ctx.companyId, target.kind, target.id]);
  if (!r.rows[0]) return null;
  return (await client.query<{ v: Body }>('select adex.joint_reversal_get($1) v', [r.rows[0].id])).rows[0]!.v;
}

/**
 * El actor debe ser el responsable VIGENTE de TODAS las rutas de la operación. Si no:
 *   · no controla ninguna → 403 CAPITAL_AUTHORITY_REQUIRED (con la lista);
 *   · controla algunas y hay otros responsables → 409 JOINT_OPERATION_MIXED_CONTROLLERS con la dependencia
 *     `joint_controllers` (proponer o confirmar la anulación coordinada).
 */
export async function requireControlsAllRoutesOr(client: pg.PoolClient, ctx: ActiveContext, routeIds: readonly string[], target: JointTarget): Promise<void> {
  if (!routeIds.length) return;
  const routes = await routeControllers(client, routeIds);
  if (routes.every((x) => x.isActor)) return;
  if (!routes.some((x) => x.isActor)) {
    throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only the current capital controller of the routes corrects this operation', { routes });
  }
  const proposal = await pendingProposal(client, ctx, target);
  const dep: Dependency = {
    kind: 'joint_controllers', id: target.id, targetKind: target.kind, label: target.label, amountMinor: target.amountMinor,
    action: !proposal ? 'propose_joint_reversal' : proposal['canConfirm'] ? 'confirm_joint_reversal' : 'view_joint_reversal',
    proposalId: proposal?.['id'] ?? null, routes,
  };
  throw new ApiError(409, 'JOINT_OPERATION_MIXED_CONTROLLERS',
    'the operation spans routes of different administrators: each one confirms their part of a joint reversal', { routes, dependencies: [dep] });
}

/** Reembolsos que impiden anular un gasto con dinero propio (0037, `adex.expense_reversal_dependencies`). */
export async function expenseDependencies(client: pg.PoolClient, expenseId: string): Promise<Dependency[]> {
  if (!(await controllerAuthorityApplied(client))) return [];
  return (await client.query<{ d: Dependency[] }>('select adex.expense_reversal_dependencies($1) d', [expenseId])).rows[0]!.d;
}

// ============================================================
// Vista previa de una corrección
// ============================================================

interface Leg { kind: string; routeId: string | null; membershipId: string | null; amountMinor: number }

const ACCOUNT_LABEL: Record<string, string> = {
  route_base: 'Base de la ruta', custody: 'Efectivo del trabajador', portfolio: 'Cartera', income: 'Intereses cobrados', expense: 'Gastos',
  admin_payable: 'Saldo a favor del Administrador (no es efectivo)', route_funding: 'Aportes y retiros externos de la ruta', admin: 'Bolsa del Administrador',
  company: 'Cuenta de la empresa', external: 'Fuera de ADEX', suspense: 'Sobrante en control', unidentified: 'Origen sin identificar',
  route_difference: 'Faltante/sobrante conciliado',
};

async function legsOf(client: pg.PoolClient, ctx: ActiveContext, opIds: readonly string[]): Promise<Leg[]> {
  if (!opIds.length) return [];
  const r = await client.query<{ kind: string; route_id: string | null; membership_id: string | null; amount_minor: string }>(
    `select a.kind, a.route_id, a.membership_id, e.amount_minor from adex.capital_entries e
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = any($2) order by e.operation_id, e.leg`, [ctx.companyId, [...opIds]]);
  return r.rows.map((x) => ({ kind: x.kind, routeId: x.route_id, membershipId: x.membership_id, amountMinor: Number(x.amount_minor) }));
}

/** Efecto de anular: las patas visibles de las operaciones originales, con el signo invertido y agrupadas por cuenta. */
async function effectsOf(client: pg.PoolClient, ctx: ActiveContext, opIds: readonly string[]) {
  const legs = await legsOf(client, ctx, opIds);
  const grouped = new Map<string, Leg>();
  for (const l of legs) {
    const k = `${l.kind}|${l.routeId ?? ''}|${l.membershipId ?? ''}`;
    const g = grouped.get(k) ?? { ...l, amountMinor: 0 };
    g.amountMinor -= l.amountMinor;
    grouped.set(k, g);
  }
  const routeIds = [...new Set([...grouped.values()].map((g) => g.routeId).filter((x): x is string => !!x))];
  const memberIds = [...new Set([...grouped.values()].map((g) => g.membershipId).filter((x): x is string => !!x))];
  const routes = new Map((await client.query<{ id: string; name: string }>('select id, name from adex.routes where company_id = $1 and id = any($2)',
    [ctx.companyId, routeIds])).rows.map((x) => [x.id, x.name] as const));
  const members = new Map((await client.query<{ id: string; display_name: string }>('select id, display_name from adex.memberships where company_id = $1 and id = any($2)',
    [ctx.companyId, memberIds])).rows.map((x) => [x.id, x.display_name] as const));
  return [...grouped.values()].filter((g) => g.amountMinor !== 0).map((g) => ({
    account: { kind: g.kind, routeId: g.routeId, membershipId: g.membershipId },
    label: ACCOUNT_LABEL[g.kind] ?? g.kind, routeName: g.routeId ? routes.get(g.routeId) ?? null : null,
    personName: g.membershipId ? members.get(g.membershipId) ?? null : null,
    isCash: ['route_base', 'custody', 'admin', 'company'].includes(g.kind), deltaMinor: g.amountMinor,
  }));
}

type Mode = 'direct' | 'cascade' | 'joint' | 'blocked';

/**
 * `GET /v1/corrections/preview?kind=expense|reimbursement|operation&id=…`. No escribe nada: dice qué cambiaría
 * (efecto en cuentas visibles), el camino (directa, en cadena, coordinada o bloqueada) y las dependencias.
 * La decisión final es siempre de PostgreSQL al confirmar.
 */
export async function previewCorrection(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const kind = q.get('kind');
  const id = q.get('id');
  if (!kind || !['expense', 'reimbursement', 'operation'].includes(kind)) throw new ApiError(400, 'INVALID_INPUT', 'kind must be expense, reimbursement or operation', { field: 'kind' });
  if (!id) throw new ApiError(400, 'INVALID_INPUT', 'id is required', { field: 'id' });
  pathId(id);
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  let opIds: string[] = [];
  let routeIds: string[] = [];
  let amount = 0;
  let label = '';
  let target: JointTarget | null = null;
  let deps: Dependency[] = [];
  let cascadeOps: string[] = [];
  let blocked: string | null = null;
  if (kind === 'expense') {
    const e = (await client.query<{ id: string; route_id: string | null; funding: string | null; amount_minor: string; reversal_id: string | null; reverses_id: string | null;
      refunds_expense_id: string | null; ledger_operation_id: string | null; description: string | null; scope: string | null; collector_membership_id: string | null;
      responsible_admin_membership_id: string | null }>('select * from adex.expenses where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
    if (!e) throw new ApiError(404, 'NOT_FOUND');
    amount = Number(e.amount_minor);
    label = `Gasto ${e.description ? `«${e.description}»` : ''}`.trim();
    if (e.reversal_id) blocked = 'ALREADY_REVERSED';
    else if (e.reverses_id || e.refunds_expense_id || !e.ledger_operation_id) blocked = 'REVERSAL_NOT_ALLOWED';
    if (e.funding === 'routes') {
      opIds = (await client.query<{ id: string }>('select id from adex.capital_operations where company_id = $1 and expense_id = $2 and kind = $3',
        [ctx.companyId, e.id, 'GENERAL_EXPENSE_CONTRIBUTION'])).rows.map((x) => x.id);
      routeIds = (await client.query<{ r: string[] }>('select adex.general_funding_routes($1, null) r', [e.id])).rows[0]!.r;
      target = { kind: 'expense', id: e.id, amountMinor: amount, label };
    } else {
      opIds = e.ledger_operation_id ? [e.ledger_operation_id] : [];
      if (e.route_id) routeIds = [e.route_id];
      if (e.funding === 'own_money' && !blocked) {
        deps = await expenseDependencies(client, e.id);
        if (deps.length) {
          cascadeOps = (await client.query<{ id: string }>(
            'select operation_id id from adex.general_funding_contributions where company_id = $1 and reimbursement_id = any($2)',
            [ctx.companyId, deps.map((d) => d.id)])).rows.map((x) => x.id);
        }
      }
      if (e.collector_membership_id && !blocked) {
        const own = (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, e.collector_membership_id])).rows[0]!.s;
        if (own) blocked = 'SELF_CORRECTION_FORBIDDEN';
      }
    }
  } else if (kind === 'reimbursement') {
    const r = (await client.query<{ id: string; amount_minor: string; source: string; reversed_at: Date | null; payer_membership_id: string }>(
      'select * from adex.admin_reimbursements where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
    if (!r) throw new ApiError(404, 'NOT_FOUND');
    amount = Number(r.amount_minor);
    label = 'Reembolso a un Administrador';
    if (r.reversed_at) blocked = 'ALREADY_REVERSED';
    opIds = (await client.query<{ id: string }>('select operation_id id from adex.general_funding_contributions where company_id = $1 and reimbursement_id = $2',
      [ctx.companyId, r.id])).rows.map((x) => x.id);
    if (r.source === 'routes') {
      routeIds = (await client.query<{ r: string[] }>('select adex.general_funding_routes(null, $1) r', [r.id])).rows[0]!.r;
      target = { kind: 'reimbursement', id: r.id, amountMinor: amount, label };
    } else if (r.payer_membership_id !== ctx.membershipId && !blocked) blocked = 'CAPITAL_AUTHORITY_REQUIRED';
  } else {
    const o = (await client.query<{ id: string; kind: string; amount_minor: string; route_id: string | null; to_route_id: string | null; reason: string }>(
      'select * from adex.capital_operations where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
    if (!o) throw new ApiError(404, 'NOT_FOUND');
    amount = Number(o.amount_minor);
    label = o.reason;
    opIds = [o.id];
    routeIds = [o.route_id, o.to_route_id].filter((x): x is string => !!x);
    if ((await client.query('select 1 from adex.capital_operations where company_id = $1 and reverses_operation_id = $2', [ctx.companyId, o.id])).rowCount) blocked = 'ALREADY_REVERSED';
    if (['REVERSAL', 'LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT', 'PRINCIPAL_RECLASSIFICATION', 'PARTNER_CONTRIBUTION', 'COMPANY_WITHDRAWAL', 'LEGACY_POOL_TO_ROUTE',
      'DIFFERENCE_CONCILIATION'].includes(o.kind) || o.kind.startsWith('ADMIN_TRANSFER_')) blocked = blocked ?? 'REVERSAL_NOT_ALLOWED';
    if (o.kind === 'ROUTE_TRANSFER') target = { kind: 'route_transfer', id: o.id, amountMinor: amount, label: `Transferencia entre rutas: ${o.reason}` };
  }
  const routes = await routeControllers(client, routeIds);
  const mixed = routes.length > 0 && !routes.every((x) => x.isActor) && routes.some((x) => x.isActor);
  if (!blocked && routes.length > 0 && !routes.some((x) => x.isActor) && kind !== 'reimbursement') blocked = 'CAPITAL_AUTHORITY_REQUIRED';
  if (!blocked && routes.length > 0 && !routes.some((x) => x.isActor) && kind === 'reimbursement' && target) blocked = 'CAPITAL_AUTHORITY_REQUIRED';
  let joint: Body | null = null;
  if (!blocked && mixed && target) {
    joint = await pendingProposal(client, ctx, target);
    deps.push({ kind: 'joint_controllers', id: target.id, targetKind: target.kind, label: target.label, amountMinor: amount,
      action: !joint ? 'propose_joint_reversal' : joint['canConfirm'] ? 'confirm_joint_reversal' : 'view_joint_reversal', proposalId: joint?.['id'] ?? null, routes });
  } else if (!blocked && mixed) blocked = 'CAPITAL_AUTHORITY_REQUIRED';
  if (!blocked) deps.push(...await closedPeriodDependencies(client, ctx, routeIds));
  if (ctx.role === 'superadmin') blocked = blocked ?? 'CAPITAL_AUTHORITY_REQUIRED';
  const cascadeBlocked = deps.some((d) => d.kind === 'reimbursement' && !d['reversibleByActor']);
  const mode: Mode = blocked ? 'blocked'
    : deps.some((d) => d.kind === 'joint_controllers') ? 'joint'
      : deps.some((d) => d.kind === 'closed_period') ? 'blocked'
        : deps.some((d) => d.kind === 'reimbursement') ? (cascadeBlocked ? 'blocked' : 'cascade') : 'direct';
  return {
    kind, id, label, amountMinor: amount, mode, blockedBy: blocked, dependencies: deps, routes,
    effects: await effectsOf(client, ctx, [...opIds, ...(mode === 'cascade' ? cascadeOps : [])]),
    jointProposal: joint, reasonMinLength: 3,
  };
}

// ============================================================
// Anulación coordinada (0037)
// ============================================================

export const JOINT_PROPOSE_FIELDS = ['targetKind', 'targetId', 'reason'] as const;

export async function listJointReversals(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  const status = q.get('status') ?? 'pending';
  if (!['pending', 'all'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'status must be pending or all', { field: 'status' });
  const list = (await client.query<{ v: Body[] }>('select adex.joint_reversal_list($1) v', [status])).rows[0]!.v;
  return { proposals: list, toConfirm: list.filter((p) => p['canConfirm']).length };
}

export async function getJointReversal(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  if (ctx.role !== 'admin' && ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  return { proposal: (await client.query<{ v: Body }>('select adex.joint_reversal_get($1) v', [id])).rows[0]!.v };
}

function requireJointActor(ctx: ActiveContext) {
  if (ctx.role !== 'admin') throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only a route capital controller acts on joint reversals');
}

const TARGET_TEXT: Record<string, string> = { expense: 'gasto general', reimbursement: 'reembolso', route_transfer: 'transferencia entre rutas' };

export async function proposeJointReversal(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const opId = requireOperationId(operationId);
  requireJointActor(ctx);
  const targetKind = oneOf(body, 'targetKind', ['expense', 'reimbursement', 'route_transfer'] as const);
  const targetId = reqId(body, 'targetId');
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const p = (await client.query<{ v: Body }>('select adex.joint_reversal_propose($1, $2, $3, $4) v', [opId, targetKind, targetId, reason])).rows[0]!.v;
  await audit(client, ctx, {
    action: 'JOINT_REVERSAL_PROPOSED', entityType: 'joint_reversal', entityId: String(p['id']), routeId: null, reason,
    description: `Anulación coordinada propuesta: ${TARGET_TEXT[targetKind]} de ${String(p['amountMinor'])}. Faltan ${String(p['pendingParts'])} confirmación(es).`,
    after: { targetKind, targetId, parts: p['parts'] }, metadata: { operationId: opId },
  });
  return { proposal: p };
}

export async function confirmJointReversal(client: pg.PoolClient, ctx: ActiveContext, id: string, operationId: string | null) {
  const opId = requireOperationId(operationId);
  pathId(id);
  requireJointActor(ctx);
  const p = (await client.query<{ v: Body }>('select adex.joint_reversal_confirm($1, $2) v', [opId, id])).rows[0]!.v;
  const posted = p['status'] === 'posted';
  await audit(client, ctx, {
    action: posted ? 'JOINT_REVERSAL_POSTED' : 'JOINT_REVERSAL_CONFIRMED', entityType: 'joint_reversal', entityId: id, routeId: null,
    reason: String(p['reason'] ?? ''),
    description: posted
      ? `Anulación coordinada ASENTADA (${TARGET_TEXT[String(p['targetKind'])] ?? ''} de ${String(p['amountMinor'])}): confirmada por todos los responsables.`
      : p['status'] === 'obsolete' ? 'Anulación coordinada caducada: la operación ya estaba anulada.'
        : `Parte confirmada de una anulación coordinada. Faltan ${String(p['pendingParts'])} confirmación(es).`,
    after: { status: p['status'], parts: p['parts'], posting: p['posting'] ?? null }, metadata: { operationId: opId },
  });
  return { proposal: p };
}

export async function cancelJointReversal(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Body, operationId: string | null) {
  const opId = requireOperationId(operationId);
  pathId(id);
  requireJointActor(ctx);
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const p = (await client.query<{ v: Body }>('select adex.joint_reversal_cancel($1, $2, $3) v', [opId, id, reason])).rows[0]!.v;
  await audit(client, ctx, {
    action: 'JOINT_REVERSAL_CANCELLED', entityType: 'joint_reversal', entityId: id, routeId: null, reason,
    description: `Anulación coordinada cancelada: ${reason}`, after: { status: p['status'] }, metadata: { operationId: opId },
  });
  return { proposal: p };
}

/** Propuestas que esperan la confirmación del contexto (bandeja y contador). */
export async function jointToConfirm(client: pg.PoolClient, ctx: ActiveContext): Promise<Body[]> {
  if (ctx.role !== 'admin' || !(await controllerAuthorityApplied(client))) return [];
  const list = (await client.query<{ v: Body[] }>("select adex.joint_reversal_list('pending') v")).rows[0]!.v;
  return list.filter((p) => p['canConfirm']);
}
