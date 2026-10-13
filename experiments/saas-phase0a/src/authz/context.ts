// Contexto activo: la identidad (del token) elige UNA membresía. La API la relee
// en PostgreSQL dentro de la misma transacción de la operación, de modo que una
// desactivación ya confirmada se aplica a la siguiente petición aunque el token
// siga siendo válido. Empresa, rol y rutas salen de la base, nunca del cliente.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { setDbContext } from '../db/tx.ts';
import type { MembershipGrant, Role } from './permissions.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompanyInfo {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  minorUnits: number;
  timezone: string;
}

export interface ActiveContext extends MembershipGrant {
  identityId: string;
  membershipId: string;
  companyId: string;
  company: CompanyInfo;
}

async function assertProvisioned(client: pg.PoolClient): Promise<void> {
  const r = await client.query('select 1 from adex.identities where id = adex.ctx_identity()');
  if (r.rowCount === 0) throw new ApiError(403, 'IDENTITY_NOT_PROVISIONED');
}

export async function resolveContext(client: pg.PoolClient, identityId: string, membershipId: string): Promise<ActiveContext> {
  if (!UUID_RE.test(membershipId)) throw new ApiError(400, 'INVALID_MEMBERSHIP_ID');
  await setDbContext(client, { identityId, membershipId });
  await assertProvisioned(client);

  // RLS (memberships_self) solo deja ver membresías de ESTA identidad.
  const m = await client.query<{ id: string; company_id: string; role: Role; status: string; scope: 'company' | 'routes' }>(
    'select id, company_id, role, status, scope from adex.memberships where id = $1',
    [membershipId],
  );
  const membership = m.rows[0];
  if (!membership) throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND');
  if (membership.status !== 'active') throw new ApiError(403, 'MEMBERSHIP_INACTIVE');

  await setDbContext(client, { identityId, membershipId, companyId: membership.company_id });
  const c = await client.query<{ id: string; name: string; country_code: string; currency_code: string; minor_units: number; timezone: string; status: string }>(
    `select c.id, c.name, c.country_code, c.currency_code, cur.minor_units, c.timezone, c.status
       from adex.companies c join adex.currencies cur on cur.code = c.currency_code
      where c.id = $1`,
    [membership.company_id],
  );
  const company = c.rows[0];
  if (!company) throw new ApiError(403, 'MEMBERSHIP_NOT_FOUND');
  if (company.status !== 'active') throw new ApiError(403, 'COMPANY_SUSPENDED');

  const routes = await client.query<{ route_id: string }>(
    'select route_id from adex.membership_routes where membership_id = $1 order by route_id',
    [membershipId],
  );

  return {
    identityId,
    membershipId: membership.id,
    companyId: membership.company_id,
    role: membership.role,
    scope: membership.scope,
    routeIds: routes.rows.map((r) => r.route_id),
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

/** Membresías de la identidad, para que el cliente elija el contexto. */
export async function listOwnMemberships(client: pg.PoolClient, identityId: string) {
  await setDbContext(client, { identityId });
  await assertProvisioned(client);
  const r = await client.query<{ id: string; company_id: string; role: string; status: string; scope: string }>(
    'select id, company_id, role, status, scope from adex.memberships order by company_id, role',
  );
  return r.rows.map((m) => ({ membershipId: m.id, companyId: m.company_id, role: m.role, status: m.status, scope: m.scope }));
}
