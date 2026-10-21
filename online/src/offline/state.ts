// MODO SIN CONEXIÓN DEL COBRADOR (Ronda 62): estado, llave, cola y avisos.
//
// Reglas que no se negocian (ver también vault.ts y sync.ts):
//   · Solo el COBRADOR: abonos, visitas sin pago, sus propios gastos y (Ronda 65) clientes nuevos,
//     solicitudes de venta y la entrega del dinero de una solicitud YA APROBADA (sales.ts).
//   · Una operación capturada sin conexión es una INTENCIÓN guardada en el dispositivo: no es
//     un pago, no cambia saldos y nunca se presenta como confirmada. La confirma (o la rechaza)
//     el servidor al sincronizar, con el MISMO id de operación y el MISMO cuerpo para siempre.
//   · Nada se borra por antigüedad ni se bloquea a nadie por el tiempo sin sincronizar: a las
//     12 y 24 horas solo se AVISA.
//   · Nada pendiente se descarta en silencio: lo rechazado queda guardado con su motivo.

import { create } from 'zustand';
import { ApiFailure } from '../lib/client.ts';
import type { ActiveContextView } from '../lib/client.ts';
import { api, useRuntime } from '../runtime/session.ts';
import {
  forgetIdentity, forgetSnapshotsOf, foreignPendingCount, getSnapshot, importKey, listOperations, loadKey, putOperation, putSnapshot, saveKey,
  type Scope,
} from './vault.ts';

export type OpKind = 'payment' | 'visit' | 'expense' | 'client' | 'credit_request' | 'disbursement';
/**
 *   local      — guardada SOLO en este dispositivo, aún no enviada.
 *   sending    — enviada al menos una vez sin respuesta definitiva (se comprueba con su mismo id).
 *   confirmed  — confirmada por el servidor.
 *   review     — el servidor no la aceptó con el estado actual (bloqueo, saldo, ruta, crédito…) o
 *                espera a otra del mismo crédito que necesita revisión. Se puede reintentar (mismo id).
 *   rejected   — el servidor la rechazó como inválida: no se puede aceptar tal como está.
 */
export type OpStatus = 'local' | 'sending' | 'confirmed' | 'review' | 'rejected';

export interface PendingOp {
  v: 1;
  /** = `X-Adex-Operation-Id`. Nace con la captura y no cambia nunca. */
  id: string;
  kind: OpKind;
  /** `offline`: capturada sin conexión; `uncertain`: enviada en línea sin respuesta (Ronda 48.1). */
  origin: 'offline' | 'uncertain';
  identityId: string;
  membershipId: string;
  companyId: string;
  routeId: string;
  /** Comando de siempre: `/v1/collections`, `/v1/no-payment-visits`, `/v1/expenses`, `/v1/clients`,
   *  `/v1/credit-requests` o `/v1/credit-requests/:id/disburse`. */
  path: string;
  /** Cuerpo EXACTO que se envía: el servidor compara su huella, un reintento debe ser idéntico. */
  body: Record<string, unknown>;
  /** Hora de captura del DISPOSITIVO (ISO). */
  capturedAt: string;
  /**
   * Ronda 65: operación de la que depende (alta del cliente de una solicitud). Hasta que el
   * servidor la confirme, el cuerpo lleva `clientId: "local:<id>"`; al confirmarse se fija el id
   * del servidor UNA vez (antes del primer envío) y el cuerpo ya no cambia.
   */
  dependsOn?: string;
  /** Datos solo para mostrar (cliente, importe, categoría…). */
  ref: { saleId?: string; clientId?: string; clientName?: string; amountMinor?: number; label?: string; reason?: string; location?: string;
    requestId?: string; document?: string };
  status: OpStatus;
  attempts: number;
  /** Ronda 65: primer envío al servidor (para no contar dos veces el efectivo; ver custody.ts). */
  firstSentAt?: string;
  lastAttemptAt?: string;
  error?: { code: string; message: string; at: string };
  result?: { entityId?: string; appliedMinor?: number; newBalanceMinor?: number; date?: string };
  confirmedAt?: string;
  /** Revisada por la persona (rechazada o en revisión): deja de avisar, pero NO se borra. */
  reviewedAt?: string;
}

