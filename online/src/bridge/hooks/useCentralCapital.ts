// PUENTE de `src/hooks/useCentralCapital.ts` (CLEAN). En el SaaS el capital centralizado
// no se «activa»: es el único modelo desde la creación de la empresa (Fase 3). Las
// pantallas reciben `activo` sin fecha de activación (no existe y no se inventa), sin
// bloqueos de ruta ni saldo heredado (la caja de ruta nunca existió en el servidor).
// R74 · Base por Ruta: `baseRuta` cuando la empresa usa `route_base` (o está migrando): las pantallas
// hablan de la Base de la ruta, no de la bolsa del responsable.

import type { CentralCapitalState } from '@clean/hooks/useCentralCapital';
import { isRouteBaseUi, useCapitalModel } from '../../runtime/routeBase/api.ts';

export type { CentralCapitalState };

const STATE: CentralCapitalState = { listo: true, activo: true, bloqueos: {}, heredadoAlActivar: {} };
const STATE_RB: CentralCapitalState = { ...STATE, baseRuta: true };

export function useCentralCapital(_tenantId: string): CentralCapitalState {
  return isRouteBaseUi(useCapitalModel()) ? STATE_RB : STATE;
}
