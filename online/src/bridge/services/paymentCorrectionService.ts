// PUENTE de `src/services/paymentCorrectionService.ts` (CLEAN): la ANULACIÓN de un abono
// va a la API (asiento espejo, nunca borrado; periodo cerrado y autoridad validados en el
// servidor). Las solicitudes de ajuste de pago no existen todavía en el servidor: sus
// lecturas fallan como dato pendiente y la pantalla Ajustes de pago está marcada.

import { PaymentAnnulmentError } from '@clean/services/paymentCorrectionService';
import { money } from '../../runtime/commands.ts';
import { generateId } from '@/lib/utils';

export * from '@clean/services/paymentCorrectionService';
import * as Clean from '@clean/services/paymentCorrectionService';

async function annulPaymentOnline(params: { paymentId: string; reason: string }): Promise<{ original: unknown; reversal: unknown }> {
  try {
    const r = await money<Record<string, unknown>>('POST', `/v1/collections/${params.paymentId}/reverse`, { reason: params.reason }, generateId());
    return { original: r, reversal: r };
  } catch (e) {
    throw new PaymentAnnulmentError(e instanceof Error ? e.message : String(e));
  }
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const annulPayment = annulPaymentOnline as unknown as typeof Clean.annulPayment;
