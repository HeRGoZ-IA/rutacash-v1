// CORRECCIÓN DE PAGOS Y SOLICITUDES DE AJUSTE (ADEX Online, 0017).
//
// Reglas de CLEAN (`paymentCorrectionService`) sin copiar: `can()` con el estado del
// periodo (`payment.correct`; en periodo cerrado exige `payment.approveAdjustment`).
//   · correctCollection   → `correctPayment`: reversión + reemplazo en UNA transacción.
//   · createAdjustment    → `requestPaymentAdjustment`: el Secretario (o quien corrige)
//                           pide la corrección de un pago de periodo cerrado.
//   · approveAdjustment   → `approvePaymentAdjustment`: ejecuta la corrección y cierra
//                           la solicitud en la MISMA transacción.
//   · rejectAdjustment    → `rejectPaymentAdjustment`: motivo obligatorio; el pago no cambia.
// El dinero lo mueve `adex.collection_correct` bajo bloqueo (segunda barrera); aquí no se
// calcula ningún saldo. Fechas: la reversión, según su periodo; el reemplazo, hoy (DS-04).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from '../structure/common.ts';
import { optText, pathId, reqId, reqText } from '../structure/input.ts';
import { requireOperationId, routeOf } from '../capital/service.ts';

export const CORRECTION_FIELDS = ['newAmountMinor', 'reason', 'note'] as const;
export const ADJUSTMENT_FIELDS = ['paymentId', 'newAmountMinor', 'reason', 'note'] as const;

type Json = Record<string, unknown>;

