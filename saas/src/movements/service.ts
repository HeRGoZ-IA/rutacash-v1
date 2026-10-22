// CONSULTAS · MOVIMIENTOS Y EVENTOS (Ronda 73 · SOC-08): una fila por OPERACIÓN LÓGICA.
//
//   · Dinero: una fila por `capital_operations` (la entrega de la bolsa al trabajador es UNA
//     operación con dos patas; las patas no son filas). El detalle (`GET /v1/capital/operations/:id`)
//     muestra origen, destino y efectos contables. Nunca se agrupa por importe, fecha ni texto.
//   · Sin dinero: solicitudes de venta, su autorización o rechazo, cuadres, cierres de periodo y
//     rectificaciones sin diferencia de capital (0030), marcados `money = false`.
//
// Todo se lee como `adex_api`: cada rama respeta la política RLS de su tabla (empresa, rol y rutas
// del contexto). Filtros y orden en el servidor, con página acotada (máx. 200 filas) y `hasMore`:
// nunca se carga todo el historial en memoria. Solo lectura.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { need } from '../structure/common.ts';
import { pathId } from '../structure/input.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 200;
const MAX_OFFSET = 20_000;
const SORTS: Record<string, string> = {
  date_desc: 'at desc, id desc', date_asc: 'at asc, id asc', amount_desc: 'amount_minor desc nulls last, at desc, id desc',
  amount_asc: 'amount_minor asc nulls last, at desc, id desc',
};
/** Tipos de evento sin dinero (los de dinero son los `kind` de `capital_operations`). */
export const EVENT_KINDS = ['SALE_REQUEST', 'SALE_APPROVAL', 'SALE_REJECTION', 'SALE_CANCELLATION', 'CUSTODY_SETTLEMENT', 'PERIOD_CLOSURE', 'CREDIT_RECTIFICATION'] as const;

let rectificationsTable: boolean | null = null;

/** Rectificaciones (0030) solo si la tabla existe: la API no depende del orden de despliegue. */
async function hasRectifications(client: pg.PoolClient): Promise<boolean> {
  rectificationsTable ??= (await client.query<{ r: string | null }>(`select to_regclass('adex.credit_rectifications')::text r`)).rows[0]!.r !== null;
  return rectificationsTable;
}

