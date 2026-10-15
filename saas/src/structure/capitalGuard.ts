// RESPONSABLE DE CAPITAL (Capital por Administrador v16) en el servidor.
//
// Puerto de `reconcileRouteCapitalControllers` / `transitionRouteCapitalController`
// (src/services/capitalControlService.ts) sin copiar reglas: la elección y los
// importes salen de las funciones PURAS de CLEAN (`validRouteAdmins`,
// `isValidCapitalController`, `pickFirstAdmin`, `adminRoutePlacement`,
// `unattributedRouteCapital`). Lo propio del servidor es la concurrencia:
//
//   · se llama DENTRO de la transacción del comando, con las asignaciones ya escritas;
//   · bloquea la fila de cada ruta (FOR UPDATE, en orden de id) antes de decidir;
//   · relee administradores, asignaciones y capital de la ruta en esa transacción;
//   · PostgreSQL vuelve a comprobar al COMMIT que el responsable es NULL o un
//     Administrador activo asignado (disparadores diferidos de 0007, AX101), así que
//     ninguna carrera entre dos comandos puede dejar un responsable inválido.
//
// Importes en UNIDADES MENORES: las funciones de CLEAN solo suman, así que el
// resultado es exacto en cualquier unidad.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  adminRoutePlacement, isValidCapitalController, pickFirstAdmin, unattributedRouteCapital, validRouteAdmins,
  type CapitalRows,
} from '@/lib/capitalAllocation';
import type { CapitalLedgerEntry, RouteCapitalControllerEventKind, User } from '@/models/types';
import { ApiError } from '../errors.ts';
import { audit } from '../db/audit.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed, routeUnrestricted } from '../authz/cleanRules.ts';

type AdminRow = Pick<User, 'id' | 'rol' | 'status' | 'tenantId' | 'authorizedRouteIds' | 'createdAt' | 'nombre'>;

export interface ControllerEvent {
  eventId: string;
  routeId: string;
  kind: RouteCapitalControllerEventKind;
  fromMembershipId: string | null;
  toMembershipId: string | null;
  capitalTransferredMinor: number;
}

export interface ReconcileParams {
  routeIds: readonly string[];
  /** Administradores preferidos para la regla del «primer Admin» (orden de la operación). */
  preferredAdminIds?: readonly string[];
  /** Responsable elegido explícitamente por el SuperAdmin: ruta → membresía. */
  replacements?: Readonly<Record<string, string>>;
  /** Motivo del cambio explícito (obligatorio con `replacements`). */
  reason?: string;
}

async function companyAdmins(client: pg.PoolClient, ctx: ActiveContext): Promise<AdminRow[]> {
  const r = await client.query<{ id: string; status: 'activo' | 'inactivo'; display_name: string; created_at: Date; routes: string[] }>(
    `select m.id, m.status, m.display_name, m.created_at,
            coalesce(array_agg(mr.route_id::text order by mr.route_id) filter (where mr.route_id is not null), '{}') routes
       from adex.memberships m left join adex.membership_routes mr on mr.membership_id = m.id
      where m.company_id = $1 and m.role = 'admin'
      group by m.id`, [ctx.companyId]);
  return r.rows.map((m) => ({
    id: m.id, rol: 'admin', status: m.status, tenantId: ctx.companyId, authorizedRouteIds: m.routes,
    createdAt: m.created_at.toISOString(), nombre: m.display_name,
  }));
}

/** Filas de capital de UNA ruta: es todo lo que leen las funciones de importe. */
async function routeCapitalRows(client: pg.PoolClient, ctx: ActiveContext, routeId: string): Promise<CapitalRows> {
  // Con RLS, un actor sin la ruta vería CERO filas y el importe saldría mal: el actor
  // debe alcanzar la ruta (el SuperAdmin alcanza todas). Fallo cerrado.
  if (!routeUnrestricted(ctx)) {
    const ok = await client.query<{ ok: boolean }>('select adex.ctx_route_allowed($1) ok', [routeId]);
    if (!ok.rows[0]?.ok) throw new ApiError(403, 'PERMISSION_DENIED');
  }
  const q = <T extends pg.QueryResultRow>(sql: string) => client.query<T>(sql, [ctx.companyId, routeId]).then((r) => r.rows);
  const [movements, withdrawals, transfers, ledger] = await Promise.all([
    q<{ amount_minor: string; admin_membership_id: string | null }>(
      'select amount_minor, admin_membership_id from adex.capital_movements where company_id = $1 and route_id = $2'),
    q<{ amount_minor: string; admin_membership_id: string | null }>(
      'select amount_minor, admin_membership_id from adex.withdrawals where company_id = $1 and route_id = $2'),
    q<{ amount_minor: string; admin_membership_id: string | null; route_origin_id: string | null; route_destination_id: string | null; origin_type: 'route' | 'partner' | null; destination_type: 'route' | 'partner' | null }>(
      `select amount_minor, admin_membership_id, route_origin_id, route_destination_id, origin_type, destination_type
         from adex.transfers where company_id = $1 and (route_origin_id = $2 or route_destination_id = $2)`),
    q<{ id: string; amount_minor: string; from_admin_membership_id: string | null; to_admin_membership_id: string | null }>(
      `select id, amount_minor, from_admin_membership_id, to_admin_membership_id
         from adex.capital_ledger where company_id = $1 and route_id = $2 and kind = 'ROUTE_CONTROL_TRANSFER'`),
  ]);
  const n = (v: string) => Number(v);
  return {
    routes: [],
    capitalMovements: movements.map((m) => ({ routeId, valor: n(m.amount_minor), adminId: m.admin_membership_id ?? undefined })),
    withdrawals: withdrawals.map((w) => ({ routeId, valor: n(w.amount_minor), adminId: w.admin_membership_id ?? undefined })),
    transfers: transfers.map((t) => ({
      routeOrigenId: t.route_origin_id ?? '', routeDestinoId: t.route_destination_id ?? '', valor: n(t.amount_minor),
      origenType: t.origin_type ?? undefined, destinoType: t.destination_type ?? undefined, adminId: t.admin_membership_id ?? undefined,
    })),
    ledger: ledger.map((e) => ({
      id: e.id, tenantId: ctx.companyId, tipo: 'ROUTE_CONTROL_TRANSFER', amount: n(e.amount_minor), routeId,
      fromAdminId: e.from_admin_membership_id ?? undefined, toAdminId: e.to_admin_membership_id ?? undefined,
    } as CapitalLedgerEntry)),
  };
}

