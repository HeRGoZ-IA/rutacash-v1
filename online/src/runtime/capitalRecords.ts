// LIBRO CENTRAL DEL SERVIDOR → REGISTROS DE CAPITAL CENTRALIZADO DE CLEAN (C1/C2).
//
// El servidor tiene UN libro de operaciones (GET /v1/capital/operations). CLEAN guarda las
// mismas operaciones del capital centralizado repartidas en varias tablas. Aquí cada
// operación del servidor se presenta con la forma del registro que CLEAN crea para ella
// (equivalencias documentadas en saas/src/capital/service.ts):
//
//   COMPANY_* / ADMIN_* / PARTNER_CONTRIBUTION  → capitalLedger
//   WORKER_DELIVERY       → capitalMovements (ENTREGA_TRABAJADOR) + cashCustodyMovements (BASE_ASSIGNMENT)
//   WORKER_RETURN         → withdrawals (DEVOLUCION_TRABAJADOR) + cashCustodyMovements (BASE_RETURN)
//   WORKER_TRANSFER       → cashCustodyMovements (PERSON_TO_PERSON)
//   ROUTE_REASSIGNMENT    → transfers (ruta → ruta) con sus dos patas de custodia
//   LOAN_DISBURSEMENT de la bolsa → capitalMovements (DESEMBOLSO_ADMIN)
//   COLLECTION a la bolsa         → withdrawals (COBRO_NO_PERSONAL)
//   ROUTE_EXPENSE de la bolsa     → capitalMovements (GASTO_RUTA)
//   SETTLEMENT_RETURN             → withdrawals (CUADRE)
//   REVERSAL              → el asiento espejo del mismo registro (importe negado, `reversesId`)
//
// Recaudos y desembolsos de la custodia de un trabajador, gastos y cuadres viven en sus
// propias tablas (pagos, ventas, gastos, cuadres), igual que en CLEAN.
//
// SOLO PARA LISTAR Y CONSULTAR. Ninguna cifra financiera se calcula sumando estos
// registros: los saldos (bolsas, custodias, Base) los da el servidor y los servicios del
// puente los leen de allí. El identificador de cada registro es el de la operación del
// servidor (así una anulación desde la pantalla anula esa operación exacta).

import type {
  CapitalLedgerEntry, CapitalMovement, CashCustodyMovement, CentralCapitalKind, PartnerCashMovement, Transfer, Withdrawal,
} from '@clean/models/types';
import { ApiFailure } from '../lib/client.ts';
import { toMajor } from './mappers.ts';
import { api, useRuntime } from './session.ts';

export interface ServerOperation {
  id: string; operationId: string; kind: string; amountMinor: number; routeId: string | null; toRouteId: string | null;
  adminId: string | null; workerId: string | null; counterpartId: string | null; saleRequestId: string | null;
  reversesOperationId: string | null; reversesKind: string | null; reason: string; entryDate: string;
  actorId: string; actorRole: string; createdAt: string;
}

export interface CapitalRecords {
  operations: ServerOperation[];
  /** El listado del servidor llegó a su tope: puede faltar historia antigua. */
  truncated: boolean;
  capitalLedger: CapitalLedgerEntry[];
  capitalMovements: CapitalMovement[];
  withdrawals: Withdrawal[];
  transfers: Transfer[];
  cashCustodyMovements: CashCustodyMovement[];
  /**
   * Pata de Caja socios de cada APORTE de socio (CLEAN C1: `registerPartnerContribution`
   * crea una «salida» del socio, categoría transferencia; su anulación, el espejo negativo).
   * Los ingresos y salidas MANUALES de Caja socios no existen en el servidor (decisión D1).
   */
  partnerCashMovements: PartnerCashMovement[];
}

const LIMIT = 500;

