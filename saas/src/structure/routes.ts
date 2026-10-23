// RUTAS (routeService, RoutesPage y routeAssignment de CLEAN → comandos).
//
// Reglas de CLEAN que se conservan:
//   · alta libre: Administrador, Cobrador y Oficina OPCIONALES; el Administrador que
//     crea queda SIEMPRE autoasignado (`resolveRouteAdminIds`: su acceso es fail-closed
//     por rutas); cada Administrador indicado, activo y gestionable por el actor;
//   · edición en UNA transacción: datos, Oficina, Cobrador responsable
//     (`validateCobradorInvariant`) y asignaciones (`computeRouteAssignmentDiff`, solo
//     dentro del universo que el actor puede gestionar);
//   · responsable de capital (v16) en la misma transacción (capitalGuard.ts);
//   · el Administrador no elimina rutas; solo el SuperAdmin y solo sin historia (DS-11).
//
// Diferencias propias del servidor (justificadas):
//   · capital inicial > 0 se rechaza: no hay caja de ruta (capital centralizado, Fase 3).
//     La ruta nace con 0 y el responsable entrega capital a los trabajadores desde su bolsa;
//   · la auditoría del ciclo de vida ESTRUCTURAL de la propia ruta (alta, datos,
//     Oficina, estado) va sin `route_id` (la entidad está en `entity_id`): si llevara
//     la FK, ninguna ruta podría borrarse jamás aunque no tenga ninguna historia.
//     Asignaciones y responsable de capital sí llevan `route_id`: son historia.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { computeRouteAssignmentDiff } from '@/lib/routeAssignmentDiff';
import { validateCobradorInvariant } from '@/lib/cobradorRules';
import { assignableRoles } from '@/lib/permissions';
import { isAllowedRate } from '@/lib/interestRatePolicy';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { mayManage, routeUnrestricted, toCleanUser, type MembershipFacts } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need, snapshot } from './common.ts';
import { bool, has, idList, minor, oneOf, optId, optText, pathId, rate, reqId, reqText } from './input.ts';
import { lockMembershipsForRevocation, lockRoutes, reconcileControllers, setRouteController, type ControllerEvent } from './capitalGuard.ts';

interface Row {
  id: string; name: string; code: string; city: string | null; email: string | null; phone: string | null;
  interest_rate: string; free_rate: boolean; max_loan_minor: string; office_id: string | null;
  collector_membership_id: string | null; capital_controller_membership_id: string | null; capital_controller_since: Date | null;
  status: 'activa' | 'inactiva'; created_at: Date; updated_at: Date;
}
const COLS = `id, name, code, city, email, phone, interest_rate, free_rate, max_loan_minor, office_id, collector_membership_id,
              capital_controller_membership_id, capital_controller_since, status, created_at, updated_at`;

function view(r: Row, members?: string[]) {
  return {
    id: r.id, name: r.name, code: r.code, city: r.city, email: r.email, phone: r.phone, interestRate: Number(r.interest_rate),
    freeRate: r.free_rate, maxLoanMinor: Number(r.max_loan_minor), officeId: r.office_id, collectorId: r.collector_membership_id,
    capitalControllerId: r.capital_controller_membership_id, capitalControllerSince: r.capital_controller_since?.toISOString() ?? null,
    status: r.status, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    ...(members ? { memberIds: members } : {}),
  };
}

function needView(ctx: ActiveContext): void {
  if (!routeUnrestricted(ctx)) need(ctx, 'route.viewAssigned');
}

