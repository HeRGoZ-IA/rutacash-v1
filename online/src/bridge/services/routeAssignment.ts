// PUENTE de `src/services/routeAssignment.ts` (CLEAN). Las asignaciones de rutas de una
// persona viven en el servidor (membresía ↔ rutas). `PUT /v1/members/:id/routes` aplica
// en UNA transacción las mismas reglas de CLEAN: el Cobrador asignado pasa a ser el
// responsable de cobro de la ruta (la asignación más reciente gana), se libera al quitarla
// y se reconcilia el responsable de capital.

import { plain } from '../../runtime/commands.ts';
import { memberId } from '../../runtime/writeAdapters.ts';

export * from '@clean/services/routeAssignment';
import * as Clean from '@clean/services/routeAssignment';

async function setCobradorRoutesOnline(userId: string, routeIds: string[]): Promise<void> {
  await plain('PUT', `/v1/members/${memberId(userId)}/routes`, { routeIds: [...new Set(routeIds)] });
}

/**
 * CLEAN quitaba a la persona como Cobrador responsable de sus rutas antes de guardar
 * otro rol. En el servidor solo un Cobrador puede ser responsable de cobro y las rutas se
 * fijan a continuación con el conjunto completo: no hay nada que limpiar aparte.
 */
async function clearRouteResponsibilitiesOnline(_userId: string): Promise<void> { /* lo resuelve el servidor */ }

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const setCobradorRoutes = setCobradorRoutesOnline as unknown as typeof Clean.setCobradorRoutes;
export const clearRouteResponsibilities = clearRouteResponsibilitiesOnline as unknown as typeof Clean.clearRouteResponsibilities;
