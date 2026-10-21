// SOLICITUDES DE CAPITAL (Ronda 59). Regla del propietario: quien tiene el dinero lo entrega sin
// pedir autorización; quien lo necesita, lo SOLICITA. Una solicitud no mueve dinero: la atiende
// quien tiene el capital con el comando ordinario (asignación, devolución, traspaso directo o
// entrega del Cobrador) y el id de la solicitud, en la MISMA transacción:
//
//   claimRequest (bloquea la fila, pendiente, es su titular) → comando → fulfillRequest
//
// Si el comando falla, la solicitud sigue pendiente; si dos personas o dos toques la atienden a la
// vez, la segunda espera el bloqueo, la encuentra atendida y su transacción entera se deshace.
// Contrato en la migración 0025 (segunda barrera: `adex.capital_request_*`, SECURITY DEFINER).

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { oneOf, optId, optText, pathId, reqText } from '../structure/input.ts';
import { requireOperationId } from './service.ts';

export const REQUEST_FIELDS = ['kind', 'holderId', 'routeId', 'concept', 'amountMinor', 'note'] as const;

export type RequestKind = 'admin_return' | 'admin_allocation' | 'admin_transfer' | 'worker_return';
const KINDS: readonly RequestKind[] = ['admin_return', 'admin_allocation', 'admin_transfer', 'worker_return'];
const STATES: readonly string[] = ['pending', 'fulfilled', 'rejected', 'cancelled'];

