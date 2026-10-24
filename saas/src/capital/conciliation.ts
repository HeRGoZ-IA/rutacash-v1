// AUTORIDAD DEL ADMINISTRADOR (R74 §15, migración 0036). Regla rectora del propietario: el Administrador es
// el máximo responsable del dinero; si una transacción no tiene definido quién la autoriza, la autoridad es
// del Administrador responsable de capital VÁLIDO de las rutas afectadas (nunca de rutas ajenas ni de otra
// empresa). El SuperAdmin supervisa y estructura; no concilia.
//
//   · RB-D3 · Conciliación de diferencias por el Administrador, sin aprobación superior:
//       diferencias de actas de entrega (`handover`), faltantes de cuadre arrastrados (`settlement_shortage`)
//       y sobrantes de cuadre retenidos en control (`settlement_surplus`). Lista, vista previa, resolución
//       (idempotente con X-Adex-Operation-Id) e historial. Los efectos son operaciones NUEVAS balanceadas
//       (`DIFFERENCE_CONCILIATION`) contra la cuenta por ruta «faltante/sobrante conciliado» (`route_difference`),
//       que no es efectivo ni resultado. Tratamiento financiero: cabecera de 0036 y tmp/r74/w1/conciliation-design.md.
//   · RB-D1 · Diagnóstico previo a desactivar a un Administrador (`GET /v1/members/:id/deactivation-check`)
//       y rechazo con la lista de cuentas pendientes (la barrera final es un disparador de PostgreSQL).
//   · RB-D7 · Explicación de una corrección conjunta rechazada: rutas y su responsable vigente.
// Segunda barrera en PostgreSQL (`adex.difference_resolve`, `adex.admin_pending_accounts_internal`, …).

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { oneOf, pathId, reqText } from '../structure/input.ts';
import { requireOperationId, routeOf } from './service.ts';
import { entriesOf } from './generalFunding.ts';

type Body = Record<string, unknown>;

export const RESOLVE_FIELDS = ['sourceKind', 'sourceId', 'resolution', 'amountMinor', 'reason'] as const;
const SOURCE_KINDS = ['handover', 'settlement_shortage', 'settlement_surplus'] as const;
const RESOLUTIONS = ['route_shortage', 'worker_owes', 'surplus_to_base', 'surplus_returned'] as const;

/** Rótulos sugeridos para la interfaz (español). */
export const RESOLUTION_LABELS: Record<(typeof RESOLUTIONS)[number], string> = {
  route_shortage: 'Reconocer como faltante de la ruta',
  worker_owes: 'El trabajador repone (queda como faltante pendiente del trabajador)',
  surplus_to_base: 'Incorporar el sobrante a la Base de la ruta',
  surplus_returned: 'Devolver el sobrante a su dueño (sale del control, no es ingreso)',
};
const SOURCE_LABELS: Record<(typeof SOURCE_KINDS)[number], string> = {
  handover: 'Acta de entrega', settlement_shortage: 'Faltante de cuadre', settlement_surplus: 'Sobrante de cuadre',
};

function requireViewer(ctx: ActiveContext): void {
  if (!['superadmin', 'admin', 'supervisor'].includes(ctx.role)) throw new ApiError(403, 'PERMISSION_DENIED');
}

function withLabels(item: Body): Body {
  const allowed = (item['allowedResolutions'] as string[] | undefined) ?? [];
  return { ...item, sourceLabel: SOURCE_LABELS[item['sourceKind'] as keyof typeof SOURCE_LABELS] ?? null,
    resolutions: allowed.map((r) => ({ code: r, label: RESOLUTION_LABELS[r as keyof typeof RESOLUTION_LABELS] ?? r })) };
}

