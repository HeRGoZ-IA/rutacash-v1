// PUENTE de `src/services/capitalControlService.ts` (CLEAN) — Capital de la empresa y
// bolsas de Administradores sobre el libro central del servidor.
//
// CIFRAS: solo las que el servidor tiene con el MISMO significado que CLEAN (capital
// centralizado):
//   · disponible de la empresa y de cada bolsa ............ GET /v1/capital/summary
//   · capital neto recibido del SuperAdmin, aportes de socios (por bolsa) . summary
//   · gastos administrativos de una bolsa (neto) .. fórmula de CLEAN sobre los gastos del
//     servidor con esa bolsa (si el listado está completo)
// Las que CLEAN obtiene de su libro local y el servidor NO tiene («capital total
// controlado», «asignado» = disponible + en rutas, «en rutas», capital colocado por ruta,
// «en rutas sin responsable», conciliación de la bolsa) se entregan como NaN: la pantalla
// las muestra como «—» y explica por qué. Nunca se reconstruyen con otra fórmula.
//
// COMANDOS: ingreso y retiro de capital de la empresa, asignación y devolución de una bolsa
// (POST /v1/capital/...) con id de operación; cambio de responsable de capital de una ruta
// (PUT /v1/routes/:id/capital-controller). El servidor valida autoridad, fondos y concurrencia.

import type { CapitalLedgerEntry, Expense, RouteCapitalControllerEvent, User } from '@clean/models/types';
import type { PoolMovement, PoolMovementKind, PoolStatement } from '@clean/lib/adminPoolStatement';
import { centralPoolKind } from '@clean/lib/adminPoolStatement';
import { expenseFundingOf, poolExpenseStateOf } from '@clean/lib/expenseFunding';
import { reversalStateOf } from '@clean/lib/movementReversal';
import { CapitalControlError } from '@clean/services/capitalControlService';
import * as Clean from '@clean/services/capitalControlService';
import { db } from '@/lib/db';
import { money as moneyCommand, plain } from '../../runtime/commands.ts';
import { capitalRecords, calendar, serverView, table, truncated } from '../../runtime/projection.ts';
import { toMajor, toMinor } from '../../runtime/mappers.ts';
import { useRuntime } from '../../runtime/session.ts';
import { ApiFailure } from '../../lib/client.ts';

export * from '@clean/services/capitalControlService';

interface AdminPool {
  adminId: string; name: string; status: string; availableMinor: number; allocatedNetMinor: number; partnerContributionsMinor: number;
}
interface Summary {
  company?: { availableMinor: number; partnerContributionsMinor: number };
  admins: AdminPool[];
}
interface Reconciliation { ok: boolean; checks: { name: string; ok: boolean; detail: number }[] }

const SIN_DATO = Number.NaN;
const caps = () => useRuntime.getState().ctx?.capabilities ?? [];

function summary(): Promise<Summary> {
  return serverView<Summary>('/v1/capital/summary');
}

/** Gastos administrativos netos de la bolsa: fórmula de CLEAN (gastos con esa bolsa). */
async function poolExpenses(adminId: string): Promise<{ total: number; list: Expense[] }> {
  const list = (await db.expenses.toArray()).filter((x) => {
    const f = expenseFundingOf(x);
    return f.kind === 'admin' && f.adminId === adminId;
  });
  const complete = !truncated.has('/v1/expenses?limit=500');
  return { total: complete ? list.reduce((s, x) => s + x.valor, 0) : SIN_DATO, list };
}

const CHECK_TEXT: Record<string, string> = {
  'positions-match-ledger': 'saldos materializados distintos de la suma de sus asientos',
  'operations-balanced': 'operaciones que no cuadran',
  'no-overdraft': 'cuentas en sobregiro',
  'single-currency': 'operaciones en otra moneda',
  'capital-conserved': 'el capital no se conserva',
  'disbursements-have-credit': 'desembolsos sin crédito',
  'credits-have-disbursement': 'créditos sin desembolso',
  'one-credit-per-request': 'solicitudes con más de un crédito',
  'portfolio-matches-credits': 'cartera distinta de sus créditos',
  'negative-custody-only-by-worker-expense': 'custodias negativas no explicadas por gastos del trabajador',
  'credits-match-installments-and-payments': 'créditos que no cuadran con cuotas y pagos',
  'payments-have-ledger-entry': 'pagos sin asiento',
  'expenses-have-ledger-entry': 'gastos sin asiento',
  'expense-accounts-match-expenses': 'cuentas de gasto distintas de sus gastos',
  'carried-matches-last-settlement': 'arrastres distintos del último cuadre',
  'settlements-match-ledger': 'cuadres distintos del libro',
  'surplus-control-matches-settlements': 'sobrantes en control distintos de los cuadres',
  'closed-periods-unchanged': 'periodos cerrados modificados',
};

