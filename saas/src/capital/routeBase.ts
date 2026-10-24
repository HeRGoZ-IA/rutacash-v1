// BASE POR RUTA (R74, migración 0034): núcleo de la API. Solo actúa cuando la empresa tiene
// `companies.capital_model = 'route_base'`; con `admin_pool` (toda empresa actual) estos comandos
// responden ROUTE_BASE_NOT_ACTIVE y todo lo demás sigue exactamente igual.
//
//   · La Base es de la RUTA (`route_base`, nunca negativa) y la mueve su Administrador responsable
//     vigente: inyección (contrapartida `route_funding` de la ruta), retiro (tope el saldo), entrega a
//     cobradores y recepción de devoluciones (comandos de siempre: capital/service.ts).
//   · Transferencia entre rutas (O11): la inicia el responsable de la ruta de ORIGEN, también hacia una
//     ruta de otro responsable; es inmediata y el destino la ve (operación visible + aviso derivado).
//   · Saldo «sin asignar» (O3): lo que quedó en la bolsa de un Administrador al activar el modelo; solo
//     lo reparte ese Administrador a una ruta de la que es responsable (`LEGACY_POOL_TO_ROUTE`).
//   · Entrega controlada (O5): al cambiar el responsable la ruta queda «en entrega» hasta que el nuevo
//     responsable confirma el conteo; la diferencia queda en un acta, sin movimientos.
//   · Activación (O6): el SuperAdmin autoriza el modelo con requisitos comprobados en PostgreSQL.
//   · Panel (`adex.route_panel`): una fila por ruta con Base, custodias, cartera, resultado operativo
//     básico, flujo, necesidad de capital, estados O9 y alertas; gastos generales aparte.
//
// Segunda barrera en PostgreSQL (`adex.route_base_post`, `adex.route_handover_confirm`,
// `adex.capital_model_transition`, guardianes de 0034). Errores sin cifras de saldos.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed } from '../authz/cleanRules.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { oneOf, optText, pathId, reqId, reqText } from '../structure/input.ts';
import {
  ACTIONS, amountOf, opView, reasonOf, requireAuthority, requireOperationId, routeOf, visibleEntries, type CapitalKind, type OpRow,
} from './service.ts';
import { requireControlsAllRoutesOr, requireOpenPeriods } from './corrections.ts';

type Body = Record<string, unknown>;

export const INJECT_FIELDS = ['routeId', 'amountMinor', 'reason', 'sourceNote'] as const;
export const WITHDRAW_FIELDS = ['routeId', 'amountMinor', 'reason'] as const;
export const TRANSFER_FIELDS = ['fromRouteId', 'toRouteId', 'amountMinor', 'reason'] as const;
export const ASSIGN_FIELDS = ['routeId', 'amountMinor', 'reason', 'evidence'] as const;
export const MODEL_FIELDS = ['target', 'evidence', 'backupReference', 'companyBalanceNote'] as const;
export const HANDOVER_FIELDS = ['countedMinor', 'expectedSeenMinor', 'note'] as const;

/** Solo el Administrador mueve la Base (E2). El resto, 403 antes de tocar nada. */
function requireAdmin(ctx: ActiveContext): void {
  if (ctx.role !== 'admin') throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only the responsible administrator moves the base of a route');
}

async function post(client: pg.PoolClient, ctx: ActiveContext, operationId: string | null,
  p: { kind: CapitalKind | 'REVERSAL'; amount: number | null; reason: string; route: string | null; toRoute?: string | null; reverses?: string | null },
  description: string) {
  const r = await client.query<OpRow>('select * from adex.route_base_post($1, $2, $3, $4, $5, $6, $7)',
    [requireOperationId(operationId), p.kind, p.amount, p.reason, p.route, p.toRoute ?? null, p.reverses ?? null]);
  const op = r.rows[0]!;
  const view = opView(op);
  await audit(client, ctx, {
    action: p.kind === 'REVERSAL' ? 'CAPITAL_OPERATION_REVERSED' : ACTIONS[p.kind], entityType: 'capital_operation', entityId: op.id,
    routeId: op.route_id, description, reason: p.reason,
    after: { kind: view.kind, amountMinor: view.amountMinor, currencyCode: view.currencyCode, routeId: view.routeId, toRouteId: view.toRouteId,
      adminId: view.adminId, counterpartId: view.counterpartId, reversesOperationId: view.reversesOperationId, entryDate: view.entryDate },
    metadata: { operationId: op.operation_id },
  });
  return { operation: view, entries: await visibleEntries(client, ctx, op.id) };
}

