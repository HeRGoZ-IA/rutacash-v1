// Adaptador de repositorio Dexie v16 ↔ PostgreSQL, guiado por `dexieV16.ts`.
//
// Base del banco de contratos (plan §5.1): escribe registros con la forma EXACTA de
// los modelos de CLEAN y los vuelve a leer con esa misma forma. Lo usan las semillas
// sintéticas y las pruebas de contrato; en la Fase 7 será la base de la importación
// diagnosticada (nunca automática, plan §4).
//
// Conversión SIN pérdida o error explícito:
//   · dinero: entero de la moneda × 10^minor_units (un decimal lanzaría);
//   · fechas contables `yyyy-MM-dd` ↔ `date`; instantes ISO ↔ `timestamptz`;
//   · '' ↔ NULL solo donde Dexie usa '' como «sin valor» (`idOrEmpty`).
// Escribe con el ADMINISTRADOR (semillas e importación), nunca con `adex_api`.

import type pg from 'pg';
import { DEXIE_V16_TABLES, type FieldKind, type FieldMap, type TableMap, tableMap } from './dexieV16.ts';

export type DexieRecord = Record<string, unknown>;
/** Tablas Dexie → registros (cualquier interfaz de CLEAN: se leen como diccionarios). */
export type DexieSnapshot = Partial<Record<string, object[]>>;
const recs = (snap: DexieSnapshot, table: string) => (snap[table] ?? []) as DexieRecord[];

/** Orden de inserción (las FK circulares son DEFERRABLE y se validan en el COMMIT). */
export const INSERT_ORDER = [
  'tenants', 'users', 'offices', 'routes', 'expenseCategories', 'clients', 'saleRequests', 'sales', 'installments',
  'payments', 'paymentAdjustmentRequests', 'noPaymentVisits', 'expenses', 'capitalMovements', 'transfers', 'withdrawals',
  'capitalLedger', 'routeCapitalControllerEvents', 'partnerCashMovements', 'cashCustodyMovements', 'cashSettlements',
  'weeklySettlements', 'auditLogs', 'platformUsers', 'companyControl', 'saasPayments', 'controlEvents',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class LossyConversionError extends Error {}

function pow10(mu: number): bigint {
  return 10n ** BigInt(mu);
}

export function toSqlValue(kind: FieldKind, value: unknown, minorUnits: number, where: string): unknown {
  if (value === undefined || value === null) return null;
  switch (kind) {
    case 'idOrEmpty':
      return value === '' ? null : value;
    case 'money': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new LossyConversionError(`${where}: money must be a safe integer, got ${String(value)}`);
      }
      return (BigInt(value) * pow10(minorUnits)).toString();
    }
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new LossyConversionError(`${where}: integer expected`);
      return value;
    case 'num':
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new LossyConversionError(`${where}: number expected`);
      return String(value);
    case 'date':
      if (typeof value !== 'string' || !DATE_RE.test(value)) throw new LossyConversionError(`${where}: yyyy-MM-dd expected, got ${String(value)}`);
      return value;
    case 'instant': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new LossyConversionError(`${where}: canonical ISO instant expected, got ${String(value)}`);
      }
      return value;
    }
    case 'json':
      return JSON.stringify(value);
    default:
      return value;
  }
}

export function fromSqlValue(kind: FieldKind, value: unknown, minorUnits: number, where: string): unknown {
  if (value === null || value === undefined) return kind === 'idOrEmpty' ? '' : undefined;
  switch (kind) {
    case 'money': {
      const minor = BigInt(value as string);
      const scale = pow10(minorUnits);
      if (minor % scale !== 0n) throw new LossyConversionError(`${where}: ${minor} minor units is not a whole amount`);
      return Number(minor / scale);
    }
    case 'num':
    case 'decimal':
      return Number(value);
    case 'instant':
      return (value as Date).toISOString();
    case 'int':
    case 'float':
      return Number(value);
    default:
      return value;
  }
}