async function getCapitalOverviewOnline(params: { actor: User | null | undefined; tenantId: string }) {
  const [s, routes, recon] = await Promise.all([
    summary(),
    table('routes'),
    caps().includes('capital.allocateAdmins')
      ? serverView<Reconciliation>('/v1/capital/reconciliation').catch((e) => (e instanceof ApiFailure && e.status === 403 ? null : Promise.reject(e)))
      : Promise.resolve(null),
  ]);
  const rutasDe = (adminId: string) => routes.filter((r) => r['capitalControllerAdminId'] === adminId).map((r) => ({ routeId: String(r['id']), colocado: SIN_DATO }));
  const admins = await Promise.all(s.admins.map(async (a) => ({
    adminId: a.adminId, asignadoPorEmpresa: toMajor(a.allocatedNetMinor), aportesSocios: toMajor(a.partnerContributionsMinor),
    asignado: SIN_DATO, enRutas: SIN_DATO, disponible: toMajor(a.availableMinor), gastos: (await poolExpenses(a.adminId)).total,
    rutas: rutasDe(a.adminId),
  })));
  const company = s.company
    ? {
      depositos: SIN_DATO, retirosEmpresa: SIN_DATO, asignadoAAdmins: toMajor(s.admins.reduce((t, a) => t + a.allocatedNetMinor, 0)),
      disponible: toMajor(s.company.availableMinor), historicoPreV16: 0, total: SIN_DATO, sinResponsable: SIN_DATO,
      gastos: SIN_DATO, gastosAdministradores: SIN_DATO, aportesSocios: toMajor(s.company.partnerContributionsMinor),
    }
    : { depositos: 0, retirosEmpresa: 0, asignadoAAdmins: 0, disponible: 0, historicoPreV16: 0, total: 0, sinResponsable: 0, gastos: 0, gastosAdministradores: 0, aportesSocios: 0 };
  const issues = (recon?.checks ?? []).filter((c) => !c.ok).map((c) => `Conciliación del servidor: ${CHECK_TEXT[c.name] ?? c.name} (${c.detail})`);
  return {
    company, admins,
    routes: routes.map((r) => ({ routeId: String(r['id']), nombre: String(r['nombre']), controllerAdminId: (r['capitalControllerAdminId'] as string | undefined) ?? undefined, colocado: SIN_DATO, sinResponsable: !r['capitalControllerAdminId'] })),
    issues,
  };
}

/**
 * Caja principal (estado de cuenta de una bolsa). Los MOVIMIENTOS son los registros reales
 * del libro central que tocan esa bolsa, clasificados igual que en CLEAN
 * (`lib/adminPoolStatement`). Las PARTIDAS y el disponible salen del servidor.
 */
