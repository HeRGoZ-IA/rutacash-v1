// GASTOS (Fase 5) con el libro central. Reglas de CLEAN (`expenseService.createExpense`,
// `reverseAdminExpense`, `refundAdminExpense`, D9–D12, C1) reutilizadas sin copiar:
// `expenseShapeError`, `can()` y `routeCashAuthorityError` (vía `requireAuthority`).
//
// FUENTE FINANCIERA (quién paga) ≠ ATRIBUCIÓN (ruta, trabajador, categoría):
//   · trabajador → su custodia en la ruta, SIN tope (73209ce): su posición puede quedar
//     negativa; ese negativo no es efectivo entregable, desembolsable ni transferible;
//   · ruta → la bolsa del Administrador responsable (C1); solo él la registra;
//   · empresa → la bolsa elegida: el Administrador, la suya; el SuperAdmin, la de la
//     empresa (D10) o la de un Administrador activo (D11). Las bolsas nunca quedan negativas.
// Caja socios (D1) no paga gastos. El Secretario no registra gastos (CLEAN).
//
// R74 (0035, D74-O4F) · GASTOS GENERALES con alcance `administrador` (NUEVO) o `empresa` y fuentes nuevas:
//   · fundingSource 'routes'    → aportes explícitos `contributions: [{routeId, amountMinor}]` de rutas donde el
//     Administrador es responsable válido (solo con Base por Ruta); la suma es el gasto (A y C1);
//   · fundingSource 'own_money' → pagado con dinero propio: obligación de la empresa con el Administrador,
//     siempre reembolsable, sin aprobación, nunca efectivo (C2; ambos modelos de capital).
//   Solo el Administrador; el gasto se registra UNA vez; se corrige solo por anulación.

import type pg from 'pg';
import { expenseShapeError } from '@/lib/expenseAttribution';
import type { ExpenseScope } from '@/models/types';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { oneOf, optId, optText, PAGE_ORDER, pageFilters, pathId, reqId, reqText } from '../structure/input.ts';
import { requireAuthority, requireCustodian, requireOperationId, routeOf } from '../capital/service.ts';
import { parseOffline, requireOfflineActor, storeOfflineCapture } from '../offline/capture.ts';
import { derivedOperationId, expenseDependencies, requireControlsAllRoutesOr, requireOpenPeriods } from '../capital/corrections.ts';
import { capitalModelOf, contributionRoutes, entriesOf, expenseContributions, parseContributions, requireGeneralFundingActor, sumOf } from '../capital/generalFunding.ts';

/** Alcances de gasto: los de CLEAN más el general del Administrador (0035, solo API/servidor). */
type Scope = ExpenseScope | 'administrador';

