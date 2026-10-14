// Contexto activo (DS-05): la identidad del token elige UNA membresía por petición
// (encabezado `X-Adex-Membership`). Empresa, rol, estado y rutas se releen en
// PostgreSQL DENTRO de la transacción de la operación; nunca se toman del cliente
// ni del token. Una revocación ya confirmada se aplica a la siguiente operación
// aunque el token siga siendo válido.
//
// REVOKE-004 (aprobado 2026-10-14): antes de leer nada, la operación toma los
// bloqueos consultivos COMPARTIDOS de su identidad, membresía y empresa. Toda vía
// de revocación toma el EXCLUSIVO (disparadores de 0005), así que:
//   · una revocación espera a que terminen las operaciones en curso;
//   · una operación que empieza durante una revocación espera y, al seguir, ve el
//     estado nuevo y se rechaza.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { setDbContext, type SessionClaims } from '../db/tx.ts';
import type { MembershipFacts, UserRole } from './cleanRules.ts';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface CompanyFacts {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  minorUnits: number;
  timezone: string;
}

export interface ActiveContext extends MembershipFacts {
  claims: SessionClaims;
  company: CompanyFacts;
}

/** Identidad aprovisionada, activa y con sesión no revocada (sin contexto de empresa). */
export async function resolveIdentity(client: pg.PoolClient, claims: SessionClaims): Promise<void> {
  await setDbContext(client, claims);
  await client.query('select adex.acquire_operation_locks()');
  const r = await client.query<{ status: string; session_ok: boolean }>(
    'select i.status, adex.ctx_session_valid() as session_ok from adex.identities i where i.id = adex.ctx_identity()',
  );
  const row = r.rows[0];
  if (!row) throw new ApiError(403, 'IDENTITY_NOT_PROVISIONED');
  if (!row.session_ok) throw new ApiError(401, 'SESSION_REVOKED');
  if (row.status !== 'active') throw new ApiError(403, 'IDENTITY_DISABLED');
}

export async function resolveContext(client: pg.PoolClient, claims: SessionClaims, membershipId: string): Promise<ActiveContext> {
  if (!ID_RE.test(membershipId)) throw new ApiError(400, 'INVALID_MEMBERSHIP_ID');
  await setDbContext(client, { ...claims, membershipId });
  await resolveIdentity(client, claims);
  await setDbContext(client, { ...claims, membershipId });
  await client.query('select adex.acquire_operation_locks()');

  // RLS (`memberships_ctx`) solo deja ver las membresías de ESTA identidad: una
  // membresía ajena es indistinguible de una inexistente.
  const m = await client.query<{ id: string; company_id: string; role: UserRole; status: 'activo' | 'inactivo'; display_name: string; created_at: Date }>(
    'select id, company_id, role, status, display_name, created_at from adex.memberships where id = $1 and identity_id = adex.ctx_identity()',
    [membershipId],
  );
  const membership = m.rows[0];
  if (!membership) throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND');
  if (membership.status !== 'activo') throw new ApiError(403, 'MEMBERSHIP_INACTIVE');

  await setDbContext(client, { ...claims, membershipId, companyId: membership.company_id });
  await client.query('select adex.acquire_operation_locks()');
  const c = await client.query<{
    id: string; name: string; country_code: string; currency_code: string; minor_units: number; timezone: string;
    operable: boolean; ctx_ok: boolean;
  }>(
    `select c.id, c.name, c.country_code, c.currency_code, cur.minor_units, c.timezone,
            adex.company_is_operable(c.status, c.expires_on, c.timezone) as operable,
            adex.ctx_membership_active() as ctx_ok
       from adex.companies c join adex.currencies cur on cur.code = c.currency_code
      where c.id = $1`,
    [membership.company_id],
  );
  const company = c.rows[0];
  if (!company) throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND');
  if (!company.operable) throw new ApiError(403, 'COMPANY_BLOCKED');
  if (!company.ctx_ok) throw new ApiError(403, 'CONTEXT_INVALID');

  const routes = await client.query<{ route_id: string }>(
    'select route_id from adex.membership_routes where membership_id = $1 order by route_id', [membershipId],
  );
  return {
    claims,
    membershipId: membership.id,
    companyId: membership.company_id,
    role: membership.role,
    status: membership.status,
    displayName: membership.display_name,
    routeIds: routes.rows.map((r) => r.route_id),
    createdAt: membership.created_at.toISOString(),
    company: {
      id: company.id,
      name: company.name,
      countryCode: company.country_code,
      currencyCode: company.currency_code,
      minorUnits: company.minor_units,
      timezone: company.timezone,
    },
  };
}

export interface MembershipOption {
  membershipId: string;
  role: UserRole;
  status: 'activo' | 'inactivo';
  company: { id: string; name: string; countryCode: string; operable: boolean };
}

/** Membresías de la identidad para el selector (DS-05). Solo las suyas. */
export async function listOwnMemberships(client: pg.PoolClient, claims: SessionClaims): Promise<MembershipOption[]> {
  await resolveIdentity(client, claims);
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; company_id: string; name: string | null; country_code: string | null; operable: boolean | null }>(
    `select m.id, m.role, m.status, m.company_id, c.name, c.country_code,
            adex.company_is_operable(c.status, c.expires_on, c.timezone) as operable
       from adex.memberships m left join adex.companies c on c.id = m.company_id
      where m.identity_id = adex.ctx_identity()
      order by c.name, m.role`,
  );
  return r.rows
    .filter((m) => m.name !== null) // empresa invisible = membresía inactiva o identidad sin acceso
    .map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      company: { id: m.company_id, name: m.name!, countryCode: m.country_code!, operable: m.operable === true },
    }));
}