/** Ruta de origen del alcance del actor con el actor como responsable (`structural` de CLEAN). */
async function controlledRoute(client: pg.PoolClient, ctx: ActiveContext, routeId: string) {
  requireAdmin(ctx);
  const route = await routeOf(client, ctx, routeId);
  need(ctx, 'capital.manage', { routeId: route.id });
  requireAuthority(ctx, route, 'structural', await loadMembers(client, ctx));
  return route;
}

// ============================================================
// Comandos de la Base
// ============================================================

/** Inyección de Base: aporte a la ruta (el origen externo es solo una nota; no se registra patrimonio). */
export async function injectBase(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const route = await controlledRoute(client, ctx, reqId(body, 'routeId'));
  const amount = amountOf(body);
  const source = optText(body, 'sourceNote', 120);
  const reason = reasonOf(body);
  const full = source ? `${reason} · Origen: ${source}`.slice(0, 300) : reason;
  return post(client, ctx, operationId, { kind: 'ROUTE_BASE_INJECTION', amount, reason: full, route: route.id },
    `Inyección de Base ${amount} en ${route.name}.`);
}

/** Retiro de Base (O10: un solo concepto, sin «ganancia retirable»). Nunca más que el saldo de la Base. */
export async function withdrawBase(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const route = await controlledRoute(client, ctx, reqId(body, 'routeId'));
  const amount = amountOf(body);
  return post(client, ctx, operationId, { kind: 'ROUTE_BASE_WITHDRAWAL', amount, reason: reasonOf(body), route: route.id },
    `Retiro de Base ${amount} de ${route.name}.`);
}

/**
 * Transferencia entre rutas (O11): la registra el responsable de la ruta de ORIGEN; el destino puede
 * ser de otro responsable (fuera del alcance del actor: lo valida PostgreSQL bajo bloqueo). Inmediata.
 */
export async function transferBase(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const from = await controlledRoute(client, ctx, reqId(body, 'fromRouteId'));
  const toRouteId = reqId(body, 'toRouteId');
  if (toRouteId === from.id) throw new ApiError(400, 'INVALID_INPUT', 'routes must differ', { field: 'toRouteId' });
  const amount = amountOf(body);
  const dest = (await client.query<{ name: string }>('select name from adex.route_transfer_destinations() where route_id = $1', [toRouteId])).rows[0];
  return post(client, ctx, operationId, { kind: 'ROUTE_TRANSFER', amount, reason: reasonOf(body), route: from.id, toRoute: toRouteId },
    `Transferencia de Base ${amount}: ${from.name} → ${dest?.name ?? toRouteId}.`);
}

/** O3: reparto de saldo «sin asignar» de la bolsa propia a una ruta de la que el actor es responsable. */
export async function assignUnassigned(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  const route = await controlledRoute(client, ctx, reqId(body, 'routeId'));
  const amount = amountOf(body);
  const evidence = reqText(body, 'evidence', 200);
  if (evidence.length < 10) throw new ApiError(400, 'INVALID_INPUT', 'evidence is required (10+ characters)', { field: 'evidence' });
  const reason = `${reasonOf(body)} · Evidencia: ${evidence}`.slice(0, 300);
  return post(client, ctx, operationId, { kind: 'LEGACY_POOL_TO_ROUTE', amount, reason, route: route.id },
    `Capital sin asignar ${amount} de ${ctx.displayName} asignado a ${route.name} (confirmado por el Administrador).`);
}