interface ExpenseRow {
  id: string; route_id: string | null; scope: Scope | null; category_id: string; amount_minor: string; description: string | null;
  expense_date: string | Date; registered_by_membership_id: string; collector_membership_id: string | null; funding: string | null;
  funding_admin_membership_id: string | null; refunds_expense_id: string | null; reference: string | null; created_at: Date;
  reversal_id: string | null; reversed_at: Date | null; reversed_by_membership_id: string | null; reversal_reason: string | null;
  reverses_id: string | null; ledger_operation_id: string | null;
  responsible_admin_membership_id?: string | null;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

/** Estado para presentar (`poolExpenseStateOf` de CLEAN, para todos los ámbitos). */
function stateOf(e: ExpenseRow): string {
  if (!e.ledger_operation_id) return e.scope === 'empresa' && !e.funding ? 'historico' : 'legado';
  if (e.reverses_id) return 'anulacion';
  if (e.refunds_expense_id) return 'reintegro';
  if (e.reversal_id) return 'anulado';
  return 'vigente';
}

type ContributionView = { routeId: string | null; routeName: string | null; amountMinor: number; operationId: string };
interface Extra { nature: string | null; contributions: ContributionView[] }

/**
 * Vista de un gasto. R74 (0035): `adminId` (Administrador responsable del gasto general con fuente
 * `routes`/`own_money`), `nature` (de la categoría), `contributions` (aportes por ruta; en una anulación,
 * los del original) e `isReimbursable` (C2: siempre). `funding` admite 'routes' y 'own_money'.
 */
function expenseView(e: ExpenseRow, x: Extra = { nature: null, contributions: [] }) {
  return {
    adminId: e.responsible_admin_membership_id ?? null, nature: x.nature, contributions: x.contributions,
    isReimbursable: e.funding === 'own_money',
    id: e.id, scope: e.scope, routeId: e.route_id, workerId: e.collector_membership_id, categoryId: e.category_id,
    amountMinor: Number(e.amount_minor), description: e.description, reference: e.reference, expenseDate: ymd(e.expense_date),
    registeredBy: e.registered_by_membership_id, funding: e.funding, fundingAdminId: e.funding_admin_membership_id,
    state: stateOf(e), reversesId: e.reverses_id, refundsExpenseId: e.refunds_expense_id, reversalId: e.reversal_id,
    reversedAt: e.reversed_at?.toISOString() ?? null, reversedBy: e.reversed_by_membership_id, reversalReason: e.reversal_reason,
    ledgerOperationId: e.ledger_operation_id, createdAt: e.created_at.toISOString(),
  };
}

function amountOf(body: Record<string, unknown>): number {
  const v = body['amountMinor'];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ApiError(400, 'INVALID_INPUT', 'amountMinor must be a positive integer (minor units)', { field: 'amountMinor' });
  return v;
}

/** Naturaleza de la categoría y aportes (del original en una anulación) para un lote de gastos. */
async function extrasOf(client: pg.PoolClient, ctx: ActiveContext, rows: readonly ExpenseRow[]): Promise<Map<string, Extra>> {
  const out = new Map<string, Extra>();
  if (!rows.length) return out;
  const cats = new Map((await client.query<{ id: string; nature: string }>(
    'select id, nature from adex.expense_categories where company_id = $1 and id = any($2)', [ctx.companyId, [...new Set(rows.map((r) => r.category_id))]])).rows
    .map((c) => [c.id, c.nature] as const));
  const routed = rows.filter((r) => r.funding === 'routes');
  const cs = await expenseContributions(client, ctx, [...new Set(routed.map((r) => r.reverses_id ?? r.id))]);
  for (const r of rows) out.set(r.id, { nature: cats.get(r.category_id) ?? null, contributions: r.funding === 'routes' ? cs.get(r.reverses_id ?? r.id) ?? [] : [] });
  return out;
}

async function viewOf(client: pg.PoolClient, ctx: ActiveContext, e: ExpenseRow) {
  return expenseView(e, (await extrasOf(client, ctx, [e])).get(e.id));
}

async function loadExpense(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<ExpenseRow> {
  pathId(id);
  const r = await client.query<ExpenseRow>('select * from adex.expenses where company_id = $1 and id = $2', [ctx.companyId, id]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

async function visibleEntries(client: pg.PoolClient, ctx: ActiveContext, opId: string) {
  const r = await client.query<{ kind: string; membership_id: string | null; route_id: string | null; amount_minor: string; balance_after_minor: string }>(
    `select a.kind, a.membership_id, a.route_id, e.amount_minor, e.balance_after_minor
       from adex.capital_entries e join adex.capital_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = $1 and e.operation_id = $2 order by e.leg`, [ctx.companyId, opId]);
  return r.rows.map((x) => ({ account: { kind: x.kind, membershipId: x.membership_id, routeId: x.route_id },
    amountMinor: Number(x.amount_minor), balanceAfterMinor: Number(x.balance_after_minor) }));
}

/** `offline` (Ronda 62): gasto propio del Cobrador capturado sin conexión (ver offline/capture.ts). */
export const EXPENSE_FIELDS = ['scope', 'routeId', 'workerId', 'categoryId', 'amountMinor', 'description', 'reference', 'fundingSource', 'fundingAdminId', 'offline',
  // R74 (0035): `funding` = alias de `fundingSource`; `contributions` = aportes por ruta (fuente 'routes').
  'funding', 'contributions'] as const;

/**
 * R74 (0035): gasto GENERAL con las fuentes nuevas (alcance `administrador`, o `empresa` con 'routes'/'own_money').
 * El Administrador registra; PostgreSQL revalida todo bajo bloqueo (`adex.general_expense_post`).
 */
async function createGeneralExpense(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, opId: string,
  scope: 'administrador' | 'empresa', funding: 'routes' | 'own_money') {
  if (body['routeId'] != null || body['workerId'] != null) throw new ApiError(400, 'INVALID_INPUT', 'a general expense has no route or worker: contributions say where the money came from');
  if (body['fundingAdminId'] != null) throw new ApiError(400, 'INVALID_INPUT', 'fundingAdminId belongs to administrator pools', { field: 'fundingAdminId' });
  if (body['offline'] != null) throw new ApiError(400, 'INVALID_INPUT', 'general expenses are registered online', { field: 'offline' });
  requireGeneralFundingActor(ctx);
  need(ctx, 'expense.register');
  need(ctx, 'cashbox.viewConsolidated');
  const categoryId = reqId(body, 'categoryId');
  const amount = amountOf(body);
  const description = optText(body, 'description', 300);
  const reference = optText(body, 'reference', 120);
  if (!description || description.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'description is required', { field: 'description' });
  const contributions = parseContributions(body);
  if (funding === 'routes') {
    if (!contributions) throw new ApiError(400, 'CONTRIBUTIONS_INVALID', 'contributions are required with fundingSource routes', { field: 'contributions' });
    if (sumOf(contributions) !== amount) throw new ApiError(400, 'CONTRIBUTIONS_INVALID', 'the contributions must add up to amountMinor', { field: 'contributions' });
    if (await capitalModelOf(client, ctx) !== 'route_base') throw new ApiError(409, 'ROUTE_BASE_NOT_ACTIVE', 'route contributions need the route base model: use own money in this company');
  } else if (contributions) {
    throw new ApiError(400, 'INVALID_INPUT', 'own money expenses have no route contributions', { field: 'contributions' });
  }
  const cat = (await client.query<{ id: string }>('select id from adex.expense_categories where company_id = $1 and id = $2', [ctx.companyId, categoryId])).rows[0];
  if (!cat) throw new ApiError(400, 'CATEGORY_INVALID');
  const names = contributions ? await contributionRoutes(client, ctx, contributions) : new Map<string, string>();
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.general_expense_post($1, $2, $3, $4, $5, $6, $7, $8) r',
    [opId, scope, categoryId, amount, description, reference, funding, contributions ? JSON.stringify(contributions) : null])).rows[0]!.r;
  const expense = await loadExpense(client, ctx, r['expenseId'] as string);
  await audit(client, ctx, {
    action: 'CREATE_EXPENSE', entityType: 'expense', entityId: expense.id, routeId: null,
    description: `Gasto general de ${scope === 'administrador' ? 'Administrador' : 'empresa'}`
      + (funding === 'routes'
        ? ` con aportes de ${contributions!.map((c) => `${names.get(c.routeId) ?? c.routeId} (${c.amountMinor})`).join(', ')}`
        : ' pagado con dinero propio del Administrador (reembolsable)') + `: ${amount}.`,
    after: { scope, amountMinor: amount, categoryId, expenseDate: ymd(expense.expense_date), funding, adminId: ctx.membershipId, contributions: r['contributions'] },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], ledgerOperationIds: r['operationIds'], kind: r['kind'] },
  });
  const opIds = r['operationIds'] as string[];
  return {
    expense: await viewOf(client, ctx, expense), entries: await entriesOf(client, ctx, opIds), offline: null,
    ...(funding === 'own_money' ? { pendingMinor: Number(r['pendingMinor']) } : {}),
  };
}

