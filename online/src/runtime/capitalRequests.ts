// SOLICITUDES, ENTREGAS VOLUNTARIAS y NOTIFICACIONES (Ronda 59) desde las pantallas de ADEX Online.
//
// Regla del propietario: quien tiene el dinero lo entrega sin pedir autorización; quien lo
// necesita, lo solicita. Pedir no mueve dinero. Atender una solicitud es el MISMO comando de
// siempre (asignación, devolución, traspaso directo, entrega del Cobrador) con `requestId`: el
// servidor enlaza ambas cosas en una transacción y no deja atender dos veces. Lecturas por
// revisión (`serverView`); comandos con id de operación (`money`: un reintento nunca duplica).

import { useEffect, useState } from 'react';
import { money } from './commands.ts';
import { serverView, subscribe } from './projection.ts';
import { toMajor, toMinor } from './mappers.ts';
import { useRuntime } from './session.ts';
import { formatPersonName } from '@/lib/displayName';

export type RequestKind = 'admin_return' | 'admin_allocation' | 'admin_transfer' | 'worker_return';
export type RequestState = 'pending' | 'fulfilled' | 'rejected' | 'cancelled';

export interface CapitalRequest {
  id: string; kind: RequestKind; state: RequestState;
  /** Importe en unidades de la moneda. */
  amount: number; note: string | null; concept: 'recaudo' | 'base' | null; routeId: string | null; createdAt: string;
  requester: { membershipId: string; role: 'superadmin' | 'admin'; name: string | null };
  holder: { membershipId: string | null; role: 'superadmin' | 'admin' | 'cobrador'; name: string | null };
  resolvedAt: string | null; resolvedBy: { membershipId: string; name: string | null } | null; resolutionReason: string | null;
  fulfilledOperationId: string | null; fulfilledTransferId: string | null;
  mySide: 'requester' | 'holder' | null; canAttend: boolean; canReject: boolean; canCancel: boolean;
}

type Raw = Omit<CapitalRequest, 'amount'> & { amountMinor: number };
const fromRaw = (r: Raw): CapitalRequest => ({ ...r, amount: toMajor(r.amountMinor) });

export const REQUEST_STATE_LABEL: Record<RequestState, string> = { pending: 'Pendiente', fulfilled: 'Atendida', rejected: 'Rechazada', cancelled: 'Cancelada' };
export const CONCEPT_LABEL = { recaudo: 'Recaudo', base: 'Devolución de base' } as const;

/** Título de la solicitud visto por quien la recibe (holder) o por quien la hizo (requester). */
export function requestTitle(r: CapitalRequest): string {
  const from = formatPersonName(r.requester.name) || (r.requester.role === 'superadmin' ? 'El SuperAdmin' : 'Un Administrador');
  const to = formatPersonName(r.holder.name) || (r.holder.role === 'superadmin' ? 'el SuperAdmin' : 'la otra parte');
  if (r.mySide === 'requester') {
    switch (r.kind) {
      case 'admin_allocation': return 'Pediste capital al SuperAdmin';
      case 'admin_return': return `Pediste a ${to} que devuelva capital`;
      case 'admin_transfer': return `Pediste capital a ${to}`;
      case 'worker_return': return `Pediste a ${to} que entregue ${r.concept === 'base' ? 'la base' : 'el recaudo'}`;
    }
  }
  switch (r.kind) {
    case 'admin_allocation': return `${from} pide capital adicional`;
    case 'admin_return': return `${from} pide que devuelvas capital`;
    case 'admin_transfer': return `${from} te pide capital`;
    case 'worker_return': return `${from} pide que entregues ${r.concept === 'base' ? 'la base' : 'el recaudo'}`;
  }
}

export async function listRequests(): Promise<CapitalRequest[]> {
  return (await serverView<{ requests: Raw[] }>('/v1/capital/requests')).requests.map(fromRaw);
}

export async function getRequest(id: string): Promise<CapitalRequest> {
  return fromRaw((await serverView<{ request: Raw }>(`/v1/capital/requests/${encodeURIComponent(id)}`)).request);
}

export async function createRequest(p: { kind: RequestKind; holderId?: string; routeId?: string; concept?: 'recaudo' | 'base'; amount: number; note?: string; operationId: string }) {
  const body: Record<string, unknown> = { kind: p.kind, amountMinor: toMinor(p.amount) };
  if (p.holderId) body['holderId'] = p.holderId;
  if (p.routeId) body['routeId'] = p.routeId;
  if (p.concept) body['concept'] = p.concept;
  if (p.note?.trim()) body['note'] = p.note.trim();
  return fromRaw((await money<{ request: Raw }>('POST', '/v1/capital/requests', body, p.operationId)).request);
}

