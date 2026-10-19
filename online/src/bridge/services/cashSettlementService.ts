// PUENTE de `src/services/cashSettlementService.ts` (CLEAN): cuadre por trabajador contra
// el servidor (Fase 6). La fórmula de CLEAN es la misma que calcula PostgreSQL bajo
// bloqueo (`adex.custody_preview` / `adex.custody_settle`):
//
//     arrastre anterior + base recibida − base devuelta + recaudado − desembolsado − gastos = esperado
//
// Aquí NO se calcula nada: la vista previa es la del servidor y el cierre lo hace el
// servidor con id de operación (un doble toque no cierra dos veces). El esperado que vio
// la pantalla viaja como `expectedSeenMinor`: si las cifras cambiaron, el servidor lo
// rechaza (SETTLEMENT_STALE) y la pantalla vuelve a leer, igual que en CLEAN.
//
// Equivalencias (servidor → CLEAN):
//   · arrastre anterior = apertura del ciclo (faltante pendiente o posición negativa del
//     cuadre anterior) + reaperturas y otros ajustes del ciclo;
//   · base recibida     = entregas del Administrador + traspasos recibidos;
//   · base devuelta     = devoluciones parciales + traspasos entregados.
// Listados de cuadres y faltantes pendientes: originales de CLEAN sobre la proyección.

import type { CashSettlement, User } from '@clean/models/types';
import { CashSettlementError, type CashSettlementPreview, type CloseCashSettlementParams } from '@clean/services/cashSettlementService';
import { hasPersonalCashbox } from '@clean/lib/collectorAttribution';
import { db } from '@/lib/db';
import { can } from '@/lib/permissions';
import { generateId } from '@/lib/utils';
import { money } from '../../runtime/commands.ts';
import { cashSettlementFrom, toMajor, toMinor, userFrom } from '../../runtime/mappers.ts';
import { capitalRecords, serverView, settleableWorkers } from '../../runtime/projection.ts';

export * from '@clean/services/cashSettlementService';
import * as Clean from '@clean/services/cashSettlementService';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

async function asSettlementError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new CashSettlementError(e instanceof Error ? e.message : String(e));
  }
}

/** Inicio del ciclo abierto: el último cuadre vigente o, si no hay, el primer movimiento de su custodia. */
async function cycleStart(routeId: string, userId: string, previousClosedAt: string | null): Promise<string> {
  if (previousClosedAt) return new Date(previousClosedAt).toISOString();
  const movs = (await capitalRecords()).cashCustodyMovements
    .filter((m) => m.routeId === routeId && (m.toUserId === userId || m.fromUserId === userId))
    .map((m) => m.createdAt).filter(Boolean).sort();
  return movs[0] ?? new Date().toISOString();
}

async function previewCashSettlementOnline(params: { actor: User | null | undefined; tenantId: string; routeId: string; userId: string }): Promise<CashSettlementPreview> {
  return asSettlementError(async () => {
    const p = await serverView<Json>(`/v1/settlements/preview?routeId=${encodeURIComponent(params.routeId)}&workerId=${encodeURIComponent(params.userId)}`);
    const c = (p['cycle'] ?? {}) as Json;
    const route = await db.routes.get(params.routeId);
    const desde = await cycleStart(params.routeId, params.userId, p['previousClosedAt'] ?? null);
    return {
      tenantId: params.tenantId, routeId: params.routeId, routeName: route?.nombre ?? '',
      userId: params.userId, userName: p['workerName'] ?? '', userRol: p['workerRole'],
      desde, hasta: new Date().toISOString(),
      origenDesde: p['previousSettlementId'] ? 'ultimo-cierre' : 'inicio-modelo',
      previousSettlementId: p['previousSettlementId'] ?? undefined,
      arrastreAnterior: toMajor((c['openingMinor'] ?? 0) + (c['reopenedSettlementsMinor'] ?? 0) + (c['otherMinor'] ?? 0)),
      baseRecibida: toMajor((c['baseDeliveredMinor'] ?? 0) + (c['transfersInMinor'] ?? 0)),
      baseDevuelta: toMajor((c['partialReturnsMinor'] ?? 0) + (c['transfersOutMinor'] ?? 0)),
      recaudado: toMajor(c['collectedMinor']), desembolsado: toMajor(c['disbursedMinor']), gastos: toMajor(c['expensesMinor']),
      // Posición esperada (puede ser negativa: gastos del trabajador mayores que su efectivo), como en CLEAN.
      esperado: toMajor(p['expectedPositionMinor']),
      modelStart: desde,
    } as CashSettlementPreview;
  });
}

async function closeCashSettlementOnline(params: CloseCashSettlementParams): Promise<CashSettlement> {
  return asSettlementError(async () => {
    const preview = await serverView<Json>(`/v1/settlements/preview?routeId=${encodeURIComponent(params.routeId)}&workerId=${encodeURIComponent(params.userId)}`);
    const body: Json = {
      routeId: params.routeId, workerId: params.userId, deliveredMinor: toMinor(Number(params.entregado)),
      expectedSeenMinor: toMinor(params.esperadoVisto ?? toMajor(preview['expectedPositionMinor'])),
    };
    if (preview['previousSettlementId']) body['previousSettlementId'] = preview['previousSettlementId'];
    if (params.motivo?.trim()) body['reason'] = params.motivo.trim();
    const r = await money<Json>('POST', '/v1/settlements', body, generateId());
    return cashSettlementFrom(r['settlement'] ?? r);
  });
}

async function reopenCashSettlementOnline(params: { actor: User | null | undefined; settlementId: string; motivo: string }): Promise<CashSettlement> {
  return asSettlementError(async () => {
    const r = await money<Json>('POST', `/v1/settlements/${params.settlementId}/reopen`, { reason: (params.motivo ?? '').trim() }, generateId());
    return cashSettlementFrom(r['settlement'] ?? r);
  });
}

/** Trabajadores cuadrables de la ruta, del servidor (incluye a quien conserva custodia sin estar asignado). */
async function listSettleableWorkersOnline(actor: User | null | undefined, tenantId: string, routeId: string): Promise<{ user: User; esPropio: boolean }[]> {
  if (!can(actor, 'cashSettlement.view', { routeId, tenantId })) return [];
  const list = await settleableWorkers(routeId);
  return list.workers
    .filter((w) => hasPersonalCashbox(w.role as User['rol']))
    .map((w) => ({
      user: userFrom({ membershipId: w.workerId, role: w.role, status: w.status, displayName: w.name, routeIds: w.assigned ? [routeId] : [] }),
      esPropio: w.own,
    }));
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const previewCashSettlement = previewCashSettlementOnline as unknown as typeof Clean.previewCashSettlement;
export const closeCashSettlement = closeCashSettlementOnline as unknown as typeof Clean.closeCashSettlement;
export const reopenCashSettlement = reopenCashSettlementOnline as unknown as typeof Clean.reopenCashSettlement;
export const listSettleableWorkers = listSettleableWorkersOnline as unknown as typeof Clean.listSettleableWorkers;
