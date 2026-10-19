// PUENTE de `src/services/centralCapitalService.ts` (CLEAN) — operaciones del capital
// centralizado contra el libro central del servidor (Fase 3):
//
//   deliverCapitalToWorker      → POST /v1/capital/deliveries          (WORKER_DELIVERY)
//   returnCapitalFromWorker     → POST /v1/capital/returns             (WORKER_RETURN)
//   reverseCapitalDelivery      → POST /v1/capital/operations/:id/reverse
//   registerPartnerContribution → POST /v1/capital/partner-contributions
//   reversePartnerContribution  → POST /v1/capital/operations/:id/reverse
//
// Cada comando lleva el id de operación que CLEAN ya genera al abrir el formulario: un
// doble clic o un reintento tras una respuesta perdida devuelven la MISMA operación. El
// servidor revalida responsable, custodio, fondos, periodo y concurrencia bajo bloqueo.
// La activación y el diagnóstico de la transición a capital centralizado no existen en el
// SaaS (nace centralizado): esas funciones fallan con una explicación.

import type { CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, User, Withdrawal } from '@clean/models/types';
import { CentralCapitalError } from '@clean/services/centralCapitalLedger';
import * as Clean from '@clean/services/centralCapitalService';
import { money } from '../../runtime/commands.ts';
import { capitalRecords, calendar } from '../../runtime/projection.ts';
import { toMinor } from '../../runtime/mappers.ts';

export * from '@clean/services/centralCapitalService';

async function command(path: string, body: Record<string, unknown>, operationId?: string): Promise<string> {
  try {
    const r = await money<{ operation: { id: string } }>('POST', path, body, operationId);
    return r.operation.id;
  } catch (e) {
    throw new CentralCapitalError(e instanceof Error ? e.message : String(e));
  }
}

const motivoValido = (m: string | undefined, que = 'el concepto') => {
  const t = (m ?? '').trim();
  if (t.length < 3) throw new CentralCapitalError(`Indica ${que} (mínimo 3 caracteres).`);
  return t;
};

async function deliverOnline(p: { actor: User | null | undefined; tenantId: string; routeId: string; recipientUserId: string; amount: number; motivo: string; operationId?: string; saleRequestId?: string }) {
  const body: Record<string, unknown> = { routeId: p.routeId, workerId: p.recipientUserId, amountMinor: toMinor(p.amount), reason: motivoValido(p.motivo) };
  if (p.saleRequestId) body['saleRequestId'] = p.saleRequestId;
  const id = await command('/v1/capital/deliveries', body, p.operationId);
  const recs = await capitalRecords();
  return {
    capital: recs.capitalMovements.find((m) => m.id === id) ?? ({ id, createdAt: new Date().toISOString() } as CapitalMovement),
    custody: recs.cashCustodyMovements.find((m) => m.id === `${id}:custodia`) as CashCustodyMovement,
  };
}

async function returnOnline(p: { actor: User | null | undefined; tenantId: string; routeId: string; fromUserId: string; amount: number; motivo: string; operationId?: string }) {
  const id = await command('/v1/capital/returns', { routeId: p.routeId, workerId: p.fromUserId, amountMinor: toMinor(p.amount), reason: motivoValido(p.motivo) }, p.operationId);
  const recs = await capitalRecords();
  return {
    withdrawal: recs.withdrawals.find((m) => m.id === id) ?? ({ id, createdAt: new Date().toISOString() } as Withdrawal),
    custody: recs.cashCustodyMovements.find((m) => m.id === `${id}:custodia`) as CashCustodyMovement,
  };
}

/** `operationId` aquí es el id de la ENTREGA a anular (en CLEAN, el id del capital movement). */
async function reverseDeliveryOnline(p: { actor: User | null | undefined; tenantId: string; operationId: string; reason: string }) {
  const id = await command(`/v1/capital/operations/${p.operationId}/reverse`, { reason: motivoValido(p.reason, 'el motivo de la anulación') });
  const recs = await capitalRecords();
  return {
    capitalReversal: recs.capitalMovements.find((m) => m.id === id) as CapitalMovement,
    custodyReversal: recs.cashCustodyMovements.find((m) => m.id === `${id}:custodia`) as CashCustodyMovement,
  };
}

async function partnerContributionOnline(p: { actor: User | null | undefined; tenantId: string; partnerId: string; routeId: string; amount: number; descripcion?: string; fecha?: string; operationId?: string }) {
  const hoy = (await calendar()).businessDate;
  if (p.fecha && p.fecha !== hoy) throw new CentralCapitalError(`La fecha la fija el servidor: hoy en la empresa (${hoy}).`);
  const id = await command('/v1/capital/partner-contributions',
    { partnerId: p.partnerId, routeId: p.routeId, amountMinor: toMinor(p.amount), reason: motivoValido(p.descripcion, 'la descripción del aporte') }, p.operationId);
  const entry = (await capitalRecords()).capitalLedger.find((e) => e.id === id) ?? ({ id } as CapitalLedgerEntry);
  // Caja socios no existe en el servidor (decisión D1 abierta): no hay pata de socio.
  return { entry, partnerMovement: undefined as never };
}

async function reversePartnerContributionOnline(p: { actor: User | null | undefined; tenantId: string; entryId: string; reason: string }) {
  const id = await command(`/v1/capital/operations/${p.entryId}/reverse`, { reason: motivoValido(p.reason, 'el motivo de la anulación') });
  return { reversal: (await capitalRecords()).capitalLedger.find((e) => e.id === id) ?? ({ id } as CapitalLedgerEntry) };
}

const sinTransicion = async (): Promise<never> => {
  throw new CentralCapitalError('En ADEX Online el capital centralizado está activo desde la creación de la empresa: no hay transición que activar ni diagnosticar.');
};

// Firmas ORIGINALES de CLEAN.
export const deliverCapitalToWorker = deliverOnline as unknown as typeof Clean.deliverCapitalToWorker;
export const returnCapitalFromWorker = returnOnline as unknown as typeof Clean.returnCapitalFromWorker;
export const reverseCapitalDelivery = reverseDeliveryOnline as unknown as typeof Clean.reverseCapitalDelivery;
export const registerPartnerContribution = partnerContributionOnline as unknown as typeof Clean.registerPartnerContribution;
export const reversePartnerContribution = reversePartnerContributionOnline as unknown as typeof Clean.reversePartnerContribution;
export const activateCentralCapitalModel = sinTransicion as unknown as typeof Clean.activateCentralCapitalModel;
export const getActivationReadiness = sinTransicion as unknown as typeof Clean.getActivationReadiness;
export const releaseCentralCapitalRoute = sinTransicion as unknown as typeof Clean.releaseCentralCapitalRoute;
export const diagnoseCentralCapitalTransition = sinTransicion as unknown as typeof Clean.diagnoseCentralCapitalTransition;
