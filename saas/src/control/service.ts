// Plano de control Owner (DS-17, aprobada 2026-10-14): mismo PostgreSQL, plano
// separado. Usa SOLO el rol `adex_control`, que no puede leer ni escribir el esquema
// de las empresas: todo pasa por funciones revisadas que devuelven hechos
// estructurales y comerciales. No hay ninguna operación que lea cartera, caja,
// clientes ni movimientos, ni que entre en una empresa (sin impersonación).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { IdentityProvider } from '../auth/provider.ts';
import { setDbContext, type SessionClaims } from '../db/tx.ts';

/** Campos que la API Owner puede devolver de una empresa. Nada operativo. */
export const COMPANY_CONTROL_FIELDS = [
  'companyId', 'name', 'taxId', 'contactName', 'contactEmail', 'createdAt', 'firstLoginAt', 'lastLoginAt', 'status',
  'routeCount', 'billableRouteCount', 'billingMode', 'billingRate', 'nextBillingDate', 'paymentStatus', 'updatedAt',
] as const;

export async function resolveOperator(client: pg.PoolClient, claims: SessionClaims): Promise<void> {
  await setDbContext(client, claims);
  const r = await client.query<{ s: string }>('select adex_control.operator_status() s');
  const s = r.rows[0]!.s;
  if (s === 'session_revoked') throw new ApiError(401, 'SESSION_REVOKED');
  if (s !== 'ok') throw new ApiError(403, 'OPERATOR_REQUIRED');
}

interface ControlRow {
  company_id: string; name: string; tax_id: string | null; contact_name: string | null; contact_email: string | null;
  created_at: Date; first_login_at: Date | null; last_login_at: Date | null; status: string; route_count: number;
  billable_route_count: number; billing_mode: string; billing_rate: string; next_billing_date: string | null;
  payment_status: string; updated_at: Date;
}

function view(r: ControlRow) {
  return {
    companyId: r.company_id, name: r.name, taxId: r.tax_id, contactName: r.contact_name, contactEmail: r.contact_email,
    createdAt: r.created_at.toISOString(), firstLoginAt: r.first_login_at?.toISOString() ?? null,
    lastLoginAt: r.last_login_at?.toISOString() ?? null, status: r.status, routeCount: r.route_count,
    billableRouteCount: r.billable_route_count, billingMode: r.billing_mode, billingRate: Number(r.billing_rate),
    nextBillingDate: r.next_billing_date, paymentStatus: r.payment_status, updatedAt: r.updated_at.toISOString(),
  };
}

export async function listCompanies(client: pg.PoolClient) {
  const r = await client.query<ControlRow>('select * from adex_control.company_control order by name, company_id');
  return r.rows.map(view);
}

async function getCompany(client: pg.PoolClient, companyId: string) {
  const r = await client.query<ControlRow>('select * from adex_control.company_control where company_id = $1', [companyId]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return view(r.rows[0]);
}

const str = (v: unknown, field: string, re?: RegExp): string => {
  if (typeof v !== 'string' || !v.trim() || (re && !re.test(v))) throw new ApiError(400, `INVALID_${field.toUpperCase()}`);
  return v.trim();
};

export async function createCompany(client: pg.PoolClient, body: Record<string, unknown>) {
  const id = randomUUID();
  await client.query('select adex_control.create_company($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
    id, str(body['name'], 'name'), str(body['email'], 'email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    str(body['plan'] ?? 'basico', 'plan'), str(body['countryCode'], 'countryCode', /^[A-Z]{2}$/), str(body['countryLabel'], 'countryLabel'),
    str(body['currencyCode'], 'currencyCode', /^[A-Z]{3}$/), str(body['timezone'], 'timezone'),
    typeof body['taxId'] === 'string' ? body['taxId'] : null, typeof body['contactName'] === 'string' ? body['contactName'] : null,
    str(body['billingMode'] ?? 'per_route', 'billingMode'), Number(body['billingRate'] ?? 0),
  ]);
  return getCompany(client, id);
}

export async function addSuperadmin(client: pg.PoolClient, companyId: string, body: Record<string, unknown>, provider: IdentityProvider) {
  const email = str(body['email'], 'email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/).toLowerCase();
  const displayName = str(body['displayName'], 'displayName');
  await getCompany(client, companyId);
  const { identityId } = await provider.ensureIdentity(email);
  const membershipId = randomUUID();
  await client.query('select adex_control.create_company_superadmin($1, $2, $3, $4, $5)', [companyId, membershipId, identityId, email, displayName]);
  // Solo el id de la membresía creada: el Owner no recibe nada más de la empresa.
  return { membershipId };
}

export async function setCompanyStatus(client: pg.PoolClient, companyId: string, body: Record<string, unknown>) {
  const status = str(body['status'], 'status', /^(trial|active|suspended)$/);
  await client.query('select adex_control.set_company_status($1, $2, $3)', [companyId, status, typeof body['detail'] === 'string' ? body['detail'] : null]);
  return getCompany(client, companyId);
}

export async function refreshRouteCounts(client: pg.PoolClient, companyId: string) {
  await client.query('select * from adex_control.refresh_route_counts($1)', [companyId]);
  return getCompany(client, companyId);
}

export async function operatorLogout(client: pg.PoolClient, scope: 'local' | 'global') {
  await client.query('select adex_control.logout($1)', [scope === 'global']);
}
