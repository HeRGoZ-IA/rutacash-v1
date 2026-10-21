// COPIA DE CONSULTA PARA TRABAJAR SIN CONEXIÓN (Ronda 62).
//
// La proyección de lectura (runtime/projection.ts) pide cada tabla al servidor. Para el Cobrador,
// cada respuesta del servidor se guarda CIFRADA en el dispositivo; si después el servidor no está
// al alcance (sin red o caído), la misma lectura se responde con la última copia y la pantalla
// sabe que son datos de la hora en que se guardaron (`useOffline.dataSavedAt`).
//
// Límites deliberados:
//   · Solo las tablas que el Cobrador necesita para cobrar en su ruta (lista de abajo).
//   · Solo ante FALTA DE CONEXIÓN. Un 403/404/409 del servidor NUNCA se tapa con la copia.
//   · La copia no se modifica en el dispositivo: los abonos capturados sin conexión no descuentan
//     saldos aquí (se muestran aparte como pendientes). Las cifras vigentes son las del servidor.

import { ApiFailure, NetworkFailure } from '../lib/client.ts';
import { getSnapshot, putSnapshot } from './vault.ts';
import { currentScope, useOffline } from './state.ts';

/** Entradas de la proyección que se conservan para consultar sin conexión. */
const CACHEABLE = new Set([
  'table:tenants', 'table:users', 'table:routes', 'table:offices', 'table:clients', 'table:sales', 'table:saleRequests',
  'table:installments', 'table:payments', 'table:noPaymentVisits', 'table:expenseCategories', 'table:expenses',
  'view:/v1/periods/calendar',
  // Ronda 65: tipos de documento del país (alta de clientes sin conexión).
  'view:/v1/document-types',
]);

/** ¿El fallo es de CONEXIÓN (no hay respuesta útil del servidor)? Solo entonces se usa la copia. */
export function isConnectivityError(e: unknown): boolean {
  if (e instanceof NetworkFailure) return true;
  return e instanceof ApiFailure && (e.status >= 500 || e.code === 'HTTP_502' || e.code === 'HTTP_503' || e.code === 'HTTP_504');
}

const lastWritten = new Map<string, string>();
const staleSince = new Map<string, string>();

function publishFreshness(): void {
  const times = [...staleSince.values()].sort();
  useOffline.setState({ dataSavedAt: times[0] ?? null });
}

/** Lectura con copia: en línea guarda lo recibido; sin conexión responde con lo último guardado. */
export async function withOfflineCopy<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
  const c = CACHEABLE.has(cacheKey) ? currentScope() : null;
  if (!c) return load();
  try {
    const value = await load();
    if (staleSince.delete(cacheKey)) publishFreshness();
    const json = JSON.stringify(value);
    const memo = `${c.scope.membershipId}|${cacheKey}`;
    if (lastWritten.get(memo) !== json) {
      lastWritten.set(memo, json);
      // Solo si el contexto sigue siendo el mismo (tras cerrar sesión no se vuelve a escribir).
      if (currentScope()?.scope === c.scope) void putSnapshot(c.scope, c.key, cacheKey, value).catch(() => lastWritten.delete(memo));
    }
    return value;
  } catch (e) {
    if (!isConnectivityError(e)) throw e;
    const snap = await getSnapshot<T>(c.scope, c.key, cacheKey);
    if (!snap) throw e;
    staleSince.set(cacheKey, snap.savedAt);
    publishFreshness();
    return snap.value;
  }
}

/** Cambio de contexto: la frescura publicada era de la membresía anterior. */
export function resetFreshness(): void {
  staleSince.clear();
  // Tras cerrar sesión o cambiar de contexto se vuelve a guardar todo (la copia anterior pudo borrarse).
  lastWritten.clear();
  publishFreshness();
}
