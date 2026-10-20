// PUENTE de `src/components/ui/ModuleTabs.tsx` (CLEAN). Ronda 53: sin «Caja socios» (el rol
// Socio y su caja no existen en ADEX Online). Las pestañas y el componente, idénticos.
import { CASHBOX_TABS as CLEAN_CASHBOX_TABS } from '@clean/components/ui/ModuleTabs';

export * from '@clean/components/ui/ModuleTabs';
export const CASHBOX_TABS = CLEAN_CASHBOX_TABS.filter((t) => t.to !== '/admin/partner-cash');
