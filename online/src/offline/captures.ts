// CAPTURAS SIN CONEXIÓN del Cobrador: visitas sin pago y gastos propios (Ronda 62).
// (El abono vive en el puente de paymentService: comparte allí la forma de la ubicación.)
//
// Cada captura es UNA operación con UN id para siempre y el cuerpo EXACTO que llegará al servidor
// por el mismo comando que en línea. Se guarda cifrada en el dispositivo antes de responder.

import { toMinor } from '../runtime/mappers.ts';
import { capture, type PendingOp } from './state.ts';
import { syncNow } from './sync.ts';

export interface VisitInput {
  saleId: string; routeId: string; clientId: string; clientName: string;
  reason: string; promisedPaymentDate?: string; note?: string;
}

/** Cuerpo del comando de visita (igual que en línea; `offline` solo si se capturó sin conexión). */
export function visitBody(v: VisitInput, offlineAt?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { saleId: v.saleId, reason: v.reason };
  if (v.promisedPaymentDate) body['promisedPaymentDate'] = v.promisedPaymentDate;
  if (v.note?.trim()) body['note'] = v.note.trim();
  if (offlineAt) body['offline'] = { capturedAt: offlineAt };
  return body;
}

const REASONS: Record<string, string> = {
  no_estaba: 'No estaba', sin_dinero: 'Sin dinero', negocio_cerrado: 'Negocio cerrado', promesa_pago: 'Promesa de pago', otro: 'Otro',
};
export const reasonLabel = (r?: string) => (r ? REASONS[r] ?? r : '');

/** Visita sin pago capturada sin conexión (no mueve dinero, no toca saldos). */
export async function captureOfflineVisit(v: VisitInput, capturedAt = new Date().toISOString()): Promise<PendingOp> {
  const op = await capture({
    id: crypto.randomUUID(), kind: 'visit', path: '/v1/no-payment-visits', body: visitBody(v, capturedAt), capturedAt, routeId: v.routeId,
    ref: { saleId: v.saleId, clientId: v.clientId, clientName: v.clientName, reason: v.reason, label: reasonLabel(v.reason) },
  });
  void syncNow();
  return op;
}

/**
 * Visita enviada EN LÍNEA sin respuesta: pasa a la cola con su MISMO id y su MISMO cuerpo; el
 * servidor la confirmará una sola vez (o dirá que ya la tenía).
 */
export async function adoptUncertainVisit(id: string, v: VisitInput, body: Record<string, unknown>, capturedAt: string): Promise<PendingOp> {
  const op = await capture({
    id, kind: 'visit', path: '/v1/no-payment-visits', body, capturedAt, routeId: v.routeId, origin: 'uncertain', status: 'sending',
    ref: { saleId: v.saleId, clientId: v.clientId, clientName: v.clientName, reason: v.reason, label: reasonLabel(v.reason) },
  });
  void syncNow();
  return op;
}

export interface ExpenseInput {
  routeId: string; workerId: string; categoryId: string; categoryName: string; amount: number; description?: string;
}

/** Gasto PROPIO del Cobrador capturado sin conexión (lo paga su custodia; puede dejarla negativa). */
export async function captureOfflineExpense(e: ExpenseInput, capturedAt = new Date().toISOString()): Promise<PendingOp> {
  const body: Record<string, unknown> = { scope: 'trabajador', routeId: e.routeId, workerId: e.workerId, categoryId: e.categoryId, amountMinor: toMinor(e.amount) };
  if (e.description?.trim()) body['description'] = e.description.trim();
  body['offline'] = { capturedAt };
  const op = await capture({
    id: crypto.randomUUID(), kind: 'expense', path: '/v1/expenses', body, capturedAt, routeId: e.routeId,
    ref: { amountMinor: toMinor(e.amount), label: e.categoryName },
  });
  void syncNow();
  return op;
}
