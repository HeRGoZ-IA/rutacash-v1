// Identidad y membresías de una empresa (Fase 1). Cada operación:
//   1. corre dentro de la transacción del contexto activo (ya resuelto y bloqueado);
//   2. autoriza con las reglas de CLEAN (`can`, jerarquía de roles, último SuperAdmin);
//   3. escribe con `adex_api`, sujeto a RLS (segunda barrera);
//   4. audita en la MISMA transacción (txid), con identidad, membresía y rol.
//
// Fuera de alcance (Fase 2, `withCapitalControllerGuard`): cambiar las rutas de un
// Administrador, porque decide quién es responsable de capital de cada ruta. Se
// rechaza con 409 en vez de elegir un responsable «en silencio».

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import type { ActiveContext } from '../authz/context.ts';
import { ID_RE } from '../authz/context.ts';
import {
  USER_ROLES, allowed, lastSuperadminBlock, mayManage, routeUnrestricted, type MembershipFacts, type UserRole,
} from '../authz/cleanRules.ts';
import type { SessionClaims } from '../db/tx.ts';

export interface MemberView {
  membershipId: string;
  role: UserRole;
  status: 'activo' | 'inactivo';
  displayName: string;
  email: string | null;
  routeIds: string[];
  hasIdentity: boolean;
}

async function audit(client: pg.PoolClient, ctx: ActiveContext, e: {
  action: string; entityType: string; entityId: string; description: string; routeId?: string | null;
  before?: unknown; after?: unknown; reason?: string | null;
}): Promise<void> {
  await client.query(
    `insert into adex.audit_log (id, company_id, actor_membership_id, actor_identity_id, actor_role, route_id, action, entity_type,
                                 entity_id, description, before_data, after_data, reason, txid, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, txid_current(), now())`,
    [randomUUID(), ctx.companyId, ctx.membershipId, ctx.claims.identityId, ctx.role, e.routeId ?? null, e.action, e.entityType,
      e.entityId, e.description, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null],
  );
}

async function loadMember(client: pg.PoolClient, ctx: ActiveContext, membershipId: string): Promise<MembershipFacts & { identityId: string | null }> {
  if (!ID_RE.test(membershipId)) throw new ApiError(404, 'NOT_FOUND');
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; identity_id: string | null }>(
    'select id, role, status, display_name, identity_id from adex.memberships where id = $1 and company_id = $2', [membershipId, ctx.companyId]);
  const row = r.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND');
  const routes = await client.query<{ route_id: string }>('select route_id from adex.membership_routes where membership_id = $1 order by 1', [row.id]);
  return {
    membershipId: row.id, companyId: ctx.companyId, role: row.role, status: row.status, displayName: row.display_name,
    routeIds: routes.rows.map((x) => x.route_id), identityId: row.identity_id,
  };
}

export async function listMembers(client: pg.PoolClient, ctx: ActiveContext): Promise<MemberView[]> {
  if (!allowed(ctx, 'user.viewAll')) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; email: string | null; identity_id: string | null; routes: string[] }>(
    `select m.id, m.role, m.status, m.display_name, i.email, m.identity_id,
            coalesce(array_agg(mr.route_id order by mr.route_id) filter (where mr.route_id is not null), '{}') routes
       from adex.memberships m
       left join adex.identities i on i.id = m.identity_id
       left join adex.membership_routes mr on mr.membership_id = m.id
      where m.company_id = $1
      group by m.id, i.email
      order by m.display_name, m.id`, [ctx.companyId]);
  return r.rows.map((m) => ({
    membershipId: m.id, role: m.role, status: m.status, displayName: m.display_name, email: m.email,
    routeIds: m.routes, hasIdentity: m.identity_id !== null,
  }));
}

function assertRoutesAssignable(ctx: ActiveContext, routeIds: string[]): void {
  for (const routeId of routeIds) {
    if (!ID_RE.test(routeId) || !allowed(ctx, 'route.assign', { routeId })) throw new ApiError(403, 'PERMISSION_DENIED');
  }
}

async function assertRoutesExist(client: pg.PoolClient, ctx: ActiveContext, routeIds: string[]): Promise<void> {
  if (!routeIds.length) return;
  const r = await client.query<{ n: number }>('select count(*)::int n from adex.routes where company_id = $1 and id = any($2)', [ctx.companyId, routeIds]);
  if (r.rows[0]!.n !== routeIds.length) throw new ApiError(404, 'ROUTE_NOT_FOUND');
}

