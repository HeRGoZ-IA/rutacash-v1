// OFICINAS (officeService de CLEAN → comandos). La Oficina ORGANIZA; la ruta
// controla el acceso. Reglas que se conservan:
//   · gestionar el catálogo (`office.*`) no concede acceso a las rutas de la Oficina;
//   · nombre único y código único por empresa, sin distinguir mayúsculas ni espacios
//     extremos (`validateOfficeIdentity`): lo impone PostgreSQL con índices únicos
//     (0001), también ante altas simultáneas;
//   · una Oficina inactiva bloquea las operaciones NUEVAS de sus rutas
//     (`isRouteOperationBlocked`, 0007 `route_operational`) y conserva la consulta;
//   · borrar una Oficina nunca borra rutas: con rutas se rechaza o, a petición, se
//     desvinculan en la MISMA transacción (cada ruta, con su permiso `route.edit`).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { routeUnrestricted } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { need } from './common.ts';
import { bool, has, idList, oneOf, optId, optText, pathId, reqText } from './input.ts';
import { lockRoutes } from './capitalGuard.ts';

interface Row { id: string; name: string; code: string | null; status: 'activa' | 'inactiva' }

async function load(client: pg.PoolClient, ctx: ActiveContext, id: string, lock = false): Promise<Row> {
  const r = await client.query<Row>(`select id, name, code, status from adex.offices where company_id = $1 and id = $2 ${lock ? 'for update' : ''}`,
    [ctx.companyId, pathId(id)]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

async function view(client: pg.PoolClient, ctx: ActiveContext, row: Row) {
  // Solo las rutas de la Oficina que el usuario TIENE AUTORIZADAS (RLS `routes_ctx` +
  // `filterAccessibleRoutes`): entrar a una Oficina no concede ninguna ruta.
  const routes = await client.query<{ id: string }>('select id from adex.routes where company_id = $1 and office_id = $2 order by id', [ctx.companyId, row.id]);
  const all = routes.rows.map((r) => r.id);
  const visible = routeUnrestricted(ctx) ? all : all.filter((id) => ctx.routeIds.includes(id));
  return { id: row.id, name: row.name, code: row.code, status: row.status, routeIds: visible };
}

export async function listOffices(client: pg.PoolClient, ctx: ActiveContext) {
  if (!routeUnrestricted(ctx)) need(ctx, 'route.viewAssigned');
  const r = await client.query<Row>('select id, name, code, status from adex.offices where company_id = $1 order by lower(name), id', [ctx.companyId]);
  return Promise.all(r.rows.map((row) => view(client, ctx, row)));
}

export async function getOffice(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  if (!routeUnrestricted(ctx)) need(ctx, 'route.viewAssigned');
  return view(client, ctx, await load(client, ctx, id));
}

export async function createOffice(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'office.create');
  const row: Row = { id: randomUUID(), name: reqText(body, 'name', 120), code: optText(body, 'code', 40), status: 'activa' };
  await client.query(`insert into adex.offices (id, company_id, name, code, status, created_at, updated_at) values ($1, $2, $3, $4, 'activa', now(), now())`,
    [row.id, ctx.companyId, row.name, row.code]);
  await audit(client, ctx, { action: 'CREATE_OFFICE', entityType: 'office', entityId: row.id, description: `Oficina creada: ${row.name}`,
    after: { name: row.name, code: row.code, status: row.status } });
  return view(client, ctx, row);
}

export async function updateOffice(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  need(ctx, 'office.edit');
  const prev = await load(client, ctx, id, true);
  const name = has(body, 'name') ? reqText(body, 'name', 120) : prev.name;
  const code = has(body, 'code') ? optText(body, 'code', 40) : prev.code;
  if (name === prev.name && code === prev.code) return view(client, ctx, prev);
  await client.query('update adex.offices set name = $3, code = $4, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, prev.id, name, code]);
  await audit(client, ctx, { action: 'UPDATE_OFFICE', entityType: 'office', entityId: prev.id, description: `Oficina actualizada: ${name}`,
    before: { name: prev.name, code: prev.code }, after: { name, code } });
  return view(client, ctx, { ...prev, name, code });
}

export async function setOfficeStatus(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  need(ctx, 'office.changeStatus');
  const status = oneOf(body, 'status', ['activa', 'inactiva'] as const);
  const prev = await load(client, ctx, id, true);
  if (prev.status !== status) {
    await client.query('update adex.offices set status = $3, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, prev.id, status]);
    await audit(client, ctx, { action: 'BLOCK_OFFICE', entityType: 'office', entityId: prev.id, description: `Oficina ${status}: ${prev.name}`,
      before: { status: prev.status }, after: { status } });
  }
  return view(client, ctx, { ...prev, status });
}

/** Mueve rutas a una Oficina (o a «Sin Oficina»): una escritura por ruta, nada hijo se toca. */
export async function moveRoutes(client: pg.PoolClient, ctx: ActiveContext, officeId: string | null, routeIds: string[], scope: string): Promise<string[]> {
  let target: Row | null = null;
  if (officeId) target = await load(client, ctx, officeId);
  for (const routeId of routeIds) need(ctx, 'route.edit', { routeId });
  await lockRoutes(client, ctx, routeIds);
  const r = await client.query<{ id: string; name: string; office_id: string | null }>(
    'select id, name, office_id from adex.routes where company_id = $1 and id = any($2) order by id', [ctx.companyId, routeIds]);
  if (r.rows.length !== routeIds.length) throw new ApiError(404, 'ROUTE_NOT_FOUND');
  const moved: string[] = [];
  for (const route of r.rows) {
    if (route.office_id === officeId) continue;
    await client.query('update adex.routes set office_id = $3, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, route.id, officeId]);
    // Ciclo de vida estructural de la ruta: sin `route_id` (ver routes.ts).
    await audit(client, ctx, { action: 'UPDATE_ROUTE', entityType: 'route', entityId: route.id,
      description: target ? `Ruta ${route.name} asignada a la Oficina ${target.name} (${scope})` : `Ruta ${route.name} quedó Sin Oficina (${scope})`,
      before: { officeId: route.office_id }, after: { officeId } });
    moved.push(route.id);
  }
  return moved;
}

export async function assignOfficeRoutes(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  const officeId = optId(body, 'officeId');
  const routeIds = idList(body, 'routeIds');
  return { moved: await moveRoutes(client, ctx, officeId, routeIds, 'organización masiva') };
}

export async function deleteOffice(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  need(ctx, 'office.delete');
  const detach = has(body, 'detachRoutes') ? bool(body, 'detachRoutes') : false;
  const office = await load(client, ctx, id, true);
  const routes = await client.query<{ id: string }>('select id from adex.routes where company_id = $1 and office_id = $2 order by id for update', [ctx.companyId, office.id]);
  const routeIds = routes.rows.map((r) => r.id);
  if (routeIds.length && !detach) throw new ApiError(409, 'OFFICE_HAS_ROUTES', undefined, { routeIds: routeIds.length });
  const detached = routeIds.length ? await moveRoutes(client, ctx, null, routeIds, 'eliminación de la Oficina') : [];
  await client.query('delete from adex.offices where company_id = $1 and id = $2', [ctx.companyId, office.id]);
  await audit(client, ctx, { action: 'DELETE_OFFICE', entityType: 'office', entityId: office.id,
    description: detached.length ? `Oficina eliminada: ${office.name} (${detached.length} ruta(s) quedaron Sin Oficina)` : `Oficina eliminada: ${office.name}`,
    before: { name: office.name, code: office.code, status: office.status }, metadata: { detachedRouteIds: detached } });
  return { deleted: office.id, detached };
}