export async function createExpense(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const scope = oneOf(body, 'scope', ['empresa', 'ruta', 'trabajador', 'administrador'] as const);
  // R74 (0035): `funding` es alias de `fundingSource` (si llegan ambos, deben coincidir).
  if (body['funding'] !== undefined) {
    if (body['fundingSource'] !== undefined && body['fundingSource'] !== body['funding']) throw new ApiError(400, 'INVALID_INPUT', 'funding and fundingSource differ', { field: 'funding' });
    body = { ...body, fundingSource: body['funding'] };
    delete body['funding'];
  }
  const src = body['fundingSource'];
  if (scope === 'administrador' || (scope === 'empresa' && (src === 'routes' || src === 'own_money'))) {
    const funding = oneOf(body, 'fundingSource', ['routes', 'own_money'] as const);
    return createGeneralExpense(client, ctx, body, opId, scope, funding);
  }
  if (body['contributions'] !== undefined && body['contributions'] !== null) {
    throw new ApiError(400, 'INVALID_INPUT', 'contributions apply only to general expenses funded by routes', { field: 'contributions' });
  }
  const routeId = optId(body, 'routeId');
  const workerId = optId(body, 'workerId');
  const shape = expenseShapeError({ scope, routeId: routeId ?? undefined, collectorId: workerId ?? undefined });
  if (shape) throw new ApiError(400, 'INVALID_INPUT', shape);
  const categoryId = reqId(body, 'categoryId');
  const amount = amountOf(body);
  const description = optText(body, 'description', 300);
  const reference = optText(body, 'reference', 120);
  // Ronda 62: sin conexión solo el Cobrador, y solo su propio gasto (lo paga su custodia, sin tope).
  const offline = parseOffline(body['offline']);
  if (offline) {
    requireOfflineActor(ctx);
    if (scope !== 'trabajador' || workerId !== ctx.membershipId) throw new ApiError(400, 'INVALID_INPUT', 'offline expenses are your own worker expenses', { field: 'offline' });
  }
  if (scope !== 'empresa' && (body['fundingSource'] !== undefined || body['fundingAdminId'] !== undefined)) {
    throw new ApiError(400, 'INVALID_INPUT', 'only company expenses choose a pool: route and worker expenses are paid by their own account');
  }
  let funding: 'admin' | 'empresa' | null = null;
  let fundingAdmin: string | null = null;
  let routeName: string | null = null;
  let workerName: string | null = null;
  if (scope === 'empresa') {
    need(ctx, 'expense.register');
    need(ctx, 'cashbox.viewConsolidated');
    if (!description || description.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'description is required', { field: 'description' });
    funding = oneOf(body, 'fundingSource', ['admin', 'empresa'] as const);
    fundingAdmin = funding === 'admin' ? reqId(body, 'fundingAdminId') : null;
    if (funding === 'empresa' && body['fundingAdminId'] !== undefined && body['fundingAdminId'] !== null) throw new ApiError(400, 'INVALID_INPUT', 'the company pool has no administrator');
    if (ctx.role === 'admin' && (funding !== 'admin' || fundingAdmin !== ctx.membershipId)) throw new ApiError(403, 'POOL_NOT_ALLOWED', 'an administrator pays only from their own pool');
    if (ctx.role === 'superadmin' && funding === 'admin') {
      const a = (await loadMembers(client, ctx, [fundingAdmin!])).get(fundingAdmin!);
      if (!a || a.role !== 'admin') throw new ApiError(404, 'NOT_FOUND');
      if (a.status !== 'activo') throw new ApiError(409, 'MEMBER_INACTIVE');
    }
  } else {
    const route = await routeOf(client, ctx, routeId!);
    routeName = route.name;
    need(ctx, 'expense.register', { routeId: route.id });
    const members = await loadMembers(client, ctx);
    if (scope === 'ruta') {
      need(ctx, 'cashCustody.manage', { routeId: route.id });
      requireAuthority(ctx, route, 'structural', members);
    } else {
      const worker = requireCustodian(members, workerId!, route.id);
      workerName = worker.displayName;
      if (worker.membershipId !== ctx.membershipId) {
        // Cargarlo a otra persona es operar con su efectivo (nivel `settle`).
        // R74: el SuperAdmin ya no carga gastos a otros (no es operador financiero de la ruta).
        if (!ctx.role || !['admin', 'supervisor'].includes(ctx.role)) throw new ApiError(403, 'PERMISSION_DENIED', 'expenses you register are yours');
        need(ctx, 'cashCustody.manage', { routeId: route.id });
        requireAuthority(ctx, route, 'settle', members);
      }
    }
  }
  const cat = (await client.query<{ id: string }>('select id from adex.expense_categories where company_id = $1 and id = $2', [ctx.companyId, categoryId])).rows[0];
  if (!cat) throw new ApiError(400, 'CATEGORY_INVALID');

  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.expense_post($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) r',
    [opId, scope, routeId, workerId, categoryId, amount, description, reference, funding, fundingAdmin])).rows[0]!.r;
  const expense = await loadExpense(client, ctx, r['expenseId'] as string);
  const offlineStatus = offline
    ? await storeOfflineCapture(client, ctx, { operationId: opId, kind: 'expense', entityId: expense.id, routeId: routeId!, capture: offline })
    : null;
  await audit(client, ctx, {
    action: 'CREATE_EXPENSE', entityType: 'expense', entityId: expense.id, routeId,
    description: `Gasto de ${scope}${workerName ? ` a cargo de ${workerName}` : ''}${routeName ? ` en ${routeName}` : ''}`
      + `${funding === 'empresa' ? ' pagado con la bolsa de la empresa' : funding === 'admin' ? ' pagado con la bolsa del Administrador' : ''}: ${amount}.`,
    after: { scope, routeId, workerId, amountMinor: amount, categoryId, expenseDate: ymd(expense.expense_date), funding, fundingAdminId: fundingAdmin },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], kind: r['kind'],
      ...(offline ? { offline: { deviceCapturedAt: offline.deviceCapturedAt, stored: offlineStatus } } : {}) },
  });
  return { expense: await viewOf(client, ctx, expense), entries: await visibleEntries(client, ctx, r['operationId'] as string),
    offline: offline ? { deviceCapturedAt: offline.deviceCapturedAt } : null };
}

