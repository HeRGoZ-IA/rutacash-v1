// RECAUDOS (Fase 5): cobro de cuotas de créditos desembolsados, con el motor de capital
// y custodia de las Fases 3–4. SOLO EN LÍNEA: el servidor confirma antes de informar; un
// reintento con el mismo `X-Adex-Operation-Id` devuelve el resultado guardado y nunca
// cobra dos veces.
//
// Reglas de CLEAN (`paymentService.registerPayment`, `annulPayment`) reutilizadas sin
// copiar: `can()` (`payment.register`, `payment.reverse`, `payment.approveAdjustment`),
// `resolveResponsibleCollector` (quién responde por el efectivo) y `hasPersonalCashbox`.
// La cascada por cuota, el tope al saldo, el reparto capital/interés, la custodia y el
// periodo los decide `adex.collection_post` (0013) bajo bloqueo: segunda barrera.
//
// Métodos de pago: solo EFECTIVO. CLEAN tiene los tipos `transferencia` y `otro` en el
// modelo, pero ninguna pantalla los crea y el libro SaaS no tiene cuenta bancaria donde
// contabilizarlos: no se habilitan (no se inventa contrapartida).

import type pg from 'pg';
import { hasPersonalCashbox, resolveResponsibleCollector } from '@/lib/collectorAttribution';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { toCleanUser } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { optId, optText, PAGE_ORDER, pageFilters, pathId, reqId, reqText } from '../structure/input.ts';
import { requireOperationId, routeOf } from '../capital/service.ts';
import { parseLocation, storePaymentLocation } from './location.ts';
import { assertOfflineFits, parseOffline, requireOfflineActor, requireRouteNotHeldByCollector, storeOfflineCapture } from '../offline/capture.ts';

