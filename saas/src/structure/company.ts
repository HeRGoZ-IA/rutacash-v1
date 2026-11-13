// Datos de la EMPRESA (SettingsPage de CLEAN → comando). `settings.access`
// (SuperAdmin y Administrador) edita los datos de contacto. Estado comercial, plan y
// vencimiento son del plano Owner (DS-17); país, moneda y zona horaria son
// estructurales (unidades menores, periodos) y no se editan desde la empresa.

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need, snapshot } from './common.ts';
import { has, optText, reqText } from './input.ts';

const COLS = ['name', 'legal_name', 'tax_id', 'email', 'phone', 'city', 'address', 'contact_name'] as const;
const FIELDS: Record<string, (typeof COLS)[number]> = {
  name: 'name', legalName: 'legal_name', taxId: 'tax_id', email: 'email', phone: 'phone', city: 'city', address: 'address', contactName: 'contact_name',
};
export const COMPANY_FIELDS = Object.keys(FIELDS);

type Row = Record<(typeof COLS)[number], string | null> & { id: string; collector_pin: string | null; country_code: string; country_label: string; currency_code: string; timezone: string; plan: string; status: string };

function view(r: Row) {
  return {
    id: r.id, name: r.name, legalName: r.legal_name, taxId: r.tax_id, email: r.email, phone: r.phone, city: r.city, address: r.address,
    contactName: r.contact_name, countryCode: r.country_code, countryLabel: r.country_label, currencyCode: r.currency_code,
    timezone: r.timezone, plan: r.plan, status: r.status,
    // 3.45 (0056): el PIN nunca sale hacia la oficina; solo si sigue en el valor inicial 0000.
    collectorPinIsDefault: r.collector_pin === null,
  };
}

async function load(client: pg.PoolClient, ctx: ActiveContext, lock = false): Promise<Row> {
  const r = await client.query<Row>(
    `select id, ${COLS.join(', ')}, collector_pin, country_code, country_label, currency_code, timezone, plan, status
       from adex.companies where id = $1 ${lock ? 'for no key update' : ''}`, [ctx.companyId]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

export async function getCompany(client: pg.PoolClient, ctx: ActiveContext) {
  need(ctx, 'settings.access');
  return view(await load(client, ctx));
}

export async function updateCompany(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  const prev = await load(client, ctx, true);
  const next: Partial<Record<(typeof COLS)[number], string | null>> = {};
  for (const [field, col] of Object.entries(FIELDS)) {
    if (!has(body, field)) continue;
    next[col] = field === 'name' || field === 'email' ? reqText(body, field) : optText(body, field);
  }
  if (next.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email!)) throw new ApiError(400, 'INVALID_EMAIL');
  if (next.email) next.email = next.email.toLowerCase();
  const changed = (Object.keys(next) as (typeof COLS)[number][]).filter((c) => next[c] !== prev[c]);
  if (!changed.length) return view(prev);
  const sets = changed.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await client.query(`update adex.companies set ${sets}, updated_at = now() where id = $1`, [ctx.companyId, ...changed.map((c) => next[c])]);
  await audit(client, ctx, {
    action: 'UPDATE_TENANT', entityType: 'company', entityId: ctx.companyId, description: `Empresa actualizada: ${next.name ?? prev.name}`,
    before: snapshot(prev, changed), after: Object.fromEntries(changed.map((c) => [c, next[c]])),
  });
  return view(await load(client, ctx));
}

// ---------- 3.45 (0056): PIN de bloqueo de la app del Cobrador ----------
// Un PIN de 4 dígitos por empresa. Se guarda como derivación PBKDF2-SHA256 con sal; la app del Cobrador se copia
// la derivación para comprobarlo sin señal. NULL = valor inicial 0000 (elegir 0000 vuelve a ese estado).

export const COLLECTOR_PIN_ITERATIONS = 100_000;

export function deriveCollectorPin(pin: string, salt: Buffer = randomBytes(16), iterations = COLLECTOR_PIN_ITERATIONS): string {
  const dk = pbkdf2Sync(pin, salt, iterations, 32, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

/** SuperAdmin y Administrador (`settings.access`) definen o cambian el PIN. El PIN nunca queda en la auditoría. */
export async function setCollectorPin(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  const pin = body['pin'];
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new ApiError(400, 'INVALID_PIN');
  const prev = await load(client, ctx, true);
  const value = pin === '0000' ? null : deriveCollectorPin(pin);
  await client.query('update adex.companies set collector_pin = $2, updated_at = now() where id = $1', [ctx.companyId, value]);
  await audit(client, ctx, {
    action: 'UPDATE_COLLECTOR_PIN', entityType: 'company', entityId: ctx.companyId,
    description: value === null ? 'PIN de bloqueo del Cobrador devuelto al valor inicial' : 'PIN de bloqueo del Cobrador cambiado',
    before: { collectorPinIsDefault: prev.collector_pin === null }, after: { collectorPinIsDefault: value === null },
  });
  return { collectorPinIsDefault: value === null };
}

/** El Cobrador lee la derivación del PIN de su empresa (null = 0000) para bloquear y desbloquear sin señal. */
export async function getCollectorLock(client: pg.PoolClient, ctx: ActiveContext) {
  if (ctx.role !== 'cobrador') throw new ApiError(403, 'PERMISSION_DENIED');
  const r = await client.query<{ collector_pin: string | null }>('select collector_pin from adex.companies where id = $1', [ctx.companyId]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return { pin: r.rows[0].collector_pin, idleMinutes: 10, maxAttempts: 5 };
}