async function load(client: pg.PoolClient, ctx: ActiveContext, id: string, lock = false): Promise<Row> {
  pathId(id);
  // Una ruta ajena o fuera del alcance es indistinguible de una inexistente (RLS + filtro).
  if (!routeUnrestricted(ctx) && !ctx.routeIds.includes(id)) throw new ApiError(404, 'NOT_FOUND');
  if (lock) await lockRoutes(client, ctx, [id]);
  const r = await client.query<Row>(`select ${COLS} from adex.routes where company_id = $1 and id = $2`, [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

async function routeMembers(client: pg.PoolClient, ctx: ActiveContext, routeId: string): Promise<string[]> {
  const r = await client.query<{ membership_id: string }>('select membership_id from adex.membership_routes where company_id = $1 and route_id = $2 order by 1',
    [ctx.companyId, routeId]);
  return r.rows.map((x) => x.membership_id);
}

/** Rutas visibles en el contexto activo (`filterAccessibleRoutes` de CLEAN + RLS). */
export async function listRoutes(client: pg.PoolClient, ctx: ActiveContext) {
  needView(ctx);
  const r = await client.query<Row>(`select ${COLS} from adex.routes where company_id = $1 order by code, id`, [ctx.companyId]);
  return (routeUnrestricted(ctx) ? r.rows : r.rows.filter((x) => ctx.routeIds.includes(x.id))).map((x) => view(x));
}

export async function getRoute(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  needView(ctx);
  const row = await load(client, ctx, id);
  return view(row, await routeMembers(client, ctx, row.id));
}

async function assertOffice(client: pg.PoolClient, ctx: ActiveContext, officeId: string | null): Promise<void> {
  if (!officeId) return;
  const r = await client.query('select 1 from adex.offices where company_id = $1 and id = $2', [ctx.companyId, officeId]);
  if (!r.rowCount) throw new ApiError(404, 'OFFICE_NOT_FOUND');
}

async function nextRouteCode(client: pg.PoolClient, ctx: ActiveContext): Promise<string> {
  // Misma forma que la pantalla de CLEAN (`RT-001`, `RT-002`…), sobre TODAS las rutas
  // de la empresa: `adex.next_route_code` corre como propietario (no depende del alcance).
  return (await client.query<{ code: string }>('select adex.next_route_code($1) code', [ctx.companyId])).rows[0]!.code;
}

/** Inserta/retira asignaciones con su auditoría (cada retiro es una revocación: REVOKE-004). */
async function applyAssignments(client: pg.PoolClient, ctx: ActiveContext, routeId: string, routeName: string, added: string[], removed: string[]) {
  for (const id of removed) {
    await client.query('delete from adex.membership_routes where company_id = $1 and membership_id = $2 and route_id = $3', [ctx.companyId, id, routeId]);
    await audit(client, ctx, { action: 'UNASSIGN_ROUTE', entityType: 'membership', entityId: id, routeId, description: `Usuario retirado de ${routeName}` });
  }
  for (const id of added) {
    await client.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [ctx.companyId, id, routeId]);
    await audit(client, ctx, { action: 'ASSIGN_ROUTE', entityType: 'membership', entityId: id, routeId, description: `Usuario asignado a ${routeName}` });
  }
}

// Regla de `resolveRouteAdminIds` (src/services/routeService.ts; el módulo de servicio
// no se puede importar en Node porque arrastra Dexie): sin duplicados y, si el actor
// es Administrador, autoincluido.
function routeAdminIds(adminIds: string[], ctx: ActiveContext): string[] {
  const ids = [...new Set(adminIds)];
  if (ctx.role === 'admin' && !ids.includes(ctx.membershipId)) ids.push(ctx.membershipId);
  return ids;
}

export const CREATE_ROUTE_FIELDS = ['name', 'code', 'city', 'email', 'phone', 'interestRate', 'freeRate', 'maxLoanMinor', 'initialCapitalMinor',
  'officeId', 'adminIds', 'collectorId'] as const;

/** D73-01: la tasa de una ruta es una de las admitidas (10 o 20): el Cobrador la usa al originar. */
function routeRate(body: Record<string, unknown>): number {
  const v = rate(body, 'interestRate');
  if (!isAllowedRate(v)) throw new ApiError(400, 'INTEREST_RATE_NOT_ALLOWED', 'the route rate must be 10 or 20', { field: 'interestRate' });
  return v;
}

export async function createRoute(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'route.create');
  const name = reqText(body, 'name', 120);
  const interestRate = routeRate(body);
  const freeRate = bool(body, 'freeRate');
  const maxLoanMinor = minor(body, 'maxLoanMinor');
  if (has(body, 'initialCapitalMinor') && minor(body, 'initialCapitalMinor') > 0) {
    throw new ApiError(409, 'ROUTE_INITIAL_CAPITAL_NOT_ALLOWED', 'there is no route cash box: the capital controller delivers capital to workers from its pool');
  }
  const officeId = optId(body, 'officeId');
  const collectorId = optId(body, 'collectorId');
  const adminIds = routeAdminIds(idList(body, 'adminIds', 50), ctx);

  const members = await loadMembers(client, ctx, [...adminIds, ...(collectorId ? [collectorId] : [])], true);
  for (const id of adminIds) {
    const a = members.get(id);
    if (!a || a.role !== 'admin' || a.status !== 'activo') throw new ApiError(400, 'INVALID_ADMIN');
    if (a.membershipId !== ctx.membershipId && !mayManage(ctx, a)) throw new ApiError(403, 'PERMISSION_DENIED');
  }
  if (collectorId) {
    const c = members.get(collectorId);
    if (!c || c.role !== 'cobrador' || c.status !== 'activo') throw new ApiError(400, 'INVALID_COLLECTOR');
    if (!mayManage(ctx, c)) throw new ApiError(403, 'PERMISSION_DENIED');
  }
  await assertOffice(client, ctx, officeId);

  // Serializa las altas de la empresa: el código siguiente no se repite.
  await client.query(`select pg_advisory_xact_lock(adex.lock_key('company-routes', $1))`, [ctx.companyId]);
  const code = optText(body, 'code', 40) ?? await nextRouteCode(client, ctx);
  const id = randomUUID();
  await client.query(
    `insert into adex.routes (id, company_id, office_id, name, code, city, email, phone, interest_rate, free_rate, max_loan_minor,
                              initial_capital_minor, legacy_capital_actual_minor, collector_membership_id, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0, $12, 'activa', now(), now())`,
    [id, ctx.companyId, officeId, name, code, optText(body, 'city', 120), optText(body, 'email', 160), optText(body, 'phone', 40),
      interestRate, freeRate, maxLoanMinor, collectorId]);
  const assigned = [...adminIds, ...(collectorId && !adminIds.includes(collectorId) ? [collectorId] : [])];
  await audit(client, ctx, {
    action: 'CREATE_ROUTE', entityType: 'route', entityId: id,
    description: [!adminIds.length ? 'Administrador' : null, !collectorId ? 'Cobrador' : null].filter(Boolean).length
      ? `Ruta creada SIN ${[!adminIds.length ? 'Administrador' : null, !collectorId ? 'Cobrador' : null].filter(Boolean).join(' ni ')} responsable: ${name}`
      : `Ruta creada: ${name}`,
    after: { name, code, officeId, adminIds, collectorId, sinAdministrador: !adminIds.length, sinCobrador: !collectorId, sinOficina: !officeId },
  });
  await applyAssignments(client, ctx, id, name, assigned, []);
  const events = await reconcileControllers(client, ctx, { routeIds: [id], preferredAdminIds: adminIds });
  const row = (await client.query<Row>(`select ${COLS} from adex.routes where company_id = $1 and id = $2`, [ctx.companyId, id])).rows[0]!;
  return { ...view(row, await routeMembers(client, ctx, id)), controllerEvents: events };
}

export const UPDATE_ROUTE_FIELDS = ['name', 'city', 'email', 'phone', 'interestRate', 'freeRate', 'maxLoanMinor', 'officeId', 'collectorId',
  'memberIds', 'capitalControllerId', 'reason'] as const;

/**
 * Edición transaccional (`updateRouteWithAssignments`). `memberIds` = membresía
 * DESEADA entre los usuarios que el actor puede asignar (`isAssignable` de RoutesPage:
 * rol asignable por el actor, no SuperAdmin y gestionable). Las asignaciones fuera de
 * ese universo no se tocan. Ausente = no se cambian asignaciones.
 */
export async function updateRoute(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  // Quien puede perder la ruta (lista nueva o cambio de Cobrador): su bloqueo de
  // revocación ANTES que la fila de la ruta (orden global, ver capitalGuard.ts).
  if (has(body, 'memberIds') || has(body, 'collectorId')) {
    pathId(id);
    const keep = new Set(has(body, 'memberIds') ? idList(body, 'memberIds') : []);
    const current = await client.query<{ membership_id: string }>(
      'select membership_id from adex.membership_routes where company_id = $1 and route_id = $2', [ctx.companyId, id]);
    await lockMembershipsForRevocation(client, current.rows.map((x) => x.membership_id).filter((m) => !keep.has(m) && m !== ctx.membershipId));
  }
  const prev = await load(client, ctx, id, true);
  need(ctx, 'route.edit', { routeId: prev.id });
  const next = {
    name: has(body, 'name') ? reqText(body, 'name', 120) : prev.name,
    city: has(body, 'city') ? optText(body, 'city', 120) : prev.city,
    email: has(body, 'email') ? optText(body, 'email', 160) : prev.email,
    phone: has(body, 'phone') ? optText(body, 'phone', 40) : prev.phone,
    interestRate: has(body, 'interestRate') ? routeRate(body) : Number(prev.interest_rate),
    freeRate: has(body, 'freeRate') ? bool(body, 'freeRate') : prev.free_rate,
    maxLoanMinor: has(body, 'maxLoanMinor') ? minor(body, 'maxLoanMinor') : Number(prev.max_loan_minor),
    officeId: has(body, 'officeId') ? optId(body, 'officeId') : prev.office_id,
    collectorId: has(body, 'collectorId') ? optId(body, 'collectorId') : prev.collector_membership_id,
  };
  const replacement = has(body, 'capitalControllerId') ? reqId(body, 'capitalControllerId') : null;
  await assertOffice(client, ctx, next.officeId);

  const all = await loadMembers(client, ctx);
  const actor = toCleanUser(ctx);
  const roles = assignableRoles(actor);
  const assignable = [...all.values()].filter((u) => u.role !== 'superadmin' && roles.includes(u.role) && mayManage(ctx, u)).map((u) => u.membershipId);
  const current = [...all.values()].filter((u) => u.routeIds.includes(prev.id)).map((u) => u.membershipId);
  const desired = has(body, 'memberIds') ? idList(body, 'memberIds') : current.filter((m) => assignable.includes(m));
  // Sin lista explícita, cambiar de Cobrador responsable lo deja asignado (como el editor de CLEAN).
  if (!has(body, 'memberIds') && next.collectorId && !desired.includes(next.collectorId)) desired.push(next.collectorId);
  if (desired.some((m) => !assignable.includes(m) && !current.includes(m))) throw new ApiError(403, 'PERMISSION_DENIED');
  const finalMembers = [...new Set([...current.filter((m) => !assignable.includes(m)), ...desired])];

  const userById = (mid: string) => { const m = all.get(mid); return m ? toCleanUser(m) : undefined; };
  if (next.collectorId !== prev.collector_membership_id || has(body, 'memberIds')) {
    const inv = validateCobradorInvariant({ routeTenantId: ctx.companyId, assignedUserIds: finalMembers, cobradorId: next.collectorId ?? undefined, userById });
    if (!inv.ok) throw new ApiError(400, 'INVALID_COLLECTOR', inv.message);
  }
  const diff = computeRouteAssignmentDiff({
    routeId: prev.id, assignableUserIds: assignable, assignedUserIds: desired,
    cobradorId: next.collectorId ?? undefined, prevCobradorId: prev.collector_membership_id ?? undefined,
    membershipOf: (mid) => [...(all.get(mid)?.routeIds ?? [])],
  });
  // Cualquier cambio de asignación es `route.assign` sobre esta ruta, y solo sobre
  // personas que el actor puede gestionar.
  if (diff.added.length || diff.removed.length) need(ctx, 'route.assign', { routeId: prev.id });
  for (const mid of [...diff.added, ...diff.removed]) {
    const m = all.get(mid);
    if (!m || !mayManage(ctx, m)) throw new ApiError(403, 'PERMISSION_DENIED');
    if (diff.added.includes(mid) && m.status !== 'activo') throw new ApiError(400, 'MEMBER_INACTIVE');
  }
  if (diff.added.length || diff.removed.length) await loadMembers(client, ctx, [...diff.added, ...diff.removed], true);

  const before = { name: prev.name, city: prev.city, email: prev.email, phone: prev.phone, interestRate: Number(prev.interest_rate), freeRate: prev.free_rate,
    maxLoanMinor: Number(prev.max_loan_minor), officeId: prev.office_id, collectorId: prev.collector_membership_id };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== before[k]);
  if (changed.length) {
    await client.query(
      `update adex.routes set name = $3, city = $4, email = $5, phone = $6, interest_rate = $7, free_rate = $8, max_loan_minor = $9, office_id = $10,
              collector_membership_id = $11, updated_at = now() where company_id = $1 and id = $2`,
      [ctx.companyId, prev.id, next.name, next.city, next.email, next.phone, next.interestRate, next.freeRate, next.maxLoanMinor, next.officeId, next.collectorId]);
    await audit(client, ctx, { action: 'UPDATE_ROUTE', entityType: 'route', entityId: prev.id, description: `Ruta actualizada: ${next.name}`,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, next[k]])) });
  }
  await applyAssignments(client, ctx, prev.id, next.name, diff.added, diff.removed);
  const events: ControllerEvent[] = await reconcileControllers(client, ctx, {
    routeIds: [prev.id], preferredAdminIds: desired.filter((m) => diff.added.includes(m)),
    replacements: replacement ? { [prev.id]: replacement } : undefined,
    reason: has(body, 'reason') ? reqText(body, 'reason', 300) : undefined,
  });
  const row = (await client.query<Row>(`select ${COLS} from adex.routes where company_id = $1 and id = $2`, [ctx.companyId, prev.id])).rows[0]!;
  return { ...view(row, await routeMembers(client, ctx, prev.id)), added: diff.added, removed: diff.removed, controllerEvents: events };
}

