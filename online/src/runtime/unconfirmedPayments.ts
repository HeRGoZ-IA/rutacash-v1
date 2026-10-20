// ABONOS SIN CONFIRMAR (Ronda 48.1). Un abono es UNA operación con UN id durante toda su
// vida: se genera al enviar, se guarda ANTES de enviar y solo se olvida cuando el servidor
// da una respuesta definitiva sobre ESE id. Si la respuesta se pierde, ningún reintento del
// cliente crea un id nuevo: se consulta `/v1/operations/:id` y, si el servidor no la tiene,
// se repite con el MISMO id y el MISMO cuerpo (`OnlineClient.resolveUncertain`). El servidor
// compara la huella del cuerpo y serializa los intentos sobre `adex.operations`: un abono
// confirmado nunca se registra dos veces, y su ubicación tampoco (va en el mismo cuerpo).
//
// Mientras un crédito tenga un abono sin confirmar, no se envía otro sobre ese crédito:
// primero se resuelve el anterior. Un nuevo intento con los MISMOS datos ES ese abono
// (se resuelve y se devuelve su resultado); con datos distintos, se resuelve el anterior y
// se informa, sin enviar el nuevo.
//
// Persistencia local MÍNIMA (única excepción a «solo la sesión», DS-07): un registro por
// abono en vuelo, con lo imprescindible para repetirlo idéntico tras una recarga. No es un
// libro ni una cola: nada se envía solo, nada se calcula con él y se borra SOLO cuando el
// servidor responde de forma definitiva sobre ese id (nunca por antigüedad ni por espacio:
// olvidarlo permitiría un segundo pago). Con demasiados pendientes no se aceptan abonos
// nuevos hasta comprobarlos. Por membresía: otra persona u otro contexto en el mismo
// dispositivo no lo ven ni lo resuelven.

import { ApiFailure, UncertainOperation, isUnconfirmed, type OnlineClient } from '../lib/client.ts';

export const COLLECTIONS_PATH = '/v1/collections';
const STORAGE_KEY = 'adex.unconfirmed-payments.v1';
/** Pendientes por membresía a partir de los cuales no se envían abonos nuevos. */
export const MAX_PENDING = 20;

export interface PendingPayment {
  v: 1;
  operationId: string;
  membershipId: string;
  saleId: string;
  /** Cuerpo EXACTO enviado: el servidor compara su huella, un reintento debe ser idéntico. */
  body: Record<string, unknown>;
  startedAt: string;
}

export interface PendingStore {
  read(): PendingPayment[];
  write(list: PendingPayment[]): void;
}

export function memoryPendingStore(): PendingStore {
  let list: PendingPayment[] = [];
  return { read: () => list.map((p) => ({ ...p })), write: (l) => { list = l.map((p) => ({ ...p })); } };
}

/** `localStorage` si está disponible (sobrevive a la recarga); si no, memoria de la pestaña. */
export function browserPendingStore(): PendingStore {
  const fallback = memoryPendingStore();
  const ls = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
  return {
    // Con almacenamiento disponible, ÉL es la verdad (compartida entre pestañas, releída antes
    // de cada escritura); la memoria solo cubre un navegador que lo bloquea.
    read() {
      const s = ls();
      if (!s) return fallback.read();
      try {
        const raw = s.getItem(STORAGE_KEY);
        if (raw == null) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(isPending) : [];
      } catch { return fallback.read(); }
    },
    write(list) {
      fallback.write(list);
      try {
        const s = ls();
        if (!s) return;
        if (list.length) s.setItem(STORAGE_KEY, JSON.stringify(list)); else s.removeItem(STORAGE_KEY);
      } catch { /* almacenamiento bloqueado: queda la memoria de la pestaña */ }
    },
  };
}

function isPending(x: unknown): x is PendingPayment {
  const p = x as PendingPayment;
  return !!p && p.v === 1 && typeof p.operationId === 'string' && typeof p.membershipId === 'string' && typeof p.saleId === 'string'
    && typeof p.startedAt === 'string' && !!p.body && typeof p.body === 'object';
}

export type PaymentOutcome =
  /** El servidor confirmó el abono. `recovered`: se confirmó al resolver un envío sin respuesta. */
  | { kind: 'confirmed'; result: Record<string, unknown>; recovered: boolean }
  /** Respuesta definitiva: el abono NO quedó registrado. */
  | { kind: 'rejected'; error: unknown; previous: boolean }
  /** No se pudo confirmar ni descartar: el abono sigue pendiente de comprobar (mismo id). */
  | { kind: 'uncertain'; pending: PendingPayment }
  /** Se pidió un abono DISTINTO, pero el anterior sin confirmar sí quedó registrado: el nuevo no se envió. */
  | { kind: 'previous_confirmed'; pending: PendingPayment; result: Record<string, unknown> }
  /** Se pidió un abono distinto; el anterior NO quedó registrado. El nuevo tampoco se envió. */
  | { kind: 'previous_rejected'; pending: PendingPayment; error: unknown }
  /** Demasiados abonos sin confirmar en este dispositivo: el nuevo no se envió. */
  | { kind: 'too_many_pending'; count: number };

