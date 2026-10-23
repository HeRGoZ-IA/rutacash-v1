// CONSULTAS v2 (Ronda 74 · bloque B): «Dinero» y «Actividad» desde una PERSPECTIVA financiera.
//
// Qué resuelve frente a R73 (`GET /v1/movements`, que sigue igual para el frontend publicado):
//   · Dinero = solo operaciones que mueven EFECTIVO en las cuentas de la perspectiva elegida.
//     Entradas y salidas se calculan con las PATAS del libro (`capital_entries`) de esas cuentas, no
//     con el tipo: nunca hay origen/destino invertidos ni dobles conteos (una operación = una fila; sus
//     patas fuera de la perspectiva no cuentan).
//   · Actividad = eventos sin dinero (solicitudes, decisiones, cuadres, cierres, rectificaciones sin
//     diferencia) y operaciones contables sin efectivo (p. ej. `PRINCIPAL_RECLASSIFICATION`, que solo
//     mueve cartera ↔ intereses, o cualquier tipo nuevo que no toque una cuenta de efectivo).
//   · Filtros, orden, totales y páginas en el SERVIDOR, todo como `adex_api` bajo RLS.
//
// PERSPECTIVA = conjunto de cuentas de efectivo (lista de ids). Hoy:
//   company            empresa + todas las bolsas + custodias + tránsito + sobrante en control (solo SuperAdmin)
//   route:<id>         custodias de la ruta (el efectivo de la calle; = `route_period_figures.custody`)
//   admin:<membresía>  la bolsa de ese Administrador
//   custody:<ruta>:<m> la custodia de esa persona en esa ruta
// Un futuro modelo «Base por Ruta» solo cambia `resolvePerspective` (p. ej. route = base + custodias):
// la API, los cálculos y la pantalla no cambian.
//
// REGLAS DE CÁLCULO (por operación, sobre sus patas EN la perspectiva, netas por cuenta: una reasignación
// entre rutas que pasa por la bolsa con +x/−x no es entrada ni salida de esa bolsa y no es fila de ella):
//   in = Σ patas > 0; out = Σ |patas < 0|; interno = mín(in, out); entrada = in − interno; salida = out − interno.
//   ⇒ Σ entradas − Σ salidas = Σ patas = saldo final − saldo inicial, EXACTO; lo interno se compensa (no es
//   ingreso, no es salida, no es ganancia). Ej.: traspaso entre dos custodias de la misma ruta en la
//   perspectiva de esa ruta, o entrega bolsa → custodia en la perspectiva Empresa.
// El saldo inicial/final usa la fecha contable (`entry_date`, zona horaria de la empresa), como 0014/0030.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { ID_RE } from '../authz/context.ts';
import { allowed } from '../authz/cleanRules.ts';
import { eventBranchesSql, hasRectifications, list, ymd } from './service.ts';

/** Cuentas de EFECTIVO (las demás —cartera, intereses, gastos, externo, sin identificar— son contables). */
// Base por Ruta (0034): `route_base` es efectivo de la ruta (la contrapartida `route_funding` no).
export const CASH_ACCOUNT_KINDS = ['company', 'admin', 'custody', 'transit', 'suspense', 'route_base'] as const;

/** Tipos de operación conocidos que mueven efectivo (base = tipo anulado si es una anulación). */
export const CASH_KINDS = [
  'COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
  'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'LOAN_DISBURSEMENT', 'COLLECTION', 'WORKER_EXPENSE', 'ROUTE_EXPENSE',
  'COMPANY_EXPENSE', 'EXPENSE_REFUND', 'SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY',
  'ADMIN_TRANSFER_RELEASE', 'DISBURSEMENT_ADJUSTMENT',
] as const;