/** Estados que todavía dependen de este dispositivo (el servidor no los tiene). */
export const UNCONFIRMED: readonly OpStatus[] = ['local', 'sending', 'review', 'rejected'];
export const isOpen = (o: PendingOp) => UNCONFIRMED.includes(o.status) && !o.reviewedAt;

export interface OfflineState {
  /** Modo sin conexión disponible para el contexto activo (Cobrador con llave). */
  enabled: boolean;
  /** Motivo por el que no está disponible (solo para mostrar). */
  unavailable: string | null;
  ops: PendingOp[];
  /** Registros de esta membresía que no se pudieron descifrar (se conservan). */
  unreadable: number;
  syncing: boolean;
  lastSyncAt: string | null;
  /** El contexto en uso viene de la copia del dispositivo (sin revalidar con el servidor). */
  ctxFromCache: boolean;
  /** Hora de la copia de consulta que se está mostrando sin conexión (null = datos en vivo). */
  dataSavedAt: string | null;
  /** Pendientes de OTRA sesión guardados (cifrados) en este dispositivo. */
  foreignPending: number;
  /** Ronda 65: hora de la última cifra de efectivo leída del servidor (custody.ts); cambia al releerla. */
  custodyAt: string | null;
}

export const useOffline = create<OfflineState>(() => ({
  enabled: false, unavailable: null, ops: [], unreadable: 0, syncing: false, lastSyncAt: null, ctxFromCache: false, dataSavedAt: null, foreignPending: 0,
  custodyAt: null,
}));

