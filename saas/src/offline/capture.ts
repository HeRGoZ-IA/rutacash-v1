// MODO SIN CONEXIÓN DEL COBRADOR (Ronda 62 · 0026; Ronda 65 · 0027).
//
// Una operación capturada sin internet llega por el MISMO comando (abono, visita, gasto y, desde
// la Ronda 65, desembolso de una solicitud aprobada; clientes y ventas NO, ver 65-C1) con
// un campo `offline` que describe la captura: `{ capturedAt, knownBalanceMinor? }`. El servidor:
//   · la acepta SOLO de un Cobrador (el modo sin conexión es suyo en esta versión);
//   · decide con el estado VIGENTE: membresía, rol, ruta asignada y operativa, crédito,
//     periodo. Que el dispositivo tuviera permiso al capturar no autoriza nada;
//   · no topa un abono al saldo: si ya no cabe, lo rechaza (409) para que se revise en vez
//     de reescribir el importe (`assertOfflineFits`);
//   · fecha el movimiento con la fecha de la empresa AL CONFIRMARSE (un periodo cerrado nunca
//     se modifica) y guarda la hora del dispositivo como evidencia NO confiable
//     (`adex.offline_captures`), bajo savepoint: si esa evidencia fallara, el movimiento sigue.
// La idempotencia es la de siempre (`adex.operations`): el campo `offline` forma parte del
// cuerpo, así que un reintento debe ser idéntico y nunca registra dos veces.

import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { ActiveContext } from '../authz/context.ts';

export interface OfflineCapture {
  /** Hora de captura del dispositivo (ISO) si es plausible; null si el reloj está fuera de rango. */
  deviceCapturedAt: string | null;
  /** Saldo que el dispositivo mostraba al capturar (solo abonos; evidencia). */
  knownBalanceMinor: number | null;
  note: string | null;
}

export type OfflineKind = 'payment' | 'visit' | 'expense' | 'disbursement';

/** Antigüedad máxima admitida para la hora del dispositivo (más allá, se guarda sin hora). */
const MAX_AGE_MS = 45 * 24 * 3_600_000;
const MAX_FUTURE_MS = 2 * 60_000;
const KEYS = new Set(['capturedAt', 'knownBalanceMinor']);

/** Normaliza `offline`. `undefined` = operación en línea. Una forma inválida es un 400 (la manda nuestro cliente). */
export function parseOffline(raw: unknown, now: Date = new Date()): OfflineCapture | null {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'INVALID_INPUT', 'offline must be an object', { field: 'offline' });
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.has(k))) throw new ApiError(400, 'INVALID_INPUT', 'offline has unknown fields', { field: 'offline' });
  const t = typeof o['capturedAt'] === 'string' ? Date.parse(o['capturedAt']) : Number.NaN;
  if (!Number.isFinite(t)) throw new ApiError(400, 'INVALID_INPUT', 'offline.capturedAt is required', { field: 'offline.capturedAt' });
  let knownBalanceMinor: number | null = null;
  if (o['knownBalanceMinor'] !== undefined) {
    const v = o['knownBalanceMinor'];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApiError(400, 'INVALID_INPUT', 'offline.knownBalanceMinor is invalid', { field: 'offline.knownBalanceMinor' });
    knownBalanceMinor = v;
  }
  // Un reloj de teléfono mal puesto es habitual en campo: la operación sigue, su hora no se toma como dato.
  if (t > now.getTime() + MAX_FUTURE_MS || t < now.getTime() - MAX_AGE_MS) {
    return { deviceCapturedAt: null, knownBalanceMinor, note: 'hora del dispositivo fuera de rango; no se guarda' };
  }
  return { deviceCapturedAt: new Date(t).toISOString(), knownBalanceMinor, note: null };
}

/** Solo el Cobrador opera sin conexión en esta versión (Administradores, Supervisor, Secretario: no). */
export function requireOfflineActor(ctx: ActiveContext): void {
  if (ctx.role !== 'cobrador') throw new ApiError(403, 'OFFLINE_NOT_ALLOWED', 'offline capture is only available to collectors');
}

