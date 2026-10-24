// NOTIFICACIONES (Ronda 59): bandeja del contexto activo, derivada de los registros del servidor
// (solicitudes, traspasos y operaciones de capital) con la RLS de quien consulta. No hay una tabla
// de avisos ni nada que «marcar como leído»: lo que requiere acción es lo que sigue pendiente.
//
//   Requieren acción  solicitudes que le toca atender · confirmaciones de traspasos registrados
//                     por Secretario (y directos anteriores a la Ronda 59 aún pendientes)
//   En espera         solicitudes que la persona hizo y siguen pendientes
//   Informativas      últimos 30 días: capital recibido, devuelto o recogido, entregas de efectivo,
//                     traspasos recibidos y resoluciones de sus solicitudes
//
// El contador (`/v1/notifications/count`) cuenta SOLO lo que requiere acción. Nunca lleva saldos:
// importes de movimientos que la persona ya puede ver, nombres y estados.

import type pg from 'pg';
import type { ActiveContext } from '../authz/context.ts';
import { holds, memberNames, requestView, type RequestRow } from './requests.ts';
import { jointToConfirm } from './corrections.ts';

const INFO_DAYS = 30;
const INFO_LIMIT = 60;

interface TransferRow {
  id: string; mode: 'direct' | 'secretary'; state: string; amount_minor: string; reason: string; created_at: Date; closed_at: Date | null;
  origin_admin_membership_id: string; destination_admin_membership_id: string; registered_by_membership_id: string;
  origin_decision: string; destination_decision: string; closed_by_membership_id: string | null; close_reason: string | null;
}

interface OpRow {
  id: string; kind: string; amount_minor: string; route_id: string | null; admin_membership_id: string | null; worker_membership_id: string | null;
  counterpart_membership_id: string | null; actor_membership_id: string; actor_role: string; reason: string; created_at: Date;
}

/** Traspasos en los que la persona debe decidir su parte. */
function mustDecide(t: TransferRow, me: string): boolean {
  return t.state === 'pending'
    && ((t.origin_admin_membership_id === me && t.origin_decision === 'pending') || (t.destination_admin_membership_id === me && t.destination_decision === 'pending'));
}

/** Qué operaciones de capital avisan a quién (tipo de aviso según el rol activo). */
function opNotice(o: OpRow, ctx: ActiveContext): string | null {
  const me = ctx.membershipId;
  if (o.actor_membership_id === me) return null;
  if (ctx.role === 'admin') {
    if (o.kind === 'ADMIN_ALLOCATION' && o.admin_membership_id === me) return 'capital-received';
    if (o.kind === 'ADMIN_RETURN' && o.admin_membership_id === me) return 'capital-collected';
    if (o.kind === 'WORKER_RETURN' && o.admin_membership_id === me && o.actor_role === 'cobrador') return 'cash-delivered';
    // R74 Base por Ruta (0034, O11): transferencia recibida en una ruta de la que es responsable (inmediata, sin aceptación).
    if (o.kind === 'ROUTE_TRANSFER' && o.counterpart_membership_id === me) return 'route-transfer-received';
  }
  if (ctx.role === 'superadmin' && o.kind === 'ADMIN_RETURN' && o.actor_role === 'admin') return 'capital-returned';
  if (ctx.role === 'cobrador' && o.worker_membership_id === me) {
    if (o.kind === 'WORKER_DELIVERY') return 'capital-delivered';
    if (o.kind === 'WORKER_RETURN') return 'return-registered';
  }
  return null;
}

const OP_KINDS: Record<string, readonly string[]> = {
  admin: ['ADMIN_ALLOCATION', 'ADMIN_RETURN', 'WORKER_RETURN', 'ROUTE_TRANSFER'],
  superadmin: ['ADMIN_RETURN'],
  cobrador: ['WORKER_DELIVERY', 'WORKER_RETURN'],
};

