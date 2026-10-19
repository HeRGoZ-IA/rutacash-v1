// PUENTE de `src/services/expenseService.ts` (CLEAN): gastos de empresa, ruta y trabajador,
// anulación y reintegro contra la API (Fase 5), con id de operación (el mismo que CLEAN ya
// genera al abrir el formulario: un reintento devuelve el gasto ya guardado). El servidor
// valida bolsa, responsable de capital, custodia, periodo cerrado y fondos. La fecha
// contable es la de la empresa: el servidor no admite gastos con otra fecha.

import type { Expense } from '@clean/models/types';
import { ExpenseError, type CreateExpenseParams } from '@clean/services/expenseService';
import { money } from '../../runtime/commands.ts';
import { expenseFrom, toMinor } from '../../runtime/mappers.ts';
import { calendar } from '../../runtime/projection.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/expenseService';
import * as Clean from '@clean/services/expenseService';

async function asExpenseError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new ExpenseError(e instanceof Error ? e.message : String(e));
  }
}

async function createExpenseOnline(params: CreateExpenseParams): Promise<Expense> {
  return asExpenseError(async () => {
    const hoy = (await calendar()).businessDate;
    if (params.fecha && params.fecha !== hoy) {
      throw new Error(`En ADEX Online el gasto se registra con la fecha de hoy de la empresa (${hoy}); no se admiten otras fechas.`);
    }
    if (params.receiptPhotoDataUrl) throw new Error('Las fotos de soporte todavía no se pueden subir en ADEX Online.');
    const body: Record<string, unknown> = { scope: params.scope, categoryId: params.categoryId, amountMinor: toMinor(params.valor) };
    if (params.scope !== 'empresa') body['routeId'] = params.routeId;
    if (params.scope === 'trabajador') body['workerId'] = params.collectorId;
    if (params.descripcion) body['description'] = params.descripcion;
    if (params.referencia) body['reference'] = params.referencia;
    if (params.scope === 'empresa' && params.funding) {
      body['fundingSource'] = params.funding.source;
      if (params.funding.source === 'admin') body['fundingAdminId'] = params.funding.adminId;
    }
    const r = await money<Record<string, unknown>>('POST', '/v1/expenses', body, params.operationId ?? generateId());
    return expenseFrom((r['expense'] as Record<string, unknown>) ?? r);
  });
}

async function reverseAdminExpenseOnline(params: { expenseId: string; reason: string }): Promise<{ original: Expense; reversal: Expense }> {
  return asExpenseError(async () => {
    const r = await money<Record<string, unknown>>('POST', `/v1/expenses/${params.expenseId}/reverse`, { reason: params.reason }, generateId());
    const e = expenseFrom((r['expense'] as Record<string, unknown>) ?? r);
    return { original: e, reversal: e };
  });
}

async function refundAdminExpenseOnline(params: { expenseId: string; amount: number; reason: string; operationId?: string }): Promise<Expense> {
  return asExpenseError(async () => {
    const r = await money<Record<string, unknown>>('POST', `/v1/expenses/${params.expenseId}/refunds`,
      { amountMinor: toMinor(params.amount), reason: params.reason }, params.operationId ?? generateId());
    return expenseFrom((r['refund'] as Record<string, unknown>) ?? r);
  });
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const createExpense = createExpenseOnline as unknown as typeof Clean.createExpense;
export const reverseAdminExpense = reverseAdminExpenseOnline as unknown as typeof Clean.reverseAdminExpense;
export const refundAdminExpense = refundAdminExpenseOnline as unknown as typeof Clean.refundAdminExpense;