/** Anulación de una inyección (desde `reverseOperation`): solo el responsable vigente, si la Base aún la tiene. */
export async function reverseRouteBase(client: pg.PoolClient, ctx: ActiveContext, orig: OpRow, reason: string, operationId: string | null) {
  // R74 (0037): también retiros (vuelven a la Base) y transferencias. Una transferencia saca dinero de la Base de
  // destino: el actor controla LAS DOS rutas o, con responsables distintos, 409 con la anulación coordinada.
  if (orig.kind === 'ROUTE_TRANSFER' && orig.route_id && orig.to_route_id) {
    requireAdmin(ctx);
    await requireControlsAllRoutesOr(client, ctx, [orig.route_id, orig.to_route_id],
      { kind: 'route_transfer', id: orig.id, amountMinor: Number(orig.amount_minor), label: `Transferencia entre rutas: ${orig.reason}` });
    await requireOpenPeriods(client, ctx, [orig.route_id, orig.to_route_id]);
  } else if (orig.route_id) {
    await controlledRoute(client, ctx, orig.route_id);
    if (orig.kind !== 'REVERSAL') await requireOpenPeriods(client, ctx, [orig.route_id]);
  } else requireAdmin(ctx);
  return post(client, ctx, operationId, { kind: 'REVERSAL', amount: null, reason, route: orig.route_id, reverses: orig.id },
    `Anulación de ${orig.kind} ${Number(orig.amount_minor)}.`);
}

/** Rutas destino posibles (nombre, código y responsable; nunca saldos). */
export async function transferDestinations(client: pg.PoolClient, ctx: ActiveContext) {
  requireAdmin(ctx);
  const r = await client.query<{ route_id: string; name: string; code: string | null; controller_id: string; controller_name: string; in_scope: boolean }>(
    'select * from adex.route_transfer_destinations()');
  return r.rows.map((x) => ({ routeId: x.route_id, name: x.name, code: x.code, controllerId: x.controller_id, controllerName: x.controller_name, inScope: x.in_scope }));
}

// ============================================================
// Entrega controlada (O5)
// ============================================================

interface HandoverRow {
  id: string; route_id: string; from_membership_id: string | null; to_membership_id: string; status: string; base_at_start_minor: string;
  custody_at_start_minor: string; started_at: Date; started_by_membership_id: string | null; expected_base_minor: string | null;
  counted_minor: string | null; difference_minor: string | null; note: string | null; confirmed_at: Date | null; confirmed_by_membership_id: string | null;
  superseded_at: Date | null;
}
const num = (v: string | null) => (v === null ? null : Number(v));
const handoverView = (h: HandoverRow) => ({
  id: h.id, routeId: h.route_id, fromId: h.from_membership_id, toId: h.to_membership_id, status: h.status,
  baseAtStartMinor: Number(h.base_at_start_minor), custodyAtStartMinor: Number(h.custody_at_start_minor), startedAt: h.started_at.toISOString(),
  startedById: h.started_by_membership_id, expectedBaseMinor: num(h.expected_base_minor), countedMinor: num(h.counted_minor),
  differenceMinor: num(h.difference_minor), note: h.note, confirmedAt: h.confirmed_at?.toISOString() ?? null,
  confirmedById: h.confirmed_by_membership_id, supersededAt: h.superseded_at?.toISOString() ?? null,
});

/** Actas de entrega visibles (RLS): SuperAdmin todas; Administrador/Supervisor las de su alcance; las propias. */
export async function listHandovers(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  if (routeId !== null) pathId(routeId);
  const status = q.get('status');
  if (status !== null && !['pendiente', 'confirmada', 'sustituida'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', 'status is invalid', { field: 'status' });
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  if (routeId) { params.push(routeId); where += ` and route_id = $${params.length}`; }
  if (status) { params.push(status); where += ` and status = $${params.length}`; }
  const r = await client.query<HandoverRow>(`select * from adex.route_handover_records where ${where} order by started_at desc, id limit 200`, params);
  // Para la vista previa del conteo: el saldo de la Base que verá el nuevo responsable (RLS).
  const bases = new Map((await client.query<{ route_id: string; b: string }>(
    `select route_id, balance_minor::text b from adex.capital_accounts where company_id = $1 and kind = 'route_base' and route_id = any($2)`,
    [ctx.companyId, [...new Set(r.rows.map((h) => h.route_id))]])).rows.map((x) => [x.route_id, Number(x.b)]));
  return r.rows.map((h) => ({ ...handoverView(h), currentBaseMinor: h.status === 'pendiente' ? bases.get(h.route_id) ?? 0 : null }));
}

/** El nuevo responsable confirma el conteo: acta con la diferencia; el libro no se toca. */
export async function confirmHandover(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body, operationId: string | null) {
  requireAdmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const int = (k: string) => {
    const v = body[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApiError(400, 'INVALID_INPUT', `${k} must be an integer >= 0 (minor units)`, { field: k });
    return v;
  };
  const counted = int('countedMinor');
  const expected = int('expectedSeenMinor');
  const note = optText(body, 'note', 500);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_handover_confirm($1, $2, $3, $4, $5) r',
    [requireOperationId(operationId), route.id, counted, expected, note])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ROUTE_HANDOVER_CONFIRMED', entityType: 'route_handover', entityId: String(r['handoverId']), routeId: route.id,
    description: `Entrega de ${route.name} confirmada: contado ${counted}, esperado ${String(r['expectedBaseMinor'])}, diferencia ${String(r['differenceMinor'])}.`,
    reason: note, after: r, metadata: { operationId },
  });
  return r;
}

