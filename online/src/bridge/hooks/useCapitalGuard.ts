// PUENTE de `src/hooks/useCapitalGuard.ts` (CLEAN). Ronda 73 · SOC-02: misma guarda y misma forma,
// medida contra el dinero que pagaría la venta (`saleFunds`), no contra la antigua caja de ruta.
// El servidor vuelve a decidir dentro de su transacción (fondos, responsable, límite de la ruta).
import { useCallback } from 'react';
import { can } from '@/lib/permissions';
import { useAuth } from '@/hooks/useAuth';
import { useRouteCapital } from '@/hooks/useRouteCapital';
import { saleFunds } from '../services/saleFunds.ts';

export function useCapitalGuard(routeId: string | undefined | null, valorVenta: number) {
  const { user } = useAuth();
  const puedeVerMonto = can(user, 'cashbox.viewRoute', { routeId: routeId ?? undefined });
  const { available: capital, loading } = useRouteCapital(routeId);
  const exceeded = capital != null && valorVenta > capital;

  const recheck = useCallback(async (valor: number) => {
    if (!routeId) return { exceeded: false, available: null as number | null };
    const funds = await saleFunds(routeId).catch(() => null);
    return { exceeded: funds != null && valor > funds, available: puedeVerMonto ? funds : null };
  }, [routeId, puedeVerMonto]);

  return { exceeded, available: puedeVerMonto ? capital : null, canSeeAmount: puedeVerMonto, loading, recheck };
}
