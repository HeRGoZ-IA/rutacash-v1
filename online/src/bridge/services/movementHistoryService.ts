// ADEX Online: COPIA de `src/services/movementHistoryService.ts` (CLEAN). Mismo alcance y
// misma proyección (`lib/movementHistory`, original), sobre los registros del libro
// central del servidor (ver runtime/capitalRecords.ts) y sus gastos. Único cambio, marcado:
// Caja socios no existe en el servidor (decisión D1), así que no aporta registros.
// ============================================================
// HISTORIAL UNIFICADO — CONSULTA CON ALCANCE (Ronda 5/6)
// ------------------------------------------------------------
// El ALCANCE se aplica aquí, ANTES de proyectar (`lib/movementHistory`): ninguna
// pantalla recibe registros que el actor no pueda ver, y los filtros (también los
// que llegan por URL) solo ESTRECHAN ese conjunto.
//
//   · SuperAdmin: todo lo de su empresa.
//   · Administrador:
//       libro de capital  → solo los asientos de SU bolsa (de/para él);
//       colocación/retiro → los de sus rutas autorizadas y los de su bolsa;
//       transferencias    → las que están en su alcance (o de su bolsa);
//       Base y custodia   → las de sus rutas autorizadas;
//       gastos            → regla de `listVisibleExpenses` (rutas + su bolsa +
//                           históricos que él registró);
//       Caja socios       → socios vinculados a sus rutas.
//     Un Administrador secundario ve los registros de la ruta como hoy en Capital y
//     Transferencias, pero nunca la bolsa ni los gastos de otro Administrador.
//   · Supervisor, Cobrador, Socio, Secretario: sin acceso (no es su módulo).
// ============================================================
import { db, type RutaCashDB } from '@/lib/db'
import { authorizedRouteIdsOf, canAccessRoute, isPartnerInScope, isTransferInScope } from '@/lib/permissions'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { canViewCompanyExpense } from '@/lib/expenseFunding'
import { buildMovementHistory, filterMovementHistory, type HistoryEntry, type HistoryFilters } from '@/lib/movementHistory'
import { AuthzError } from '@/services/authz'
import type { User } from '@/models/types'

/** ¿Puede `actor` consultar el historial? (UI; el servicio revalida). */
export function canViewMovementHistory(actor: User | null | undefined, tenantId: string): boolean {
  return !!actor && actor.status === 'activo' && actor.tenantId === tenantId && (actor.rol === 'superadmin' || actor.rol === 'admin')
}

export async function listMovementHistory(
  params: { actor: User | null | undefined; tenantId: string; filtros?: HistoryFilters },
  database: RutaCashDB = db,
): Promise<HistoryEntry[]> {
  const { actor, tenantId } = params
  if (!canViewMovementHistory(actor, tenantId)) throw new AuthzError('No tienes acceso al historial de movimientos.')
  const [users, ledger, capitalMovements, withdrawals, transfers, custody, expenses] = await Promise.all([
    database.users.where('tenantId').equals(tenantId).toArray(),
    database.capitalLedger.where('tenantId').equals(tenantId).toArray(),
    database.capitalMovements.where('tenantId').equals(tenantId).toArray(),
    database.withdrawals.where('tenantId').equals(tenantId).toArray(),
    database.transfers.where('tenantId').equals(tenantId).toArray(),
    database.cashCustodyMovements.where('tenantId').equals(tenantId).toArray(),
    database.expenses.where('tenantId').equals(tenantId).toArray(),
  ])
  // ADEX Online: sin Caja socios en el servidor (D1).
  const partnerCash: Awaited<ReturnType<typeof database.partnerCashMovements.toArray>> = []
  const a = actor!
  const sa = a.rol === 'superadmin'
  const ruta = (routeId?: string) => !!routeId && canAccessRoute(a, routeId)
  const partnerRoutes = (socioId: string) => authorizedRouteIdsOf(users.find(u => u.id === socioId))
  const transfersVisibles = sa ? transfers : transfers.filter(t => t.adminId === a.id || isTransferInScope(a, t, partnerRoutes))
  const idsTransfer = new Set(transfersVisibles.map(t => t.id))
  const sources = {
    ledger: sa ? ledger : ledger.filter(e => e.fromAdminId === a.id || e.toAdminId === a.id),
    capitalMovements: sa ? capitalMovements : capitalMovements.filter(m => m.adminId === a.id || ruta(m.routeId)),
    withdrawals: sa ? withdrawals : withdrawals.filter(w => w.adminId === a.id || ruta(w.routeId)),
    transfers: transfersVisibles,
    // Patas de transferencias visibles + custodia de sus rutas.
    custody: sa ? custody : custody.filter(c => ruta(c.routeId) || (!!c.relatedTransferId && idsTransfer.has(c.relatedTransferId))),
    expenses: sa ? expenses : expenses.filter(e => (e.routeId ? ruta(e.routeId) : canViewCompanyExpense(a, e))),
    partnerCash: sa ? partnerCash : partnerCash.filter(p => (p.relatedTransferId ? idsTransfer.has(p.relatedTransferId) : isPartnerInScope(a, partnerRoutes(p.partnerId)))),
    hasCashbox: (id: string) => { const u = users.find(x => x.id === id); return !!u && hasPersonalCashbox(u.rol) },
  }
  return filterMovementHistory(buildMovementHistory(sources), params.filtros ?? {})
}

/** Una entrada por su referencia canónica (`fuente:id`), con el MISMO alcance. */
export async function getMovementEntry(
  params: { actor: User | null | undefined; tenantId: string; key: string },
  database: RutaCashDB = db,
): Promise<HistoryEntry | null> {
  const todas = await listMovementHistory({ actor: params.actor, tenantId: params.tenantId }, database)
  return todas.find(e => e.key === params.key) ?? null
}