interface AdjustmentRow {
  id: string; route_id: string; payment_id: string; client_id: string; sale_id: string; requested_by_membership_id: string; requested_by_role: string;
  requested_at: Date; original_amount_minor: string; original_date: string | Date; reason: string; new_amount_minor: string; new_date: string | Date | null;
  note: string | null; status: string; reviewed_by_membership_id: string | null; reviewed_at: Date | null; rejection_reason: string | null;
  resulting_reversal_id: string | null; resulting_payment_id: string | null;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

function adjustmentView(r: AdjustmentRow) {
  return {
    id: r.id, routeId: r.route_id, paymentId: r.payment_id, clientId: r.client_id, saleId: r.sale_id, requestedBy: r.requested_by_membership_id,
    requestedByRole: r.requested_by_role, requestedAt: r.requested_at.toISOString(), originalAmountMinor: Number(r.original_amount_minor),
    originalDate: ymd(r.original_date), reason: r.reason, newAmountMinor: Number(r.new_amount_minor), newDate: r.new_date ? ymd(r.new_date) : null,
    note: r.note, status: r.status, reviewedBy: r.reviewed_by_membership_id, reviewedAt: r.reviewed_at?.toISOString() ?? null,
    rejectionReason: r.rejection_reason, resultingReversalId: r.resulting_reversal_id, resultingPaymentId: r.resulting_payment_id,
  };
}

function newAmountOf(body: Json): number {
  const v = body['newAmountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ApiError(400, 'INVALID_INPUT', 'newAmountMinor must be a positive integer (minor units)', { field: 'newAmountMinor' });
  return v;
}
function reasonOf(body: Json): string {
  const r = reqText(body, 'reason', 300);
  if (r.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  return r;
}

async function loadAdjustment(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<AdjustmentRow> {
  pathId(id);
  const r = await client.query<AdjustmentRow>('select * from adex.payment_adjustment_requests where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

/** Corrección directa (`correctPayment`): periodo abierto, o cerrado con autoridad de ajuste. */
export async function correctCollection(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Json, operationId: string | null) {
  const opId = requireOperationId(operationId);
  pathId(id);
  const p = (await client.query<{ route_id: string; amount_minor: string; payment_date: string | Date }>(
    'select route_id, amount_minor, payment_date from adex.payments where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!p) throw new ApiError(404, 'NOT_FOUND');
  await routeOf(client, ctx, p.route_id);
  need(ctx, 'payment.correct', { routeId: p.route_id });
  const newAmount = newAmountOf(body);
  const reason = reasonOf(body);
  const note = optText(body, 'note', 500);
  const r = (await client.query<{ r: Json }>('select adex.collection_correct($1, $2, $3, $4, $5, null) r', [opId, id, newAmount, reason, note])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'CORRECT_PAYMENT', entityType: 'Payment', entityId: id, routeId: p.route_id, reason,
    description: 'Corrección de pago (reversión + reemplazo)',
    before: { valor: Number(p.amount_minor), fecha: ymd(p.payment_date) }, after: { valor: newAmount, fecha: r['correctedDate'] },
    metadata: { operationId: opId, reversalId: r['reversalPaymentId'], correctedId: r['correctedPaymentId'], periodClosed: r['periodClosed'] },
  });
  return r;
}

/** Solicitud de ajuste (`requestPaymentAdjustment`): un pago vigente, una sola pendiente por pago. */
export async function createAdjustment(client: pg.PoolClient, ctx: ActiveContext, body: Json) {
  const paymentId = reqId(body, 'paymentId');
  const p = (await client.query<{ route_id: string; client_id: string; sale_id: string; amount_minor: string; payment_date: string | Date; state: string | null }>(
    'select route_id, client_id, sale_id, amount_minor, payment_date, state from adex.payments where company_id = $1 and id = $2', [ctx.companyId, paymentId])).rows[0];
  if (!p) throw new ApiError(404, 'NOT_FOUND');
  await routeOf(client, ctx, p.route_id);
  need(ctx, 'payment.correct', { routeId: p.route_id });
  if ((p.state ?? 'active') !== 'active') throw new ApiError(409, 'ALREADY_REVERSED');
  const newAmount = newAmountOf(body);
  const reason = reasonOf(body);
  const note = optText(body, 'note', 500);
  const id = randomUUID();
  await client.query(
    `insert into adex.payment_adjustment_requests (id, company_id, route_id, payment_id, client_id, sale_id, requested_by_membership_id, requested_by_role,
                                                   requested_at, original_amount_minor, original_date, reason, new_amount_minor, note, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11, $12, $13, 'pending')`,
    [id, ctx.companyId, p.route_id, paymentId, p.client_id, p.sale_id, ctx.membershipId, ctx.role, p.amount_minor, ymd(p.payment_date), reason, newAmount, note]);
  await audit(client, ctx, {
    action: 'REQUEST_PAYMENT_ADJUSTMENT', entityType: 'Payment', entityId: paymentId, routeId: p.route_id, reason,
    description: 'Solicitud de ajuste de pago (periodo cerrado)',
    before: { valor: Number(p.amount_minor), fecha: ymd(p.payment_date) }, after: { valor: newAmount }, metadata: { requestId: id },
  });
  return adjustmentView(await loadAdjustment(client, ctx, id));
}

export async function listAdjustments(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  const status = q.get('status');
  if (status !== null) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new ApiError(400, 'INVALID_INPUT');
    params.push(status); where += ` and status = $${params.length}`;
  }
  const routeId = q.get('routeId');
  if (routeId !== null) { pathId(routeId); params.push(routeId); where += ` and route_id = $${params.length}`; }
  const r = await client.query<AdjustmentRow>(`select * from adex.payment_adjustment_requests where ${where} order by requested_at desc, id limit 500`, params);
  // RLS: solo las de las rutas del contexto.
  return r.rows.map(adjustmentView);
}

/**
 * R74 (DS-05): quien resuelve (aprueba o rechaza) una solicitud de ajuste no es la PERSONA que la
 * pidió, tampoco con otra membresía. PostgreSQL lo repite (`collection_correct` AX505 y la política
 * `payment_adjustment_reject`, 0033).
 */
async function notOwnRequest(client: pg.PoolClient, ctx: ActiveContext, a: AdjustmentRow): Promise<void> {
  const same = (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, a.requested_by_membership_id])).rows[0]!.s;
  if (same) throw new ApiError(403, 'SELF_APPROVAL_FORBIDDEN', 'nobody resolves their own adjustment request');
}

/** Aprobación (`approvePaymentAdjustment`): corrige y cierra la solicitud en la misma transacción. */
export async function approveAdjustment(client: pg.PoolClient, ctx: ActiveContext, id: string, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const a = await loadAdjustment(client, ctx, id);
  await routeOf(client, ctx, a.route_id);
  need(ctx, 'payment.approveAdjustment', { routeId: a.route_id });
  if (a.status !== 'pending') throw new ApiError(409, 'REQUEST_STATE_INVALID');
  await notOwnRequest(client, ctx, a);
  const r = (await client.query<{ r: Json }>('select adex.collection_correct($1, $2, $3, $4, $5, $6) r',
    [opId, a.payment_id, Number(a.new_amount_minor), a.reason, a.note, a.id])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'APPROVE_PAYMENT_ADJUSTMENT', entityType: 'PaymentAdjustmentRequest', entityId: id, routeId: a.route_id, reason: a.reason,
    description: 'Aprobación de solicitud de ajuste de pago',
    before: { valor: Number(a.original_amount_minor) }, after: { valor: Number(a.new_amount_minor), fecha: r['correctedDate'] },
    metadata: { operationId: opId, paymentId: a.payment_id, reversalId: r['reversalPaymentId'], correctedId: r['correctedPaymentId'] },
  });
  return { request: adjustmentView(await loadAdjustment(client, ctx, id)), correction: r };
}

/** Rechazo (`rejectPaymentAdjustment`): motivo obligatorio; el pago original no cambia. */
export async function rejectAdjustment(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Json) {
  const a = await loadAdjustment(client, ctx, id);
  await routeOf(client, ctx, a.route_id);
  need(ctx, 'payment.approveAdjustment', { routeId: a.route_id });
  if (a.status !== 'pending') throw new ApiError(409, 'REQUEST_STATE_INVALID');
  await notOwnRequest(client, ctx, a);
  const reason = reasonOf(body);
  await client.query(`update adex.payment_adjustment_requests set status = 'rejected', reviewed_by_membership_id = $3, reviewed_at = now(), rejection_reason = $4
                       where company_id = $1 and id = $2`, [ctx.companyId, id, ctx.membershipId, reason]);
  await audit(client, ctx, {
    action: 'REJECT_PAYMENT_ADJUSTMENT', entityType: 'PaymentAdjustmentRequest', entityId: id, routeId: a.route_id, reason,
    description: 'Rechazo de solicitud de ajuste de pago', before: { status: 'pending' }, after: { status: 'rejected' },
  });
  return adjustmentView(await loadAdjustment(client, ctx, id));
}
