// PUENTE de `src/platform/types.ts` (CLEAN): los mismos tipos y etiquetas. Ronda 40: el
// historial del servidor Owner registra además quién asignó el Super Admin, los enlaces de
// primer acceso emitidos y la edición de los datos de la empresa (0021).

export * from '@clean/platform/types';
import { CONTROL_EVENT_LABEL as CLEAN_EVENT_LABEL, type ControlEventType } from '@clean/platform/types';

export const CONTROL_EVENT_LABEL = {
  ...CLEAN_EVENT_LABEL,
  SUPERADMIN_ASSIGNED: 'Super Admin asignado',
  ACCESS_LINK_ISSUED: 'Enlace de primer acceso emitido',
  COMPANY_UPDATED: 'Datos de la empresa actualizados',
} as Record<ControlEventType, string>;
