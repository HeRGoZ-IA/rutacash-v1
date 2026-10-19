// PUENTE de `src/platform/companyControlService.ts` (CLEAN). El plano Owner es OTRO
// servicio (DS-17): la empresa nunca escribe en él. La telemetría que CLEAN registraba
// desde el navegador (último ingreso, métricas de rutas) la produce el servidor de
// empresas por su cuenta (`adex_control.record_company_login` al elegir contexto; las
// rutas se cuentan en el plano de control). Aquí no se hace nada.

export * from '@clean/platform/companyControlService';
import type * as Clean from '@clean/platform/companyControlService';

async function noop(): Promise<void> { /* lo registra el servidor */ }

export const recordTenantLogin = noop as unknown as typeof Clean.recordTenantLogin;
export const syncRouteMetrics = noop as unknown as typeof Clean.syncRouteMetrics;