/** Diferencias de una ruta (o de todas las del alcance): pendientes y faltantes decididos como del trabajador. */
export async function listDifferences(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  requireViewer(ctx);
  const routeId = q.get('routeId');
  if (routeId !== null) await routeOf(client, ctx, pathId(routeId));
  const status = q.get('status') ?? 'pending';
  if (!['pending', 'all'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'status is invalid', { field: 'status' });
  const items = ((await client.query<{ r: Body[] }>('select adex.route_differences($1) r', [routeId])).rows[0]!.r ?? [])
    .filter((i) => status === 'all' || i['pending'] === true).map(withLabels);
  const sum = (k: string, kind?: string) => items.filter((i) => i['pending'] === true && (!kind || i['kind'] === kind)).reduce((t, i) => t + Number(i[k] ?? 0), 0);
  return {
    items,
    summary: { pendingCount: items.filter((i) => i['pending'] === true).length, pendingShortageMinor: sum('pendingMinor', 'faltante'),
      pendingSurplusMinor: sum('pendingMinor', 'sobrante'), workerOwedMinor: items.reduce((t, i) => t + Number(i['workerOwedMinor'] ?? 0), 0), isCash: false },
  };
}

function sourceOf(q: URLSearchParams | Body, k: 'sourceKind' | 'sourceId' | 'resolution') {
  const v = q instanceof URLSearchParams ? q.get(k) : q[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Vista previa: cifras, importe(s) admitidos, patas que se escribirían y lo que impediría resolver. No escribe. */
export async function previewDifference(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  requireViewer(ctx);
  const kind = sourceOf(q, 'sourceKind');
  const id = sourceOf(q, 'sourceId');
  const resolution = sourceOf(q, 'resolution');
  if (!kind || !(SOURCE_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, 'INVALID_INPUT', 'sourceKind is invalid', { field: 'sourceKind' });
  if (!id) throw new ApiError(400, 'INVALID_INPUT', 'sourceId is required', { field: 'sourceId' });
  pathId(id);
  if (resolution !== null && !(RESOLUTIONS as readonly string[]).includes(resolution)) throw new ApiError(400, 'INVALID_INPUT', 'resolution is invalid', { field: 'resolution' });
  const r = (await client.query<{ r: Body }>('select adex.difference_preview($1, $2, $3) r', [kind, id, resolution])).rows[0]!.r;
  return { ...withLabels(r), resolutionLabel: resolution ? RESOLUTION_LABELS[resolution as keyof typeof RESOLUTION_LABELS] : null };
}

/** Resolución expresa del Administrador responsable de la ruta (RB-D3). */
export async function resolveDifference(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const opId = requireOperationId(operationId);
  if (ctx.role !== 'admin') throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only the responsible administrator conciliates differences');
  const kind = oneOf(body, 'sourceKind', SOURCE_KINDS);
  const id = sourceOf(body, 'sourceId');
  if (!id) throw new ApiError(400, 'INVALID_INPUT', 'sourceId is required', { field: 'sourceId' });
  pathId(id);
  const resolution = oneOf(body, 'resolution', RESOLUTIONS);
  const amount = body['amountMinor'];
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  }
  const reason = reqText(body, 'reason', 500);
  if (reason.length < 10) throw new ApiError(400, 'REASON_REQUIRED', 'a conciliation needs a reason (10+ characters)', { field: 'reason' });
  const r = (await client.query<{ r: Body }>('select adex.difference_resolve($1, $2, $3, $4, $5, $6) r',
    [opId, kind, id, resolution, amount, reason])).rows[0]!.r;
  const route = await routeOf(client, ctx, String(r['routeId']));
  await audit(client, ctx, {
    action: 'DIFFERENCE_CONCILIATED', entityType: 'difference_conciliation', entityId: String(r['conciliationId']), routeId: route.id, reason,
    description: `${SOURCE_LABELS[kind]} en ${route.name}: ${RESOLUTION_LABELS[resolution]} (${amount}). Esperado ${String(r['expectedMinor'])}, `
      + `contado ${String(r['countedMinor'])}, diferencia ${String(r['differenceMinor'])}.`,
    before: { estado: 'pendiente', differenceMinor: r['differenceMinor'] },
    after: { estado: 'conciliada', resolution, amountMinor: amount, carriedAfterMinor: r['carriedAfterMinor'], workerOwedAfterMinor: r['workerOwedAfterMinor'] },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], sourceKind: kind, sourceId: id },
  });
  return {
    conciliation: await loadConciliation(client, ctx, String(r['conciliationId'])),
    entries: r['operationId'] ? await entriesOf(client, ctx, [String(r['operationId'])]) : [],
  };
}

interface ConciliationRow {
  id: string; operation_id: string; route_id: string; source_kind: string; handover_id: string | null; settlement_id: string | null;
  worker_membership_id: string | null; holder_membership_id: string | null; expected_minor: string; counted_minor: string; difference_minor: string;
  amount_minor: string; resolution: string; carried_after_minor: string | null; reason: string; ledger_operation_id: string | null; capital_model: string;
  entry_date: string | Date; actor_membership_id: string; created_at: Date; route_name?: string; actor_name?: string; worker_name?: string | null;
}
const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
const n = (v: string | null) => (v === null ? null : Number(v));
function conciliationView(c: ConciliationRow) {
  return {
    id: c.id, operationId: c.operation_id, routeId: c.route_id, routeName: c.route_name ?? null, sourceKind: c.source_kind,
    sourceLabel: SOURCE_LABELS[c.source_kind as keyof typeof SOURCE_LABELS] ?? c.source_kind, sourceId: c.handover_id ?? c.settlement_id,
    workerId: c.worker_membership_id, workerName: c.worker_name ?? null, holderId: c.holder_membership_id,
    expectedMinor: Number(c.expected_minor), countedMinor: Number(c.counted_minor), differenceMinor: Number(c.difference_minor),
    amountMinor: Number(c.amount_minor), resolution: c.resolution, resolutionLabel: RESOLUTION_LABELS[c.resolution as keyof typeof RESOLUTION_LABELS] ?? c.resolution,
    carriedAfterMinor: n(c.carried_after_minor), reason: c.reason, ledgerOperationId: c.ledger_operation_id, movesMoney: c.ledger_operation_id !== null,
    capitalModel: c.capital_model, entryDate: ymd(c.entry_date), actorId: c.actor_membership_id, actorName: c.actor_name ?? null, createdAt: c.created_at.toISOString(),
  };
}
const SELECT = `select d.*, ro.name route_name, a.display_name actor_name, w.display_name worker_name
                  from adex.difference_conciliations d
                  join adex.routes ro on ro.company_id = d.company_id and ro.id = d.route_id
                  left join adex.memberships a on a.company_id = d.company_id and a.id = d.actor_membership_id
                  left join adex.memberships w on w.company_id = d.company_id and w.id = d.worker_membership_id`;

async function loadConciliation(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const r = (await client.query<ConciliationRow>(`${SELECT} where d.company_id = $1 and d.id = $2`, [ctx.companyId, id])).rows[0];
  if (!r) throw new ApiError(404, 'NOT_FOUND');
  return conciliationView(r);
}

/** Historial de conciliaciones visibles (RLS: SuperAdmin todas; Administrador/Supervisor las de su alcance; las propias). */
export async function listConciliations(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const params: unknown[] = [ctx.companyId];
  let where = 'd.company_id = $1';
  const routeId = q.get('routeId');
  if (routeId !== null) { pathId(routeId); params.push(routeId); where += ` and d.route_id = $${params.length}`; }
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 500);
  params.push(limit);
  const r = await client.query<ConciliationRow>(`${SELECT} where ${where} order by d.created_at desc, d.seq desc limit $${params.length}`, params);
  return r.rows.map(conciliationView);
}

