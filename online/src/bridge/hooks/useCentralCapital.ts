// PUENTE de `src/hooks/useCentralCapital.ts` (CLEAN). En el SaaS el capital centralizado
// no se «activa»: es el único modelo desde la creación de la empresa (Fase 3). Las
// pantallas reciben `activo` sin fecha de activación (no existe y no se inventa), sin
// bloqueos de ruta ni saldo heredado (la caja de ruta nunca existió en el servidor).

import type { CentralCapitalState } from '@clean/hooks/useCentralCapital';

export type { CentralCapitalState };

const STATE: CentralCapitalState = { listo: true, activo: true, bloqueos: {}, heredadoAlActivar: {} };

export function useCentralCapital(_tenantId: string): CentralCapitalState {
  return STATE;
}
