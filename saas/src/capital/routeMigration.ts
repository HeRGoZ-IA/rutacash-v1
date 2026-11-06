// MIGRACIÓN DE RUTAS CON HISTORIAL (migración 0043, parte 1). Diseño: docs/ADEX_DISENO_MIGRACION_RUTAS_2026-11.md.
//
//   · Una ruta `en_migracion` sigue operando en el sistema anterior (Listos); en ADEX es de solo lectura.
//     El bloqueo de escrituras está en PostgreSQL (triggers): cualquier comando sobre esa ruta responde
//     409 ROUTE_IN_MIGRATION.
//   · Abre y cancela la migración SOLO el SuperAdmin, sobre una ruta activa y vacía (PostgreSQL lo comprueba:
//     `adex.route_migration_open` / `adex.route_migration_cancel`).
//   · La carga de datos y el paso a normal con el conteo de caja llegan en la parte 2.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { optText, pathId, reqText } from '../structure/input.ts';
import { requireOperationId, routeOf } from './service.ts';

type Body = Record<string, unknown>;

export const MIGRATION_OPEN_FIELDS = ['sourceRouteName', 'note'] as const;
export const MIGRATION_CANCEL_FIELDS = ['reason'] as const;

interface MigrationRow {
  id: string; route_id: string; status: string; source_system: string; source_route_name: string; note: string | null;
  opened_at: Date; opened_by_membership_id: string; closed_at: Date | null; closed_by_membership_id: string | null; close_reason: string | null;
}

const view = (m: MigrationRow) => ({
  id: m.id, routeId: m.route_id, status: m.status, sourceSystem: m.source_system, sourceRouteName: m.source_route_name, note: m.note,
  openedAt: m.opened_at.toISOString(), openedById: m.opened_by_membership_id,
  closedAt: m.closed_at?.toISOString() ?? null, closedById: m.closed_by_membership_id, closeReason: m.close_reason,
});

function requireSuperadmin(ctx: ActiveContext): void {
  if (ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED', 'only the SuperAdmin manages a route migration');
}

/** Migraciones visibles (RLS): SuperAdmin todas; Administrador, Supervisor y Secretario las de su alcance. */
export async function listMigrations(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const routeId = q.get('routeId');
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  if (routeId !== null) { params.push(pathId(routeId)); where += ` and route_id = $${params.length}`; }
  const r = await client.query<MigrationRow>(`select * from adex.route_migrations where ${where} order by opened_at desc, id limit 200`, params);
  // 0045: cierres cargados (fecha y resumen), del más reciente al más antiguo.
  const loads = r.rows.length === 0 ? [] : (await client.query<{ migration_id: string; report_date: string; result: Record<string, unknown>; created_at: Date }>(
    `select migration_id, to_char(report_date, 'YYYY-MM-DD') report_date, result - 'duplicateDocuments' result, created_at
       from adex.route_migration_loads where company_id = $1 and migration_id = any($2::text[]) order by report_date desc`,
    [ctx.companyId, r.rows.map((m) => m.id)])).rows;
  // 0048: diferencias de cada migración (abiertas primero), con el valor de ADEX y el del sistema anterior.
  const diffs = r.rows.length === 0 ? [] : (await client.query<DifferenceRow>(
    `select d.*, to_char(d.detected_report_date, 'YYYY-MM-DD') detected_on, to_char(d.source_report_date, 'YYYY-MM-DD') source_on,
            c.name client_name, v.status current_status, v.balance_minor current_balance
       from adex.route_migration_differences d
       join adex.clients c on c.company_id = d.company_id and c.id = d.client_id
       join adex.sales v on v.company_id = d.company_id and v.id = d.sale_id
      where d.company_id = $1 and d.migration_id = any($2::text[])
      order by (d.status = 'abierta') desc, d.detected_report_date, d.source_code`,
    [ctx.companyId, r.rows.map((m) => m.id)])).rows;
  return r.rows.map((m) => {
    const mine = diffs.filter((d) => d.migration_id === m.id).map(differenceView);
    return { ...view(m), loads: loads.filter((l) => l.migration_id === m.id)
      .map((l) => ({ reportDate: l.report_date, loadedAt: l.created_at.toISOString(), summary: l.result })),
      differences: mine, openDifferences: mine.filter((d) => d.status === 'abierta').length };
  });
}

interface DifferenceRow {
  id: string; migration_id: string; sale_id: string; client_id: string; client_name: string; source_code: string; kind: string; status: string;
  adex_status: string; adex_balance_minor: string; current_status: string; current_balance: string; source_status: string;
  source_balance_minor: string | null; detected_on: string; source_on: string; action: string | null; reason: string | null;
  resolved_at: Date | null; resolved_by_membership_id: string | null; result: Record<string, unknown>;
}

const differenceView = (d: DifferenceRow) => ({
  id: d.id, saleId: d.sale_id, clientId: d.client_id, clientName: d.client_name, code: d.source_code, kind: d.kind, status: d.status,
  adexStatus: d.adex_status, adexBalanceMinor: Number(d.adex_balance_minor), currentStatus: d.current_status, currentBalanceMinor: Number(d.current_balance),
  sourceStatus: d.source_status, sourceBalanceMinor: d.source_balance_minor === null ? null : Number(d.source_balance_minor),
  detectedReportDate: d.detected_on, sourceReportDate: d.source_on, action: d.action, reason: d.reason,
  resolvedAt: d.resolved_at?.toISOString() ?? null, resolvedById: d.resolved_by_membership_id, result: d.result,
});

/** El SuperAdmin pone una ruta vacía «en migración» (espejo de solo lectura del sistema anterior). */
export async function openMigration(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body, operationId: string | null) {
  requireSuperadmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const sourceRouteName = reqText(body, 'sourceRouteName', 120);
  const note = optText(body, 'note', 500);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_open($1, $2, $3, $4) r',
    [requireOperationId(operationId), route.id, sourceRouteName, note])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ROUTE_MIGRATION_OPENED', entityType: 'route_migration', entityId: String(r['migrationId']), routeId: route.id,
    description: `Ruta ${route.name} en migración desde el sistema anterior («${sourceRouteName}»): solo lectura hasta terminar.`,
    reason: note, after: r, metadata: { operationId },
  });
  return r;
}

