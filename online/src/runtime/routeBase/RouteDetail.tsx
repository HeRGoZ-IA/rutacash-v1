// DETALLE DE UNA RUTA (3.38): una sola ventana, usada desde Caja principal / Panel de rutas y desde
// Rutas («Ver detalle», 3.37). Cabecera fija (ruta, responsable, avisos y 3 cifras) y pestañas:
//   Resumen · Movimientos · Resultado · Liquidaciones · Responsable.
// Solo presenta cifras del panel (`GET /v1/capital/route-panel`) y registros ya proyectados
// (cierres de ruta y cuadres por trabajador); no calcula nada nuevo.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange, HandCoins, Handshake, History, Info, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useAuth } from '@/hooks/useAuth';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatDate, formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { validRouteAdmins } from '@/lib/capitalAllocation';
import { setRouteCapitalController } from '@/services/capitalControlService';
import { cn, generateId } from '@/lib/utils';
import type { CashSettlement, Route, User, WeeklySettlement } from '@/models/types';
import { todayIn } from '../../lib/format.ts';
import { useRuntime } from '../session.ts';
import { fetchControllerEvents, fetchHandovers, fetchPanel, repayPartnerDebt, type ControllerEvent, type Handover, type PanelRoute } from './api.ts';
import { AlertChip, Notice, StateBadge, activeStates, num, otherAlerts, stateHelp, useMoney } from './parts.tsx';
import { toMajor, toMinor } from '../mappers.ts';

/** Cifra que abrió el detalle (Caja principal): decide la pestaña inicial. */
export type Section = 'efectivo' | 'base' | 'cartera' | 'periodo' | 'estados' | 'entrega' | 'deuda';
type Tab = 'resumen' | 'movimientos' | 'resultado' | 'liquidaciones' | 'responsable';
const TABS: [Tab, string][] = [['resumen', 'Resumen'], ['movimientos', 'Movimientos'], ['resultado', 'Resultado'], ['liquidaciones', 'Liquidaciones'], ['responsable', 'Responsable']];
const TAB_OF: Record<Section, Tab> = { efectivo: 'resumen', cartera: 'resumen', deuda: 'resumen', estados: 'resumen', base: 'movimientos', periodo: 'resultado', entrega: 'responsable' };

/** 0052: a quién le debe la ruta («ti» si es el actor). */
export function debtCreditors(d: { creditors: { adminId: string; name: string | null; outstandingMinor: number }[] }, mine: boolean | string | null | undefined): string {
  const me = typeof mine === 'string' ? mine : null;
  const names = d.creditors.filter((c) => c.outstandingMinor > 0).map((c) => (me && c.adminId === me ? 'ti' : formatPersonName(c.name) || 'su Administrador'));
  return names.length ? names.join(' y ') : 'su Administrador';
}

// ---------------------------------------------------------------------------
// 3.37 · Detalle abierto desde Rutas: carga el panel de hoy y muestra la MISMA ventana.
// ---------------------------------------------------------------------------