async function visibleRequests(client: pg.PoolClient, ctx: ActiveContext): Promise<RequestRow[]> {
  return (await client.query<RequestRow>(
    `select * from adex.capital_requests
      where company_id = $1 and (state = 'pending' or resolved_at > now() - make_interval(days => $2))
        and (requester_membership_id = $3 or holder_membership_id = $3 or (holder_membership_id is null and $4 = 'superadmin'))
      order by created_at desc, id limit 200`, [ctx.companyId, INFO_DAYS, ctx.membershipId, ctx.role])).rows;
}

async function partyTransfers(client: pg.PoolClient, ctx: ActiveContext): Promise<TransferRow[]> {
  if (ctx.role !== 'admin') return [];
  return (await client.query<TransferRow>(
    `select * from adex.admin_transfers
      where company_id = $1 and $2 in (origin_admin_membership_id, destination_admin_membership_id)
        and (state = 'pending' or closed_at > now() - make_interval(days => $3))
      order by created_at desc, id limit 200`, [ctx.companyId, ctx.membershipId, INFO_DAYS])).rows;
}

export async function notificationCount(client: pg.PoolClient, ctx: ActiveContext) {
  const r = await client.query<{ n: string }>(
    `select (select count(*) from adex.capital_requests where company_id = $1 and state = 'pending'
               and (holder_membership_id = $2 or (holder_membership_id is null and $3 = 'superadmin'))
               and requester_membership_id <> $2)
          + (select count(*) from adex.admin_transfers where company_id = $1 and state = 'pending' and $3 = 'admin'
               and ((origin_admin_membership_id = $2 and origin_decision = 'pending') or (destination_admin_membership_id = $2 and destination_decision = 'pending')))
          -- R74 Base por Ruta (0034, O5): entregas de ruta pendientes de SU conteo.
          + (select count(*) from adex.route_handover_records where company_id = $1 and status = 'pendiente' and to_membership_id = $2 and $3 = 'admin') n`,
    [ctx.companyId, ctx.membershipId, ctx.role]);
  // R74 (0037): anulaciones coordinadas que esperan SU confirmación.
  return { actionRequired: Number(r.rows[0]!.n) + (await jointToConfirm(client, ctx)).length };
}

