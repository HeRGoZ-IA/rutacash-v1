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
import type { SessionClaims } from '../db/tx.ts';
import type { MembershipFacts, UserRole } from './cleanRules.ts';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface CompanyFacts {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  minorUnits: number;
  timezone: string;
  /** Empresa Demo (datos ficticios, ciclo de vida en `adex_demo`, 0011). */
  isDemo: boolean;
}

export interface ActiveContext extends MembershipFacts {
  claims: SessionClaims;
  company: CompanyFacts;
}

// Una sola llamada (0012, `adex.open_request_context`) hace la secuencia completa en
// PostgreSQL: fijar contexto → bloqueo de identidad → identidad y sesión → bloqueo de
// membresía → membresía → bloqueo de empresa → empresa operable → rutas. Mismo orden,
// mismos bloqueos y las mismas políticas RLS (la función corre como `adex_api`); solo
// se ahorran los viajes de red (≈11 → 1).
const OUTCOME: Record<string, ApiError> = {
  IDENTITY_NOT_PROVISIONED: new ApiError(403, 'IDENTITY_NOT_PROVISIONED'),
  SESSION_REVOKED: new ApiError(401, 'SESSION_REVOKED'),
  IDENTITY_DISABLED: new ApiError(403, 'IDENTITY_DISABLED'),
  MEMBERSHIP_NOT_FOUND: new ApiError(403, 'MEMBERSHIP_NOT_FOUND'),
  MEMBERSHIP_INACTIVE: new ApiError(403, 'MEMBERSHIP_INACTIVE'),
  COMPANY_BLOCKED: new ApiError(403, 'COMPANY_BLOCKED'),
  CONTEXT_INVALID: new ApiError(403, 'CONTEXT_INVALID'),
};

interface OpenedContext {
  outcome: string;
  membership?: { id: string; companyId: string; role: UserRole; status: 'activo' | 'inactivo'; displayName: string; createdAt: string };
  company?: CompanyFacts;
  routeIds?: string[];
}

async function openContext(client: pg.PoolClient, claims: SessionClaims, membershipId: string | null): Promise<OpenedContext> {
  const r = await client.query<{ r: OpenedContext }>('select adex.open_request_context($1, $2, $3, $4) r',
    [claims.identityId, claims.sessionId, String(claims.iat), membershipId]);
  const opened = r.rows[0]!.r;
  if (opened.outcome !== 'ok') throw OUTCOME[opened.outcome] ?? new ApiError(403, 'CONTEXT_INVALID');
  return opened;
}

/** Identidad aprovisionada, activa y con sesión no revocada (sin contexto de empresa). */
export async function resolveIdentity(client: pg.PoolClient, claims: SessionClaims): Promise<void> {
  await openContext(client, claims, null);
}

export async function resolveContext(client: pg.PoolClient, claims: SessionClaims, membershipId: string): Promise<ActiveContext> {
  if (!ID_RE.test(membershipId)) throw new ApiError(400, 'INVALID_MEMBERSHIP_ID');
  const { membership, company, routeIds } = await openContext(client, claims, membershipId);
  return {
    claims,
    membershipId: membership!.id,
    companyId: membership!.companyId,
    role: membership!.role,
    status: membership!.status,
    displayName: membership!.displayName,
    routeIds: routeIds ?? [],
    createdAt: new Date(membership!.createdAt).toISOString(),
    company: company!,
  };
}

export interface MembershipOption {
  membershipId: string;
  role: UserRole;
  status: 'activo' | 'inactivo';
  company: { id: string; name: string; countryCode: string; operable: boolean; isDemo: boolean };
}

/** Membresías de la identidad para el selector (DS-05). Solo las suyas. */
export async function listOwnMemberships(client: pg.PoolClient, claims: SessionClaims): Promise<MembershipOption[]> {
  await resolveIdentity(client, claims);
  const r = await client.query<{ id: string; role: UserRole; status: 'activo' | 'inactivo'; company_id: string; name: string | null; country_code: string | null; operable: boolean | null; is_demo: boolean | null }>(
    `select m.id, m.role, m.status, m.company_id, c.name, c.country_code, c.is_demo,
            adex.company_is_operable(c.status, c.expires_on, c.timezone) as operable
       from adex.memberships m left join adex.companies c on c.id = m.company_id
      where m.identity_id = adex.ctx_identity()
      order by c.name, m.role`,
  );
  return r.rows
    // Empresa invisible = membresía inactiva, identidad sin acceso o Demo retirada (0011).
    .filter((m) => m.name !== null)
    .map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      company: { id: m.company_id, name: m.name!, countryCode: m.country_code!, operable: m.operable === true, isDemo: m.is_demo === true },
    }));
}
