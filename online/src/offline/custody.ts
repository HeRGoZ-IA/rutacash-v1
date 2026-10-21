// EFECTIVO DISPONIBLE DEL COBRADOR SIN CONEXIÓN (Ronda 65).
//
// Sin internet, el Cobrador puede entregar el dinero de una solicitud YA APROBADA con el efectivo
// que tiene en custodia. El dispositivo NO lleva un libro: parte de la última cifra que dio el
// SERVIDOR (`GET /v1/capital/custody`, su propia custodia por ruta, con la misma regla que aplica
// `adex.credit_disburse`: saldo menos faltante arrastrado) y le aplica solo lo que el servidor
// todavía no tiene en esa cifra:
//
//   − desembolsos y gastos propios capturados en el dispositivo y aún no confirmados, cualquiera
//     que sea su estado (el dinero ya salió de la mano del Cobrador aunque el servidor lo rechace),
//     y los confirmados DESPUÉS de empezar a leer la cifra (aún no incluidos);
//   + abonos capturados que siguen pendientes de enviar (local) o enviados por primera vez después
//     de empezar a leer la cifra (el efectivo está en su mano y el servidor lo sumará a su
//     custodia). Un abono rechazado o en revisión NO suma.
//
// Ante la duda, la regla es conservadora: puede contar de menos, nunca dos veces el mismo dinero.
// Es una barrera del dispositivo; la decisión final es SIEMPRE del servidor al sincronizar (si ya
// no cabe, 409 y queda en revisión, sin saldos negativos ni registros parciales).

import { api, useRuntime } from '../runtime/session.ts';
import { subscribe } from '../runtime/projection.ts';
import { getSnapshot, putSnapshot } from './vault.ts';
import { currentScope, onActivated, useOffline, type PendingOp } from './state.ts';

interface Position { routeId: string; workerId: string; balanceMinor: number; carriedMinor: number }
export interface CustodySnapshot {
  /** Hora del dispositivo al EMPEZAR la lectura: lo confirmado después puede no estar incluido. */
  startedAt: string;
  positions: Position[];
}

const NAME = 'custody';
let snapshot: CustodySnapshot | null = null;
let loadedFor: string | null = null;
let refreshing: Promise<void> | null = null;

/** Lee del servidor la custodia propia y la guarda cifrada. Sin red, conserva la anterior. */
export function refreshCustody(): Promise<void> {
  refreshing ??= (async () => {
    const c = currentScope();
    if (!c || useRuntime.getState().ctx?.role !== 'cobrador') return;
    const startedAt = new Date().toISOString();
    try {
      const r = await api().get<{ positions: Position[] }>('/v1/capital/custody');
      const mine = (r.positions ?? []).filter((p) => p.workerId === c.scope.membershipId)
        .map((p) => ({ routeId: p.routeId, workerId: p.workerId, balanceMinor: Number(p.balanceMinor), carriedMinor: Number(p.carriedMinor) }));
      const next: CustodySnapshot = { startedAt, positions: mine };
      if (currentScope()?.scope !== c.scope) return;
      snapshot = next;
      loadedFor = c.scope.membershipId;
      await putSnapshot(c.scope, c.key, NAME, next).catch(() => undefined);
      useOffline.setState({ custodyAt: startedAt });
    } catch {
      /* sin conexión: se usa la última cifra guardada */
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Última cifra conocida (memoria o copia cifrada del dispositivo). */
export async function custodySnapshot(): Promise<CustodySnapshot | null> {
  const c = currentScope();
  if (!c) return null;
  if (loadedFor === c.scope.membershipId && snapshot) return snapshot;
  const saved = await getSnapshot<CustodySnapshot>(c.scope, c.key, NAME);
  if (currentScope()?.scope !== c.scope) return null;
  snapshot = saved?.value ?? null;
  loadedFor = c.scope.membershipId;
  return snapshot;
}

/** Cambio de contexto o cierre de sesión: nada de la membresía anterior queda en memoria. */
export function forgetCustody(): void {
  snapshot = null;
  loadedFor = null;
  useOffline.setState({ custodyAt: null });
}

const after = (t: string | undefined, since: string) => t !== undefined && t >= since;

/** Efecto en el efectivo del Cobrador que el servidor aún no tiene en la cifra leída en `since`. */
export function pendingEffect(op: PendingOp, since: string): number {
  const amount = Number(op.ref.amountMinor ?? 0);
  if (!(amount > 0)) return 0;
  if (op.kind === 'disbursement' || (op.kind === 'expense' && op.body['scope'] === 'trabajador')) {
    return op.status !== 'confirmed' || after(op.confirmedAt, since) ? -amount : 0;
  }
  if (op.kind === 'payment') {
    // Confirmado: lo que el servidor aplicó de verdad (en línea puede haberse topado al saldo).
    const got = op.status === 'confirmed' && op.result?.appliedMinor != null ? Math.min(amount, Number(op.result.appliedMinor)) : amount;
    if (op.status === 'local' && op.attempts === 0) return got;
    if ((op.status === 'local' || op.status === 'sending' || op.status === 'confirmed') && after(op.firstSentAt, since)) return got;
  }
  return 0;
}

export interface Availability {
  /** null = el dispositivo no conoce todavía la cifra del servidor (hay que conectarse una vez). */
  availableMinor: number | null;
  serverMinor: number | null;
  pendingOutMinor: number;
  pendingInMinor: number;
  savedAt: string | null;
}

/** Efectivo con el que el Cobrador puede entregar dinero en una ruta, según el dispositivo. */
export async function availableCash(routeId: string): Promise<Availability> {
  const snap = await custodySnapshot();
  const ops = useOffline.getState().ops.filter((o) => o.routeId === routeId);
  if (!snap) return { availableMinor: null, serverMinor: null, pendingOutMinor: 0, pendingInMinor: 0, savedAt: null };
  const pos = snap.positions.find((p) => p.routeId === routeId);
  // D25: un faltante arrastrado es deuda, no billetes (misma regla que el servidor).
  const server = pos ? pos.balanceMinor - pos.carriedMinor : 0;
  let out = 0, inc = 0;
  for (const o of ops) {
    const e = pendingEffect(o, snap.startedAt);
    if (e < 0) out += -e; else inc += e;
  }
  return { availableMinor: server - out + inc, serverMinor: server, pendingOutMinor: out, pendingInMinor: inc, savedAt: snap.startedAt };
}

let watching = false;
/** En línea, cada vez que la proyección se invalida (comando propio o cambios del servidor), se relee la cifra. */
export function watchCustody(): void {
  if (watching) return;
  watching = true;
  let timer = 0;
  subscribe(() => {
    if (useRuntime.getState().ctx?.role !== 'cobrador' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void refreshCustody(); }, 500);
  });
}

// Al quedar listo el modo sin conexión para un contexto: fuera la cifra anterior y, con red, la vigente.
onActivated(() => {
  forgetCustody();
  void refreshCustody();
});
