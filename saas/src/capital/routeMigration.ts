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
  return r.rows.map(view);
}

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
    description: `Ruta ${route.name} en migración desde Listos («${sourceRouteName}»): solo lectura hasta terminar.`,
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
