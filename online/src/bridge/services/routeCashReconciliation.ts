// PUENTE de `src/services/routeCashReconciliation.ts` (CLEAN): efectivo de una ruta.
//
// En el servidor (capital centralizado) la ruta NO tiene caja: todo su efectivo está en la
// custodia de sus trabajadores (GET /v1/capital/custody). Por eso, con el mismo significado
// que CLEAN en su modelo centralizado:
//   · posición de cada persona = su custodia en la ruta (saldo del servidor);
//   · arrastre = faltante arrastrado de su último cuadre (servidor);
//   · en manos de trabajadores = Σ posiciones = Base de la ruta;
//   · sin asignar («saldo heredado») = 0 y disponible de la caja = 0: no existe caja de ruta.
// El desglose del libro local de CLEAN (capital, transferencias, retiros, recaudado por
// persona…) no se reconstruye: queda NaN («—» si una pantalla lo mostrara).

import type { User } from '@clean/models/types';
import type { RouteCashReconciliation } from '@clean/services/routeCashReconciliation';
import * as Clean from '@clean/services/routeCashReconciliation';
import { carteraEnCalleOf } from '@clean/services/cashboxEngine';
import { assertCan } from '@clean/services/authz';
import { db } from '@/lib/db';
import { custodyPositions } from '../../runtime/projection.ts';
import { toMajor } from '../../runtime/mappers.ts';

export * from '@clean/services/routeCashReconciliation';

const N = Number.NaN;

async function computeOnline(params: { tenantId: string; routeId: string; hasta?: string }): Promise<RouteCashReconciliation> {
  const { tenantId, routeId } = params;
  const route = await db.routes.get(routeId);
  if (!route) throw new Error('La ruta no existe en esta empresa.');
  const [positions, users, sales] = await Promise.all([
    custodyPositions(), db.users.toArray(), db.sales.where('routeId').equals(routeId).toArray(),
  ]);
  const mine = positions.filter((p) => p.routeId === routeId);
  const personas = mine.map((p) => {
    const u = users.find((x) => x.id === p.workerId);
    return {
      userId: p.workerId, nombre: u?.nombre ?? p.workerName, rol: (u?.rol ?? p.role) as User['rol'], status: u?.status ?? 'activo',
      asignada: !!u?.authorizedRouteIds?.includes(routeId), cicloDesde: '', arrastreAnterior: toMajor(p.carriedMinor),
      baseRecibida: N, baseDevuelta: N, recaudado: N, desembolsado: N, gastos: N, posicion: toMajor(p.balanceMinor),
    };
  });
  const enPersonas = personas.reduce((s, p) => s + p.posicion, 0);
  const activas = sales.filter((s) => s.status === 'activa' && s.disbursementStatus !== 'pendiente');
  return {
    tenantId, routeId, routeName: route.nombre, hasta: params.hasta ?? new Date().toISOString(), modelStart: '',
    libro: { capital: N, transferenciasEntrada: N, transferenciasSalida: N, retiros: N, cobros: N, desembolsos: N, gastos: N, saldo: enPersonas },
    estructural: N, personas, enPersonas,
    // Sin caja de ruta en el servidor: nada sin asignar y nada que mover desde la caja.
    noAsignado: 0,
    explicacionNoAsignado: { estructural: N, operacionNoPersonal: N, baseEntregadaNeta: N, entregadoEnCuadres: N, sobrantesRegistrados: N, total: 0 },
    // Identidad Base = Σ posiciones: se cumple por construcción en el libro central.
    cuadra: true,
    efectivoFisicoNoAsignado: 0, disponible: 0,
    faltantes: mine.filter((p) => p.carriedMinor > 0).map((p) => ({ userId: p.workerId, nombre: p.workerName, monto: toMajor(p.carriedMinor), settlementId: '' })),
    sobrantes: [], cuadresVigentes: N,
    cartera: { carteraEnCalle: carteraEnCalleOf(sales), ventasActivas: activas.length },
    movimientosEstructurales: { capital: [], transferencias: [], retiros: [] },
    custodia: await db.cashCustodyMovements.where('routeId').equals(routeId).toArray(),
  } as RouteCashReconciliation;
}

async function getOnline(params: { actor: User | null | undefined; tenantId: string; routeId: string }): Promise<RouteCashReconciliation> {
  assertCan(params.actor, 'cashbox.viewRoute', { routeId: params.routeId, tenantId: params.tenantId });
  return computeOnline({ tenantId: params.tenantId, routeId: params.routeId });
}

async function computeBreakdownOnline(params: { tenantId: string; routeId: string }) {
  return Clean.routeBaseBreakdown(await computeOnline(params));
}

// Firmas ORIGINALES de CLEAN.
export const computeRouteCashReconciliation = computeOnline as unknown as typeof Clean.computeRouteCashReconciliation;
export const getRouteCashReconciliation = getOnline as unknown as typeof Clean.getRouteCashReconciliation;
export const computeRouteBaseBreakdown = computeBreakdownOnline as unknown as typeof Clean.computeRouteBaseBreakdown;
