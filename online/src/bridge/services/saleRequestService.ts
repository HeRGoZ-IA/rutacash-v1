// PUENTE de `src/services/saleRequestService.ts` (CLEAN): solicitudes, autorización y
// venta directa contra la API (Fase 4). Las consultas y conteos originales se conservan
// (leen la proyección). Diferencias reales del servidor, sin disimularlas:
//   · Aprobar NO crea todavía el crédito: queda la solicitud aprobada y el crédito nace al
//     desembolsar (comando de dinero del Cobrador o del responsable). Para el negocio es
//     el mismo estado que en CLEAN: «pendiente de desembolso por el cobrador».
//   · Castigar (marcar perdido) un crédito desembolsado no existe todavía en el servidor.
//   · Alta de cliente + venta/solicitud en el mismo formulario: el servidor da de alta el
//     cliente (comando idempotente) y DESPUÉS registra la venta o la solicitud. Son dos
//     transacciones: si la segunda falla, el cliente queda registrado y se dice así.
// Los errores se lanzan como `SaleRuleError` para que las pantallas originales muestren
// el motivo exacto (solo muestran el texto de ese tipo de error).
//
// Ronda 65-C1 · COBRADOR SIN CONEXIÓN (offline/sales.ts): NO registra clientes ni ventas (llama a la
// oficina; aquí se vuelve a comprobar aunque la pantalla ya lo impida) y nada se deja en cola. El
// desembolso de una solicitud aprobada que el dispositivo conoce va por `disburseAsCollector`.
//
// Ronda 67 · GPS AL VENDER EN LÍNEA: la venta directa y la solicitud llevan la lectura del dispositivo
// de quien registra (`location`), pedida UNA vez antes de escribir nada. Sin permiso o sin GPS la venta
// sigue igual y viaja la causa. Es evidencia de dónde estaba quien registró, NUNCA la ubicación del cliente.

import type { Client, Sale, SaleRequest, User } from '@clean/models/types';
import { SaleRuleError, type SaleInputs } from '@clean/services/saleRequestService';
import { money, plain } from '../../runtime/commands.ts';
import { saleFrom, saleRequestFrom, toMinor } from '../../runtime/mappers.ts';
import { clientId, createClientOnline } from '../../runtime/writeAdapters.ts';
import { generateId } from '@/lib/utils';
import { useRuntime } from '../../runtime/session.ts';
import { useOffline } from '../../offline/state.ts';
import { OFFLINE_BLOCK_TEXT, OFFLINE_BLOCK_TITLE, disburseAsCollector, newClientsAndSalesBlocked } from '../../offline/sales.ts';
import { saleDeviceLocation } from '../../runtime/deviceLocation.ts';
import { approvalBody, approvedMismatch, type ApprovalChoice } from '../../runtime/approvalBody.ts';

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

/**
 * Ronda 73 · SOC-07: viajan TODAS las condiciones elegidas por el autorizador (antes solo `notes`:
 * el servidor aprobaba con lo solicitado). SOC-04: también el número de parcelas. Si el servidor
 * no guardó exactamente lo elegido, no se informa éxito.
 */
async function approveSaleRequestOnline(requestOrId: SaleRequest | string, _actor: User, overrides?: ApprovalChoice): Promise<Sale> {
  return asSaleError(async () => {
    const body = approvalBody(overrides);
    const saved = await plain<Record<string, unknown>>('POST', `/v1/credit-requests/${idOf(requestOrId)}/approve`, body);
    const wrong = approvedMismatch(body, saved);
    if (wrong.length) {
      throw new Error(`El servidor no registró las condiciones elegidas (${wrong.join(', ')}). Revise la solicitud antes de desembolsar.`);
    }
    // El crédito aún no existe en el servidor; las pantallas solo esperan la promesa.
    return undefined as unknown as Sale;
  });
}

async function rejectSaleRequestOnline(requestOrId: SaleRequest | string, _actor: User, reason: string): Promise<void> {
  await asSaleError(() => plain('POST', `/v1/credit-requests/${idOf(requestOrId)}/reject`, { reason }));
}

type Conditions = Pick<SaleInputs, 'routeId' | 'clientId' | 'valorVenta' | 'tasaInteres' | 'numeroCuotas' | 'frecuenciaPago' | 'fechaInicio'> & { paymentDays?: number[] };

const conditions = (input: Conditions, client: string) => ({
  routeId: input.routeId, clientId: client, amountMinor: toMinor(input.valorVenta), interestRate: input.tasaInteres,
  installmentsCount: input.numeroCuotas, frequency: input.frecuenciaPago, startDate: input.fechaInicio, paymentDays: input.paymentDays ?? [],
});

/** Cliente nuevo del mismo formulario: se da de alta primero y se devuelve su id del servidor. */
async function clientFor(input: Conditions, newClient?: Client): Promise<string> {
  if (!newClient) return clientId(input.clientId);
  return createClientOnline(newClient as unknown as Record<string, unknown>);
}