export async function getConciliation(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  return loadConciliation(client, ctx, id);
}

// ============================================================
// RB-D1 · Desactivación de un Administrador
// ============================================================

/** Textos sugeridos (español) para cada cuenta pendiente. */
export const BLOCKER_MESSAGES: Record<string, string> = {
  CAPITAL_CONTROLLER: 'Es responsable de capital de rutas: reasígnalas primero con el cambio de responsable (entrega estructural).',
  ADMIN_POOL_BALANCE: 'Tiene saldo en su bolsa (incluido el saldo «sin asignar»): debe repartirse o devolverse antes.',
  PENDING_REIMBURSEMENT: 'La empresa le debe reembolsos: págalos (o anula los gastos que correspondan) antes de desactivarlo.',
  PENDING_HANDOVER: 'Tiene actas de entrega pendientes: el nuevo responsable debe confirmar el conteo.',
  UNRESOLVED_DIFFERENCES: 'Hay diferencias sin conciliar en sus rutas: concílialas antes.',
  PENDING_ADMIN_TRANSFERS: 'Tiene traspasos entre Administradores pendientes: deben aplicarse, rechazarse o cancelarse.',
  PENDING_CAPITAL_REQUESTS: 'Tiene solicitudes de capital pendientes: deben atenderse, rechazarse o cancelarse.',
  SUSPENSE_BALANCE: 'Tiene sobrantes de cuadre en control a su nombre: concílialos antes.',
  OTHER_MEMBERSHIP_CUSTODY: 'Otra membresía suya tiene efectivo en custodia: debe entregarlo o cuadrarlo antes.',
};

