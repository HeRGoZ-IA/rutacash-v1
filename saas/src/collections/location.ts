// UBICACIÓN DEL COBRO (Ronda 48 · 0022). El dispositivo informa una lectura; el servidor
// la trata como DATO NO CONFIABLE: nunca autoriza nada con ella, solo la guarda como
// evidencia complementaria. Una lectura imposible o malformada no se descarta en
// silencio ni bloquea el abono: queda como `invalid` con el motivo, sin coordenadas.

import type pg from 'pg';
import type { ActiveContext } from '../authz/context.ts';

export type LocationStatus = 'captured' | 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'invalid';

export interface LocationRecord {
  status: LocationStatus;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  capturedAt: string | null;
  reason: string | null;
}

const CLIENT_STATUSES = new Set(['captured', 'denied', 'unavailable', 'timeout', 'unsupported']);
const KEYS = new Set(['status', 'lat', 'lng', 'accuracyM', 'capturedAt', 'reason']);
/** Ventana aceptada para la hora de captura del dispositivo frente al reloj del servidor. */
const MAX_PAST_MS = 15 * 60_000;
const MAX_FUTURE_MS = 2 * 60_000;

const invalid = (reason: string): LocationRecord => ({ status: 'invalid', lat: null, lng: null, accuracyM: null, capturedAt: null, reason });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Normaliza la lectura enviada con el abono. `undefined` = el cliente no envió nada
 * (frontend anterior): no se registra fila. Cualquier otra cosa produce un registro.
 */
export function parseLocation(raw: unknown, now: Date = new Date()): LocationRecord | null {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalid('formato no válido');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.has(k))) return invalid('campos no admitidos');
  const status = o['status'];
  if (typeof status !== 'string' || !CLIENT_STATUSES.has(status)) return invalid('estado desconocido');

  if (status !== 'captured') {
    if (o['lat'] !== undefined || o['lng'] !== undefined || o['accuracyM'] !== undefined || o['capturedAt'] !== undefined) {
      return invalid('coordenadas sin lectura válida');
    }
    const reason = typeof o['reason'] === 'string' ? o['reason'].trim().slice(0, 200) || null : null;
    return { status: status as LocationStatus, lat: null, lng: null, accuracyM: null, capturedAt: null, reason };
  }

  const lat = o['lat'], lng = o['lng'];
  if (!finite(lat) || !finite(lng)) return invalid('coordenadas ausentes o no numéricas');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return invalid('coordenadas fuera de rango');
  if (lat === 0 && lng === 0) return invalid('coordenadas 0,0');
  let accuracyM: number | null = null;
  if (o['accuracyM'] !== undefined) {
    if (!finite(o['accuracyM']) || o['accuracyM'] < 0 || o['accuracyM'] > 100_000) return invalid('precisión no válida');
    accuracyM = Math.round(o['accuracyM']);
  }
  if (o['reason'] !== undefined) return invalid('motivo con lectura válida');
  let capturedAt: string | null = null;
  let reason: string | null = null;
  if (o['capturedAt'] !== undefined) {
    const t = typeof o['capturedAt'] === 'string' ? Date.parse(o['capturedAt']) : Number.NaN;
    if (!Number.isFinite(t)) return invalid('hora de captura no válida');
    // Un reloj de teléfono mal puesto es habitual en campo: la posición se conserva, pero
    // su hora no se toma como dato (queda la de recepción del servidor) y se anota.
    if (t < now.getTime() - MAX_PAST_MS || t > now.getTime() + MAX_FUTURE_MS) reason = 'hora del dispositivo desfasada; no se guarda';
    else capturedAt = new Date(t).toISOString();
  }
  return { status: 'captured', lat, lng, accuracyM, capturedAt, reason };
}

/**
 * Guarda la ubicación del abono recién registrado DENTRO de un savepoint: si algo
 * fallara, se deshace solo la ubicación y el abono (ya asentado) sigue en pie.
 * Devuelve el estado guardado, o `not_stored` si no pudo escribirse.
 */
