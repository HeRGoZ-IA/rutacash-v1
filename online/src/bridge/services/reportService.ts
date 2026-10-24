// PUENTE de `src/services/reportService.ts` (CLEAN): los reportes son los mismos; solo cambia el de GASTOS (R74):
//   · con Base por Ruta no hay «bolsas»: la columna es «Fuente» (Base de la ruta, efectivo del trabajador, aportes
//     de rutas, dinero propio) y los alcances usan el vocabulario nuevo (De ruta, General del Administrador…);
//   · en ambos modelos, un gasto general con aportes de rutas o con dinero propio (0035) se rotula por su fuente
//     real, nunca como «Histórico sin bolsa».
// Mismo orden de filtrado (rutas permitidas → ruta elegida → fechas) y mismas filas: solo cambian los textos.

import * as Clean from '@clean/services/reportService';
import type { ReportFilters, ReportRow, ReportSources, ReportType } from '@clean/services/reportService';
import { formatDate } from '@/lib/formatters';
import { EXPENSE_SCOPE_LABEL, expenseAttribution } from '@/lib/expenseAttribution';
import { POOL_STATE_LABEL, expenseFundingOf, poolExpenseStateOf } from '@/lib/expenseFunding';
import { hasPersonalCashbox } from '@/lib/collectorAttribution';
import { currentCapitalModel, isRouteBaseUi } from '../../runtime/routeBase/api.ts';

export * from '@clean/services/reportService';

function gastos(src: ReportSources, f: ReportFilters): ReportRow[] {
  const rb = isRouteBaseUi(currentCapitalModel());
  const routeName = (id: string) => src.routes.find((r) => r.id === id)?.nombre ?? id;
  const catName = (id: string) => src.categories.find((c) => c.id === id)?.nombre ?? id;
  const userName = (id?: string) => src.users?.find((u) => u.id === id)?.nombre ?? id ?? '';
  const conCaja = (id: string) => { const u = src.users?.find((x) => x.id === id); return !!u && hasPersonalCashbox(u.rol); };
  const inRange = (d: string) => (!f.fechaDesde || d >= f.fechaDesde) && (!f.fechaHasta || d <= f.fechaHasta);
  const conRuta = src.expenses.filter((e) => !!e.routeId && f.routeIds.has(e.routeId));
  const sinRuta = f.includeCompanyExpenses ? src.expenses.filter((e) => !e.routeId) : [];
  return [...conRuta, ...sinRuta].filter((e) => inRange(e.fecha)).map((e) => {
    // 0035: el servidor trae alcances y fuentes que el tipo de CLEAN no conoce.
    const raw = { funding: e.funding as string | undefined, scope: e.scope as string | undefined };
    const general = raw.funding === 'routes' || raw.funding === 'own_money' || raw.scope === 'administrador';
    const a = expenseAttribution(e, conCaja);
    const pool = expenseFundingOf(e);
    const tipo = raw.scope === 'administrador' ? 'General del Administrador'
      : general ? 'General de empresa'
        : rb ? (a.scope === 'ruta' ? 'De ruta' : a.scope === 'trabajador' ? 'De trabajador' : 'Empresa (anterior a Base por Ruta)')
          : EXPENSE_SCOPE_LABEL[a.scope];
    const fuente = raw.funding === 'routes' ? 'Aportes de rutas'
      : raw.funding === 'own_money' ? `Dinero propio de ${userName(e.userId)} (reembolsable)`
        : a.scope === 'trabajador' ? (rb ? 'Base del trabajador' : '—')
          : a.scope === 'ruta' ? (rb ? 'Base disponible' : '—')
            : pool.kind === 'admin' ? (rb ? `Saldo sin asignar de ${userName(pool.adminId)}` : `Administrador ${userName(pool.adminId)}`)
              : pool.kind === 'empresa' ? (rb ? 'Empresa (anterior a Base por Ruta)' : 'Empresa')
                : pool.kind === 'historico' ? (rb ? 'Histórico' : 'Histórico sin bolsa') : '—';
    const estado = general ? (e.reversesId ? 'anulacion' : e.reversalId ? 'anulado' : 'vigente') : poolExpenseStateOf(e);
    return {
      Fecha: formatDate(e.fecha),
      Tipo: tipo,
      [rb ? 'Fuente' : 'Bolsa']: fuente,
      Estado: estado === 'ruta' ? '' : POOL_STATE_LABEL[estado as keyof typeof POOL_STATE_LABEL] ?? estado,
      Ruta: e.routeId ? routeName(e.routeId) : '—',
      Trabajador: a.scope === 'trabajador' && !general ? userName(a.cashHolderId) : '—',
      Categoría: catName(e.categoryId),
      Valor: e.valor,
      Descripción: e.descripcion ?? '',
    };
  });
}

export function buildGastosReport(src: ReportSources, f: ReportFilters): ReportRow[] {
  return gastos(src, f);
}

export function buildReport(type: ReportType, src: ReportSources, f: ReportFilters): ReportRow[] {
  return type === 'gastos' ? gastos(src, f) : Clean.buildReport(type, src, f);
}
