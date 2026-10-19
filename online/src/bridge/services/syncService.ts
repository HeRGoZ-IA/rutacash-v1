// PUENTE de `src/services/syncService.ts` (CLEAN). En ADEX Online no hay cola local: cada
// abono, gasto o visita se confirma en el servidor al registrarlo (DS-07, solo en línea).
// Nada queda pendiente en el dispositivo, así que no hay nada que confirmar después.

import type { SyncResult } from '@clean/services/syncService';

export * from '@clean/services/syncService';
import * as Clean from '@clean/services/syncService';

async function getPendingSyncCountOnline(): Promise<number> { return 0; }
async function syncPendingItemsOnline(): Promise<SyncResult> { return { synced: 0, errors: 0, deferred: 0 }; }

export const getPendingSyncCount = getPendingSyncCountOnline as unknown as typeof Clean.getPendingSyncCount;
export const syncPendingItems = syncPendingItemsOnline as unknown as typeof Clean.syncPendingItems;