/**
 * Un abono capturado sin conexión debe CABER en el saldo vigente (leído bajo el mismo bloqueo
 * que `collection_post`). Si no cabe, 409 para revisión: nunca se reescribe el importe.
 */
export async function assertOfflineFits(client: pg.PoolClient, saleId: string, amountMinor: number): Promise<number> {
  const balance = Number((await client.query<{ b: string }>('select adex.offline_collection_balance($1) b', [saleId])).rows[0]!.b);
  if (amountMinor > balance) {
    throw new ApiError(409, 'OFFLINE_AMOUNT_EXCEEDS_BALANCE', 'the payment captured offline exceeds the current balance',
      { balanceMinor: balance, requestedMinor: amountMinor });
  }
  return balance;
}

/** Evidencia de la captura, en la misma transacción y bajo savepoint (un fallo no revierte el movimiento). */
export async function storeOfflineCapture(client: pg.PoolClient, ctx: ActiveContext, c: {
  operationId: string; kind: OfflineKind; entityId: string; routeId: string; capture: OfflineCapture;
  /** 0040: gasto con un tipo que ya no está en la lista de Cobradores (se acepta y avisa al Administrador). Solo con 0040. */
  categoryOutsideList?: boolean;
}): Promise<'stored' | 'not_stored'> {
  await client.query('savepoint offline_capture');
  try {
    const flag = c.categoryOutsideList === true;
    await client.query(
      `insert into adex.offline_captures (company_id, operation_id, kind, entity_id, route_id, membership_id, device_captured_at,
                                          known_balance_minor, note, received_at${flag ? ', category_outside_list' : ''})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()${flag ? ', true' : ''})`,
      [ctx.companyId, c.operationId, c.kind, c.entityId, c.routeId, ctx.membershipId, c.capture.deviceCapturedAt,
       c.capture.knownBalanceMinor, c.capture.note]);
    await client.query('release savepoint offline_capture');
    return 'stored';
  } catch (e) {
    await client.query('rollback to savepoint offline_capture');
    await client.query('release savepoint offline_capture');
    const err = e as { code?: string; name?: string };
    process.stderr.write(`${JSON.stringify({ level: 'warn', t: new Date().toISOString(), msg: 'offline_capture_not_stored',
      code: err?.code ?? null, name: err?.name ?? 'Error', kind: c.kind, entityId: c.entityId })}\n`);
    return 'not_stored';
  }
}

/**
 * EXCLUSIVIDAD DE RUTA (Ronda 62): mientras una ruta tenga un Cobrador ACTIVO asignado, solo él
 * registra sus operaciones habituales con los clientes (abonos y visitas). Un Supervisor que va a
 * sustituirlo debe bloquearlo antes (desactivarlo o quitarle la ruta). Las operaciones de oficina
 * (Administrador, SuperAdmin: asignaciones, recargas, cobros a nombre del Cobrador) no cambian.
 */
export async function requireRouteNotHeldByCollector(client: pg.PoolClient, ctx: ActiveContext, routeId: string): Promise<void> {
  if (ctx.role !== 'supervisor') return;
  const held = (await client.query<{ n: string }>(
    `select count(*) n from adex.memberships m join adex.membership_routes mr on mr.company_id = m.company_id and mr.membership_id = m.id
      where m.company_id = $1 and mr.route_id = $2 and m.role = 'cobrador' and m.status = 'activo'`, [ctx.companyId, routeId])).rows[0]!.n;
  if (Number(held) > 0) {
    throw new ApiError(409, 'ROUTE_HAS_ACTIVE_COLLECTOR', 'the route has an active collector: block the collector before substituting');
  }
}

/** Llave del dispositivo de la membresía del contexto (la crea la primera vez). */
export async function offlineKey(client: pg.PoolClient, ctx: ActiveContext): Promise<{ key: string }> {
  requireOfflineActor(ctx);
  const key = (await client.query<{ k: Buffer }>('select adex.offline_key() k')).rows[0]!.k;
  return { key: key.toString('base64') };
}
