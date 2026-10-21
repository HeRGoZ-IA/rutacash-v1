// TRASPASOS ENTRE ADMINISTRADORES (Ronda 53, decisión D2; Ronda 59, entrega voluntaria).
// Contratos en docs/ADEX_RONDA_53_TRANSFERENCIAS_SIN_SOCIO.md §2, docs/ADEX_RONDA_59_DINERO.md y
// las migraciones 0023 y 0025.
//
//   Directo     el Administrador que TIENE el capital lo entrega: se aplica al registrarlo (R59);
//               el destino queda avisado y no confirma (`destination.decision = not_required`).
//   Secretario  el Secretario registra un traspaso ya hecho o comunicado → confirman AMBOS
//               Administradores; el capital queda comprometido en tránsito hasta entonces; un
//               rechazo o una cancelación lo devuelven al origen. Nadie decide por otro.
//
// Los directos registrados antes de la Ronda 59 que quedaron pendientes se siguen confirmando o
// rechazando con los mismos comandos.
//
// Dos barreras, como el resto del capital: aquí el rol y la forma de la entrada (errores
// claros); en PostgreSQL (`adex.admin_transfer_*`, SECURITY DEFINER) partes, estados, fondos y
// concurrencia BAJO BLOQUEO. Cada comando lleva su `X-Adex-Operation-Id` (idempotencia P3).

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { optId, pathId, reqId, reqText } from '../structure/input.ts';
import { requireOperationId } from './service.ts';
import { claimRequest, fulfillRequest } from './requests.ts';

export const REGISTER_FIELDS = ['originAdminId', 'destinationAdminId', 'amountMinor', 'reason', 'requestId'] as const;

type State = 'pending' | 'applied' | 'rejected' | 'cancelled';
type Decision = 'pending' | 'confirmed' | 'rejected' | 'not_required';

interface Row {
  id: string; operation_id: string; mode: 'direct' | 'secretary'; origin_admin_membership_id: string; destination_admin_membership_id: string;
  amount_minor: string; currency_code: string; reason: string; entry_date: string | Date; state: State;
  registered_by_membership_id: string; registered_by_role: 'admin' | 'secretario';
  origin_decision: Decision; origin_decided_at: Date | null; origin_decision_reason: string | null;
  destination_decision: Decision; destination_decided_at: Date | null; destination_decision_reason: string | null;
  hold_operation_id: string; settle_operation_id: string | null; closed_at: Date | null; closed_by_membership_id: string | null;
  close_reason: string | null; created_at: Date;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Vista para el actor: lo que le toca hacer (`canConfirm`, `canReject`, `canCancel`) lo calcula el servidor. */
function view(r: Row, ctx: ActiveContext, names: Map<string, string>) {
  const me = ctx.membershipId;
  const mySide = me === r.origin_admin_membership_id ? 'origin' : me === r.destination_admin_membership_id ? 'destination' : null;
  const myDecision = mySide === 'origin' ? r.origin_decision : mySide === 'destination' ? r.destination_decision : null;
  const pending = r.state === 'pending';
  return {
    id: r.id, operationId: r.operation_id, mode: r.mode, state: r.state, amountMinor: Number(r.amount_minor), currencyCode: r.currency_code,
    reason: r.reason, entryDate: ymd(r.entry_date), createdAt: r.created_at.toISOString(),
    origin: { adminId: r.origin_admin_membership_id, name: names.get(r.origin_admin_membership_id) ?? null,
      decision: r.origin_decision, decidedAt: iso(r.origin_decided_at), reason: r.origin_decision_reason },
    destination: { adminId: r.destination_admin_membership_id, name: names.get(r.destination_admin_membership_id) ?? null,
      decision: r.destination_decision, decidedAt: iso(r.destination_decided_at), reason: r.destination_decision_reason },
    registeredBy: { membershipId: r.registered_by_membership_id, role: r.registered_by_role, name: names.get(r.registered_by_membership_id) ?? null },
    holdOperationId: r.hold_operation_id, settleOperationId: r.settle_operation_id, closedAt: iso(r.closed_at),
    closedBy: r.closed_by_membership_id, closeReason: r.close_reason,
    mySide, canConfirm: pending && myDecision === 'pending', canReject: pending && myDecision === 'pending',
    canCancel: pending && r.registered_by_membership_id === me,
  };
}

async function namesOf(client: pg.PoolClient, ctx: ActiveContext, rows: Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => [r.origin_admin_membership_id, r.destination_admin_membership_id, r.registered_by_membership_id]))];
  if (!ids.length) return new Map();
  const r = await client.query<{ id: string; display_name: string }>('select id, display_name from adex.memberships where company_id = $1 and id = any($2)', [ctx.companyId, ids]);
  return new Map(r.rows.map((x) => [x.id, x.display_name]));
}

