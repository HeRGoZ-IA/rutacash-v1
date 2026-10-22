// CRÉDITOS (Fase 4): solicitud → autorización → desembolso, y venta directa, con el
// motor de capital y custodia de la Fase 3. SOLO EN LÍNEA: el servidor confirma antes
// de informar; un reintento con el mismo `X-Adex-Operation-Id` devuelve el resultado
// ya guardado y nunca desembolsa dos veces.
//
// Reglas de CLEAN reutilizadas SIN copiar (funciones puras de `src/lib` y del motor de
// cuotas): `decideSaleOrigination` (segundo crédito), `originationRateError` (el
// Cobrador solo origina al 20 %), `ALLOWED_INTEREST_RATES` (10 y 20), `directSaleLimit`
// (por la ruta), `calculateTotalWithInterest`, `calculateInstallmentValue`,
// `generateInstallments` y `estimateFinalDate`.
//
// Diferencia con CLEAN (decisión del propietario, Fase 4): aprobar NO crea el crédito.
// La obligación del cliente nace al confirmar el desembolso, en la misma transacción
// que el asiento contable (`adex.credit_disburse`). Una solicitud aprobada cuenta como
// crédito activo del cliente, igual que la venta «pendiente» de CLEAN.
//
// Segunda barrera en PostgreSQL: RLS + guardia de transiciones de `sale_requests`
// (0010) y `adex.credit_disburse` como única vía de creación de créditos.

import type pg from 'pg';
import { decideSaleOrigination } from '@/lib/activeCredit';
import { ALLOWED_INTEREST_RATES, originationRateError } from '@/lib/interestRatePolicy';
import { calculateInstallmentValue, calculateTotalWithInterest, generateInstallments } from '@/services/installmentEngine';
import type { PaymentFrequency } from '@/models/types';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { need } from '../structure/common.ts';
import { has, optText, PAGE_ORDER, pageFilters, pathId, reqId, reqText } from '../structure/input.ts';
import { requireOperationId, routeOf } from '../capital/service.ts';
import { parseOffline, requireOfflineActor, storeOfflineCapture, type OfflineCapture } from '../offline/capture.ts';
import { parseLocation } from '../collections/location.ts';
import { storeSaleLocation } from '../map/service.ts';