function feedSql(withRectifications: boolean): string {
  // Columnas comunes: id, money, kind, reverses_kind, at, entry_date, route_id, to_route_id, worker_id, counterpart_id,
  // admin_id, client_id, amount_minor, concept, status, reference, actor_id, sale_id, payment_id, expense_id, settlement_id.
  const tz = `(select c.timezone from adex.companies c where c.id = $1)`;
  return `
    select o.id, true as money, o.kind, o.reverses_kind, o.created_at as at, o.entry_date, o.route_id, o.to_route_id,
           o.worker_membership_id as worker_id, o.counterpart_membership_id as counterpart_id, o.admin_membership_id as admin_id,
           coalesce(s.client_id, p.client_id) as client_id, o.amount_minor, o.reason as concept,
           case when o.kind = 'REVERSAL' then 'anulacion'
                when exists (select 1 from adex.capital_operations x where x.company_id = o.company_id and x.reverses_operation_id = o.id) then 'anulada'
                else 'aplicada' end as status,
           o.operation_id::text as reference, o.actor_membership_id as actor_id, o.sale_id, o.payment_id, o.expense_id, o.settlement_id
      from adex.capital_operations o
      left join adex.sales s on s.company_id = o.company_id and s.id = o.sale_id
      left join adex.payments p on p.company_id = o.company_id and p.id = o.payment_id
     where o.company_id = $1
    union all
    select 'req:' || r.id, false, 'SALE_REQUEST', null, r.requested_at, (r.requested_at at time zone ${tz})::date, r.route_id, null,
           coalesce(r.requested_by_membership_id, r.collector_membership_id), null, null, r.client_id, r.amount_minor,
           'Solicitud de venta al ' || coalesce(r.requested_interest_rate, r.interest_rate)::int || ' % en '
             || ${withRectifications ? 'coalesce(r.requested_installments_count, r.installments_count)' : 'r.installments_count'} || ' parcelas',
           r.status, r.id, coalesce(r.requested_by_membership_id, r.collector_membership_id), r.sale_id, null, null, null
      from adex.sale_requests r where r.company_id = $1
    union all
    select 'rev:' || r.id, false, case r.status when 'rejected' then 'SALE_REJECTION' else 'SALE_APPROVAL' end, null, r.reviewed_at,
           (r.reviewed_at at time zone ${tz})::date, r.route_id, null, coalesce(r.requested_by_membership_id, r.collector_membership_id), null, null,
           r.client_id, r.amount_minor,
           case r.status when 'rejected' then 'Rechazada: ' || coalesce(r.rejection_reason, '')
                else 'Aprobada al ' || r.interest_rate::int || ' % en ' || r.installments_count || ' parcelas' end,
           r.status, r.id, r.reviewed_by_membership_id, r.sale_id, null, null, null
      from adex.sale_requests r where r.company_id = $1 and r.reviewed_at is not null
    union all
    select 'can:' || r.id, false, 'SALE_CANCELLATION', null, r.cancelled_at, (r.cancelled_at at time zone ${tz})::date, r.route_id, null,
           coalesce(r.requested_by_membership_id, r.collector_membership_id), null, null, r.client_id, r.amount_minor,
           'Cancelada sin desembolso: ' || coalesce(r.cancel_reason, ''), r.status, r.id, r.cancelled_by_membership_id, null, null, null, null
      from adex.sale_requests r where r.company_id = $1 and r.cancelled_at is not null
    union all
    select 'set:' || cs.id, false, 'CUSTODY_SETTLEMENT', null, cs.closed_at, cs.business_date, cs.route_id, null, cs.worker_membership_id, null,
           cs.receiver_admin_membership_id, null, cs.delivered_minor,
           'Cuadre ciclo ' || cs.cycle_no || ' v' || cs.version || coalesce(' · ' || cs.reason, ''), cs.status, cs.operation_id::text,
           cs.closed_by_membership_id, null, null, null, cs.id
      from adex.custody_settlements cs where cs.company_id = $1
    union all
    select 'per:' || pc.id, false, 'PERIOD_CLOSURE', null, pc.closed_at, pc.business_date, pc.route_id, null, null, null, null, null, null,
           'Cierre de periodo ' || pc.week_start || ' a ' || pc.week_end || ' v' || pc.version || coalesce(' · ' || pc.note, ''), 'cerrado',
           pc.operation_id::text, pc.closed_by_membership_id, null, null, null, null
      from adex.period_closures pc where pc.company_id = $1
    ${withRectifications ? `union all
    select 'rec:' || cr.id, false, 'CREDIT_RECTIFICATION', null, cr.created_at, cr.business_date, cr.route_id, null, null, null, null,
           s2.client_id, cr.delta_minor, 'Rectificación #' || cr.sequence_no || ': ' || cr.reason, 'aplicada', cr.operation_id::text,
           cr.actor_membership_id, cr.sale_id, null, null, null
      from adex.credit_rectifications cr join adex.sales s2 on s2.company_id = cr.company_id and s2.id = cr.sale_id
     where cr.company_id = $1 and cr.adjustment_operation_id is null` : ''}`;
}

function list(q: URLSearchParams, key: string, re?: RegExp): string[] {
  const v = q.getAll(key).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  if (v.length > 50) throw new ApiError(400, 'INVALID_INPUT', `${key}: too many values`);
  for (const x of v) {
    if (re) { if (!re.test(x)) throw new ApiError(400, 'INVALID_INPUT', `${key} is invalid`); } else pathId(x);
  }
  return v;
}

/**
 * `GET /v1/movements` — filtros (todos opcionales, combinables): `from`/`to` (fecha contable),
 * `routeId`, `kind`, `workerId`, `adminId`, `clientId`, `actorId` (repetibles o separados por comas), `money`
 * (`yes`|`no`), `status`, `q` (concepto o referencia), `minAmount`/`maxAmount` (unidades menores),
 * `sort` (`date_desc` por defecto, `date_asc`, `amount_desc`, `amount_asc`), `limit` (≤ 200), `offset`.
 */