export interface CreateMemberInput {
  email?: unknown;
  role?: unknown;
  displayName?: unknown;
  phone?: unknown;
  routeIds?: unknown;
}

export async function createMember(client: pg.PoolClient, ctx: ActiveContext, input: CreateMemberInput, provider: IdentityProvider): Promise<MemberView> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'INVALID_EMAIL');
  const role = input.role as UserRole;
  if (!USER_ROLES.includes(role)) throw new ApiError(400, 'INVALID_ROLE');
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName) throw new ApiError(400, 'INVALID_NAME');
  const phone = typeof input.phone === 'string' ? input.phone : null;
  const routeIds = Array.isArray(input.routeIds) ? [...new Set(input.routeIds.map(String))].sort() : [];

  if (!allowed(ctx, 'user.create', { targetRole: role })) throw new ApiError(403, 'PERMISSION_DENIED');
  if (role === 'superadmin' && routeIds.length) throw new ApiError(400, 'SUPERADMIN_IS_UNRESTRICTED');
  if (role === 'admin' && routeIds.length) throw new ApiError(409, 'REQUIRES_PHASE_2_CAPITAL_GUARD');
  assertRoutesAssignable(ctx, routeIds);
  await assertRoutesExist(client, ctx, routeIds);

  const { identityId } = await provider.ensureIdentity(email);
  await client.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [identityId, email]);
  const membershipId = randomUUID();
  await client.query(
    `insert into adex.memberships (id, company_id, identity_id, role, status, display_name, phone, created_at, updated_at)
     values ($1, $2, $3, $4, 'activo', $5, $6, now(), now())`,
    [membershipId, ctx.companyId, identityId, role, displayName, phone],
  );
  for (const routeId of routeIds) {
    await client.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [ctx.companyId, membershipId, routeId]);
  }
  await audit(client, ctx, { action: 'CREATE_USER', entityType: 'membership', entityId: membershipId, description: `Alta de ${role}`,
    after: { role, routeIds, identityId } });
  return { membershipId, role, status: 'activo', displayName, email, routeIds, hasIdentity: true };
}

async function companyMembers(client: pg.PoolClient, ctx: ActiveContext): Promise<MembershipFacts[]> {
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string }>(
    'select id, role, status, display_name from adex.memberships where company_id = $1', [ctx.companyId]);
  return r.rows.map((m) => ({ membershipId: m.id, companyId: ctx.companyId, role: m.role, status: m.status, displayName: m.display_name, routeIds: [] }));
}

export async function setMemberStatus(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, status: 'activo' | 'inactivo'): Promise<MemberView> {
  const target = await loadMember(client, ctx, membershipId);
  if (!allowed(ctx, 'user.block', { targetRole: target.role }) || !mayManage(ctx, target)) {
    throw new ApiError(403, 'PERMISSION_DENIED');
  }
  if (status === 'inactivo') {
    // Serializa las bajas de SuperAdmin de la empresa: dos bajas simultáneas no
    // pueden dejarla sin ninguno (LAST_SUPERADMIN_PROTECTION de CLEAN).
    await client.query(`select pg_advisory_xact_lock(adex.lock_key('company-superadmins', $1))`, [ctx.companyId]);
    const block = lastSuperadminBlock(target, await companyMembers(client, ctx));
    if (block) throw new ApiError(409, block.code, block.message);
  }
  if (target.status !== status) {
    // El disparador toma el bloqueo EXCLUSIVO de la membresía (REVOKE-004): espera a
    // las operaciones en curso de esa membresía y bloquea las nuevas hasta el COMMIT.
    await client.query('update adex.memberships set status = $2, updated_at = now() where id = $1', [target.membershipId, status]);
    await audit(client, ctx, {
      action: status === 'inactivo' ? 'BLOCK_USER' : 'UPDATE_USER', entityType: 'membership', entityId: target.membershipId,
      description: status === 'inactivo' ? 'Membresía desactivada' : 'Membresía reactivada', before: { status: target.status }, after: { status },
    });
  }
  return { ...(await viewOf(client, ctx, target.membershipId)) };
}

