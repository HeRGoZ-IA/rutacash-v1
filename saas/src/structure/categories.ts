// CATEGORÍAS DE GASTO (ExpenseCategoriesPage de CLEAN → comandos). Pantalla de
// Administrador y SuperAdmin (`settings.access`). Nombre único por empresa sin
// distinguir mayúsculas entre las no eliminadas (índice único de 0007, parcial desde 0040).
// 0040 (pendiente 3.14): casilla «Para Cobradores» (lo que pueden usar Cobrador y Supervisor)
// y eliminación con historia: el tipo sale de la lista y sus gastos conservan tipo y nombre.
// Sin gastos se borra de verdad (FK + guarda DS-11 de 0007).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';
import { audit } from '../db/audit.ts';
import { need } from './common.ts';
import { bool, has, oneOf, optText, pathId, reqText } from './input.ts';

// R74 Base por Ruta (0034, O4): naturaleza del gasto. `bien_duradero` (p. ej. una moto) no se presenta como
// gasto operativo del periodo en el panel por ruta. Sin depreciación ni contabilidad de activos.
export const EXPENSE_NATURES = ['operativo', 'bien_duradero', 'otro'] as const;
type Nature = (typeof EXPENSE_NATURES)[number];

interface Row { id: string; name: string; icon: string | null; active: boolean; nature: Nature; for_collectors: boolean; deleted_at: Date | null }
const view = (r: Row) => ({ id: r.id, name: r.name, icon: r.icon, active: r.active, nature: r.nature,
  forCollectors: r.for_collectors, deleted: r.deleted_at !== null });

let ready = false;
/** 0040 aplicada (casilla «Para Cobradores» y eliminación con historia). Solo se recuerda el «sí». */
export async function collectorCategoriesReady(q: pg.Pool | pg.PoolClient): Promise<boolean> {
  if (ready) return true;
  try {
    const r = await q.query<{ ok: boolean }>(
      "select exists (select 1 from pg_attribute where attrelid = 'adex.expense_categories'::regclass and attname = 'for_collectors' and not attisdropped) ok");
    ready = r.rows[0]?.ok === true;
  } catch {
    ready = false;
  }
  return ready;
}

// Sin 0040 todo tipo sirve a todos (comportamiento anterior) y nada está eliminado.
const cols = (on: boolean) => on ? 'id, name, icon, active, nature, for_collectors, deleted_at' : 'id, name, icon, active, nature, true for_collectors, null::timestamptz deleted_at';

