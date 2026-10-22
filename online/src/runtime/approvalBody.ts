// Ronda 73 · SOC-07 / SOC-04: cuerpo de `POST /v1/credit-requests/:id/approve` a partir de las
// condiciones que el autorizador fijó en la pantalla de CLEAN (`ApprovalOverrides`).
//
// Causa del incidente SOC-07: el puente enviaba SOLO `notes`; la tasa, la frecuencia, los días y la
// confirmación telefónica elegidos por el Secretario nunca llegaban al servidor, que aprobaba (y
// después desembolsaba) con las condiciones solicitadas (20 %). Aquí viaja TODO lo elegido, y
// `approvedMismatch` comprueba que el servidor guardó exactamente eso antes de dar el éxito.
//
// Sin dependencias: lo prueban las pruebas de unidad de `saas/` (test/unit/r73-approval-body.test.ts).

export interface ApprovalChoice {
  notes?: string;
  interestRate?: number;
  frequency?: string;
  paymentDays?: number[];
  installmentsCount?: number;
  phoneConfirmed?: boolean;
  phoneConfirmationNote?: string;
}

export function approvalBody(choice: ApprovalChoice | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!choice) return body;
  if (choice.notes?.trim()) body['notes'] = choice.notes.trim();
  if (choice.interestRate !== undefined) body['interestRate'] = choice.interestRate;
  if (choice.frequency !== undefined) body['frequency'] = choice.frequency;
  if (choice.paymentDays !== undefined) body['paymentDays'] = [...choice.paymentDays];
  if (choice.installmentsCount !== undefined) body['installmentsCount'] = choice.installmentsCount;
  // Solo se registra una confirmación NUEVA (quien no tiene esa capacidad nunca la envía en true).
  if (choice.phoneConfirmed === true) body['phoneConfirmed'] = true;
  if (choice.phoneConfirmationNote?.trim()) body['phoneConfirmationNote'] = choice.phoneConfirmationNote.trim();
  return body;
}

/**
 * Condiciones que el servidor NO guardó como se pidieron (lista vacía = coincide). Una aprobación
 * cuya respuesta difiere de lo elegido no se presenta como éxito.
 */
export function approvedMismatch(body: Record<string, unknown>, saved: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['interestRate', 'frequency', 'installmentsCount'] as const) {
    if (k in body && saved[k] !== body[k]) out.push(k);
  }
  if ('paymentDays' in body) {
    const a = [...(body['paymentDays'] as number[])].sort((x, y) => x - y);
    const b = Array.isArray(saved['paymentDays']) ? [...(saved['paymentDays'] as number[])].sort((x, y) => x - y) : null;
    if (!b || JSON.stringify(a) !== JSON.stringify(b)) out.push('paymentDays');
  }
  return out;
}
