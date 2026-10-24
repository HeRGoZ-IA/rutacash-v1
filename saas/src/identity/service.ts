// Identidad y membresías de una empresa (Fases 1 y 2). Cada operación:
//   1. corre dentro de la transacción del contexto activo (ya resuelto y bloqueado);
//   2. autoriza con las reglas de CLEAN (`can`, jerarquía de roles, último SuperAdmin);
//   3. escribe con `adex_api`, sujeto a RLS (segunda barrera);
//   4. audita en la MISMA transacción (txid), con identidad, membresía y rol.
//
// Fase 2 (`withCapitalControllerGuard` como restricción transaccional): asignar o
// retirar rutas de un Administrador, desactivarlo o reactivarlo fija o protege al
// responsable de capital de cada ruta EN LA MISMA TRANSACCIÓN (capitalGuard.ts), y
// PostgreSQL lo vuelve a comprobar al COMMIT. Para Cobradores se conserva
// `setCobradorRoutes`: la ruta añadida lo hace responsable (gana la asignación más
// reciente) y la retirada lo libera.
//
// Cambiar el ROL de una membresía no existe (DS-05: una membresía por empresa y rol):
// se da de alta otra membresía y se desactiva la anterior, que conserva su historia.

import type pg from 'pg';
import { applyOfficeRouteSelection } from '@/lib/officeManagement';
import { ApiError } from '../errors.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import type { ActiveContext } from '../authz/context.ts';
import { ID_RE } from '../authz/context.ts';
import {
  USER_ROLES, allowed, lastSuperadminBlock, mayManage, type MembershipFacts, type UserRole,
} from '../authz/cleanRules.ts';
import type { SessionClaims } from '../db/tx.ts';
import { audit } from '../db/audit.ts';
import { randomUUID } from 'node:crypto';
import { lockMembershipsForRevocation, lockRoutes, reconcileControllers, type ControllerEvent } from '../structure/capitalGuard.ts';
import { has, idList, optText, pathId, reqId, reqText } from '../structure/input.ts';
import { requireNoPendingAccounts } from '../capital/conciliation.ts';

export interface MemberView {
  membershipId: string;
  role: UserRole;
  status: 'activo' | 'inactivo';
  displayName: string;
  phone?: string | null;
  email: string | null;
  routeIds: string[];
  hasIdentity: boolean;
  controllerEvents?: ControllerEvent[];
}

async function loadMember(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, lock = false): Promise<MembershipFacts & { identityId: string | null; phone: string | null }> {
  if (!ID_RE.test(membershipId)) throw new ApiError(404, 'NOT_FOUND');
  type Row = { id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; identity_id: string | null; phone: string | null };
  const sql = 'select id, role, status, display_name, identity_id, phone from adex.memberships where id = $1 and company_id = $2';
  let row = (await client.query<Row>(sql, [membershipId, ctx.companyId])).rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND');
  // FOR UPDATE exige la política de UPDATE: quien no puede gestionar membresías no
  // bloquea la fila y recibe el 403 de la comprobación de permisos que sigue.
  if (lock) row = (await client.query<Row>(`${sql} for update`, [membershipId, ctx.companyId])).rows[0] ?? row;
  const routes = await client.query<{ route_id: string }>('select route_id from adex.membership_routes where membership_id = $1 order by 1', [row.id]);
  return {
    membershipId: row.id, companyId: ctx.companyId, role: row.role, status: row.status, displayName: row.display_name,
    routeIds: routes.rows.map((x) => x.route_id), identityId: row.identity_id, phone: row.phone,
  };
}