export function RouteDetailLoader({ routeId, onClose }: { routeId: string | null; onClose: () => void }) {
  const { tenantId } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const isSa = me?.role === 'superadmin';
  const revision = useDataRevision();
  const today = useMemo(() => todayIn(me?.company.timezone ?? 'UTC'), [me?.company.timezone, revision]);
  const [route, setRoute] = useState<PanelRoute | null | undefined>(undefined);
  const [users, setUsers] = useState<User[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!routeId) { setRoute(undefined); return; }
    let alive = true;
    fetchPanel(today, today)
      .then((p) => { if (alive) setRoute(p.routes.find((x) => x.routeId === routeId) ?? null); })
      .catch(() => { if (alive) setRoute(null); });
    void Promise.all([db.users.where('tenantId').equals(tenantId).toArray(), db.routes.where('tenantId').equals(tenantId).toArray()])
      .then(([u, r]) => { if (alive) { setUsers(u); setRoutes(r); } }).catch(() => undefined);
    if (!isSa) fetchHandovers({ status: 'pendiente', routeId }).then((l) => { if (alive) setPending(l.some((h) => h.toId === me?.membershipId)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [routeId, today, revision, tenantId, isSa, me?.membershipId]);
  if (!routeId) return null;
  if (route === null) {
    return (
      <Modal open onClose={onClose} size="sm" title="Detalle de la ruta" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
        <p className="text-sm text-gray-600" data-testid="rb-route-detail-unavailable">El detalle de esta ruta no está disponible: no está en tu alcance de capital o el servidor no respondió.</p>
      </Modal>
    );
  }
  if (!route) {
    return (
      <Modal open onClose={onClose} size="sm" title="Detalle de la ruta">
        <p className="text-sm text-gray-500" role="status">Cargando…</p>
      </Modal>
    );
  }
  return <RouteDetail r={route} section="efectivo" range={{ from: today, to: today }} isSa={isSa} users={users} routes={routes}
    onClose={onClose} onConfirm={() => onClose()} canConfirm={pending} />;
}

// ---------------------------------------------------------------------------
// La ventana
// ---------------------------------------------------------------------------

export function RouteDetail({ r, section, range, isSa, users, routes, onClose, onConfirm, canConfirm }: {
  r: PanelRoute | null; section: Section; range: { from: string; to: string }; isSa: boolean; users: User[]; routes: Route[];
  onClose: () => void; onConfirm: (r: PanelRoute) => void; canConfirm: boolean;
}) {
  const money = useMoney();
  const me = useRuntime((s) => s.ctx);
  const [tab, setTab] = useState<Tab>(TAB_OF[section]);
  useEffect(() => { setTab(TAB_OF[section]); }, [r?.routeId, section]);
  if (!r) return null;
  const states = activeStates(r);
  const alerts = otherAlerts(r);
  const debt = r.partnerDebt?.outstandingMinor ?? 0;
  const who = r.partnerDebt ? debtCreditors(r.partnerDebt, me?.membershipId) : 'su Administrador';
  const periodText = range.from === range.to ? range.from : `${range.from} a ${range.to}`;
  const route = routes.find((x) => x.id === r.routeId);

  return (
    <Modal open onClose={onClose} size="xl" title={r.name}
      footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <div data-testid="rb-route-drawer">
        {/* ---------- Cabecera fija ---------- */}
        <div className="sticky -top-4 sm:-top-6 z-10 -mx-4 sm:-mx-6 -mt-4 sm:-mt-6 px-4 sm:px-6 pt-4 sm:pt-5 pb-0 bg-white border-b border-gray-100 space-y-3" data-testid="rb-d-header">
          <p className="text-sm text-gray-600">
            {route?.codigo ? <span className="text-gray-500">{route.codigo} · </span> : null}
            Responsable de capital: <b className="text-gray-900">{me?.membershipId && r.controller.id === me.membershipId ? 'Tú' : formatPersonName(r.controller.name) || 'sin responsable'}</b>
            {!r.controller.valid && r.controller.id ? ' (no válido)' : ''}
          </p>
          {(states.length > 0 || alerts.length > 0) && (
            <div className="flex flex-wrap gap-1" aria-label="Avisos de la ruta" data-testid="rb-d-alerts">
              {states.map((k) => <StateBadge key={k} k={k} detail={k === 'insufficientLiquidity' && r.capitalNeedMinor ? `faltan ${money(r.capitalNeedMinor)}` : undefined} />)}
              {alerts.map((a) => <AlertChip key={a} a={a} />)}
            </div>
          )}
          <dl className={cn('grid gap-2', debt > 0 ? 'grid-cols-3' : 'grid-cols-2')}>
            <HeadFig label="Base disponible" value={money(r.baseMinor)} testId="rb-d-head-base" />
            <HeadFig label="Cartera activa" value={money(r.portfolio.outstandingWithInterestMinor)} testId="rb-d-head-portfolio" />
            {debt > 0 && <HeadFig label={who === 'ti' ? 'Te debe' : 'Deuda con el Admin'} value={money(debt)} tone="amber" testId="rb-d-head-debt" />}
          </dl>
          <div className="flex flex-wrap gap-x-1" role="tablist" aria-label="Secciones del detalle">
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`rb-d-tab-${k}`}
                className={cn('px-2.5 sm:px-3 h-9 text-sm font-medium border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded-t-md',
                  tab === k ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-600 hover:text-gray-900')}>{label}</button>
            ))}
          </div>
        </div>

        <div className="pt-4" role="tabpanel">
          {tab === 'resumen' && <SummaryTab r={r} isSa={isSa} myId={me?.membershipId} states={states} />}
          {tab === 'movimientos' && <MovementsTab r={r} range={range} periodText={periodText} myId={me?.membershipId} />}
          {tab === 'resultado' && <ResultTab r={r} periodText={periodText} />}
          {tab === 'liquidaciones' && <SettlementsTab r={r} users={users} />}
          {tab === 'responsable' && <ControllerTab r={r} isSa={isSa} users={users} routes={routes} onConfirm={onConfirm} canConfirm={canConfirm} />}
        </div>
      </div>
    </Modal>
  );
}