// ============================================================
// Modelo de capital (O6)
// ============================================================

export async function capitalModel(client: pg.PoolClient, ctx: ActiveContext) {
  const c = (await client.query<{ capital_model: string; route_base_since: Date | null }>(
    'select capital_model, route_base_since from adex.companies where id = $1', [ctx.companyId])).rows[0];
  if (!c) throw new ApiError(404, 'NOT_FOUND');
  const a = await client.query<{ id: string; from_model: string; to_model: string; evidence: string; backup_reference: string | null;
    company_balance_note: string | null; unassigned_pools: unknown; actor_membership_id: string; created_at: Date }>(
    'select * from adex.capital_model_activations where company_id = $1 order by created_at, id', [ctx.companyId]);
  return {
    model: c.capital_model, routeBaseSince: c.route_base_since?.toISOString() ?? null,
    activations: a.rows.map((x) => ({ id: x.id, fromModel: x.from_model, toModel: x.to_model, evidence: x.evidence, backupReference: x.backup_reference,
      companyBalanceNote: x.company_balance_note, unassignedPools: x.unassigned_pools, actorId: x.actor_membership_id, createdAt: x.created_at.toISOString() })),
  };
}

export async function modelPrerequisites(client: pg.PoolClient, ctx: ActiveContext) {
  need(ctx, 'capital.allocateAdmins');
  return (await client.query<{ r: unknown }>('select adex.capital_model_prerequisites() r')).rows[0]!.r;
}

/** SuperAdmin: admin_pool → migrating → route_base (o admin_pool → route_base); migrating → admin_pool aborta. */
export async function transitionModel(client: pg.PoolClient, ctx: ActiveContext, body: Body, operationId: string | null) {
  need(ctx, 'capital.allocateAdmins');
  const target = oneOf(body, 'target', ['admin_pool', 'migrating', 'route_base'] as const);
  const evidence = reqText(body, 'evidence', 1000);
  const backup = optText(body, 'backupReference', 300);
  const note = optText(body, 'companyBalanceNote', 500);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.capital_model_transition($1, $2, $3, $4, $5) r',
    [requireOperationId(operationId), target, evidence, backup, note])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'CAPITAL_MODEL_CHANGED', entityType: 'company', entityId: ctx.companyId, routeId: null,
    description: `Modelo de capital: ${String(r['fromModel'])} → ${target}.`, reason: evidence,
    after: { model: target, routeBaseSince: r['routeBaseSince'], backupReference: backup, unassignedPools: r['unassignedPools'] },
    metadata: { operationId, activationId: r['activationId'] },
  });
  return r;
}

// ============================================================
// Panel por ruta / Caja principal consolidada
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function routePanel(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  if (!allowed(ctx, 'cashbox.viewRoute')) throw new ApiError(403, 'PERMISSION_DENIED');
  const today = (await client.query<{ d: string }>('select adex.business_today($1)::text d', [ctx.companyId])).rows[0]!.d;
  const from = q.get('from') ?? today;
  const to = q.get('to') ?? today;
  for (const [k, v] of [['from', from], ['to', to]] as const) if (!DATE_RE.test(v)) throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`, { field: k });
  if (to < from) throw new ApiError(400, 'INVALID_INPUT', 'to before from', { field: 'to' });
  return (await client.query<{ r: unknown }>('select adex.route_panel($1::date, $2::date) r', [from, to])).rows[0]!.r;
}

