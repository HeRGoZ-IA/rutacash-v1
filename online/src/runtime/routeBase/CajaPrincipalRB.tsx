// CAJA PRINCIPAL con Base por Ruta (R74 · bloque F, O8, O9). Es un PANEL consolidado de las rutas
// en alcance, NUNCA otra cuenta: cada peso está en la Base de una ruta o en manos de un trabajador.
//
//   · Administrador: sus rutas (las del panel bajo RLS). Desde aquí confirma las entregas de ruta que
//     le tocan (O5) y va a Transferencias para mover la Base.
//   · SuperAdmin: el MISMO panel, de solo lectura, para todas las rutas, con el resumen global
//     (oficinas, rutas, responsables, rutas que requieren atención y rutas con resultado positivo) y el
//     único acto estructural que le queda sobre una ruta: cambiar su responsable (abre la entrega).
//
// Cifras: `GET /v1/capital/route-panel` (saldos actuales + cifras del periodo elegido). Subtotales
// solo donde suman con sentido: Base + custodias = efectivo de la ruta; la cartera va aparte; los
// gastos generales y el saldo «sin asignar» se muestran aparte y nunca como efectivo de una ruta.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeftRight, ChevronRight, Handshake, History, Info, MapPin, Repeat, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useAuth } from '@/hooks/useAuth';
import { useDataRevision } from '@/hooks/useDataRevision';
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter';
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar';
import { formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { validRouteAdmins } from '@/lib/capitalAllocation';
import { setRouteCapitalController } from '@/services/capitalControlService';
import { cn } from '@/lib/utils';
import type { Office, Route, User } from '@/models/types';
import { todayIn } from '../../lib/format.ts';
import { useRuntime } from '../session.ts';
import {
  fetchHandovers, fetchPanel, routeExpenses, sumRows, type CapitalModel, type Handover, type PanelRoute, type RoutePanel,
} from './api.ts';
import {
  AlertChip, Notice, PERIOD_LABEL, StateBadge, activeStates, num, otherAlerts, periodDates, stateHelp, stateLabel, useMoney, type PanelPeriod,
} from './parts.tsx';
import { HandoverDialog } from './HandoverDialog.tsx';
import { GeneralExpensesPanel } from './GeneralExpensesRB.tsx';

type Section = 'efectivo' | 'base' | 'cartera' | 'periodo' | 'estados' | 'entrega';

export function CajaPrincipalRB({ model }: { model: CapitalModel }) {
  const { tenantId } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const isSa = me?.role === 'superadmin';
  const timezone = me?.company.timezone ?? 'UTC';
  const today = useMemo(() => todayIn(timezone), [timezone]);
  const money = useMoney();
  const navigate = useNavigate();
  const officeFilter = useOfficeRouteFilter();
  const revision = useDataRevision();

  const [period, setPeriod] = useState<PanelPeriod>('hoy');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = periodDates(period, today, custom);
  const [panel, setPanel] = useState<RoutePanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [pendingMine, setPendingMine] = useState<Handover[]>([]);
  const [detail, setDetail] = useState<{ routeId: string; section: Section } | null>(null);
  const [confirming, setConfirming] = useState<{ routeId: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPanel(range.from, range.to)
      .then((p) => { if (alive) { setPanel(p); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar el panel'); });
    if (!isSa) {
      fetchHandovers({ status: 'pendiente' }).then((l) => { if (alive) setPendingMine(l.filter((h) => h.toId === me?.membershipId)); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [range.from, range.to, revision, isSa, me?.membershipId]);
  useEffect(() => {
    void Promise.all([db.routes.where('tenantId').equals(tenantId).toArray(), db.offices.where('tenantId').equals(tenantId).toArray(), db.users.where('tenantId').equals(tenantId).toArray()])
      .then(([r, o, u]) => { setRoutes(r); setOffices(o); setUsers(u); }).catch(() => undefined);
  }, [tenantId, revision]);

  const filtering = officeFilter.hasOfficeFilter || !!officeFilter.routeId;
  const rows = (panel?.routes ?? []).filter((r) => !filtering || officeFilter.visibleRouteIds.has(r.routeId));
  const t = sumRows(rows);
  const pools = panel?.general.unassignedPools ?? [];
  const ownPool = pools.find((p) => p.adminId === me?.membershipId);
  const selected = detail ? panel?.routes.find((r) => r.routeId === detail.routeId) ?? null : null;
  const periodText = period === 'rango' ? `${range.from} a ${range.to}` : PERIOD_LABEL[period];

  const attention = rows.filter((r) => activeStates(r).length > 0 || otherAlerts(r).length > 0);
  const positive = rows.filter((r) => r.operatingResultMinor > 0);
  const officeOf = (id: string) => routes.find((r) => r.id === id)?.officeId ?? null;
  const officeCount = new Set(rows.map((r) => officeOf(r.routeId)).filter(Boolean)).size;
  const controllers = new Set(rows.map((r) => r.controller.id).filter(Boolean)).size;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto w-full" data-testid="rb-caja">
      {/* ---------- Cabecera ---------- */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900">{isSa ? 'Panel de rutas' : 'Caja principal'}</h1>
          <p className="text-sm text-gray-600 mt-0.5 max-w-2xl">
            {isSa ? 'Todas las rutas de la empresa, solo lectura. ' : 'Tus rutas en un solo panel. '}
            No es una cuenta: el efectivo está en la <b>Base</b> de cada ruta o en manos de sus trabajadores.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:flex-nowrap lg:flex-shrink-0">
          {!isSa && <Button onClick={() => navigate('/admin/transfers')} icon={<ArrowLeftRight className="w-4 h-4" />} data-testid="rb-go-transfers">Transferencias</Button>}
          {isSa && <Button variant="secondary" onClick={() => navigate('/admin/capital/modelo')} icon={<Settings2 className="w-4 h-4" />} data-testid="rb-go-model">Modelo de capital</Button>}
          <Link to={`/admin/consultas?desde=${range.from}&hasta=${range.to}`}
            className="inline-flex items-center justify-center gap-2 h-10 sm:h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <History className="w-4 h-4" aria-hidden />Ver movimientos
          </Link>
        </div>
      </div>

      <PeriodControl period={period} onPeriod={setPeriod} custom={custom} onCustom={setCustom} />

      {model === 'migrating' && (
        <Notice tone="violet" testId="rb-migrating">La empresa está pasando a <b>Base por Ruta</b>. Las bolsas están congeladas hasta que el SuperAdmin complete la activación; los Cobradores siguen operando.</Notice>
      )}
      {pendingMine.map((h) => {
        const name = panel?.routes.find((r) => r.routeId === h.routeId)?.name ?? 'la ruta';
        return (
          <div key={h.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3" data-testid="rb-handover-banner">
            <p className="text-sm text-violet-900 flex gap-2">
              <Handshake className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
              <span><b>{name}</b> está en entrega: ahora eres su responsable. Cuenta la Base y confirma para volver a operar la ruta.</span>
            </p>
            <Button size="sm" onClick={() => setConfirming({ routeId: h.routeId, name })} data-testid="rb-handover-open">Confirmar conteo</Button>
          </div>
        );
      })}

      {error ? <p className="text-sm text-red-600">{error}</p> : !panel ? <PanelSkeleton /> : (
        <>
          {/* ---------- Consolidado ---------- */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-5 space-y-4" aria-labelledby="rb-cons" data-testid="rb-consolidated">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rb-cons" className="text-sm font-semibold text-gray-900">{filtering ? `Consolidado · ${officeFilter.contextLabel}` : 'Consolidado'}</h2>
              <span className="text-xs text-gray-500">{rows.length} ruta(s) · saldos al momento · periodo: {periodText}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-2 md:gap-3">
              <Figure label="Base disponible" value={money(t.baseMinor)} testId="rb-total-base" strong />
              <Op>+</Op>
              <Figure label="Efectivo en custodias" value={money(t.custodyMinor)} testId="rb-total-custody"
                note={<>Entregable {money(t.deliverableMinor)}{t.negativeCustodyMinor < 0 ? <> · negativo {money(t.negativeCustodyMinor)}</> : null}</>} />
              <Op>=</Op>
              <Figure label="Efectivo de las rutas" value={money(t.cashMinor)} testId="rb-total-cash" strong tone="primary" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-3">
              <div className="rounded-xl border border-gray-100 p-3" data-testid="rb-total-portfolio">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Cartera (no es efectivo)</p>
                <dl className="grid grid-cols-2 gap-2">
                  <Mini label="Capital colocado" value={money(t.principalPlacedMinor)} />
                  <Mini label="Cartera con interés" value={money(t.outstandingMinor)} hint="Incluye interés aún no cobrado" />
                </dl>
              </div>
              <div className="rounded-xl border border-gray-100 p-3" data-testid="rb-total-period">
                <p className="text-xs font-medium text-gray-500 mb-1.5">Periodo · {periodText}</p>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Mini label="Recaudos" value={money(t.collectionsMinor)} />
                  <Mini label="Gastos de rutas" value={money(t.expensesMinor)} />
                  <Mini label="Retiros de Base" value={money(t.withdrawalsMinor)} />
                  <Mini label="Resultado operativo" value={money(t.resultMinor)} hint="No es utilidad contable ni dinero retirable" negative={t.resultMinor < 0} testId="rb-total-result" />
                </dl>
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 p-3" data-testid="rb-total-differences">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1.5">
                <p className="text-xs font-medium text-gray-500">Diferencias y obligaciones (no son efectivo)</p>
                <Link to="/admin/diferencias" className="text-xs font-medium text-primary-700 hover:underline" data-testid="rb-go-differences">
                  {t.differences && t.differences.pendingCount > 0 ? `Conciliar ${t.differences.pendingCount} diferencia(s)` : 'Diferencias y conciliaciones'}
                </Link>
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {t.differences ? (
                  <>
                    <Mini label="Faltantes pendientes" value={money(t.differences.shortagePendingMinor)} testId="rb-shortage-pending" />
                    <Mini label="Sobrantes pendientes" value={money(t.differences.surplusPendingMinor)} testId="rb-surplus-pending" />
                    <Mini label="Faltantes conciliados" value={money(t.differences.shortageConciliatedMinor)} hint="En el periodo" />
                    <Mini label="Sobrantes conciliados" value={money(t.differences.surplusConciliatedMinor)} hint="En el periodo" />
                  </>
                ) : (
                  <>
                    <Mini label="Faltantes pendientes" value={money(t.shortageMinor)} hint="Arrastrados en cuadres; no es billete" testId="rb-shortage-pending" />
                    <Mini label="Sobrantes en control" value={money(t.surplusMinor)} hint="Aparte; no es Base" testId="rb-surplus-pending" />
                  </>
                )}
                <Mini label="Reembolsos pendientes a Administradores" value={money(panel.general.pendingAdminReimbursements?.totalMinor ?? 0)} hint="Obligación de la empresa; no es efectivo" testId="rb-total-payables" />
                <Mini label="Aportes a gastos generales" value={money(t.generalContributionsMinor)} hint={`Salieron de las Bases · periodo; reembolsos pagados ${money(t.reimbursementsMinor)}`} />
              </dl>
            </div>
          </section>

          {/* ---------- SuperAdmin: resumen global ---------- */}
          {isSa && (
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-3" data-testid="rb-sa-global">
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
                <h2 className="text-sm font-semibold text-gray-900 mb-2">Estructura</h2>
                <dl className="grid grid-cols-3 gap-2">
                  <Mini label="Oficinas" value={String(officeCount)} />
                  <Mini label="Rutas" value={String(rows.length)} />
                  <Mini label="Responsables" value={String(controllers)} />
                </dl>
                <dl className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-gray-100">
                  <Mini label="Faltantes arrastrados" value={money(t.shortageMinor)} />
                  <Mini label="Inyecciones del periodo" value={money(t.injectionsMinor)} hint="Aportes a la Base: no son pérdida" />
                </dl>
              </div>
              <RouteShortList title="Rutas que requieren atención" empty="Ninguna ruta con alertas." testId="rb-sa-attention"
                items={attention.map((r) => ({ r, extra: [...activeStates(r).map(stateLabel), ...otherAlerts(r)].length }))}
                render={(r) => <div className="flex flex-wrap gap-1 mt-1">{activeStates(r).map((k) => <StateBadge key={k} k={k} />)}{otherAlerts(r).map((a) => <AlertChip key={a} a={a} />)}</div>}
                onOpen={(id) => setDetail({ routeId: id, section: 'estados' })} />
              <RouteShortList title="Rutas con resultado operativo positivo" empty="Ninguna en este periodo." testId="rb-sa-positive"
                items={positive.map((r) => ({ r, extra: 0 }))}
                render={(r) => <p className={`${num} text-xs text-emerald-800 mt-0.5`}>{money(r.operatingResultMinor)}</p>}
                onOpen={(id) => setDetail({ routeId: id, section: 'periodo' })} />
            </section>
          )}

          {/* ---------- Rutas ---------- */}
          <section className="space-y-3" aria-labelledby="rb-routes">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <h2 id="rb-routes" className="text-sm font-semibold text-gray-900">Rutas</h2>
              <OfficeRouteFilterBar offices={officeFilter.offices} officeId={officeFilter.officeId} onOfficeChange={officeFilter.setOfficeId}
                routesInOffice={officeFilter.routesInOffice} routeId={officeFilter.routeId} onRouteChange={officeFilter.setRouteId}
                hasUnassigned={officeFilter.hasUnassigned} contextLabel={officeFilter.contextLabel} showContext={officeFilter.hasOfficeFilter} />
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={<MapPin className="w-8 h-8" />} title={isSa ? 'No hay rutas' : 'No tienes rutas en tu alcance'} />
            ) : (
              <ul className="space-y-3">
                {rows.map((r) => (
                  <RouteRow key={r.routeId} r={r} mine={!isSa && r.controller.id === me?.membershipId}
                    office={offices.find((o) => o.id === officeOf(r.routeId))?.nombre ?? null}
                    onOpen={(section) => setDetail({ routeId: r.routeId, section })}
                    onConfirm={() => setConfirming({ routeId: r.routeId, name: r.name })}
                    canConfirm={!isSa && pendingMine.some((h) => h.routeId === r.routeId)} />
                ))}
              </ul>
            )}
          </section>

          {/* ---------- Aparte: gastos generales y reembolsos (0035), saldo sin asignar ---------- */}
          <div data-testid="rb-general">
            <GeneralExpensesPanel model={model} panel={panel} periodText={periodText} />
          </div>
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3" aria-label="Fuera de las rutas">
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="rb-consolidated-result">
              <h2 className="text-sm font-semibold text-gray-900">Resultado consolidado del periodo</h2>
              <p className="text-xs text-gray-600">Resultado operativo de las rutas y, aparte, los gastos generales. No es utilidad contable ni dinero retirable.</p>
              <dl className="grid grid-cols-2 gap-2">
                <Mini label="Resultado operativo de las rutas" value={money(panel.consolidated?.routesOperatingResultMinor ?? t.resultMinor)} negative={(panel.consolidated?.routesOperatingResultMinor ?? t.resultMinor) < 0} />
                <Mini label="Gastos generales operativos" value={money(panel.consolidated?.generalOperatingExpensesMinor ?? 0)} />
                <Mini label="Después de gastos generales" value={money(panel.consolidated?.resultAfterGeneralExpensesMinor ?? t.resultMinor)} negative={(panel.consolidated?.resultAfterGeneralExpensesMinor ?? 0) < 0} testId="rb-result-after-general" />
                <Mini label="Bienes duraderos generales" value={money(panel.consolidated?.generalDurableGoodsMinor ?? 0)} hint="Aparte: no es pérdida" />
              </dl>
            </div>
            <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="rb-unassigned">
              <h2 className="text-sm font-semibold text-gray-900">Saldo sin asignar</h2>
              <p className="text-xs text-gray-600">Lo que quedó de antes de Base por Ruta. No es Base de ninguna ruta: solo su Administrador lo reparte a una ruta suya, con confirmación.</p>
              {pools.length === 0 ? <p className="text-sm text-gray-500">No hay saldo sin asignar.</p> : (
                <ul className="divide-y divide-gray-50">
                  {pools.map((p) => (
                    <li key={p.adminId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{formatPersonName(p.name) || 'Administrador'}</span>
                      <span className={`${num} font-semibold text-gray-900`}>{money(p.balanceMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {ownPool && ownPool.balanceMinor > 0 && (
                <Button size="sm" variant="secondary" onClick={() => navigate('/admin/transfers?op=assign')} data-testid="rb-assign-unassigned">Repartir a una ruta</Button>
              )}
            </div>
          </section>
        </>
      )}

      <RouteDetail r={selected} section={detail?.section ?? 'efectivo'} range={range} isSa={isSa} users={users} routes={routes}
        onClose={() => setDetail(null)} onConfirm={(r) => { setDetail(null); setConfirming({ routeId: r.routeId, name: r.name }); }}
        canConfirm={!!selected && !isSa && pendingMine.some((h) => h.routeId === selected.routeId)} />
      <HandoverDialog routeId={confirming?.routeId ?? null} routeName={confirming?.name} onClose={() => setConfirming(null)} onDone={() => setConfirming(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function PeriodControl({ period, onPeriod, custom, onCustom }: {
  period: PanelPeriod; onPeriod: (p: PanelPeriod) => void; custom: { from: string; to: string }; onCustom: (c: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Periodo de las cifras">
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
        {(Object.keys(PERIOD_LABEL) as PanelPeriod[]).map((p) => (
          <button key={p} type="button" onClick={() => onPeriod(p)} aria-pressed={period === p} data-testid={`rb-period-${p}`}
            className={cn('px-3 h-8 text-xs font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              period === p ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-100')}>{PERIOD_LABEL[p]}</button>
        ))}
      </div>
      {period === 'rango' && (
        <div className="flex flex-wrap gap-2">
          <label className="text-xs text-gray-600 flex items-center gap-1">Desde
            <input type="date" value={custom.from} onChange={(e) => onCustom({ ...custom, from: e.target.value })} className="h-8 rounded-lg border border-gray-300 px-2 text-sm" />
          </label>
          <label className="text-xs text-gray-600 flex items-center gap-1">Hasta
            <input type="date" value={custom.to} onChange={(e) => onCustom({ ...custom, to: e.target.value })} className="h-8 rounded-lg border border-gray-300 px-2 text-sm" />
          </label>
        </div>
      )}
      <p className="text-xs text-gray-500 basis-full sm:basis-auto">El periodo cambia recaudos, gastos, retiros y resultado; los saldos son siempre los actuales.</p>
    </div>
  );
}

function Figure({ label, value, note, testId, strong, tone }: { label: string; value: string; note?: ReactNode; testId?: string; strong?: boolean; tone?: 'primary' }) {
  return (
    <div className={cn('rounded-xl p-3', tone === 'primary' ? 'bg-primary-50' : 'bg-gray-50')} data-testid={testId}>
      <p className={cn('text-xs', tone === 'primary' ? 'text-primary-800' : 'text-gray-600')}>{label}</p>
      <p className={cn(num, strong ? 'text-xl font-bold' : 'text-lg font-semibold', tone === 'primary' ? 'text-primary-900' : 'text-gray-900')}>{value}</p>
      {note && <p className={cn('text-xs mt-0.5', tone === 'primary' ? 'text-primary-800' : 'text-gray-600')}>{note}</p>}
    </div>
  );
}
function Op({ children }: { children: ReactNode }) {
  return <span className="hidden md:flex items-center justify-center text-lg font-semibold text-gray-400 select-none" aria-hidden>{children}</span>;
}
function Mini({ label, value, hint, negative, testId }: { label: string; value: string; hint?: string; negative?: boolean; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={cn(num, 'text-sm font-semibold', negative ? 'text-red-700' : 'text-gray-900')}>{value}</dd>
      {hint && <dd className="text-[11px] leading-tight text-gray-500">{hint}</dd>}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Cargando el panel">
      <div className="h-40 rounded-2xl bg-gray-100 animate-pulse" />
      <div className="h-28 rounded-2xl bg-gray-100 animate-pulse" />
      <div className="h-28 rounded-2xl bg-gray-100 animate-pulse" />
    </div>
  );
}

function RouteShortList({ title, empty, items, render, onOpen, testId }: {
  title: string; empty: string; items: { r: PanelRoute; extra: number }[]; render: (r: PanelRoute) => ReactNode; onOpen: (id: string) => void; testId: string;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold text-gray-900 mb-2">{title} <span className="text-gray-500 font-normal">({items.length})</span></h2>
      {items.length === 0 ? <p className="text-sm text-gray-500">{empty}</p> : (
        <ul className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
          {items.map(({ r }) => (
            <li key={r.routeId}>
              <button type="button" onClick={() => onOpen(r.routeId)} className="w-full text-left py-2 hover:bg-gray-50 rounded-lg px-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                <span className="text-sm font-medium text-gray-900">{r.name}</span>
                {render(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RouteRow({ r, mine, office, onOpen, onConfirm, canConfirm }: {
  r: PanelRoute; mine: boolean; office: string | null; onOpen: (s: Section) => void; onConfirm: () => void; canConfirm: boolean;
}) {
  const money = useMoney();
  const states = activeStates(r);
  const alerts = otherAlerts(r);
  const fig = (label: string, value: string, section: Section, opts: { sub?: string; negative?: boolean; testId?: string } = {}) => (
    <button type="button" onClick={() => onOpen(section)} data-testid={opts.testId}
      className="text-left min-w-0 rounded-lg px-2 py-1.5 -mx-2 -my-1.5 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
      <span className="block text-xs text-gray-500">{label}</span>
      <span className={cn(num, 'block text-sm font-semibold', opts.negative ? 'text-red-700' : 'text-gray-900')}>{value}</span>
      {opts.sub && <span className="block text-[11px] leading-tight text-gray-500">{opts.sub}</span>}
    </button>
  );
  const custodySub = [r.custody.deliverableMinor !== r.custody.grossMinor ? `entregable ${money(r.custody.deliverableMinor)}` : null,
    r.custody.carriedShortageMinor > 0 ? `faltante ${money(r.custody.carriedShortageMinor)}` : null].filter(Boolean).join(' · ');
  return (
    <li className={cn('bg-white rounded-2xl shadow-card border p-4', r.handoverState === 'en_entrega' ? 'border-violet-200' : 'border-gray-100')} data-testid={`rb-route-${r.routeId}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-center gap-x-2">
            {r.name}{r.code ? <span className="text-xs font-normal text-gray-500">{r.code}</span> : null}
            {office && <span className="text-xs font-normal text-gray-500">· {office}</span>}
          </p>
          <p className="text-xs text-gray-600">
            {r.controller.id
              ? <>Responsable: <span className="font-medium text-gray-800">{mine ? 'Tú' : formatPersonName(r.controller.name) || '—'}</span></>
              : <span className="text-red-700 font-medium">Sin responsable</span>}
          </p>
          {(states.length > 0 || alerts.length > 0) && (
            <div className="flex flex-wrap gap-1 mt-1.5" data-testid="rb-route-states">
              {states.map((k) => <StateBadge key={k} k={k} detail={k === 'insufficientLiquidity' && r.capitalNeedMinor ? `faltan ${money(r.capitalNeedMinor)}` : undefined} />)}
              {alerts.map((a) => <AlertChip key={a} a={a} to={a === 'PENDING_DIFFERENCES' ? `/admin/diferencias?ruta=${encodeURIComponent(r.routeId)}` : undefined} />)}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-shrink-0">
          {canConfirm && <Button size="sm" onClick={onConfirm} icon={<Handshake className="w-3.5 h-3.5" />}>Confirmar conteo</Button>}
          <Button size="sm" variant="ghost" onClick={() => onOpen('efectivo')} data-testid="rb-route-detail">Detalle<ChevronRight className="w-3.5 h-3.5" aria-hidden /></Button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-x-4 gap-y-3 border-t border-gray-100 pt-3">
        {fig('Base disponible', money(r.baseMinor), 'base', { testId: 'rb-fig-base' })}
        {fig('En custodias', money(r.custody.grossMinor), 'efectivo', { sub: custodySub || undefined, negative: r.custody.negativeMinor < 0, testId: 'rb-fig-custody' })}
        {fig('Efectivo de la ruta', money(r.cashMinor), 'efectivo', { testId: 'rb-fig-cash' })}
        {fig('Capital colocado', money(r.portfolio.principalPlacedMinor), 'cartera', { sub: `con interés ${money(r.portfolio.outstandingWithInterestMinor)}`, testId: 'rb-fig-portfolio' })}
        {fig('Recaudos', money(r.period.collectionsMinor), 'periodo', { testId: 'rb-fig-collections' })}
        {fig('Gastos', money(routeExpenses(r)), 'periodo', { sub: r.period.expenses.bienDuraderoMinor ? `bienes duraderos ${money(r.period.expenses.bienDuraderoMinor)}` : undefined, testId: 'rb-fig-expenses' })}
        {fig('Retiros de Base', money(r.period.base?.withdrawalsMinor ?? 0), 'base', { testId: 'rb-fig-withdrawals' })}
        {fig('Resultado operativo', money(r.operatingResultMinor), 'periodo', { negative: r.operatingResultMinor < 0, testId: 'rb-fig-result' })}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Detalle de una ruta (drill-down de cada cifra)
// ---------------------------------------------------------------------------

function RouteDetail({ r, section, range, isSa, users, routes, onClose, onConfirm, canConfirm }: {
  r: PanelRoute | null; section: Section; range: { from: string; to: string }; isSa: boolean; users: User[]; routes: Route[];
  onClose: () => void; onConfirm: (r: PanelRoute) => void; canConfirm: boolean;
}) {
  const money = useMoney();
  const { tenantId } = useTenant();
  const { user } = useAuth();
  const [changing, setChanging] = useState<{ adminId: string; motivo: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!r) { setChanging(null); return; }
    const t = setTimeout(() => document.getElementById(`rb-d-${section}`)?.scrollIntoView({ block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [r?.routeId, section]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  const b = r.period.base;
  const route = routes.find((x) => x.id === r.routeId);
  const candidates = route ? validRouteAdmins(users, route).filter((a) => a.id !== r.controller.id) : [];
  const states = activeStates(r);
  const alerts = otherAlerts(r);
  const row = (label: string, v: number | null | undefined, opts: { sign?: '+' | '−'; strong?: boolean; hint?: string } = {}) => (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', opts.strong && 'border-t border-gray-200 mt-1 pt-2')}>
      <dt className={cn('text-sm', opts.strong ? 'font-semibold text-gray-900' : 'text-gray-600')}>{label}{opts.hint && <span className="block text-[11px] text-gray-500">{opts.hint}</span>}</dt>
      <dd className={cn(num, 'text-sm', opts.strong ? 'font-bold text-gray-900' : 'text-gray-900')}>{opts.sign && v ? `${opts.sign} ` : ''}{money(v ?? 0)}</dd>
    </div>
  );
  const q = `perspectiva=${encodeURIComponent(`route:${r.routeId}`)}&desde=${range.from}&hasta=${range.to}`;

  async function saveController() {
    if (!changing || !user) return;
    if (changing.motivo.trim().length < 3) { toast.error('Indica el motivo.'); return; }
    setSaving(true);
    try {
      await setRouteCapitalController({ actor: user, tenantId, routeId: r!.routeId, adminId: changing.adminId, motivo: changing.motivo });
      toast.success('Responsable cambiado: la ruta queda en entrega hasta que el nuevo responsable confirme el conteo');
      setChanging(null);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} size="xl" title={`${r.name} · detalle`}
      footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <div className="space-y-5" data-testid="rb-route-drawer">
        <p className="text-sm text-gray-600">
          Responsable: <b className="text-gray-900">{formatPersonName(r.controller.name) || 'sin responsable'}</b>{!r.controller.valid && r.controller.id ? ' (no válido)' : ''}
          {' '}· saldos al momento · periodo {range.from === range.to ? range.from : `${range.from} a ${range.to}`}
        </p>
        {(states.length > 0 || alerts.length > 0) && (
          <section id="rb-d-estados" className="space-y-1.5" aria-label="Estados y alertas">
            {states.map((k) => (
              <div key={k} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <StateBadge k={k} /><span className="text-xs text-gray-600">{stateHelp(k)}{k === 'insufficientLiquidity' && r.capitalNeedMinor ? ` Faltan ${money(r.capitalNeedMinor)}.` : ''}</span>
              </div>
            ))}
            {alerts.length > 0 && <div className="flex flex-wrap gap-1">{alerts.map((a) => <AlertChip key={a} a={a} />)}</div>}
          </section>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <section id="rb-d-efectivo" aria-labelledby="rb-d-ef-h">
            <h3 id="rb-d-ef-h" className="text-sm font-semibold text-gray-900 mb-1">Efectivo de la ruta</h3>
            <dl>
              {row('Base disponible', r.baseMinor)}
              {row('En custodias (bruto)', r.custody.grossMinor, { hint: `${r.custody.positions} trabajador(es) con caja` })}
              {row('Efectivo de la ruta', r.cashMinor, { strong: true })}
              {row('Custodia entregable', r.custody.deliverableMinor, { hint: 'Lo que los trabajadores pueden entregar hoy' })}
              {r.custody.negativeMinor < 0 && row('Custodias negativas', r.custody.negativeMinor, { hint: 'Gastos de trabajadores por encima de su efectivo; no es efectivo' })}
              {r.custody.carriedShortageMinor > 0 && row('Faltante arrastrado', r.custody.carriedShortageMinor, { hint: 'Reconocido en cuadres; no es billete' })}
              {r.surplusInControlMinor > 0 && row('Sobrante en control', r.surplusInControlMinor, { hint: 'Aparte; no es Base' })}
            </dl>
          </section>
          <section id="rb-d-base" aria-labelledby="rb-d-b-h">
            <h3 id="rb-d-b-h" className="text-sm font-semibold text-gray-900 mb-1">Movimiento de la Base en el periodo</h3>
            {!b ? <p className="text-sm text-gray-500">Sin datos de la Base para este periodo.</p> : (
              <dl data-testid="rb-d-base-block">
                {row('Saldo inicial', b.openingMinor)}
                {b.injectionsMinor > 0 && row('Inyecciones de Base', b.injectionsMinor, { sign: '+' })}
                {b.unassignedAssignedMinor > 0 && row('Reparto de saldo sin asignar', b.unassignedAssignedMinor, { sign: '+' })}
                {b.transfersInMinor > 0 && row('Transferencias recibidas', b.transfersInMinor, { sign: '+' })}
                {b.returnsReceivedMinor > 0 && row('Devoluciones de Cobradores', b.returnsReceivedMinor, { sign: '+' })}
                {b.collectionsReceivedMinor > 0 && row('Recaudos recibidos en la Base', b.collectionsReceivedMinor, { sign: '+' })}
                {b.withdrawalsMinor > 0 && row('Retiros de Base', b.withdrawalsMinor, { sign: '−' })}
                {b.transfersOutMinor > 0 && row('Transferencias enviadas', b.transfersOutMinor, { sign: '−' })}
                {b.deliveredToWorkersMinor > 0 && row('Entregas de Base a Cobradores', b.deliveredToWorkersMinor, { sign: '−' })}
                {b.disbursedMinor > 0 && row('Desembolsos desde la Base', b.disbursedMinor, { sign: '−' })}
                {b.routeExpensesMinor > 0 && row('Gastos pagados con la Base', b.routeExpensesMinor, { sign: '−' })}
                {b.reassignmentsNetMinor !== 0 && row('Reasignaciones entre rutas (neto)', b.reassignmentsNetMinor)}
                {b.otherMinor !== 0 && row('Otros (anulaciones, cuadres)', b.otherMinor)}
                {row('Saldo final', b.closingMinor, { strong: true })}
                {row('Aportes netos acumulados', r.contributionsNetMinor, { hint: 'Inyecciones menos retiros desde la activación' })}
              </dl>
            )}
          </section>
          <section id="rb-d-cartera" aria-labelledby="rb-d-c-h">
            <h3 id="rb-d-c-h" className="text-sm font-semibold text-gray-900 mb-1">Cartera (no es efectivo)</h3>
            <dl>
              {row('Capital colocado', r.portfolio.principalPlacedMinor, { hint: 'Capital pendiente de las ventas, sin interés' })}
              {row('Cartera con interés', r.portfolio.outstandingWithInterestMinor, { hint: 'Incluye interés aún no cobrado' })}
              {row('Ventas aprobadas sin desembolsar', r.approvedNotDisbursedMinor)}
            </dl>
          </section>
          <section id="rb-d-periodo" aria-labelledby="rb-d-p-h">
            <h3 id="rb-d-p-h" className="text-sm font-semibold text-gray-900 mb-1">Periodo y resultado</h3>
            <dl>
              {row('Recaudos', r.period.collectionsMinor, { hint: `De ellos, interés cobrado ${money(r.period.interestCollectedMinor)}` })}
              {row('Capital desembolsado', r.period.principalDisbursedMinor)}
              {row('Gastos operativos', r.period.expenses.operativoMinor)}
              {row('Otros gastos', r.period.expenses.otroMinor)}
              {row('Bienes duraderos', r.period.expenses.bienDuraderoMinor, { hint: 'Aparte: no cuentan en el resultado operativo' })}
              {row('Resultado operativo básico', r.operatingResultMinor, { strong: true, hint: 'Interés cobrado − gastos operativos y otros. No es utilidad contable ni dinero retirable' })}
              {row('Flujo operativo', r.operatingFlowMinor, { hint: 'Recaudos − desembolsos − gastos. Puede ser negativo sin ser pérdida' })}
              {r.capitalNeedMinor != null && row('Necesidad de capital', r.capitalNeedMinor)}
            </dl>
          </section>
        </div>
        <section id="rb-d-entrega" aria-labelledby="rb-d-e-h" className="space-y-2">
          <h3 id="rb-d-e-h" className="text-sm font-semibold text-gray-900">Entrega de la ruta</h3>
          {r.handoverState === 'en_entrega'
            ? <Notice tone="violet" testId="rb-d-handover">Ruta en entrega: el nuevo responsable debe contar la Base y confirmar. Hasta entonces no hay inyecciones, retiros, entregas ni transferencias de salida.</Notice>
            : <p className="text-sm text-gray-600">Sin entrega pendiente.</p>}
          {r.lastHandover && r.lastHandover.status === 'confirmada' && (
            <p className="text-xs text-gray-600">Última entrega confirmada {r.lastHandover.confirmed_at ? formatDateTime(r.lastHandover.confirmed_at) : ''}: esperado {money(r.lastHandover.expected_base_minor)}, contado {money(r.lastHandover.counted_minor)}{r.lastHandover.difference_minor ? `, diferencia ${money(r.lastHandover.difference_minor)}` : ', sin diferencia'}.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {canConfirm && <Button size="sm" onClick={() => onConfirm(r)} icon={<Handshake className="w-3.5 h-3.5" />}>Confirmar conteo</Button>}
            {isSa && !changing && (
              <Button size="sm" variant="secondary" onClick={() => setChanging({ adminId: '', motivo: '' })} disabled={candidates.length === 0} icon={<Repeat className="w-3.5 h-3.5" />} data-testid="rb-change-controller">
                {r.controller.id ? 'Cambiar responsable' : 'Asignar responsable'}
              </Button>
            )}
          </div>
          {isSa && candidates.length === 0 && !changing && <p className="text-xs text-gray-500">Para cambiar el responsable, asigna antes otro Administrador activo a la ruta (Rutas).</p>}
          {isSa && changing && (
            <div className="rounded-xl border border-gray-200 p-3 space-y-3" data-testid="rb-change-form">
              <Notice tone="sky">La Base no se mueve: sigue siendo de la ruta. La ruta queda <b>en entrega</b> hasta que el nuevo responsable cuente la Base y confirme.</Notice>
              <Select label="Nuevo responsable" value={changing.adminId} onChange={(e) => setChanging((c) => c && { ...c, adminId: e.target.value })} placeholder="Seleccionar Administrador asignado"
                options={candidates.map((a) => ({ value: a.id, label: formatPersonName(a.nombre) }))} required />
              <Textarea label="Motivo" value={changing.motivo} onChange={(e) => setChanging((c) => c && { ...c, motivo: e.target.value })} rows={2} required />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="secondary" onClick={() => setChanging(null)} disabled={saving}>Cancelar</Button>
                <Button size="sm" onClick={saveController} loading={saving} disabled={!changing.adminId} data-testid="rb-change-save">Cambiar responsable</Button>
              </div>
            </div>
          )}
        </section>
        <section className="flex flex-wrap gap-x-4 gap-y-2 border-t border-gray-100 pt-3 text-sm" aria-label="Ver en Consultas">
          <Link to={`/admin/consultas?${q}`} className="text-primary-700 hover:underline inline-flex items-center gap-1"><History className="w-4 h-4" aria-hidden />Dinero de la ruta (Base y custodias)</Link>
          <Link to={`/admin/consultas?vista=actividad&${q}`} className="text-primary-700 hover:underline inline-flex items-center gap-1"><Info className="w-4 h-4" aria-hidden />Actividad de la ruta</Link>
          <span className="text-xs text-gray-500 basis-full">«Dinero de la ruta» incluye la Base (inyecciones, retiros, transferencias, aportes a gastos generales y reembolsos) y las custodias de sus trabajadores (entregas, devoluciones, recaudos). Cada operación abre su detalle con comprobante.</span>
        </section>
      </div>
    </Modal>
  );
}
