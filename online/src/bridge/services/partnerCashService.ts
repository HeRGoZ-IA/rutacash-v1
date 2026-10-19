// PUENTE de `src/services/partnerCashService.ts` (CLEAN): Caja socios.
//
// Lo que existe en el servidor se muestra con la pantalla original: la «salida» de cada
// APORTE de socio a la bolsa de un Administrador (y su anulación), vista del libro central
// (`runtime/capitalRecords.ts`). Los ingresos y salidas MANUALES de Caja socios no existen
// en el servidor: decidir si la caja de un socio debe tener fondos, de dónde salen y cómo se
// concilia con el capital es la decisión de negocio D1, que sigue pendiente. Registrar uno
// se rechaza diciendo exactamente eso (no se guarda nada ni se aproxima).

import { PartnerCashError } from '@clean/services/partnerCashService';

export * from '@clean/services/partnerCashService';
import * as Clean from '@clean/services/partnerCashService';

async function createPartnerMovementOnline(): Promise<never> {
  throw new PartnerCashError('Los ingresos y salidas manuales de Caja socios todavía no se registran en ADEX Online: '
    + 'está pendiente la decisión de negocio D1 (si la caja de un socio debe tener fondos y cómo se concilia con el capital). '
    + 'Los aportes de socio a una bolsa sí se registran, desde Transferencias.');
}

export const createPartnerMovement = createPartnerMovementOnline as unknown as typeof Clean.createPartnerMovement;