export async function listMembers(client: pg.PoolClient, ctx: ActiveContext): Promise<MemberView[]> {
  if (!allowed(ctx, 'user.viewAll')) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; phone: string | null; email: string | null; identity_id: string | null; routes: string[] }>(
    `select m.id, m.role, m.status, m.display_name, m.phone, i.email, m.identity_id,
            coalesce(array_agg(mr.route_id::text order by mr.route_id) filter (where mr.route_id is not null), '{}') routes
       from adex.memberships m
       left join adex.identities i on i.id = m.identity_id
       left join adex.membership_routes mr on mr.membership_id = m.id
      where m.company_id = $1
      group by m.id, i.email
      order by m.display_name, m.id`, [ctx.companyId]);
  return r.rows.map((m) => ({
    membershipId: m.id, role: m.role, status: m.status, displayName: m.display_name, phone: m.phone, email: m.email,
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

/**
 * Escribe el conjunto de rutas de una membresía y sus consecuencias, en la
 * transacción del comando: asignaciones auditadas, Cobrador responsable
 * (`setCobradorRoutes`) y responsable de capital (`withCapitalControllerGuard`).
 */
async function applyMemberRoutes(client: pg.PoolClient, ctx: ActiveContext, target: MembershipFacts, next: string[], scope?: string): Promise<{ added: string[]; removed: string[]; events: ControllerEvent[] }> {
  const current = new Set(target.routeIds);
  const added = next.filter((r) => !current.has(r));
  const removed = [...current].filter((r) => !next.includes(r));
  if (!added.length && !removed.length) return { added, removed, events: [] };
  assertRoutesAssignable(ctx, [...added, ...removed]);
  await assertRoutesExist(client, ctx, added);
  if (added.length && target.status !== 'activo') throw new ApiError(400, 'MEMBER_INACTIVE');
  // D74-H2: ampliar el alcance de otra membresía de la MISMA persona es autoasignación (quitar rutas, no).
  if (added.length && target.membershipId !== ctx.membershipId) {
    const own = await client.query('select 1 from adex.memberships where company_id = $1 and id = $2 and identity_id = $3',
      [ctx.companyId, target.membershipId, ctx.claims.identityId]);
    if (own.rowCount) throw new ApiError(403, 'SELF_ASSIGNMENT_FORBIDDEN', 'nobody assigns routes to their own membership');
  }
  await lockRoutes(client, ctx, [...added, ...removed]);
  const description = (verb: string) => `Ruta ${verb}${scope ? ` (${scope})` : ''}`;
  for (const routeId of removed) {
    // Quitar una ruta es una revocación: el disparador toma el bloqueo exclusivo (REVOKE-004).
    await client.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [target.membershipId, routeId]);
    await audit(client, ctx, { action: 'UNASSIGN_ROUTE', entityType: 'membership', entityId: target.membershipId, routeId, description: description('retirada') });
    if (target.role === 'cobrador') {
      await client.query('update adex.routes set collector_membership_id = null, updated_at = now() where company_id = $1 and id = $2 and collector_membership_id = $3',
        [ctx.companyId, routeId, target.membershipId]);
    }
  }
  for (const routeId of added) {
    await client.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [ctx.companyId, target.membershipId, routeId]);
    await audit(client, ctx, { action: 'ASSIGN_ROUTE', entityType: 'membership', entityId: target.membershipId, routeId, description: description('asignada') });
    if (target.role === 'cobrador') {
      const r = await client.query<{ collector_membership_id: string | null }>('select collector_membership_id from adex.routes where company_id = $1 and id = $2', [ctx.companyId, routeId]);
      const other = r.rows[0]?.collector_membership_id;
      if (other && other !== target.membershipId) {
        // Conflicto: la ruta ya tenía otro Cobrador responsable → gana lo más reciente.
        await client.query('delete from adex.membership_routes where membership_id = $1 and route_id = $2', [other, routeId]);
        await audit(client, ctx, { action: 'UNASSIGN_ROUTE', entityType: 'membership', entityId: other, routeId, description: 'Cobrador responsable reemplazado' });
      }
      await client.query('update adex.routes set collector_membership_id = $3, updated_at = now() where company_id = $1 and id = $2', [ctx.companyId, routeId, target.membershipId]);
    }
  }
  const events = await reconcileControllers(client, ctx, {
    routeIds: [...added, ...removed], preferredAdminIds: target.role === 'admin' ? [target.membershipId] : [],
  });
  return { added, removed, events };
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
  assertRoutesAssignable(ctx, routeIds);
  await assertRoutesExist(client, ctx, routeIds);

  const { identityId } = await provider.ensureIdentity(email);
  // R74 (DS-05): nadie se da de alta a sí mismo otra membresía (otro perfil) en su empresa.
  // Otra persona con autoridad debe hacerlo. PostgreSQL lo repite (política restrictiva, 0033).
  if (identityId === ctx.claims.identityId) throw new ApiError(403, 'SELF_ASSIGNMENT_FORBIDDEN', 'nobody grants themselves another membership');
  await client.query('insert into adex.identities (id, email) values ($1, $2) on conflict do nothing', [identityId, email]);
  const membershipId = randomUUID();
  await client.query(
    `insert into adex.memberships (id, company_id, identity_id, role, status, display_name, phone, created_at, updated_at)
     values ($1, $2, $3, $4, 'activo', $5, $6, now(), now())`,
    [membershipId, ctx.companyId, identityId, role, displayName, phone],
  );
  await audit(client, ctx, { action: 'CREATE_USER', entityType: 'membership', entityId: membershipId, description: `Alta de ${role}`,
    after: { role, routeIds, identityId } });
  const target: MembershipFacts = { membershipId, companyId: ctx.companyId, role, status: 'activo', displayName, routeIds: [] };
  const { events } = await applyMemberRoutes(client, ctx, target, routeIds);
  return { ...(await viewOf(client, ctx, membershipId)), controllerEvents: events };
}

/**
 * Enlace de PRIMER ACCESO de un usuario de la empresa (Ronda 40). Quien puede crear y
 * gestionar a esa persona (misma regla que el alta: `user.create` para su rol + jerarquía y
 * alcance) obtiene un enlace de un solo uso para entregárselo; la persona fija su propia
 * contraseña con él. Solo si la identidad es exclusiva de esta empresa (no pertenece a otra
 * ni es Owner) y NUNCA ha iniciado sesión: a quien ya tiene acceso nadie le fija la
 * contraseña desde fuera. El token no se guarda ni se registra; la auditoría anota quién lo
 * emitió y para quién.
 */
export async function memberAccessLink(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, provider: IdentityProvider) {
  const target = await loadMember(client, ctx, membershipId);
  if (!allowed(ctx, 'user.create', { targetRole: target.role }) || !mayManage(ctx, target)) throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ identity_id: string; email: string; exclusive: boolean }>(
    'select identity_id, email, exclusive from adex.access_link_target($1)', [target.membershipId]);
  const t = r.rows[0];
  if (!t) throw new ApiError(409, 'MEMBERSHIP_INACTIVE');
  if (!t.exclusive) throw new ApiError(409, 'IDENTITY_SHARED');
  const out = await provider.issueAccessLink(t.identity_id, t.email);
  if (out.status === 'already_active') return { status: 'already_active' as const };
  await audit(client, ctx, { action: 'ISSUE_ACCESS_LINK', entityType: 'membership', entityId: target.membershipId,
    description: 'Enlace de primer acceso emitido' });
  return { status: 'issued' as const, tokenHash: out.tokenHash };
}