function HeadFig({ label, value, tone, testId }: { label: string; value: string; tone?: 'amber'; testId?: string }) {
  return (
    <div className={cn('min-w-0 rounded-xl px-3 py-2', tone === 'amber' ? 'bg-amber-50' : 'bg-gray-50')} data-testid={testId}>
      <dt className={cn('text-xs truncate', tone === 'amber' ? 'text-amber-900' : 'text-gray-600')}>{label}</dt>
      <dd className={cn(num, 'text-base sm:text-lg font-bold', tone === 'amber' ? 'text-amber-900' : 'text-gray-900')}>{value}</dd>
    </div>
  );
}

/** Fila «etiqueta … cifra» de las pestañas. */
function useRow() {
  const money = useMoney();
  return (label: string, v: number | null | undefined, opts: { sign?: '+' | '−'; strong?: boolean; hint?: string } = {}) => (
    <div className={cn('flex items-baseline justify-between gap-3 py-1', opts.strong && 'border-t border-gray-200 mt-1 pt-2')}>
      <dt className={cn('text-sm', opts.strong ? 'font-semibold text-gray-900' : 'text-gray-600')}>{label}{opts.hint && <span className="block text-[11px] text-gray-500">{opts.hint}</span>}</dt>
      <dd className={cn(num, 'text-sm', opts.strong ? 'font-bold text-gray-900' : 'text-gray-900')}>{opts.sign && v ? `${opts.sign} ` : ''}{money(v ?? 0)}</dd>
    </div>
  );
}

function H({ id, children }: { id: string; children: ReactNode }) {
  return <h3 id={id} className="text-sm font-semibold text-gray-900 mb-1">{children}</h3>;
}