/** Mismos datos de pago (la lectura de ubicación de cada pulsación no cambia la intención). */
export function sameIntent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const k = (x: Record<string, unknown>) => JSON.stringify([x['saleId'], x['amountMinor'], x['collectorId'] ?? null, x['note'] ?? null]);
  return k(a) === k(b);
}

export class PaymentGuard {
  private readonly running = new Map<string, { intent: Record<string, unknown> | null; promise: Promise<PaymentOutcome> }>();
  private readonly client: OnlineClient;
  private readonly store: PendingStore;
  private readonly now: () => number;

  constructor(client: OnlineClient, store: PendingStore = browserPendingStore(), now: () => number = Date.now) {
    this.client = client;
    this.store = store;
    this.now = now;
  }

  /** Abono sin confirmar de este crédito en la membresía ACTIVA (null si no hay). */
  pendingFor(saleId: string): PendingPayment | null {
    const m = this.client.activeMembershipId;
    return m ? this.live().find((p) => p.membershipId === m && p.saleId === saleId) ?? null : null;
  }

  /**
   * Registrar un abono. Un doble toque o una petición simultánea con los MISMOS datos sobre
   * el mismo crédito reciben el MISMO resultado; con datos distintos, esperan a que termine
   * la anterior y se deciden después (nunca heredan su resultado).
   */
  register(saleId: string, body: Record<string, unknown>): Promise<PaymentOutcome> {
    return this.once(saleId, body, () => this.registerNow(saleId, body));
  }

  /** «Comprobar ahora»: resuelve el abono sin confirmar de ese crédito (nunca crea otro). */
  check(saleId: string): Promise<PaymentOutcome | null> {
    const p = this.pendingFor(saleId);
    if (!p) return Promise.resolve(null);
    return this.once(saleId, null, () => this.settle(p));
  }

  private once(saleId: string, intent: Record<string, unknown> | null, fn: () => Promise<PaymentOutcome>): Promise<PaymentOutcome> {
    const key = `${this.client.activeMembershipId ?? '-'} ${saleId}`;
    const busy = this.running.get(key);
    if (busy && (intent === null || busy.intent === null || sameIntent(busy.intent, intent))) return busy.promise;
    const start = (): Promise<PaymentOutcome> => {
      const promise = fn().finally(() => { if (this.running.get(key)?.promise === promise) this.running.delete(key); });
      this.running.set(key, { intent, promise });
      return promise;
    };
    return busy ? busy.promise.catch(() => undefined).then(() => this.once(saleId, intent, fn)) : start();
  }

  private async registerNow(saleId: string, body: Record<string, unknown>): Promise<PaymentOutcome> {
    const membershipId = this.client.activeMembershipId;
    if (!membershipId) return { kind: 'rejected', error: new ApiFailure(400, 'MEMBERSHIP_REQUIRED'), previous: false };
    const prev = this.pendingFor(saleId);
    if (prev) {
      const out = await this.settle(prev);
      if (sameIntent(prev.body, body) || out.kind === 'uncertain') return out;
      return out.kind === 'confirmed'
        ? { kind: 'previous_confirmed', pending: prev, result: out.result }
        : { kind: 'previous_rejected', pending: prev, error: (out as { error: unknown }).error };
    }
    const open = this.live().filter((p) => p.membershipId === membershipId).length;
    if (open >= MAX_PENDING) return { kind: 'too_many_pending', count: open };
    // El id nace con la intención y se guarda ANTES de enviar: una recarga a mitad de la
    // petición también deja con qué comprobarla.
    const pending: PendingPayment = { v: 1, operationId: crypto.randomUUID(), membershipId, saleId, body, startedAt: new Date(this.now()).toISOString() };
    this.put(pending);
    try {
      const result = await this.client.request('POST', COLLECTIONS_PATH, { body, operationId: pending.operationId, membership: membershipId });
      this.remove(pending.operationId);
      return { kind: 'confirmed', result, recovered: false };
    } catch (err) {
      if (isUnconfirmed(err)) return this.settle(pending);
      // Primer envío de este id rechazado: definitivo (incluso sesión o contexto: no llegó a la operación).
      this.remove(pending.operationId);
      return { kind: 'rejected', error: err, previous: false };
    }
  }

  private async settle(p: PendingPayment): Promise<PaymentOutcome> {
    // Solo en SU contexto: con otra membresía, la consulta no lo vería y repetirlo lo
    // registraría a nombre de otra persona.
    if (this.client.activeMembershipId !== p.membershipId) return { kind: 'uncertain', pending: p };
    try {
      const result = await this.client.resolveUncertain<Record<string, unknown>>(new UncertainOperation(p.operationId, 'POST', COLLECTIONS_PATH, p.body, p.membershipId));
      this.remove(p.operationId);
      return { kind: 'confirmed', result, recovered: true };
    } catch (err) {
      if (err instanceof UncertainOperation) return { kind: 'uncertain', pending: p };
      this.remove(p.operationId);
      return { kind: 'rejected', error: err, previous: true };
    }
  }

  private live(): PendingPayment[] {
    return this.store.read();
  }

  private put(p: PendingPayment): void {
    this.store.write([...this.live().filter((x) => x.operationId !== p.operationId), p]);
  }

  private remove(operationId: string): void {
    this.store.write(this.live().filter((x) => x.operationId !== operationId));
  }
}
