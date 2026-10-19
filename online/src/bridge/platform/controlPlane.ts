// PUENTE de `src/platform/controlPlane.ts` (CLEAN). El plano de control local de CLEAN
// no existe en ADEX Online (el Owner es un servicio separado, DS-17). Se exporta un
// objeto inerte para que las llamadas de telemetría de las pantallas no hagan nada.

export * from '@clean/platform/controlPlane';
import type { SaaSControlPlane } from '@clean/platform/controlPlane';

export const controlPlane = new Proxy({}, { get: () => async () => undefined }) as unknown as SaaSControlPlane;
