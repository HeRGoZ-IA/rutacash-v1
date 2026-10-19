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
//   · «Mi recaudo hoy» del Cobrador (`getCollectorDailyCashSummary`) es el ORIGINAL: suma
//     sus abonos, desembolsos y gastos del día, que la proyección trae del servidor.
//   · El ciclo personal por rango (`getCollectorCashSummary`) es el del servidor (vista
//     previa del cuadre, `cashSettlementService`).
//   · CAJA de la ruta por rango (`getCashboxSummary`) y su desglose de capital: cifras de
//     la liquidación del servidor, línea a línea (`runtime/cashboxFigures.ts`).

import type { RouteFinancialSummary } from '@clean/models/types';
import { carteraEnCalleOf } from '@clean/services/cashboxEngine';
import { db } from '@/lib/db';
import { calendar, custodyPositions, serverView, ServerGap } from '../../runtime/projection.ts';
import { cashboxFromFigures, flowFromFigures } from '../../runtime/cashboxFigures.ts';
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Figures = Record<string, any>;
const FLOW_KEYS = ['deliveriesMinor', 'transfersInMinor', 'transfersOutMinor', 'partialReturnsMinor', 'settlementReturnsMinor', 'collectionsMinor',
  'disbursementsMinor', 'workerExpensesMinor', 'otherMinor'];
const POOL_KEYS = ['collectionsReceivedMinor', 'deliveredToWorkersMinor', 'returnsReceivedMinor', 'routeExpensesMinor', 'disbursedFromPoolMinor',
  'partnerContributionsMinor', 'surplusHeldMinor'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

function liquidationOf(routeId: string, from: string, to: string): Promise<Figures> {
  return serverView<Figures>(`/v1/periods/liquidation?routeId=${encodeURIComponent(routeId)}&from=${from}&to=${to}`);
}

/**
 * Liquidación del servidor de una ruta y un rango (`GET /v1/periods/liquidation`,
 * `cashbox.viewRoute`). Como en CLEAN, un rango vacío (fin antes del inicio) no tiene
 * movimientos: apertura = cierre = saldo al inicio. El servidor admite hasta 366 días por
 * consulta: un rango mayor se pide por tramos y se suman sus flujos (apertura del primero,
 * cierre del último).
 */
async function figures(routeId: string, desde: string, hasta: string): Promise<Figures> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || hasta < desde) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? desde : ymd(new Date());
    const f = await liquidationOf(routeId, d, d);
    const c = f['custody'] ?? {};
    return { custody: { openingMinor: c.openingMinor ?? 0, closingMinor: c.openingMinor ?? 0 }, pool: {} };
  }
  const parts: Figures[] = [];
  for (let from = desde; from <= hasta; from = addDays(from, 366)) {
    const to = addDays(from, 365) < hasta ? addDays(from, 365) : hasta;
    parts.push(await liquidationOf(routeId, from, to));
  }
  if (parts.length === 1) return parts[0]!;
  const custody: Record<string, number> = { openingMinor: parts[0]!['custody']?.openingMinor ?? 0, closingMinor: parts[parts.length - 1]!['custody']?.closingMinor ?? 0 };
  const pool: Record<string, number> = {};
  for (const p of parts) {
    for (const k of FLOW_KEYS) custody[k] = (custody[k] ?? 0) + Number(p['custody']?.[k] ?? 0);
    for (const k of POOL_KEYS) pool[k] = (pool[k] ?? 0) + Number(p['pool']?.[k] ?? 0);
  }
  return { custody, pool };
}

/** Caja de la ruta en el rango: cifras del libro del servidor (`runtime/cashboxFigures.ts`). */
async function getCashboxSummaryOnline(routeId: string, desde: string, hasta: string) {
  return cashboxFromFigures(routeId, await figures(routeId, desde, hasta));
}
async function getCapitalFlowBreakdownOnline(routeId: string, desde: string, hasta: string) {
  return flowFromFigures(await figures(routeId, desde, hasta));
}
/** Caja ACUMULADA de la ruta (CLEAN `getRouteLedger`: desde su alta hasta hoy). */
async function getRouteLedgerOnline(routeId: string) {
  const route = await db.routes.get(routeId);
  const hoy = (await calendar()).businessDate;
  const desde = route?.createdAt ? route.createdAt.slice(0, 10) : hoy;
  return cashboxFromFigures(routeId, await figures(routeId, desde < hoy ? desde : hoy, hoy));
}
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
export const getCollectorCashSummary = getCollectorCashSummaryOnline as unknown as typeof Clean.getCollectorCashSummary;
export const hasCapitalForSale = hasCapitalForSaleOnline as unknown as typeof Clean.hasCapitalForSale;
