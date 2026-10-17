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

import type pg from 'pg';
import { expenseShapeError } from '@/lib/expenseAttribution';
import type { ExpenseScope } from '@/models/types';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { loadMembers, need } from '../structure/common.ts';
import { oneOf, optId, optText, pathId, reqId, reqText } from '../structure/input.ts';
import { requireAuthority, requireCustodian, requireOperationId, routeOf } from '../capital/service.ts';

interface ExpenseRow {
  id: string; route_id: string | null; scope: ExpenseScope | null; category_id: string; amount_minor: string; description: string | null;
  expense_date: string | Date; registered_by_membership_id: string; collector_membership_id: string | null; funding: string | null;
  funding_admin_membership_id: string | null; refunds_expense_id: string | null; reference: string | null; created_at: Date;
  reversal_id: string | null; reversed_at: Date | null; reversed_by_membership_id: string | null; reversal_reason: string | null;
  reverses_id: string | null; ledger_operation_id: string | null;
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

function expenseView(e: ExpenseRow) {
  return {
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

export const EXPENSE_FIELDS = ['scope', 'routeId', 'workerId', 'categoryId', 'amountMinor', 'description', 'reference', 'fundingSource', 'fundingAdminId'] as const;

export async function createExpense(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const scope = oneOf(body, 'scope', ['empresa', 'ruta', 'trabajador'] as const);
  const routeId = optId(body, 'routeId');
  const workerId = optId(body, 'workerId');
  const shape = expenseShapeError({ scope, routeId: routeId ?? undefined, collectorId: workerId ?? undefined });
  if (shape) throw new ApiError(400, 'INVALID_INPUT', shape);
  const categoryId = reqId(body, 'categoryId');
  const amount = amountOf(body);
  const description = optText(body, 'description', 300);
  const reference = optText(body, 'reference', 120);
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
        if (!ctx.role || !['superadmin', 'admin', 'supervisor'].includes(ctx.role)) throw new ApiError(403, 'PERMISSION_DENIED', 'expenses you register are yours');
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
  await audit(client, ctx, {
    action: 'CREATE_EXPENSE', entityType: 'expense', entityId: expense.id, routeId,
    description: `Gasto de ${scope}${workerName ? ` a cargo de ${workerName}` : ''}${routeName ? ` en ${routeName}` : ''}`
      + `${funding === 'empresa' ? ' pagado con la bolsa de la empresa' : funding === 'admin' ? ' pagado con la bolsa del Administrador' : ''}: ${amount}.`,
    after: { scope, routeId, workerId, amountMinor: amount, categoryId, expenseDate: ymd(expense.expense_date), funding, fundingAdminId: fundingAdmin },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], kind: r['kind'] },
  });
  return { expense: expenseView(expense), entries: await visibleEntries(client, ctx, r['operationId'] as string) };
}

/**
 * Anulación total (asiento espejo enlazado; el original queda ANULADO con quién, cuándo y
 * motivo; el importe vuelve a la cuenta que pagó).
 *   · gasto de bolsa (D12): el Administrador, su bolsa; el SuperAdmin, cualquiera;
 *   · gasto de trabajador o de ruta (F5-D02): autoridad `correct` (responsable de la ruta
 *     o SuperAdmin) y nunca la persona que lo registró, tampoco con otra membresía; con la
 *     semana del gasto cerrada, ajuste en el periodo abierto con autoridad de ajustes (D7).
 * PostgreSQL lo revalida todo bajo bloqueo (`adex.expense_reverse`).
 */
export async function reverseExpense(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>, operationId: string | null) {
  const opId = requireOperationId(operationId);
  const prev = await loadExpense(client, ctx, id);
  need(ctx, 'expense.correct', prev.route_id ? { routeId: prev.route_id } : {});
  if (prev.route_id) {
    const route = await routeOf(client, ctx, prev.route_id);
    if (prev.scope !== 'empresa' && prev.ledger_operation_id && !prev.reverses_id && !prev.refunds_expense_id) {
      requireAuthority(ctx, route, 'correct', await loadMembers(client, ctx));
      const same = (await client.query<{ s: boolean }>('select adex.same_person($1, $2, $3) s', [ctx.companyId, ctx.membershipId, prev.registered_by_membership_id])).rows[0]!.s;
      if (same) throw new ApiError(403, 'SELF_CORRECTION_FORBIDDEN');
    }
  }
  const reason = reqText(body, 'reason', 200);
  if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'reason is required', { field: 'reason' });
  const r = (await client.query<{ r: Record<string, unknown> }>('select adex.expense_reverse($1, $2, $3) r', [opId, prev.id, reason])).rows[0]!.r;
  await audit(client, ctx, {
    action: 'MOVEMENT_REVERSED', entityType: 'expense', entityId: prev.id, routeId: prev.route_id, reason,
    description: `Gasto anulado (${Number(prev.amount_minor)}): ${reason}`,
    before: { valor: Number(prev.amount_minor), estado: 'vigente' },
    after: { estado: 'anulado', reversalId: r['reversalExpenseId'], fecha: r['reversalDate'], funding: prev.funding, fundingAdminId: prev.funding_admin_membership_id },
    metadata: { operationId: opId, ledgerOperationId: r['operationId'], scope: prev.scope, workerId: prev.collector_membership_id,
      registeredBy: prev.registered_by_membership_id, originalDate: ymd(prev.expense_date), periodClosed: r['periodClosed'] === true },
  });
  return {
    reversal: expenseView(await loadExpense(client, ctx, r['reversalExpenseId'] as string)),
    original: expenseView(await loadExpense(client, ctx, prev.id)),
    entries: await visibleEntries(client, ctx, r['operationId'] as string),
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
    refund: expenseView(await loadExpense(client, ctx, r['refundExpenseId'] as string)), remainingMinor: Number(r['remainingMinor']),
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
    if (!['empresa', 'ruta', 'trabajador'].includes(scope)) throw new ApiError(400, 'INVALID_INPUT');
    params.push(scope); where += ` and scope = $${params.length}`;
  }
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 200) || 200, 1), 500);
  params.push(limit);
  const r = await client.query<ExpenseRow>(`select * from adex.expenses where ${where} order by created_at desc, id limit $${params.length}`, params);
  return r.rows.map(expenseView);
}

export async function getExpense(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  const e = await loadExpense(client, ctx, id);
  const refunds = (await client.query<ExpenseRow>('select * from adex.expenses where company_id = $1 and refunds_expense_id = $2 order by created_at', [ctx.companyId, e.id])).rows;
  return { expense: expenseView(e), refunds: refunds.map(expenseView), entries: e.ledger_operation_id ? await visibleEntries(client, ctx, e.ledger_operation_id) : [] };
}