/**
 * Anulación total (asiento espejo enlazado; el original queda ANULADO con quién, cuándo y
 * motivo; el importe vuelve a la cuenta que pagó).
 *   · gasto de bolsa (D12): el Administrador, su bolsa; el SuperAdmin, cualquiera;
 *   · gasto de trabajador o de ruta: autoridad `correct` (responsable de capital de la ruta; R74: ya no el
 *     SuperAdmin). R74 (0037, regla definitiva): el responsable anula también lo que ÉL registró (se retiró la
 *     independencia F5-D02); solo nadie anula un gasto cargado a SU propia custodia (tampoco con otra membresía).
 *     Con la semana del gasto cerrada, ajuste en el periodo abierto con autoridad de ajustes (D7); con el periodo
 *     de HOY cerrado, 409 con la reapertura como camino (`details.dependencies`).
 *   · gasto con dinero propio ya reembolsado: 409 con los reembolsos que lo impiden; con `cascade: true` se anulan
 *     esos reembolsos y el gasto en UNA transacción (si todos los puede anular el actor).
 *   · gasto general con aportes de rutas de varios responsables: 409 con la anulación coordinada como camino.
 * PostgreSQL lo revalida todo bajo bloqueo (`adex.expense_reverse`).
 */
export async function reverseExpense(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const prev = await loadExpense(client, ctx, id);
  need(ctx, 'expense.correct', prev.route_id ? { routeId: prev.route_id } : {});
  if (body['cascade'] !== undefined && typeof body['cascade'] !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'cascade must be a boolean', { field: 'cascade' });
  const cascade = body['cascade'] === true;
  const correctable = !!prev.ledger_operation_id && !prev.reverses_id && !prev.refunds_expense_id && !prev.reversal_id;
  if (prev.route_id) {
    const route = await routeOf(client, ctx, prev.route_id);
    if (prev.scope !== 'empresa' && correctable) {
      requireAuthority(ctx, route, 'correct', await loadMembers(client, ctx));
      // R74 (0037): sin «quien registró no anula»; solo la propia custodia queda fuera (PostgreSQL: AX717).
      if (prev.collector_membership_id) {
        const own = (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, prev.collector_membership_id])).rows[0]!.s;
        if (own) throw new ApiError(403, 'SELF_CORRECTION_FORBIDDEN', 'nobody reverses an expense charged to their own custody');
      }
      await requireOpenPeriods(client, ctx, [route.id]);
    }
  }
  // 0039 (RB-D12): un gasto general con aportes de rutas lo anula COMPLETO quien lo registró (o, si ya no responde, un
  // responsable vigente de esas rutas). Sin 0039 aplicada: la regla anterior (responsable de todas o anulación coordinada).
  if (prev.funding === 'routes' && correctable) {
    if (ctx.role !== 'admin') throw new ApiError(403, 'CAPITAL_AUTHORITY_REQUIRED', 'only an administrator reverses general expenses');
    const routes = (await client.query<{ r: string[] }>('select adex.general_funding_routes($1, null) r', [prev.id])).rows[0]!.r;
    await requireControlsAllRoutesOr(client, ctx, routes, { kind: 'expense', id: prev.id, amountMinor: Number(prev.amount_minor), label: prev.description ?? 'Gasto general' },
      prev.registered_by_membership_id ?? null);
    await requireOpenPeriods(client, ctx, routes);
  }
  const reason = reqText(body, 'reason', 200);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  // R74 (0037): gasto con dinero propio ya reembolsado → dependencias (reembolsos) y, si se pide, anulación en cadena.
  const cascaded: Record<string, unknown>[] = [];
  if (prev.funding === 'own_money' && correctable && ctx.role === 'admin' && prev.responsible_admin_membership_id === ctx.membershipId) {
    const deps = await expenseDependencies(client, prev.id);
    if (deps.length) {
      const blocked = deps.filter((d) => !d['reversibleByActor']);
      if (!cascade || blocked.length) {
        throw new ApiError(409, 'PAYABLE_ALREADY_REIMBURSED', blocked.length
          ? 'the obligation was reimbursed by someone else: they reverse that reimbursement first'
          : 'the obligation was already reimbursed: reverse the reimbursements first (cascade: true does it in the same transaction)',
        { dependencies: deps, cascadeAvailable: blocked.length === 0 });
      }
      for (const [i, d] of deps.entries()) {
        const sub = derivedOperationId(opId, `cascade:${i + 1}`);
        const rr = (await client.query<{ r: Record<string, unknown> }>('select adex.admin_reimbursement_reverse($1, $2, $3) r',
          [sub, d.id, `${reason} (anulación en cadena del gasto)`.slice(0, 300)])).rows[0]!.r;
        await audit(client, ctx, {
          action: 'ADMIN_REIMBURSEMENT_REVERSED', entityType: 'admin_reimbursement', entityId: d.id, routeId: null, reason,
          description: `Reembolso anulado (${Number(d.amountMinor)}) para poder anular el gasto que pagaba: ${reason}`,
          before: { estado: 'vigente', amountMinor: d.amountMinor }, after: { estado: 'anulado', pendingAfterMinor: rr['pendingAfterMinor'] },
          metadata: { operationId: sub, cascadeOf: opId, expenseId: prev.id, ledgerOperationIds: rr['operationIds'] },
        });
        cascaded.push({ reimbursementId: d.id, amountMinor: d.amountMinor, operationIds: rr['operationIds'] });
      }
    }
  }
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.expense_reverse($1, $2, $3) r', [opId, prev.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'MOVEMENT_REVERSED', entityType: 'expense', entityId: prev.id, routeId: prev.route_id, reason,
    description: `Gasto anulado (${Number(prev.amount_minor)}): ${reason}`,
    before: { valor: Number(prev.amount_minor), estado: 'vigente' },
    after: { estado: 'anulado', reversalId: r['reversalExpenseId'], fecha: r['reversalDate'], funding: prev.funding, fundingAdminId: prev.funding_admin_membership_id },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], scope: prev.scope, workerId: prev.collector_membership_id,
      registeredBy: prev.registered_by_membership_id, originalDate: ymd(prev.expense_date), periodClosed: r['periodClosed'] === true,
      selfCorrection: prev.registered_by_membership_id === ctx.membershipId, ...(cascaded.length ? { cascadedReimbursements: cascaded } : {}) },
  });
  // R74 (0035): un gasto con aportes de varias rutas se anula con una operación por aporte.
  const opIds = Array.isArray(r['operationIds']) ? (r['operationIds'] as string[]) : [r['operationId'] as string];
  return {
    reversal: await viewOf(client, ctx, await loadExpense(client, ctx, r['reversalExpenseId'] as string)),
    original: await viewOf(client, ctx, await loadExpense(client, ctx, prev.id)),
    entries: opIds.length > 1 ? await entriesOf(client, ctx, opIds) : await visibleEntries(client, ctx, r['operationId'] as string),
    ...(cascaded.length ? { cascadedReimbursements: cascaded } : {}),
  };
}

