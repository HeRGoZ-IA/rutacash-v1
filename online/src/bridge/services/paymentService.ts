// PUENTE de `src/services/paymentService.ts` (CLEAN): registro de abonos contra la API
// (Fase 5). El servidor aplica el abono a las cuotas, topa al saldo, atribuye el efectivo
// al responsable y asienta el libro en UNA transacción, con id de operación (un
// reintento nunca duplica). La fecha del abono es la de la EMPRESA (no se elige).

import type { User } from '@clean/models/types';
import type { GeoCapture, GeoRecordStatus } from '@clean/lib/geolocation';
import { formatCurrency } from '@/lib/formatters';
import { api } from '../../runtime/session.ts';
import { invalidate } from '../../runtime/projection.ts';
import { toMajor, toMinor } from '../../runtime/mappers.ts';
import { PaymentGuard, type PaymentOutcome, type PendingPayment } from '../../runtime/unconfirmedPayments.ts';
import { errorText } from '../../lib/format.ts';

export * from '@clean/services/paymentService';
import * as Clean from '@clean/services/paymentService';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Ronda 48: lectura de ubicación del dispositivo, tal cual, con su estado. Viaja en el
 * MISMO cuerpo del comando (mismo id de operación): un reintento repite exactamente la
 * misma petición y el servidor devuelve el resultado guardado, sin duplicar el abono ni
 * la ubicación. El servidor la valida y la trata como dato no confiable.
 */
function locationBody(g: GeoCapture | undefined): Record<string, unknown> | undefined {
  if (!g) return undefined;
  const loc: Record<string, unknown> = { status: g.status };
  if (g.status === 'captured') {
    loc['lat'] = g.lat; loc['lng'] = g.lng;
    if (g.accuracyM != null) loc['accuracyM'] = g.accuracyM;
    if (g.capturedAt) loc['capturedAt'] = g.capturedAt;
  } else if (g.reason) {
    loc['reason'] = g.reason.slice(0, 200);
  }
  return loc;
}

/**
 * Ronda 48.1: cada abono es UNA operación con UN id, guardado antes de enviar. Si la
 * respuesta se pierde, se comprueba ese mismo id; nunca se crea otro abono por un
 * reintento, un doble toque o una recarga (ver runtime/unconfirmedPayments.ts).
 */
let guard: PaymentGuard | null = null;
const payments = () => (guard ??= new PaymentGuard(api()));

function success(r: Record<string, any>, recovered: boolean): Clean.RegisterPaymentSuccess {
  const inst = (r['installments'] ?? []) as { number: number; status: string }[];
  const pending = inst.find((i) => i.status !== 'pagada');
  const paid = inst.filter((i) => i.status === 'pagada').map((i) => i.number);
  return {
    ok: true, paymentId: r['paymentId'], collectorId: r['payment']?.collectorId ?? r['collectorId'] ?? '', collectorSource: 'server' as any,
    requestedAmount: toMajor(r['requestedMinor']), appliedAmount: toMajor(r['appliedMinor']), capped: r['capped'] === true,
    cappedAmount: toMajor(r['cappedMinor'] ?? 0), previousBalance: toMajor(r['previousBalanceMinor']), newBalance: toMajor(r['newBalanceMinor']),
    saleStatus: r['credit']?.status, paidInstallmentNumber: null, currentInstallmentNumber: pending?.number ?? null,
    lastPaidInstallmentNumber: paid.length ? Math.max(...paid) : 0, installmentsCompleted: [], audited: true,
    locationStatus: (r['location'] as { status?: GeoRecordStatus } | undefined)?.status,
    recovered,
  };
}

function view(p: PendingPayment): Clean.UnconfirmedPayment {
  return { saleId: p.saleId, requestedAmount: toMajor(Number(p.body['amountMinor'])), startedAt: p.startedAt };
}

const amountOf = (p: PendingPayment) => formatCurrency(toMajor(Number(p.body['amountMinor'])));
const UNCONFIRMED_TEXT = 'No se pudo confirmar con el servidor si el abono quedó registrado. No le vuelva a cobrar al cliente: compruébelo primero. Comprobarlo nunca crea otro abono.';

function toResult(o: PaymentOutcome): Clean.RegisterPaymentResult {
  switch (o.kind) {
    case 'confirmed': return success(o.result, o.recovered);
    case 'uncertain': return { ok: false, code: 'PAYMENT_UNCONFIRMED', message: UNCONFIRMED_TEXT, unconfirmed: view(o.pending) };
    case 'previous_confirmed':
      return { ok: false, code: 'PREVIOUS_PAYMENT_CONFIRMED', message: `El abono anterior de ${amountOf(o.pending)} sí quedó registrado. Revise el saldo actualizado antes de registrar otro.` };
    case 'previous_rejected':
      return { ok: false, code: 'PREVIOUS_PAYMENT_NOT_REGISTERED', message: `El abono anterior de ${amountOf(o.pending)} no quedó registrado: ${errorText(o.error)} Revise el valor y regístrelo de nuevo.` };
    case 'too_many_pending':
      return { ok: false, code: 'TOO_MANY_UNCONFIRMED', message: `Hay ${o.count} abonos sin confirmar en este dispositivo. Compruébelos (abra cada cobro pendiente) antes de registrar otro.` };
    case 'rejected':
      return { ok: false, code: ((o.error as { code?: string })?.code ?? 'ERROR') as Clean.PaymentRejectionCode,
        message: o.previous ? `El abono anterior no quedó registrado: ${errorText(o.error)} Puede registrarlo de nuevo.` : errorText(o.error) };
  }
}

async function registerPaymentOnline(input: { saleId: string; requestedAmount: number; actor: User | null | undefined; collectorId?: string; observacion?: string; location?: GeoCapture }): Promise<Clean.RegisterPaymentResult> {
  const body: Record<string, unknown> = { saleId: input.saleId, amountMinor: toMinor(input.requestedAmount) };
  if (input.collectorId) body['collectorId'] = input.collectorId;
  if (input.observacion) body['note'] = input.observacion;
  const location = locationBody(input.location);
  if (location) body['location'] = location;
  const outcome = await payments().register(input.saleId, body);
  // Tras una respuesta definitiva, todas las pantallas releen del servidor (saldo real).
  if (outcome.kind !== 'uncertain') invalidate();
  return toResult(outcome);
}

function getUnconfirmedPaymentOnline(saleId: string): Clean.UnconfirmedPayment | null {
  const p = payments().pendingFor(saleId);
  return p ? view(p) : null;
}

async function checkUnconfirmedPaymentOnline(saleId: string): Promise<Clean.UnconfirmedPaymentCheck> {
  const o = await payments().check(saleId);
  if (!o) return { status: 'none' };
  if (o.kind !== 'uncertain') invalidate();
  if (o.kind === 'confirmed') return { status: 'confirmed', result: success(o.result, true) };
  if (o.kind === 'uncertain') return { status: 'unconfirmed', payment: view(o.pending), message: 'Todavía no hay respuesta del servidor. Revise la conexión y vuelva a comprobar en un momento.' };
  return { status: 'not_registered', message: `El abono anterior no quedó registrado: ${errorText((o as { error: unknown }).error)} Puede registrarlo de nuevo.` };
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const registerPayment = registerPaymentOnline as unknown as typeof Clean.registerPayment;
export const getUnconfirmedPayment: typeof Clean.getUnconfirmedPayment = getUnconfirmedPaymentOnline;
export const checkUnconfirmedPayment: typeof Clean.checkUnconfirmedPayment = checkUnconfirmedPaymentOnline;
