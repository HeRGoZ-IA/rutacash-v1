// PUENTE de `src/services/adminDashboardService.ts` (CLEAN): MISMA interfaz
// (`DashboardData`) y mismas reglas de alcance (todo se recorta por las rutas del
// contexto ANTES de sumar), con las cifras del SERVIDOR:
//
//   · «Hoy» y «esta semana» son los de la EMPRESA (fecha de negocio y zona horaria del
//     servidor, GET /v1/periods/calendar), con la semana de CLEAN (lunes a sábado).
//   · Base total: Σ Base de las rutas (custodia del servidor, ver puente de cashboxEngine).
//   · Cartera activa: Σ saldo (capital + interés) de ventas activas desembolsadas, misma
//     fórmula de CLEAN sobre los saldos del servidor.
//   · Recaudo (hoy, semana, 7 días, top rutas) y gastos de la semana: la MISMA fórmula de
//     CLEAN (Σ abonos por fecha y por ruta, anulaciones incluidas con signo; Σ gastos con
//     ruta) sobre los registros del servidor (GET /v1/collections y /v1/expenses). Si esos
//     listados llegaron a su tope y no cubren el periodo, se usa el agregado del libro del
//     servidor por ruta y rango (GET /v1/periods/liquidation), que da la misma cifra.
//   · Pendiente de sincronizar: 0 por construcción (ADEX Online no tiene cola local).
//   · Rutas con mora: la MISMA regla de CLEAN (rutas con alguna cuota «vencida» y días de
//     mora) sobre las cuotas del servidor. El estado y los días de mora de cada cuota los
//     deriva la regla original `updateInstallmentStatuses` con la fecha de hoy al leerlas
//     (projection.ts): el servidor guarda importes, pagado y saldo; no se inventa nada.

import { format, parseISO, subDays } from 'date-fns';
import { es } from 'date-fns/locale';
import { db } from '@/lib/db';
import { filterAccessibleRoutes } from '@/lib/permissions';
import { getWeekEnd, getWeekStart } from '@/lib/formatters';
import { carteraEnCalleOf } from '@clean/services/cashboxEngine';
import type { Expense, Payment, User } from '@clean/models/types';
import { calendar, custodyPositions, liquidation, mapLimit, since, table, truncated, type Liquidation } from '../../runtime/projection.ts';
import { toMajor } from '../../runtime/mappers.ts';

/** Rutas visibles con alguna cuota vencida (regla original de CLEAN, `getAdminDashboardData`). */
async function rutasConMora(scope: Set<string>): Promise<number> {
  const sales = new Map((await db.sales.toArray()).map((s) => [s.id, s]));
  const set = new Set<string>();
  for (const inst of await db.installments.toArray()) {
    if (inst.status === 'vencida' && inst.diasMora > 0) {
      const sale = sales.get(inst.saleId);
      if (sale && scope.has(sale.routeId)) set.add(sale.routeId);
    }
  }
  return set.size;
}
import { useRuntime } from '../../runtime/session.ts';

export interface DashboardData {
  baseActualTotal: number
  carteraEnCalle: number
  totalControlado: number
  recaudoHoy: number
  recaudoSemana: number
  ventasActivas: number
  clientesActivos: number
  gastosSemana: number
  pagosPendientesSync: number
  rutasConMora: number
  topRoutes: { nombre: string; cobrado: number }[]
  recaudoDiario: { dia: string; valor: number }[]
  alertas: { tipo: string; mensaje: string; severity: 'warning' | 'error' | 'info' }[]
}



const recaudo = (l: Liquidation) => l.credit.principalCollectedMinor + l.credit.interestCollectedMinor;