async function companyMembers(client: pg.PoolClient, ctx: ActiveContext): Promise<MembershipFacts[]> {
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string }>(
    'select id, role, status, display_name from adex.memberships where company_id = $1', [ctx.companyId]);
  return r.rows.map((m) => ({ membershipId: m.id, companyId: ctx.companyId, role: m.role, status: m.status, displayName: m.display_name, routeIds: [] }));
}

export async function setMemberStatus(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, status: 'activo' | 'inactivo'): Promise<MemberView> {
  const peek = await loadMember(client, ctx, membershipId);
  if (!allowed(ctx, 'user.block', { targetRole: peek.role }) || !mayManage(ctx, peek)) {
    throw new ApiError(403, 'PERMISSION_DENIED');
  }
  // Orden global: bloqueo de revocación de la persona → rutas (por id) → filas de membresías.
  await lockMembershipsForRevocation(client, [peek.membershipId]);
  await lockRoutes(client, ctx, peek.routeIds);
  const target = await loadMember(client, ctx, membershipId, true);
  // R74 (DS-05): nadie reactiva una membresía propia (otro perfil de la misma persona).
  if (status === 'activo' && target.status !== 'activo' && target.identityId === ctx.claims.identityId) {
    throw new ApiError(403, 'SELF_ASSIGNMENT_FORBIDDEN', 'nobody reactivates their own membership');
  }
  if (status === 'inactivo') {
    // Serializa las bajas de SuperAdmin de la empresa: dos bajas simultáneas no
    // pueden dejarla sin ninguno (LAST_SUPERADMIN_PROTECTION de CLEAN).
    await client.query(`select pg_advisory_xact_lock(adex.lock_key('company-superadmins', $1))`, [ctx.companyId]);
    const block = lastSuperadminBlock(target, await companyMembers(client, ctx));
    if (block) throw new ApiError(409, block.code, block.message);
    // R74 (0036, RB-D1): ningún Administrador se desactiva con cuentas pendientes (rutas a su cargo, bolsa, reembolsos,
    // actas, diferencias, traspasos, solicitudes, sobrantes en control). Disparador AX433 como barrera final.
    if (target.role === 'admin' && target.status === 'activo') await requireNoPendingAccounts(client, ctx, target.membershipId);
  }
  let events: ControllerEvent[] = [];
  if (target.status !== status) {
    // El disparador toma el bloqueo EXCLUSIVO de la membresía (REVOKE-004): espera a
    // las operaciones en curso de esa membresía y bloquea las nuevas hasta el COMMIT.
    await client.query('update adex.memberships set status = $2, updated_at = now() where id = $1', [target.membershipId, status]);
    await audit(client, ctx, {
      action: status === 'inactivo' ? 'BLOCK_USER' : 'UPDATE_USER', entityType: 'membership', entityId: target.membershipId,
      description: status === 'inactivo' ? 'Membresía desactivada' : 'Membresía reactivada', before: { status: target.status }, after: { status },
    });
    // v16: desactivar al responsable exige que otro lo sea (o libera la ruta si no
    // queda ninguno); reactivar a un Administrador puede hacerlo primer responsable.
    if (target.role === 'admin') {
      events = await reconcileControllers(client, ctx, { routeIds: target.routeIds, preferredAdminIds: [target.membershipId] });
    }
  }
  return { ...(await viewOf(client, ctx, target.membershipId)), controllerEvents: events };
}

