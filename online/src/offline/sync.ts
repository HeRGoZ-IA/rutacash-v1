// SINCRONIZACIÓN DE LO CAPTURADO SIN CONEXIÓN (Ronda 62).
//
//   1. DISPONIBILIDAD EFECTIVA: la señal de red del navegador no basta. Antes de enviar nada se
//      pide el contexto al servidor (`GET /v1/context`): responde la API, la sesión vale y la
//      membresía, el rol y las rutas son los VIGENTES (un bloqueo posterior se respeta: si la
//      membresía ya no vale, no se envía nada y el cliente vuelve al selector).
//   2. ORDEN: por hora de captura. Un abono espera si OTRO abono anterior del MISMO crédito
//      necesita revisión (nunca se salta uno para aplicar el siguiente sobre un saldo distinto).
//      Visitas, gastos y desembolsos (Ronda 65) no dependen de nada.
//      65-C1: clientes y ventas NO se registran sin conexión. Un alta o solicitud que una versión
//      anterior hubiera dejado en la cola NUNCA se envía: se marca «Rechazado» con la explicación y
//      se conserva (si ya se había enviado sin respuesta, solo se CONSULTA su resultado por el id).
//   3. EXACTAMENTE UNA VEZ: cada operación se envía con su MISMO id y su MISMO cuerpo. Si la
//      respuesta se pierde, se consulta `/v1/operations/:id` antes de repetir (`OnlineClient.command`);
//      el servidor serializa los intentos y devuelve el resultado guardado. Una sola sincronización
//      a la vez entre pestañas (Web Locks) y, de todos modos, el servidor no duplicaría.
//   4. EL SERVIDOR DECIDE: lo que rechaza queda guardado con su motivo («Requiere revisión» o
//      «Rechazado»); nunca se reescribe un importe ni se descarta en silencio.

import { ApiFailure, CONTEXT_LOST, NetworkFailure, SESSION_LOST, UncertainOperation, isBeforeOperation, isUnconfirmed } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';
import { invalidate } from '../runtime/projection.ts';
import { api, refreshContextFromServer, useRuntime } from '../runtime/session.ts';
import { currentScope, persist, persistInScope, reload, useOffline, type PendingOp } from './state.ts';
import { holdForSessionReview } from './sessionReview.ts';
import { refreshCustody, watchCustody } from './custody.ts';

const now = () => new Date().toISOString();

function summarize(op: PendingOp, r: Record<string, unknown>): PendingOp['result'] {
  if (op.kind === 'payment') {
    return { entityId: r['paymentId'] as string, appliedMinor: Number(r['appliedMinor']), newBalanceMinor: Number(r['newBalanceMinor']), date: r['paymentDate'] as string };
  }
  if (op.kind === 'visit') return { entityId: r['id'] as string, date: r['visitDate'] as string };
  if (op.kind === 'disbursement') {
    const c = (r['credit'] ?? {}) as Record<string, unknown>;
    return { entityId: c['id'] as string, date: c['disbursementDate'] as string };
  }
  const e = (r['expense'] ?? {}) as Record<string, unknown>;
  return { entityId: e['id'] as string, date: e['expenseDate'] as string };
}

/** 4xx definitivo → estado de la operación. 400 = inválida tal como está; el resto, revisión. */
function verdict(e: ApiFailure): 'review' | 'rejected' {
  return e.status === 400 ? 'rejected' : 'review';
}

const DEPENDENCY = 'DEPENDENCY_HELD';

async function withLock(fn: () => Promise<void>): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) { await fn(); return true; }
  let ran = false;
  await locks.request('adex-offline-sync', { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    ran = true;
    await fn();
  });
  return ran;
}

let running: Promise<void> | null = null;

/** Envía lo pendiente si hay servidor. Nunca lanza; varias llamadas a la vez comparten la misma ejecución. */
export function syncNow(): Promise<void> {
  running ??= run().finally(() => { running = null; });
  return running;
}

const held = (o: PendingOp) => o.status === 'review' && o.error?.code === DEPENDENCY && !o.reviewedAt;
const sendable = (o: PendingOp) => o.status === 'local' || o.status === 'sending' || held(o);

/** 65-C1: alta de cliente o solicitud que una versión anterior dejó en la cola (ya no se envían). */
export const LEGACY_CODE = 'OFFLINE_SALES_NOT_ALLOWED';
const LEGACY_TEXT = 'Registrado sin conexión con una versión anterior de la aplicación. Los clientes y las ventas ya no se registran sin internet: '
  + 'esto NO se envió al servidor. Comuníquese con la oficina para que lo registren.';
const legacy = (o: PendingOp) => (o.kind === 'client' || o.kind === 'credit_request')
  && (o.status === 'local' || o.status === 'sending' || o.status === 'review') && !o.reviewedAt;

/** Abono ANTERIOR del mismo crédito que espera revisión (y que nadie dio por revisado). */
function blockerOf(op: PendingOp, live: Map<string, PendingOp>): PendingOp | undefined {
  if (op.kind !== 'payment') return undefined;
  const before = (o: PendingOp) => o.capturedAt < op.capturedAt || (o.capturedAt === op.capturedAt && o.id < op.id);
  return [...live.values()].find((o) => o.id !== op.id && o.kind === 'payment' && o.ref.saleId === op.ref.saleId && before(o)
    && (o.status === 'review' || o.status === 'rejected') && !o.reviewedAt);
}

