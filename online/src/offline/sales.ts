// RONDA 65 (corregida en 65-C1) · DESEMBOLSOS DEL COBRADOR SIN CONEXIÓN.
//
// Decisión del propietario (65-C1): SIN INTERNET EL COBRADOR NO REGISTRA CLIENTES NUEVOS NI VENTAS
// (ni solicitudes, ni ventas directas): llama a la oficina, que los registra con las reglas de
// siempre en la ruta que corresponde. Aquí no hay captura local de altas ni de solicitudes; las
// pantallas muestran el aviso (`newClientsAndSalesBlocked`) y el puente del servicio de ventas lo
// vuelve a comprobar.
//
// Lo que SÍ se puede sin conexión: entregar el dinero de una solicitud YA APROBADA que el dispositivo
// conoce desde su última sincronización, con el efectivo en custodia que calcula custody.ts (cifra
// del servidor menos lo que ya salió). Un id por intención: un segundo toque o un reintento nunca
// crea otro desembolso. Nada se presenta como confirmado hasta que el servidor responde.

import { formatCurrency, formatDateTime } from '@/lib/formatters';
import { ApiFailure, UncertainOperation, isUnconfirmed } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';
import { toMajor, toMinor } from '../runtime/mappers.ts';
import { invalidate, table } from '../runtime/projection.ts';
import { api, useRuntime } from '../runtime/session.ts';
import { availableCash } from './custody.ts';
import { capture, opsForRequest, recordConfirmed, shouldCaptureOffline, useOffline, type PendingOp } from './state.ts';
import { syncNow } from './sync.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** Error con el texto que muestran las pantallas originales. */
export class OfflineRuleError extends Error {
  constructor(message: string) { super(message); this.name = 'OfflineRuleError'; }
}

export const OFFLINE_BLOCK_TITLE = 'Operación no disponible sin internet';
export const OFFLINE_BLOCK_TEXT = 'Para registrar un cliente nuevo o una venta, comuníquese telefónicamente con la oficina para que realicen la gestión.';

/**
 * 65-C1: ¿el Cobrador está sin servidor al alcance? Entonces no registra clientes ni ventas.
 * Sin red del navegador, sin respuesta de la API o con el contexto aún sin revalidar.
 */
export function newClientsAndSalesBlocked(): boolean {
  if (useRuntime.getState().ctx?.role !== 'cobrador') return false;
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || !useRuntime.getState().online;
  return offline || useOffline.getState().ctxFromCache;
}

const nowIso = () => new Date().toISOString();

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
  if (!sale) throw new OfflineRuleError('Esta venta aprobada no está en los datos de este dispositivo. Conéctate a internet para actualizarlos.');
  return sale;
}

const cashText = (minor: number) => formatCurrency(toMajor(minor));

/**
 * Entrega del dinero de una solicitud aprobada por el COBRADOR (en línea o sin conexión).
 *   · Sin servidor al alcance: solo lo aprobado que el dispositivo ya conoce; comprueba el efectivo
 *     disponible y guarda la operación; el servidor la aplicará (o la dejará en revisión).
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

  if (shouldCaptureOffline()) {
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
