// Auditoría del servidor: MISMA transacción que el comando (txid), con identidad,
// membresía y rol del contexto. La política `audit_log_insert` (0005) rechaza
// cualquier otra combinación, así que la API no puede auditar en nombre de otro.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActiveContext } from '../authz/context.ts';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  /** Ruta afectada. NULL en el ciclo de vida estructural de la propia ruta (ver routes.ts). */
  routeId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  metadata?: unknown;
}

export async function audit(client: pg.PoolClient, ctx: ActiveContext, e: AuditEntry): Promise<void> {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  await client.query(
    `insert into adex.audit_log (id, company_id, actor_membership_id, actor_identity_id, actor_role, route_id, action, entity_type,
                                 entity_id, description, before_data, after_data, reason, metadata, txid, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, txid_current(), now())`,
    [randomUUID(), ctx.companyId, ctx.membershipId, ctx.claims.identityId, ctx.role, e.routeId ?? null, e.action, e.entityType,
      e.entityId, e.description, json(e.before), json(e.after), e.reason ?? null, json(e.metadata)],
  );
}