function requireRole(ctx: ActiveContext, roles: readonly string[]): void {
  if (!roles.includes(ctx.role)) throw new ApiError(403, 'PERMISSION_DENIED');
}

function amountOf(body: Record<string, unknown>): number {
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  }
  return v;
}

function reasonOf(body: Record<string, unknown>, field = 'reason'): string {
  const r = reqText(body, field, 300);
  if (r.length < 3) throw new ApiError(400, 'INVALID_INPUT', `${field} is required`, { field });
  return r;
}

async function respond(client: pg.PoolClient, ctx: ActiveContext, row: Row) {
  return { transfer: view(row, ctx, await namesOf(client, ctx, [row])) };
}

async function auditTransfer(client: pg.PoolClient, ctx: ActiveContext, row: Row, action: string, description: string, reason: string) {
  await audit(client, ctx, {
    action, entityType: 'admin_transfer', entityId: row.id, routeId: null, description, reason,
    after: { state: row.state, mode: row.mode, amountMinor: Number(row.amount_minor), originAdminId: row.origin_admin_membership_id,
      destinationAdminId: row.destination_admin_membership_id, originDecision: row.origin_decision, destinationDecision: row.destination_decision,
      settleOperationId: row.settle_operation_id },
    metadata: { operationId: row.operation_id, holdOperationId: row.hold_operation_id },
  });
}

// ============================================================
// Comandos
// ============================================================

/**
 * Registrar. Administrador: traspaso DIRECTO desde su propia bolsa (no envía origen, o envía el
 * suyo), aplicado en el acto; puede atender una solicitud de capital de otro Administrador
 * (`requestId`). Secretario: origen y destino, por cuenta de dos Administradores. El SuperAdmin y
 * el resto de roles no registran traspasos entre bolsas (el SuperAdmin asigna y retira capital).
 */
export async function registerAdminTransfer(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  requireRole(ctx, ['admin', 'secretario']);
  const op = requireOperationId(operationId);
  const origin = ctx.role === 'admin' ? (optId(body, 'originAdminId') ?? ctx.membershipId) : reqId(body, 'originAdminId');
  if (ctx.role === 'admin' && origin !== ctx.membershipId) throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'an administrator only transfers from their own pool');
  const destination = reqId(body, 'destinationAdminId');
  if (origin === destination) throw new ApiError(400, 'INVALID_INPUT', 'origin and destination must differ', { field: 'destinationAdminId' });
  const amount = amountOf(body);
  const reason = reasonOf(body);
  const requestId = optId(body, 'requestId');
  if (requestId && ctx.role !== 'admin') throw new ApiError(409, 'REQUEST_MISMATCH', 'a capital request is attended by the administrator who holds the capital');
  if (requestId) await claimRequest(client, ctx, requestId, 'admin_transfer');
  const r = await client.query<Row>('select * from adex.admin_transfer_register($1, $2, $3, $4, $5)',
    [op, ctx.role === 'admin' ? null : origin, destination, amount, reason]);
  const row = r.rows[0]!;
  await auditTransfer(client, ctx, row, row.state === 'applied' ? 'ADMIN_TRANSFER_APPLIED' : 'ADMIN_TRANSFER_REGISTERED',
    row.state === 'applied' ? `Traspaso ${amount} entregado por el Administrador de origen y aplicado a la bolsa destino (entrega voluntaria).`
      : `Traspaso ${amount} entre Administradores registrado por Secretario; pendiente de la confirmación de ambos.`, reason);
  const out = await respond(client, ctx, row);
  return requestId ? { ...out, request: await fulfillRequest(client, ctx, requestId, { transfer: row.id }) } : out;
}