/** Un cambio de responsable: asientos + evento + ruta, en la transacción del comando. */
async function transition(client: pg.PoolClient, ctx: ActiveContext, route: { id: string; name: string; controller: string | null },
  kind: RouteCapitalControllerEventKind, toAdminId: string | null, reason: string): Promise<ControllerEvent> {
  const rows = await routeCapitalRows(client, ctx, route.id);
  const fromAdminId = route.controller;
  const carried = fromAdminId ? adminRoutePlacement(fromAdminId, route.id, rows) : 0;
  const unattributed = unattributedRouteCapital(route.id, rows);
  const eventId = randomUUID();
  const entries: { id: string; amount: number; from: string | null; to: string | null; description: string }[] = [];
  if (fromAdminId && carried !== 0) {
    entries.push({ id: randomUUID(), amount: carried, from: fromAdminId, to: toAdminId,
      description: toAdminId ? `Traspaso de responsabilidad de la ruta ${route.name}` : `La ruta ${route.name} queda sin responsable de capital` });
  }
  if (toAdminId && unattributed !== 0) {
    entries.push({ id: randomUUID(), amount: unattributed, from: null, to: toAdminId,
      description: `Capital existente de la ruta ${route.name} reconocido en la bolsa de su responsable` });
  }
  // Fecha contable en la zona horaria de la EMPRESA, no la del servidor.
  const entryDate = entries.length
    ? (await client.query<{ d: string }>('select (now() at time zone timezone)::date d from adex.companies where id = $1', [ctx.companyId])).rows[0]!.d
    : null;
  for (const e of entries) {
    await client.query(
      `insert into adex.capital_ledger (id, company_id, kind, amount_minor, from_admin_membership_id, to_admin_membership_id, route_id,
                                        related_event_id, description, entry_date, created_at, actor_membership_id, actor_role, status, sync_status)
       values ($1, $2, 'ROUTE_CONTROL_TRANSFER', $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, 'aplicado', 'synced')`,
      [e.id, ctx.companyId, e.amount, e.from, e.to, route.id, eventId, e.description, entryDate, ctx.membershipId, ctx.role]);
  }
  const transferred = (fromAdminId ? carried : 0) + (toAdminId ? unattributed : 0);
  // `base_at_change_minor` queda NULL: la Base de la ruta la calcula el servidor desde
  // la Fase 3 (caja). Es un dato informativo; ningún saldo depende de él.
  await client.query(
    `insert into adex.route_capital_controller_events (id, company_id, route_id, kind, from_admin_membership_id, to_admin_membership_id,
                                                       capital_transferred_minor, ledger_entry_id, reason, created_at, actor_membership_id,
                                                       actor_role, sync_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, 'synced')`,
    [eventId, ctx.companyId, route.id, kind, fromAdminId, toAdminId, transferred, entries[0]?.id ?? null, reason, ctx.membershipId, ctx.role]);
  await client.query(
    `update adex.routes set capital_controller_membership_id = $3, capital_controller_since = case when $4 then now() end,
            updated_at = now() where company_id = $1 and id = $2`, [ctx.companyId, route.id, toAdminId, toAdminId !== null]);
  await audit(client, ctx, {
    action: 'ROUTE_CAPITAL_CONTROLLER_CHANGED', entityType: 'route', entityId: route.id, routeId: route.id,
    description: `Responsable de capital de ${route.name}: ${fromAdminId ?? 'ninguno'} → ${toAdminId ?? 'ninguno'} (${kind}).`,
    before: { capitalControllerMembershipId: fromAdminId }, after: { capitalControllerMembershipId: toAdminId, capitalTransferredMinor: transferred, eventId },
    reason,
  });
  route.controller = toAdminId;
  return { eventId, routeId: route.id, kind, fromMembershipId: fromAdminId, toMembershipId: toAdminId, capitalTransferredMinor: transferred };
}