// ---------- Resumen ----------
function SummaryTab({ r, isSa, myId, states }: { r: PanelRoute; isSa: boolean; myId: string | undefined; states: ReturnType<typeof activeStates> }) {
  const money = useMoney();
  const row = useRow();
  return (
    <div className="space-y-5" data-testid="rb-d-summary">
      {states.length > 0 && (
        <section id="rb-d-estados" className="space-y-1.5" aria-label="Qué significan los avisos">
          {states.map((k) => (
            <p key={k} className="text-xs text-gray-600"><StateBadge k={k} /> <span className="ml-1">{stateHelp(k)}{k === 'insufficientLiquidity' && r.capitalNeedMinor ? ` Faltan ${money(r.capitalNeedMinor)}.` : ''}</span></p>
          ))}
        </section>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section id="rb-d-efectivo" aria-label="Efectivo de la ruta">
          <dl>
            {row('Base disponible', r.baseMinor)}
            {row('Base del trabajador (bruto)', r.custody.grossMinor, { hint: `${r.custody.positions} trabajador(es) con efectivo` })}
            {row('Efectivo de la ruta', r.cashMinor, { strong: true })}
            {row('Base del trabajador entregable', r.custody.deliverableMinor, { hint: 'Lo que los trabajadores pueden entregar hoy' })}
            {r.custody.negativeMinor < 0 && row('Base del trabajador negativa', r.custody.negativeMinor, { hint: 'Gastos de trabajadores por encima de su efectivo; no es efectivo' })}
            {r.custody.carriedShortageMinor > 0 && row('Faltante arrastrado', r.custody.carriedShortageMinor, { hint: 'Reconocido en cuadres; no es billete' })}
            {r.surplusInControlMinor > 0 && row('Sobrante en control', r.surplusInControlMinor, { hint: 'Aparte; no es Base disponible' })}
          </dl>
        </section>
        <section id="rb-d-cartera" aria-labelledby="rb-d-c-h">
          <H id="rb-d-c-h">Cartera (no es efectivo)</H>
          <dl>
            {row('Capital colocado', r.portfolio.principalPlacedMinor, { hint: 'Capital pendiente de las ventas, sin interés' })}
            {row('Cartera activa', r.portfolio.outstandingWithInterestMinor, { hint: 'Capital + interés aún no cobrado' })}
            {row('Ventas aprobadas sin desembolsar', r.approvedNotDisbursedMinor)}
          </dl>
        </section>
      </div>
      {r.partnerDebt && r.partnerDebt.debtMinor > 0 && <PartnerDebtSection r={r} mine={myId === r.controller.id && !isSa} myId={myId} />}
    </div>
  );
}

// ---------- Movimientos ----------
function MovementsTab({ r, range, periodText, myId }: { r: PanelRoute; range: { from: string; to: string }; periodText: string; myId: string | undefined }) {
  const row = useRow();
  const b = r.period.base;
  const q = `perspectiva=${encodeURIComponent(`route:${r.routeId}`)}&desde=${range.from}&hasta=${range.to}`;
  return (
    <div className="space-y-5" data-testid="rb-d-movements">
      <section id="rb-d-base" aria-labelledby="rb-d-b-h">
        <H id="rb-d-b-h">Movimiento de la Base · {periodText}</H>
        {!b ? <p className="text-sm text-gray-500">Sin datos de la Base para este periodo.</p> : (
          <dl data-testid="rb-d-base-block" className="max-w-xl">
            {row('Saldo inicial', b.openingMinor)}
            {b.injectionsMinor > 0 && row('Inyecciones de Base', b.injectionsMinor, { sign: '+' })}
            {b.unassignedAssignedMinor > 0 && row('Reparto de saldo sin asignar', b.unassignedAssignedMinor, { sign: '+' })}
            {b.transfersInMinor > 0 && row('Transferencias recibidas', b.transfersInMinor, { sign: '+' })}
            {b.returnsReceivedMinor > 0 && row('Devoluciones de Cobradores', b.returnsReceivedMinor, { sign: '+' })}
            {b.collectionsReceivedMinor > 0 && row('Recaudo recibido en la Base disponible', b.collectionsReceivedMinor, { sign: '+' })}
            {b.withdrawalsMinor > 0 && row('Retiros de Base', b.withdrawalsMinor, { sign: '−' })}
            {b.transfersOutMinor > 0 && row('Transferencias enviadas', b.transfersOutMinor, { sign: '−' })}
            {b.deliveredToWorkersMinor > 0 && row('Entregas de Base a Cobradores', b.deliveredToWorkersMinor, { sign: '−' })}
            {b.disbursedMinor > 0 && row('Desembolsos desde la Base disponible', b.disbursedMinor, { sign: '−' })}
            {b.routeExpensesMinor > 0 && row('Gastos pagados con la Base', b.routeExpensesMinor, { sign: '−' })}
            {b.reassignmentsNetMinor !== 0 && row('Reasignaciones entre rutas (neto)', b.reassignmentsNetMinor)}
            {(b.partnerCoverMinor ?? 0) > 0 && row(`Cubierto por ${debtCreditors(r.partnerDebt ?? { creditors: [] }, myId)} (deuda de la ruta)`, b.partnerCoverMinor, { sign: '+', hint: 'Caja negativa del sistema anterior: se le devuelve con la Base de esta ruta' })}
            {(b.partnerRepaidMinor ?? 0) > 0 && row('Devuelto al Administrador', b.partnerRepaidMinor, { sign: '−' })}
            {(b.migrationLoadsMinor ?? 0) !== 0 && row('Cierres de la migración (neto)', b.migrationLoadsMinor, { hint: 'Abonos, créditos e ingresos de los cierres del sistema anterior' })}
            {b.otherMinor !== 0 && row('Otros (anulaciones, cuadres)', b.otherMinor)}
            {row('Saldo final', b.closingMinor, { strong: true })}
            {row('Aportes netos acumulados', r.contributionsNetMinor, { hint: 'Inyecciones menos retiros desde la activación' })}
          </dl>
        )}
      </section>
      <section className="flex flex-wrap gap-x-4 gap-y-2 border-t border-gray-100 pt-3 text-sm" aria-label="Ver en Consultas">
        <Link to={`/admin/consultas?${q}`} className="text-primary-700 hover:underline inline-flex items-center gap-1"><History className="w-4 h-4" aria-hidden />Dinero de la ruta (Base de la ruta y del trabajador)</Link>
        <Link to={`/admin/consultas?vista=actividad&${q}`} className="text-primary-700 hover:underline inline-flex items-center gap-1"><Info className="w-4 h-4" aria-hidden />Actividad de la ruta</Link>
        <span className="text-xs text-gray-500 basis-full">«Dinero de la ruta» incluye la Base disponible (inyecciones, retiros, transferencias, aportes a gastos generales y reembolsos) y la Base de sus trabajadores (entregas, devoluciones, recaudos). Cada operación abre su detalle con comprobante.</span>
      </section>
    </div>
  );
}

// ---------- Resultado ----------
function ResultTab({ r, periodText }: { r: PanelRoute; periodText: string }) {
  const money = useMoney();
  const row = useRow();
  const loss = r.period.creditLossMinor ?? 0;
  return (
    <section id="rb-d-periodo" aria-labelledby="rb-d-p-h" data-testid="rb-d-result">
      <H id="rb-d-p-h">Periodo y resultado · {periodText}</H>
      <dl className="max-w-xl">
        {row('Recaudo', r.period.collectionsMinor, { hint: `De ellos, interés cobrado ${money(r.period.interestCollectedMinor)}` })}
        {row('Capital desembolsado', r.period.principalDisbursedMinor)}
        {row('Gastos operativos', r.period.expenses.operativoMinor)}
        {row('Otros gastos', r.period.expenses.otroMinor)}
        {row('Bienes duraderos', r.period.expenses.bienDuraderoMinor, { hint: 'Aparte: no cuentan en el resultado operativo' })}
        {/* 3.28 (0053): línea aparte; baja el resultado, no el efectivo. */}
        {loss !== 0 && row('Pérdida por créditos (capital)', loss, { hint: 'Capital de ventas dadas por perdidas en el periodo, menos lo recuperado. No es efectivo' })}
        {row('Resultado operativo', r.operatingResultMinor, { strong: true, hint: loss !== 0
          ? 'Interés cobrado − gastos operativos y otros − pérdida por créditos. No es utilidad contable ni dinero retirable'
          : 'Interés cobrado − gastos operativos y otros. No es utilidad contable ni dinero retirable' })}
        {row('Flujo operativo', r.operatingFlowMinor, { hint: 'Recaudo − desembolsos − gastos. Puede ser negativo sin ser pérdida' })}
        {r.capitalNeedMinor != null && row('Necesidad de capital', r.capitalNeedMinor)}
      </dl>
      <p className="text-xs text-gray-500 mt-2">El periodo se elige en Caja principal; desde Rutas el detalle muestra el día de hoy.</p>
    </section>
  );
}

// ---------- Liquidaciones (idea de Helmer) ----------
const WORKER_ROLES = new Set(['cobrador', 'supervisor']);

function SettlementsTab({ r, users }: { r: PanelRoute; users: User[] }) {
  const money = useMoney();
  const revision = useDataRevision();
  const [closes, setCloses] = useState<WeeklySettlement[] | null>(null);
  const [cuadres, setCuadres] = useState<CashSettlement[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([db.weeklySettlements.where('routeId').equals(r.routeId).toArray(), db.cashSettlements.where('routeId').equals(r.routeId).toArray()])
      .then(([w, c]) => { if (alive) { setCloses(w); setCuadres(c); } }).catch(() => { if (alive) setCloses([]); });
    return () => { alive = false; };
  }, [r.routeId, revision]);
  const lastClose = (closes ?? []).filter((w) => w.status !== 'reabierta' && w.status !== 'abierta' && !w.supersededBy)
    .sort((a, b) => b.semanaFin.localeCompare(a.semanaFin) || (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))[0];
  // Trabajadores: los asignados a la ruta (Cobrador / Supervisor activos) y quien tenga cuadres en ella.
  const valid = cuadres.filter((c) => c.status === 'cerrada' && !c.supersededBy);
  const lastOf = (id: string) => valid.filter((c) => c.userId === id).sort((a, b) => b.closedAt.localeCompare(a.closedAt))[0];
  const workerIds = new Set<string>([
    ...users.filter((u) => WORKER_ROLES.has(u.rol) && u.status === 'activo' && (u.authorizedRouteIds ?? []).includes(r.routeId)).map((u) => u.id),
    ...valid.map((c) => c.userId),
  ]);
  const workers = [...workerIds].map((id) => ({ id, user: users.find((u) => u.id === id), last: lastOf(id) }))
    .sort((a, b) => formatPersonName(a.user?.nombre ?? '').localeCompare(formatPersonName(b.user?.nombre ?? '')));
  const base = `/admin/weekly-settlement?routeId=${encodeURIComponent(r.routeId)}`;
  if (!closes) return <p className="text-sm text-gray-500" role="status">Cargando…</p>;
  return (
    <div className="space-y-5" data-testid="rb-d-settlements">
      <section aria-labelledby="rb-d-l-h" className="space-y-2">
        <H id="rb-d-l-h">Último cierre de la ruta</H>
        {lastClose ? (
          <div className="rounded-xl border border-gray-100 p-3 text-sm" data-testid="rb-d-last-close">
            <p className="text-gray-900 font-medium">{lastClose.semanaInicio === lastClose.semanaFin ? formatDate(lastClose.semanaFin) : `${formatDate(lastClose.semanaInicio)} a ${formatDate(lastClose.semanaFin)}`}</p>
            <p className="text-xs text-gray-600">Cerrado{lastClose.closedAt ? ` el ${formatDateTime(lastClose.closedAt)}` : ''} · saldo final {money(toMinor(lastClose.saldoFinal))}</p>
          </div>
        ) : <p className="text-sm text-gray-500" data-testid="rb-d-last-close">Esta ruta todavía no tiene cierres.</p>}
        <Link to={base} data-testid="rb-d-go-route-close"
          className="inline-flex items-center gap-2 h-9 px-3 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
          <CalendarRange className="w-4 h-4" aria-hidden />Ir a la liquidación de la ruta
        </Link>
      </section>
      <section aria-labelledby="rb-d-w-h" className="space-y-2">
        <H id="rb-d-w-h">Cuadre por trabajador</H>
        {workers.length === 0 ? <p className="text-sm text-gray-500">La ruta no tiene Cobradores ni Supervisores asignados.</p> : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100" data-testid="rb-d-workers">
            {workers.map(({ id, user, last }) => (
              <li key={id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{formatPersonName(user?.nombre ?? '') || 'Trabajador'}</p>
                  <p className="text-xs text-gray-600">
                    {last
                      ? <>Último cuadre {formatDateTime(last.closedAt)}{last.faltante > 0 ? <> · <span className="text-red-700">faltante {money(toMinor(last.faltante))}</span></> : last.sobrante > 0 ? <> · sobrante {money(toMinor(last.sobrante))}</> : ' · sin diferencia'}</>
                      : 'Sin cuadres todavía'}
                  </p>
                </div>
                <Link to={`/admin/weekly-settlement?vista=trabajadores&routeId=${encodeURIComponent(r.routeId)}&userId=${encodeURIComponent(id)}`} data-testid="rb-d-go-worker"
                  className="text-sm font-medium text-primary-700 hover:underline flex-shrink-0">Cuadrar</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------- Responsable (antes «Entrega de la ruta») ----------
const CONTROLLER_KIND: Record<ControllerEvent['kind'], string> = {
  MIGRATION: 'Responsable inicial',
  FIRST_ADMIN: 'Primer responsable',
  CHANGE: 'Cambio de responsable',
  RELEASE: 'Ruta sin responsable',
};

function ControllerTab({ r, isSa, users, routes, onConfirm, canConfirm }: {
  r: PanelRoute; isSa: boolean; users: User[]; routes: Route[]; onConfirm: (r: PanelRoute) => void; canConfirm: boolean;
}) {
  const money = useMoney();
  const { tenantId } = useTenant();
  const { user } = useAuth();
  const [changing, setChanging] = useState<{ adminId: string; motivo: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setChanging(null); }, [r.routeId]);
  const route = routes.find((x) => x.id === r.routeId);
  const candidates = route ? validRouteAdmins(users, route).filter((a) => a.id !== r.controller.id) : [];

  async function saveController() {
    if (!changing || !user) return;
    if (changing.motivo.trim().length < 3) { toast.error('Indica el motivo.'); return; }
    setSaving(true);
    try {
      await setRouteCapitalController({ actor: user, tenantId, routeId: r.routeId, adminId: changing.adminId, motivo: changing.motivo });
      toast.success('Responsable de capital cambiado: la ruta espera que el nuevo responsable cuente la Base y confirme');
      setChanging(null);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }

  return (
    <section id="rb-d-entrega" aria-labelledby="rb-d-e-h" className="space-y-3" data-testid="rb-d-controller">
      <H id="rb-d-e-h">Responsable de capital</H>
      {r.handoverState === 'en_entrega'
        ? <Notice tone="violet" testId="rb-d-handover">Cambio de responsable pendiente: el nuevo responsable debe contar la Base y confirmar. Hasta entonces no hay inyecciones, retiros, entregas a trabajadores ni transferencias de salida.</Notice>
        : <p className="text-sm text-gray-600">Sin cambio de responsable pendiente.</p>}
      {r.lastHandover && r.lastHandover.status === 'confirmada' && (
        <p className="text-xs text-gray-600">Último cambio confirmado {r.lastHandover.confirmed_at ? formatDateTime(r.lastHandover.confirmed_at) : ''}: Base esperada {money(r.lastHandover.expected_base_minor)}, contada {money(r.lastHandover.counted_minor)}{r.lastHandover.difference_minor ? `, diferencia ${money(r.lastHandover.difference_minor)}` : ', sin diferencia'}.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {canConfirm && <Button size="sm" onClick={() => onConfirm(r)} icon={<Handshake className="w-3.5 h-3.5" />}>Confirmar conteo</Button>}
        {isSa && !changing && (
          <Button size="sm" variant="secondary" onClick={() => setChanging({ adminId: '', motivo: '' })} disabled={candidates.length === 0} icon={<Repeat className="w-3.5 h-3.5" />} data-testid="rb-change-controller">
            {r.controller.id ? 'Cambio de responsable' : 'Asignar responsable'}
          </Button>
        )}
      </div>
      {isSa && candidates.length === 0 && !changing && <p className="text-xs text-gray-500">Para cambiar el responsable, asigna antes otro Administrador activo a la ruta (Rutas).</p>}
      {isSa && changing && (
        <div className="rounded-xl border border-gray-200 p-3 space-y-3" data-testid="rb-change-form">
          <Notice tone="sky">La Base no se mueve: sigue siendo de la ruta. El nuevo responsable debe contar la Base y confirmar antes de volver a operarla.</Notice>
          <Select label="Nuevo responsable" value={changing.adminId} onChange={(e) => setChanging((c) => c && { ...c, adminId: e.target.value })} placeholder="Seleccionar Administrador asignado"
            options={candidates.map((a) => ({ value: a.id, label: formatPersonName(a.nombre) }))} required />
          <Textarea label="Motivo" value={changing.motivo} onChange={(e) => setChanging((c) => c && { ...c, motivo: e.target.value })} rows={2} required />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={() => setChanging(null)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={saveController} loading={saving} disabled={!changing.adminId} data-testid="rb-change-save">Cambiar responsable</Button>
          </div>
        </div>
      )}
      <ControllerHistory routeId={r.routeId} users={users} />
    </section>
  );
}

function ControllerHistory({ routeId, users }: { routeId: string; users: User[] }) {
  const money = useMoney();
  const revision = useDataRevision();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ events: ControllerEvent[]; handovers: Handover[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setOpen(false); setData(null); }, [routeId]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFailed(false);
    Promise.all([fetchControllerEvents(routeId), fetchHandovers({ routeId })])
      .then(([events, handovers]) => { if (alive) setData({ events, handovers }); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open, routeId, revision]);
  const name = (id: string | null) => (id ? formatPersonName(users.find((u) => u.id === id)?.nombre ?? '') || 'Administrador' : 'nadie');
  // El acta del cambio nace en la misma transacción que el cambio: mismo destino y misma hora.
  const handoverOf = (e: ControllerEvent) => data?.handovers.find((h) => h.toId === e.toAdminId
    && Math.abs(new Date(h.startedAt).getTime() - new Date(e.createdAt).getTime()) < 60_000);
  const result = (h: Handover | undefined) => {
    if (!h) return null;
    if (h.status === 'pendiente') return 'Pendiente: falta el conteo del nuevo responsable.';
    if (h.status === 'sustituida') return 'Sustituido por un cambio posterior.';
    const diff = h.differenceMinor ?? 0;
    return `Conteo confirmado${h.confirmedAt ? ` el ${formatDateTime(h.confirmedAt)}` : ''}: esperado ${money(h.expectedBaseMinor ?? 0)}, contado ${money(h.countedMinor ?? 0)}`
      + (diff < 0 ? `, faltante de ${money(-diff)}.` : diff > 0 ? `, sobrante de ${money(diff)}.` : ', sin diferencia.');
  };
  if (!open) {
    return <button type="button" className="text-sm text-primary-700 hover:underline inline-flex items-center gap-1" onClick={() => setOpen(true)} data-testid="rb-controller-history-open">
      <History className="w-4 h-4" aria-hidden />Ver historial de responsables</button>;
  }
  return (
    <div className="rounded-xl border border-gray-200 p-3" data-testid="rb-controller-history">
      <p className="text-sm font-medium text-gray-900 mb-1">Historial de responsables</p>
      {failed ? <p className="text-sm text-red-700">No se pudo cargar el historial. Inténtalo de nuevo.</p>
        : !data ? <p className="text-sm text-gray-500" role="status">Cargando…</p>
        : data.events.length === 0 ? <p className="text-sm text-gray-500">Sin cambios de responsable registrados.</p>
        : (
          <ol className="divide-y divide-gray-100">
            {data.events.map((e) => (
              <li key={e.id} className="py-2" data-testid="rb-controller-event">
                <p className="text-sm text-gray-900">{CONTROLLER_KIND[e.kind]}: {name(e.fromAdminId)} → {name(e.toAdminId)}</p>
                <p className="text-xs text-gray-500">{formatDateTime(e.createdAt)} · registró {e.actorSystem ? 'el sistema' : name(e.actorId)}{e.reason ? ` · Motivo: ${e.reason}` : ''}</p>
                {result(handoverOf(e)) && <p className="text-xs text-gray-600">{result(handoverOf(e))}</p>}
              </li>
            ))}
          </ol>
        )}
      <button type="button" className="mt-1 text-xs text-gray-500 hover:underline" onClick={() => setOpen(false)}>Ocultar historial</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 0052: deuda de la ruta con su Administrador (caja cubierta en la migración)
// ---------------------------------------------------------------------------

function PartnerDebtSection({ r, mine, myId }: { r: PanelRoute; mine: boolean; myId: string | undefined }) {
  const money = useMoney();
  const { currency } = useTenant();
  const d = r.partnerDebt!;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [opId, setOpId] = useState('');
  const [saving, setSaving] = useState(false);
  const who = debtCreditors(d, myId);
  const max = Math.max(0, Math.min(d.outstandingMinor, r.baseMinor));
  const amountMinor = toMinor(amount);
  const problem = amountMinor <= 0 ? 'Escribe el valor.' : amountMinor > d.outstandingMinor ? `La ruta solo debe ${money(d.outstandingMinor)}.`
    : amountMinor > r.baseMinor ? `La Base disponible de ${r.name} es ${money(r.baseMinor)}.` : reason.trim().length < 3 ? 'Escribe el concepto (mínimo 3 caracteres).' : null;
  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      await repayPartnerDebt({ routeId: r.routeId, amountMinor, reason }, opId);
      toast.success(`Devolución registrada: ${money(amountMinor)} desde la Base de ${r.name}`);
      setOpen(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  return (
    <section id="rb-d-deuda" aria-labelledby="rb-d-dd-h" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3" data-testid="rb-d-partner-debt">
      <h3 id="rb-d-dd-h" className="text-sm font-semibold text-gray-900">Deuda de la ruta {who === 'ti' ? 'contigo' : `con ${who}`}</h3>
      <p className="text-xs text-gray-600">En la migración, la caja del sistema anterior estaba negativa: {who === 'ti' ? 'tú pusiste' : `${who} puso`} ese dinero.
        Se devuelve <b>solo con la Base de {r.name}</b>, cuando la ruta tenga dinero. No es efectivo ni gasto de la ruta.</p>
      <dl className="grid grid-cols-3 gap-2">
        <div><dt className="text-xs text-gray-500">Deuda</dt><dd className={cn(num, 'text-sm font-semibold')}>{money(d.debtMinor)}</dd></div>
        <div><dt className="text-xs text-gray-500">Devuelto</dt><dd className={cn(num, 'text-sm font-semibold')}>{money(d.repaidMinor)}</dd></div>
        <div><dt className="text-xs text-gray-500">Pendiente</dt><dd className={cn(num, 'text-sm font-semibold', d.outstandingMinor > 0 ? 'text-amber-900' : 'text-gray-900')}>{money(d.outstandingMinor)}</dd></div>
      </dl>
      {mine && d.outstandingMinor > 0 && !open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={<HandCoins className="w-3.5 h-3.5" />} disabled={max <= 0 || r.handoverState === 'en_entrega'}
            onClick={() => { setAmount(toMajor(max)); setReason('Devolución de la caja cubierta en la migración'); setOpId(generateId()); setOpen(true); }} data-testid="rb-d-repay">
            {who === 'ti' ? 'Devolverme con la Base de la ruta' : `Devolver a ${who} con la Base de la ruta`}
          </Button>
          {max <= 0 && <span className="text-xs text-gray-500">La Base disponible de la ruta está en {money(r.baseMinor)}: se podrá devolver cuando tenga dinero.</span>}
        </div>
      )}
      {mine && open && (
        <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-3" data-testid="rb-d-repay-form">
          <Notice tone="sky">Sale de la <b>Base disponible de {r.name}</b> (hoy {money(r.baseMinor)}) y baja la deuda de la ruta. Ninguna otra ruta se toca.</Notice>
          <MoneyInput label="Valor a devolver" currency={currency} value={amount} onValueChange={(v) => setAmount(v)} required
            hint={`Máximo ${money(max)} (lo menor entre la deuda y la Base)`} />
          <Textarea label="Concepto" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={save} loading={saving} disabled={!!problem} data-testid="rb-d-repay-save">Registrar devolución</Button>
          </div>
        </div>
      )}
    </section>
  );
}
