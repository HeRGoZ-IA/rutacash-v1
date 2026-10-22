// PUENTE de `src/hooks/useRouteCapital.ts` (CLEAN). Ronda 73 · SOC-02: en ADEX Online el límite de
// una venta nueva es el dinero que la PAGARÍA (`saleFunds`: bolsa del Administrador responsable o
// custodia propia del trabajador), no la antigua caja de ruta. Misma forma que el original: el valor
// es VIVO (se relee tras cada escritura que mueve dinero) y pertenece a SU ruta. `null` = sin límite
// conocido en pantalla (decide el servidor).
import { useEffect, useState } from 'react';
import { ROUTE_BASE_TABLES, watchQuery } from '@/lib/dataRevision';
import { saleFunds } from '../services/saleFunds.ts';

export function useRouteCapital(routeId: string | undefined | null) {
  const [state, setState] = useState<{ routeId: string; value: number | null } | null>(null);

  useEffect(() => {
    if (!routeId) return;
    return watchQuery(ROUTE_BASE_TABLES, () => saleFunds(routeId).catch(() => null), (value) => setState({ routeId, value }));
  }, [routeId]);

  const resolved = Boolean(routeId) && state?.routeId === routeId;
  return { available: resolved ? state!.value : null, loading: Boolean(routeId) && !resolved };
}