/** Grupos de «Tipo de movimiento» de Dinero (por tipo base). Lo que no está aquí es `otros`. */
export const CASH_GROUPS: Record<string, readonly string[]> = {
  desembolsos: ['LOAN_DISBURSEMENT', 'DISBURSEMENT_ADJUSTMENT'],
  recaudos: ['COLLECTION'],
  gastos: ['WORKER_EXPENSE', 'ROUTE_EXPENSE', 'COMPANY_EXPENSE', 'EXPENSE_REFUND'],
  capital: ['COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION', 'WORKER_DELIVERY',
    'WORKER_RETURN', 'WORKER_TRANSFER', 'ROUTE_REASSIGNMENT', 'ADMIN_TRANSFER_HOLD', 'ADMIN_TRANSFER_APPLY', 'ADMIN_TRANSFER_RELEASE',
    'ROUTE_BASE_INJECTION', 'ROUTE_BASE_WITHDRAWAL', 'ROUTE_TRANSFER', 'LEGACY_POOL_TO_ROUTE'],
  cuadres: ['SETTLEMENT_RETURN', 'SETTLEMENT_SURPLUS'],
};
/** Grupos de Actividad. `contables` = operaciones del libro sin efectivo y rectificaciones sin diferencia. */
export const ACTIVITY_GROUPS: Record<string, readonly string[]> = {
  solicitudes: ['SALE_REQUEST'],
  decisiones: ['SALE_APPROVAL', 'SALE_REJECTION', 'SALE_CANCELLATION'],
  cuadres: ['CUSTODY_SETTLEMENT'],
  cierres: ['PERIOD_CLOSURE'],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 200;
const MAX_OFFSET = 20_000;
const SORTS: Record<string, string> = {
  date_desc: 'at desc, id desc', date_asc: 'at asc, id asc',
  amount_desc: 'amount_minor desc nulls last, at desc, id desc', amount_asc: 'amount_minor asc nulls last, at desc, id desc',
};
const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const groupCase = (col: string) => `case ${Object.entries(CASH_GROUPS).map(([g, ks]) => `when ${col} in (${sqlList(ks)}) then '${g}'`).join(' ')} else 'otros' end`;

// ---------- Acceso y perspectiva ----------

type Access = 'full' | 'own';

/** SuperAdmin, Administrador y Supervisor (`cashbox.viewRoute`): consultas completas. Cobrador: solo su custodia. */
function access(ctx: ActiveContext): Access {
  if (allowed(ctx, 'cashbox.viewRoute', {})) return 'full';
  if (ctx.role === 'cobrador') return 'own';
  throw new ApiError(403, 'PERMISSION_DENIED');
}

export interface Perspective {
  key: string;
  kind: 'company' | 'route' | 'admin' | 'custody';
  label: string;
  routeId: string | null;
  membershipId: string | null;
  accountIds: string[];
}

function idOrNotFound(id: string | undefined): string {
  if (!id || !ID_RE.test(id)) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
  return id;
}

async function routeName(client: pg.PoolClient, ctx: ActiveContext, routeId: string): Promise<string | null> {
  const r = await client.query<{ name: string }>('select name from adex.routes where company_id = $1 and id = $2', [ctx.companyId, routeId]);
  return r.rows[0]?.name ?? null;
}
async function memberName(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<string> {
  const r = await client.query<{ display_name: string }>('select display_name from adex.memberships where company_id = $1 and id = $2', [ctx.companyId, id]);
  return r.rows[0]?.display_name ?? 'Usuario';
}

/**
 * Perspectiva → cuentas VISIBLES (la consulta de cuentas corre bajo RLS: lo ajeno no aparece). Una
 * perspectiva fuera del alcance responde 404 (no se distingue «no existe» de «no es suya»).
 */
export async function resolvePerspective(client: pg.PoolClient, ctx: ActiveContext, raw: string | null, mode: Access): Promise<Perspective> {
  const key = raw?.trim() || await defaultPerspective(client, ctx, mode);
  const [kind, a, b] = key.split(':');
  const accounts = async (where: string, params: unknown[]) =>
    (await client.query<{ id: string }>(`select id from adex.capital_accounts where company_id = $1 and ${where} order by id`, [ctx.companyId, ...params])).rows.map((x) => x.id);
  if (mode === 'own' && kind !== 'custody') throw new ApiError(403, 'PERMISSION_DENIED');
  switch (kind) {
    case 'company': {
      if (ctx.role !== 'superadmin' || a !== undefined) throw new ApiError(403, 'PERMISSION_DENIED');
      return { key: 'company', kind: 'company', label: 'Empresa', routeId: null, membershipId: null,
        accountIds: await accounts(`kind = any($2::text[])`, [[...CASH_ACCOUNT_KINDS]]) };
    }
    case 'route': {
      const routeId = idOrNotFound(a);
      if (b !== undefined) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
      const name = await routeName(client, ctx, routeId);
      if (name === null || (ctx.role !== 'superadmin' && !ctx.routeIds.includes(routeId))) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
      return { key, kind: 'route', label: name, routeId, membershipId: null,
        // Ruta = custodias de la ruta + su Base (con Base por Ruta; en el modelo de bolsas no existe).
        accountIds: await accounts(`kind in ('custody', 'route_base') and route_id = $2`, [routeId]) };
    }
    case 'admin': {
      const membershipId = idOrNotFound(a);
      if (b !== undefined) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
      const ids = await accounts(`kind = 'admin' and membership_id = $2`, [membershipId]);
      // La bolsa existe desde su primera operación; antes, solo su dueño o el SuperAdmin la consultan (vacía).
      if (!ids.length && !(ctx.role === 'superadmin' || (ctx.role === 'admin' && membershipId === ctx.membershipId))) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
      return { key, kind: 'admin', label: `Bolsa de ${await memberName(client, ctx, membershipId)}`, routeId: null, membershipId, accountIds: ids };
    }
    case 'custody': {
      const routeId = idOrNotFound(a);
      const membershipId = idOrNotFound(b);
      if (mode === 'own' && membershipId !== ctx.membershipId) throw new ApiError(403, 'PERMISSION_DENIED');
      const ids = await accounts(`kind = 'custody' and route_id = $2 and membership_id = $3`, [routeId, membershipId]);
      if (!ids.length && membershipId !== ctx.membershipId) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
      const rn = await routeName(client, ctx, routeId);
      return { key, kind: 'custody', label: `Custodia de ${await memberName(client, ctx, membershipId)}${rn ? ` · ${rn}` : ''}`, routeId, membershipId, accountIds: ids };
    }
    default:
      throw new ApiError(400, 'INVALID_INPUT', 'perspective is invalid', { field: 'perspective' });
  }
}

async function defaultPerspective(client: pg.PoolClient, ctx: ActiveContext, mode: Access): Promise<string> {
  if (ctx.role === 'superadmin') return 'company';
  if (ctx.role === 'admin') return `admin:${ctx.membershipId}`;
  if (mode === 'own') {
    const r = await client.query<{ route_id: string }>(
      `select route_id from adex.capital_accounts where company_id = $1 and kind = 'custody' and membership_id = $2 order by route_id limit 1`, [ctx.companyId, ctx.membershipId]);
    const route = r.rows[0]?.route_id ?? ctx.routeIds[0];
    if (!route) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
    return `custody:${route}:${ctx.membershipId}`;
  }
  const route = [...ctx.routeIds].sort()[0];
  if (!route) throw new ApiError(404, 'PERSPECTIVE_NOT_FOUND');
  return `route:${route}`;
}

/** `GET /v1/movements/perspectives` — perspectivas que el contexto puede elegir (todas bajo RLS). */
export async function listPerspectives(client: pg.PoolClient, ctx: ActiveContext) {
  const mode = access(ctx);
  const options: { key: string; kind: Perspective['kind']; label: string; routeId: string | null; membershipId: string | null; office: string | null }[] = [];
  if (mode === 'full') {
    if (ctx.role === 'superadmin') options.push({ key: 'company', kind: 'company', label: 'Empresa', routeId: null, membershipId: null, office: null });
    const routes = await client.query<{ id: string; name: string; office: string | null }>(
      `select r.id, r.name, o.name office from adex.routes r left join adex.offices o on o.company_id = r.company_id and o.id = r.office_id
        where r.company_id = $1 ${ctx.role === 'superadmin' ? '' : 'and r.id = any($2::text[])'} order by lower(r.name), r.id`,
      ctx.role === 'superadmin' ? [ctx.companyId] : [ctx.companyId, [...ctx.routeIds]]);
    for (const r of routes.rows) options.push({ key: `route:${r.id}`, kind: 'route', label: r.name, routeId: r.id, membershipId: null, office: r.office });
    const pools = await client.query<{ membership_id: string; display_name: string }>(
      `select a.membership_id, m.display_name from adex.capital_accounts a join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
        where a.company_id = $1 and a.kind = 'admin' order by lower(m.display_name), a.membership_id`, [ctx.companyId]);
    const poolIds = new Set(pools.rows.map((p) => p.membership_id));
    if (ctx.role === 'admin' && !poolIds.has(ctx.membershipId)) pools.rows.unshift({ membership_id: ctx.membershipId, display_name: ctx.displayName });
    for (const p of pools.rows) options.push({ key: `admin:${p.membership_id}`, kind: 'admin', label: `Bolsa de ${p.display_name}`, routeId: null, membershipId: p.membership_id, office: null });
  }
  const custodies = await client.query<{ route_id: string; membership_id: string; display_name: string; route_name: string | null }>(
    `select a.route_id, a.membership_id, m.display_name, r.name route_name from adex.capital_accounts a
       join adex.memberships m on m.company_id = a.company_id and m.id = a.membership_id
       left join adex.routes r on r.company_id = a.company_id and r.id = a.route_id
      where a.company_id = $1 and a.kind = 'custody' ${mode === 'own' ? 'and a.membership_id = $2' : ''}
      order by lower(coalesce(r.name, '')), lower(m.display_name), a.id`, mode === 'own' ? [ctx.companyId, ctx.membershipId] : [ctx.companyId]);
  for (const c of custodies.rows) {
    options.push({ key: `custody:${c.route_id}:${c.membership_id}`, kind: 'custody', label: `Custodia de ${c.display_name}`, routeId: c.route_id, membershipId: c.membership_id, office: c.route_name });
  }
  let def: string | null = null;
  try { def = await defaultPerspective(client, ctx, mode); } catch { def = options[0]?.key ?? null; }
  if (def && !options.some((o) => o.key === def)) def = options[0]?.key ?? null;
  return { default: def, options, timezone: ctx.company.timezone };
}

// ---------- Filtros comunes ----------

interface Range { from: string | null; to: string | null }

function range(q: URLSearchParams): Range {
  const out: Range = { from: null, to: null };
  for (const k of ['from', 'to'] as const) {
    const v = q.get(k);
    if (v === null || v === '') continue;
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
      throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`, { field: k });
    }
    out[k] = v;
  }
  if (out.from && out.to && out.from > out.to) throw new ApiError(400, 'INVALID_INPUT', 'from is after to', { field: 'from' });
  return out;
}

function page(q: URLSearchParams) {
  const sort = SORTS[q.get('sort') ?? 'date_desc'];
  if (!sort) throw new ApiError(400, 'INVALID_INPUT', 'sort is invalid', { field: 'sort' });
  const rawLimit = q.get('limit');
  const limit = rawLimit === null ? 50 : Math.min(Math.max(Number(rawLimit) || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0);
  if (!Number.isInteger(offset)) throw new ApiError(400, 'INVALID_INPUT', 'offset is invalid', { field: 'offset' });
  if (offset > MAX_OFFSET) throw new ApiError(400, 'INVALID_INPUT', 'offset is too large: narrow the filters', { field: 'offset' });
  return { sort, limit, offset };
}

function textFilter(q: URLSearchParams): string | null {
  const text = q.get('q')?.trim();
  if (!text) return null;
  if (text.length > 100) throw new ApiError(400, 'INVALID_INPUT', 'q is too long', { field: 'q' });
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function groupsOf(q: URLSearchParams, known: Record<string, readonly string[]>, extra: readonly string[] = []): string[] {
  const gs = list(q, 'group', /^[a-z]{3,20}$/);
  for (const g of gs) if (!(g in known) && !extra.includes(g)) throw new ApiError(400, 'INVALID_INPUT', 'group is invalid', { field: 'group' });
  return gs;
}

// ---------- Partes (origen → destino) ----------

export interface Party { type: string; id?: string | null; name?: string | null; routeId?: string | null; routeName?: string | null }

interface NamedRow {
  kind: string; base: string; reversal: boolean; net: number;
  worker_id: string | null; worker_name: string | null; counterpart_id: string | null; counterpart_name: string | null;
  admin_id: string | null; admin_name: string | null; client_id: string | null; client_name: string | null;
  route_id: string | null; route_name: string | null; to_route_id: string | null; to_route_name: string | null; concept: string;
  expense_category: string | null;
  via_base: boolean;   // la operación toca una cuenta `route_base` (Base por Ruta)
}

/**
 * Origen y destino según el tipo, con la orientación REAL: una anulación invierte el sentido y un ajuste
 * de desembolso negativo (Δ < 0) devuelve a quien pagó. Para los traspasos entre Administradores se usa el
 * papel de cada campo en 0023 (HOLD/RELEASE: admin = origen; APPLY: admin = DESTINO, contraparte = origen),
 * que es lo que R73 mostraba al revés.
 */
export function parties(r: NamedRow): { from: Party | null; to: Party | null } {
  // Con Base por Ruta, lo que antes pagaba o recibía la bolsa lo paga o recibe la Base de la ruta.
  const base = (routeId = r.route_id, routeName = r.route_name): Party => ({ type: 'route_base', routeId, routeName, name: routeName });
  const pool = (id: string | null, name: string | null): Party => (r.via_base ? base() : { type: 'pool', id, name });
  const custody = (id: string | null, name: string | null, routeId = r.route_id, routeName = r.route_name): Party => ({ type: 'custody', id, name, routeId, routeName });
  const client: Party = { type: 'client', id: r.client_id, name: r.client_name };
  const company: Party = { type: 'company', name: 'Empresa' };
  const payer = r.worker_id ? custody(r.worker_id, r.worker_name) : r.admin_id ? pool(r.admin_id, r.admin_name) : company;
  const expense: Party = { type: 'expense', name: r.expense_category ?? r.concept };
  let f: [Party | null, Party | null];
  switch (r.base) {
    case 'COMPANY_DEPOSIT': f = [{ type: 'external', name: 'Fuera de la empresa' }, company]; break;
    case 'COMPANY_WITHDRAWAL': f = [company, { type: 'external', name: 'Fuera de la empresa' }]; break;
    case 'ADMIN_ALLOCATION': f = [company, pool(r.admin_id, r.admin_name)]; break;
    case 'ADMIN_RETURN': f = [pool(r.admin_id, r.admin_name), company]; break;
    case 'PARTNER_CONTRIBUTION': f = [{ type: 'partner', id: r.counterpart_id, name: r.counterpart_name }, pool(r.admin_id, r.admin_name)]; break;
    case 'WORKER_DELIVERY': f = [pool(r.admin_id, r.admin_name), custody(r.worker_id, r.worker_name)]; break;
    case 'WORKER_RETURN': case 'SETTLEMENT_RETURN': f = [custody(r.worker_id, r.worker_name), pool(r.admin_id, r.admin_name)]; break;
    case 'WORKER_TRANSFER': f = [custody(r.worker_id, r.worker_name), custody(r.counterpart_id, r.counterpart_name)]; break;
    case 'ROUTE_REASSIGNMENT': f = [custody(r.worker_id, r.worker_name), custody(r.counterpart_id, r.counterpart_name, r.to_route_id, r.to_route_name)]; break;
    case 'LOAN_DISBURSEMENT': f = [payer, client]; break;
    case 'DISBURSEMENT_ADJUSTMENT': f = r.net > 0 ? [client, payer] : [payer, client]; break;
    case 'COLLECTION': f = [client, payer]; break;
    case 'WORKER_EXPENSE': case 'ROUTE_EXPENSE': case 'COMPANY_EXPENSE': f = [payer, expense]; break;
    case 'EXPENSE_REFUND': f = [expense, payer]; break;
    case 'SETTLEMENT_SURPLUS': f = [{ type: 'unidentified', name: 'Origen sin identificar' }, { type: 'control', id: r.admin_id, name: r.admin_name, routeId: r.route_id, routeName: r.route_name }]; break;
    case 'ADMIN_TRANSFER_HOLD': f = [pool(r.admin_id, r.admin_name), { type: 'transit', id: r.counterpart_id, name: r.counterpart_name }]; break;
    case 'ADMIN_TRANSFER_APPLY': f = [{ type: 'transit', id: r.counterpart_id, name: r.counterpart_name }, pool(r.admin_id, r.admin_name)]; break;
    case 'ADMIN_TRANSFER_RELEASE': f = [{ type: 'transit', id: r.counterpart_id, name: r.counterpart_name }, pool(r.admin_id, r.admin_name)]; break;
    case 'ROUTE_BASE_INJECTION': f = [{ type: 'external', name: 'Aporte de Base' }, base()]; break;
    case 'ROUTE_BASE_WITHDRAWAL': f = [base(), { type: 'external', name: 'Retiro de Base' }]; break;
    case 'ROUTE_TRANSFER': f = [base(), base(r.to_route_id, r.to_route_name)]; break;
    case 'LEGACY_POOL_TO_ROUTE': f = [{ type: 'pool', id: r.admin_id, name: r.admin_name }, base()]; break;
    default: f = [null, null];
  }
  return r.reversal ? { from: f[1], to: f[0] } : { from: f[0], to: f[1] };
}

// Nombres de la fila (solo para la página pedida: se unen DESPUÉS de filtrar y paginar).
const NAMES_SQL = `
  left join adex.memberships mw on mw.company_id = $1 and mw.id = f.worker_id
  left join adex.memberships mc on mc.company_id = $1 and mc.id = f.counterpart_id
  left join adex.memberships ma on ma.company_id = $1 and ma.id = f.admin_id
  left join adex.memberships mx on mx.company_id = $1 and mx.id = f.actor_id
  left join adex.clients cl on cl.company_id = $1 and cl.id = f.client_id
  left join adex.routes rr on rr.company_id = $1 and rr.id = f.route_id
  left join adex.routes rt on rt.company_id = $1 and rt.id = f.to_route_id
  left join adex.offices ro on ro.company_id = $1 and ro.id = rr.office_id`;
const NAMES_COLS = `mw.display_name worker_name, mc.display_name counterpart_name, ma.display_name admin_name, mx.display_name actor_name,
  mx.role actor_role, cl.name client_name, rr.name route_name, rt.name to_route_name, ro.name office_name`;

const tzOf = `(select c.timezone from adex.companies c where c.id = $1)`;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function baseRow(x: Row) {
  return {
    id: String(x['id']), kind: String(x['kind']), reversesKind: str(x['reverses_kind']),
    at: (x['at'] as Date).toISOString(), date: ymd(x['entry_date'] as Date | string), localTime: String(x['local_time']),
    route: x['route_id'] ? { id: String(x['route_id']), name: str(x['route_name']), office: str(x['office_name']) } : null,
    toRoute: x['to_route_id'] ? { id: String(x['to_route_id']), name: str(x['to_route_name']) } : null,
    worker: x['worker_id'] ? { id: String(x['worker_id']), name: str(x['worker_name']) } : null,
    counterpart: x['counterpart_id'] ? { id: String(x['counterpart_id']), name: str(x['counterpart_name']) } : null,
    admin: x['admin_id'] ? { id: String(x['admin_id']), name: str(x['admin_name']) } : null,
    client: x['client_id'] ? { id: String(x['client_id']), name: str(x['client_name']) } : null,
    actor: x['actor_id'] ? { id: String(x['actor_id']), name: str(x['actor_name']), role: str(x['actor_role']) } : null,
    concept: str(x['concept']) ?? '', status: String(x['status']), reference: str(x['reference']),
    saleId: str(x['sale_id']), paymentId: str(x['payment_id']), expenseId: str(x['expense_id']), settlementId: str(x['settlement_id']),
  };
}

function namedOf(x: Row, net: number, viaBase?: boolean): NamedRow {
  return {
    kind: String(x['kind']), base: String(x['reverses_kind'] ?? x['kind']), reversal: x['kind'] === 'REVERSAL', net,
    worker_id: str(x['worker_id']), worker_name: str(x['worker_name']), counterpart_id: str(x['counterpart_id']), counterpart_name: str(x['counterpart_name']),
    admin_id: str(x['admin_id']), admin_name: str(x['admin_name']), client_id: str(x['client_id']), client_name: str(x['client_name']),
    route_id: str(x['route_id']), route_name: str(x['route_name']), to_route_id: str(x['to_route_id']), to_route_name: str(x['to_route_name']),
    concept: str(x['concept']) ?? '', expense_category: str(x['expense_category']), via_base: viaBase ?? x['via_base'] === true,
  };
}

// ---------- Dinero ----------

/**
 * `GET /v1/movements/cash` — Dinero desde una perspectiva.
 *   perspective  company | route:<id> | admin:<membresía> | custody:<ruta>:<membresía> (por defecto según el rol)
 *   from, to     fecha contable inclusive (zona horaria de la empresa)
 *   group        desembolsos | recaudos | gastos | capital | cuadres | otros (repetible)
 *   kind         tipo exacto (repetible; incluye sus anulaciones)
 *   flow         in | out | internal
 *   personId     trabajador, contraparte, Administrador o quien registró
 *   clientId, actorId, status (aplicada | anulada | anulacion), q (concepto, referencia, cliente o persona),
 *   minAmount, maxAmount (unidades menores), sort, limit (≤ 200, 50 por defecto), offset
 * Respuesta: perspectiva, resumen del periodo (sin otros filtros: siempre concilia), totales del filtro y página.
 */
export async function listCashMovements(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const mode = access(ctx);
  const p = await resolvePerspective(client, ctx, q.get('perspective'), mode);
  const { from, to } = range(q);
  const { sort, limit, offset } = page(q);

  const params: unknown[] = [ctx.companyId, p.accountIds, from, to];
  // Patas de la perspectiva agregadas por operación (índice company_id + account_id), unidas a su operación visible.
  const opsCte = `
    legs as (
      -- Primero se neta cada CUENTA dentro de la operación (una reasignación entre rutas pasa por la bolsa
      -- con +x y −x: en esa bolsa no es entrada ni salida); una operación que no cambia ninguna cuenta de
      -- la perspectiva no es una fila de esa perspectiva.
      select a.operation_id id, coalesce(sum(a.n) filter (where a.n > 0), 0)::bigint inn,
             coalesce(-sum(a.n) filter (where a.n < 0), 0)::bigint outt
        from (select e.operation_id, e.account_id, sum(e.amount_minor) n
                from adex.capital_entries e
               where e.company_id = $1 and e.account_id = any($2::text[])
               group by e.operation_id, e.account_id) a
       group by a.operation_id
      having bool_or(a.n <> 0)
    ), ops as (
      select o.id, o.kind, o.reverses_kind, coalesce(o.reverses_kind, o.kind) base, o.created_at at, o.entry_date, o.route_id, o.to_route_id,
             o.worker_membership_id worker_id, o.counterpart_membership_id counterpart_id, o.admin_membership_id admin_id,
             coalesce(s.client_id, pm.client_id) client_id, o.amount_minor, o.reason concept, o.operation_id::text reference,
             exists (select 1 from adex.capital_entries be join adex.capital_accounts ba on ba.company_id = be.company_id and ba.id = be.account_id
                      where be.company_id = o.company_id and be.operation_id = o.id and ba.kind = 'route_base') via_base,
             o.actor_membership_id actor_id, o.sale_id, o.payment_id, o.expense_id, o.settlement_id, o.reverses_operation_id,
             case when o.kind = 'REVERSAL' then 'anulacion'
                  when exists (select 1 from adex.capital_operations x where x.company_id = o.company_id and x.reverses_operation_id = o.id) then 'anulada'
                  else 'aplicada' end status,
             l.inn, l.outt, least(l.inn, l.outt) internal, l.inn - least(l.inn, l.outt) entrada, l.outt - least(l.inn, l.outt) salida
        from legs l
        join adex.capital_operations o on o.company_id = $1 and o.id = l.id
        left join adex.sales s on s.company_id = o.company_id and s.id = o.sale_id
        left join adex.payments pm on pm.company_id = o.company_id and pm.id = o.payment_id
    )`;

  // Resumen del periodo (perspectiva + fechas, sin otros filtros): saldo inicial + entradas − salidas = saldo final.
  const sum = await client.query<Row>(
    `with ${opsCte}
     select coalesce(sum(inn - outt) filter (where $3::date is not null and entry_date < $3::date), 0)::bigint opening,
            coalesce(sum(inn - outt) filter (where $4::date is null or entry_date <= $4::date), 0)::bigint closing,
            coalesce(sum(entrada) filter (where in_period), 0)::bigint entradas,
            coalesce(sum(salida) filter (where in_period), 0)::bigint salidas,
            coalesce(sum(internal) filter (where in_period), 0)::bigint internos,
            count(*) filter (where in_period)::int n,
            coalesce(sum(inn - outt), 0)::bigint all_time,
            coalesce(jsonb_agg(jsonb_build_object('g', grp, 'in', entrada, 'out', salida, 'int', internal)) filter (where in_period), '[]'::jsonb) per_op
       from (select *, ${groupCase('base')} grp,
                    ($3::date is null or entry_date >= $3::date) and ($4::date is null or entry_date <= $4::date) in_period from ops) z`,
    params);
  const s = sum.rows[0]!;
  const groups = new Map<string, { group: string; inMinor: number; outMinor: number; internalMinor: number; count: number }>();
  for (const g of [...Object.keys(CASH_GROUPS), 'otros']) groups.set(g, { group: g, inMinor: 0, outMinor: 0, internalMinor: 0, count: 0 });
  for (const o of s['per_op'] as { g: string; in: number; out: number; int: number }[]) {
    const g = groups.get(o.g)!;
    g.inMinor += Number(o.in); g.outMinor += Number(o.out); g.internalMinor += Number(o.int); g.count += 1;
  }
  // Verificación contra el libro: Σ saldos de las cuentas = Σ de TODAS sus patas visibles con su operación visible.
  const led = await client.query<{ balance: string; entries: string }>(
    `select coalesce((select sum(balance_minor) from adex.capital_accounts where company_id = $1 and id = any($2::text[])), 0)::bigint balance,
            coalesce((select sum(amount_minor) from adex.capital_entries where company_id = $1 and account_id = any($2::text[])), 0)::bigint entries`,
    [ctx.companyId, p.accountIds]);
  const ledgerBalance = Number(led.rows[0]!.balance);
  const ledger = { balanceMinor: ledgerBalance, ok: ledgerBalance === Number(s['all_time']) && ledgerBalance === Number(led.rows[0]!.entries) };

  // Operaciones atribuidas a la ruta que NO tocan sus custodias (las pagó o recibió la bolsa del Administrador).
  let outside: { count: number } | null = null;
  if (p.kind === 'route') {
    const r = await client.query<{ n: number }>(
      `select count(*)::int n from adex.capital_operations o
        where o.company_id = $1 and (o.route_id = $2 or o.to_route_id = $2)
          and ($3::date is null or o.entry_date >= $3::date) and ($4::date is null or o.entry_date <= $4::date)
          and not exists (select 1 from adex.capital_entries e where e.company_id = $1 and e.operation_id = o.id and e.account_id = any($5::text[]))`,
      [ctx.companyId, p.routeId, from, to, p.accountIds]);
    outside = { count: r.rows[0]!.n };
  }

  // Filtros de la lista (sobre el periodo).
  const where: string[] = ['($3::date is null or entry_date >= $3::date)', '($4::date is null or entry_date <= $4::date)'];
  const add = (sql: (ph: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  const gs = groupsOf(q, CASH_GROUPS, ['otros']);
  if (gs.length) add((ph) => `${groupCase('base')} = any(${ph}::text[])`, gs);
  const kinds = list(q, 'kind', /^[A-Z_]{3,40}$/);
  if (kinds.length) add((ph) => `base = any(${ph}::text[])`, kinds);
  const flow = q.get('flow');
  if (flow !== null && flow !== '') {
    if (!['in', 'out', 'internal'].includes(flow)) throw new ApiError(400, 'INVALID_INPUT', 'flow is invalid', { field: 'flow' });
    where.push(flow === 'in' ? 'entrada > 0' : flow === 'out' ? 'salida > 0' : '(internal > 0 and entrada = 0 and salida = 0)');
  }
  const persons = list(q, 'personId');
  if (persons.length) add((ph) => `(worker_id = any(${ph}::text[]) or counterpart_id = any(${ph}::text[]) or admin_id = any(${ph}::text[]) or actor_id = any(${ph}::text[]))`, persons);
  const clients = list(q, 'clientId');
  if (clients.length) add((ph) => `client_id = any(${ph}::text[])`, clients);
  const actors = list(q, 'actorId');
  if (actors.length) add((ph) => `actor_id = any(${ph}::text[])`, actors);
  const statuses = list(q, 'status', /^(aplicada|anulada|anulacion)$/);
  if (statuses.length) add((ph) => `status = any(${ph}::text[])`, statuses);
  for (const [k, op] of [['minAmount', '>='], ['maxAmount', '<=']] as const) {
    const v = q.get(k);
    if (v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new ApiError(400, 'INVALID_INPUT', `${k} is invalid`, { field: k });
    add((ph) => `amount_minor ${op} ${ph}::bigint`, n);
  }
  const text = textFilter(q);
  if (text) {
    add((ph) => `(concept ilike ${ph} or reference ilike ${ph} or id ilike ${ph}
      or exists (select 1 from adex.clients c where c.company_id = $1 and c.id = client_id and c.name ilike ${ph})
      or exists (select 1 from adex.memberships m where m.company_id = $1 and m.id in (worker_id, counterpart_id, admin_id, actor_id) and m.display_name ilike ${ph}))`, text);
  }
  const filteredCte = `with ${opsCte}, f as (select * from ops where ${where.join(' and ')})`;
  const totals = await client.query<Row>(
    `${filteredCte} select count(*)::int n, coalesce(sum(entrada), 0)::bigint entradas, coalesce(sum(salida), 0)::bigint salidas,
            coalesce(sum(internal), 0)::bigint internos from f`, params);
  params.push(limit + 1, offset);
  const r = await client.query<Row>(
    `${filteredCte}, pg as (select * from f order by ${sort} limit $${params.length - 1} offset $${params.length})
     select f.*, to_char(f.at at time zone ${tzOf}, 'HH24:MI') local_time, ${NAMES_COLS}, ec.name expense_category
       from pg f ${NAMES_SQL}
       left join adex.expenses ex on ex.company_id = $1 and ex.id = f.expense_id
       left join adex.expense_categories ec on ec.company_id = $1 and ec.id = ex.category_id
      order by ${sort.replace(/\b(at|id|amount_minor)\b/g, 'f.$1')}`, params);
  const t = totals.rows[0]!;
  const rows = r.rows.slice(0, limit).map((x) => {
    const entrada = num(x['entrada']); const salida = num(x['salida']); const internal = num(x['internal']);
    const net = num(x['inn']) - num(x['outt']);
    const flowOf = entrada > 0 ? 'in' : salida > 0 ? 'out' : 'internal';
    return {
      ...baseRow(x), base: String(x['base']), group: groupOf(String(x['base'])), amountMinor: num(x['amount_minor']),
      inMinor: entrada, outMinor: salida, internalMinor: internal, flow: flowOf, ...parties(namedOf(x, net)),
      reversesOperationId: str(x['reverses_operation_id']),
    };
  });
  return {
    perspective: { key: p.key, kind: p.kind, label: p.label, routeId: p.routeId, membershipId: p.membershipId, accounts: p.accountIds.length },
    period: { from, to },
    summary: {
      openingMinor: Number(s['opening']), inMinor: Number(s['entradas']), outMinor: Number(s['salidas']), internalMinor: Number(s['internos']),
      closingMinor: Number(s['closing']), count: Number(s['n']), groups: [...groups.values()], ledger, outside,
    },
    filtered: { count: Number(t['n']), inMinor: Number(t['entradas']), outMinor: Number(t['salidas']), internalMinor: Number(t['internos']) },
    rows, hasMore: r.rows.length > limit, limit, offset, timezone: ctx.company.timezone,
  };
}

function groupOf(base: string): string {
  for (const [g, ks] of Object.entries(CASH_GROUPS)) if (ks.includes(base)) return g;
  return 'otros';
}

// ---------- Actividad ----------

/** Operaciones del libro SIN efectivo (tipo desconocido para Dinero y ninguna pata visible en una cuenta de efectivo). */
const CAPITAL_OPS_SQL = `
    select o.id, false as money, o.kind, o.reverses_kind, o.created_at as at, o.entry_date, o.route_id, o.to_route_id,
           o.worker_membership_id as worker_id, o.counterpart_membership_id as counterpart_id, o.admin_membership_id as admin_id,
           coalesce(s.client_id, p.client_id) as client_id, o.amount_minor, o.reason as concept,
           case when o.kind = 'REVERSAL' then 'anulacion'
                when exists (select 1 from adex.capital_operations x where x.company_id = o.company_id and x.reverses_operation_id = o.id) then 'anulada'
                else 'aplicada' end as status,
           o.operation_id::text as reference, o.actor_membership_id as actor_id, o.sale_id, o.payment_id, o.expense_id, o.settlement_id
      from adex.capital_operations o
      left join adex.sales s on s.company_id = o.company_id and s.id = o.sale_id
      left join adex.payments p on p.company_id = o.company_id and p.id = o.payment_id
     where o.company_id = $1`;
const NON_CASH_OPS_SQL = `${CAPITAL_OPS_SQL} and coalesce(o.reverses_kind, o.kind) not in (${sqlList(CASH_KINDS)})
       and not exists (select 1 from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
                        where e.company_id = o.company_id and e.operation_id = o.id and a.kind in (${sqlList(CASH_ACCOUNT_KINDS)}))`;

async function activitySql(client: pg.PoolClient): Promise<string> {
  return `${NON_CASH_OPS_SQL}
    union all${eventBranchesSql(await hasRectifications(client))}`;
}

const activityGroupCase = `case ${Object.entries(ACTIVITY_GROUPS).map(([g, ks]) => `when kind in (${sqlList(ks)}) then '${g}'`).join(' ')} else 'contables' end`;

/**
 * `GET /v1/movements/activity` — eventos sin dinero desde la misma perspectiva:
 *   company: todo · route: eventos de la ruta · admin: de las rutas cuyo capital controla o registrados por él ·
 *   custody: de esa persona en esa ruta. Filtros: from, to (fecha contable / fecha local de la empresa), group
 *   (solicitudes | decisiones | cuadres | cierres | contables), kind, personId, clientId, actorId, q, sort, limit, offset.
 */
export async function listActivity(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const mode = access(ctx);
  if (mode !== 'full') throw new ApiError(403, 'PERMISSION_DENIED');
  const p = await resolvePerspective(client, ctx, q.get('perspective'), mode);
  const { from, to } = range(q);
  const { sort, limit, offset } = page(q);
  const params: unknown[] = [ctx.companyId];
  const where: string[] = [];
  const add = (sql: (ph: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
  if (from) add((ph) => `entry_date >= ${ph}::date`, from);
  if (to) add((ph) => `entry_date <= ${ph}::date`, to);
  if (p.kind === 'route') add((ph) => `(route_id = ${ph} or to_route_id = ${ph})`, p.routeId);
  if (p.kind === 'custody') {
    add((ph) => `(route_id = ${ph} or to_route_id = ${ph})`, p.routeId);
    add((ph) => `(worker_id = ${ph} or counterpart_id = ${ph} or actor_id = ${ph})`, p.membershipId);
  }
  if (p.kind === 'admin') {
    add((ph) => `(admin_id = ${ph} or actor_id = ${ph} or route_id in (select r.id from adex.routes r where r.company_id = $1 and r.capital_controller_membership_id = ${ph}))`, p.membershipId);
  }
  const gs = groupsOf(q, ACTIVITY_GROUPS, ['contables']);
  if (gs.length) add((ph) => `${activityGroupCase} = any(${ph}::text[])`, gs);
  const kinds = list(q, 'kind', /^[A-Z_]{3,40}$/);
  if (kinds.length) add((ph) => `kind = any(${ph}::text[])`, kinds);
  const persons = list(q, 'personId');
  if (persons.length) add((ph) => `(worker_id = any(${ph}::text[]) or counterpart_id = any(${ph}::text[]) or admin_id = any(${ph}::text[]) or actor_id = any(${ph}::text[]))`, persons);
  const clients = list(q, 'clientId');
  if (clients.length) add((ph) => `client_id = any(${ph}::text[])`, clients);
  const actors = list(q, 'actorId');
  if (actors.length) add((ph) => `actor_id = any(${ph}::text[])`, actors);
  const text = textFilter(q);
  if (text) {
    add((ph) => `(concept ilike ${ph} or reference ilike ${ph} or id ilike ${ph}
      or exists (select 1 from adex.clients c where c.company_id = $1 and c.id = client_id and c.name ilike ${ph})
      or exists (select 1 from adex.memberships m where m.company_id = $1 and m.id in (worker_id, counterpart_id, admin_id, actor_id) and m.display_name ilike ${ph}))`, text);
  }
  const base = `with feed as (${await activitySql(client)}), f as (select * from feed ${where.length ? `where ${where.join(' and ')}` : ''})`;
  const total = (await client.query<{ n: number }>(`${base} select count(*)::int n from f`, params)).rows[0]!.n;
  params.push(limit + 1, offset);
  const r = await client.query<Row>(
    `${base}, pg as (select * from f order by ${sort} limit $${params.length - 1} offset $${params.length})
     select f.*, ${activityGroupCase.replace(/\bkind\b/g, 'f.kind')} grp, to_char(f.at at time zone ${tzOf}, 'HH24:MI') local_time, ${NAMES_COLS}
       from pg f ${NAMES_SQL}
      order by ${sort.replace(/\b(at|id|amount_minor)\b/g, 'f.$1')}`, params);
  const rows = r.rows.slice(0, limit).map((x) => ({ ...baseRow(x), group: String(x['grp']), amountMinor: x['amount_minor'] === null ? null : Number(x['amount_minor']) }));
  return {
    perspective: { key: p.key, kind: p.kind, label: p.label, routeId: p.routeId, membershipId: p.membershipId },
    period: { from, to }, total, rows, hasMore: r.rows.length > limit, limit, offset, timezone: ctx.company.timezone,
  };
}

// ---------- Detalle ----------

const ACCOUNT_LABEL: Record<string, string> = {
  company: 'Empresa', admin: 'Bolsa', custody: 'Custodia', portfolio: 'Cartera de la ruta', external: 'Fuera de la empresa', income: 'Intereses',
  expense: 'Gastos', suspense: 'Sobrante en control', unidentified: 'Origen sin identificar', transit: 'En tránsito', partner: 'Socio (histórico)',
};

/**
 * `GET /v1/movements/detail?id=` — detalle de una fila (dinero o actividad): quién, cuándo (fecha y hora
 * de la empresa), ruta y oficina, partes, referencias, patas contables VISIBLES para el rol, anulación
 * vinculada y vínculos operativos. Lo ajeno o inexistente responde 404.
 */
export async function movementDetail(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const mode = access(ctx);
  const id = q.get('id') ?? '';
  const m = /^(?:(req|rev|can|set|per|rec):)?(.+)$/.exec(id);
  if (!m || !ID_RE.test(m[2]!)) throw new ApiError(404, 'NOT_FOUND');
  const isOp = !m[1];
  const feed = isOp ? CAPITAL_OPS_SQL : await activitySql(client);
  const r = await client.query<Row>(
    `with f0 as (${feed}), f as (select * from f0 where id = $2)
     select f.*, to_char(f.at at time zone ${tzOf}, 'YYYY-MM-DD HH24:MI:SS') local_at, to_char(f.at at time zone ${tzOf}, 'HH24:MI') local_time,
            ${NAMES_COLS}, ec.name expense_category
       from f ${NAMES_SQL}
       left join adex.expenses ex on ex.company_id = $1 and ex.id = f.expense_id
       left join adex.expense_categories ec on ec.company_id = $1 and ec.id = ex.category_id`, [ctx.companyId, id]);
  const x = r.rows[0];
  if (!x) throw new ApiError(404, 'NOT_FOUND');
  const legs = isOp ? (await client.query<Row>(
    `select e.leg, a.kind, a.membership_id, mm.display_name, a.route_id, ro.name route_name, e.amount_minor, e.balance_after_minor
       from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
       left join adex.memberships mm on mm.company_id = e.company_id and mm.id = a.membership_id
       left join adex.routes ro on ro.company_id = e.company_id and ro.id = a.route_id
      where e.company_id = $1 and e.operation_id = $2 order by e.leg`, [ctx.companyId, id])).rows : [];
  // El Cobrador solo ve el detalle de operaciones que tocan su propia custodia.
  if (mode === 'own' && !legs.some((l) => l['kind'] === 'custody' && l['membership_id'] === ctx.membershipId)) throw new ApiError(404, 'NOT_FOUND');
  const cashNet = legs.filter((l) => (CASH_ACCOUNT_KINDS as readonly string[]).includes(String(l['kind']))).reduce((a, l) => a + Number(l['amount_minor']), 0);
  const reversedBy = isOp ? (await client.query<{ id: string }>(
    `select id from adex.capital_operations where company_id = $1 and reverses_operation_id = $2`, [ctx.companyId, id])).rows[0]?.id ?? null : null;
  const ops = isOp ? (await client.query<{ reverses_operation_id: string | null; actor_role: string; txid: string }>(
    `select reverses_operation_id, actor_role, txid::text from adex.capital_operations where company_id = $1 and id = $2`, [ctx.companyId, id])).rows[0] : undefined;
  const base = String(x['reverses_kind'] ?? x['kind']);
  return {
    movement: {
      ...baseRow(x), base, money: isOp && (CASH_KINDS as readonly string[]).includes(base), localAt: String(x['local_at']), timezone: ctx.company.timezone,
      amountMinor: x['amount_minor'] === null ? null : Number(x['amount_minor']),
      ...(isOp ? parties(namedOf(x, cashNet, legs.some((l) => l['kind'] === 'route_base'))) : { from: null, to: null }),
      reversesOperationId: ops?.reverses_operation_id ?? null, reversedBy, actorRole: ops?.actor_role ?? str(x['actor_role']),
    },
    legs: legs.map((l) => ({
      leg: Number(l['leg']), account: { kind: String(l['kind']), label: ACCOUNT_LABEL[String(l['kind'])] ?? String(l['kind']), membershipId: str(l['membership_id']),
        name: str(l['display_name']), routeId: str(l['route_id']), routeName: str(l['route_name']) },
      cash: (CASH_ACCOUNT_KINDS as readonly string[]).includes(String(l['kind'])),
      amountMinor: Number(l['amount_minor']), balanceAfterMinor: Number(l['balance_after_minor']),
    })),
    legsComplete: ctx.role === 'superadmin',
  };
}