async function getAdminPoolStatementOnline(params: { actor: User | null | undefined; tenantId: string; adminId: string }): Promise<PoolStatement> {
  const { adminId } = params;
  const [s, recs, gastos] = await Promise.all([summary(), capitalRecords(), poolExpenses(adminId)]);
  const pool = s.admins.find((a) => a.adminId === adminId);
  const movimientos: PoolMovement[] = [];
  const estado = (m: { reversalId?: string; reversesId?: string }) => reversalStateOf(m);
  for (const e of recs.capitalLedger) {
    const base = { id: e.id, fecha: e.fecha, createdAt: e.createdAt, actorId: e.actorUserId, descripcion: e.descripcion, estado: estado(e) };
    if (e.tipo === 'ADMIN_ALLOCATION' && e.toAdminId === adminId) movimientos.push({ ...base, kind: 'asignacion', monto: e.amount, afecta: 'disponible' });
    if (e.tipo === 'ADMIN_RETURN' && e.fromAdminId === adminId) movimientos.push({ ...base, kind: 'devolucionSA', monto: -e.amount, afecta: 'disponible' });
    if (e.tipo === 'PARTNER_CONTRIBUTION' && e.toAdminId === adminId) {
      movimientos.push({ ...base, kind: 'aporteSocio', monto: e.amount, afecta: 'disponible', routeId: e.routeId, corrigeId: e.reversesId });
    }
  }
  for (const m of recs.capitalMovements.filter((x) => x.adminId === adminId)) {
    movimientos.push({ id: m.id, kind: centralPoolKind(m.centralLink, 'colocacion'), fecha: m.fecha, createdAt: m.createdAt, monto: -m.valor,
      afecta: 'disponible', estado: estado(m), routeId: m.routeId, actorId: m.userId, descripcion: m.descripcion, corrigeId: m.reversesId });
  }
  for (const w of recs.withdrawals.filter((x) => x.adminId === adminId)) {
    movimientos.push({ id: w.id, kind: centralPoolKind(w.centralLink, 'retiroRuta'), fecha: w.fecha, createdAt: w.createdAt, monto: w.valor,
      afecta: 'disponible', estado: estado(w), routeId: w.routeId, actorId: w.userId, descripcion: w.descripcion, corrigeId: w.reversesId });
  }
  for (const x of gastos.list) {
    const st = poolExpenseStateOf(x);
    movimientos.push({
      id: x.id, kind: (st === 'anulacion' ? 'anulacionGasto' : st === 'reintegro' ? 'reintegro' : 'gasto') as PoolMovementKind,
      fecha: x.fecha, createdAt: x.createdAt, monto: -x.valor, afecta: 'disponible',
      estado: st === 'anulado' ? 'anulado' : st === 'anulacion' ? 'reversion' : 'vigente',
      actorId: x.userId, descripcion: x.descripcion, categoryId: x.categoryId, corrigeId: x.reversesId ?? x.refundsExpenseId,
    });
  }
  movimientos.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fecha.localeCompare(a.fecha));
  const de = (k: PoolMovementKind) => movimientos.filter((m) => m.kind === k).reduce((t, m) => t + m.monto, 0);
  const completo = !recs.truncated;
  const recibidoSA = pool ? toMajor(pool.allocatedNetMinor) : 0;
  const aportesSocios = pool ? toMajor(pool.partnerContributionsMinor) : 0;
  return {
    adminId,
    capital: {
      adminId, asignadoPorEmpresa: recibidoSA, aportesSocios, asignado: SIN_DATO, enRutas: SIN_DATO,
      disponible: pool ? toMajor(pool.availableMinor) : 0, gastos: gastos.total, rutas: [],
    } as unknown as PoolStatement['capital'],
    partidas: {
      // Asignaciones y devoluciones por separado: suma de sus registros, solo si el listado está completo.
      asignaciones: completo ? de('asignacion') : SIN_DATO, devolucionesSA: completo ? -de('devolucionSA') : SIN_DATO,
      recibidoSA, aportesSocios,
      // El servidor no traspasa capital al cambiar el responsable de una ruta (no hay «capital con la ruta»).
      rutasRecibidas: 0, rutasEntregadas: 0,
      colocado: SIN_DATO, retiradoDeRutas: SIN_DATO,
    },
    conciliacion: { entradas: recibidoSA + aportesSocios, explicado: SIN_DATO, diferencia: SIN_DATO },
    movimientos,
  };
}

/** Historial de responsables: el servidor lo audita pero aún no lo expone (no hay consulta). */
export const CONTROLLER_HISTORY_UNAVAILABLE = 'El servidor registra cada cambio de responsable en su auditoría, pero aún no ofrece una consulta para mostrarlos aquí.';
async function listRouteControllerHistoryOnline(): Promise<RouteCapitalControllerEvent[]> {
  return [];
}

// ---------- Comandos ----------
type LedgerOp = { actor: User | null | undefined; tenantId: string; amount: number; descripcion?: string; fecha?: string; operationId?: string };

async function checkReasonAndDate(p: { descripcion?: string; fecha?: string }): Promise<string> {
  const reason = (p.descripcion ?? '').trim();
  if (reason.length < 3) throw new CapitalControlError('Escribe la descripción (mínimo 3 caracteres): queda en la auditoría de la operación.');
  const hoy = (await calendar()).businessDate;
  if (p.fecha && p.fecha !== hoy) throw new CapitalControlError(`La fecha la fija el servidor: hoy en la empresa (${hoy}). No se registran operaciones con otra fecha.`);
  return reason;
}