const FREQUENCIES: readonly PaymentFrequency[] = ['diaria', 'semanal', 'quincenal', 'mensual', 'personalizada'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Status = 'pending' | 'approved' | 'rejected' | 'disbursed' | 'cancelled';

interface RequestRow {
  id: string; client_id: string; route_id: string; collector_membership_id: string; requested_by_membership_id: string | null;
  amount_minor: string; interest_rate: string; total_amount_minor: string; installments_count: number; installment_value_minor: string;
  frequency: PaymentFrequency; start_date: string | Date; payment_days: number[] | null; status: Status; requested_at: Date;
  reviewed_at: Date | null; reviewed_by_membership_id: string | null; rejection_reason: string | null; approval_notes: string | null;
  sale_id: string | null; requested_interest_rate: string | null; requested_frequency: PaymentFrequency | null;
  requested_payment_days: number[] | null; approved_interest_rate: string | null; approved_frequency: PaymentFrequency | null;
  approved_payment_days: number[] | null; phone_confirmed: boolean | null; phone_confirmation_note: string | null;
  active_credit_sale_ids: string[] | null; authorization_reason: string | null;
  // Ronda 73 (0030): parcelas pedidas y aprobadas (NULL en solicitudes anteriores: valen `installments_count`).
  requested_installments_count?: number | null; approved_installments_count?: number | null;
  cancelled_at: Date | null; cancelled_by_membership_id: string | null; cancel_reason: string | null;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
const iso = (d: Date | null) => d?.toISOString() ?? null;
const num = (v: string | null) => (v === null ? null : Number(v));

function requestView(r: RequestRow) {
  return {
    id: r.id, clientId: r.client_id, routeId: r.route_id, requestedBy: r.requested_by_membership_id ?? r.collector_membership_id,
    status: r.status, amountMinor: Number(r.amount_minor), interestRate: Number(r.interest_rate), totalAmountMinor: Number(r.total_amount_minor),
    installmentsCount: r.installments_count, installmentValueMinor: Number(r.installment_value_minor), frequency: r.frequency,
    startDate: ymd(r.start_date), paymentDays: r.payment_days ?? [], requestedAt: r.requested_at.toISOString(),
    requested: { interestRate: num(r.requested_interest_rate), frequency: r.requested_frequency, paymentDays: r.requested_payment_days,
      installmentsCount: r.requested_installments_count ?? r.installments_count },
    approved: r.approved_interest_rate === null ? null
      : { interestRate: num(r.approved_interest_rate), frequency: r.approved_frequency, paymentDays: r.approved_payment_days,
          installmentsCount: r.approved_installments_count ?? r.installments_count },
    reviewedAt: iso(r.reviewed_at), reviewedBy: r.reviewed_by_membership_id, rejectionReason: r.rejection_reason, approvalNotes: r.approval_notes,
    phoneConfirmed: r.phone_confirmed ?? false, phoneConfirmationNote: r.phone_confirmation_note,
    authorizationReason: r.authorization_reason, activeCreditSaleIdsAtRequest: r.active_credit_sale_ids ?? [],
    cancelledAt: iso(r.cancelled_at), cancelledBy: r.cancelled_by_membership_id, cancelReason: r.cancel_reason, saleId: r.sale_id,
  };
}

// ---------- Entradas ----------

function amountOf(body: Record<string, unknown>): number {
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  return v;
}
function rateOf(body: Record<string, unknown>, key = 'interestRate'): number {
  const v = body[key];
  if (typeof v !== 'number' || !(ALLOWED_INTEREST_RATES as readonly number[]).includes(v)) throw new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED', 'the rate must be 10 or 20', { field: key });
  return v;
}
function countOf(body: Record<string, unknown>): number {
  const v = body['installmentsCount'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000) throw new ApiError(400, 'INVALID_INPUT', 'installmentsCount is invalid', { field: 'installmentsCount' });
  return v;
}
function frequencyOf(body: Record<string, unknown>): PaymentFrequency {
  const v = body['frequency'];
  if (typeof v !== 'string' || !FREQUENCIES.includes(v as PaymentFrequency)) throw new ApiError(400, 'INVALID_INPUT', 'frequency is invalid', { field: 'frequency' });
  return v as PaymentFrequency;
}
function daysOf(body: Record<string, unknown>): number[] {
  const v = body['paymentDays'];
  if (!Array.isArray(v) || v.length === 0 || v.length > 7 || !v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(v).size !== v.length) {
    throw new ApiError(400, 'INVALID_INPUT', 'select at least one valid payment day', { field: 'paymentDays' });
  }
  return [...(v as number[])].sort((a, b) => a - b);
}
function startOf(body: Record<string, unknown>): string {
  const v = body['startDate'];
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new ApiError(400, 'INVALID_INPUT', 'startDate is invalid', { field: 'startDate' });
  return v;
}

interface Conditions { amount: number; rate: number; count: number; frequency: PaymentFrequency; start: string; days: number[] }

/** Totales y calendario con el motor de CLEAN (sobre unidades menores). */
function financials(c: Conditions) {
  const { valorTotal } = calculateTotalWithInterest({ valorVenta: c.amount, tasaInteres: c.rate });
  const value = calculateInstallmentValue({ valorTotal, numeroCuotas: c.count });
  const schedule = generateInstallments({ saleId: 'calendario', valorTotal, numeroCuotas: c.count, valorCuota: value, frecuencia: c.frequency,
    fechaInicio: c.start, paymentDays: c.days }).map((i) => ({ number: i.numero, dueDate: i.fechaVencimiento, amountMinor: i.valor }));
  return { total: valorTotal, value, schedule };
}

async function companyToday(client: pg.PoolClient, ctx: ActiveContext): Promise<string> {
  // Fecha contable de la empresa (0018: una sola fuente para todo el servidor).
  return (await client.query<{ d: string }>('select adex.business_today($1)::text d', [ctx.companyId])).rows[0]!.d;
}

/** Cliente ACTIVO de esa ruta, visible para el actor. */
async function activeClient(client: pg.PoolClient, ctx: ActiveContext, clientId: string, routeId: string): Promise<{ id: string; name: string }> {
  const r = await client.query<{ id: string; name: string; status: string; route_id: string }>(
    'select id, name, status, route_id from adex.clients where company_id = $1 and id = $2', [ctx.companyId, clientId]);
  const c = r.rows[0];
  if (!c || c.route_id !== routeId) throw new ApiError(404, 'NOT_FOUND');
  if (c.status !== 'activo') throw new ApiError(409, 'CLIENT_NOT_ACTIVE');
  return { id: c.id, name: c.name };
}

/** Créditos activos del cliente en TODA la empresa (ventas activas + aprobadas sin desembolsar). */
async function activeCredits(client: pg.PoolClient, ctx: ActiveContext, clientId: string) {
  const r = await client.query<{ kind: string; id: string }>('select kind, id from adex.client_active_credits($1, $2)', [ctx.companyId, clientId]);
  return { sales: r.rows.filter((x) => x.kind === 'sale').map((x) => x.id), approvedRequests: r.rows.filter((x) => x.kind === 'approved_request').map((x) => x.id) };
}

async function loadRequest(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<RequestRow> {
  pathId(id);
  const r = await client.query<RequestRow>('select * from adex.sale_requests where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

async function samePerson(client: pg.PoolClient, ctx: ActiveContext, a: string, b: string): Promise<boolean> {
  return (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, a, b])).rows[0]!.s;
}

// ============================================================
// Solicitudes
// ============================================================

// Ronda 65-C1 (decisión del propietario): clientes y solicitudes NO se registran sin conexión;
// estos comandos no admiten `offline` (UNKNOWN_FIELD). Sin conexión, el Cobrador llama a la oficina.
// Ronda 67: `location` = lectura del DISPOSITIVO al registrar la venta en línea (evidencia; nunca la del cliente).
export const CREATE_REQUEST_FIELDS = ['routeId', 'clientId', 'amountMinor', 'interestRate', 'installmentsCount', 'frequency', 'startDate', 'paymentDays', 'location'] as const;

/**
 * Ronda 65: desembolso capturado sin conexión (solo el Cobrador) con id de operación, que identifica
 * la evidencia de la captura. Las reglas del comando son las mismas que en línea.
 */
function offlineOf(ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null): OfflineCapture | null {
  const offline = parseOffline(body['offline']);
  if (!offline) return null;
  requireOfflineActor(ctx);
  if (!operationId) throw new ApiError(400, 'OPERATION_ID_REQUIRED');
  return offline;
}

/**
 * Solicitud de crédito (`createSaleRequest`). Tener efectivo en custodia NO autoriza
 * a prestar: el Cobrador siempre solicita. Una sola pendiente por cliente (índice único).
 */
export async function createRequest(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  need(ctx, 'sale.createRequest', { routeId: route.id });
  const cond: Conditions = { amount: amountOf(body), rate: rateOf(body), count: countOf(body), frequency: frequencyOf(body), start: startOf(body), days: daysOf(body) };
  const rateError = originationRateError(ctx.role, cond.rate);
  if (rateError) throw new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED', rateError);
  if (cond.start < await companyToday(client, ctx)) throw new ApiError(400, 'INVALID_CONDITIONS', 'start date before today');
  const cl = await activeClient(client, ctx, reqId(body, 'clientId'), route.id);
  const active = await activeCredits(client, ctx, cl.id);
  const routeRow = (await client.query<{ max: string }>('select max_loan_minor max from adex.routes where company_id = $1 and id = $2', [ctx.companyId, route.id])).rows[0]!;
  const canDirect = allowed(ctx, 'sale.createDirect', { routeId: route.id });
  const decision = decideSaleOrigination({ actor: { rol: ctx.role }, canCreateDirect: canDirect, canCreateRequest: true,
    activeCredits: active.sales.length + active.approvedRequests.length });
  // `directSaleLimit` de CLEAN con el límite de la ruta (el del usuario es legado: `can()` lo ignora).
  const limit = Number(routeRow.max) > 0 ? Number(routeRow.max) : Infinity;
  const reason = decision.kind === 'authorization' ? decision.reason : cond.amount > limit ? 'over-limit' : null;
  const { total, value } = financials(cond);
  const r = await client.query<RequestRow>(
    `insert into adex.sale_requests (id, company_id, client_id, route_id, collector_membership_id, amount_minor, interest_rate, total_amount_minor,
                                     installments_count, installment_value_minor, frequency, start_date, payment_days, status, requested_at,
                                     requested_by_membership_id, requested_interest_rate, requested_frequency, requested_payment_days,
                                     active_credit_sale_ids, authorization_reason)
     values (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', now(), $4, $6, $10, $12, $13, $14)
     returning *`,
    [ctx.companyId, cl.id, route.id, ctx.membershipId, cond.amount, cond.rate, total, cond.count, value, cond.frequency, cond.start, cond.days,
      active.sales, reason]);
  const row = r.rows[0]!;
  // Ronda 67: ubicación del dispositivo en un savepoint (una falla de GPS o de esquema no tumba la solicitud).
  const location = parseLocation(body['location']);
  if (location) await storeSaleLocation(client, ctx, { kind: 'credit_request', entityId: row.id, routeId: route.id, clientId: cl.id, location });
  await audit(client, ctx, { action: 'CREATE_SALE_REQUEST', entityType: 'sale_request', entityId: row.id, routeId: route.id,
    description: `Solicitud de crédito ${cond.amount} para ${cl.name}`, after: requestView(row) });
  return requestView(row);
}

export const APPROVE_FIELDS = ['notes', 'interestRate', 'frequency', 'paymentDays', 'installmentsCount', 'phoneConfirmed', 'phoneConfirmationNote'] as const;

/**
 * Aprobación (`approveSaleRequest`): fija las condiciones FINALES. NO crea el crédito
 * ni mueve dinero. Cambiar tasa, frecuencia, días o (Ronda 73, SOC-04) número de parcelas
 * exige `authorization.modifyConditions`; el importe no se cambia. Total, valor de la
 * parcela y calendario se recalculan aquí y el desembolso usa SOLO lo aprobado. Nadie
 * resuelve su propia solicitud (ni con otra membresía). Dos aprobaciones simultáneas:
 * una gana; la otra, 409.
 */
export async function approveRequest(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const prev = await loadRequest(client, ctx, id);
  need(ctx, 'authorization.approve', { routeId: prev.route_id });
  if (prev.status !== 'pending') throw new ApiError(409, 'REQUEST_STATE_INVALID');
  if (await samePerson(client, ctx, ctx.membershipId, prev.requested_by_membership_id ?? prev.collector_membership_id)) {
    throw new ApiError(403, 'SELF_APPROVAL_FORBIDDEN');
  }
  await routeOf(client, ctx, prev.route_id);
  await activeClient(client, ctx, prev.client_id, prev.route_id);
  const before = { interestRate: Number(prev.interest_rate), frequency: prev.frequency, paymentDays: prev.payment_days ?? [], installmentsCount: prev.installments_count };
  const after = {
    interestRate: has(body, 'interestRate') ? rateOf(body) : before.interestRate,
    frequency: has(body, 'frequency') ? frequencyOf(body) : before.frequency,
    paymentDays: has(body, 'paymentDays') ? daysOf(body) : before.paymentDays,
    installmentsCount: has(body, 'installmentsCount') ? countOf(body) : before.installmentsCount,
  };
  const changes = JSON.stringify(before) !== JSON.stringify(after);
  if (changes) need(ctx, 'authorization.modifyConditions', { routeId: prev.route_id });
  const phone = has(body, 'phoneConfirmed') ? body['phoneConfirmed'] === true : (prev.phone_confirmed ?? false);
  if (has(body, 'phoneConfirmed') && typeof body['phoneConfirmed'] !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'phoneConfirmed must be boolean');
  if (phone && !prev.phone_confirmed) need(ctx, 'authorization.phoneConfirm', { routeId: prev.route_id });
  const { total, value } = financials({ amount: Number(prev.amount_minor), rate: after.interestRate, count: after.installmentsCount,
    frequency: after.frequency, start: ymd(prev.start_date), days: after.paymentDays });
  // Las parcelas solo se escriben si cambian (0030): sin cambio, la aprobación es la de siempre.
  const countChanged = after.installmentsCount !== before.installmentsCount;
  const r = await client.query<RequestRow>(
    `update adex.sale_requests set status = 'approved', reviewed_at = now(), reviewed_by_membership_id = $3, approval_notes = $4,
            interest_rate = $5, frequency = $6, payment_days = $7, total_amount_minor = $8, installment_value_minor = $9,
            approved_interest_rate = $5, approved_frequency = $6, approved_payment_days = $7, phone_confirmed = $10,
            phone_confirmation_note = coalesce($11, phone_confirmation_note)${countChanged ? ', installments_count = $12' : ''}
      where company_id = $1 and id = $2 and status = 'pending' returning *`,
    [ctx.companyId, prev.id, ctx.membershipId, optText(body, 'notes', 500), after.interestRate, after.frequency, after.paymentDays, total, value,
      phone, optText(body, 'phoneConfirmationNote', 300), ...(countChanged ? [after.installmentsCount] : [])]);
  if (!r.rows[0]) throw new ApiError(409, 'REQUEST_STATE_INVALID');
  const base = { entityType: 'sale_request', entityId: prev.id, routeId: prev.route_id };
  await audit(client, ctx, { ...base, action: 'APPROVE_SALE_REQUEST', description: `Solicitud aprobada (${Number(prev.amount_minor)})`, before, after: { ...after, phoneConfirmed: phone } });
  if (changes) await audit(client, ctx, { ...base, action: 'CHANGE_SALE_CONDITIONS', description: 'Modificación de condiciones en autorización', before, after });
  if (phone && !prev.phone_confirmed) {
    await audit(client, ctx, { ...base, action: 'PHONE_CONFIRMATION', description: 'Confirmación telefónica con el cliente', reason: optText(body, 'phoneConfirmationNote', 300) });
  }
  return requestView(r.rows[0]);
}

/** Rechazo con motivo (`rejectSaleRequest`). No crea nada. */
export async function rejectRequest(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const prev = await loadRequest(client, ctx, id);
  need(ctx, 'authorization.reject', { routeId: prev.route_id });
  if (prev.status !== 'pending') throw new ApiError(409, 'REQUEST_STATE_INVALID');
  if (await samePerson(client, ctx, ctx.membershipId, prev.requested_by_membership_id ?? prev.collector_membership_id)) {
    throw new ApiError(403, 'SELF_APPROVAL_FORBIDDEN');
  }
  const reason = reqText(body, 'reason', 300);
  const r = await client.query<RequestRow>(
    `update adex.sale_requests set status = 'rejected', reviewed_at = now(), reviewed_by_membership_id = $3, rejection_reason = $4
      where company_id = $1 and id = $2 and status = 'pending' returning *`, [ctx.companyId, prev.id, ctx.membershipId, reason]);
  if (!r.rows[0]) throw new ApiError(409, 'REQUEST_STATE_INVALID');
  await audit(client, ctx, { action: 'REJECT_SALE_REQUEST', entityType: 'sale_request', entityId: prev.id, routeId: prev.route_id,
    description: 'Solicitud rechazada', reason });
  return requestView(r.rows[0]);
}

/**
 * Cancelación de una solicitud APROBADA que no se entregará (`sale.cancel`, Admin y
 * SuperAdmin; en CLEAN, marcar perdida una venta pendiente). Ya no admite desembolso.
 */
export async function cancelRequest(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const prev = await loadRequest(client, ctx, id);
  need(ctx, 'sale.cancel', { routeId: prev.route_id });
  if (prev.status !== 'approved') throw new ApiError(409, 'REQUEST_STATE_INVALID');
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = await client.query<RequestRow>(
    `update adex.sale_requests set status = 'cancelled', cancelled_at = now(), cancelled_by_membership_id = $3, cancel_reason = $4
      where company_id = $1 and id = $2 and status = 'approved' returning *`, [ctx.companyId, prev.id, ctx.membershipId, reason]);
  if (!r.rows[0]) throw new ApiError(409, 'REQUEST_STATE_INVALID');
  await audit(client, ctx, { action: 'CANCEL_SALE_REQUEST', entityType: 'sale_request', entityId: prev.id, routeId: prev.route_id,
    description: 'Solicitud aprobada cancelada sin desembolso', reason });
  return requestView(r.rows[0]);
}

// ============================================================
// Desembolso y venta directa
// ============================================================

async function disburse(client: pg.PoolClient, operationId: string, requestId: string | null, routeId: string, clientId: string, c: Conditions, reason: string) {
  const { schedule } = financials(c);
  const r = await client.query<{ credit_id: string; disbursement_id: string }>(
    'select * from adex.credit_disburse($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
    [operationId, requestId, routeId, clientId, c.amount, c.rate, c.count, c.frequency, c.start, c.days, JSON.stringify(schedule), reason]);
  return r.rows[0]!;
}

/**
 * Confirmación del desembolso REAL de una solicitud aprobada (`confirmDisbursement`).
 * Sale de la custodia de quien entrega el efectivo (Cobrador o Supervisor) o, si quien
 * confirma no tiene caja personal, de la bolsa del responsable de la ruta. Crea el
 * crédito, sus cuotas y el asiento UNA vez. Sin fondos: 409 y nada escrito.
 */
export const DISBURSE_FIELDS = ['offline'] as const;

/**
 * Ronda 65 · `offline`: el Cobrador entregó el dinero SIN CONEXIÓN con su efectivo en custodia. Al
 * sincronizar se aplica lo mismo que en línea (solicitud aún aprobada, custodia suficiente sin
 * contar faltante arrastrado, ruta operativa, periodo abierto); si ya no cabe, 409 y nada escrito
 * (el dispositivo lo conserva en revisión: nunca se reintenta con otro id ni se fuerza un saldo).
 */
export async function disburseRequest(client: pg.PoolClient, ctx: ActiveContext, id: string, operationId: string | null, body: Record<string, unknown> = {}) {
  const opId = requireOperationId(operationId);
  const offline = offlineOf(ctx, body, opId);
  const prev = await loadRequest(client, ctx, id);
  need(ctx, 'sale.confirmDisbursement', { routeId: prev.route_id });
  if (prev.status !== 'approved') throw new ApiError(409, 'REQUEST_NOT_DISBURSABLE');
  const c: Conditions = { amount: Number(prev.amount_minor), rate: Number(prev.interest_rate), count: prev.installments_count,
    frequency: prev.frequency, start: ymd(prev.start_date), days: prev.payment_days ?? [] };
  const out = await disburse(client, opId, prev.id, prev.route_id, prev.client_id, c,
    offline ? 'Desembolso de solicitud aprobada (sin conexión)' : 'Desembolso de solicitud aprobada');
  const offlineStatus = offline
    ? await storeOfflineCapture(client, ctx, { operationId: opId, kind: 'disbursement', entityId: out.credit_id, routeId: prev.route_id, capture: offline })
    : null;
  await audit(client, ctx, { action: 'CONFIRM_DISBURSEMENT', entityType: 'sale', entityId: out.credit_id, routeId: prev.route_id,
    description: `Desembolso confirmado (${c.amount})`, after: { saleRequestId: prev.id, operationId: out.disbursement_id },
    metadata: { operationId: opId, ...(offline ? { offline: { deviceCapturedAt: offline.deviceCapturedAt, stored: offlineStatus } } : {}) } });
  const credit = await getCredit(client, ctx, out.credit_id);
  return offline ? { ...credit, offline: { deviceCapturedAt: offline.deviceCapturedAt } } : credit;
}

export const DIRECT_FIELDS = CREATE_REQUEST_FIELDS;

/**
 * Venta directa (`createDirectSale`): solo `sale.createDirect` (SuperAdmin,
 * Administrador, Supervisor). Queda desembolsada en el acto con las mismas reglas de
 * fondos que la confirmación. El Supervisor (sin `route.edit`) respeta el límite de la
 * ruta: por encima, solicitud. El Cobrador NO vende directo (discrepancia pendiente).
 */
export async function directSale(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  need(ctx, 'sale.createDirect', { routeId: route.id });
  const c: Conditions = { amount: amountOf(body), rate: rateOf(body), count: countOf(body), frequency: frequencyOf(body), start: startOf(body), days: daysOf(body) };
  const rateError = originationRateError(ctx.role, c.rate);
  if (rateError) throw new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED', rateError);
  if (c.start < await companyToday(client, ctx)) throw new ApiError(400, 'INVALID_CONDITIONS', 'start date before today');
  const cl = await activeClient(client, ctx, reqId(body, 'clientId'), route.id);
  const max = Number((await client.query<{ m: string }>('select max_loan_minor m from adex.routes where company_id = $1 and id = $2', [ctx.companyId, route.id])).rows[0]!.m);
  if (!allowed(ctx, 'route.edit', { routeId: route.id }) && max > 0 && c.amount > max) throw new ApiError(409, 'DIRECT_SALE_LIMIT');
  const active = await activeCredits(client, ctx, cl.id);
  const decision = decideSaleOrigination({ actor: { rol: ctx.role }, canCreateDirect: true, canCreateRequest: allowed(ctx, 'sale.createRequest', { routeId: route.id }),
    activeCredits: active.sales.length + active.approvedRequests.length });
  if (decision.kind !== 'direct') throw new ApiError(409, 'AUTHORIZATION_REQUIRED');
  const out = await disburse(client, opId, null, route.id, cl.id, c, 'Venta directa');
  const location = parseLocation(body['location']);
  if (location) await storeSaleLocation(client, ctx, { kind: 'direct_sale', entityId: out.credit_id, routeId: route.id, clientId: cl.id, location });
  await audit(client, ctx, { action: 'CREATE_DIRECT_SALE', entityType: 'sale', entityId: out.credit_id, routeId: route.id,
    description: `Venta directa ${c.amount} a ${cl.name}`, after: { operationId: out.disbursement_id }, metadata: { operationId: opId } });
  return getCredit(client, ctx, out.credit_id);
}

// ============================================================
// Rectificación de un crédito desembolsado (Ronda 73 · SOC-09 · 0030)
// ============================================================

export const RECTIFY_FIELDS = ['amountMinor', 'interestRate', 'installmentsCount', 'frequency', 'startDate', 'paymentDays',
  'expectedRectifications', 'reason', 'evidence', 'offlineChecked'] as const;

function textOf(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const v = reqText(body, key, max);
  if (v.trim().length < min) throw new ApiError(400, 'INVALID_INPUT', `${key} needs at least ${min} characters`, { field: key });
  return v.trim();
}

/**
 * Decisión del propietario (Ronda 73): el ADMINISTRADOR corrige un crédito desembolsado SIN
 * recaudos, cuyo desembolso no entró en un cuadre ni en un periodo cerrado (capital
 * realmente entregado, interés, parcelas y calendario). Nunca se borra el crédito ni se toca
 * su asiento: la diferencia de capital es una operación nueva (`DISBURSEMENT_ADJUSTMENT`)
 * entre la cuenta que pagó y la cartera, y las cuotas se rehacen con el motor de CLEAN; lo
 * anterior queda completo en `adex.credit_rectifications`. Todo en `adex.credit_rectify`
 * (una transacción, bloqueos ruta → crédito → cuentas, id de operación idempotente).
 * `expectedRectifications` = rectificaciones que vio quien corrige (si otra llegó antes, 409).
 * `offlineChecked`: el servidor no ve capturas aún guardadas en un dispositivo sin conexión;
 * quien rectifica confirma que lo verificó con el trabajador.
 */
export async function rectifyCredit(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  pathId(id);
  const s = (await client.query<SaleRow>('select * from adex.sales where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!s) throw new ApiError(404, 'NOT_FOUND');
  need(ctx, 'sale.cancel', { routeId: s.route_id });
  if (ctx.role !== 'admin') throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only an administrator rectifies a disbursed credit');
  const c: Conditions = { amount: amountOf(body), rate: rateOf(body), count: countOf(body), frequency: frequencyOf(body), start: startOf(body), days: daysOf(body) };
  const expected = body['expectedRectifications'];
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'expectedRectifications is required', { field: 'expectedRectifications' });
  }
  const reason = textOf(body, 'reason', 10, 300);
  const evidence = textOf(body, 'evidence', 10, 500);
  if (body['offlineChecked'] !== true) {
    throw new ApiError(400, 'INVALID_INPUT', 'confirm there are no offline captures pending for this credit', { field: 'offlineChecked' });
  }
  const { schedule } = financials(c);
  const r = (await client.query<{ rectification_id: string; adjustment_id: string | null; delta_minor: string }>(
    'select * from adex.credit_rectify($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    [opId, s.id, expected, c.amount, c.rate, c.count, c.frequency, c.start, c.days, JSON.stringify(schedule), reason, evidence, true])).rows[0]!;
  const before = { amountMinor: Number(s.sale_value_minor), interestRate: Number(s.interest_rate), installmentsCount: s.installments_count,
    frequency: s.payment_frequency, startDate: ymd(s.start_date), paymentDays: s.payment_days ?? [], totalMinor: Number(s.total_value_minor) };
  const after = { amountMinor: c.amount, interestRate: c.rate, installmentsCount: c.count, frequency: c.frequency, startDate: c.start, paymentDays: c.days,
    totalMinor: calculateTotalWithInterest({ valorVenta: c.amount, tasaInteres: c.rate }).valorTotal };
  await audit(client, ctx, { action: 'RECTIFY_CREDIT', entityType: 'sale', entityId: s.id, routeId: s.route_id,
    description: `Rectificación del crédito desembolsado (capital ${before.amountMinor} → ${c.amount})`, before, after, reason,
    metadata: { operationId: opId, rectificationId: r.rectification_id, adjustmentOperationId: r.adjustment_id, deltaMinor: Number(r.delta_minor), evidence } });
  const credit = await getCredit(client, ctx, s.id);
  return { ...credit, rectification: { id: r.rectification_id, adjustmentOperationId: r.adjustment_id, deltaMinor: Number(r.delta_minor) } };
}

/** Historial de rectificaciones del crédito (Administrador y SuperAdmin de la ruta, por RLS). */
export async function listRectifications(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  need(ctx, 'sale.viewActive');
  if (!(await client.query('select 1 from adex.sales where company_id = $1 and id = $2', [ctx.companyId, id])).rowCount) throw new ApiError(404, 'NOT_FOUND');
  const r = await client.query<{ id: string; sequence_no: number; adjustment_operation_id: string | null; delta_minor: string; before_state: Record<string, unknown>;
    after_state: Record<string, unknown>; reason: string; evidence: string; actor_membership_id: string; business_date: string | Date; created_at: Date }>(
    `select id, sequence_no, adjustment_operation_id, delta_minor, before_state, after_state, reason, evidence, actor_membership_id, business_date, created_at
       from adex.credit_rectifications where company_id = $1 and sale_id = $2 order by sequence_no`, [ctx.companyId, id]);
  return r.rows.map((x) => ({ id: x.id, sequence: x.sequence_no, adjustmentOperationId: x.adjustment_operation_id, deltaMinor: Number(x.delta_minor),
    before: x.before_state, after: x.after_state, reason: x.reason, evidence: x.evidence, actorId: x.actor_membership_id,
    businessDate: ymd(x.business_date), at: x.created_at.toISOString() }));
}

// ============================================================
// Consultas (RLS por ruta y rol)
// ============================================================

export async function listRequests(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const status = q.get('status');
  if (status !== null && !['pending', 'approved', 'rejected', 'disbursed', 'cancelled'].includes(status)) throw new ApiError(400, 'INVALID_INPUT');
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  if (status) { params.push(status); where += ` and status = $${params.length}`; }
  if (routeId) { params.push(routeId); where += ` and route_id = $${params.length}`; }
  const r = await client.query<RequestRow>(`select * from adex.sale_requests where ${where} order by requested_at, id limit 500`, params);
  // Nadie resuelve las suyas: la bandeja de un autorizador no las incluye (`listPendingSaleRequestsForRoute`).
  return r.rows.map(requestView);
}

/** Solicitud + contexto de crédito activo AHORA (detalle solo de rutas visibles). */
export async function getRequest(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const row = await loadRequest(client, ctx, id);
  const active = await activeCredits(client, ctx, row.client_id);
  const visible = (await client.query<{ id: string; route_id: string; balance_minor: string; total_value_minor: string; status: string }>(
    'select id, route_id, balance_minor, total_value_minor, status from adex.sales where company_id = $1 and id = any($2)', [ctx.companyId, active.sales])).rows;
  return {
    ...requestView(row),
    activeCreditsNow: {
      count: active.sales.length + active.approvedRequests.filter((x) => x !== row.id).length,
      sales: active.sales.map((sid) => {
        const s = visible.find((v) => v.id === sid);
        return s ? { saleId: sid, routeId: s.route_id, balanceMinor: Number(s.balance_minor), totalMinor: Number(s.total_value_minor), status: s.status, restricted: false }
          : { saleId: sid, restricted: true };
      }),
      approvedRequests: active.approvedRequests.filter((x) => x !== row.id),
    },
  };
}

interface SaleRow {
  id: string; route_id: string; client_id: string; created_by_membership_id: string; sale_value_minor: string; interest_rate: string;
  interest_value_minor: string; total_value_minor: string; balance_minor: string; installments_count: number; installment_value_minor: string;
  payment_frequency: string; payment_days: number[] | null; start_date: string | Date; estimated_end_date: string | Date; status: string;
  disbursement_status: string | null; disbursed_by_collector_id: string | null; disbursed_by_membership_id: string | null;
  disbursement_date: string | Date | null; disbursed_at: Date | null; sale_request_id: string | null; ledger_operation_id: string | null; created_at: Date;
  rectification_count?: number;   // Ronda 73 (0030)
}

function creditView(s: SaleRow) {
  return {
    id: s.id, routeId: s.route_id, clientId: s.client_id, createdBy: s.created_by_membership_id, saleValueMinor: Number(s.sale_value_minor),
    interestRate: Number(s.interest_rate), interestValueMinor: Number(s.interest_value_minor), totalValueMinor: Number(s.total_value_minor),
    balanceMinor: Number(s.balance_minor), installmentsCount: s.installments_count, installmentValueMinor: Number(s.installment_value_minor),
    frequency: s.payment_frequency, paymentDays: s.payment_days ?? [], startDate: ymd(s.start_date), estimatedEndDate: ymd(s.estimated_end_date),
    status: s.status, disbursementStatus: s.disbursement_status, disbursedByCollectorId: s.disbursed_by_collector_id,
    disbursedBy: s.disbursed_by_membership_id, disbursementDate: s.disbursement_date ? ymd(s.disbursement_date) : null,
    disbursedAt: iso(s.disbursed_at), saleRequestId: s.sale_request_id, ledgerOperationId: s.ledger_operation_id, createdAt: s.created_at.toISOString(),
    rectificationCount: s.rectification_count ?? 0,
  };
}

export async function listCredits(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'sale.viewActive');
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  for (const [key, col] of [['routeId', 'route_id'], ['clientId', 'client_id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; }
  }
  where += pageFilters(q, 'start_date', params);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 500) || 500, 1), 1000);
  params.push(limit);
  const r = await client.query<SaleRow>(`select * from adex.sales where ${where} order by ${PAGE_ORDER} limit $${params.length}`, params);
  return r.rows.map(creditView);
}

/**
 * Cuotas en bloque de los créditos visibles (ADEX Online: la proyección de lectura las
 * pide por ruta en una sola consulta, no una por crédito). Exige `routeId` o `saleId`.
 */
export async function listInstallments(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'sale.viewActive');
  const params: unknown[] = [ctx.companyId];
  let where = 's.company_id = $1';
  let scoped = false;
  for (const [key, col] of [['routeId', 's.route_id'], ['saleId', 's.id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; scoped = true; }
  }
  if (!scoped) throw new ApiError(400, 'INVALID_INPUT', 'routeId or saleId is required');
  const status = q.get('creditStatus');
  if (status !== null) {
    if (!['activa', 'finalizada', 'perdida', 'refinanciada'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'creditStatus is invalid');
    params.push(status); where += ` and s.status = $${params.length}`;
  }
  const r = await client.query<{ sale_id: string; number: number; due_date: string | Date; amount_minor: string; paid_minor: string; balance_minor: string; status: string; days_overdue: number }>(
    `select i.sale_id, i.number, i.due_date, i.amount_minor, i.paid_minor, i.balance_minor, i.status, i.days_overdue
       from adex.installments i join adex.sales s on s.company_id = i.company_id and s.id = i.sale_id
      where ${where} order by i.sale_id, i.number limit 50001`, params);
  if (r.rows.length > 50000) throw new ApiError(400, 'INVALID_INPUT', 'too many installments: filter by saleId');
  return r.rows.map((i) => ({ saleId: i.sale_id, number: i.number, dueDate: ymd(i.due_date), amountMinor: Number(i.amount_minor),
    paidMinor: Number(i.paid_minor), balanceMinor: Number(i.balance_minor), status: i.status, daysOverdue: i.days_overdue }));
}

/** Crédito, cuotas, solicitud, asiento (solo las patas visibles) y eventos de auditoría visibles. */
export async function getCredit(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  need(ctx, 'sale.viewActive');
  const s = (await client.query<SaleRow>('select * from adex.sales where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!s) throw new ApiError(404, 'NOT_FOUND');
  const installments = (await client.query<{ number: number; due_date: string | Date; amount_minor: string; paid_minor: string; balance_minor: string; status: string }>(
    'select number, due_date, amount_minor, paid_minor, balance_minor, status from adex.installments where company_id = $1 and sale_id = $2 order by number',
    [ctx.companyId, id])).rows.map((i) => ({ number: i.number, dueDate: ymd(i.due_date), amountMinor: Number(i.amount_minor),
    paidMinor: Number(i.paid_minor), balanceMinor: Number(i.balance_minor), status: i.status }));
  const ledger = s.ledger_operation_id ? (await client.query<{ kind: string; membership_id: string | null; route_id: string | null; amount_minor: string }>(
    `select a.kind, a.membership_id, a.route_id, e.amount_minor from adex.capital_entries e
       join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = $2 order by e.leg`, [ctx.companyId, s.ledger_operation_id])).rows
    .map((e) => ({ account: { kind: e.kind, membershipId: e.membership_id, routeId: e.route_id }, amountMinor: Number(e.amount_minor) })) : [];
  const events = (await client.query<{ action: string; actor_membership_id: string | null; actor_role: string | null; created_at: Date; description: string }>(
    `select action, actor_membership_id, actor_role, created_at, description from adex.audit_log
      where company_id = $1 and ((entity_type = 'sale' and entity_id = $2) or (entity_type = 'sale_request' and entity_id = $3)) order by created_at, id`,
    [ctx.companyId, id, s.sale_request_id ?? ''])).rows.map((e) => ({ action: e.action, actorId: e.actor_membership_id, actorRole: e.actor_role,
    at: e.created_at.toISOString(), description: e.description }));
  return { credit: creditView(s), installments, disbursementEntries: ledger, events };
}
