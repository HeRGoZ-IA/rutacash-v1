// Piezas comunes de los comandos de estructura y catálogo (Fase 2).

import type pg from 'pg';
import type { Capability, PermissionContext } from '@/lib/permissions';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { allowed, type MembershipFacts, type UserRole } from '../authz/cleanRules.ts';

/** `can()` de CLEAN o 403. */
export function need(ctx: ActiveContext, capability: Capability, pc: Omit<PermissionContext, 'tenantId'> = {}): void {
  if (!allowed(ctx, capability, pc)) throw new ApiError(403, 'PERMISSION_DENIED');
}

/** Membresías de la empresa con sus rutas, releídas en la transacción. */
export async function loadMembers(client: pg.PoolClient, ctx: ActiveContext, ids?: readonly string[], lock = false): Promise<Map<string, MembershipFacts>> {
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; created_at: Date }>(
    `select id, role, status, display_name, created_at from adex.memberships
      where company_id = $1 ${ids ? 'and id = any($2)' : ''} order by id ${lock ? 'for update' : ''}`,
    ids ? [ctx.companyId, [...ids]] : [ctx.companyId]);
  const routes = await client.query<{ membership_id: string; route_id: string }>(
    `select membership_id, route_id from adex.membership_routes where company_id = $1 ${ids ? 'and membership_id = any($2)' : ''} order by route_id`,
    ids ? [ctx.companyId, [...ids]] : [ctx.companyId]);
  const out = new Map<string, MembershipFacts>();
  for (const m of r.rows) {
    out.set(m.id, { membershipId: m.id, companyId: ctx.companyId, role: m.role, status: m.status, displayName: m.display_name, routeIds: [], createdAt: m.created_at.toISOString() });
  }
  for (const x of routes.rows) (out.get(x.membership_id)?.routeIds as string[] | undefined)?.push(x.route_id);
  return out;
}

/** Instantánea JSON de una fila para la auditoría (sin campos binarios). */
export function snapshot<T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k as string, row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k] ?? null]));
}