export async function setRouteStatus(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const status = oneOf(body, 'status', ['activa', 'inactiva'] as const);
  const prev = await load(client, ctx, id, true);
  need(ctx, 'route.block', { routeId: prev.id });
  if (prev.status !== status) {
    await client.query('update adex.routes set status = $3, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, prev.id, status]);
    // `billableRouteCount` (DS-17) lo cuenta el servidor sobre `status`: no hay cifra que sincronizar.
    await audit(client, ctx, { action: 'BLOCK_ROUTE', entityType: 'route', entityId: prev.id, description: `Ruta ${status}: ${prev.name}`,
      before: { status: prev.status }, after: { status } });
  }
  return view({ ...prev, status });
}

/** DS-11: solo SuperAdmin, solo sin historia ni referencias protegidas. */
export async function deleteRoute(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  need(ctx, 'route.delete');
  const prev = await load(client, ctx, id, true);
  const refs = (await client.query<{ refs: string[] }>("select adex.protected_references('adex.routes'::regclass, $1, $2) refs", [ctx.companyId, prev.id])).rows[0]!.refs;
  if (refs.length) throw new ApiError(409, 'HAS_HISTORY', 'the route has history: deactivate it instead', { references: refs });
  // El disparador de 0007 vuelve a comprobarlo con el bloqueo de la fila tomado.
  await client.query('delete from adex.routes where company_id = $1 and id = $2', [ctx.companyId, prev.id]);
  await audit(client, ctx, { action: 'DELETE_ROUTE', entityType: 'route', entityId: prev.id, description: `Ruta eliminada: ${prev.name}`,
    before: snapshot(prev as unknown as Record<string, unknown>, ['name', 'code', 'status', 'office_id']) });
  return { deleted: prev.id };
}

export async function changeRouteController(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  const prev = await load(client, ctx, id);
  const event = await setRouteController(client, ctx, prev.id, reqId(body, 'membershipId'), reqText(body, 'reason', 300));
  return { event, route: await getRoute(client, ctx, prev.id) };
}
