// PUENTE de `src/services/movementReversalService.ts` (CLEAN): anulación con asiento espejo.
//
// En el servidor TODA anulación de capital es `POST /v1/capital/operations/:id/reverse`
// (nunca se borra ni se reescribe el original). Como los registros de capital que muestran
// las pantallas son vistas de operaciones del servidor, su id ES el de la operación:
//   · capital centralizado (entrega, préstamo o gasto pagado con la bolsa) → esa operación;
//   · retiro centralizado (devolución de un trabajador) → esa operación;
//   · transferencia entre rutas (reasignación) → esa operación.
// El servidor decide si procede: un desembolso, un cobro, un gasto o un cuadre no se anulan
// por aquí (tienen su propio comando) y una entrega solo si el trabajador conserva el dinero.
// Las reglas de qué botón se ofrece (`canReverse*`) son las originales de CLEAN.

import { MovementReversalError } from '@clean/services/movementReversalService';
import * as Clean from '@clean/services/movementReversalService';
import { money } from '../../runtime/commands.ts';
import { capitalRecords } from '../../runtime/projection.ts';

export * from '@clean/services/movementReversalService';

async function reverse(id: string, reason: string): Promise<string> {
  const motivo = (reason ?? '').trim();
  if (motivo.length < 3) throw new MovementReversalError('Indica el motivo de la anulación (mínimo 3 caracteres).');
  try {
    return (await money<{ operation: { id: string } }>('POST', `/v1/capital/operations/${id}/reverse`, { reason: motivo })).operation.id;
  } catch (e) {
    throw new MovementReversalError(e instanceof Error ? e.message : String(e));
  }
}

async function reverseCapitalMovementOnline(p: { movementId: string; reason: string }) {
  const id = await reverse(p.movementId, p.reason);
  const recs = await capitalRecords();
  return { original: recs.capitalMovements.find((m) => m.id === p.movementId)!, reversal: recs.capitalMovements.find((m) => m.id === id)! };
}

async function reverseWithdrawalOnline(p: { movementId: string; reason: string }) {
  const id = await reverse(p.movementId, p.reason);
  const recs = await capitalRecords();
  return { original: recs.withdrawals.find((m) => m.id === p.movementId)!, reversal: recs.withdrawals.find((m) => m.id === id)! };
}

async function reverseTransferOnline(p: { movementId: string; reason: string }) {
  const id = await reverse(p.movementId, p.reason);
  const recs = await capitalRecords();
  return {
    original: recs.transfers.find((t) => t.id === p.movementId)!, reversal: recs.transfers.find((t) => t.id === id)!,
    partnerReversals: [], custodyReversals: recs.cashCustodyMovements.filter((c) => c.relatedTransferId === id),
  };
}

export const reverseCapitalMovement = reverseCapitalMovementOnline as unknown as typeof Clean.reverseCapitalMovement;
export const reverseWithdrawal = reverseWithdrawalOnline as unknown as typeof Clean.reverseWithdrawal;
export const reverseTransfer = reverseTransferOnline as unknown as typeof Clean.reverseTransfer;