/** Reintegro parcial de un gasto de bolsa (D12), hasta lo no reintegrado. */
export async function refundExpense(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const prev = await loadExpense(client, ctx, id);
  need(ctx, 'expense.correct');
  const amount = amountOf(body);
  const reason = reqText(body, 'reason', 200);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.expense_refund($1, $2, $3, $4) r', [opId, prev.id, amount, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'EXPENSE_REFUNDED', entityType: 'expense', entityId: prev.id, routeId: prev.route_id, reason,
    description: `Reintegro de ${amount} al gasto administrativo: ${reason}`,
    after: { reintegroId: r['refundExpenseId'], amount, remainingMinor: r['remainingMinor'], funding: prev.funding, fundingAdminId: prev.funding_admin_membership_id },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'] },
  });
  return {
    refund: await viewOf(client, ctx, await loadExpense(client, ctx, r['refundExpenseId'] as string)), remainingMinor: Number(r['remainingMinor']),
    entries: await visibleEntries(client, ctx, r['operationId'] as string),
  };
}

/** Gastos visibles (RLS: de ruta, quien la gestiona; los propios; de empresa, su bolsa). */
export async function listExpenses(client: pg.PoolClient, ctx: ActiveContext, q: URLSearchParams) {
  const params: unknown[] = [ctx.companyId];
  let where = 'company_id = $1';
  for (const [key, col] of [['routeId', 'route_id'], ['workerId', 'collector_membership_id']] as const) {
    const v = q.get(key);
    if (v !== null) { pathId(v); params.push(v); where += ` and ${col} = $${params.length}`; }
  }
  const scope = q.get('scope');
  if (scope !== null) {
    if (!['empresa', 'ruta', 'trabajador', 'administrador'].includes(scope)) throw new ApiError(400, 'INVALID_INPUT');
    params.push(scope); where += ` and scope = $${params.length}`;
  }
  where += pageFilters(q, 'expense_date', params);
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 1000);
  params.push(limit);
  const r = await client.query<ExpenseRow>(`select * from adex.expenses where ${where} order by ${PAGE_ORDER} limit $${params.length}`, params);
  const extras = await extrasOf(client, ctx, r.rows);
  return r.rows.map((e) => expenseView(e, extras.get(e.id)));
}

export async function getExpense(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const e = await loadExpense(client, ctx, id);
  const refunds = (await client.query<ExpenseRow>('select * from adex.expenses where company_id = $1 and refunds_expense_id = $2 order by created_at', [ctx.companyId, e.id])).rows;
  const extras = await extrasOf(client, ctx, [e, ...refunds]);
  // R74 (0035): con aportes de varias rutas, las patas de todas sus operaciones.
  const ops = e.funding === 'routes'
    ? (await client.query<{ id: string }>('select id from adex.capital_operations where company_id = $1 and expense_id = $2 order by created_at, id', [ctx.companyId, e.id])).rows.map((x) => x.id)
    : [];
  return { expense: expenseView(e, extras.get(e.id)), refunds: refunds.map((x) => expenseView(x, extras.get(x.id))),
    entries: ops.length > 1 ? await entriesOf(client, ctx, ops) : e.ledger_operation_id ? await visibleEntries(client, ctx, e.ledger_operation_id) : [] };
}