export async function listMovements(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'cashbox.viewRoute');
  const params: unknown[] = [ctx.companyId];
  const where: string[] = [];
  const add = (sql: (p: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  for (const k of ['from', 'to'] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`, { field: k });
    add((p) => (k === 'from' ? `entry_date >= ${p}::date` : `entry_date <= ${p}::date`), v);
  }
  const routes = list(q, 'routeId');
  if (routes.length) add((p) => `(route_id = any(${p}::text[]) or to_route_id = any(${p}::text[]))`, routes);
  const kinds = list(q, 'kind', /^[A-Z_]{3,40}$/);
  if (kinds.length) add((p) => `(kind = any(${p}::text[]) or (kind = 'REVERSAL' and reverses_kind = any(${p}::text[])))`, kinds);
  const workers = list(q, 'workerId');
  if (workers.length) add((p) => `(worker_id = any(${p}::text[]) or counterpart_id = any(${p}::text[]))`, workers);
  const admins = list(q, 'adminId');
  if (admins.length) add((p) => `(admin_id = any(${p}::text[]) or counterpart_id = any(${p}::text[]))`, admins);
  const clients = list(q, 'clientId');
  if (clients.length) add((p) => `client_id = any(${p}::text[])`, clients);
  const actors = list(q, 'actorId');
  if (actors.length) add((p) => `actor_id = any(${p}::text[])`, actors);
  const statuses = list(q, 'status', /^[a-z_]{3,20}$/);
  if (statuses.length) add((p) => `status = any(${p}::text[])`, statuses);
  const money = q.get('money');
  if (money !== null) {
    if (money !== 'yes' && money !== 'no') throw new ApiError(400, 'INVALID_INPUT', 'money is invalid', { field: 'money' });
    where.push(money === 'yes' ? 'money' : 'not money');
  }
  for (const [k, op] of [['minAmount', '>='], ['maxAmount', '<=']] as const) {
    const v = q.get(k);
    if (v === null) continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`, { field: k });
    add((p) => `abs(amount_minor) ${op} ${p}::bigint`, n);
  }
  const text = q.get('q')?.trim();
  if (text) {
    if (text.length > 100) throw new ApiError(400, 'INVALID_INPUT', 'q is too long', { field: 'q' });
    add((p) => `(concept ilike ${p} or reference ilike ${p} or id ilike ${p})`, `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const sort = SORTS[q.get('sort') ?? 'date_desc'];
  if (!sort) throw new ApiError(400, 'INVALID_INPUT', 'sort is invalid', { field: 'sort' });
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 100) || 100, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
  if (offset > MAX_OFFSET) throw new ApiError(400, 'INVALID_INPUT', 'offset is too large: narrow the filters', { field: 'offset' });
  params.push(limit + 1, offset);
  const sql = `select * from (${feedSql(await hasRectifications(client))}) f
                ${where.length ? `where ${where.join(' and ')}` : ''}
                order by ${sort} limit $${params.length - 1} offset $${params.length}`;
  const r = await client.query<Record<string, unknown>>(sql, params);
  const rows = r.rows.slice(0, limit).map((x) => ({
    id: x['id'] as string, money: x['money'] as boolean, kind: x['kind'] as string, reversesKind: (x['reverses_kind'] as string | null) ?? null,
    at: (x['at'] as Date).toISOString(), date: ymd(x['entry_date'] as Date | string), routeId: x['route_id'] ?? null, toRouteId: x['to_route_id'] ?? null,
    workerId: x['worker_id'] ?? null, counterpartId: x['counterpart_id'] ?? null, adminId: x['admin_id'] ?? null, clientId: x['client_id'] ?? null,
    amountMinor: x['amount_minor'] === null ? null : Number(x['amount_minor']), concept: (x['concept'] as string | null) ?? '', status: x['status'] as string,
    reference: x['reference'] ?? null, actorId: x['actor_id'] ?? null, saleId: x['sale_id'] ?? null, paymentId: x['payment_id'] ?? null,
    expenseId: x['expense_id'] ?? null, settlementId: x['settlement_id'] ?? null,
  }));
  return { movements: rows, hasMore: r.rows.length > limit, limit, offset };
}

function ymd(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