async function ledgerCommand(path: string, p: LedgerOp, extra: Record<string, unknown> = {}): Promise<CapitalLedgerEntry> {
  const reason = await checkReasonAndDate(p);
  try {
    const r = await moneyCommand<{ operation: { id: string } }>('POST', path, { ...extra, amountMinor: toMinor(p.amount), reason }, p.operationId);
    return (await capitalRecords()).capitalLedger.find((e) => e.id === r.operation.id) ?? ({ id: r.operation.id } as CapitalLedgerEntry);
  } catch (e) {
    throw e instanceof CapitalControlError ? e : new CapitalControlError(e instanceof Error ? e.message : String(e));
  }
}

const registerCompanyCapitalOnline = (p: LedgerOp) => ledgerCommand('/v1/capital/company/deposits', p);
const withdrawCompanyCapitalOnline = (p: LedgerOp) => ledgerCommand('/v1/capital/company/withdrawals', p);
const allocateCapitalToAdminOnline = (p: LedgerOp & { adminId: string }) => ledgerCommand('/v1/capital/allocations', p, { adminId: p.adminId });
const returnCapitalFromAdminOnline = (p: LedgerOp & { adminId: string }) => ledgerCommand('/v1/capital/admin-returns', p, { adminId: p.adminId });

async function setRouteCapitalControllerOnline(p: { actor: User | null | undefined; tenantId: string; routeId: string; adminId: string; motivo?: string }) {
  const reason = (p.motivo ?? '').trim();
  if (reason.length < 3) throw new CapitalControlError('Indica el motivo del cambio (mínimo 3 caracteres).');
  try {
    return await plain('PUT', `/v1/routes/${p.routeId}/capital-controller`, { membershipId: p.adminId, reason });
  } catch (e) {
    throw new CapitalControlError(e instanceof Error ? e.message : String(e));
  }
}

// ---------- Disponibles (sin cambios desde la Ronda 24) ----------
async function getCompanyAvailableCapitalOnline(_tenantId: string): Promise<number> {
  return toMajor((await summary()).company?.availableMinor ?? 0);
}
/** Un Administrador sin operaciones todavía no tiene bolsa en el servidor: su disponible es 0. */
async function getAdminAvailableCapitalOnline(_tenantId: string, adminId: string): Promise<number> {
  return toMajor((await summary()).admins.find((a) => a.adminId === adminId)?.availableMinor ?? 0);
}
/**
 * CLEAN envolvía las asignaciones en una transacción local que además reconciliaba el
 * responsable de capital. En el servidor cada comando de asignación ya reconcilia el
 * responsable en su propia transacción (y lo audita): aquí solo se ejecuta el cambio.
 */
async function withCapitalControllerGuardOnline<T>(_params: unknown, cambio: () => Promise<T>): Promise<{ result: T; events: never[] }> {
  return { result: await cambio(), events: [] };
}

// Firmas ORIGINALES de CLEAN (las pantallas y servicios originales las llaman así).
export const getCapitalOverview = getCapitalOverviewOnline as unknown as typeof Clean.getCapitalOverview;
export const getAdminPoolStatement = getAdminPoolStatementOnline as unknown as typeof Clean.getAdminPoolStatement;
export const listRouteControllerHistory = listRouteControllerHistoryOnline as unknown as typeof Clean.listRouteControllerHistory;
export const registerCompanyCapital = registerCompanyCapitalOnline as unknown as typeof Clean.registerCompanyCapital;
export const withdrawCompanyCapital = withdrawCompanyCapitalOnline as unknown as typeof Clean.withdrawCompanyCapital;
export const allocateCapitalToAdmin = allocateCapitalToAdminOnline as unknown as typeof Clean.allocateCapitalToAdmin;
export const returnCapitalFromAdmin = returnCapitalFromAdminOnline as unknown as typeof Clean.returnCapitalFromAdmin;
export const setRouteCapitalController = setRouteCapitalControllerOnline as unknown as typeof Clean.setRouteCapitalController;
export const getCompanyAvailableCapital = getCompanyAvailableCapitalOnline as unknown as typeof Clean.getCompanyAvailableCapital;
export const getAdminAvailableCapital = getAdminAvailableCapitalOnline as unknown as typeof Clean.getAdminAvailableCapital;
export const withCapitalControllerGuard = withCapitalControllerGuardOnline as unknown as typeof Clean.withCapitalControllerGuard;