/** El segundo paso falló con el cliente ya creado: se dice exactamente qué quedó guardado. */
function afterClient(e: unknown, created: boolean, what: string): never {
  const msg = e instanceof Error ? e.message : String(e);
  throw new Error(created ? `El cliente quedó registrado, pero ${what} no: ${msg} Puede intentarlo de nuevo desde Nueva venta.` : msg);
}

async function createDirectSaleOnline(input: Conditions, _actor: User, opts: { newClient?: Client } = {}): Promise<Sale> {
  return asSaleError(async () => {
    refuseWithoutServer();
    const location = await saleDeviceLocation();
    const client = await clientFor(input, opts.newClient);
    try {
      const r = await money<Record<string, unknown>>('POST', '/v1/credits/direct', { ...conditions(input, client), location }, generateId());
      return saleFrom((r['credit'] as Record<string, unknown>) ?? r);
    } catch (e) {
      return afterClient(e, Boolean(opts.newClient), 'la venta');
    }
  });
}

const collectorOffline = () => useRuntime.getState().ctx?.role === 'cobrador' && useOffline.getState().enabled;

/** 65-C1: sin servidor al alcance, el Cobrador no registra clientes ni ventas. */
function refuseWithoutServer(): void {
  if (newClientsAndSalesBlocked()) throw new SaleRuleError(`${OFFLINE_BLOCK_TITLE}. ${OFFLINE_BLOCK_TEXT}`);
}

async function createSaleRequestOnline(input: Conditions, _actor: User, opts: { newClient?: Client } = {}): Promise<SaleRequest> {
  return asSaleError(async () => {
    refuseWithoutServer();
    const location = await saleDeviceLocation();
    const client = await clientFor(input, opts.newClient);
    try {
      const r = await money<Record<string, unknown>>('POST', '/v1/credit-requests', { ...conditions(input, client), location }, generateId());
      return saleRequestFrom((r['request'] as Record<string, unknown>) ?? r);
    } catch (e) {
      return afterClient(e, Boolean(opts.newClient), 'la solicitud');
    }
  });
}

/**
 * Confirmar el desembolso de una venta «pendiente de desembolso». En el servidor es la
 * solicitud aprobada (`pendingSaleFrom`: el id de la venta pendiente ES el de la
 * solicitud): el crédito nace aquí, sale de la custodia de quien entrega o de la bolsa
 * del responsable, con id de operación (un doble toque no desembolsa dos veces).
 */
async function confirmDisbursementOnline(saleId: string, _actor: User): Promise<void> {
  // Ronda 65: el Cobrador entrega con SU efectivo, también sin conexión (efectivo disponible del dispositivo).
  if (collectorOffline()) {
    await asSaleError(() => disburseAsCollector(saleId));
    return;
  }
  await asSaleError(() => money('POST', `/v1/credit-requests/${saleId}/disburse`, {}, generateId()));
}

async function markSaleLostOnline(): Promise<void> {
  throw new SaleRuleError('Marcar un crédito como perdido (castigo) todavía no está disponible en el servidor de ADEX Online.');
}

/** Ronda 73 · SOC-09: rectificación de una venta desembolsada (Administrador, `POST /v1/credits/:id/rectify`). */
async function rectifyDisbursedSaleOnline(saleId: string, _actor: User, input: Clean.RectifySaleInput): Promise<void> {
  await asSaleError(() => money('POST', `/v1/credits/${encodeURIComponent(saleId)}/rectify`, {
    amountMinor: toMinor(input.valorVenta), interestRate: input.tasaInteres, installmentsCount: input.numeroCuotas, frequency: input.frecuenciaPago,
    startDate: input.fechaInicio, paymentDays: input.paymentDays, expectedRectifications: input.rectificacionesVistas,
    reason: input.motivo.trim(), evidence: input.evidencia.trim(), offlineChecked: input.sinCapturasPendientes === true,
  }, input.operationId));
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const approveSaleRequest = approveSaleRequestOnline as unknown as typeof Clean.approveSaleRequest;
export const rejectSaleRequest = rejectSaleRequestOnline as unknown as typeof Clean.rejectSaleRequest;
export const createDirectSale = createDirectSaleOnline as unknown as typeof Clean.createDirectSale;
export const markSaleLost = markSaleLostOnline as unknown as typeof Clean.markSaleLost;
export const createSaleRequest = createSaleRequestOnline as unknown as typeof Clean.createSaleRequest;
export const confirmDisbursement = confirmDisbursementOnline as unknown as typeof Clean.confirmDisbursement;
export const rectifyDisbursedSale = rectifyDisbursedSaleOnline as unknown as typeof Clean.rectifyDisbursedSale;