export async function adminPendingAccounts(client: pg.PoolClient, ctx: ActiveContext, membershipId: string) {
  const r = (await client.query<{ r: Body }>('select adex.admin_pending_accounts($1) r', [membershipId])).rows[0]!.r;
  const blockers = ((r['blockers'] as Body[]) ?? []).map((b) => ({ ...b, message: BLOCKER_MESSAGES[String(b['code'])] ?? String(b['code']) }));
  return { ...r, blockers };
}

/** `GET /v1/members/:id/deactivation-check` (SuperAdmin; o el propio Administrador). */
export async function deactivationCheck(client: pg.PoolClient, ctx: ActiveContext, membershipId: string) {
  pathId(membershipId);
  if (ctx.role !== 'superadmin' && ctx.membershipId !== membershipId) throw new ApiError(403, 'PERMISSION_DENIED');
  return adminPendingAccounts(client, ctx, membershipId);
}

/** Antes de escribir: 409 ADMIN_HAS_PENDING_ACCOUNTS con la lista (el disparador AX433 es la barrera final). */
export async function requireNoPendingAccounts(client: pg.PoolClient, ctx: ActiveContext, membershipId: string): Promise<void> {
  const r = await adminPendingAccounts(client, ctx, membershipId);
  if (r.blockers.length > 0) {
    throw new ApiError(409, 'ADMIN_HAS_PENDING_ACCOUNTS', 'the administrator has pending accounts: settle and hand them over first', { blockers: r.blockers });
  }
}

// ============================================================
// RB-D7 · Corrección conjunta: el actor debe controlar TODAS las rutas
// ============================================================

/**
 * Comprobación previa con explicación: rutas y su responsable vigente. 409 JOINT_OPERATION_MIXED_CONTROLLERS si
 * las rutas son de distintos responsables; 403 CAPITAL_AUTHORITY_REQUIRED si todas son de otro. PostgreSQL lo
 * revalida bajo bloqueo (`adex.require_controls_all_routes`).
 */
export async function requireControlsAllRoutes(client: pg.PoolClient, ctx: ActiveContext, routeIds: readonly string[]): Promise<void> {
  if (!routeIds.length) return;
  const r = await client.query<{ route_id: string; name: string; controller_id: string | null; controller_name: string | null; is_actor: boolean }>(
    'select * from adex.joint_operation_controllers($1)', [[...routeIds]]);
  if (r.rows.every((x) => x.is_actor)) return;
  const routes = r.rows.map((x) => ({ routeId: x.route_id, name: x.name, controllerId: x.controller_id, controllerName: x.controller_name, isActor: x.is_actor }));
  const distinct = new Set(r.rows.map((x) => x.controller_id ?? '-')).size;
  if (distinct > 1) {
    throw new ApiError(409, 'JOINT_OPERATION_MIXED_CONTROLLERS',
      'the operation spans routes of different administrators: only someone who controls all of them corrects it', { routes });
  }
  throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only the current capital controller of the routes corrects this operation', { routes });
}
