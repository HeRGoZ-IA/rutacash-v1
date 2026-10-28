// CUADRES Y CIERRES (Fase 6) con el libro central. Reglas de CLEAN reutilizadas sin
// copiar: `can()` (`cashSettlement.*`, `settlement.*`, `cashbox.viewRoute`),
// `routeCashAuthorityError` (`settle` para cuadrar, `correct` para reabrir y cerrar),
// `MIN_CASH_REASON` y `validateDelivered`. La fórmula vive en PostgreSQL (0014), una
// sola vez para la vista previa, el cuadre, el cierre y la conciliación.
//
//   · Entrega parcial: `POST /v1/capital/returns` (Fase 3). No cierra el cuadre.
//   · Cuadre: concilia esperado (P, del libro), entregado y diferencia de UN trabajador
//     en UNA ruta. Solo el efectivo reconocido vuelve a la bolsa del responsable; el
//     faltante queda como arrastre no gastable; el sobrante, en control (F6-D02).
//   · Liquidación: cifras de la ruta y de cada trabajador en un rango, desde el libro.
//   · Cierre de periodo: archiva la liquidación de un periodo TERMINADO (D29) y lo
//     protege (D7). No mueve dinero ni inventa entregas.
// Fechas: las decide el servidor con la zona horaria de la empresa (DS-04).

import type pg from 'pg';
import { MIN_CASH_REASON, validateDelivered } from '@/lib/cashSettlementRules';
import { hasPersonalCashbox } from '@/lib/collectorAttribution';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { optId, optText, pathId, reqId, reqText } from '../structure/input.ts';
import { requireAuthority, requireOperationId, routeOf } from '../capital/service.ts';