export interface RequestRow {
  id: string; operation_id: string; kind: RequestKind; requester_membership_id: string; requester_role: 'superadmin' | 'admin';
  holder_membership_id: string | null; holder_role: 'superadmin' | 'admin' | 'cobrador'; route_id: string | null;
  concept: 'recaudo' | 'base' | null; amount_minor: string; currency_code: string; note: string | null;
  state: 'pending' | 'fulfilled' | 'rejected' | 'cancelled'; resolved_at: Date | null; resolved_by_membership_id: string | null;
  resolution_reason: string | null; fulfilled_operation_id: string | null; fulfilled_transfer_id: string | null; created_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** ¿Le toca atenderla (o rechazarla) a quien consulta? */
export function holds(r: RequestRow, ctx: ActiveContext): boolean {
  return r.holder_membership_id === ctx.membershipId || (r.holder_membership_id === null && ctx.role === 'superadmin');
}

export function requestView(r: RequestRow, ctx: ActiveContext, names: Map<string, string>) {
  const pending = r.state === 'pending';
  const mine = holds(r, ctx);
  return {
    id: r.id, kind: r.kind, state: r.state, amountMinor: Number(r.amount_minor), currencyCode: r.currency_code, note: r.note,
    concept: r.concept, routeId: r.route_id, createdAt: r.created_at.toISOString(),
    requester: { membershipId: r.requester_membership_id, role: r.requester_role, name: names.get(r.requester_membership_id) ?? null },
    holder: { membershipId: r.holder_membership_id, role: r.holder_role, name: r.holder_membership_id ? names.get(r.holder_membership_id) ?? null : null },
    resolvedAt: iso(r.resolved_at), resolvedBy: r.resolved_by_membership_id ? { membershipId: r.resolved_by_membership_id, name: names.get(r.resolved_by_membership_id) ?? null } : null,
    resolutionReason: r.resolution_reason, fulfilledOperationId: r.fulfilled_operation_id, fulfilledTransferId: r.fulfilled_transfer_id,
    mySide: r.requester_membership_id === ctx.membershipId ? 'requester' : mine ? 'holder' : null,
    canAttend: pending && mine, canReject: pending && mine, canCancel: pending && r.requester_membership_id === ctx.membershipId,
  };
}

export async function memberNames(client: pg.PoolClient, ctx: ActiveContext, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const list = [...new Set([...ids].filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const r = await client.query<{ id: string; display_name: string }>('select id, display_name from adex.memberships where company_id = $1 and id = any($2)', [ctx.companyId, list]);
  return new Map(r.rows.map((x) => [x.id, x.display_name]));
}

const namesFor = (client: pg.PoolClient, ctx: ActiveContext, rows: RequestRow[]) =>
  memberNames(client, ctx, rows.flatMap((r) => [r.requester_membership_id, r.holder_membership_id, r.resolved_by_membership_id]));

async function respond(client: pg.PoolClient, ctx: ActiveContext, row: RequestRow) {
  return { request: requestView(row, ctx, await namesFor(client, ctx, [row])) };
}

const KIND_TEXT: Record<RequestKind, string> = {
  admin_return: 'devolución de capital al SuperAdmin', admin_allocation: 'capital adicional al SuperAdmin',
  admin_transfer: 'capital a otro Administrador', worker_return: 'entrega de efectivo del Cobrador',
};

async function auditRequest(client: pg.PoolClient, ctx: ActiveContext, row: RequestRow, action: string, description: string, reason: string | null) {
  await audit(client, ctx, {
    action, entityType: 'capital_request', entityId: row.id, routeId: row.route_id, description, reason,
    after: { kind: row.kind, state: row.state, amountMinor: Number(row.amount_minor), requesterId: row.requester_membership_id,
      holderId: row.holder_membership_id, routeId: row.route_id, concept: row.concept,
      fulfilledOperationId: row.fulfilled_operation_id, fulfilledTransferId: row.fulfilled_transfer_id },
    metadata: { operationId: row.operation_id },
  });
}

// ============================================================
// Comandos
// ============================================================

/** Crear una solicitud. No mueve dinero. Roles: SuperAdmin pide devolución; Administrador, el resto. */
export async function createRequest(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  if (ctx.role !== 'superadmin' && ctx.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED');
  const op = requireOperationId(operationId);
  const kind = oneOf(body, 'kind', KINDS);
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  }
  const concept = body['concept'] === undefined || body['concept'] === null ? null : oneOf(body, 'concept', ['recaudo', 'base'] as const);
  const r = await client.query<RequestRow>('select * from adex.capital_request_create($1, $2, $3, $4, $5, $6, $7)',
    [op, kind, optId(body, 'holderId'), optId(body, 'routeId'), concept, v, optText(body, 'note', 300)]);
  const row = r.rows[0]!;
  await auditRequest(client, ctx, row, 'CAPITAL_REQUEST_CREATED', `Solicitud de ${KIND_TEXT[kind]} por ${v} (no mueve dinero).`, row.note);
  return respond(client, ctx, row);
}

/** Rechazar (quien tiene el capital) o cancelar (quien la pidió), con motivo. No mueve dinero. */
export async function closeRequest(client: pg.PoolClient, ctx: ActiveContext, id: string, action: 'reject' | 'cancel',
  body: Record<string, unknown>, operationId: string | null) {
  pathId(id);
  requireOperationId(operationId);
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = await client.query<RequestRow>('select * from adex.capital_request_close($1, $2, $3)', [id, action, reason]);
  const row = r.rows[0]!;
  await auditRequest(client, ctx, row, action === 'reject' ? 'CAPITAL_REQUEST_REJECTED' : 'CAPITAL_REQUEST_CANCELLED',
    `Solicitud de ${KIND_TEXT[row.kind]} ${action === 'reject' ? 'rechazada' : 'cancelada'}; no se movió dinero.`, reason);
  return respond(client, ctx, row);
}

/**
 * Antes del comando que la atiende: bloquea la solicitud y comprueba que sigue pendiente, que es
 * de quien la atiende y que se atiende con ESTE comando. Un error aquí no deja nada escrito.
 */
export async function claimRequest(client: pg.PoolClient, ctx: ActiveContext, requestId: string, kind: RequestKind): Promise<RequestRow> {
  pathId(requestId);
  const r = await client.query<RequestRow>('select * from adex.capital_request_lock($1)', [requestId]);
  const row = r.rows[0]!;
  if (row.kind !== kind) throw new ApiError(409, 'REQUEST_MISMATCH', 'this command does not attend this request');
  return row;
}

/** Después del comando, en la misma transacción: enlaza la operación (o el traspaso) y la da por atendida. */
export async function fulfillRequest(client: pg.PoolClient, ctx: ActiveContext, requestId: string, link: { operation?: string; transfer?: string }) {
  const r = await client.query<RequestRow>('select * from adex.capital_request_fulfill($1, $2, $3)', [requestId, link.operation ?? null, link.transfer ?? null]);
  const row = r.rows[0]!;
  await auditRequest(client, ctx, row, 'CAPITAL_REQUEST_FULFILLED', `Solicitud de ${KIND_TEXT[row.kind]} atendida con el movimiento registrado.`, null);
  return requestView(row, ctx, await namesFor(client, ctx, [row]));
}

// ============================================================
// Consultas (RLS: quien pide, quien tiene el capital; el SuperAdmin, todas)
// ============================================================

export async function listRequests(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const state = q.get('state');
  if (state !== null && !STATES.includes(state)) throw new ApiError(400, 'INVALID_INPUT', 'state is invalid', { field: 'state' });
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 500);
  const params: unknown[] = [ctx.companyId, limit];
  const r = await client.query<RequestRow>(
    `select * from adex.capital_requests where company_id = $1 ${state ? `and state = $${params.push(state)}` : ''}
      order by (state = 'pending') desc, created_at desc, id limit $2`, params);
  const names = await namesFor(client, ctx, r.rows);
  return r.rows.map((x) => requestView(x, ctx, names));
}

export async function getRequest(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  const r = await client.query<RequestRow>('select * from adex.capital_requests where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return respond(client, ctx, r.rows[0]);
}