/** El SuperAdmin cancela la migración: la ruta vuelve a su estado normal sin cambios. */
export async function cancelMigration(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body, operationId: string | null) {
  requireSuperadmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const reason = reqText(body, 'reason', 500);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_cancel($1, $2, $3) r',
    [requireOperationId(operationId), route.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ROUTE_MIGRATION_CANCELLED', entityType: 'route_migration', entityId: String(r['migrationId']), routeId: route.id,
    description: `Migración de ${route.name} cancelada: la ruta vuelve a su estado normal.`, reason, after: r, metadata: { operationId },
  });
  return r;
}

// ---------- 0044/0045 · Carga de cada cierre de Listos y finalización ----------
// El cuerpo es `{ payload }`: lo arma `saas/scripts/migracion/listos_a_adex.py` a partir de los reportes de Listos
// (importes en unidades menores). PostgreSQL lo valida todo (`adex.route_migration_load`): controles del reporte,
// calendario de cada crédito, saldos que solo bajan, Σ saldos de la ruta = reporte. Todo o nada. La ruta SIGUE en
// migración; `closeMigration` la termina (estado normal) y la caja se abre con una inyección de Base.
export const MIGRATION_LOAD_FIELDS = ['payload'] as const;
export const MIGRATION_CLOSE_FIELDS = ['note'] as const;
/** Una ruta grande: ~150 clientes, ~60 activos con su calendario y ~1.000 créditos pagados caben con holgura. */
export const MIGRATION_LOAD_MAX_BYTES = 2 * 1024 * 1024;

function loadPayload(body: Body): Record<string, unknown> {
  const p = body['payload'];
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new ApiError(400, 'INVALID_INPUT', 'payload must be an object');
  return p as Record<string, unknown>;
}

/** Vista previa: ejecuta la carga del cierre con las mismas comprobaciones y la DESHACE. No guarda nada. */
export async function previewMigrationLoad(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body) {
  requireSuperadmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const payload = loadPayload(body);
  await client.query('savepoint route_migration_preview');
  try {
    const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_load($1, $2, $3::jsonb) r',
      [crypto.randomUUID(), route.id, JSON.stringify(payload)])).rows[0]!.r;
    return { ...r, preview: true, valid: true };
  } catch (e) {
    // Datos que no cuadran (AX445): la vista previa dice QUÉ falla (crédito, control) en lugar de un error sin detalle.
    if ((e as { code?: string }).code !== 'AX445') throw e;
    return { preview: true, valid: false, problem: String((e as Error).message).replace(/^adex: /, '') };
  } finally {
    await client.query('rollback to savepoint route_migration_preview');
  }
}