/** Confirmar o rechazar la PROPIA parte (solo el Administrador origen o destino). */
export async function decideAdminTransfer(client: pg.PoolClient, ctx: ActiveContext, id: string, decision: 'confirm' | 'reject',
  body: Record<string, unknown>, operationId: string | null) {
  pathId(id);
  requireRole(ctx, ['admin']);
  const op = requireOperationId(operationId);
  const reason = decision === 'reject' ? reasonOf(body) : null;
  const r = await client.query<Row>('select * from adex.admin_transfer_decide($1, $2, $3, $4)', [op, id, decision, reason]);
  const row = r.rows[0]!;
  const action = row.state === 'applied' ? 'ADMIN_TRANSFER_APPLIED' : decision === 'reject' ? 'ADMIN_TRANSFER_REJECTED' : 'ADMIN_TRANSFER_CONFIRMED';
  const text = row.state === 'applied' ? `Traspaso ${Number(row.amount_minor)} aplicado a la bolsa destino.`
    : decision === 'reject' ? `Traspaso ${Number(row.amount_minor)} rechazado; el capital vuelve a la bolsa de origen.`
      : `Confirmación registrada; el traspaso sigue pendiente de la otra parte.`;
  await auditTransfer(client, ctx, row, action, text, reason ?? 'Confirmación de la parte');
  return respond(client, ctx, row);
}

/** Cancelar (solo quien registró, mientras siga pendiente). */
export async function cancelAdminTransfer(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  pathId(id);
  requireRole(ctx, ['admin', 'secretario']);
  const op = requireOperationId(operationId);
  const reason = reasonOf(body);
  const r = await client.query<Row>('select * from adex.admin_transfer_cancel($1, $2, $3)', [op, id, reason]);
  const row = r.rows[0]!;
  await auditTransfer(client, ctx, row, 'ADMIN_TRANSFER_CANCELLED', `Traspaso ${Number(row.amount_minor)} cancelado; el capital vuelve a la bolsa de origen.`, reason);
  return respond(client, ctx, row);
}

// ============================================================
// Consultas (RLS: cada Administrador los suyos, el Secretario los de Secretario, el SuperAdmin todos)
// ============================================================

const STATES: readonly string[] = ['pending', 'applied', 'rejected', 'cancelled'];

export async function listAdminTransfers(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  requireRole(ctx, ['superadmin', 'admin', 'secretario']);
  const state = q.get('state');
  if (state !== null && !STATES.includes(state)) throw new ApiError(400, 'INVALID_INPUT', 'state is invalid', { field: 'state' });
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 500);
  const params: unknown[] = [ctx.companyId, limit];
  const r = await client.query<Row>(
    `select * from adex.admin_transfers where company_id = $1 ${state ? `and state = $${params.push(state)}` : ''}
      order by (state = 'pending') desc, created_at desc, id limit $2`, params);
  const names = await namesOf(client, ctx, r.rows);
  return r.rows.map((x) => view(x, ctx, names));
}

export async function getAdminTransfer(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  requireRole(ctx, ['superadmin', 'admin', 'secretario']);
  const r = await client.query<Row>('select * from adex.admin_transfers where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return respond(client, ctx, r.rows[0]);
}

/** Administradores activos (id y nombre, nunca saldos) para elegir la contraparte. */
export async function adminDirectory(client: pg.PoolClient, ctx: ActiveContext) {
  requireRole(ctx, ['superadmin', 'admin', 'secretario']);
  const r = await client.query<{ membership_id: string; display_name: string }>('select * from adex.admin_directory()');
  return r.rows.map((x) => ({ adminId: x.membership_id, name: x.display_name, self: x.membership_id === ctx.membershipId }));
}
