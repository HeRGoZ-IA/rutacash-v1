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

export async function createCompany(client: pg.PoolClient, body: Record<string, unknown>, provider: IdentityProvider) {
  const id = randomUUID();
  // Ronda 40: el alta de la Plataforma Owner original (CLEAN) crea la empresa, su estado
  // comercial inicial y su PRIMER SuperAdmin en UNA transacción: nunca queda una empresa
  // sin SuperAdmin por un fallo a medias.
  const status = body['status'] === undefined ? 'trial' : str(body['status'], 'status', /^(trial|active)$/);
  const sa = body['superAdmin'];
  if (sa !== undefined && (typeof sa !== 'object' || sa === null || Array.isArray(sa))) throw new ApiError(400, 'INVALID_SUPERADMIN');
  await client.query('select adex_control.create_company($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [
    id, str(body['name'], 'name'), str(body['email'], 'email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    str(body['plan'] ?? 'basico', 'plan'), str(body['countryCode'], 'countryCode', /^[A-Z]{2}$/), str(body['countryLabel'], 'countryLabel'),
    str(body['currencyCode'], 'currencyCode', /^[A-Z]{3}$/), str(body['timezone'], 'timezone'),
    typeof body['taxId'] === 'string' ? body['taxId'] : null, typeof body['contactName'] === 'string' ? body['contactName'] : null,
    str(body['billingMode'] ?? 'per_route', 'billingMode'), Number(body['billingRate'] ?? 0),
  ]);
  if (status === 'active') await client.query('select adex_control.set_company_status($1, $2, $3)', [id, 'active', null]);
  const superAdmin = sa === undefined ? null : await addSuperadmin(client, id, sa as Record<string, unknown>, provider);
  return { ...(await getCompany(client, id)), superAdmin };
}

