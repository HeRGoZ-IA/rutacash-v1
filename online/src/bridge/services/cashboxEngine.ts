// PUENTE de `src/services/cashboxEngine.ts` (CLEAN).
//
// CLEAN calcula la BASE de una ruta sumando su libro local (capital, cobros, préstamos,
// gastos, transferencias, retiros). En ADEX Online ese libro es el del SERVIDOR:
//
//   · BASE DE LA RUTA = efectivo de la ruta esté donde esté (definición oficial de
//     CLEAN). Con capital centralizado —el único modelo del SaaS— la ruta no tiene caja
//     propia: todo su efectivo está en manos de sus trabajadores. Por tanto la Base es
//     Σ posiciones de custodia de la ruta (GET /v1/capital/custody), saldos que mantiene
//     PostgreSQL. No se reconstruye nada en el navegador.
//   · CARTERA EN CALLE = Σ saldo (capital + interés) de ventas activas desembolsadas: la
//     MISMA fórmula de CLEAN (`carteraEnCalleOf`, original) sobre los saldos de cada
//     crédito que devuelve el servidor. No es `portfolioMinor` del resumen de capital, que
//     solo cuenta capital pendiente.
//   · Los resúmenes de caja por rango (`getCashboxSummary`, caja del cobrador) dependen del
//     libro local y quedan sin conectar: lanzan `ServerGap`.

import type { RouteFinancialSummary } from '@clean/models/types';
import { carteraEnCalleOf } from '@clean/services/cashboxEngine';
import { db } from '@/lib/db';
import { custodyPositions, ServerGap } from '../../runtime/projection.ts';
import { toMajor } from '../../runtime/mappers.ts';

export * from '@clean/services/cashboxEngine';
import * as Clean from '@clean/services/cashboxEngine';

/** Base de la ruta: Σ custodia de sus trabajadores (servidor). */
async function getRouteBaseOnline(routeId: string): Promise<number> {
  const positions = await custodyPositions();
  return toMajor(positions.filter((p) => p.routeId === routeId).reduce((s, p) => s + p.balanceMinor, 0));
}

function getRouteAvailableCapitalOnline(routeId: string): Promise<number> {
  return getRouteBaseOnline(routeId);
}

async function getRoutesCurrentBalanceOnline(routeIds: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const routeId of routeIds) result[routeId] = await getRouteBaseOnline(routeId);
  return result;
}

async function getRouteFinancialSummaryOnline(routeId: string): Promise<RouteFinancialSummary> {
  const baseActual = await getRouteBaseOnline(routeId);
  const sales = await db.sales.where('routeId').equals(routeId).toArray();
  const activas = sales.filter((s) => s.status === 'activa' && s.disbursementStatus !== 'pendiente');
  const carteraEnCalle = carteraEnCalleOf(sales);
  const interesPorCobrarEstimado = Math.round(activas.reduce((sum, s) => {
    if (s.valorTotal <= 0) return sum;
    return sum + (Math.max(0, s.saldo) * s.valorInteres) / s.valorTotal;
  }, 0));
  return {
    routeId,
    baseActual,
    carteraEnCalle,
    totalControlado: baseActual + carteraEnCalle,
    ventasActivas: activas.length,
    clientesActivos: new Set(activas.map((s) => s.clientId)).size,
    interesPorCobrarEstimado,
  };
}

async function getRoutesFinancialSummaryOnline(routeIds: string[]): Promise<Record<string, RouteFinancialSummary>> {
  const result: Record<string, RouteFinancialSummary> = {};
  for (const routeId of routeIds) result[routeId] = await getRouteFinancialSummaryOnline(routeId);
  return result;
}

// Resúmenes del libro local por rango: sin conectar (ver cabecera).
async function getCashboxSummaryOnline(): Promise<never> { throw new ServerGap('cashboxSummary'); }
function getRouteLedgerOnline(): Promise<never> { return Promise.reject(new ServerGap('cashboxSummary')); }
async function getCapitalFlowBreakdownOnline(): Promise<never> { throw new ServerGap('capitalFlowBreakdown'); }
async function getCollectorDailyCashSummaryOnline(): Promise<never> { throw new ServerGap('collectorCash'); }
async function getCollectorCashSummaryOnline(): Promise<never> { throw new ServerGap('collectorCash'); }
/** La API valida los fondos al desembolsar (INSUFFICIENT_FUNDS): aquí no se decide. */
async function hasCapitalForSaleOnline(): Promise<boolean> { return true; }

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const getRouteBase = getRouteBaseOnline as unknown as typeof Clean.getRouteBase;
export const getRouteAvailableCapital = getRouteAvailableCapitalOnline as unknown as typeof Clean.getRouteAvailableCapital;
export const getRoutesCurrentBalance = getRoutesCurrentBalanceOnline as unknown as typeof Clean.getRoutesCurrentBalance;
export const getRouteFinancialSummary = getRouteFinancialSummaryOnline as unknown as typeof Clean.getRouteFinancialSummary;
export const getRoutesFinancialSummary = getRoutesFinancialSummaryOnline as unknown as typeof Clean.getRoutesFinancialSummary;
export const getCashboxSummary = getCashboxSummaryOnline as unknown as typeof Clean.getCashboxSummary;
export const getRouteLedger = getRouteLedgerOnline as unknown as typeof Clean.getRouteLedger;
export const getCapitalFlowBreakdown = getCapitalFlowBreakdownOnline as unknown as typeof Clean.getCapitalFlowBreakdown;
export const getCollectorDailyCashSummary = getCollectorDailyCashSummaryOnline as unknown as typeof Clean.getCollectorDailyCashSummary;
export const getCollectorCashSummary = getCollectorCashSummaryOnline as unknown as typeof Clean.getCollectorCashSummary;
export const hasCapitalForSale = hasCapitalForSaleOnline as unknown as typeof Clean.hasCapitalForSale;