async function run(): Promise<void> {
  if (!useOffline.getState().enabled) return;
  if (!useOffline.getState().ops.some((o) => sendable(o) || legacy(o))) return;
  useOffline.setState({ syncing: true });
  try {
    await withLock(async () => {
      // D73-04: llave y cola de ESTA membresía antes de hablar con el servidor (si la sesión resulta
      // revocada, el modo se desactiva al instante y ya no habría con qué guardar).
      const sc = currentScope();
      const before = useOffline.getState().ops;
      const holdAll = async (ops: readonly PendingOp[]) => {
        if (!sc) return;
        for (const o of holdForSessionReview(ops, now())) await persistInScope(sc, o).catch(() => undefined);
      };
      // 1. ¿Responde el servidor y sigue valiendo el contexto?
      try {
        await refreshContextFromServer();
      } catch (e) {
        // Sin red: se intentará después. Membresía perdida: el cliente ya volvió al selector; los
        // pendientes quedan guardados para esa membresía. Sesión terminada (D73-04): lo pendiente
        // queda retenido para revisión explícita tras volver a iniciar sesión en este dispositivo.
        if (e instanceof ApiFailure && SESSION_LOST.has(e.code)) await holdAll(before);
        return;
      }
      if (!useOffline.getState().enabled) return;
      const ops = await reload();
      const live = new Map(ops.map((o) => [o.id, o]));
      const save = async (o: PendingOp) => { live.set(o.id, o); await persist(o); };
      let confirmed = 0;
      for (const { id } of ops) {
        const op = live.get(id)!;
        if (legacy(op)) {
          // Nunca se envía. Si una versión anterior ya lo había enviado sin respuesta, solo se consulta.
          if (op.status === 'sending') {
            try {
              const o = await api().get<{ result?: Record<string, unknown> }>(`/v1/operations/${op.id}`);
              await save({ ...op, status: 'confirmed', confirmedAt: now(), result: { entityId: o.result?.['id'] as string | undefined }, error: undefined });
              continue;
            } catch (e) {
              if (!(e instanceof ApiFailure && e.status === 404)) break;
            }
          }
          await save({ ...op, status: 'rejected', error: { code: LEGACY_CODE, message: LEGACY_TEXT, at: now() } });
          continue;
        }
        if (!sendable(op)) continue;
        // 2. Dependencia real: abono posterior de un crédito con otro abono en revisión.
        if (blockerOf(op, live)) {
          if (!held(op)) await save({ ...op, status: 'review', error: { code: DEPENDENCY, message: 'Espera a que se revise un abono anterior de este mismo crédito.', at: now() } });
          continue;
        }
        const prev = held(op) ? 'local' : op.status;
        const at = now();
        const sending: PendingOp = { ...op, status: 'sending', attempts: op.attempts + 1, firstSentAt: op.firstSentAt ?? at, lastAttemptAt: at,
          error: op.status === 'sending' ? op.error : undefined };
        await save(sending);
        try {
          // R74: con la membresía de la operación (la que la capturó), no con la activa en este momento.
          const r = await api().command<Record<string, unknown>>('POST', sending.path, sending.body, op.id, { membership: op.membershipId });
          await save({ ...sending, status: 'confirmed', confirmedAt: now(), result: summarize(op, r), error: undefined });
          confirmed++;
        } catch (e) {
          if (e instanceof UncertainOperation || e instanceof NetworkFailure || isUnconfirmed(e)) {
            // Sin respuesta definitiva: sigue «enviándose»; se comprobará con el mismo id.
            await save({ ...sending, error: { code: 'UNCERTAIN', message: 'Enviado sin respuesta del servidor: se comprobará con el mismo registro, sin duplicarlo.', at: now() } });
            break;
          }
          if (e instanceof ApiFailure && SESSION_LOST.has(e.code)) {
            // D73-04: la sesión terminó a mitad de la sincronización: esta y las pendientes, a revisión.
            await holdAll([...live.values()].map((o) => (o.id === sending.id ? { ...sending, status: prev } : o)));
            break;
          }
          if (e instanceof ApiFailure && (isBeforeOperation(e) || CONTEXT_LOST.has(e.code))) {
            // El servidor no llegó a la operación (sesión, contexto, límite): queda como estaba.
            await save({ ...sending, status: prev, error: { code: e.code, message: errorText(e), at: now() } });
            break;
          }
          if (e instanceof ApiFailure) {
            await save({ ...sending, status: verdict(e), error: { code: e.code, message: errorText(e), at: now() } });
            continue;
          }
          await save({ ...sending, status: prev });
          break;
        }
      }
      if (confirmed > 0) {
        invalidate();
        // Ronda 65: efectivo vigente del servidor tras lo confirmado (base del cálculo sin conexión).
        void refreshCustody();
      }
      useOffline.setState({ lastSyncAt: now() });
    });
  } catch {
    /* nunca rompe la pantalla: se reintentará */
  } finally {
    useOffline.setState({ syncing: false });
  }
}

let started = false;

/** Disparadores: vuelta de la red, pestaña visible, intervalo mientras haya pendientes. */
export function startOfflineSync(intervalMs = 15_000): void {
  if (started) return;
  started = true;
  // Ronda 65: con red, la cifra de efectivo del servidor se relee tras cada cambio.
  watchCustody();
  window.addEventListener('online', () => { void syncNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  window.setInterval(() => {
    if (document.visibilityState !== 'visible' || !useRuntime.getState().ctx) return;
    void syncNow();
  }, intervalMs);
}
