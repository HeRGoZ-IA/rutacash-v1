// PUENTE de `src/platform/types.ts` (CLEAN): los mismos tipos y etiquetas. Ronda 40: el
// historial del servidor Owner registra además quién asignó el Super Admin, los enlaces de
// primer acceso emitidos y la edición de los datos de la empresa (0021). Ronda 54: cambio del
// correo de acceso de un Super Admin (0024).

export * from '@clean/platform/types';
import { CONTROL_EVENT_LABEL as CLEAN_EVENT_LABEL, type ControlEventType } from '@clean/platform/types';

export const CONTROL_EVENT_LABEL = {
  ...CLEAN_EVENT_LABEL,
  SUPERADMIN_ASSIGNED: 'Super Admin asignado',
  ACCESS_LINK_ISSUED: 'Enlace de primer acceso emitido',
  COMPANY_UPDATED: 'Datos de la empresa actualizados',
  // Ronda 54 (0024).
  SUPERADMIN_EMAIL_CHANGED: 'Correo del Super Admin cambiado',
} as Record<ControlEventType, string>;
