// RONDA 73 · SOC-07: lo que ADEX Online envía al aprobar una solicitud. El incidente real: el
// Secretario eligió 10 % pero el puente solo enviaba `notes` y el servidor aprobó al 20 %.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { approvalBody, approvedMismatch } from '../../../online/src/runtime/approvalBody.ts';

describe('Ronda 73 · cuerpo de la aprobación (ADEX Online)', () => {
  test('R73-UNIT-001 · las condiciones elegidas por el Secretario viajan completas (antes: solo notes)', () => {
    const body = approvalBody({ interestRate: 10, frequency: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6], phoneConfirmed: true, phoneConfirmationNote: ' ok ', notes: '' });
    assert.deepEqual(body, { interestRate: 10, frequency: 'diaria', paymentDays: [1, 2, 3, 4, 5, 6], phoneConfirmed: true, phoneConfirmationNote: 'ok' });
  });

  test('R73-UNIT-002 · sin elección (pantalla del Administrador) no se inventa nada; una confirmación en false no se envía', () => {
    assert.deepEqual(approvalBody(undefined), {});
    assert.deepEqual(approvalBody({ phoneConfirmed: false }), {});
    assert.deepEqual(approvalBody({ installmentsCount: 20 }), { installmentsCount: 20 });
  });

  test('R73-UNIT-003 · si el servidor guardó otra cosa, se detecta (nunca se informa éxito con condiciones distintas)', () => {
    const body = approvalBody({ interestRate: 10, paymentDays: [6, 1], installmentsCount: 20 });
    assert.deepEqual(approvedMismatch(body, { interestRate: 10, paymentDays: [1, 6], installmentsCount: 20 }), []);
    assert.deepEqual(approvedMismatch(body, { interestRate: 20, paymentDays: [1, 6], installmentsCount: 12 }), ['interestRate', 'installmentsCount']);
    assert.deepEqual(approvedMismatch(body, { interestRate: 10, installmentsCount: 20 }), ['paymentDays']);
  });
});
