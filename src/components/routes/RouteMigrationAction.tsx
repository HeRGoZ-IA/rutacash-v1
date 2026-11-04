import type { Route } from '@/models/types'

/**
 * Acción «Poner en migración / Cancelar migración» de una ruta (SaaS 0043).
 *
 * En CLEAN (local) no existe la migración de rutas: no muestra nada. ADEX Online sustituye este
 * módulo por su puente (`online/src/bridge/components/routes/RouteMigrationAction.tsx`), que habla
 * con la API. Solo el SuperAdmin la ve.
 */
export function RouteMigrationAction(_props: { route: Route; isSuperadmin: boolean }) {
  return null
}