async function load(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<Row> {
  const r = await client.query<Row>(`select ${cols(await collectorCategoriesReady(client))} from adex.expense_categories where company_id = $1 and id = $2 for update`,
    [ctx.companyId, pathId(id)]);
  if (!r.rows[0]) throw new ApiError(404, 'NOT_FOUND');
  return r.rows[0];
}

/** Para registrar un gasto: el tipo, si sigue en la lista y si lo pueden usar Cobradores y Supervisores. */
export async function categoryForUse(client: pg.PoolClient, ctx: ActiveContext, id: string): Promise<Row | null> {
  const r = await client.query<Row>(`select ${cols(await collectorCategoriesReady(client))} from adex.expense_categories where company_id = $1 and id = $2`,
    [ctx.companyId, id]);
  return r.rows[0] ?? null;
}

/** Catálogo de la empresa: lo consulta quien registra gastos y quien lo administra. Incluye los eliminados
 *  (marcados) para que el historial siga mostrando el nombre de sus gastos. */
export async function listCategories(client: pg.PoolClient, ctx: ActiveContext) {
  const r = await client.query<Row>(`select ${cols(await collectorCategoriesReady(client))} from adex.expense_categories where company_id = $1 order by lower(name), id`, [ctx.companyId]);
  return r.rows.map(view);
}

async function requireReady(client: pg.PoolClient) {
  if (!(await collectorCategoriesReady(client))) throw new ApiError(409, 'MIGRATION_PENDING', 'expense categories for collectors need migration 0040');
}

export async function createCategory(client: pg.PoolClient, ctx: ActiveContext, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  const on = await collectorCategoriesReady(client);
  if (has(body, 'forCollectors')) await requireReady(client);
  const name = reqText(body, 'name', 80);
  const row: Row = { id: randomUUID(), name, icon: optText(body, 'icon', 40), active: true,
    nature: has(body, 'nature') ? oneOf(body, 'nature', EXPENSE_NATURES) : 'operativo',
    // Sin la casilla, el valor por nombre de 0040 (Transporte, Alimentación, Combustible).
    for_collectors: has(body, 'forCollectors') ? bool(body, 'forCollectors') : !on || ['transporte', 'alimentación', 'alimentacion', 'combustible'].includes(name.trim().toLowerCase()),
    deleted_at: null };
  if (on) {
    await client.query('insert into adex.expense_categories (id, company_id, name, icon, active, nature, for_collectors) values ($1, $2, $3, $4, true, $5, $6)',
      [row.id, ctx.companyId, row.name, row.icon, row.nature, row.for_collectors]);
  } else {
    await client.query('insert into adex.expense_categories (id, company_id, name, icon, active, nature) values ($1, $2, $3, $4, true, $5)',
      [row.id, ctx.companyId, row.name, row.icon, row.nature]);
  }
  await audit(client, ctx, { action: 'CREATE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: row.id,
    description: `Categoría creada: ${row.name}${on && row.for_collectors ? ' (para Cobradores)' : ''}`, after: view(row) });
  return view(row);
}

export async function updateCategory(client: pg.PoolClient, ctx: ActiveContext, id: string, body: Record<string, unknown>) {
  need(ctx, 'settings.access');
  if (has(body, 'forCollectors')) await requireReady(client);
  const prev = await load(client, ctx, id);
  if (prev.deleted_at) throw new ApiError(409, 'CATEGORY_DELETED', 'a deleted expense category cannot change');
  const next: Row = {
    ...prev,
    name: has(body, 'name') ? reqText(body, 'name', 80) : prev.name,
    icon: has(body, 'icon') ? optText(body, 'icon', 40) : prev.icon,
    active: has(body, 'active') ? bool(body, 'active') : prev.active,
    nature: has(body, 'nature') ? oneOf(body, 'nature', EXPENSE_NATURES) : prev.nature,
    for_collectors: has(body, 'forCollectors') ? bool(body, 'forCollectors') : prev.for_collectors,
  };
  if (next.name === prev.name && next.icon === prev.icon && next.active === prev.active && next.nature === prev.nature
    && next.for_collectors === prev.for_collectors) return view(prev);
  if (next.for_collectors !== prev.for_collectors) {
    await client.query('update adex.expense_categories set name = $3, icon = $4, active = $5, nature = $6, for_collectors = $7 where company_id = $1 and id = $2',
      [ctx.companyId, prev.id, next.name, next.icon, next.active, next.nature, next.for_collectors]);
  } else {
    await client.query('update adex.expense_categories set name = $3, icon = $4, active = $5, nature = $6 where company_id = $1 and id = $2',
      [ctx.companyId, prev.id, next.name, next.icon, next.active, next.nature]);
  }
  await audit(client, ctx, { action: 'UPDATE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: prev.id,
    description: `Categoría actualizada: ${next.name}`, before: view(prev), after: view(next) });
  return view(next);
}

export async function deleteCategory(client: pg.PoolClient, ctx: ActiveContext, id: string) {
  need(ctx, 'settings.access');
  const prev = await load(client, ctx, id);
  if (prev.deleted_at) return { deleted: prev.id, kept: true };
  const refs = (await client.query<{ refs: string[] }>("select adex.protected_references('adex.expense_categories'::regclass, $1, $2) refs",
    [ctx.companyId, prev.id])).rows[0]!.refs;
  if (refs.length) {
    if (!(await collectorCategoriesReady(client))) throw new ApiError(409, 'HAS_HISTORY', 'the category has expenses: deactivate it instead', { references: refs });
    // 0040: sale de la lista; los gastos registrados conservan su tipo y su nombre.
    await client.query('update adex.expense_categories set active = false, deleted_at = now() where company_id = $1 and id = $2', [ctx.companyId, prev.id]);
    await audit(client, ctx, { action: 'DELETE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: prev.id,
      description: `Categoría eliminada de la lista: ${prev.name} (sus gastos registrados se conservan)`, before: view(prev),
      after: view({ ...prev, active: false, deleted_at: new Date() }) });
    return { deleted: prev.id, kept: true };
  }
  await client.query('delete from adex.expense_categories where company_id = $1 and id = $2', [ctx.companyId, prev.id]);
  await audit(client, ctx, { action: 'DELETE_EXPENSE_CATEGORY', entityType: 'expense_category', entityId: prev.id,
    description: `Categoría eliminada: ${prev.name}`, before: view(prev) });
  return { deleted: prev.id, kept: false };
}