let scope: Scope | null = null;
let key: CryptoKey | null = null;
const activated = new Set<() => void>();
/** Avisa cada vez que el modo queda listo para un contexto (p. ej. para adoptar abonos sin confirmar). */
export function onActivated(fn: () => void): () => void {
  activated.add(fn);
  return () => activated.delete(fn);
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('adex-offline') : null;
channel?.addEventListener('message', () => { void reload(); });

export function currentScope(): { scope: Scope; key: CryptoKey } | null {
  return scope && key ? { scope, key } : null;
}

const CTX_SNAPSHOT = '__context';

/**
 * Prepara el modo sin conexión para el contexto recién validado POR EL SERVIDOR: obtiene la llave
 * de la membresía (si aún no está en el dispositivo), guarda la copia del contexto y carga sus
 * pendientes. Para cualquier otro rol, el modo queda apagado.
 */
export async function activate(ctx: ActiveContextView, opts: { fromCache?: boolean } = {}): Promise<void> {
  const identityId = api().identityId;
  if (!identityId) return deactivate();
  const next: Scope = { identityId, membershipId: ctx.membershipId, companyId: ctx.company.id };
  scope = next;
  key = null;
  useOffline.setState({ ctxFromCache: opts.fromCache === true, ops: [], unreadable: 0 });
  if (ctx.role !== 'cobrador') {
    useOffline.setState({ enabled: false, unavailable: null });
    return;
  }
  let k = await loadKey(identityId, ctx.membershipId);
  if (!k && !opts.fromCache) {
    try {
      const r = await api().send<{ key: string }>('POST', '/v1/offline/key', {});
      k = await importKey(r.key);
      await saveKey(identityId, ctx.membershipId, k);
    } catch (e) {
      // API anterior a la Ronda 62 (404) o sin IndexedDB: sin modo sin conexión, todo sigue en línea.
      if (scope !== next) return;
      useOffline.setState({ enabled: false, unavailable: e instanceof ApiFailure && e.status === 404 ? 'El servidor todavía no ofrece el modo sin conexión.' : 'No se pudo preparar el modo sin conexión en este dispositivo.' });
      return;
    }
  }
  if (scope !== next) return;
  if (!k) {
    useOffline.setState({ enabled: false, unavailable: 'Conéctate a internet una vez para preparar el modo sin conexión.' });
    return;
  }
  key = k;
  if (!opts.fromCache) await putSnapshot(next, k, CTX_SNAPSHOT, ctx).catch(() => undefined);
  useOffline.setState({ enabled: true, unavailable: null });
  await reload();
  for (const fn of activated) { try { fn(); } catch { /* cada suscriptor se protege */ } }
}

/** El servidor revalidó el MISMO contexto: deja de ser «de la copia» y se guarda de nuevo. */
export async function confirmContext(ctx: ActiveContextView): Promise<void> {
  const s = scope, k = key;
  if (s && k && s.membershipId === ctx.membershipId) await putSnapshot(s, k, CTX_SNAPSHOT, ctx).catch(() => undefined);
  if (scope === s) useOffline.setState({ ctxFromCache: false });
}

/** Contexto guardado de esta identidad y membresía (para abrir la ruta sin conexión). */
export async function cachedContext(identityId: string, membershipId: string): Promise<ActiveContextView | null> {
  const k = await loadKey(identityId, membershipId);
  if (!k) return null;
  const snap = await getSnapshot<ActiveContextView>({ identityId, membershipId, companyId: '' }, k, CTX_SNAPSHOT);
  return snap?.value.role === 'cobrador' && snap.value.membershipId === membershipId ? snap.value : null;
}

export function deactivate(): void {
  scope = null;
  key = null;
  useOffline.setState({ enabled: false, unavailable: null, ops: [], unreadable: 0, ctxFromCache: false, dataSavedAt: null });
  void refreshForeign();
}

/** Cierre de sesión: fuera llaves y copias de consulta de la identidad; los pendientes quedan cifrados. */
export async function forgetOnSignOut(identityId: string | null): Promise<void> {
  // Primero se apaga el modo (no se escriben más copias); después se borran llave y copias.
  deactivate();
  if (identityId) await forgetIdentity(identityId).catch(() => undefined);
}

/** El servidor dijo que esta membresía ya no vale: fuera su copia de consulta (pendientes y llave quedan). */
export async function forgetMembershipData(membershipId: string): Promise<void> {
  await forgetSnapshotsOf(membershipId).catch(() => undefined);
}

export async function refreshForeign(): Promise<void> {
  const n = await foreignPendingCount(scope?.identityId ?? api().identityId ?? null, ['local', 'sending', 'review', 'rejected']);
  useOffline.setState({ foreignPending: n });
}

/** Relee la cola de esta membresía desde el disco (otra pestaña pudo cambiarla). */
export async function reload(): Promise<PendingOp[]> {
  const s = scope, k = key;
  if (!s || !k) return [];
  const { ops, unreadable } = await listOperations<PendingOp>(s, k);
  if (s !== scope) return [];
  ops.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  useOffline.setState({ ops, unreadable });
  void refreshForeign();
  return ops;
}

/** Guarda la operación EN DISCO (resuelve tras confirmarse la escritura) y avisa a las demás pestañas. */
export async function persist(op: PendingOp): Promise<void> {
  const s = scope, k = key;
  if (!s || !k || op.membershipId !== s.membershipId) throw new Error('OFFLINE_SCOPE_MISMATCH');
  await putOperation(s, k, op);
  useOffline.setState((st) => {
    const ops = st.ops.filter((o) => o.id !== op.id).concat(op);
    ops.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
    return { ops };
  });
  channel?.postMessage({ t: 'changed', id: op.id });
}

type Capture = Pick<PendingOp, 'kind' | 'path' | 'body' | 'routeId' | 'ref' | 'dependsOn'> & { id: string; capturedAt: string; origin?: PendingOp['origin']; status?: OpStatus };

/** Nueva operación capturada. Se guarda en disco ANTES de devolverla: si la app se cierra, sigue ahí. */
export async function capture(c: Capture): Promise<PendingOp> {
  const s = scope;
  if (!s || !key || !useOffline.getState().enabled) throw new Error('OFFLINE_UNAVAILABLE');
  const existing = useOffline.getState().ops.find((o) => o.id === c.id);
  if (existing) return existing;
  const op: PendingOp = {
    v: 1, id: c.id, kind: c.kind, origin: c.origin ?? 'offline', identityId: s.identityId, membershipId: s.membershipId, companyId: s.companyId,
    routeId: c.routeId, path: c.path, body: c.body, capturedAt: c.capturedAt, ref: c.ref, status: c.status ?? 'local', attempts: 0,
    ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}),
  };
  await persist(op);
  return op;
}

/**
 * Ronda 65: operación hecha EN LÍNEA y ya confirmada por el servidor que el dispositivo recuerda
 * (desembolso del Cobrador): sin ella, el efectivo disponible sin conexión la contaría dos veces.
 */