export async function closeRequest(id: string, action: 'reject' | 'cancel', reason: string, operationId: string) {
  return fromRaw((await money<{ request: Raw }>('POST', `/v1/capital/requests/${encodeURIComponent(id)}/${action}`, { reason: reason.trim() }, operationId)).request);
}

/** Administrador: devuelve capital de SU bolsa a la empresa (sin aprobación). */
export async function returnToCompany(p: { amount: number; reason: string; requestId?: string; operationId: string }) {
  const body: Record<string, unknown> = { amountMinor: toMinor(p.amount), reason: p.reason.trim() };
  if (p.requestId) body['requestId'] = p.requestId;
  return money<{ operation: { id: string } }>('POST', '/v1/capital/admin-returns', body, p.operationId);
}

/** Cobrador: entrega efectivo de SU custodia al responsable de la ruta (sin aprobación). */
export async function deliverOwnCash(p: { routeId: string; amount: number; concept: 'recaudo' | 'base'; note?: string; requestId?: string; operationId: string }) {
  const body: Record<string, unknown> = { routeId: p.routeId, amountMinor: toMinor(p.amount), concept: p.concept };
  if (p.note?.trim()) body['note'] = p.note.trim();
  if (p.requestId) body['requestId'] = p.requestId;
  return money<{ operation: { id: string } }>('POST', '/v1/capital/own-returns', body, p.operationId);
}

// ---------- Notificaciones ----------

export type NoticeType = 'capital-received' | 'capital-collected' | 'cash-delivered' | 'capital-returned' | 'capital-delivered' | 'return-registered'
  | 'transfer-received' | 'transfer-closed' | 'request-resolved' | 'route-transfer-received';

export interface NoticeOperation {
  id: string; kind: string; amount: number; routeId: string | null; reason: string;
  actor: { membershipId: string; name: string | null; role: string }; adminName: string | null; workerName: string | null;
}

export interface NoticeTransfer {
  id: string; mode: 'direct' | 'secretary'; state: string; amount: number; reason: string; closeReason: string | null;
  origin: { adminId: string; name: string | null; decision: string }; destination: { adminId: string; name: string | null; decision: string };
  registeredBy: { membershipId: string; name: string | null }; mySide: 'origin' | 'destination';
}

/** R74 Base por Ruta (O5): el nuevo responsable debe contar la Base y confirmar la entrega. */
export interface NoticeHandover { id: string; routeId: string; routeName: string; fromId: string | null; baseAtStart: number }

export type Notice =
  | { type: 'request'; at: string; request: CapitalRequest }
  | { type: 'handover-confirmation'; at: string; handover: NoticeHandover }
  | { type: 'transfer-confirmation'; at: string; transfer: NoticeTransfer }
  | { type: 'request-resolved'; at: string; request: CapitalRequest }
  | { type: 'transfer-received' | 'transfer-closed'; at: string; transfer: NoticeTransfer }
  | { type: Exclude<NoticeType, 'request-resolved' | 'transfer-received' | 'transfer-closed'>; at: string; operation: NoticeOperation };

export interface Inbox { actionRequired: Notice[]; waiting: Notice[]; info: Notice[]; count: number; days: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapNotice(n: any): Notice {
  if (n.request) return { ...n, request: fromRaw(n.request) };
  if (n.transfer) return { ...n, transfer: { ...n.transfer, amount: toMajor(n.transfer.amountMinor) } };
  if (n.handover) return { ...n, handover: { ...n.handover, baseAtStart: toMajor(n.handover.baseAtStartMinor) } };
  return { ...n, operation: { ...n.operation, amount: toMajor(n.operation.amountMinor) } };
}

export async function fetchInbox(): Promise<Inbox> {
  const r = await serverView<any>('/v1/notifications');
  return { actionRequired: r.actionRequired.map(mapNotice), waiting: r.waiting.map(mapNotice), info: r.info.map(mapNotice), count: r.count, days: r.days };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Globo de Notificaciones: SOLO lo que requiere actuar. Se relee con el refresco normal de ADEX
 * (cada comando propio y la huella de cambios del servidor), sin sondeos propios.
 */
export function useNotificationCount(): number {
  const [n, setN] = useState(0);
  const ctx = useRuntime((s) => s.ctx);
  useEffect(() => {
    if (!ctx) { setN(0); return; }
    let alive = true;
    const read = () => {
      serverView<{ actionRequired: number }>('/v1/notifications/count')
        .then((r) => { if (alive) setN(r.actionRequired); })
        .catch(() => { /* API anterior o sin conexión: sin globo */ });
    };
    read();
    const off = subscribe(() => read());
    return () => { alive = false; off(); };
  }, [ctx]);
  return n;
}
