// TRASPASOS ENTRE ADMINISTRADORES (Rondas 53 y 59) desde las pantallas de ADEX Online.
//
// No existen en CLEAN: el servidor es la única autoridad. El directo se aplica al registrarlo
// (R59, entrega voluntaria); el registrado por Secretario espera la confirmación de ambos. Lecturas por revisión (`serverView`, se releen tras cada comando o cambio
// detectado); comandos con id de operación (`money`: un reintento nunca duplica).

import { money } from './commands.ts';
import { serverView } from './projection.ts';
import { toMajor, toMinor } from './mappers.ts';

export type TransferState = 'pending' | 'applied' | 'rejected' | 'cancelled';
export type PartyDecision = 'pending' | 'confirmed' | 'rejected' | 'not_required';

export interface AdminTransferParty { adminId: string; name: string | null; decision: PartyDecision; decidedAt: string | null; reason: string | null }

export interface AdminTransfer {
  id: string; mode: 'direct' | 'secretary'; state: TransferState;
  /** Importe en unidades de la moneda (como el resto de pantallas de CLEAN). */
  amount: number; reason: string; entryDate: string; createdAt: string; closedAt: string | null; closeReason: string | null;
  origin: AdminTransferParty; destination: AdminTransferParty;
  registeredBy: { membershipId: string; role: 'admin' | 'secretario'; name: string | null };
  mySide: 'origin' | 'destination' | null; canConfirm: boolean; canReject: boolean; canCancel: boolean;
}

interface Raw extends Omit<AdminTransfer, 'amount'> { amountMinor: number }

const fromRaw = (r: Raw): AdminTransfer => ({ ...r, amount: toMajor(r.amountMinor) });

export async function listAdminTransfers(): Promise<AdminTransfer[]> {
  const r = await serverView<{ transfers: Raw[] }>('/v1/capital/admin-transfers');
  return r.transfers.map(fromRaw);
}

export interface AdminOption { adminId: string; name: string; self: boolean }

export async function adminDirectory(): Promise<AdminOption[]> {
  return (await serverView<{ admins: AdminOption[] }>('/v1/capital/admin-directory')).admins;
}

/** Administrador: desde su bolsa (sin origen), aplicado en el acto (R59). Secretario: origen y destino. */
export async function registerAdminTransfer(p: { originAdminId?: string; destinationAdminId: string; amount: number; reason: string; operationId: string; requestId?: string }) {
  const body: Record<string, unknown> = { destinationAdminId: p.destinationAdminId, amountMinor: toMinor(p.amount), reason: p.reason.trim() };
  if (p.originAdminId) body['originAdminId'] = p.originAdminId;
  if (p.requestId) body['requestId'] = p.requestId;
  return fromRaw((await money<{ transfer: Raw }>('POST', '/v1/capital/admin-transfers', body, p.operationId)).transfer);
}

export async function decideAdminTransfer(id: string, what: 'confirm' | 'reject' | 'cancel', operationId: string, reason?: string) {
  const body = what === 'confirm' ? {} : { reason: (reason ?? '').trim() };
  return fromRaw((await money<{ transfer: Raw }>('POST', `/v1/capital/admin-transfers/${encodeURIComponent(id)}/${what}`, body, operationId)).transfer);
}

export const STATE_LABEL: Record<TransferState, string> = { pending: 'Pendiente', applied: 'Aplicada', rejected: 'Rechazada', cancelled: 'Cancelada' };
export const DECISION_LABEL: Record<PartyDecision, string> = { pending: 'Pendiente', confirmed: 'Confirmó', rejected: 'Rechazó', not_required: 'Recibió (entrega directa)' };
