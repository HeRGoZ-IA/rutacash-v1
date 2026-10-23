// RONDA 73 · D73-04: capturas sin conexión de una sesión desplazada. Nada se borra ni se envía solo:
// lo que iba a enviarse queda «Requiere revisión» con el motivo, y solo «Reintentar» lo devuelve a la cola
// (mismo id → idempotente; el servidor aplica sus validaciones vigentes).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SESSION_ENDED, awaitingSend, holdForSessionReview } from '../../../online/src/offline/sessionReview.ts';

type Op = { id: string; status: 'local' | 'sending' | 'confirmed' | 'review' | 'rejected'; error?: { code: string; message: string; at: string }; reviewedAt?: string };

describe('Ronda 73 · D73-04 · retención para revisión tras una sesión desplazada', () => {
  const ops: Op[] = [
    { id: 'a', status: 'local' },
    { id: 'b', status: 'sending' },
    { id: 'c', status: 'confirmed' },
    { id: 'd', status: 'review', error: { code: 'DEPENDENCY_HELD', message: '', at: '' } },
    { id: 'e', status: 'review', error: { code: 'PERIOD_CLOSED', message: '', at: '' } },
    { id: 'f', status: 'rejected', error: { code: 'INVALID_INPUT', message: '', at: '' } },
    { id: 'g', status: 'review', error: { code: 'DEPENDENCY_HELD', message: '', at: '' }, reviewedAt: '2026-10-22' },
  ];

  test('R73-UNIT-OFF-001 · pendientes, enviadas sin respuesta y retenidas por dependencia pasan a revisión con el motivo', () => {
    const held = holdForSessionReview(ops, '2026-10-22T10:00:00Z');
    assert.deepEqual(held.map((o) => o.id), ['a', 'b', 'd']);
    assert.ok(held.every((o) => o.status === 'review' && o.error?.code === SESSION_ENDED));
  });

  test('R73-UNIT-OFF-002 · nada se pierde: confirmadas, rechazadas y revisiones de otra causa no cambian; los ids se conservan', () => {
    const held = holdForSessionReview(ops, 'x');
    assert.equal(held.length, 3);
    assert.ok(!awaitingSend(ops[2]!) && !awaitingSend(ops[4]!) && !awaitingSend(ops[5]!) && !awaitingSend(ops[6]!));
    assert.deepEqual(ops.map((o) => o.status), ['local', 'sending', 'confirmed', 'review', 'review', 'rejected', 'review'], 'la entrada no se modifica');
  });

  test('R73-UNIT-OFF-003 · una operación retenida ya no se considera para envío automático', () => {
    for (const o of holdForSessionReview(ops, 'x')) assert.equal(awaitingSend(o), false);
  });
});
