// PUENTE de `src/services/cashCustodyService.ts` (CLEAN): efectivo en manos de cada
// trabajador (custodia) contra el libro central del servidor.
//
//   transferBaseBetweenWorkers → POST /v1/capital/worker-transfers (PERSON_TO_PERSON)
//   assignBaseToWorker         → POST /v1/capital/deliveries (con capital centralizado,
//   returnBaseFromWorker       → POST /v1/capital/returns     el único modelo del SaaS)
//   getTransferableCash        → disponible de su custodia según el servidor
//                                (`GET /v1/settlements/workers`: posición − arrastre)
//
// `listCustodyMovements` y `custodianBlockedReason` son los originales: leen la vista de
// custodia del libro central (`capitalRecords.ts`) y las personas de la proyección.

import type { User } from '@clean/models/types';
import { CashCustodyError } from '@clean/services/cashCustodyService';
import { generateId } from '@/lib/utils';
import { money } from '../../runtime/commands.ts';
import { toMajor, toMinor } from '../../runtime/mappers.ts';
import { settleableWorkers } from '../../runtime/projection.ts';
import { deliverCapitalToWorker, returnCapitalFromWorker } from '@/services/centralCapitalService';

export * from '@clean/services/cashCustodyService';
import * as Clean from '@clean/services/cashCustodyService';

interface CustodyParams { actor: User | null | undefined; tenantId: string; routeId: string; amount: number; motivo?: string; operationId?: string }

function motivoValido(m: string | undefined): string {
  const v = (m ?? '').trim();
  if (v.length < 3) throw new CashCustodyError('Indica el motivo del movimiento.');
  return v;
}

async function asCustodyError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof CashCustodyError ? e : new CashCustodyError(e instanceof Error ? e.message : String(e));
  }
}

async function getTransferableCashOnline(params: { tenantId: string; routeId: string; userId: string }): Promise<number> {
  const list = await settleableWorkers(params.routeId);
  return toMajor(list.workers.find((w) => w.workerId === params.userId)?.availableMinor ?? 0);
}

async function transferOnline(params: CustodyParams & { fromUserId: string; toUserId: string }) {
  return asCustodyError(async () => {
    if (params.fromUserId === params.toUserId) throw new CashCustodyError('Quien entrega y quien recibe deben ser personas distintas.');
    const r = await money<Record<string, unknown>>('POST', '/v1/capital/worker-transfers', {
      routeId: params.routeId, fromWorkerId: params.fromUserId, toWorkerId: params.toUserId, amountMinor: toMinor(params.amount), reason: motivoValido(params.motivo),
    }, params.operationId ?? generateId());
    return r;
  });
}

async function assignOnline(params: CustodyParams & { recipientUserId: string }) {
  return asCustodyError(() => deliverCapitalToWorker({ ...params, motivo: motivoValido(params.motivo) } as Parameters<typeof deliverCapitalToWorker>[0]));
}

async function returnOnline(params: CustodyParams & { fromUserId: string }) {
  return asCustodyError(() => returnCapitalFromWorker({ ...params, motivo: motivoValido(params.motivo) } as Parameters<typeof returnCapitalFromWorker>[0]));
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const getTransferableCash = getTransferableCashOnline as unknown as typeof Clean.getTransferableCash;
export const transferBaseBetweenWorkers = transferOnline as unknown as typeof Clean.transferBaseBetweenWorkers;
export const assignBaseToWorker = assignOnline as unknown as typeof Clean.assignBaseToWorker;
export const returnBaseFromWorker = returnOnline as unknown as typeof Clean.returnBaseFromWorker;
