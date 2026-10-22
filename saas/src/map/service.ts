// MAPA DE RUTAS DEL ADMINISTRADOR (Ronda 67 · 0029). Solo lectura de lo que YA ocurrió: ventas,
// abonos y visitas sin pago de las rutas autorizadas, y la ubicación de REFERENCIA de cada cliente.
// No hay seguimiento continuo: la «última actividad conocida» es la última operación registrada
// con ubicación del dispositivo, con su fecha, nunca una posición en tiempo real.
//
// Dos ubicaciones que no se mezclan:
//   · referencia del cliente (`adex.client_locations`), fijada a propósito con su origen;
//   · dispositivo al registrar (abono: `payment_locations`; venta: `sale_locations`), evidencia.
// Un cliente sin referencia no recibe coordenadas de nadie: el mapa lo cuenta como «sin ubicación».

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from '../structure/common.ts';
import { optText, pathId } from '../structure/input.ts';
import type { LocationRecord } from '../collections/location.ts';

// ============================================================
// Ubicación de referencia del cliente
// ============================================================

export const CLIENT_LOCATION_FIELDS = ['source', 'lat', 'lng', 'accuracyM', 'capturedAt', 'note'] as const;
const SOURCES = ['gps_on_site', 'map_pin'] as const;
type Source = typeof SOURCES[number];
const MAX_PAST_MS = 15 * 60_000;
const MAX_FUTURE_MS = 2 * 60_000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface ClientLocationRow {
  id: string; client_id: string; route_id: string; source: Source; lat: number; lng: number; accuracy_m: number | null;
  device_captured_at: Date | null; note: string | null; set_by_membership_id: string; set_by_role: string; created_at: Date;
  set_by_name?: string | null;
}

const clientLocationView = (r: ClientLocationRow) => ({
  id: r.id, clientId: r.client_id, routeId: r.route_id, source: r.source, lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m,
  deviceCapturedAt: r.device_captured_at?.toISOString() ?? null, note: r.note, setBy: r.set_by_membership_id,
  setByName: r.set_by_name ?? null, setByRole: r.set_by_role, setAt: r.created_at.toISOString(),
});

/**
 * Fija o corrige la ubicación de REFERENCIA de un cliente (Administrador, Supervisor o Cobrador de
 * su ruta). `gps_on_site`: lectura del dispositivo estando en el lugar del cliente (la persona lo
 * confirma en pantalla). `map_pin`: punto marcado a mano; no lleva precisión ni hora del
 * dispositivo, porque no las hay. Cada cambio es una fila nueva (historia y auditoría).
 */