export async function addSuperadmin(client: pg.PoolClient, companyId: string, body: Record<string, unknown>, provider: IdentityProvider) {
  for (const k of Object.keys(body)) if (!['email', 'displayName'].includes(k)) throw new ApiError(400, 'UNKNOWN_FIELD');
  const email = str(body['email'], 'email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/).toLowerCase();
  const displayName = str(body['displayName'], 'displayName');
  await getCompany(client, companyId);
  const { identityId, created } = await provider.ensureIdentity(email);
  const membershipId = randomUUID();
  await client.query('select adex_control.create_company_superadmin($1, $2, $3, $4, $5)', [companyId, membershipId, identityId, email, displayName]);
  // Solo el id de la membresía creada y si la persona es nueva en ADEX: el Owner no recibe
  // nada más de la empresa. Una identidad que ya existía entra con su contraseña de siempre.
  return { membershipId, identity: created ? 'new' : 'existing' };
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

// ---------- Panel Owner SaaS (Ronda 20) ----------
// Solo usa lo que `adex_control` ya tenía concedido en 0006: lectura de su propio
// esquema, columnas de facturación de `company_control` y `saas_payments` (cobros de
// ADEX a la empresa; NO es dinero de la empresa). Nada del esquema `adex`.

/** Perfil del Owner de la sesión (nombre y fechas). La identidad viene del token verificado. */
export async function operatorProfile(client: pg.PoolClient, claims: SessionClaims) {
  const r = await client.query<{ display_name: string; role: string; created_at: Date }>(
    'select display_name, role, created_at from adex_control.platform_operators where identity_id = $1', [claims.identityId]);
  if (!r.rows[0]) throw new ApiError(403, 'OPERATOR_REQUIRED');
  return { displayName: r.rows[0].display_name, role: r.rows[0].role, since: r.rows[0].created_at.toISOString() };
}

interface PaymentRow { id: string; period: string; amount: string; expected_date: string; paid_date: string | null; status: string; note: string | null; created_at: Date }
const paymentView = (p: PaymentRow) => ({
  id: p.id, period: p.period, amount: Number(p.amount), expectedDate: p.expected_date, paidDate: p.paid_date, status: p.status, note: p.note,
  createdAt: p.created_at.toISOString(),
});

/** Ficha de una empresa: datos de control, historial estructural/comercial y cobros SaaS. */
export async function companyDetail(client: pg.PoolClient, companyId: string) {
  const company = await getCompany(client, companyId);
  // Ronda 40 (0021): país, moneda y zona horaria (solo lectura) y los SuperAdmins (nombre,
  // correo, estado): aprovisionamiento, nada operativo.
  const locale = (await client.query<{ country_code: string; country_label: string; currency_code: string; timezone: string }>(
    'select * from adex_control.company_locale($1)', [companyId])).rows[0];
  const superadmins = (await client.query<{ membership_id: string; email: string; display_name: string; status: string; exclusive: boolean; created_at: Date }>(
    'select membership_id, email, display_name, status, exclusive, created_at from adex_control.company_superadmins($1)', [companyId])).rows;
  const events = await client.query<{ type: string; at: Date; detail: string | null }>(
    'select type, at, detail from adex_control.control_events where company_id = $1 order by at desc limit 100', [companyId]);
  const payments = await client.query<PaymentRow>(
    `select id, period, amount, to_char(expected_date, 'YYYY-MM-DD') expected_date, to_char(paid_date, 'YYYY-MM-DD') paid_date, status, note, created_at
       from adex_control.saas_payments where company_id = $1 order by period desc, created_at desc`, [companyId]);
  return {
    company,
    locale: locale ? { countryCode: locale.country_code, countryLabel: locale.country_label, currencyCode: locale.currency_code, timezone: locale.timezone } : null,
    superadmins: superadmins.map((m) => ({ id: m.membership_id, email: m.email, displayName: m.display_name, status: m.status,
      linkAllowed: m.exclusive && m.status === 'activo', createdAt: m.created_at.toISOString() })),
    events: events.rows.map((e) => ({ type: e.type, at: e.at.toISOString(), detail: e.detail })),
    payments: payments.rows.map(paymentView),
  };
}

/**
 * Enlace de PRIMER ACCESO de un SuperAdmin (Ronda 40). Solo para una membresía SuperAdmin
 * activa de esa empresa cuya identidad sea exclusiva de ella (no pertenece a otra empresa
 * ni es Owner) y que NUNCA haya iniciado sesión (lo comprueba el proveedor). El token se
 * devuelve una vez y no se guarda ni se registra; el historial anota que se emitió y quién.
 */
export async function superadminAccessLink(client: pg.PoolClient, companyId: string, membershipId: string, provider: IdentityProvider) {
  await getCompany(client, companyId);
  const r = await client.query<{ identity_id: string; email: string; status: string; exclusive: boolean }>(
    'select identity_id, email, status, exclusive from adex_control.company_superadmins($1) where membership_id = $2', [companyId, membershipId]);
  const t = r.rows[0];
  if (!t) throw new ApiError(404, 'NOT_FOUND');
  if (t.status !== 'activo') throw new ApiError(409, 'MEMBERSHIP_INACTIVE');
  if (!t.exclusive) throw new ApiError(409, 'IDENTITY_SHARED');
  const out = await provider.issueAccessLink(t.identity_id, t.email);
  if (out.status === 'already_active') return { status: 'already_active' as const };
  await client.query('select adex_control.record_access_link($1, $2)', [companyId, membershipId]);
  return { status: 'issued' as const, tokenHash: out.tokenHash };
}

/** Nombre, identificación y contacto de la empresa (Ficha comercial de CLEAN). */
export async function updateProfile(client: pg.PoolClient, companyId: string, body: Record<string, unknown>) {
  const opt = (k: string) => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : null);
  const contactEmail = opt('contactEmail');
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new ApiError(400, 'INVALID_CONTACTEMAIL');
  await client.query('select adex_control.update_company_profile($1, $2, $3, $4, $5)',
    [companyId, str(body['name'], 'name'), opt('taxId'), opt('contactName'), contactEmail]);
  return getCompany(client, companyId);
}

/** Owners de la plataforma (Configuración del portal). */
export async function listOperators(client: pg.PoolClient, claims: SessionClaims) {
  const r = await client.query<{ identity_id: string; display_name: string; email: string; status: string; first_login_at: Date | null; last_login_at: Date | null; created_at: Date }>(
    'select * from adex_control.list_operators()');
  return r.rows.map((o) => ({ displayName: o.display_name, email: o.email, status: o.status, self: o.identity_id === claims.identityId,
    firstLoginAt: o.first_login_at?.toISOString() ?? null, lastLoginAt: o.last_login_at?.toISOString() ?? null, createdAt: o.created_at.toISOString() }));
}

/** Acceso correcto al portal Owner: sella primer y último ingreso del propio Owner. */
export async function recordOperatorLogin(client: pg.PoolClient, claims: SessionClaims) {
  await client.query('select adex_control.record_operator_login()');
  return operatorProfile(client, claims);
}

/** Todos los cobros SaaS (vista de facturación). Solo hechos de ADEX con sus clientes. */
export async function listPayments(client: pg.PoolClient) {
  const r = await client.query<PaymentRow & { company_id: string; company_name: string }>(
    `select p.id, p.company_id, c.name company_name, p.period, p.amount, to_char(p.expected_date, 'YYYY-MM-DD') expected_date,
            to_char(p.paid_date, 'YYYY-MM-DD') paid_date, p.status, p.note, p.created_at
       from adex_control.saas_payments p join adex_control.company_control c on c.company_id = p.company_id
      order by p.expected_date desc, c.name`);
  return r.rows.map((p) => ({ ...paymentView(p), companyId: p.company_id, companyName: p.company_name }));
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const amountOf = (v: unknown, field: string, min: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > 1e9 || Math.round(n * 100) !== n * 100) throw new ApiError(400, `INVALID_${field.toUpperCase()}`);
  return n;
};
const optDate = (v: unknown, field: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new ApiError(400, `INVALID_${field.toUpperCase()}`);
  return v;
};

/** Condiciones de facturación SaaS de la empresa (modo, tarifa, próximo cobro, estado de pago). */
export async function updateBilling(client: pg.PoolClient, companyId: string, body: Record<string, unknown>) {
  const mode = str(body['billingMode'], 'billingMode', /^(per_route|fixed)$/);
  const rate = amountOf(body['billingRate'], 'billingRate', 0);
  const next = optDate(body['nextBillingDate'], 'nextBillingDate');
  const status = str(body['paymentStatus'], 'paymentStatus', /^(pending|paid|overdue)$/);
  const r = await client.query(
    `update adex_control.company_control set billing_mode = $2, billing_rate = $3, next_billing_date = $4, payment_status = $5, updated_at = now()
      where company_id = $1`, [companyId, mode, rate, next, status]);
  if (r.rowCount !== 1) throw new ApiError(404, 'NOT_FOUND');
  return getCompany(client, companyId);
}

/** Registra un cobro de ADEX a la empresa (periodo AAAA-MM). */
export async function registerPayment(client: pg.PoolClient, companyId: string, body: Record<string, unknown>) {
  await getCompany(client, companyId);
  const period = str(body['period'], 'period', /^\d{4}-(0[1-9]|1[0-2])$/);
  const amount = amountOf(body['amount'], 'amount', 0.01);
  const expected = optDate(body['expectedDate'], 'expectedDate') ?? fail('expectedDate');
  const status = str(body['status'] ?? 'pending', 'status', /^(pending|paid|overdue)$/);
  const paid = optDate(body['paidDate'], 'paidDate');
  if ((status === 'paid') !== (paid !== null)) throw new ApiError(400, 'INVALID_PAIDDATE');
  const note = typeof body['note'] === 'string' && body['note'].trim() ? body['note'].trim().slice(0, 200) : null;
  const id = randomUUID();
  await client.query(
    `insert into adex_control.saas_payments (id, company_id, period, amount, expected_date, paid_date, status, note, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`, [id, companyId, period, amount, expected, paid, status, note]);
  return (await companyDetail(client, companyId)).payments.find((p) => p.id === id)!;
}

/** Cambia el estado de un cobro SaaS (pendiente, pagado con fecha, vencido). */
export async function setPaymentStatus(client: pg.PoolClient, paymentId: string, body: Record<string, unknown>) {
  const status = str(body['status'], 'status', /^(pending|paid|overdue)$/);
  const paid = optDate(body['paidDate'], 'paidDate');
  if ((status === 'paid') !== (paid !== null)) throw new ApiError(400, 'INVALID_PAIDDATE');
  const r = await client.query<PaymentRow>(
    `update adex_control.saas_payments set status = $2, paid_date = $3, updated_at = now() where id = $1
     returning id, period, amount, to_char(expected_date, 'YYYY-MM-DD') expected_date, to_char(paid_date, 'YYYY-MM-DD') paid_date, status, note, created_at`,
    [paymentId, status, paid]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return paymentView(r.rows[0]);
}

function fail(field: string): never {
  throw new ApiError(400, `INVALID_${field.toUpperCase()}`);
}