export async function recordConfirmed(c: Capture & { result: PendingOp['result']; sentAt: string }): Promise<PendingOp | null> {
  const s = scope;
  if (!s || !key || !useOffline.getState().enabled) return null;
  const at = new Date().toISOString();
  const op: PendingOp = {
    v: 1, id: c.id, kind: c.kind, origin: 'uncertain', identityId: s.identityId, membershipId: s.membershipId, companyId: s.companyId,
    routeId: c.routeId, path: c.path, body: c.body, capturedAt: c.capturedAt, ref: c.ref, status: 'confirmed', attempts: 1,
    firstSentAt: c.sentAt, lastAttemptAt: c.sentAt, confirmedAt: at, result: c.result,
  };
  await persist(op);
  return op;
}

/** «Ya lo revisé»: deja de avisar. El registro NO se borra del dispositivo. */
export async function markReviewed(id: string): Promise<void> {
  const op = useOffline.getState().ops.find((o) => o.id === id);
  if (!op || (op.status !== 'review' && op.status !== 'rejected')) return;
  await persist({ ...op, reviewedAt: new Date().toISOString() });
}

/** «Reintentar» una operación en revisión: vuelve a la cola con su MISMO id y cuerpo. */
export async function retry(id: string): Promise<void> {
  const op = useOffline.getState().ops.find((o) => o.id === id);
  if (!op || op.status !== 'review') return;
  // Reenviar con el mismo id es seguro: si el servidor ya lo tenía, devuelve el resultado guardado.
  await persist({ ...op, status: 'local', reviewedAt: undefined });
}

/**
 * ¿Hay que capturar sin conexión? Solo si el modo está disponible y el servidor no está al
 * alcance (sin red, última petición sin respuesta o contexto aún sin revalidar).
 */
export function shouldCaptureOffline(): boolean {
  if (!useOffline.getState().enabled) return false;
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || !useRuntime.getState().online;
  return offline || useOffline.getState().ctxFromCache;
}

/** Ronda 65: operaciones de una solicitud aprobada (su desembolso) que el dispositivo conoce, de cualquier estado. */
export function opsForRequest(requestId: string): PendingOp[] {
  return useOffline.getState().ops.filter((o) => o.kind === 'disbursement' && o.ref.requestId === requestId);
}

/** Operaciones sin confirmar de un crédito (para no cobrar dos veces ni descontar a ciegas). */
export function openOpsForSale(saleId: string): PendingOp[] {
  return useOffline.getState().ops.filter((o) => o.ref.saleId === saleId && UNCONFIRMED.includes(o.status));
}

// ---------- Avisos de 12 y 24 horas (decisión del propietario) ----------

export const ALERT_12H = 'Tienes operaciones pendientes de sincronización. Busca conexión a internet lo antes posible. Los datos guardados únicamente en este dispositivo podrían perderse si se borran los datos de la aplicación o falla el dispositivo.';
export const ALERT_24H = 'Atención: llevas más de 24 horas sin sincronizar. Conéctate a internet cuanto antes para proteger tus operaciones pendientes. Mientras no se sincronicen, solo están guardadas en este dispositivo y existe riesgo de pérdida.';

/**
 * Nivel de aviso según la operación pendiente MÁS ANTIGUA aún no confirmada por el servidor.
 * Solo avisa: nunca borra, nunca bloquea, sin cuenta regresiva.
 */
export function alertLevel(ops: readonly PendingOp[], now = Date.now()): 0 | 12 | 24 {
  const open = ops.filter(isOpen);
  if (!open.length) return 0;
  const oldest = Math.min(...open.map((o) => Date.parse(o.capturedAt)).filter(Number.isFinite));
  if (!Number.isFinite(oldest)) return 0;
  const hours = (now - oldest) / 3_600_000;
  return hours >= 24 ? 24 : hours >= 12 ? 12 : 0;
}

/** Resumen para el indicador y la pantalla de pendientes. */
export function summary(ops: readonly PendingOp[]) {
  const open = ops.filter(isOpen);
  return {
    pending: open.filter((o) => o.status === 'local' || o.status === 'sending').length,
    attention: open.filter((o) => o.status === 'review' || o.status === 'rejected').length,
    open: open.length,
  };
}