export async function setMemberRoutes(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, routeIdsInput: unknown): Promise<MemberView> {
  if (!Array.isArray(routeIdsInput)) throw new ApiError(400, 'INVALID_ROUTES');
  const next = [...new Set(routeIdsInput.map(String))].sort();
  const peek = await loadMember(client, ctx, membershipId);
  if (!mayManage(ctx, peek)) throw new ApiError(403, 'PERMISSION_DENIED');
  if (peek.role === 'superadmin') throw new ApiError(400, 'SUPERADMIN_IS_UNRESTRICTED');
  await lockMembershipsForRevocation(client, [peek.membershipId]);
  await lockRoutes(client, ctx, [...peek.routeIds, ...next.filter((r) => ID_RE.test(r))]);
  const target = await loadMember(client, ctx, membershipId, true);
  const { events } = await applyMemberRoutes(client, ctx, target, next);
  return { ...(await viewOf(client, ctx, target.membershipId)), controllerEvents: events };
}

/**
 * Asignaciones de una persona decididas DESDE una Oficina (`setUserOfficeRoutes`):
 * solo cambian las rutas de esa Oficina (`applyOfficeRouteSelection`); las demás
 * se conservan.
 */
export async function setMemberOfficeRoutes(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, body: Record<string, unknown>): Promise<MemberView> {
  const officeId = reqId(body, 'officeId');
  const selected = idList(body, 'selectedRouteIds');
  if (!allowed(ctx, 'route.assign')) throw new ApiError(403, 'PERMISSION_DENIED');
  const office = await client.query('select 1 from adex.offices where company_id = $1 and id = $2', [ctx.companyId, officeId]);
  if (!office.rowCount) throw new ApiError(404, 'OFFICE_NOT_FOUND');
  const officeRoutes = (await client.query<{ id: string }>('select id from adex.routes where company_id = $1 and office_id = $2 order by id', [ctx.companyId, officeId]))
    .rows.map((r) => r.id);
  const peek = await loadMember(client, ctx, membershipId);
  if (!mayManage(ctx, peek)) throw new ApiError(403, 'PERMISSION_DENIED');
  if (peek.role === 'superadmin') throw new ApiError(400, 'SUPERADMIN_IS_UNRESTRICTED');
  const next = applyOfficeRouteSelection([...peek.routeIds], officeRoutes, selected);
  await lockMembershipsForRevocation(client, [peek.membershipId]);
  await lockRoutes(client, ctx, [...peek.routeIds, ...next]);
  const target = await loadMember(client, ctx, membershipId, true);
  const { events } = await applyMemberRoutes(client, ctx, target, applyOfficeRouteSelection([...target.routeIds], officeRoutes, selected), 'desde una Oficina');
  return { ...(await viewOf(client, ctx, target.membershipId)), controllerEvents: events };
}

/** Datos de contacto (`user.edit` con jerarquía). Ni rol ni correo: ver cabecera. */
export async function updateMember(client: pg.PoolClient, ctx: ActiveContext, membershipId: string, body: Record<string, unknown>): Promise<MemberView> {
  const target = await loadMember(client, ctx, membershipId, true);
  if (!allowed(ctx, 'user.edit', { targetRole: target.role }) || !mayManage(ctx, target)) throw new ApiError(403, 'PERMISSION_DENIED');
  const displayName = has(body, 'displayName') ? reqText(body, 'displayName', 120) : target.displayName;
  const phone = has(body, 'phone') ? optText(body, 'phone', 40) : target.phone;
  if (displayName !== target.displayName || phone !== target.phone) {
    const u = await client.query('update adex.memberships set display_name = $2, phone = $3, updated_at = now() where id = $1', [target.membershipId, displayName, phone]);
    if (u.rowCount !== 1) throw new ApiError(403, 'PERMISSION_DENIED');
    await audit(client, ctx, { action: 'UPDATE_USER', entityType: 'membership', entityId: target.membershipId, description: `Datos de ${displayName} actualizados`,
      before: { displayName: target.displayName, phone: target.phone }, after: { displayName, phone } });
  }
  return viewOf(client, ctx, target.membershipId);
}

