// ============================================================
// FIXTURE DE CAPITAL POR ADMINISTRADOR (v16) — compartido por las suites
// ------------------------------------------------------------
// Desde v16 una ruta solo opera su caja con un Administrador RESPONSABLE de capital
// (`Route.capitalControllerAdminId`) y el capital que coloca sale de SU bolsa.
// Las suites anteriores a v16 sembraban rutas y usuarios directamente en la base;
// este helper deja esas empresas en el estado que habrían alcanzado por la vía real:
//
//   · cada ruta indicada → su responsable (regla del primer Admin);
//   · cada responsable → una bolsa con `fondos` (ingreso a la empresa + asignación
//     del SuperAdmin), para que colocar capital en sus rutas no dependa del monto.
//
// No toca movimientos, pagos ni cuadres: solo añade lo que v16 exige.
// ============================================================
import type { CapitalLedgerEntry, Route } from '../../src/models/types'

interface CapitalFixtureDb {
  routes: { update(key: string, changes: Partial<Route>): Promise<number> }
  capitalLedger: { add(item: CapitalLedgerEntry): Promise<unknown> }
}

export const FONDOS_FIXTURE = 1_000_000_000_000

export async function sembrarResponsables(
  db: CapitalFixtureDb,
  tenantId: string,
  responsables: Record<string, string>,
  fondos = FONDOS_FIXTURE,
): Promise<void> {
  const ahora = '2026-01-01T00:00:00.000Z'
  for (const [routeId, adminId] of Object.entries(responsables)) {
    await db.routes.update(routeId, { capitalControllerAdminId: adminId, capitalControllerSince: ahora })
  }
  const admins = [...new Set(Object.values(responsables))]
  if (admins.length === 0 || fondos <= 0) return
  const base = { tenantId, fecha: '2026-01-01', createdAt: ahora, actorUserId: 'fixture', actorRole: 'superadmin' as const, status: 'aplicado' as const, syncStatus: 'synced' as const }
  await db.capitalLedger.add({ ...base, id: `fx-dep-${tenantId}`, tipo: 'COMPANY_DEPOSIT', amount: fondos * admins.length })
  for (const adminId of admins) {
    await db.capitalLedger.add({ ...base, id: `fx-alloc-${tenantId}-${adminId}`, tipo: 'ADMIN_ALLOCATION', amount: fondos, toAdminId: adminId })
  }
}
