// PUENTE de `src/services/auditService.ts` (CLEAN). En ADEX Online la AUDITORÍA la
// escribe el SERVIDOR dentro de la misma transacción de cada comando (actor, membresía,
// rol, antes/después, motivo): es más fuerte que el registro local de CLEAN, que se
// guardaba después y aparte. Por eso `logAction` no escribe nada en el dispositivo.
// Si el comando principal no llegó al servidor, no hay nada que auditar.

import type * as Clean from '@clean/services/auditService';

async function logActionOnline(): Promise<void> { /* auditoría en el servidor */ }

export const logAction = logActionOnline as unknown as typeof Clean.logAction;
