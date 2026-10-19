// VISITAS SIN PAGO (ADEX Online · pantalla original «No pagó» de CLEAN, `NoPaymentPage`).
//
// No mueven dinero: dejan constancia de que el cliente fue visitado y no pagó, con el
// motivo y, si lo hay, la fecha prometida. Las registra quien visita (`payment.register`
// en la ruta); la fecha es la de la empresa. Segunda barrera: RLS y el disparador
// `no_payment_visit_guard` (0015): venta activa y desembolsada de esa ruta y ese cliente.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from '../structure/common.ts';
import { optText, pathId, reqId } from '../structure/input.ts';
import { routeOf } from '../capital/service.ts';

export const VISIT_REASONS = ['no_estaba', 'sin_dinero', 'negocio_cerrado', 'promesa_pago', 'otro'] as const;
export const VISIT_FIELDS = ['saleId', 'reason', 'promisedPaymentDate', 'note'] as const;

interface VisitRow {
  id: string; sale_id: string; client_id: string; route_id: string; collector_membership_id: string; reason: string;
  promised_payment_date: string | Date | null; note: string | null; visit_date: string | Date; created_at: Date;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

function visitView(v: VisitRow) {
  return {
    id: v.id, saleId: v.sale_id, clientId: v.client_id, routeId: v.route_id, collectorId: v.collector_membership_id, reason: v.reason,
    promisedPaymentDate: v.promised_payment_date ? ymd(v.promised_payment_date) : null, note: v.note, visitDate: ymd(v.visit_date),
    createdAt: v.created_at.toISOString(),
  };
}

export async function registerVisit(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  const saleId = reqId(body, 'saleId');
  const sale = (await client.query<{ route_id: string; client_id: string }>('select route_id, client_id from adex.sales where company_id = $1 and id = $2',
    [ctx.companyId, saleId])).rows[0];
  if (!sale) throw new ApiError(404, 'NOT_FOUND');
  const route = await routeOf(client, ctx, sale.route_id);
  need(ctx, 'payment.register', { routeId: route.id });
  const reason = body['reason'];
  if (typeof reason !== 'string' || !(VISIT_REASONS as readonly string[]).includes(reason)) {
    throw new ApiError(400, 'INVALID_INPUT', 'reason is invalid', { field: 'reason' });
  }
  const promised = optText(body, 'promisedPaymentDate', 10);
  if (promised !== null && !/^\d{4}-\d{2}-\d{2}$/.test(promised)) throw new ApiError(400, 'INVALID_INPUT', 'promisedPaymentDate is invalid', { field: 'promisedPaymentDate' });
  const note = optText(body, 'note', 500);
  const id = randomUUID();
  await client.query(
    `insert into adex.no_payment_visits (id, company_id, sale_id, client_id, route_id, collector_membership_id, reason, promised_payment_date, note,
                                         visit_date, sync_status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, adex.company_today($10), 'synced', now())`,
    [id, ctx.companyId, saleId, sale.client_id, route.id, ctx.membershipId, reason, promised, note, ctx.companyId]);
  const row = (await client.query<VisitRow>('select * from adex.no_payment_visits where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0]!;
  await audit(client, ctx, { action: 'REGISTER_NO_PAYMENT_VISIT', entityType: 'NoPaymentVisit', entityId: id, routeId: route.id,
    description: `Visita sin pago (${reason})`, after: { saleId, reason, promisedPaymentDate: promised } });
  return visitView(row);
}

/** Visitas visibles (RLS por ruta). Filtros: routeId, saleId, collectorId, date. */
export async function listVisits(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'payment.viewHistory');
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  for (const [key, col] of [['saleId', 'sale_id'], ['routeId', 'route_id'], ['collectorId', 'collector_membership_id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; }
  }
  for (const [key, op] of [['date', '='], ['from', '>='], ['to', '<=']] as const) {
    const v = q.get(key);
    if (v === null) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`);
    params.push(v); where += ` and visit_date ${op} $${params.length}`;
  }
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 1000);
  params.push(limit);
  const r = await client.query<VisitRow>(`select * from adex.no_payment_visits where ${where} order by created_at desc, id limit $${params.length}`, params);
  return r.rows.map(visitView);
}