/** Fila SQL (columna → valor) a partir de un registro Dexie. */
export function toRow(t: TableMap, rec: DexieRecord, minorUnits: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { ...extra };
  for (const m of t.fields) {
    const where = `${t.dexieTable}.${m.field}`;
    if (m.kind === 'identityEmail' || m.kind === 'routeList') continue;
    if (m.kind === 'actor') {
      const v = rec[m.field];
      const isSystem = typeof v === 'string' && v.startsWith('system:');
      row[`${m.column}_membership_id`] = isSystem ? null : (v ?? null);
      row[`${m.column}_system`] = isSystem ? v : null;
      continue;
    }
    row[m.column] = toSqlValue(m.kind, rec[m.field], minorUnits, where);
  }
  return row;
}

/** Registro Dexie a partir de una fila SQL (los ausentes quedan sin clave, como en Dexie). */
export function fromRow(t: TableMap, row: Record<string, unknown>, minorUnits: number): DexieRecord {
  const rec: DexieRecord = {};
  for (const m of t.fields) {
    if (m.kind === 'identityEmail' || m.kind === 'routeList') continue;
    let v: unknown;
    if (m.kind === 'actor') v = row[`${m.column}_membership_id`] ?? row[`${m.column}_system`] ?? undefined;
    else v = fromSqlValue(m.kind, row[m.column], minorUnits, `${t.dexieTable}.${m.field}`);
    if (v !== undefined) rec[m.field] = v;
  }
  return rec;
}

function companyOf(t: TableMap, rec: DexieRecord, saleCompany: Map<string, string>): string | null {
  if (t.dexieTable === 'tenants') return rec['id'] as string;
  if (t.dexieTable === 'installments') return saleCompany.get(rec['saleId'] as string) ?? null;
  if (t.source === 'platform') return (rec['companyId'] as string | undefined) ?? null;
  return (rec['tenantId'] as string | undefined) ?? null;
}