/** Bloquea las filas de las rutas en orden de id (sin interbloqueos entre comandos). */
export async function lockRoutes(client: pg.PoolClient, ctx: ActiveContext, routeIds: readonly string[]): Promise<void> {
  const ids = [...new Set(routeIds)].sort();
  if (ids.length) await client.query('select id from adex.routes where company_id = $1 and id = any($2) order by id for update', [ctx.companyId, ids]);
}

/**
 * Coherencia del responsable de capital de `routeIds` tras un cambio de asignaciones,
 * estado o rol (misma semántica que `reconcileRouteCapitalControllers`):
 *   · cambio explícito (SuperAdmin) → CHANGE con traspaso;
 *   · responsable vigente válido → nada;
 *   · responsable inválido y quedan otros Administradores válidos → 409: el
 *     SuperAdmin debe elegir antes (nunca se elige a nadie en silencio);
 *   · responsable inválido y no queda ninguno → RELEASE;
 *   · sin responsable y con Administradores válidos → FIRST_ADMIN (preferido o el
 *     primero estable de `pickFirstAdmin`).
 */
export async function reconcileControllers(client: pg.PoolClient, ctx: ActiveContext, p: ReconcileParams): Promise<ControllerEvent[]> {
  const events: ControllerEvent[] = [];
  const ids = [...new Set(p.routeIds)].sort();
  if (!ids.length) return events;
  await lockRoutes(client, ctx, ids);
  const admins = await companyAdmins(client, ctx);
  const routes = await client.query<{ id: string; name: string; capital_controller_membership_id: string | null }>(
    'select id, name, capital_controller_membership_id from adex.routes where company_id = $1 and id = any($2) order by id', [ctx.companyId, ids]);
  for (const r of routes.rows) {
    const route = { id: r.id, name: r.name, controller: r.capital_controller_membership_id };
    const cleanRoute = { id: r.id, tenantId: ctx.companyId };
    const valid = validRouteAdmins(admins, cleanRoute);
    const chosen = p.replacements?.[r.id];
    if (chosen && chosen !== route.controller) {
      if (!allowed(ctx, 'capital.assignController')) throw new ApiError(403, 'PERMISSION_DENIED');
      if (!valid.some((a) => a.id === chosen)) throw new ApiError(409, 'CAPITAL_CONTROLLER_INVALID', 'the new controller must be an active Administrator assigned to the route');
      events.push(await transition(client, ctx, route, 'CHANGE', chosen, p.reason ?? 'Cambio de responsable al editar las asignaciones'));
      continue;
    }
    if (route.controller) {
      if (isValidCapitalController(admins.find((a) => a.id === route.controller), cleanRoute)) continue;
      if (valid.length > 0) {
        throw new ApiError(409, 'CAPITAL_CONTROLLER_REQUIRED',
          `route ${r.name}: choose another capital controller first`, { routeId: r.id, candidates: valid.map((a) => a.id) });
      }
      events.push(await transition(client, ctx, route, 'RELEASE', null,
        'La ruta quedó sin Administradores válidos: operaciones de caja bloqueadas hasta asignar un responsable'));
      continue;
    }
    if (!valid.length) continue;
    const preferred = (p.preferredAdminIds ?? []).map((id) => valid.find((v) => v.id === id)).find(Boolean);
    const first = preferred ?? pickFirstAdmin(valid, r.id, []);
    events.push(await transition(client, ctx, route, 'FIRST_ADMIN', first!.id, 'Primer Administrador válido asignado a la ruta'));
  }
  return events;
}

/** SuperAdmin cambia el responsable de capital (`setRouteCapitalController`). */
export async function setRouteController(client: pg.PoolClient, ctx: ActiveContext, routeId: string, membershipId: string, reason: string): Promise<ControllerEvent> {
  if (!allowed(ctx, 'capital.assignController')) throw new ApiError(403, 'PERMISSION_DENIED');
  if (reason.trim().length < 3) throw new ApiError(400, 'REASON_REQUIRED');
  await lockRoutes(client, ctx, [routeId]);
  const r = await client.query<{ capital_controller_membership_id: string | null }>(
    'select capital_controller_membership_id from adex.routes where company_id = $1 and id = $2', [ctx.companyId, routeId]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  if (r.rows[0].capital_controller_membership_id === membershipId) throw new ApiError(409, 'ALREADY_CONTROLLER');
  const [event] = await reconcileControllers(client, ctx, { routeIds: [routeId], replacements: { [routeId]: membershipId }, reason: reason.trim() });
  return event!;
}