type Json = Record<string, unknown>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} must be a date (YYYY-MM-DD)`, { field });
  }
  return v;
}

async function samePerson(client: pg.PoolClient, ctx: ActiveContext, other: string): Promise<boolean> {
  return (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, other])).rows[0]!.s;
}

// ---------- Vistas ----------

interface SettlementRow {
  id: string; route_id: string; worker_membership_id: string; cycle_no: number; version: number; previous_settlement_id: string | null;
  from_seq: string; to_seq: string; closing_seq: string; opening_position_minor: string; opening_carried_minor: string;
  base_received_minor: string; base_returned_minor: string; collected_minor: string; disbursed_minor: string; expenses_minor: string;
  other_minor: string; expected_position_minor: string; expected_cash_minor: string; delivered_minor: string; difference_minor: string;
  shortage_minor: string; surplus_minor: string; returned_to_pool_minor: string; carried_after_minor: string; negative_position_minor: string;
  breakdown: Json; reason: string | null; status: string; superseded_by: string | null; business_date: string | Date; timezone: string;
  closed_at: Date; closed_by_membership_id: string; closed_by_role: string; receiver_admin_membership_id: string;
  return_operation_id: string | null; surplus_operation_id: string | null; reopened_at: Date | null; reopened_by_membership_id: string | null;
  reopen_reason: string | null;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
const n = (v: string | number) => Number(v);

function settlementView(s: SettlementRow) {
  const diff = n(s.difference_minor);
  return {
    id: s.id, routeId: s.route_id, workerId: s.worker_membership_id, cycleNo: s.cycle_no, version: s.version,
    previousSettlementId: s.previous_settlement_id, ledger: { fromSeq: n(s.from_seq), toSeq: n(s.to_seq), closingSeq: n(s.closing_seq) },
    openingPositionMinor: n(s.opening_position_minor), openingCarriedMinor: n(s.opening_carried_minor),
    baseReceivedMinor: n(s.base_received_minor), baseReturnedMinor: n(s.base_returned_minor), collectedMinor: n(s.collected_minor),
    disbursedMinor: n(s.disbursed_minor), expensesMinor: n(s.expenses_minor), otherMinor: n(s.other_minor), breakdown: s.breakdown,
    expectedPositionMinor: n(s.expected_position_minor), expectedCashMinor: n(s.expected_cash_minor), deliveredMinor: n(s.delivered_minor),
    differenceMinor: diff, shortageMinor: n(s.shortage_minor), surplusMinor: n(s.surplus_minor), returnedToPoolMinor: n(s.returned_to_pool_minor),
    carriedAfterMinor: n(s.carried_after_minor), negativePositionMinor: n(s.negative_position_minor),
    result: diff === 0 ? 'exacto' : diff < 0 ? 'faltante' : 'sobrante', reason: s.reason,
    status: s.status, supersededBy: s.superseded_by, businessDate: ymd(s.business_date), timezone: s.timezone,
    closedAt: s.closed_at.toISOString(), closedBy: s.closed_by_membership_id, closedByRole: s.closed_by_role,
    receiverAdminId: s.receiver_admin_membership_id, returnOperationId: s.return_operation_id, surplusOperationId: s.surplus_operation_id,
    reopenedAt: s.reopened_at?.toISOString() ?? null, reopenedBy: s.reopened_by_membership_id, reopenReason: s.reopen_reason,
  };
}

async function loadSettlement(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<SettlementRow> {
  pathId(id);
  // RLS: quien gestiona la ruta o la propia membresía; lo ajeno es indistinguible de lo inexistente.
  const r = await client.query<SettlementRow>('select * from adex.custody_settlements where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

async function visibleEntries(client: pg.PoolClient, ctx: ActiveContext, opIds: (string | null | undefined)[]) {
  const ids = opIds.filter((x): x is string => Boolean(x));
  if (!ids.length) return [];
  const r = await client.query<{ operation_id: string; leg: number; kind: string; membership_id: string | null; route_id: string | null; amount_minor: string; balance_after_minor: string }>(
    `select e.operation_id, e.leg, a.kind, a.membership_id, a.route_id, e.amount_minor, e.balance_after_minor
       from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = any($2) order by e.seq`, [ctx.companyId, ids]);
  return r.rows.map((x) => ({ operationId: x.operation_id, leg: x.leg, account: { kind: x.kind, membershipId: x.membership_id, routeId: x.route_id },
    amountMinor: Number(x.amount_minor), balanceAfterMinor: Number(x.balance_after_minor) }));
}

// ============================================================
// Cuadres
// ============================================================

/**
 * Lo que la persona debería entregar AHORA (`previewCashSettlement`). No persiste nada.
 * Sobre uno mismo exige `cashSettlement.viewOwn` (Mi efectivo); sobre otro, `cashSettlement.view`.
 */
export async function previewSettlement(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  const workerId = q.get('workerId');
  if (!routeId || !workerId) throw new ApiError(400, 'INVALID_INPUT', 'routeId and workerId are required');
  pathId(routeId); pathId(workerId);
  await routeOf(client, ctx, routeId);
  const own = await samePerson(client, ctx, workerId);
  need(ctx, own ? 'cashSettlement.viewOwn' : 'cashSettlement.view', { routeId });
  return (await client.query<{ r: Json }>('select adex.custody_preview($1, $2) r', [routeId, workerId])).rows[0]!.r;
}

/**
 * Trabajadores cuadrables de una ruta (`listSettleableWorkers`): con caja personal y
 * asignados, más quien conserva custodia en ella aunque ya no esté asignado.
 */
export async function settleableWorkers(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (!routeId) throw new ApiError(400, 'INVALID_INPUT', 'routeId is required');
  const route = await routeOf(client, ctx, pathId(routeId));
  need(ctx, 'cashSettlement.view', { routeId: route.id });
  const members = await loadMembers(client, ctx);
  const r = await client.query<{ membership_id: string; balance_minor: string; carried_minor: string }>(
    `select membership_id, balance_minor, carried_minor from adex.capital_accounts where company_id = $1 and kind = 'custody' and route_id = $2`,
    [ctx.companyId, route.id]);
  const positions = new Map(r.rows.map((x) => [x.membership_id, x]));
  const out = [];
  for (const m of members.values()) {
    if (!hasPersonalCashbox(m.role)) continue;
    const pos = positions.get(m.membershipId);
    const assigned = m.routeIds.includes(route.id);
    if (!assigned && !pos) continue;
    const balance = Number(pos?.balance_minor ?? 0);
    const carried = Number(pos?.carried_minor ?? 0);
    out.push({
      workerId: m.membershipId, name: m.displayName, role: m.role, status: m.status, assigned,
      own: await samePerson(client, ctx, m.membershipId),
      positionMinor: balance, carriedMinor: carried, availableMinor: Math.max(0, balance - carried),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.workerId.localeCompare(b.workerId));
  // Consolidado de la ruta: SOLO agrega, no concentra dinero (la ruta no es una caja).
  // Responsable de capital (ADEX Online): la pantalla original decide con él quién cuadra
  // (`canOperateRouteCash`); se da solo su nombre y si HOY es válido (mismo criterio que
  // `requireAuthority`), a quien ya puede ver los cuadres de la ruta.
  const ctrl = route.controller ? members.get(route.controller) : undefined;
  const controllerValid = !!ctrl && ctrl.role === 'admin' && ctrl.status === 'activo' && ctrl.routeIds.includes(route.id);
  return {
    routeId: route.id, routeName: route.name, controllerId: route.controller, controllerName: ctrl?.displayName ?? null, controllerValid, workers: out,
    routeTotalPositionMinor: out.reduce((s, w) => s + w.positionMinor, 0),
    routeTotalAvailableMinor: out.reduce((s, w) => s + w.availableMinor, 0),
  };
}

export const SETTLEMENT_FIELDS = ['routeId', 'workerId', 'deliveredMinor', 'expectedSeenMinor', 'previousSettlementId', 'reason'] as const;

/**
 * CIERRE del cuadre (`closeCashSettlement`). Autoridad `cashSettlement.close` + `settle`
 * (responsable o Supervisor de la ruta; R74: ya no el SuperAdmin); nunca la misma PERSONA que se cuadra.
 * El esperado lo calcula PostgreSQL bajo bloqueo; el visto en pantalla solo detecta
 * cifras obsoletas (se rechaza) y la vista previa de partida (`previousSettlementId`)
 * impide que dos intentos del mismo cuadre creen dos ciclos.
 */
export async function closeSettlement(client: pg.PoolClient, ctx: ActiveContext, body: Json, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  need(ctx, 'cashSettlement.close', { routeId: route.id });
  const members = await loadMembers(client, ctx);
  requireAuthority(ctx, route, 'settle', members);
  const workerId = reqId(body, 'workerId');
  const worker = members.get(workerId);
  if (!worker) throw new ApiError(404, 'NOT_FOUND');
  if (!hasPersonalCashbox(worker.role)) throw new ApiError(400, 'CUSTODIAN_INVALID');
  if (await samePerson(client, ctx, workerId)) throw new ApiError(403, 'SELF_SETTLEMENT_FORBIDDEN');
  const deliveredErr = validateDelivered(body['deliveredMinor']);
  if (deliveredErr || typeof body['deliveredMinor'] !== 'number' || !Number.isSafeInteger(body['deliveredMinor'])) {
    throw new ApiError(400, 'INVALID_INPUT', deliveredErr ?? 'deliveredMinor is invalid', { field: 'deliveredMinor' });
  }
  const delivered = body['deliveredMinor'] as number;
  const seen = body['expectedSeenMinor'];
  if (typeof seen !== 'number' || !Number.isSafeInteger(seen)) throw new ApiError(400, 'INVALID_INPUT', 'expectedSeenMinor is required', { field: 'expectedSeenMinor' });
  const previous = optId(body, 'previousSettlementId');
  const reason = optText(body, 'reason', 300);
  const r = (await client.query<{ r: Json }>('select adex.custody_settle($1, $2, $3, $4, $5, $6, $7) r',
    [opId, route.id, workerId, delivered, seen, previous, reason])).rows[0]!.r;
  const s = await loadSettlement(client, ctx, r['settlementId'] as string);
  const view = settlementView(s);
  await audit(client, ctx, {
    action: 'CASH_SETTLEMENT_CLOSED', entityType: 'cashSettlement', entityId: s.id, routeId: route.id, reason: s.reason,
    description: `Cuadre de ${worker.displayName} en "${route.name}" (v${s.version}): esperado ${view.expectedCashMinor}, entregado ${view.deliveredMinor}, `
      + (view.result === 'exacto' ? 'cuadre exacto' : view.result === 'faltante' ? `FALTANTE ${view.shortageMinor}` : `SOBRANTE ${view.surplusMinor}`)
      + (view.negativePositionMinor < 0 ? ` (posición negativa ${view.negativePositionMinor} sigue en la custodia)` : '') + '.',
    after: { expectedPositionMinor: view.expectedPositionMinor, expectedCashMinor: view.expectedCashMinor, deliveredMinor: view.deliveredMinor,
      differenceMinor: view.differenceMinor, returnedToPoolMinor: view.returnedToPoolMinor, carriedAfterMinor: view.carriedAfterMinor,
      surplusMinor: view.surplusMinor, cycleNo: view.cycleNo, version: view.version, businessDate: view.businessDate },
    metadata: { operationId: opId, worker: workerId, returnOperationId: s.return_operation_id, surplusOperationId: s.surplus_operation_id,
      receiverAdminId: s.receiver_admin_membership_id, ledger: view.ledger },
  });
  return { settlement: view, entries: await visibleEntries(client, ctx, [s.return_operation_id, s.surplus_operation_id]) };
}

/**
 * REAPERTURA (`reopenCashSettlement`): `cashSettlement.reopen` + `correct`, motivo
 * (≥ 10), solo el último cuadre vigente y solo con su periodo abierto (D7). El efectivo
 * devuelto a la bolsa vuelve a la custodia si la bolsa aún lo tiene; el arrastre vuelve
 * al anterior. Volver a cerrar crea una versión nueva del mismo ciclo.
 */
export async function reopenSettlement(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Json, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const s = await loadSettlement(client, ctx, id);
  const route = await routeOf(client, ctx, s.route_id);
  need(ctx, 'cashSettlement.reopen', { routeId: route.id });
  requireAuthority(ctx, route, 'correct', await loadMembers(client, ctx));
  if (await samePerson(client, ctx, s.worker_membership_id)) throw new ApiError(403, 'SELF_SETTLEMENT_FORBIDDEN');
  const reason = reqText(body, 'reason', 300);
  if (reason.length < MIN_CASH_REASON) throw new ApiError(400, 'REASON_REQUIRED', `reason needs at least ${MIN_CASH_REASON} characters`, { field: 'reason' });
  const r = (await client.query<{ r: Json }>('select adex.custody_settlement_reopen($1, $2, $3) r', [opId, s.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'CASH_SETTLEMENT_REOPENED', entityType: 'cashSettlement', entityId: s.id, routeId: route.id, reason,
    description: `Cuadre v${s.version} REABIERTO. El siguiente cierre vuelve a partir del cuadre anterior.`,
    before: { status: 'cerrada' }, after: { status: 'reabierta', returnedToCustodyMinor: r['returnedToCustodyMinor'], carriedMinor: r['carriedMinor'] },
    metadata: { operationId: opId, worker: s.worker_membership_id, reversalOperationId: r['reversalOperationId'], surplusReversalOperationId: r['surplusReversalOperationId'] },
  });
  return { settlement: settlementView(await loadSettlement(client, ctx, s.id)),
    entries: await visibleEntries(client, ctx, [r['reversalOperationId'] as string | null, r['surplusReversalOperationId'] as string | null]) };
}

/** Cuadres visibles (RLS): los de las rutas que gestiona o los propios. */
export async function listSettlements(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  for (const [key, col] of [['routeId', 'route_id'], ['workerId', 'worker_membership_id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; }
  }
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 100) || 100, 1), 500);
  params.push(limit);
  const r = await client.query<SettlementRow>(`select * from adex.custody_settlements where ${where} order by closed_at desc, id limit $${params.length}`, params);
  return r.rows.map(settlementView);
}

export async function getSettlement(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const s = await loadSettlement(client, ctx, id);
  const ops = (await client.query<{ id: string }>('select id from adex.capital_operations where company_id = $1 and settlement_id = $2 order by created_at, id',
    [ctx.companyId, s.id])).rows.map((x) => x.id);
  return { settlement: settlementView(s), entries: await visibleEntries(client, ctx, ops) };
}

// ============================================================
// Periodos: liquidación y cierre
// ============================================================

/** Semana operativa anterior (lunes–domingo) a la fecha contable de la empresa. */
function previousWeek(today: string): { weekStart: string; weekEnd: string } {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;               // 0 = lunes
  const monday = new Date(d.getTime() - (dow + 7) * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { weekStart: monday.toISOString().slice(0, 10), weekEnd: sunday.toISOString().slice(0, 10) };
}

/** Calendario del servidor (DS-04): fecha contable, zona y periodo propuesto. */
export async function periodCalendar(client: pg.PoolClient, ctx: ActiveContext) {
  const r = (await client.query<{ d: string; now: Date }>('select adex.company_today($1)::text d, now() now', [ctx.companyId])).rows[0]!;
  return { businessDate: r.d, timezone: ctx.company.timezone, serverTime: r.now.toISOString(), suggested: previousWeek(r.d) };
}

/** Liquidación de una ruta en un rango (`cashbox.viewRoute`). No mueve dinero. */
export async function liquidation(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (!routeId) throw new ApiError(400, 'INVALID_INPUT', 'routeId is required');
  const route = await routeOf(client, ctx, pathId(routeId));
  need(ctx, 'cashbox.viewRoute', { routeId: route.id });
  const from = dateOf(q.get('from'), 'from');
  const to = dateOf(q.get('to'), 'to');
  const r = (await client.query<{ r: Json }>('select adex.route_liquidation($1, $2::date, $3::date) r', [route.id, from, to])).rows[0]!.r;
  return { ...r, routeName: route.name };
}

export const PERIOD_CLOSE_FIELDS = ['routeId', 'weekStart', 'weekEnd', 'note'] as const;

/**
 * CIERRE de periodo (`closeSettlement`): `settlement.close` + `correct` (responsable de
 * capital; R74: ya no el SuperAdmin). D29 con el reloj del servidor y la zona de la empresa; sin
 * duplicados ni solapes; cifras del libro archivadas e inmutables.
 */
export async function closePeriod(client: pg.PoolClient, ctx: ActiveContext, body: Json, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const route = await routeOf(client, ctx, reqId(body, 'routeId'));
  need(ctx, 'settlement.close', { routeId: route.id });
  requireAuthority(ctx, route, 'correct', await loadMembers(client, ctx));
  const from = dateOf(body['weekStart'], 'weekStart');
  const to = dateOf(body['weekEnd'], 'weekEnd');
  if (to < from) throw new ApiError(400, 'INVALID_INPUT', 'weekEnd cannot be before weekStart', { field: 'weekEnd' });
  const note = optText(body, 'note', 300);
  const r = (await client.query<{ r: Json }>('select adex.period_close($1, $2, $3::date, $4::date, $5) r', [opId, route.id, from, to, note])).rows[0]!.r;
  const fig = r['figures'] as Json;
  const custody = fig['custody'] as Record<string, number>;
  await audit(client, ctx, {
    action: 'SETTLEMENT_CLOSED', entityType: 'weeklySettlement', entityId: r['closureId'] as string, routeId: route.id, reason: note,
    description: `Semana ${from} a ${to} CERRADA en la ruta "${route.name}" (versión ${r['version']}). Custodia final ${custody['closingMinor']}.`,
    after: { weekStart: from, weekEnd: to, version: r['version'], businessDate: r['businessDate'], timezone: r['timezone'], custody },
    metadata: { operationId: opId, operations: fig['operations'] },
  });
  return r;
}

interface ClosureRow {
  id: string; route_id: string; week_start: string | Date; week_end: string | Date; status: string | null; version: number | null;
  closed_at: Date | null; closed_by_membership_id: string | null; superseded_by: string | null; opening_balance_minor: string;
  closing_balance_minor: string; figures: Json | null; business_date: string | Date | null; timezone: string | null; note: string | null;
  ledger_operations: number | null; ledger_hash: string | null;
  reopened_at: Date | null; reopened_by_membership_id: string | null; reopen_reason: string | null;
}

function closureView(c: ClosureRow) {
  return {
    id: c.id, routeId: c.route_id, weekStart: ymd(c.week_start), weekEnd: ymd(c.week_end), status: c.status ?? 'cerrada', version: c.version ?? 1,
    closedAt: c.closed_at?.toISOString() ?? null, closedBy: c.closed_by_membership_id, supersededBy: c.superseded_by,
    openingMinor: Number(c.opening_balance_minor), closingMinor: Number(c.closing_balance_minor),
    // Cierre del servidor (Fase 6): archivo con las cifras del libro. Legado importado: sin archivo.
    archived: c.figures !== null, businessDate: c.business_date ? ymd(c.business_date) : null, timezone: c.timezone, note: c.note,
    ledgerOperations: c.ledger_operations, ledgerHash: c.ledger_hash, figures: c.figures,
    reopenedAt: c.reopened_at?.toISOString() ?? null, reopenedBy: c.reopened_by_membership_id, reopenReason: c.reopen_reason,
  };
}

const CLOSURE_SQL = `select w.id, w.route_id, w.week_start, w.week_end, w.status, w.version, w.closed_at, w.closed_by_membership_id, w.superseded_by,
                            w.opening_balance_minor, w.closing_balance_minor, p.figures, p.business_date, p.timezone, p.note, p.ledger_operations, p.ledger_hash,
                            w.reopened_at, w.reopened_by_membership_id, w.reopen_reason
                       from adex.weekly_settlements w left join adex.period_closures p on p.company_id = w.company_id and p.id = w.id`;

/** Cierres visibles (RLS de `weekly_settlements`: `cashbox.viewRoute` sobre la ruta). */
export async function listClosures(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  if (!allowed(ctx, 'cashbox.viewRoute')) throw new ApiError(403, 'PERMISSION_DENIED');
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const r = await client.query<ClosureRow>(`${CLOSURE_SQL} where w.company_id = $1 ${routeId ? 'and w.route_id = $2' : ''}
                                             order by w.week_start desc, coalesce(w.version, 1) desc limit 200`,
    routeId ? [ctx.companyId, routeId] : [ctx.companyId]);
  return r.rows.map((c) => ({ ...closureView(c), figures: undefined }));
}

/**
 * 3.18 (socio): fechas de los cierres de ruta VIGENTES de las rutas del alcance, sin cifras. Lo usa la pantalla
 * de Gastos del Cobrador y del Supervisor para separar los gastos ya incluidos en un cierre. Cualquier membresía
 * activa (también el Cobrador, que no ve los documentos de cierre): `ctx_closed_weeks` (0020) aplica el alcance.
 */
export async function listClosedRanges(client: pg.PoolClient, _ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const r = await client.query<{ route_id: string; f: string; t: string }>(
    `select route_id, week_start::text f, week_end::text t from adex.ctx_closed_weeks() ${routeId ? 'where route_id = $1' : ''}
      order by week_end desc, route_id limit 500`, routeId ? [routeId] : []);
  return r.rows.map((x) => ({ routeId: x.route_id, from: x.f, to: x.t }));
}

export async function getClosure(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  if (!allowed(ctx, 'cashbox.viewRoute')) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<ClosureRow>(`${CLOSURE_SQL} where w.company_id = $1 and w.id = $2`, [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return closureView(r.rows[0]);
}

/**
 * REAPERTURA de un periodo cerrado (`reopenSettlement` de CLEAN, 0016): `settlement.reopen`
 * + autoridad `correct` (responsable de capital; R74: ya no el SuperAdmin), motivo ≥ 10. No borra ni
 * recalcula: el documento queda 'reabierta' y sus fechas vuelven a ser corregibles hasta el
 * siguiente cierre, que crea una versión nueva. El archivo de cifras no cambia.
 */
export async function reopenPeriod(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Json, operationId: string | null) {
  const opId = requireOperationId(operationId);
  pathId(id);
  const reason = reqText(body, 'reason', 300);
  const r = (await client.query<{ r: Json }>('select adex.period_reopen($1, $2, $3) r', [opId, id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'SETTLEMENT_REOPENED', entityType: 'weeklySettlement', entityId: id, routeId: r['routeId'] as string, reason,
    description: `Semana ${r['weekStart']} a ${r['weekEnd']} REABIERTA (versión ${r['version']}). Los pagos de esas fechas vuelven a ser corregibles.`,
    before: { status: 'cerrada' }, after: { status: 'reabierta' }, metadata: { operationId: opId },
  });
  const row = (await client.query<ClosureRow>(`${CLOSURE_SQL} where w.company_id = $1 and w.id = $2`, [ctx.companyId, id])).rows[0]!;
  return { closure: closureView(row) };
}