export async function setClientLocation(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  pathId(id);
  const c = (await client.query<{ id: string; route_id: string; name: string }>(
    'select id, route_id, name from adex.clients where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!c) throw new ApiError(404, 'NOT_FOUND');
  need(ctx, 'client.setLocation', { routeId: c.route_id });
  const source = body['source'];
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) throw new ApiError(400, 'INVALID_INPUT', 'source is invalid', { field: 'source' });
  const lat = body['lat'], lng = body['lng'];
  if (!finite(lat) || !finite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    throw new ApiError(400, 'INVALID_INPUT', 'lat/lng are invalid', { field: 'lat' });
  }
  let accuracyM: number | null = null;
  let capturedAt: string | null = null;
  if (source === 'map_pin') {
    if (body['accuracyM'] !== undefined || body['capturedAt'] !== undefined) {
      throw new ApiError(400, 'INVALID_INPUT', 'a map pin has no device accuracy or capture time', { field: 'source' });
    }
  } else {
    if (body['accuracyM'] !== undefined) {
      const a = body['accuracyM'];
      if (!finite(a) || a < 0 || a > 100_000) throw new ApiError(400, 'INVALID_INPUT', 'accuracyM is invalid', { field: 'accuracyM' });
      accuracyM = Math.round(a);
    }
    if (body['capturedAt'] !== undefined) {
      const t = typeof body['capturedAt'] === 'string' ? Date.parse(body['capturedAt']) : Number.NaN;
      if (!Number.isFinite(t)) throw new ApiError(400, 'INVALID_INPUT', 'capturedAt is invalid', { field: 'capturedAt' });
      // Reloj del teléfono desfasado: la posición vale, su hora no se toma como dato.
      if (t >= Date.now() - MAX_PAST_MS && t <= Date.now() + MAX_FUTURE_MS) capturedAt = new Date(t).toISOString();
    }
  }
  const note = optText(body, 'note', 200);
  const locId = randomUUID();
  await client.query(
    `insert into adex.client_locations (id, company_id, client_id, route_id, source, lat, lng, accuracy_m, device_captured_at, note,
                                        set_by_membership_id, set_by_role, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    [locId, ctx.companyId, c.id, c.route_id, source, lat, lng, accuracyM, capturedAt, note, ctx.membershipId, ctx.role]);
  const row = (await client.query<ClientLocationRow>('select * from adex.client_locations where company_id = $1 and id = $2', [ctx.companyId, locId])).rows[0]!;
  // Auditoría SIN coordenadas (como el abono, 0022): quién, cuándo, de qué cliente y con qué origen.
  await audit(client, ctx, { action: 'SET_CLIENT_LOCATION', entityType: 'client', entityId: c.id, routeId: c.route_id,
    description: `Ubicación de referencia de ${c.name} (${source === 'gps_on_site' ? 'GPS en el lugar' : 'punto en el mapa'})`,
    metadata: { source, locationId: locId } });
  return clientLocationView(row);
}

/** Ubicación vigente y su historia (quien la fijó, cuándo y de dónde). */
export async function getClientLocation(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  pathId(id);
  const c = (await client.query<{ route_id: string }>('select route_id from adex.clients where company_id = $1 and id = $2', [ctx.companyId, id])).rows[0];
  if (!c) throw new ApiError(404, 'NOT_FOUND');
  need(ctx, 'client.view', { routeId: c.route_id });
  const rows = (await client.query<ClientLocationRow>(
    `select l.*, m.display_name set_by_name from adex.client_locations l
       left join adex.memberships m on m.company_id = l.company_id and m.id = l.set_by_membership_id
      where l.company_id = $1 and l.client_id = $2 order by l.created_at desc, l.id desc limit 50`, [ctx.companyId, id])).rows;
  return { current: rows[0] ? clientLocationView(rows[0]) : null, history: rows.map(clientLocationView) };
}

// ============================================================
// Ubicación del dispositivo al registrar una venta (savepoint: nunca tumba la venta)
// ============================================================

export async function storeSaleLocation(
  client: pg.PoolClient, ctx: ActiveContext,
  p: { kind: 'direct_sale' | 'credit_request'; entityId: string; routeId: string; clientId: string; location: LocationRecord },
): Promise<string> {
  await client.query('savepoint sale_location');
  try {
    await client.query(
      `insert into adex.sale_locations (company_id, entity_kind, entity_id, route_id, client_id, captured_by_membership_id, status, lat, lng,
                                        accuracy_m, device_captured_at, reason, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
      [ctx.companyId, p.kind, p.entityId, p.routeId, p.clientId, ctx.membershipId, p.location.status, p.location.lat, p.location.lng,
       p.location.accuracyM, p.location.capturedAt, p.location.reason]);
    await client.query('release savepoint sale_location');
    return p.location.status;
  } catch (e) {
    await client.query('rollback to savepoint sale_location');
    await client.query('release savepoint sale_location');
    const err = e as { code?: string; name?: string };
    process.stderr.write(`${JSON.stringify({ level: 'warn', t: new Date().toISOString(), msg: 'sale_location_not_stored',
      code: err?.code ?? null, name: err?.name ?? 'Error', entityId: p.entityId })}\n`);
    return 'not_stored';
  }
}

// ============================================================
// Lectura del mapa
// ============================================================

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 93;
const MAX_CLIENTS = 5000;
const MAX_PER_KIND = 3000;
const KINDS = ['sale', 'payment', 'visit'] as const;
type Kind = typeof KINDS[number];

interface Device { status: string; lat: number | null; lng: number | null; accuracyM: number | null; capturedAt: string | null; receivedAt: string | null }
const device = (r: Record<string, unknown>, p = 'd_'): Device | null => (r[`${p}status`] == null ? null : {
  status: String(r[`${p}status`]), lat: (r[`${p}lat`] as number | null) ?? null, lng: (r[`${p}lng`] as number | null) ?? null,
  accuracyM: (r[`${p}accuracy`] as number | null) ?? null,
  capturedAt: (r[`${p}captured_at`] as Date | null)?.toISOString() ?? null, receivedAt: (r[`${p}received_at`] as Date | null)?.toISOString() ?? null,
});

/**
 * `GET /v1/map?routeId&workerId&from&to&kinds`: clientes de las rutas autorizadas con su ubicación de
 * referencia (o `null`), la actividad del periodo y la última actividad conocida con ubicación de cada
 * trabajador. Solo el Administrador (`map.view`); una ruta ajena por parámetro es 403 y la base
 * (RLS) tampoco devolvería sus filas.
 */
export async function routeMap(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  need(ctx, 'map.view');
  const routeParam = q.get('routeId');
  if (routeParam !== null) { pathId(routeParam); need(ctx, 'map.view', { routeId: routeParam }); }
  const workerId = q.get('workerId');
  if (workerId !== null) pathId(workerId);
  const today = (await client.query<{ d: string }>('select adex.company_today($1)::text d', [ctx.companyId])).rows[0]!.d;
  const to = q.get('to') ?? today;
  const from = q.get('from') ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  for (const [k, v] of [['from', from], ['to', to]] as const) if (!DAY.test(v) || Number.isNaN(Date.parse(v))) throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`);
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (span < 0) throw new ApiError(400, 'INVALID_INPUT', 'from is after to');
  if (span > MAX_DAYS) throw new ApiError(400, 'RANGE_TOO_LARGE', `at most ${MAX_DAYS} days`);
  const kindsParam = q.get('kinds');
  const kinds = new Set<Kind>(kindsParam ? kindsParam.split(',').map((k) => {
    if (!(KINDS as readonly string[]).includes(k)) throw new ApiError(400, 'INVALID_INPUT', 'kinds is invalid');
    return k as Kind;
  }) : KINDS);

  // Rutas del alcance: las autorizadas (RLS de `routes`), o la pedida.
  const routes = (await client.query<{ id: string; name: string; status: string }>(
    `select id, name, status from adex.routes where company_id = $1 ${routeParam ? 'and id = $2' : ''} order by name, id`,
    routeParam ? [ctx.companyId, routeParam] : [ctx.companyId])).rows
    .filter((r) => ctx.routeIds.includes(r.id));
  const routeIds = routes.map((r) => r.id);

  const clients = (await client.query<Record<string, unknown>>(
    `select c.id, c.name, c.route_id, c.address_primary, c.address_secondary, c.status,
            l.id l_id, l.source l_source, l.lat l_lat, l.lng l_lng, l.accuracy_m l_accuracy, l.created_at l_set_at,
            l.set_by_membership_id l_set_by, m.display_name l_set_by_name, l.set_by_role l_set_by_role
       from adex.clients c
       left join lateral (select * from adex.client_locations x where x.company_id = c.company_id and x.client_id = c.id
                           order by x.created_at desc, x.id desc limit 1) l on true
       left join adex.memberships m on m.company_id = c.company_id and m.id = l.set_by_membership_id
      where c.company_id = $1 and c.route_id = any($2::text[])
      order by c.name, c.id limit ${MAX_CLIENTS + 1}`, [ctx.companyId, routeIds])).rows;
  const clientsTruncated = clients.length > MAX_CLIENTS;

  const wf = (cols: string[], params: unknown[]) => {
    if (workerId === null) return '';
    params.push(workerId);
    return ` and $${params.length} in (${cols.join(', ')})`;
  };
  let truncated = clientsTruncated;
  const activities: Record<string, unknown>[] = [];

  if (kinds.has('sale')) {
    const params: unknown[] = [ctx.companyId, routeIds, from, to];
    const r = (await client.query<Record<string, unknown>>(
      `select s.id, s.client_id, s.route_id, s.created_by_membership_id, s.disbursed_by_membership_id, s.sale_value_minor amount,
              s.status sale_status, coalesce(s.disbursement_date, s.start_date)::text biz_day, coalesce(s.disbursed_at, s.created_at) op_at,
              coalesce(ld.status, lr.status) d_status, coalesce(ld.lat, lr.lat) d_lat, coalesce(ld.lng, lr.lng) d_lng,
              coalesce(ld.accuracy_m, lr.accuracy_m) d_accuracy, coalesce(ld.device_captured_at, lr.device_captured_at) d_captured_at,
              coalesce(ld.received_at, lr.received_at) d_received_at, case when ld.status is not null then 'direct_sale' when lr.status is not null then 'credit_request' end d_kind,
              coalesce(ld.captured_by_membership_id, lr.captured_by_membership_id) d_by
         from adex.sales s
         left join adex.sale_locations ld on ld.company_id = s.company_id and ld.entity_kind = 'direct_sale' and ld.entity_id = s.id
         left join adex.sale_locations lr on lr.company_id = s.company_id and lr.entity_kind = 'credit_request' and lr.entity_id = s.sale_request_id
        where s.company_id = $1 and s.route_id = any($2::text[]) and coalesce(s.disbursement_date, s.start_date) between $3::date and $4::date
          ${wf(['s.created_by_membership_id', 's.disbursed_by_membership_id'], params)}
        order by op_at desc, s.id limit ${MAX_PER_KIND + 1}`, params)).rows;
    if (r.length > MAX_PER_KIND) { truncated = true; r.length = MAX_PER_KIND; }
    for (const x of r) {
      activities.push({ kind: 'sale', id: x['id'], clientId: x['client_id'], routeId: x['route_id'], day: x['biz_day'], at: (x['op_at'] as Date).toISOString(),
        workerId: x['disbursed_by_membership_id'] ?? x['created_by_membership_id'], registeredBy: x['created_by_membership_id'],
        deliveredBy: x['disbursed_by_membership_id'] ?? null, amountMinor: Number(x['amount']), saleStatus: x['sale_status'],
        device: device(x), deviceOrigin: x['d_kind'] ?? null, deviceBy: x['d_by'] ?? null });
    }
  }
  if (kinds.has('payment')) {
    const params: unknown[] = [ctx.companyId, routeIds, from, to];
    // Solo abonos VÁLIDOS: un abono anulado (y su asiento espejo) no es un cobro exitoso.
    const r = (await client.query<Record<string, unknown>>(
      `select p.id, p.client_id, p.route_id, p.sale_id, p.collector_membership_id, coalesce(p.created_by_membership_id, p.collector_membership_id) by_m,
              p.amount_minor amount, p.payment_date::text biz_day, p.created_at op_at, p.state,
              l.status d_status, l.lat d_lat, l.lng d_lng, l.accuracy_m d_accuracy, l.device_captured_at d_captured_at, l.received_at d_received_at
         from adex.payments p
         left join adex.payment_locations l on l.company_id = p.company_id and l.payment_id = p.id
        where p.company_id = $1 and p.route_id = any($2::text[]) and p.payment_date between $3::date and $4::date
          and coalesce(p.state, 'active') in ('active', 'correction')
          ${wf(['p.collector_membership_id', 'p.created_by_membership_id'], params)}
        order by p.created_at desc, p.id limit ${MAX_PER_KIND + 1}`, params)).rows;
    if (r.length > MAX_PER_KIND) { truncated = true; r.length = MAX_PER_KIND; }
    for (const x of r) {
      activities.push({ kind: 'payment', id: x['id'], clientId: x['client_id'], routeId: x['route_id'], saleId: x['sale_id'], day: x['biz_day'],
        at: (x['op_at'] as Date).toISOString(), workerId: x['by_m'], collectorId: x['collector_membership_id'], amountMinor: Number(x['amount']),
        device: device(x) });
    }
  }
  if (kinds.has('visit')) {
    const params: unknown[] = [ctx.companyId, routeIds, from, to];
    // La visita sin pago no tiene GPS propio (regla del propietario): se representa en la ubicación del cliente.
    const r = (await client.query<Record<string, unknown>>(
      `select v.id, v.client_id, v.route_id, v.sale_id, v.collector_membership_id, v.reason, v.promised_payment_date::text promised,
              v.visit_date::text biz_day, v.created_at op_at
         from adex.no_payment_visits v
        where v.company_id = $1 and v.route_id = any($2::text[]) and v.visit_date between $3::date and $4::date
          ${wf(['v.collector_membership_id'], params)}
        order by v.created_at desc, v.id limit ${MAX_PER_KIND + 1}`, params)).rows;
    if (r.length > MAX_PER_KIND) { truncated = true; r.length = MAX_PER_KIND; }
    for (const x of r) {
      activities.push({ kind: 'visit', id: x['id'], clientId: x['client_id'], routeId: x['route_id'], saleId: x['sale_id'], day: x['biz_day'],
        at: (x['op_at'] as Date).toISOString(), workerId: x['collector_membership_id'], reason: x['reason'], promisedPaymentDate: x['promised'],
        device: null });
    }
  }
  activities.sort((a, b) => String(b['at']).localeCompare(String(a['at'])) || String(a['id']).localeCompare(String(b['id'])));

  // Trabajadores de las rutas (para el filtro y los nombres), sin datos personales adicionales.
  const workers = (await client.query<{ id: string; name: string; role: string; status: string }>(
    `select distinct m.id, m.display_name name, m.role, m.status from adex.memberships m
       join adex.membership_routes mr on mr.company_id = m.company_id and mr.membership_id = m.id
      where m.company_id = $1 and mr.route_id = any($2::text[]) and m.role in ('cobrador', 'supervisor', 'admin', 'secretario')
      order by name, id`, [ctx.companyId, routeIds])).rows;
  const known = new Set(workers.map((w) => w.id));
  const missingIds = [...new Set(activities.flatMap((a) => [a['workerId'], a['registeredBy'], a['deliveredBy'], a['collectorId']]).filter((x): x is string => typeof x === 'string' && !known.has(x)))];
  if (missingIds.length) {
    const extra = (await client.query<{ id: string; name: string; role: string; status: string }>(
      `select id, display_name name, role, status from adex.memberships where company_id = $1 and id = any($2::text[])`, [ctx.companyId, missingIds])).rows;
    workers.push(...extra);
  }

  // Última actividad CONOCIDA con ubicación del dispositivo, por Cobrador o Supervisor (sin límite de
  // fechas del filtro, dentro de las rutas del alcance). Es una operación pasada, no un rastreo.
  const lastParams: unknown[] = [ctx.companyId, routeIds];
  const lastWorker = workerId === null ? '' : (lastParams.push(workerId), ` and by_m = $${lastParams.length}`);
  const last = (await client.query<Record<string, unknown>>(
    `select distinct on (by_m) by_m, kind, id, client_id, route_id, op_at, d_lat, d_lng, d_accuracy, d_captured_at
       from (
         select coalesce(p.created_by_membership_id, p.collector_membership_id) by_m, 'payment' kind, p.id, p.client_id, p.route_id,
                coalesce(l.device_captured_at, l.received_at) op_at, l.lat d_lat, l.lng d_lng, l.accuracy_m d_accuracy, l.device_captured_at d_captured_at
           from adex.payment_locations l join adex.payments p on p.company_id = l.company_id and p.id = l.payment_id
          where l.company_id = $1 and l.route_id = any($2::text[]) and l.status = 'captured'
         union all
         select l.captured_by_membership_id, 'sale', coalesce(s.id, l.entity_id), l.client_id, l.route_id,
                coalesce(l.device_captured_at, l.received_at), l.lat, l.lng, l.accuracy_m, l.device_captured_at
           from adex.sale_locations l
           left join adex.sales s on s.company_id = l.company_id and ((l.entity_kind = 'direct_sale' and s.id = l.entity_id) or (l.entity_kind = 'credit_request' and s.sale_request_id = l.entity_id))
          where l.company_id = $1 and l.route_id = any($2::text[]) and l.status = 'captured'
       ) x
      where exists (select 1 from adex.memberships m where m.company_id = $1 and m.id = x.by_m and m.role in ('cobrador', 'supervisor'))
        ${lastWorker}
      order by by_m, op_at desc, id`, lastParams)).rows;

  return {
    from, to, today,
    routes: routes.map((r) => ({ id: r.id, name: r.name, status: r.status })),
    workers: workers.map((w) => ({ id: w.id, name: w.name, role: w.role, status: w.status })),
    clients: clients.slice(0, MAX_CLIENTS).map((c) => ({
      id: c['id'], name: c['name'], routeId: c['route_id'], address: c['address_primary'], addressSecondary: c['address_secondary'] ?? null,
      status: c['status'],
      location: c['l_id'] == null ? null : {
        source: c['l_source'], lat: c['l_lat'], lng: c['l_lng'], accuracyM: c['l_accuracy'] ?? null, setAt: (c['l_set_at'] as Date).toISOString(),
        setBy: c['l_set_by'], setByName: c['l_set_by_name'] ?? null, setByRole: c['l_set_by_role'],
      },
    })),
    activities,
    lastKnown: last.map((x) => ({ workerId: x['by_m'], kind: x['kind'], id: x['id'], clientId: x['client_id'], routeId: x['route_id'],
      at: (x['op_at'] as Date).toISOString(), lat: x['d_lat'], lng: x['d_lng'], accuracyM: x['d_accuracy'] ?? null })),
    truncated,
  };
}
