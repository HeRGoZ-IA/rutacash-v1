// PUENTE de `src/lib/dataRevision.ts` (CLEAN): misma API («la base cambió, vuelve a
// leer»), pero la señal no viene de IndexedDB sino de la proyección del servidor: sube
// tras cada comando confirmado por la API y con el refresco periódico. Así
// `useDataRevision` y las pantallas que lo usan funcionan sin cambios.

import { subscribe } from '../../runtime/projection.ts';

export const OPERATIONAL_TABLES = [
  'payments', 'sales', 'installments', 'expenses', 'capitalMovements', 'transfers',
  'withdrawals', 'clients', 'routes', 'users', 'offices', 'weeklySettlements',
  'cashSettlements', 'saleRequests', 'cashCustodyMovements', 'partnerCashMovements',
] as const;

export const ROUTE_BASE_TABLES = [
  'capitalMovements', 'payments', 'sales', 'expenses', 'transfers', 'withdrawals',
] as const;

export function mutatedTables(): Set<string> { return new Set(); }
export function touchesTables(): boolean { return false; }

export function subscribeDataChanges(tables: readonly string[], onChange: (tablasTocadas: Set<string>) => void): () => void {
  return subscribe((touched) => {
    if (tables.some((t) => touched.has(t))) onChange(touched);
  });
}

export function watchQuery<T>(tables: readonly string[], query: () => Promise<T>, onValue: (value: T) => void, debounceMs = 150): () => void {
  let seq = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    const mine = ++seq;
    query().then((value) => { if (!closed && mine === seq) onValue(value); }, () => {});
  };
  const unsubscribe = subscribeDataChanges(tables, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  });
  run();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