/** Operaciones visibles: el listado general y el de cada ruta (alcance por RLS), sin repetir. */
export async function fetchOperations(routeIds: string[]): Promise<{ operations: ServerOperation[]; truncated: boolean }> {
  const get = async (q: string) => {
    try {
      return (await api().get<{ operations: ServerOperation[] }>(`/v1/capital/operations?limit=${LIMIT}${q}`)).operations;
    } catch (e) {
      if (e instanceof ApiFailure && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  };
  const lists = await Promise.all([get(''), ...routeIds.map((r) => get(`&routeId=${encodeURIComponent(r)}`))]);
  const byId = new Map<string, ServerOperation>();
  for (const l of lists) for (const o of l) byId.set(o.id, o);
  return { operations: [...byId.values()], truncated: lists.some((l) => l.length >= LIMIT) };
}

const LEDGER_KINDS = ['COMPANY_DEPOSIT', 'COMPANY_WITHDRAWAL', 'ADMIN_ALLOCATION', 'ADMIN_RETURN', 'PARTNER_CONTRIBUTION'];

export function buildCapitalRecords(operations: ServerOperation[], truncated: boolean): CapitalRecords {
  const tenantId = useRuntime.getState().ctx?.company.id ?? '';
  const out: CapitalRecords = { operations, truncated, capitalLedger: [], capitalMovements: [], withdrawals: [], transfers: [], cashCustodyMovements: [], partnerCashMovements: [] };
  const sorted = [...operations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const o of sorted) {
    const rev = o.kind === 'REVERSAL';
    const k = rev ? o.reversesKind ?? '' : o.kind;
    const a = toMajor(o.amountMinor);
    const orig = o.reversesOperationId ?? undefined;
    const common = { fecha: o.entryDate, createdAt: o.createdAt };
    const reversal = rev ? { reversesId: orig, reversalReason: o.reason } : {};
    const link = (kind: CentralCapitalKind) => ({ kind, operationId: rev ? orig! : o.id });

    if (LEDGER_KINDS.includes(k)) {
      out.capitalLedger.push({
        id: o.id, tenantId, tipo: k as CapitalLedgerEntry['tipo'], amount: rev ? -a : a,
        fromAdminId: k === 'ADMIN_RETURN' ? o.adminId ?? undefined : undefined,
        toAdminId: k === 'ADMIN_ALLOCATION' || k === 'PARTNER_CONTRIBUTION' ? o.adminId ?? undefined : undefined,
        routeId: o.routeId ?? undefined, partnerId: k === 'PARTNER_CONTRIBUTION' ? o.counterpartId ?? undefined : undefined,
        descripcion: o.reason, ...common, actorUserId: o.actorId, actorRole: o.actorRole as CapitalLedgerEntry['actorRole'],
        status: 'aplicado', syncStatus: 'synced', ...reversal,
      });
      if (k === 'PARTNER_CONTRIBUTION' && o.counterpartId) {
        out.partnerCashMovements.push({
          id: `pc:${o.id}`, tenantId, partnerId: o.counterpartId, type: 'salida', category: 'transferencia', amount: rev ? -a : a,
          description: rev ? `Anulación de aporte: ${o.reason}` : o.reason, relatedLedgerEntryId: o.id, ...common, createdBy: o.actorId,
          ...(rev ? { reversesId: `pc:${orig}`, reversalReason: o.reason } : {}),
        });
      }
    } else if (k === 'WORKER_DELIVERY' && o.routeId) {
      const l = link(rev ? 'ANULACION_ENTREGA' : 'ENTREGA_TRABAJADOR');
      out.capitalMovements.push({
        id: o.id, tenantId, routeId: o.routeId, tipo: 'ingresoCapital', valor: rev ? -a : a, descripcion: o.reason, ...common,
        userId: o.actorId, adminId: o.adminId ?? undefined, centralLink: l, ...reversal,
      });
      out.cashCustodyMovements.push({
        id: `${o.id}:custodia`, tenantId, routeId: o.routeId, tipo: rev ? 'BASE_RETURN' : 'BASE_ASSIGNMENT', amount: a,
        toUserId: rev ? undefined : o.workerId ?? undefined, fromUserId: rev ? o.workerId ?? undefined : undefined,
        origen: 'admin-pool', centralLink: l, saleRequestId: o.saleRequestId ?? undefined, motivo: o.reason, ...common, createdByUserId: o.actorId,
        ...(rev ? { reversesId: `${orig}:custodia`, reversalReason: o.reason } : {}),
      });
    } else if (k === 'WORKER_RETURN' && o.routeId) {
      const l = link('DEVOLUCION_TRABAJADOR');
      out.withdrawals.push({
        id: o.id, tenantId, routeId: o.routeId, valor: rev ? -a : a, descripcion: o.reason, ...common, userId: o.actorId,
        adminId: o.adminId ?? undefined, centralLink: l, ...reversal,
      });
      out.cashCustodyMovements.push({
        id: `${o.id}:custodia`, tenantId, routeId: o.routeId, tipo: rev ? 'BASE_ASSIGNMENT' : 'BASE_RETURN', amount: a,
        fromUserId: rev ? undefined : o.workerId ?? undefined, toUserId: rev ? o.workerId ?? undefined : undefined,
        origen: 'admin-pool', centralLink: l, motivo: o.reason, ...common, createdByUserId: o.actorId,
        ...(rev ? { reversesId: `${orig}:custodia`, reversalReason: o.reason } : {}),
      });
    } else if (k === 'WORKER_TRANSFER' && o.routeId) {
      out.cashCustodyMovements.push({
        id: o.id, tenantId, routeId: o.routeId, tipo: 'PERSON_TO_PERSON', amount: a,
        fromUserId: (rev ? o.counterpartId : o.workerId) ?? undefined, toUserId: (rev ? o.workerId : o.counterpartId) ?? undefined,
        origen: 'route-cash', motivo: o.reason, ...common, createdByUserId: o.actorId, ...reversal,
      });
    } else if (k === 'ROUTE_REASSIGNMENT' && o.routeId && o.toRouteId) {
      out.transfers.push({
        id: o.id, tenantId, routeOrigenId: o.routeId, routeDestinoId: o.toRouteId, origenType: 'route', destinoType: 'route',
        valor: rev ? -a : a, descripcion: o.reason, ...common, userId: o.actorId, adminId: o.adminId ?? undefined, ...reversal,
      });
      out.cashCustodyMovements.push(
        { id: `${o.id}:origen`, tenantId, routeId: o.routeId, tipo: rev ? 'BASE_ASSIGNMENT' : 'BASE_RETURN', amount: a,
          ...(rev ? { toUserId: o.workerId ?? undefined } : { fromUserId: o.workerId ?? undefined }),
          origen: 'transfer', relatedTransferId: o.id, motivo: o.reason, ...common, createdByUserId: o.actorId },
        { id: `${o.id}:destino`, tenantId, routeId: o.toRouteId, tipo: rev ? 'BASE_RETURN' : 'BASE_ASSIGNMENT', amount: a,
          ...(rev ? { fromUserId: o.counterpartId ?? undefined } : { toUserId: o.counterpartId ?? undefined }),
          origen: 'transfer', relatedTransferId: o.id, motivo: o.reason, ...common, createdByUserId: o.actorId },
      );
    } else if (o.adminId && o.routeId && (k === 'LOAN_DISBURSEMENT' || k === 'ROUTE_EXPENSE')) {
      out.capitalMovements.push({
        id: o.id, tenantId, routeId: o.routeId, tipo: 'ingresoCapital', valor: rev ? -a : a, descripcion: o.reason, ...common,
        userId: o.actorId, adminId: o.adminId, centralLink: link(k === 'LOAN_DISBURSEMENT' ? 'DESEMBOLSO_ADMIN' : 'GASTO_RUTA'), ...reversal,
      });
    } else if (o.adminId && o.routeId && (k === 'COLLECTION' || k === 'SETTLEMENT_RETURN')) {
      out.withdrawals.push({
        id: o.id, tenantId, routeId: o.routeId, valor: rev ? -a : a, descripcion: o.reason, ...common, userId: o.actorId, adminId: o.adminId,
        centralLink: link(k === 'COLLECTION' ? (rev ? 'ANULACION_COBRO' : 'COBRO_NO_PERSONAL') : (rev ? 'REAPERTURA_CUADRE' : 'CUADRE')), ...reversal,
      });
    }
  }
  // Marca de anulado en el original (CLEAN la guarda en el registro; aquí sale del espejo).
  const mark = <T extends { id: string; reversesId?: string; createdAt: string; reversalReason?: string }>(list: T[], actor: (r: T) => string) => {
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const r of list) {
      if (!r.reversesId) continue;
      const original = byId.get(r.reversesId) as (T & { reversalId?: string; reversedAt?: string; reversedByUserId?: string }) | undefined;
      if (original) Object.assign(original, { reversalId: r.id, reversedAt: r.createdAt, reversedByUserId: actor(r), reversalReason: r.reversalReason });
    }
  };
  mark(out.capitalLedger, (r) => r.actorUserId);
  mark(out.capitalMovements, (r) => r.userId);
  mark(out.withdrawals, (r) => r.userId);
  mark(out.transfers, (r) => r.userId);
  mark(out.cashCustodyMovements, (r) => r.createdByUserId);
  mark(out.partnerCashMovements, (r) => r.createdBy ?? '');
  return out;
}
