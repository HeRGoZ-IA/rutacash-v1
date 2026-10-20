// PUENTE de `src/lib/routeAssignments.ts` (CLEAN). Ronda 53: ADEX Online no tiene el rol
// Socio; la vista de asignaciones por ruta no muestra su grupo. El resto, idéntico.
import { ASSIGNMENT_ROLE_ORDER as CLEAN_ORDER } from '@clean/lib/routeAssignments';

export * from '@clean/lib/routeAssignments';
export const ASSIGNMENT_ROLE_ORDER = CLEAN_ORDER.filter((r) => r.rol !== 'socio');