export async function setMemberRoutes(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, routeIdsInput: unknown): Promise<MemberView> {
  if (!Array.isArray(routeIdsInput)) throw new ApiError(400, 'INVALID_ROUTES');
  const next = [...new Set(routeIdsInput.map(String))].sort();
  const target = await loadMember(client, ctx, membershipId);
  if (!mayManage(ctx, target)) throw new ApiError(403, 'PERMISSION_DENIED');
  if (target.role === 'superadmin') throw new ApiError(400, 'SUPERADMIN_IS_UNRESTRICTED');
  if (target.role === 'admin') throw new ApiError(409, 'REQUIRES_PHASE_2_CAPITAL_GUARD');
  const current = new Set(target.routeIds);
  const added = next.filter((r) => !current.has(r));
  const removed = [...current].filter((r) => !next.includes(r));
  assertRoutesAssignable(ctx, [...added, ...removed]);
  await assertRoutesExist(client, ctx, added);
  for (const routeId of removed) {
    // Quitar una ruta es una revocación: el disparador toma el bloqueo exclusivo.
    await client.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [target.membershipId, routeId]);
    await audit(client, ctx, { action: 'UNASSIGN_ROUTE', entityType: 'membership', entityId: target.membershipId, routeId, description: 'Ruta retirada' });
  }
  for (const routeId of added) {
    await client.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [ctx.companyId, target.membershipId, routeId]);
    await audit(client, ctx, { action: 'ASSIGN_ROUTE', entityType: 'membership', entityId: target.membershipId, routeId, description: 'Ruta asignada' });
  }
  return viewOf(client, ctx, target.membershipId);
}

async function viewOf(client: pg.PoolClient, ctx: ActiveContext, membershipId: string): Promise<MemberView> {
  const m = await loadMember(client, ctx, membershipId);
  const e = m.identityId ? await client.query<{ email: string }>('select email from adex.identities where id = $1', [m.identityId]) : null;
  return {
    membershipId: m.membershipId, role: m.role, status: m.status, displayName: m.displayName,
    email: e?.rows[0]?.email ?? null, routeIds: [...m.routeIds], hasIdentity: m.identityId !== null,
  };
}

/** Rutas visibles en el contexto activo (`filterAccessibleRoutes` de CLEAN + RLS). */
export async function listRoutes(client: pg.PoolClient, ctx: ActiveContext) {
  if (!allowed(ctx, 'route.viewAssigned') && !allowed(ctx, 'route.viewAll')) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ id: string; name: string; code: string; status: string; office_id: string | null }>(
    'select id, name, code, status, office_id from adex.routes where company_id = $1 order by code', [ctx.companyId]);
  const visible = routeUnrestricted(ctx) ? r.rows : r.rows.filter((x) => ctx.routeIds.includes(x.id));
  return visible.map((x) => ({ id: x.id, name: x.name, code: x.code, status: x.status, officeId: x.office_id }));
}

export async function getRoute(client: pg.PoolClient, ctx: ActiveContext, routeId: string) {
  // Una ruta ajena o fuera del alcance es indistinguible de una inexistente.
  if (!ID_RE.test(routeId)) throw new ApiError(404, 'NOT_FOUND');
  const route = (await listRoutes(client, ctx)).find((x) => x.id === routeId);
  if (!route) throw new ApiError(404, 'NOT_FOUND');
  return route;
}

/**
 * Cierre de sesión (decisión 2026-10-14): ADEX revoca PRIMERO en su registro —que es
 * lo que corta las operaciones aunque el token siga firmado— y después en el proveedor.
 */
export async function logout(client: pg.PoolClient, claims: SessionClaims, scope: 'local' | 'global'): Promise<void> {
  // Global: el corte por identidad revoca TODAS las sesiones emitidas hasta ahora,
  // incluida esta (su `iat` es anterior). RLS solo deja moverlo con una sesión todavía
  // válida, y un UPDATE filtrado por RLS no falla: afecta 0 filas. Por eso se exige 1.
  if (scope === 'global') {
    const r = await client.query('update adex.identities set sessions_valid_after = now(), updated_at = now() where id = $1', [claims.identityId]);
    if (r.rowCount !== 1) throw new ApiError(401, 'SESSION_REVOKED');
    return;
  }
  await client.query('insert into adex.revoked_sessions (session_id, identity_id, reason) values ($1, $2, $3)',
    [claims.sessionId, claims.identityId, 'logout']);
}