export async function notifications(client: pg.PoolClient, ctx: ActiveContext) {
  const me = ctx.membershipId;
  const [requests, transfers] = [await visibleRequests(client, ctx), await partyTransfers(client, ctx)];
  const kinds = OP_KINDS[ctx.role] ?? [];
  const ops = kinds.length === 0 ? [] : (await client.query<OpRow>(
    `select id, kind, amount_minor, route_id, admin_membership_id, worker_membership_id, counterpart_membership_id, actor_membership_id, actor_role,
            reason, created_at
       from adex.capital_operations
      where company_id = $1 and kind = any($2) and reverses_operation_id is null and created_at > now() - make_interval(days => $3)
        and actor_membership_id <> $4
        and ($5 = 'superadmin' or admin_membership_id = $4 or worker_membership_id = $4 or counterpart_membership_id = $4)
      order by created_at desc, id limit $6`, [ctx.companyId, kinds, INFO_DAYS, me, ctx.role, INFO_LIMIT * 2])).rows;

  const names = await memberNames(client, ctx, [
    ...requests.flatMap((r) => [r.requester_membership_id, r.holder_membership_id, r.resolved_by_membership_id]),
    ...transfers.flatMap((t) => [t.origin_admin_membership_id, t.destination_admin_membership_id, t.registered_by_membership_id, t.closed_by_membership_id]),
    ...ops.flatMap((o) => [o.actor_membership_id, o.admin_membership_id, o.worker_membership_id]),
  ]);
  const name = (id: string | null) => (id ? names.get(id) ?? null : null);
  const transferView = (t: TransferRow) => ({
    id: t.id, mode: t.mode, state: t.state, amountMinor: Number(t.amount_minor), reason: t.reason,
    origin: { adminId: t.origin_admin_membership_id, name: name(t.origin_admin_membership_id), decision: t.origin_decision },
    destination: { adminId: t.destination_admin_membership_id, name: name(t.destination_admin_membership_id), decision: t.destination_decision },
    registeredBy: { membershipId: t.registered_by_membership_id, name: name(t.registered_by_membership_id) },
    mySide: t.origin_admin_membership_id === me ? 'origin' : 'destination', closeReason: t.close_reason,
  });

  const actionRequired: unknown[] = [];
  const waiting: unknown[] = [];
  const info: { at: string; item: unknown }[] = [];
  // Una operación que atendió una solicitud propia se avisa una vez (como resolución de la solicitud).
  const fulfilledForMe = new Set(requests.filter((r) => r.requester_membership_id === me && r.fulfilled_operation_id).map((r) => r.fulfilled_operation_id!));
  const fulfilledTransfersForMe = new Set(requests.filter((r) => r.requester_membership_id === me && r.fulfilled_transfer_id).map((r) => r.fulfilled_transfer_id!));

  for (const r of requests) {
    const v = requestView(r, ctx, names);
    if (r.state === 'pending') {
      if (holds(r, ctx) && r.requester_membership_id !== me) actionRequired.push({ type: 'request', at: v.createdAt, request: v });
      else if (r.requester_membership_id === me) waiting.push({ type: 'request', at: v.createdAt, request: v });
    } else if (r.resolved_by_membership_id !== me && (r.requester_membership_id === me || holds(r, ctx))) {
      info.push({ at: v.resolvedAt!, item: { type: 'request-resolved', at: v.resolvedAt, request: v } });
    }
  }
  for (const t of transfers) {
    if (mustDecide(t, me)) actionRequired.push({ type: 'transfer-confirmation', at: t.created_at.toISOString(), transfer: transferView(t) });
    else if (t.state !== 'pending' && t.closed_by_membership_id !== me && t.closed_at && !fulfilledTransfersForMe.has(t.id)) {
      const received = t.state === 'applied' && t.destination_admin_membership_id === me;
      if (received || t.state !== 'applied') {
        info.push({ at: t.closed_at.toISOString(), item: { type: received ? 'transfer-received' : 'transfer-closed', at: t.closed_at.toISOString(), transfer: transferView(t) } });
      }
    }
  }
  // R74 Base por Ruta (0034, O5): el nuevo responsable debe confirmar el conteo de la Base.
  if (ctx.role === 'admin') {
    const h = await client.query<{ id: string; route_id: string; route_name: string; from_membership_id: string | null; base_at_start_minor: string; started_at: Date }>(
      `select h.id, h.route_id, r.name route_name, h.from_membership_id, h.base_at_start_minor, h.started_at
         from adex.route_handover_records h join adex.routes r on r.company_id = h.company_id and r.id = h.route_id
        where h.company_id = $1 and h.status = 'pendiente' and h.to_membership_id = $2 order by h.started_at desc, h.id`, [ctx.companyId, me]);
    for (const x of h.rows) {
      actionRequired.push({ type: 'handover-confirmation', at: x.started_at.toISOString(), handover: { id: x.id, routeId: x.route_id, routeName: x.route_name,
        fromId: x.from_membership_id, baseAtStartMinor: Number(x.base_at_start_minor) } });
    }
  }
  // R74 (0037): anulación coordinada de una operación conjunta: el responsable de una ruta afectada confirma SU parte.
  for (const p of await jointToConfirm(client, ctx)) {
    actionRequired.push({ type: 'joint-reversal-confirmation', at: String(p['createdAt']), proposal: p });
  }
  for (const o of ops) {
    const type = opNotice(o, ctx);
    if (!type || fulfilledForMe.has(o.id)) continue;
    info.push({ at: o.created_at.toISOString(), item: {
      type, at: o.created_at.toISOString(),
      operation: { id: o.id, kind: o.kind, amountMinor: Number(o.amount_minor), routeId: o.route_id, reason: o.reason,
        actor: { membershipId: o.actor_membership_id, name: name(o.actor_membership_id), role: o.actor_role },
        adminId: o.admin_membership_id, adminName: name(o.admin_membership_id), workerId: o.worker_membership_id, workerName: name(o.worker_membership_id) },
    } });
  }
  info.sort((a, b) => b.at.localeCompare(a.at));
  return { actionRequired, waiting, info: info.slice(0, INFO_LIMIT).map((x) => x.item), count: actionRequired.length, days: INFO_DAYS };
}
