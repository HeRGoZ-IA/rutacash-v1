// CATEGORÍAS DE GASTO (ExpenseCategoriesPage de CLEAN → comandos). Pantalla de
// Administrador y SuperAdmin (`settings.access`). Nombre único por empresa sin
// distinguir mayúsculas (índice único de 0007). Una categoría con gastos no se borra:
// se desactiva (FK + guarda DS-11 de 0007).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from './common.ts';
import { bool, has, optText, pathId, reqText } from './input.ts';

interface Row { id: string; name: string; icon: string | null; active: boolean }
const view = (r: Row) => ({ id: r.id, name: r.name, icon: r.icon, active: r.active });

async function load(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<Row> {
  const r = await client.query<Row>('select id, name, icon, active from adex.expense_categories where company_id = $1 and id = $2 for update',
    [ctx.companyId, pathId(id)]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

/** Catálogo de la empresa: lo consulta quien registra gastos y quien lo administra. */
export async function listCategories(client: pg.PoolClient, ctx: ActiveContext) {
  const r = await client.query<Row>('select id, name, icon, active from adex.expense_categories where company_id = $1 order by lower(name), id', [ctx.companyId]);
  return r.rows.map(view);
}

export async function createCategory(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  const row: Row = { id: randomUUID(), name: reqText(body, 'name', 80), icon: optText(body, 'icon', 40), active: true };
  await client.query('insert into adex.expense_categories (id, company_id, name, icon, active) values ($1, $2, $3, $4, true)',
    [row.id, ctx.companyId, row.name, row.icon]);
  await audit(client, ctx, { action: 'CREATE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: row.id,
    description: `Categoría creada: ${row.name}`, after: view(row) });
  return view(row);
}

export async function updateCategory(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  const prev = await load(client, ctx, id);
  const next: Row = {
    ...prev,
    name: has(body, 'name') ? reqText(body, 'name', 80) : prev.name,
    icon: has(body, 'icon') ? optText(body, 'icon', 40) : prev.icon,
    active: has(body, 'active') ? bool(body, 'active') : prev.active,
  };
  if (next.name === prev.name && next.icon === prev.icon && next.active === prev.active) return view(prev);
  await client.query('update adex.expense_categories set name = $3, icon = $4, active = $5 where company_id = $1 and id = $2',
    [ctx.companyId, prev.id, next.name, next.icon, next.active]);
  await audit(client, ctx, { action: 'UPDATE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: prev.id,
    description: `Categoría actualizada: ${next.name}`, before: view(prev), after: view(next) });
  return view(next);
}

export async function deleteCategory(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  need(ctx, 'settings.access');
  const prev = await load(client, ctx, id);
  const refs = (await client.query<{ refs: string[] }>("select adex.protected_references('adex.expense_categories'::regclass, $1, $2) refs",
    [ctx.companyId, prev.id])).rows[0]!.refs;
  if (refs.length) throw new ApiError(409, 'HAS_HISTORY', 'the category has expenses: deactivate it instead', { references: refs });
  await client.query('delete from adex.expense_categories where company_id = $1 and id = $2', [ctx.companyId, prev.id]);
  await audit(client, ctx, { action: 'DELETE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: prev.id,
    description: `Categoría eliminada: ${prev.name}`, before: view(prev) });
  return { deleted: prev.id };
}
