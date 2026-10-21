// RONDA 65 · CLIENTES, SOLICITUDES DE VENTA Y DESEMBOLSOS DEL COBRADOR SIN CONEXIÓN.
//
// Mismas reglas que en línea, sin atajos por no tener internet (ver también 0027 y sync.ts):
//   · Cliente nuevo: el MISMO cuerpo que el alta en línea (`POST /v1/clients`) más `offline`. Hasta
//     que el servidor lo confirme es «cliente sin sincronizar» (id `local:<operación>`): se puede
//     elegir para una solicitud, pero no tiene créditos ni cobros. Si el documento ya existía, el
//     servidor lo rechaza (409) y queda en revisión: nunca se fusiona ni se sobrescribe nada.
//   · Venta del Cobrador = SOLICITUD (el Cobrador no tiene venta directa). Sin conexión queda
//     guardada; el servidor la recibe PENDIENTE y otra persona la aprueba en línea. Nada de esto
//     mueve dinero.
//   · Desembolso: solo de una solicitud YA APROBADA que el dispositivo conoce, con el efectivo en
//     custodia que calcula custody.ts (cifra del servidor menos lo que ya salió). Un id por
//     intención: un segundo toque o un reintento nunca crea otro desembolso.
// Ninguna de estas capturas se presenta como confirmada hasta que el servidor responde.

import type { Client } from '@clean/models/types';
import { formatCurrency, formatDateTime, normalizeDoc } from '@/lib/formatters';
import { ApiFailure, UncertainOperation, isUnconfirmed } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';
import { clientFrom, toMajor, toMinor } from '../runtime/mappers.ts';
import { invalidate, registerLocalRows, table } from '../runtime/projection.ts';
import { api } from '../runtime/session.ts';
import { availableCash } from './custody.ts';
import { capture, opsForRequest, recordConfirmed, shouldCaptureOffline, useOffline, type PendingOp } from './state.ts';
import { syncNow } from './sync.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export const LOCAL_PREFIX = 'local:';
export const isLocalClientId = (id: string | undefined | null) => typeof id === 'string' && id.startsWith(LOCAL_PREFIX);
const opIdOf = (localId: string) => localId.slice(LOCAL_PREFIX.length);

/** Error con el texto que muestran las pantallas originales. */
export class OfflineRuleError extends Error {
  constructor(message: string) { super(message); this.name = 'OfflineRuleError'; }
}