async function insertRow(client: pg.ClientBase, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  const sql = `insert into ${table} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
  await client.query(sql, cols.map((c) => row[c]));
}

export interface ImportOptions {
  /** correo normalizado → id de identidad (uuid del proveedor). Sin entrada: membresía sin acceso. */
  identityIds: Record<string, string>;
  /** Empresa → país ISO y zona IANA (no existen en Dexie, ver `dexieV16` added). */
  companyIntl: Record<string, { countryCode: string; timezone: string }>;
}

/**
 * Inserta un snapshot Dexie en UNA transacción (todo o nada). El cliente debe ser el
 * administrador del proyecto (BYPASSRLS): con FORCE RLS ningún otro rol puede sembrar.
 */
export async function importSnapshot(client: pg.ClientBase, snap: DexieSnapshot, opts: ImportOptions): Promise<void> {
  const minorByCompany = new Map<string, number>();
  const currencies = await client.query<{ code: string; minor_units: number }>('select code, minor_units from adex.currencies');
  const minorByCurrency = new Map(currencies.rows.map((r) => [r.code, r.minor_units]));
  for (const t of recs(snap, 'tenants')) {
    const mu = minorByCurrency.get(t['moneda'] as string);
    if (mu === undefined) throw new Error(`tenant ${String(t['id'])}: unsupported currency ${String(t['moneda'])}`);
    minorByCompany.set(t['id'] as string, mu);
  }
  const saleCompany = new Map(recs(snap, 'sales').map((s) => [s['id'] as string, s['tenantId'] as string]));
  const pendingRoutes: [string, string, string][] = [];

  await client.query('begin');
  try {
    // Identidades primero (personas), una sola vez por correo.
    const emails = new Set<string>();
    for (const tbl of ['users', 'platformUsers']) {
      for (const u of recs(snap, tbl)) {
        const email = String(u['email']).trim().toLowerCase();
        if (opts.identityIds[email] && !emails.has(email)) {
          emails.add(email);
          // Alta de la identidad = alta del primer registro de esa persona (determinista).
          await client.query('insert into adex.identities (id, email, created_at, updated_at) values ($1, $2, $3, $3) on conflict (id) do nothing',
            [opts.identityIds[email], email, u['createdAt'] ?? null]);
        }
      }
    }
    for (const name of INSERT_ORDER) {
      const t = tableMap(name);
      if (!t.sqlTable) continue;
      for (const rec of recs(snap, name)) {
        const company = companyOf(t, rec, saleCompany);
        const mu = company ? (minorByCompany.get(company) ?? 0) : 0;
        const extra: Record<string, unknown> = {};
        if (name === 'tenants') {
          const intl = opts.companyIntl[rec['id'] as string];
          if (!intl) throw new Error(`tenant ${String(rec['id'])}: country_code/timezone required`);
          extra['country_code'] = intl.countryCode;
          extra['timezone'] = intl.timezone;
        }
        if (name === 'installments') {
          if (!company) throw new Error(`installment ${String(rec['id'])}: sale not in snapshot`);
          extra['company_id'] = company;
        }
        if (name === 'users' || name === 'platformUsers') {
          extra['identity_id'] = opts.identityIds[String(rec['email']).trim().toLowerCase()] ?? null;
        }
        await insertRow(client, t.sqlTable, toRow(t, rec, mu, extra));
        if (name === 'users') {
          const routes = new Set<string>((rec['authorizedRouteIds'] as string[] | undefined) ?? []);
          if (rec['routeId']) routes.add(rec['routeId'] as string);
          for (const r of routes) {
            pendingRoutes.push([company as string, rec['id'] as string, r]);
          }
        }
      }
      // Las rutas autorizadas se insertan cuando las rutas ya existen.
      if (name === 'routes') {
        for (const [c, m, r] of pendingRoutes.splice(0)) {
          await client.query('insert into adex.membership_routes (company_id, membership_id, route_id) values ($1, $2, $3)', [c, m, r]);
        }
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Lee una empresa completa con la forma Dexie (para contrato y diagnóstico). */
export async function exportCompany(client: pg.ClientBase, companyId: string): Promise<DexieSnapshot> {
  const company = await client.query<{ minor_units: number }>(
    'select cur.minor_units from adex.companies c join adex.currencies cur on cur.code = c.currency_code where c.id = $1', [companyId]);
  const mu = company.rows[0]?.minor_units;
  if (mu === undefined) throw new Error(`company ${companyId} not found`);
  const out: DexieSnapshot = {};
  for (const t of DEXIE_V16_TABLES) {
    if (!t.sqlTable || t.dexieTable === 'platformUsers') continue;
    const key = t.dexieTable === 'tenants' ? 'id' : 'company_id';
    const order = t.dexieTable === 'companyControl' ? 'company_id' : 'id';
    const rows = (await client.query(`select * from ${t.sqlTable} where ${key} = $1 order by ${order}`, [companyId])).rows as Record<string, unknown>[];
    if (!rows.length) continue;
    const list: DexieRecord[] = [];
    for (const row of rows) {
      const rec = fromRow(t, row, t.source === 'platform' ? 0 : mu);
      await attachRelations(client, t, row, rec);
      list.push(rec);
    }
    out[t.dexieTable] = list;
  }
  return out;
}

async function attachRelations(client: pg.ClientBase, t: TableMap, row: Record<string, unknown>, rec: DexieRecord): Promise<void> {
  for (const m of t.fields as FieldMap[]) {
    if (m.kind === 'identityEmail' && row['identity_id']) {
      const r = await client.query<{ email: string }>('select email from adex.identities where id = $1', [row['identity_id']]);
      if (r.rows[0]) rec[m.field] = r.rows[0].email;
    }
    if (m.kind === 'routeList') {
      const r = await client.query<{ route_id: string }>('select route_id from adex.membership_routes where membership_id = $1 order by route_id', [row['id']]);
      if (r.rowCount) rec[m.field] = r.rows.map((x) => x.route_id);
    }
  }
}

/** Owners del plano de control (no pertenecen a ninguna empresa). */
export async function exportOperators(client: pg.ClientBase): Promise<DexieRecord[]> {
  const t = tableMap('platformUsers');
  const rows = (await client.query('select * from adex_control.platform_operators order by id')).rows as Record<string, unknown>[];
  const out: DexieRecord[] = [];
  for (const row of rows) {
    const rec = fromRow(t, row, 0);
    await attachRelations(client, t, row, rec);
    out.push(rec);
  }
  return out;
}
