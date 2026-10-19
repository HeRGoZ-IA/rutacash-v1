// PUENTE de `src/services/routeFundsService.ts` (CLEAN): fondos de la CAJA DE LA RUTA (v16).
//
// En el servidor (capital centralizado) la ruta no tiene caja: no se coloca ni se retira
// capital de una ruta, y su disponible es 0. Las operaciones con Caja socios (Ruta → Socio,
// Socio → Socio) dependen de la decisión D1 y no existen en el servidor. Estas funciones
// explican la situación en vez de registrar nada en el dispositivo. El aporte de un socio a
// la bolsa del responsable SÍ existe (centralCapitalService.registerPartnerContribution).

import { RouteFundsError } from '@clean/services/routeFundsService';
import * as Clean from '@clean/services/routeFundsService';

export * from '@clean/services/routeFundsService';

const NO_CAJA = 'En ADEX Online la ruta no tiene caja propia (capital centralizado): el capital se entrega a los trabajadores desde la bolsa del responsable.';
const SIN_SOCIOS = 'Las operaciones con Caja socios (Ruta → Socio y entre socios) no existen en el servidor de ADEX Online: dependen de la decisión D1.';

async function noCaja(): Promise<never> { throw new RouteFundsError(NO_CAJA); }
async function sinSocios(): Promise<never> { throw new RouteFundsError(SIN_SOCIOS); }
async function getRouteAvailableFundsOnline(): Promise<number> { return 0; }

export const registerCapital = noCaja as unknown as typeof Clean.registerCapital;
export const registerWithdrawal = noCaja as unknown as typeof Clean.registerWithdrawal;
export const registerTransfer = sinSocios as unknown as typeof Clean.registerTransfer;
export const getRouteAvailableFunds = getRouteAvailableFundsOnline as unknown as typeof Clean.getRouteAvailableFunds;