/**
 * DS-11: borrado físico de una membresía SOLO por el SuperAdmin (UsersPage), nunca la
 * propia, nunca el último SuperAdmin activo y nunca con historia (movimientos, rutas
 * asignadas, responsabilidades, actos auditados o decisiones sobre ella). La identidad
 * de la persona no se toca: puede tener otras membresías.
 */
export async function deleteMember(client: pg.PoolClient, ctx: ActiveContext, membershipId: string) {
  if (ctx.role !== 'superadmin') throw new ApiError(403, 'PERMISSION_DENIED');
  const target = await loadMember(client, ctx, pathId(membershipId), true);
  if (target.membershipId === ctx.membershipId) throw new ApiError(409, 'CANNOT_DELETE_SELF');
  await client.query(`select pg_advisory_xact_lock(adex.lock_key('company-superadmins', $1))`, [ctx.companyId]);
  const block = lastSuperadminBlock(target, await companyMembers(client, ctx));
  if (block) throw new ApiError(409, block.code, block.message);
  const refs = (await client.query<{ refs: string[] }>("select adex.protected_references('adex.memberships'::regclass, $1, $2) refs", [ctx.companyId, target.membershipId])).rows[0]!.refs;
  if (refs.length) throw new ApiError(409, 'HAS_HISTORY', 'the member has history: deactivate it instead', { references: refs });
  const d = await client.query('delete from adex.memberships where company_id = $1 and id = $2', [ctx.companyId, target.membershipId]);
  if (d.rowCount !== 1) throw new ApiError(403, 'PERMISSION_DENIED');
  await audit(client, ctx, { action: 'DELETE_USER', entityType: 'membership', entityId: target.membershipId, description: `Membresía eliminada: ${target.displayName}`,
    before: { role: target.role, status: target.status, displayName: target.displayName, identityId: target.identityId } });
  return { deleted: target.membershipId };
}

async function viewOf(client: pg.PoolClient, ctx: ActiveContext, membershipId: string): Promise<MemberView> {
  const m = await loadMember(client, ctx, membershipId);
  const e = m.identityId ? await client.query<{ email: string }>('select email from adex.identities where id = $1', [m.identityId]) : null;
  return {
    membershipId: m.membershipId, role: m.role, status: m.status, displayName: m.displayName, phone: m.phone,
    email: e?.rows[0]?.email ?? null, routeIds: [...m.routeIds], hasIdentity: m.identityId !== null,
  };
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

// ---------- Ronda 73 · SOC-01: una sola sesión activa por identidad (0031) ----------
const claimReady: Record<'adex' | 'adex_control', boolean | null> = { adex: null, adex_control: null };

/**
 * Inicio de sesión EXPLÍCITO: la sesión del token pasa a ser la única vigente de la identidad y la
 * anterior queda revocada (`superseded`). Se llama solo al iniciar sesión (empresa:
 * `POST /v1/session/claim`; Owner: `POST /control/v1/session/start`), nunca al renovar el token ni
 * al cambiar de empresa o rol (DS-05). Sin 0031 aplicada no hace nada (la API no depende del orden).
 */
export async function claimSession(client: pg.PoolClient, claims: SessionClaims, schema: 'adex' | 'adex_control' = 'adex'): Promise<{ claimed: boolean; revokedPrevious: boolean }> {
  claimReady[schema] ??= (await client.query<{ r: boolean }>(`select to_regprocedure('${schema}.claim_session(uuid,uuid,bigint)') is not null r`)).rows[0]!.r;
  if (!claimReady[schema]) return { claimed: false, revokedPrevious: false };
  const r = (await client.query<{ r: { outcome: string; revokedPrevious?: boolean } }>(`select ${schema}.claim_session($1, $2, $3) r`,
    [claims.identityId, claims.sessionId, claims.iat])).rows[0]!.r;
  if (r.outcome === 'IDENTITY_NOT_PROVISIONED') throw new ApiError(403, 'IDENTITY_NOT_PROVISIONED');
  if (r.outcome !== 'ok') throw new ApiError(401, 'SESSION_REVOKED');
  return { claimed: true, revokedPrevious: r.revokedPrevious === true };
}