/** ¿Este registro debe guardarse en el dispositivo? (Cobrador con el modo listo y sin servidor al alcance.) */
export function captureOffline(): boolean {
  return shouldCaptureOffline();
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

/** Clientes nuevos que el dispositivo aún no ve en la copia del servidor (para elegirlos y verlos). */
export function pendingClientRows(serverRows: Row[]): Row[] {
  const st = useOffline.getState();
  if (!st.enabled) return [];
  const known = new Set(serverRows.map((r) => String(r['id'])));
  const out: Row[] = [];
  for (const o of st.ops) {
    if (o.kind !== 'client' || o.status === 'rejected' || o.reviewedAt) continue;
    const id = o.status === 'confirmed' && o.result?.entityId ? o.result.entityId : `${LOCAL_PREFIX}${o.id}`;
    if (known.has(id)) continue;
    const b = o.body;
    const row = clientFrom({ id, routeId: o.routeId, name: b['name'], document: b['document'], phonePrimary: b['phonePrimary'], phoneSecondary: b['phoneSecondary'],
      addressPrimary: b['addressPrimary'], addressSecondary: b['addressSecondary'], business: b['business'], notes: b['notes'], status: 'activo',
      createdAt: o.capturedAt, updatedAt: o.capturedAt }) as unknown as Row;
    row['pendingSync'] = o.status !== 'confirmed';
    out.push(row);
  }
  return out;
}

registerLocalRows('clients', pendingClientRows);

// Los clientes del dispositivo cambian cuando cambia su cola (captura, carga tras abrir la app,
// confirmación o rechazo del servidor): entonces se vuelve a leer la tabla de clientes.
let clientSig = '';
useOffline.subscribe((st) => {
  const sig = st.ops.filter((o) => o.kind === 'client').map((o) => `${o.id}:${o.status}:${o.reviewedAt ?? ''}`).join('|');
  if (sig === clientSig) return;
  clientSig = sig;
  invalidate(['clients']);
});

/** ¿Hay ya un cliente (del servidor o guardado aquí) con ese documento? Misma normalización que CLEAN. */
export async function findClientByDocument(document: string): Promise<Client | null> {
  const norm = normalizeDoc(document);
  if (!norm) return null;
  const rows = (await table('clients').catch(() => [])) as unknown as Client[];
  return rows.find((c) => normalizeDoc(c.documento ?? '') === norm) ?? null;
}

/**
 * Alta de cliente guardada en el dispositivo. `body` es el cuerpo EXACTO del alta en línea
 * (writeAdapters.clientBodyOf). Devuelve la operación y el id local con el que se puede
 * relacionar una solicitud.
 */
export async function captureOfflineClient(body: Row, id: string = crypto.randomUUID(), capturedAt = nowIso()): Promise<{ op: PendingOp; localId: string }> {
  const dup = await findClientByDocument(String(body['document'] ?? ''));
  if (dup) throw new OfflineRuleError('Este documento ya está registrado en esta empresa.');
  const op = await capture({
    id, kind: 'client', path: '/v1/clients', body: { ...body, offline: { capturedAt } }, capturedAt, routeId: String(body['routeId']),
    ref: { clientName: String(body['name'] ?? ''), document: String(body['document'] ?? '') },
  });
  void syncNow();
  return { op, localId: `${LOCAL_PREFIX}${op.id}` };
}

/** Alta EN LÍNEA sin respuesta: pasa a la cola con su MISMO id y su MISMO cuerpo (se confirmará una vez). */
export async function adoptUncertainClient(body: Row, id: string, sentAt: string): Promise<{ op: PendingOp; localId: string } | null> {
  if (!useOffline.getState().enabled) return null;
  const op = await capture({
    id, kind: 'client', path: '/v1/clients', body, capturedAt: sentAt, routeId: String(body['routeId']), origin: 'uncertain', status: 'sending',
    ref: { clientName: String(body['name'] ?? ''), document: String(body['document'] ?? '') },
  });
  void syncNow();
  return { op, localId: `${LOCAL_PREFIX}${op.id}` };
}

// ---------------------------------------------------------------------------
// Solicitudes de venta
// ---------------------------------------------------------------------------

export interface RequestConditions {
  routeId: string; clientId: string; amountMinor: number; interestRate: number; installmentsCount: number;
  frequency: string; startDate: string; paymentDays: number[];
}

/** Cuerpo del comando de solicitud (igual que en línea). */
export const requestBody = (c: RequestConditions): Row => ({
  routeId: c.routeId, clientId: c.clientId, amountMinor: c.amountMinor, interestRate: c.interestRate, installmentsCount: c.installmentsCount,
  frequency: c.frequency, startDate: c.startDate, paymentDays: c.paymentDays,
});

/**
 * Solicitud guardada en el dispositivo. Con un cliente sin sincronizar, depende de su alta: se
 * enviará después de que el servidor lo confirme (y con su id real).
 */
export async function captureOfflineRequest(c: RequestConditions, clientName: string, capturedAt = nowIso()): Promise<PendingOp> {
  const open = useOffline.getState().ops.find((o) => o.kind === 'credit_request' && o.ref.clientId === c.clientId
    && (o.status === 'local' || o.status === 'sending' || (o.status === 'review' && !o.reviewedAt)));
  if (open) throw new OfflineRuleError('Ya hay una solicitud de este cliente guardada en este dispositivo, pendiente de enviar.');
  const dependsOn = isLocalClientId(c.clientId) ? opIdOf(c.clientId) : undefined;
  if (dependsOn && !useOffline.getState().ops.some((o) => o.id === dependsOn && o.kind === 'client')) {
    throw new OfflineRuleError('El cliente nuevo ya no está en este dispositivo.');
  }
  const op = await capture({
    id: crypto.randomUUID(), kind: 'credit_request', path: '/v1/credit-requests', body: { ...requestBody(c), offline: { capturedAt } }, capturedAt,
    routeId: c.routeId, dependsOn, ref: { clientId: c.clientId, clientName, amountMinor: c.amountMinor },
  });
  void syncNow();
  return op;
}

/** Solicitud EN LÍNEA sin respuesta → cola con su mismo id y cuerpo. */
export async function adoptUncertainRequest(body: Row, id: string, sentAt: string, clientName: string): Promise<PendingOp | null> {
  if (!useOffline.getState().enabled) return null;
  const op = await capture({
    id, kind: 'credit_request', path: '/v1/credit-requests', body, capturedAt: sentAt, routeId: String(body['routeId']), origin: 'uncertain', status: 'sending',
    ref: { clientId: String(body['clientId']), clientName, amountMinor: Number(body['amountMinor']) },
  });
  void syncNow();
  return op;
}

// ---------------------------------------------------------------------------
// Desembolsos
// ---------------------------------------------------------------------------

export type DisbursementOutcome =
  | { kind: 'confirmed' }
  | { kind: 'saved'; op: PendingOp }
  | { kind: 'uncertain'; op: PendingOp };

/** Estado del desembolso de una solicitud en el dispositivo (para la pantalla). */
export function disbursementState(requestId: string): PendingOp | null {
  const ops = opsForRequest(requestId);
  return ops.find((o) => o.status !== 'confirmed') ?? ops.find((o) => o.status === 'confirmed') ?? null;
}

async function pendingSale(requestId: string): Promise<Row> {
  const sale = ((await table('sales')) as Row[]).find((s) => s['id'] === requestId && s['disbursementStatus'] === 'pendiente');
  if (!sale) throw new OfflineRuleError('La venta ya no está pendiente de desembolso.');
  return sale;
}

const cashText = (minor: number) => formatCurrency(toMajor(minor));

/**
 * Entrega del dinero de una solicitud aprobada por el COBRADOR (en línea o sin conexión).
 *   · Sin servidor al alcance: comprueba el efectivo disponible del dispositivo y guarda la
 *     operación; el servidor la aplicará (o la dejará en revisión) al sincronizar.
 *   · En línea: el servidor decide en el acto; el dispositivo recuerda lo confirmado (para no
 *     contar dos veces el efectivo) y, si la respuesta se pierde, lo pasa a la cola con el mismo id.
 */
export async function disburseAsCollector(requestId: string): Promise<DisbursementOutcome> {
  const known = disbursementState(requestId);
  if (known?.status === 'confirmed') throw new OfflineRuleError('Este desembolso ya está confirmado por el servidor.');
  // Nunca un segundo desembolso (otro id) para lo mismo: el primero se resuelve con SU registro
  // («Reintentar» en Pendientes cuando la oficina lo solucione), aunque ya se haya revisado.
  if (known) {
    throw new OfflineRuleError(known.status === 'local' || known.status === 'sending'
      ? 'Este desembolso ya está guardado en este dispositivo y pendiente de sincronizar. No entregue el dinero otra vez.'
      : `Este desembolso ya se registró en este dispositivo y requiere revisión (${known.error?.message ?? 'sin motivo'}). No entregue el dinero otra vez; consulte Pendientes.`);
  }
  const sale = await pendingSale(requestId);
  const clients = (await table('clients').catch(() => [])) as Row[];
  const clientName = String(clients.find((c) => c['id'] === sale['clientId'])?.['nombre'] ?? '');
  const amountMinor = toMinor(Number(sale['valorVenta']));
  const routeId = String(sale['routeId']);
  const path = `/v1/credit-requests/${encodeURIComponent(requestId)}/disburse`;
  const ref = { requestId, clientId: String(sale['clientId']), clientName, amountMinor };
  const id = crypto.randomUUID();

  if (captureOffline()) {
    const cash = await availableCash(routeId);
    if (cash.availableMinor === null) {
      throw new OfflineRuleError('Para entregar dinero sin conexión, este dispositivo necesita conocer tu efectivo: conéctate a internet una vez.');
    }
    if (amountMinor > cash.availableMinor) {
      throw new OfflineRuleError(`Efectivo insuficiente: según la última sincronización (${formatDateTime(cash.savedAt!)}) y lo registrado después en este dispositivo, `
        + `tienes ${cashText(Math.max(0, cash.availableMinor))} para entregar.`);
    }
    const capturedAt = nowIso();
    const op = await capture({ id, kind: 'disbursement', path, body: { offline: { capturedAt } }, capturedAt, routeId, ref });
    void syncNow();
    return { kind: 'saved', op };
  }

  const sentAt = nowIso();
  try {
    const r = await api().command<Row>('POST', path, {}, id);
    invalidate();
    const credit = (r['credit'] ?? {}) as Row;
    await recordConfirmed({ id, kind: 'disbursement', path, body: {}, capturedAt: sentAt, routeId, ref, sentAt,
      result: { entityId: credit['id'], date: credit['disbursementDate'] } }).catch(() => null);
    return { kind: 'confirmed' };
  } catch (e) {
    if (e instanceof UncertainOperation || isUnconfirmed(e)) {
      if (useOffline.getState().enabled) {
        const op = await capture({ id, kind: 'disbursement', path, body: {}, capturedAt: sentAt, routeId, ref, origin: 'uncertain', status: 'sending' });
        void syncNow();
        return { kind: 'uncertain', op };
      }
      throw new OfflineRuleError('No se pudo confirmar el desembolso con el servidor. No entregue el dinero otra vez: recargue y compruebe si quedó registrado.');
    }
    if (e instanceof ApiFailure) { invalidate(); throw new OfflineRuleError(errorText(e)); }
    throw e;
  }
}
