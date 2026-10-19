// PUENTE de `src/services/saleRequestService.ts` (CLEAN): solicitudes, autorización y
// venta directa contra la API (Fase 4). Las consultas y conteos originales se conservan
// (leen la proyección). Diferencias reales del servidor, sin disimularlas:
//   · Aprobar NO crea todavía el crédito: queda la solicitud aprobada y el crédito nace al
//     desembolsar (comando de dinero del Cobrador o del responsable). Para el negocio es
//     el mismo estado que en CLEAN: «pendiente de desembolso por el cobrador».
//   · Castigar (marcar perdido) un crédito desembolsado no existe todavía en el servidor.
// Los errores se lanzan como `SaleRuleError` para que las pantallas originales muestren
// el motivo exacto (solo muestran el texto de ese tipo de error).

import type { Sale, SaleRequest, User } from '@clean/models/types';
import { SaleRuleError } from '@clean/services/saleRequestService';
import { money, plain } from '../../runtime/commands.ts';
import { saleFrom, toMinor } from '../../runtime/mappers.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/saleRequestService';
import * as Clean from '@clean/services/saleRequestService';

async function asSaleError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new SaleRuleError(e instanceof Error ? e.message : String(e));
  }
}

const idOf = (r: SaleRequest | string) => (typeof r === 'string' ? r : r.id);

async function approveSaleRequestOnline(requestOrId: SaleRequest | string, _actor: User, overrides?: { notes?: string }): Promise<Sale> {
  return asSaleError(async () => {
    const body: Record<string, unknown> = {};
    if (overrides?.notes) body['notes'] = overrides.notes;
    await plain('POST', `/v1/credit-requests/${idOf(requestOrId)}/approve`, body);
    // El crédito aún no existe en el servidor; las pantallas solo esperan la promesa.
    return undefined as unknown as Sale;
  });
}

async function rejectSaleRequestOnline(requestOrId: SaleRequest | string, _actor: User, reason: string): Promise<void> {
  await asSaleError(() => plain('POST', `/v1/credit-requests/${idOf(requestOrId)}/reject`, { reason }));
}

async function createDirectSaleOnline(
  input: { routeId: string; clientId: string; valorVenta: number; tasaInteres: number; numeroCuotas: number; frecuenciaPago: string; fechaInicio: string; paymentDays?: number[] },
  _actor: User,
  opts: { newClient?: unknown } = {},
): Promise<Sale> {
  return asSaleError(async () => {
    if (opts.newClient) throw new Error('En ADEX Online el cliente se da de alta antes de la venta.');
    const r = await money<Record<string, unknown>>('POST', '/v1/credits/direct', {
      routeId: input.routeId, clientId: input.clientId, amountMinor: toMinor(input.valorVenta), interestRate: input.tasaInteres,
      installmentsCount: input.numeroCuotas, frequency: input.frecuenciaPago, startDate: input.fechaInicio, paymentDays: input.paymentDays ?? [],
    }, generateId());
    return saleFrom((r['credit'] as Record<string, unknown>) ?? r);
  });
}

async function markSaleLostOnline(): Promise<void> {
  throw new SaleRuleError('Marcar un crédito como perdido (castigo) todavía no está disponible en el servidor de ADEX Online.');
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const approveSaleRequest = approveSaleRequestOnline as unknown as typeof Clean.approveSaleRequest;
export const rejectSaleRequest = rejectSaleRequestOnline as unknown as typeof Clean.rejectSaleRequest;
export const createDirectSale = createDirectSaleOnline as unknown as typeof Clean.createDirectSale;
export const markSaleLost = markSaleLostOnline as unknown as typeof Clean.markSaleLost;