interface PaymentRow {
  id: string; sale_id: string; client_id: string; route_id: string; collector_membership_id: string; created_by_membership_id: string | null;
  amount_minor: string; payment_date: string | Date; payment_type: string; note: string | null; created_at: Date; state: string | null;
  reverses_payment_id: string | null; reversal_payment_id: string | null; correction_reason: string | null; corrected_by_membership_id: string | null;
  corrected_at: Date | null; ledger_operation_id: string | null; principal_minor: string | null; interest_minor: string | null;
  corrected_by_payment_id?: string | null; correction_of_payment_id?: string | null; period_closed?: boolean;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
const num = (v: string | null) => (v === null ? null : Number(v));

const PERIOD_CLOSED = 'coalesce(adex.payment_in_closed_period(id), false) period_closed';
// En listados, la MISMA regla una vez por consulta: semanas cerradas de las rutas del alcance
// (`ctx_closed_weeks`, 0020) en vez de una llamada a la función por cobro.
const CLOSED_WEEKS = 'with closed as materialized (select * from adex.ctx_closed_weeks())';
const PERIOD_CLOSED_LIST = `exists (select 1 from closed w where w.route_id = p.route_id::text
  and p.payment_date between w.week_start and w.week_end) period_closed`;

function paymentView(p: PaymentRow) {
  return {
    id: p.id, saleId: p.sale_id, clientId: p.client_id, routeId: p.route_id, collectorId: p.collector_membership_id,
    createdBy: p.created_by_membership_id ?? p.collector_membership_id, amountMinor: Number(p.amount_minor), paymentDate: ymd(p.payment_date),
    paymentType: p.payment_type, note: p.note, createdAt: p.created_at.toISOString(), state: p.state ?? 'active',
    reversesPaymentId: p.reverses_payment_id, reversalPaymentId: p.reversal_payment_id, correctionReason: p.correction_reason,
    correctedBy: p.corrected_by_membership_id, correctedAt: p.corrected_at?.toISOString() ?? null, ledgerOperationId: p.ledger_operation_id,
    principalMinor: num(p.principal_minor), interestMinor: num(p.interest_minor),
    correctedByPaymentId: p.corrected_by_payment_id ?? null, correctionOfPaymentId: p.correction_of_payment_id ?? null,
    // ¿Su fecha cae en una semana CERRADA de la ruta? (decide corrección directa o solicitud de ajuste, D7).
    periodClosed: p.period_closed === true,
  };
}

function amountOf(body: Record<string, unknown>): number {
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  return v;
}

/** Crédito y cuotas tal como quedaron (lectura con RLS en la misma transacción). */
async function creditState(client: pg.PoolClient, ctx: ActiveContext, saleId: string) {
  const s = (await client.query<{ id: string; route_id: string; client_id: string; status: string; balance_minor: string; total_value_minor: string; finished_on: string | Date | null }>(
    'select id, route_id, client_id, status, balance_minor, total_value_minor, finished_on from adex.sales where company_id = $1 and id = $2', [ctx.companyId, saleId])).rows[0];
  if (!s) throw new ApiError(404, 'NOT_FOUND');
  const installments = (await client.query<{ number: number; due_date: string | Date; amount_minor: string; paid_minor: string; balance_minor: string; status: string; days_overdue: number }>(
    'select number, due_date, amount_minor, paid_minor, balance_minor, status, days_overdue from adex.installments where company_id = $1 and sale_id = $2 order by number',
    [ctx.companyId, saleId])).rows.map((i) => ({ number: i.number, dueDate: ymd(i.due_date), amountMinor: Number(i.amount_minor), paidMinor: Number(i.paid_minor),
    balanceMinor: Number(i.balance_minor), status: i.status, daysOverdue: i.days_overdue }));
  return {
    credit: { id: s.id, routeId: s.route_id, clientId: s.client_id, status: s.status, balanceMinor: Number(s.balance_minor),
      totalValueMinor: Number(s.total_value_minor), finishedOn: s.finished_on ? ymd(s.finished_on) : null },
    installments,
  };
}

/** Patas visibles para el actor (RLS: el Cobrador solo ve su custodia). */
async function visibleEntries(client: pg.PoolClient, ctx: ActiveContext, opId: string) {
  const r = await client.query<{ kind: string; membership_id: string | null; route_id: string | null; amount_minor: string; balance_after_minor: string }>(
    `select a.kind, a.membership_id, a.route_id, e.amount_minor, e.balance_after_minor
       from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = $2 order by e.leg`, [ctx.companyId, opId]);
  return r.rows.map((x) => ({ account: { kind: x.kind, membershipId: x.membership_id, routeId: x.route_id },
    amountMinor: Number(x.amount_minor), balanceAfterMinor: Number(x.balance_after_minor) }));
}

async function loadPayment(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<PaymentRow> {
  pathId(id);
  const r = await client.query<PaymentRow>(`select *, ${PERIOD_CLOSED} from adex.payments where company_id = $1 and id = $2`, [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

/**
 * `location` (Ronda 48, 0022): lectura del dispositivo con su estado; ver collections/location.ts.
 * `offline` (Ronda 62, 0026): abono capturado sin conexión por el Cobrador; ver offline/capture.ts.
 */
export const COLLECTION_FIELDS = ['saleId', 'amountMinor', 'collectorId', 'note', 'location', 'offline'] as const;

/**
 * Registro de un abono (`registerPayment`). El importe pedido puede superar el saldo: se
 * aplica el saldo (CLEAN, RC-BUG-001) y la respuesta lo indica (`capped`).
 */
export async function registerCollection(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const saleId = reqId(body, 'saleId');
  const sale = (await client.query<{ route_id: string }>('select route_id from adex.sales where company_id = $1 and id = $2', [ctx.companyId, saleId])).rows[0];
  if (!sale) throw new ApiError(404, 'NOT_FOUND');
  const route = await routeOf(client, ctx, sale.route_id);
  need(ctx, 'payment.register', { routeId: route.id });
  // Ronda 62: con un Cobrador activo en la ruta, solo él cobra a sus clientes.
  await requireRouteNotHeldByCollector(client, ctx, route.id);
  const amount = amountOf(body);
  const note = optText(body, 'note', 500);
  // Ronda 62: capturado sin conexión → solo Cobrador, y debe caber en el saldo vigente (sin tope).
  const offline = parseOffline(body['offline']);
  if (offline) requireOfflineActor(ctx);
  // Ubicación (Ronda 48): se normaliza ANTES del comando, pero nunca lo condiciona: una
  // lectura malformada queda como `invalid` y el abono sigue su curso. Sin conexión, la lectura
  // se tomó al capturar: su hora se compara con la de la captura, no con la de llegada.
  const location = parseLocation(body['location'], offline?.deviceCapturedAt ? new Date(offline.deviceCapturedAt) : new Date());
  // Quién responde por el dinero, con la regla de CLEAN y las personas REALES de la ruta.
  const members = await loadMembers(client, ctx);
  const routeCollectors = [...members.values()].filter((m) => hasPersonalCashbox(m.role) && m.routeIds.includes(route.id)).map(toCleanUser);
  const who = resolveResponsibleCollector({ actor: toCleanUser(ctx), requested: optId(body, 'collectorId') ?? undefined, routeCollectors });
  if (!who.ok) throw new ApiError(400, who.code === 'ambiguous' ? 'COLLECTOR_REQUIRED' : 'COLLECTOR_INVALID', who.message);
  const balanceAtSync = offline ? await assertOfflineFits(client, saleId, amount) : null;

  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.collection_post($1, $2, $3, $4, $5) r',
    [opId, saleId, amount, who.collectorId, note])).rows[0]!.r;
  const outcome = {
    paymentId: r['paymentId'] as string, operationId: r['operationId'] as string, collectorId: who.collectorId, collectorSource: who.source,
    receiver: r['receiver'] as string, requestedMinor: Number(r['requestedMinor']), appliedMinor: Number(r['appliedMinor']),
    capped: r['capped'] === true, cappedMinor: Number(r['requestedMinor']) - Number(r['appliedMinor']),
    previousBalanceMinor: Number(r['previousBalanceMinor']), newBalanceMinor: Number(r['newBalanceMinor']),
    paymentDate: r['paymentDate'] as string,
  };
  // Misma transacción del abono, bajo savepoint: un fallo aquí no revierte el pago.
  const locationStatus = location
    ? await storePaymentLocation(client, ctx, { paymentId: outcome.paymentId, routeId: route.id, location })
    : null;
  const offlineStatus = offline
    ? await storeOfflineCapture(client, ctx, { operationId: opId, kind: 'payment', entityId: outcome.paymentId, routeId: route.id, capture: offline })
    : null;
  const state = await creditState(client, ctx, saleId);
  await audit(client, ctx, {
    action: 'REGISTER_PAYMENT', entityType: 'Payment', entityId: outcome.paymentId, routeId: route.id,
    description: outcome.capped
      ? `Pago registrado por ${outcome.appliedMinor} (solicitado ${outcome.requestedMinor}; limitado al saldo pendiente)`
      : `Pago registrado por ${outcome.appliedMinor}`,
    before: { saldo: outcome.previousBalanceMinor, status: 'activa' }, after: { saldo: outcome.newBalanceMinor, status: state.credit.status },
    metadata: { operationId: opId, saleId, collectorId: outcome.collectorId, createdBy: ctx.membershipId, collectorSource: outcome.collectorSource,
      receiver: outcome.receiver, requestedAmount: outcome.requestedMinor, appliedAmount: outcome.appliedMinor, capped: outcome.capped,
      principalMinor: Number(r['principalMinor']), interestMinor: Number(r['interestMinor']),
      // Solo el ESTADO de ubicación: las coordenadas no se copian a la auditoría.
      locationStatus,
      ...(offline ? { offline: { deviceCapturedAt: offline.deviceCapturedAt, knownBalanceMinor: offline.knownBalanceMinor, balanceAtSync, stored: offlineStatus } } : {}) },
  });
  return { ...outcome, payment: paymentView(await loadPayment(client, ctx, outcome.paymentId)), ...state,
    entries: await visibleEntries(client, ctx, outcome.operationId),
    location: locationStatus ? { status: locationStatus } : null,
    offline: offline ? { deviceCapturedAt: offline.deviceCapturedAt } : null };
}

/**
 * Anulación administrativa de un abono (`annulPayment`): asiento espejo, original
 * marcado, recálculo canónico del crédito. Solo si quien recibió el dinero aún lo tiene.
 * Semana cerrada: la anulación va a hoy y exige poder aprobar ajustes (D7, 6C.1).
 */
export async function reverseCollection(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const prev = await loadPayment(client, ctx, id);
  need(ctx, 'payment.reverse', { routeId: prev.route_id });
  await routeOf(client, ctx, prev.route_id);
  const reason = reqText(body, 'reason', 300);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.collection_reverse($1, $2, $3) r', [opId, prev.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ANNUL_PAYMENT', entityType: 'Payment', entityId: prev.id, routeId: prev.route_id, reason,
    description: `Pago anulado (${Number(prev.amount_minor)}): ${reason}`,
    before: { valor: Number(prev.amount_minor), fecha: ymd(prev.payment_date), estado: 'vigente' },
    after: { estado: 'anulado', reversalId: r['reversalPaymentId'], fecha: r['reversalDate'] },
    metadata: { operationId: opId, saleId: prev.sale_id, collectorId: prev.collector_membership_id, periodClosed: r['periodClosed'] },
  });
  return {
    reversal: paymentView(await loadPayment(client, ctx, r['reversalPaymentId'] as string)),
    original: paymentView(await loadPayment(client, ctx, prev.id)),
    ...(await creditState(client, ctx, prev.sale_id)),
    entries: await visibleEntries(client, ctx, r['operationId'] as string),
  };
}

/** Historial de abonos visible (`payment.viewHistory`, por ruta con RLS). */
export async function listCollections(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'payment.viewHistory');
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  for (const [key, col] of [['saleId', 'sale_id'], ['routeId', 'route_id'], ['collectorId', 'collector_membership_id'], ['clientId', 'client_id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; }
  }
  const date = q.get('date');
  if (date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'INVALID_INPUT', 'date is invalid');
    params.push(date); where += ` and payment_date = $${params.length}`;
  }
  where += pageFilters(q, 'payment_date', params);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 1000);
  params.push(limit);
  const r = await client.query<PaymentRow>(`${CLOSED_WEEKS} select p.*, ${PERIOD_CLOSED_LIST} from adex.payments p
    where ${where} order by ${PAGE_ORDER} limit $${params.length}`, params);
  return r.rows.map(paymentView);
}

export async function getCollection(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  need(ctx, 'payment.viewHistory');
  const p = await loadPayment(client, ctx, id);
  return { payment: paymentView(p), entries: p.ledger_operation_id ? await visibleEntries(client, ctx, p.ledger_operation_id) : [] };
}