/** Carga un cierre: la ruta en ADEX queda igual que en Listos ese día (sigue en migración, de solo lectura). */
export async function loadMigrationClose(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body, operationId: string | null) {
  requireSuperadmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const payload = loadPayload(body);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_load($1, $2, $3::jsonb) r',
    [requireOperationId(operationId), route.id, JSON.stringify(payload)])).rows[0]!.r;
  const { duplicateDocuments: _d, ...summary } = r;
  await audit(client, ctx, {
    action: 'ROUTE_MIGRATION_LOADED', entityType: 'route_migration', entityId: String(r['migrationId']), routeId: route.id,
    description: `Ruta ${route.name}: cierre del sistema anterior del ${String(r['reportDate'])} cargado (${String(r['activeCredits'])} créditos activos`
      + (Number(r['openDifferences'] ?? 0) > 0 ? `; ${String(r['openDifferences'])} diferencias por revisar).` : ').'),
    after: summary, metadata: { operationId },
  });
  return r;
}

/** Termina la migración: la ruta queda en estado normal y empieza a operar en ADEX. */
export async function closeMigration(client: pg.PoolClient, ctx: ActiveContext, routeId: string, body: Body, operationId: string | null) {
  requireSuperadmin(ctx);
  const route = await routeOf(client, ctx, pathId(routeId));
  const note = optText(body, 'note', 500);
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_close($1, $2, $3) r',
    [requireOperationId(operationId), route.id, note])).rows[0]!.r;
  const { duplicateDocuments: _d, ...summary } = r;
  await audit(client, ctx, {
    action: 'ROUTE_MIGRATION_FINISHED', entityType: 'route_migration', entityId: String(r['migrationId']), routeId: route.id,
    description: `Migración de ${route.name} terminada con el cierre del ${String(r['lastReportDate'])}: la ruta queda en estado normal.`,
    reason: note, after: summary, metadata: { operationId },
  });
  return r;
}

// ---------- 0048 · Diferencias de un cierre (3.27, decisión 2.2.2 de Helmer) ----------
// Un cierre que no cuadra en un crédito se carga igual: el crédito queda con una diferencia ABIERTA (sin mover dinero).
// La corrigen el SuperAdmin o el Administrador responsable de la ruta, con motivo; PostgreSQL lo valida todo
// (`adex.route_migration_resolve_difference`) y ningún ajuste toca una caja. «Terminar migración» exige cero abiertas.
export const MIGRATION_RESOLVE_FIELDS = ['action', 'reason'] as const;
export const DIFFERENCE_ACTIONS = ['accept_source', 'keep_adex', 'paid', 'void', 'still_active', 'reopen', 'keep_paid'] as const;
const ACTION_LABEL: Record<string, string> = {
  accept_source: 'aceptar el saldo del sistema anterior', keep_adex: 'mantener el saldo de ADEX', paid: 'fue pagado',
  void: 'nunca debió existir (anulada)', still_active: 'sigue activo', reopen: 'reabrir con el saldo del sistema anterior', keep_paid: 'mantener pagado',
};

/** Corrige una diferencia de migración: SuperAdmin o Administrador responsable de la ruta, con motivo. */
export async function resolveMigrationDifference(client: pg.PoolClient, ctx: ActiveContext, routeId: string, differenceId: string, body: Body,
                                                 operationId: string | null) {
  if (ctx.role !== 'superadmin' && ctx.role !== 'admin') {
    throw new ApiError(403, 'PERMISSION_DENIED', 'only the SuperAdmin or the responsible administrator resolves a migration difference');
  }
  const route = await routeOf(client, ctx, pathId(routeId));
  const id = pathId(differenceId);
  const action = reqText(body, 'action', 40);
  if (!(DIFFERENCE_ACTIONS as readonly string[]).includes(action)) throw new ApiError(400, 'INVALID_INPUT', 'action is invalid', { field: 'action' });
  const reason = reqText(body, 'reason', 500);
  if (reason.length < 10) throw new ApiError(400, 'INVALID_INPUT', 'reason needs at least 10 characters', { field: 'reason' });
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.route_migration_resolve_difference($1, $2, $3, $4, $5) r',
    [requireOperationId(operationId), route.id, id, action, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'ROUTE_MIGRATION_DIFFERENCE_RESOLVED', entityType: 'route_migration_difference', entityId: id, routeId: route.id,
    description: `Ruta ${route.name}: diferencia del crédito ${String(r['code'])} corregida (${ACTION_LABEL[action] ?? action}).`,
    reason, before: r['before'], after: r, metadata: { operationId },
  });
  return r;
}