export async function storePaymentLocation(
  client: pg.PoolClient, ctx: ActiveContext,
  p: { paymentId: string; routeId: string; location: LocationRecord },
): Promise<LocationStatus | 'not_stored'> {
  await client.query('savepoint payment_location');
  try {
    await client.query(
      `insert into adex.payment_locations (company_id, payment_id, route_id, captured_by_membership_id, status, lat, lng,
                                           accuracy_m, device_captured_at, reason, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [ctx.companyId, p.paymentId, p.routeId, ctx.membershipId, p.location.status, p.location.lat, p.location.lng,
       p.location.accuracyM, p.location.capturedAt, p.location.reason]);
    await client.query('release savepoint payment_location');
    return p.location.status;
  } catch (e) {
    await client.query('rollback to savepoint payment_location');
    await client.query('release savepoint payment_location');
    // Rastro operativo SIN coordenadas: solo el código SQL (p. ej. 42P01 si falta 0022).
    const err = e as { code?: string; name?: string };
    process.stderr.write(`${JSON.stringify({ level: 'warn', t: new Date().toISOString(), msg: 'payment_location_not_stored',
      code: err?.code ?? null, name: err?.name ?? 'Error', paymentId: p.paymentId })}\n`);
    return 'not_stored';
  }
}

/**
 * ¿Está aplicada 0022 en esta base? `/healthz` solo anuncia `payment-location-v1` si es
 * así: la puerta de Vercel exige la función, de modo que el frontend nuevo nunca se
 * publica contra una API cuyo esquema aún no tiene la tabla (Ronda 48).
 */
export async function paymentLocationsReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.payment_locations');
}

/** Ronda 53: `admin-transfers-v1` solo si 0023 está aplicada (sin Socio, con traspasos entre Administradores). */
export async function adminTransfersReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.admin_transfers');
}

/** Ronda 59 (0025): solicitudes de capital y entregas voluntarias. */
export async function capitalRequestsReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.capital_requests');
}

/** Ronda 62 (0026): modo sin conexión del Cobrador (capturas, llave del dispositivo, saldo bajo bloqueo). */
export async function offlineCollectorReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.offline_captures');
}

/**
 * Ronda 65 (0027): desembolsos sin conexión. La migración amplía la restricción de tipos de
 * `adex.offline_captures`; se anuncia solo si ya admite 'disbursement'.
 */
export async function offlineDisbursementsReady(pool: pg.Pool, attempts = 3): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await pool.query<{ ok: boolean }>(
        `select coalesce(bool_or(pg_get_constraintdef(oid) like '%disbursement%'), false) as ok from pg_constraint
          where conrelid = to_regclass('adex.offline_captures') and conname = 'offline_captures_kind_check'`);
      return r.rows[0]?.ok === true;
    } catch {
      if (i === attempts) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * i));
    }
  }
  return false;
}

/** Ronda 67 (0028 + 0029): mapa del Administrador y cartera de solo lectura del SuperAdmin. */
export async function routeMapReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.client_locations');
}

/** Ronda 73 (0031): una sola sesión activa por identidad. */
export async function singleSessionReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.identity_active_sessions');
}

/** Ronda 73 (0030): parcelas en la autorización y rectificación de créditos desembolsados. */
export async function creditRectificationReady(pool: pg.Pool): Promise<boolean> {
  return relationExists(pool, 'adex.credit_rectifications');
}

/**
 * R74 Base por Ruta (0034): modelo de capital por empresa, Base por ruta, entregas y panel.
 * UN solo intento: corre después de las comprobaciones anteriores, que ya reintentan; con la base
 * inaccesible, más reintentos alargarían el arranque por encima del margen de Render (RND-002).
 */
export async function routeBaseReady(pool: pg.Pool): Promise<boolean> {
  try {
    const r = await pool.query<{ ok: boolean }>("select to_regprocedure('adex.route_base_post(uuid,text,bigint,text,text,text,text)') is not null as ok");
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** R74 (0035, D74-O4F): gastos generales con aportes de rutas o dinero propio, y reembolsos a Administradores. */
export async function generalExpensesReady(pool: pg.Pool): Promise<boolean> {
  try {
    const r = await pool.query<{ ok: boolean }>("select to_regprocedure('adex.general_expense_post(uuid,text,text,bigint,text,text,text,jsonb)') is not null as ok");
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** R74 (0036, §15): conciliación de diferencias por el Administrador (RB-D3) y control de desactivación (RB-D1). */
export async function adminAuthorityReady(pool: pg.Pool): Promise<boolean> {
  try {
    const r = await pool.query<{ ok: boolean }>("select to_regprocedure('adex.difference_resolve(uuid,text,text,text,bigint,text)') is not null as ok");
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** Bloque A post-R73 (0032): rectificación con pagos y reaplicación de pagos anulados. */
export async function rectificationPaymentsReady(pool: pg.Pool): Promise<boolean> {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await pool.query<{ ok: boolean }>("select to_regprocedure('adex.collection_reapply(uuid,text,text)') is not null as ok");
      return r.rows[0]?.ok === true;
    } catch {
      if (i === 3) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * i));
    }
  }
  return false;
}

/**
 * ¿Existe la relación? Con REINTENTOS (Ronda 59): la primera conexión de un proceso recién
 * arrancado en Render suele fallar (base en frío). Antes, ese fallo dejaba sin anunciar la
 * primera función comprobada (`payment-location-v1`) hasta otro reinicio, y la puerta de Vercel
 * bloqueaba el frontend. Una respuesta negativa real (la tabla no existe) no se reintenta.
 */
async function relationExists(pool: pg.Pool, name: string, attempts = 3): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await pool.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [name]);
      return r.rows[0]?.ok === true;
    } catch {
      if (i === attempts) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * i));
    }
  }
  return false;
}