export async function getAdminDashboardData(params: { user: User | null | undefined; tenantId: string; now?: Date }): Promise<DashboardData> {
  const { user, tenantId } = params;
  // Todas las lecturas en paralelo (después se leen de la caché de la misma revisión).
  const [cal] = await Promise.all([calendar(), table('routes'), table('sales'), custodyPositions(), table('clients')]);
  const todayStr = cal.businessDate;
  const now = parseISO(`${todayStr}T12:00:00`);
  const weekStart = getWeekStart(now);
  const weekEnd = getWeekEnd(now);
  const weekTo = weekEnd < todayStr ? weekEnd : todayStr;

  const routes = filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(tenantId).toArray());
  const scope = new Set(routes.map((r) => r.id));

  const allSales = (await db.sales.where('tenantId').equals(tenantId).toArray()).filter((s) => scope.has(s.routeId));
  const ventasActivas = allSales.filter((s) => s.status === 'activa');

  const positions = await custodyPositions();
  const baseActualTotal = toMajor(positions.filter((p) => scope.has(p.routeId)).reduce((s, p) => s + p.balanceMinor, 0));
  const carteraEnCalle = carteraEnCalleOf(allSales);

  const days = Array.from({ length: 7 }, (_, i) => format(subDays(now, 6 - i), 'yyyy-MM-dd'));
  const desde = days[0]! < weekStart ? days[0]! : weekStart;

  // Registros del servidor con fecha DESDE `desde` (todas las cifras de abajo son de ese rango:
  // el servidor filtra por fecha, mismo alcance; no se descarga el historial). ¿Cubren todo el
  // periodo? Si el listado llegó a su tope, solo cubre desde su registro más antiguo.
  const [recentPayments, recentExpenses] = (await Promise.all([since('payments', desde), since('expenses', desde)])) as unknown as [Payment[], Expense[]];
  const allPayments = recentPayments.filter((p) => p.tenantId === tenantId && scope.has(p.routeId));
  const allExpenses = recentExpenses.filter((e) => e.tenantId === tenantId && !!e.routeId && scope.has(e.routeId));
  const covers = (key: string, dates: string[]) => !truncated.has(key) || dates.reduce((m, d) => (d < m ? d : m), '9999-12-31') < desde;
  // Sin permiso para leer abonos o gastos, los listados llegan vacíos: se usa el agregado.
  const caps = useRuntime.getState().ctx?.capabilities ?? [];
  const legibles = caps.includes('payment.viewHistory') && (caps.includes('expense.register') || caps.includes('expense.correct'));
  const fromRecords = legibles && covers(`/v1/collections?from=${desde}`, allPayments.map((p) => p.fecha)) && covers(`/v1/expenses?from=${desde}`, allExpenses.map((e) => e.fecha));

  let recaudoHoy: number; let recaudoSemana: number; let gastosSemana: number;
  let porRuta: Record<string, number> = {};
  let recaudoDiario: DashboardData['recaudoDiario'];
  const label = (d: string) => format(parseISO(`${d}T12:00:00`), 'EEE', { locale: es });
  if (fromRecords) {
    // Fórmula original de CLEAN (adminDashboardService), sobre los registros del servidor.
    const enSemana = (f: string) => f >= weekStart && f <= weekEnd;
    recaudoHoy = allPayments.filter((p) => p.fecha === todayStr).reduce((t, p) => t + p.valor, 0);
    recaudoSemana = allPayments.filter((p) => enSemana(p.fecha)).reduce((t, p) => t + p.valor, 0);
    gastosSemana = allExpenses.filter((e) => enSemana(e.fecha)).reduce((t, e) => t + e.valor, 0);
    for (const p of allPayments.filter((x) => enSemana(x.fecha))) porRuta[p.routeId] = (porRuta[p.routeId] ?? 0) + p.valor;
    recaudoDiario = days.map((d) => ({ dia: label(d), valor: allPayments.filter((p) => p.fecha === d).reduce((t, p) => t + p.valor, 0) }));
  } else {
    // Agregado del libro del servidor (mismas cifras, sin depender del tope de los listados).
    const perRoute = await mapLimit(routes, 4, async (r) => {
      const [week, daily] = await Promise.all([
        weekStart <= weekTo ? liquidation(r.id, weekStart, weekTo) : Promise.resolve(null),
        mapLimit(days, 2, (d) => liquidation(r.id, d, d)),
      ]);
      return { route: r, week, daily };
    });
    recaudoSemana = toMajor(perRoute.reduce((t, x) => t + (x.week ? recaudo(x.week) : 0), 0));
    recaudoHoy = toMajor(perRoute.reduce((t, x) => t + recaudo(x.daily[6]!), 0));
    gastosSemana = toMajor(perRoute.reduce((t, x) => t + (x.week ? x.week.credit.expensesMinor : 0), 0));
    porRuta = Object.fromEntries(perRoute.map((x) => [x.route.id, x.week ? toMajor(recaudo(x.week)) : 0]));
    recaudoDiario = days.map((d, i) => ({ dia: label(d), valor: toMajor(perRoute.reduce((t, x) => t + recaudo(x.daily[i]!), 0)) }));
  }

  const allClients = (await db.clients.where('tenantId').equals(tenantId).toArray()).filter((c) => scope.has(c.routeId));
  const clientesActivos = allClients.filter((c) => c.status === 'activo').length;

  const routeMap = new Map(routes.map((r) => [r.id, r]));
  const topRoutes = Object.entries(porRuta)
    .filter(([, cobrado]) => cobrado !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, cobrado]) => ({ nombre: routeMap.get(id)?.nombre ?? id, cobrado }));

  const alertas: DashboardData['alertas'] = [];
  const rutasSinCobrador = routes.filter((r) => !r.cobradorId && r.status === 'activa');
  if (rutasSinCobrador.length > 0) {
    alertas.push({ tipo: 'ruta', mensaje: `${rutasSinCobrador.length} ruta(s) sin Cobrador asignado: sin operación de cobro hasta asignarlo`, severity: 'warning' });
  }

  return {
    baseActualTotal,
    carteraEnCalle,
    totalControlado: baseActualTotal + carteraEnCalle,
    recaudoHoy,
    recaudoSemana,
    ventasActivas: ventasActivas.length,
    clientesActivos,
    gastosSemana,
    pagosPendientesSync: 0,
    rutasConMora: await rutasConMora(scope),
    topRoutes,
    recaudoDiario,
    alertas,
  };
}
