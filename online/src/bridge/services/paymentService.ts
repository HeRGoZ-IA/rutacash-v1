// PUENTE de `src/services/paymentService.ts` (CLEAN): registro de abonos contra la API
// (Fase 5). El servidor aplica el abono a las cuotas, topa al saldo, atribuye el efectivo
// al responsable y asienta el libro en UNA transacción, con id de operación (un
// reintento nunca duplica). La fecha del abono es la de la EMPRESA (no se elige).

import type { User } from '@clean/models/types';
import { money } from '../../runtime/commands.ts';
import { toMajor, toMinor } from '../../runtime/mappers.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/paymentService';
import * as Clean from '@clean/services/paymentService';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function registerPaymentOnline(input: { saleId: string; requestedAmount: number; actor: User | null | undefined; collectorId?: string; observacion?: string }): Promise<any> {
  try {
    const body: Record<string, unknown> = { saleId: input.saleId, amountMinor: toMinor(input.requestedAmount) };
    if (input.collectorId) body['collectorId'] = input.collectorId;
    if (input.observacion) body['note'] = input.observacion;
    const r = await money<Record<string, any>>('POST', '/v1/collections', body, generateId());
    const inst = (r['installments'] ?? []) as { number: number; status: string }[];
    const pending = inst.find((i) => i.status !== 'pagada');
    const paid = inst.filter((i) => i.status === 'pagada').map((i) => i.number);
    return {
      ok: true, paymentId: r['paymentId'], collectorId: r['payment']?.collectorId ?? input.collectorId ?? '', collectorSource: 'server',
      requestedAmount: toMajor(r['requestedMinor']), appliedAmount: toMajor(r['appliedMinor']), capped: r['capped'] === true,
      cappedAmount: toMajor(r['cappedMinor'] ?? 0), previousBalance: toMajor(r['previousBalanceMinor']), newBalance: toMajor(r['newBalanceMinor']),
      saleStatus: r['credit']?.status, paidInstallmentNumber: null, currentInstallmentNumber: pending?.number ?? null,
      lastPaidInstallmentNumber: paid.length ? Math.max(...paid) : 0, installmentsCompleted: [], audited: true,
    };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const registerPayment = registerPaymentOnline as unknown as typeof Clean.registerPayment;
