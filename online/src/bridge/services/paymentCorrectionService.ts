// PUENTE de `src/services/paymentCorrectionService.ts` (CLEAN) contra el servidor (0017).
//
//   annulPayment               → POST /v1/collections/:id/reverse       (asiento espejo)
//   correctPayment             → POST /v1/collections/:id/correct       (reversión + reemplazo, UNA transacción)
//   requestPaymentAdjustment   → POST /v1/payment-adjustments           (periodo cerrado: solicitud)
//   approvePaymentAdjustment   → POST /v1/payment-adjustments/:id/approve (corrige y cierra la solicitud)
//   rejectPaymentAdjustment    → POST /v1/payment-adjustments/:id/reject
//   isPaymentInClosedPeriod    → lo dice el servidor en cada pago (`periodClosed`)
//
// Diferencia real del servidor (DS-04): el pago corregido queda con la fecha de HOY de la
// empresa (el servidor no fecha asientos en el pasado); la reversión, con la del original si
// su semana está abierta. Elegir otra fecha para el pago corregido no está disponible.
// Mismas firmas y mismo contrato de respuesta que CLEAN (`{ success, error }`).

import type { Payment, User } from '@clean/models/types';
import { PaymentAnnulmentError, type CorrectionInput } from '@clean/services/paymentCorrectionService';
import { protectingClosureFor } from '@clean/lib/settlementPeriods';
import { db } from '@/lib/db';
import { generateId } from '@/lib/utils';
import { money, plain } from '../../runtime/commands.ts';
import { paymentPeriodClosed, toMinor } from '../../runtime/mappers.ts';
import { table } from '../../runtime/projection.ts';

export * from '@clean/services/paymentCorrectionService';
import * as Clean from '@clean/services/paymentCorrectionService';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fail = (e: unknown) => ({ success: false, error: e instanceof Error ? e.message : String(e) });

function dateGuard(original: Payment | undefined, input: CorrectionInput): string | null {
  if (input.newFecha && original && input.newFecha !== original.fecha) {
    return 'En ADEX Online el pago corregido queda con la fecha de hoy de la empresa: no se puede elegir otra fecha.';
  }
  return null;
}

async function annulPaymentOnline(params: { paymentId: string; reason: string }): Promise<{ original: unknown; reversal: unknown }> {
  try {
    const r = await money<Record<string, unknown>>('POST', `/v1/collections/${params.paymentId}/reverse`, { reason: params.reason }, generateId());
    return { original: r, reversal: r };
  } catch (e) {
    throw new PaymentAnnulmentError(e instanceof Error ? e.message : String(e));
  }
}

async function correctPaymentOnline(_actor: User, paymentId: string, input: CorrectionInput) {
  if (!input.reason?.trim()) return { success: false, error: 'El motivo es obligatorio' };
  if (!(input.newValor > 0)) return { success: false, error: 'El valor corregido debe ser mayor a 0' };
  const original = await db.payments.get(paymentId);
  const guard = dateGuard(original, input);
  if (guard) return { success: false, error: guard };
  try {
    const body: Record<string, unknown> = { newAmountMinor: toMinor(input.newValor), reason: input.reason.trim() };
    if (input.observacion?.trim()) body['note'] = input.observacion.trim();
    const r = await money<Record<string, any>>('POST', `/v1/collections/${paymentId}/correct`, body, generateId());
    return { success: true, reversalId: r['reversalPaymentId'] as string, correctedId: r['correctedPaymentId'] as string };
  } catch (e) {
    if ((e as { code?: string }).code === 'ADJUSTMENT_REQUIRED') {
      return { success: false, error: 'El pago está en un periodo cerrado. Genera una solicitud de ajuste para aprobación.' };
    }
    return fail(e);
  }
}

async function requestPaymentAdjustmentOnline(_actor: User, paymentId: string, input: CorrectionInput) {
  if (!input.reason?.trim()) return { success: false, error: 'El motivo es obligatorio' };
  if (!(input.newValor > 0)) return { success: false, error: 'El valor corregido debe ser mayor a 0' };
  const guard = dateGuard(await db.payments.get(paymentId), input);
  if (guard) return { success: false, error: guard };
  try {
    const body: Record<string, unknown> = { paymentId, newAmountMinor: toMinor(input.newValor), reason: input.reason.trim() };
    if (input.observacion?.trim()) body['note'] = input.observacion.trim();
    const r = await money<Record<string, any>>('POST', '/v1/payment-adjustments', body, generateId());
    return { success: true, requestId: r['id'] as string };
  } catch (e) {
    return fail(e);
  }
}

async function approvePaymentAdjustmentOnline(_actor: User, requestId: string) {
  try {
    await money('POST', `/v1/payment-adjustments/${requestId}/approve`, {}, generateId());
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

async function rejectPaymentAdjustmentOnline(_actor: User, requestId: string, rejectionReason: string) {
  if (!rejectionReason?.trim()) return { success: false, error: 'Indica el motivo del rechazo' };
  try {
    await plain('POST', `/v1/payment-adjustments/${requestId}/reject`, { reason: rejectionReason.trim() });
    return { success: true };
  } catch (e) {
    return fail(e);
  }
}

/** Semana cerrada: el servidor lo indica en cada pago; si no hay dato, la regla original sobre los cierres visibles. */
async function isPaymentInClosedPeriodOnline(payment: Pick<Payment, 'routeId' | 'fecha'> & { id?: string }): Promise<boolean> {
  if (payment.id && paymentPeriodClosed.has(payment.id)) return paymentPeriodClosed.get(payment.id)!;
  const settlements = (await table('weeklySettlements')).filter((w) => w['routeId'] === payment.routeId);
  return protectingClosureFor(settlements as never, payment.routeId, payment.fecha) !== null;
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const annulPayment = annulPaymentOnline as unknown as typeof Clean.annulPayment;
export const correctPayment = correctPaymentOnline as unknown as typeof Clean.correctPayment;
export const requestPaymentAdjustment = requestPaymentAdjustmentOnline as unknown as typeof Clean.requestPaymentAdjustment;
export const approvePaymentAdjustment = approvePaymentAdjustmentOnline as unknown as typeof Clean.approvePaymentAdjustment;
export const rejectPaymentAdjustment = rejectPaymentAdjustmentOnline as unknown as typeof Clean.rejectPaymentAdjustment;
export const isPaymentInClosedPeriod = isPaymentInClosedPeriodOnline as unknown as typeof Clean.isPaymentInClosedPeriod;
