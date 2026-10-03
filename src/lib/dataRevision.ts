// ============================================================
// CAMBIOS EN LA BASE LOCAL — SEÑAL ÚNICA DE REFRESCO (sin React)
// ------------------------------------------------------------
// Auditoría de actualización local (2026-09-24): las vistas administrativas
// calculaban bien, pero SOLO al montarse. Con dos ventanas abiertas en el mismo
// navegador (Cobrador en una, Admin en otra) el pago ya estaba en IndexedDB y el
// Dashboard seguía mostrando la cifra vieja hasta navegar o pulsar F5.
//
// Dexie emite `storagemutated` al confirmar CUALQUIER transacción de escritura, y
// lo reenvía a las demás pestañas del MISMO origen por BroadcastChannel. Aquí se
// filtra por tabla para que una escritura irrelevante (auditoría, telemetría de
// login) no recalcule pantallas financieras.
//
// Alcance honesto: esto funciona dentro de UNA IndexedDB (mismo navegador, mismo
// perfil, mismo origen). Entre dispositivos distintos no llega nada: no hay backend.
// ============================================================
import Dexie from 'dexie'

/** Tablas cuyo cambio altera cifras operativas o financieras visibles. */
export const OPERATIONAL_TABLES = [
  'payments', 'sales', 'installments', 'expenses', 'capitalMovements', 'transfers',
  'withdrawals', 'clients', 'routes', 'users', 'offices', 'weeklySettlements',
  'cashSettlements', 'saleRequests', 'cashCustodyMovements', 'partnerCashMovements',
] as const

/**
 * Tablas que mueven la BASE de la ruta: exactamente las que lee `getRouteLedger`.
 * La custodia (`cashCustodyMovements`) y los cuadres no la cambian: solo dicen QUIÉN
 * tiene el efectivo, así que no obligan a releer la Base.
 */
export const ROUTE_BASE_TABLES = [
  'capitalMovements', 'payments', 'sales', 'expenses', 'transfers', 'withdrawals',
] as const

/**
 * Tablas tocadas en un aviso de Dexie. Las claves tienen la forma
 * `idb://<base>/<tabla>/<índice>`; se extrae `<tabla>`.
 */
export function mutatedTables(parts: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(parts ?? {})) {
    const m = /^idb:\/\/[^/]+\/([^/]+)\//.exec(key)
    if (m) out.add(m[1])
  }
  return out
}

/** ¿El aviso afecta a alguna de `tables`? */
export function touchesTables(parts: Record<string, unknown> | null | undefined, tables: readonly string[]): boolean {
  const tocadas = mutatedTables(parts)
  return tables.some(t => tocadas.has(t))
}

/**
 * Se suscribe a los cambios confirmados de `tables` (misma pestaña y otras pestañas
 * del mismo navegador). Devuelve la función para cancelar la suscripción.
 */
export function subscribeDataChanges(
  tables: readonly string[],
  onChange: (tablasTocadas: Set<string>) => void,
): () => void {
  const handler = (parts: Record<string, unknown>) => {
    if (touchesTables(parts, tables)) onChange(mutatedTables(parts))
  }
  Dexie.on.storagemutated.subscribe(handler)
  return () => Dexie.on.storagemutated.unsubscribe(handler)
}

/**
 * LECTURA VIVA (sin React): ejecuta `query` ya y la repite tras cada escritura
 * confirmada en `tables`, con la misma señal y la misma agrupación de ráfagas que
 * `useDataRevision`. Es lo que usa un hook cuyo único dato es UNA consulta (la Base
 * de una ruta): así no hay estado capturado al montar que se quede viejo.
 *
 * Solo se publica la respuesta de la ÚLTIMA lectura lanzada: si una lectura anterior
 * termina tarde (otra ruta, una revisión ya superada), se descarta. Tras llamar a la
 * función devuelta no se publica nada más y la suscripción queda cancelada.
 * Una lectura que falla conserva el último valor publicado.
 */
export function watchQuery<T>(
  tables: readonly string[],
  query: () => Promise<T>,
  onValue: (value: T) => void,
  debounceMs = 150,
): () => void {
  let seq = 0
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    const mine = ++seq
    query().then(value => { if (!closed && mine === seq) onValue(value) }, () => {})
  }
  const unsubscribe = subscribeDataChanges(tables, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, debounceMs)
  })
  run()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}
