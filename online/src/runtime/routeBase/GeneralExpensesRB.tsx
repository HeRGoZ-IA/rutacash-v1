// GASTOS GENERALES Y REEMBOLSOS (R74 · migración 0035, decisión D74-O4F del propietario, §13.2 y §15.2).
//
// Regla rectora: el Administrador es el máximo responsable del dinero; nada de esto pide aprobación.
//   · A  (gasto general del Administrador) y C1 (gasto general de empresa): aportes EXPLÍCITOS de una o varias
//        rutas de las que él es el responsable vigente; él elige cuáles y cuánto; la suma es el gasto.
//   · C2 (dinero propio): no mueve efectivo; crea un saldo a favor del Administrador (obligación de la
//        empresa), siempre reembolsable, sin aprobación. NUNCA es efectivo ni suma a una Base.
//   · Reembolso: parcial o total, nunca más que lo pendiente; con Base por Ruta, aportes de las rutas de
//        quien paga (también a sí mismo: RB-D8); en el modelo de bolsas, desde la bolsa de quien paga (RB-D9).
//        No vuelve a reconocer el gasto: solo paga la obligación.
//   · Un gasto se registra UNA vez; se corrige solo anulándolo (con motivo). Si ya se reembolsó, primero se
//        anula el reembolso (PAYABLE_ALREADY_REIMBURSED).
// El SuperAdmin ve todo en solo lectura. Las cifras y las reglas son del servidor (PostgreSQL bajo bloqueo);
// aquí solo se ayuda a componer los aportes y se explica cada operación antes de registrarla.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HandCoins, Plus, Receipt, RotateCcw, Undo2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatDate } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { generateId, cn } from '@/lib/utils';
import type { User } from '@/models/types';
import { todayIn } from '../../lib/format.ts';
import { ApiFailure } from '../../lib/client.ts';
import { toMajor, toMinor } from '../mappers.ts';
import { serverView } from '../projection.ts';
import { useRuntime } from '../session.ts';
import {
  createGeneralExpense, fetchCategories, fetchGeneralExpenses, fetchPanel, fetchPayables, fetchReimbursements, natureLabel, reimburseAdmin,
  reverseExpense, reverseReimbursement,
  type CapitalModel, type Contribution, type Payables, type PanelRoute, type Reimbursement, type RoutePanel, type ServerCategory, type ServerExpense,
} from './api.ts';
import { ExplainPanel, Notice, num, useMoney, type Explanation } from './parts.tsx';

type Tab = 'gastos' | 'pendientes' | 'reembolsos';

/** Ruta que puede aportar (del panel): solo las del responsable vigente, activas y fuera de entrega. */
export interface FundingRoute { routeId: string; name: string; baseMinor: number; inHandover: boolean }
export const fundingRoutesOf = (rows: PanelRoute[], me: string | undefined): FundingRoute[] =>
  rows.filter((r) => r.controller.id === me && r.status === 'activa')
    .map((r) => ({ routeId: r.routeId, name: r.name, baseMinor: r.baseMinor, inHandover: r.handoverState === 'en_entrega' }));

const routeBaseUi = (m: CapitalModel) => m === 'route_base';

/**
 * RB-D7 (0036): ¿se ofrece «Anular»? Con Base por Ruta, lo que salió de rutas lo corrige el responsable VIGENTE de
 * esas rutas (aunque no lo registrara); se ofrece si controla al menos una y el servidor decide: si las rutas son de
 * varios responsables, responde JOINT_OPERATION_MIXED_CONTROLLERS con la lista, que el diálogo muestra. Lo que no
 * salió de rutas (dinero propio, bolsa) sigue siendo de su titular: el acreedor o quien pagó.
 */
const touchesMine = (contributions: { routeId: string | null }[], mine: ReadonlySet<string>) => contributions.some((c) => !!c.routeId && mine.has(c.routeId));
export const canReverseExpense = (e: ServerExpense, me: string | undefined, mine: ReadonlySet<string>, rb: boolean) =>
  !!me && e.state === 'vigente' && (rb && e.funding === 'routes' ? touchesMine(e.contributions, mine) : e.adminId === me);
const canReverseReimbursement = (r: Reimbursement, me: string | undefined, mine: ReadonlySet<string>, rb: boolean) =>
  !!me && r.state === 'vigente' && (rb && r.source === 'routes' ? touchesMine(r.contributions, mine) : r.payerId === me);

/**
 * Panel completo: cifras, registro (Administrador), obligaciones y reembolsos. `panel` (route_base) aporta las
 * cifras del periodo y las Bases de las rutas; sin él (modelo de bolsas) el panel lee lo suyo.
 */
export function GeneralExpensesPanel({ model, panel, periodText }: { model: CapitalModel; panel?: RoutePanel | null; periodText?: string }) {
  const { tenantId } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const isSa = me?.role === 'superadmin';
  const isAdmin = me?.role === 'admin';
  const money = useMoney();
  const revision = useDataRevision();
  const rb = routeBaseUi(model);
  const today = useMemo(() => todayIn(me?.company.timezone ?? 'UTC'), [me?.company.timezone]);

  const [expenses, setExpenses] = useState<ServerExpense[] | null>(null);
  const [payables, setPayables] = useState<Payables | null>(null);
  const [reimbursements, setReimbursements] = useState<Reimbursement[]>([]);
  const [categories, setCategories] = useState<ServerCategory[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [ownPanel, setOwnPanel] = useState<RoutePanel | null>(null);
  const [poolAvailable, setPoolAvailable] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [tab, setTab] = useState<Tab>('gastos');
  const [registering, setRegistering] = useState(false);
  const [reimbursing, setReimbursing] = useState<{ adminId: string } | null>(null);
  const [reversing, setReversing] = useState<{ kind: 'expense'; e: ServerExpense } | { kind: 'reimbursement'; r: Reimbursement } | null>(null);

  useEffect(() => {
    let alive = true;
    // Una API anterior a 0035 no conoce estos endpoints (404): el panel no se ofrece (sin regresión).
    fetchPayables()
      .then((p) => Promise.all([fetchGeneralExpenses(), fetchReimbursements(), fetchCategories().catch(() => [] as ServerCategory[]),
        db.users.where('tenantId').equals(tenantId).toArray()]).then(([e, r, c, u]) => {
        if (!alive) return; setPayables(p); setExpenses(e); setReimbursements(r); setCategories(c); setUsers(u); setError(null); setUnsupported(false);
      }))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiFailure && err.status === 404) { setUnsupported(true); return; }
        setError(err instanceof Error ? err.message : 'No se pudieron cargar los gastos generales');
      });
    // Bases de mis rutas (route_base) cuando el contenedor no trae el panel; disponible de mi bolsa (modelo anterior).
    if (rb && !panel && isAdmin) fetchPanel(today, today).then((p) => { if (alive) setOwnPanel(p); }).catch(() => undefined);
    if (!rb && isAdmin) {
      serverView<{ admins: { adminId: string; availableMinor: number }[] }>('/v1/capital/summary')
        .then((s) => { if (alive) setPoolAvailable(s.admins.find((a) => a.adminId === me?.membershipId)?.availableMinor ?? 0); })
        .catch(() => undefined);
    }
    return () => { alive = false; };
  }, [revision, tenantId, rb, isAdmin, panel, today, me?.membershipId]);

  const sourcePanel = panel ?? ownPanel;
  const fundingRoutes = rb ? fundingRoutesOf(sourcePanel?.routes ?? [], me?.membershipId) : [];
  const myRouteIds = new Set(fundingRoutes.map((r) => r.routeId));
  const nameOf = (id: string | null | undefined) => (!id ? '—' : id === me?.membershipId ? 'Tú' : formatPersonName(users.find((u) => u.id === id)?.nombre ?? payables?.admins.find((a) => a.adminId === id)?.name ?? '') || 'Administrador');
  const catOf = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Categoría';
  const originals = (expenses ?? []).filter((e) => !e.reversesId && !e.refundsExpenseId);
  const pendingRows = (payables?.admins ?? []).filter((a) => a.pendingMinor > 0 || a.ownMoneyExpensesMinor > 0);
  const myPending = payables?.admins.find((a) => a.adminId === me?.membershipId)?.pendingMinor ?? 0;
  const general = sourcePanel?.general;
  const adminGeneral = (general?.administratorGeneral ?? []).reduce((t, a) => t + a.totalMinor, 0);
  const companyGeneral = general?.companyGeneral?.totalMinor ?? null;
  const durable = (general?.administratorGeneral ?? []).reduce((t, a) => t + a.bienDuraderoMinor, 0) + (general?.companyGeneral?.bienDuraderoMinor ?? 0);
  const canReimburse = isAdmin && (rb ? fundingRoutes.some((r) => !r.inHandover && r.baseMinor > 0) : (poolAvailable ?? 0) > 0);

  if (unsupported) {
    return rb ? <Notice tone="gray" testId="ge-unsupported">El servidor todavía no ofrece el registro de gastos generales y reembolsos.</Notice> : null;
  }
  return (
    <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-5 space-y-4" aria-labelledby="ge-title" data-testid="ge-panel">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 id="ge-title" className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Receipt className="w-4 h-4 text-gray-500" aria-hidden />Gastos generales y reembolsos</h2>
          <p className="text-xs text-gray-600 mt-0.5 max-w-2xl">
            Gastos que no son de una sola ruta (del Administrador o de la empresa). Se registran una vez y se muestran aparte del resultado de cada ruta.
            {rb ? ' Se pagan con aportes de tus rutas o con tu dinero propio.' : ' En este modelo se registran con tu dinero propio y se reembolsan desde tu bolsa.'}
            {isSa ? ' Vista de solo lectura.' : ''}
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2 lg:flex-shrink-0">
            <Button size="sm" onClick={() => setRegistering(true)} icon={<Plus className="w-4 h-4" />} data-testid="ge-new">Registrar gasto general</Button>
            <Button size="sm" variant="secondary" onClick={() => setReimbursing({ adminId: me?.membershipId ?? '' })} disabled={!canReimburse || !pendingRows.some((a) => a.pendingMinor > 0)}
              icon={<HandCoins className="w-4 h-4" />} data-testid="ge-reimburse">Pagar reembolso</Button>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {general?.administratorGeneral && <Fig label="Generales del Administrador" value={money(adminGeneral)} hint={periodText ? `Periodo · ${periodText}` : undefined} testId="ge-fig-admin" />}
        {companyGeneral != null && <Fig label="Generales de empresa" value={money(companyGeneral)} hint={periodText ? `Periodo · ${periodText}` : undefined} testId="ge-fig-company" />}
        {general?.administratorGeneral && <Fig label="Bienes duraderos" value={money(durable)} hint="Aparte: no son gasto operativo ni pérdida" testId="ge-fig-durable" />}
        <Fig label="Reembolsos pendientes a Administradores" value={money(payables?.totalPendingMinor ?? 0)} hint="Obligación de la empresa · no es efectivo" tone="violet" testId="ge-pending-total" />
        {!general && isAdmin && <Fig label="Tu saldo a favor" value={money(myPending)} hint="Lo que la empresa te debe · no es efectivo" testId="ge-fig-mine" />}
        {!rb && isAdmin && poolAvailable != null && <Fig label="Disponible en tu bolsa" value={money(poolAvailable)} hint="De aquí sale un reembolso en este modelo" testId="ge-fig-pool" />}
      </dl>

      <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-white p-0.5" role="tablist" aria-label="Gastos generales y reembolsos">
        {([['gastos', `Gastos generales (${originals.length})`], ['pendientes', `Reembolsos pendientes (${pendingRows.filter((a) => a.pendingMinor > 0).length})`],
          ['reembolsos', `Historial de reembolsos (${reimbursements.length})`]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`ge-tab-${k}`}
            className={cn('px-3 h-8 text-xs font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              tab === k ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-100')}>{label}</button>
        ))}
      </div>

      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : !expenses || !payables ? (
        <div className="h-24 rounded-xl bg-gray-100 animate-pulse" aria-busy="true" />
      ) : tab === 'gastos' ? (
        originals.length === 0 ? <p className="text-sm text-gray-500" data-testid="ge-empty">No hay gastos generales registrados.</p> : (
          <ul className="divide-y divide-gray-100" data-testid="ge-list">
            {originals.map((e) => (
              <ExpenseRow key={e.id} e={e} category={catOf(e.categoryId)} nameOf={nameOf}
                canReverse={isAdmin && canReverseExpense(e, me?.membershipId, myRouteIds, rb)} onReverse={() => setReversing({ kind: 'expense', e })} />
            ))}
          </ul>
        )
      ) : tab === 'pendientes' ? (
        <div className="space-y-2" data-testid="ge-payables">
          <Notice tone="violet">Obligaciones de la empresa con sus Administradores por gastos pagados con dinero propio. <b>No son efectivo</b>: no suman a ninguna Base ni caja.</Notice>
          {pendingRows.length === 0 ? <p className="text-sm text-gray-500">Nadie tiene reembolsos pendientes.</p> : (
            <ul className="divide-y divide-gray-100">
              {pendingRows.map((a) => (
                <li key={a.adminId} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid={`ge-payable-${a.adminId}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{nameOf(a.adminId)}{a.status !== 'activo' ? <span className="ml-1 text-xs text-gray-500">(inactivo)</span> : null}</p>
                    <p className="text-xs text-gray-600">Pagó con dinero propio {money(a.ownMoneyExpensesMinor)} · reembolsado {money(a.reimbursedMinor)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-[11px] text-gray-500">Pendiente</p>
                      <p className={`${num} text-sm font-bold text-violet-900`} data-testid="ge-payable-pending">{money(a.pendingMinor)}</p>
                    </div>
                    {isAdmin && a.pendingMinor > 0 && (
                      <Button size="sm" variant="secondary" disabled={!canReimburse} onClick={() => setReimbursing({ adminId: a.adminId })} data-testid="ge-payable-reimburse">
                        {a.adminId === me?.membershipId ? 'Pagar mi reembolso' : 'Pagar reembolso'}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        reimbursements.length === 0 ? <p className="text-sm text-gray-500" data-testid="ge-reimb-empty">No hay reembolsos registrados.</p> : (
          <ul className="divide-y divide-gray-100" data-testid="ge-reimbursements">
            {reimbursements.map((r) => (
              <ReimbursementRow key={r.id} r={r} nameOf={nameOf} me={me?.membershipId} rb={rb}
                canReverse={isAdmin && canReverseReimbursement(r, me?.membershipId, myRouteIds, rb)} onReverse={() => setReversing({ kind: 'reimbursement', r })} />
            ))}
          </ul>
        )
      )}

      {isAdmin && (
        <>
          <GeneralExpenseModal open={registering} onClose={() => setRegistering(false)} model={model} routes={fundingRoutes} categories={categories} />
          <ReimburseModal target={reimbursing} onClose={() => setReimbursing(null)} model={model} routes={fundingRoutes} payables={payables}
            poolAvailableMinor={poolAvailable} nameOf={nameOf} />
          <ReverseDialog target={reversing} onClose={() => setReversing(null)} money={money} catOf={catOf} nameOf={nameOf} />
        </>
      )}
    </section>
  );
}

/**
 * Lista de gastos generales con las fuentes nuevas (para la pantalla Gastos): mismas filas y misma anulación que
 * el panel de la Caja principal. `scope` filtra por alcance; `from`/`to` por fecha contable.
 */
export function GeneralExpensesList({ scope, from, to }: { scope?: 'administrador' | 'empresa' | ''; from?: string; to?: string }) {
  const { tenantId } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const revision = useDataRevision();
  const [rows, setRows] = useState<ServerExpense[] | null>(null);
  const [categories, setCategories] = useState<ServerCategory[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [reversing, setReversing] = useState<{ kind: 'expense'; e: ServerExpense } | null>(null);
  const [myRouteIds, setMyRouteIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    Promise.all([fetchGeneralExpenses(), fetchCategories().catch(() => [] as ServerCategory[]), db.users.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray()])
      .then(([e, c, u, r]) => {
        if (!alive) return;
        setRows(e); setCategories(c); setUsers(u);
        // RB-D7: rutas de las que soy el responsable vigente (las que puedo corregir).
        setMyRouteIds(new Set(r.filter((x) => x.status === 'activa' && !!me?.membershipId && x.capitalControllerAdminId === me.membershipId).map((x) => x.id)));
      })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [revision, tenantId, me?.membershipId]);
  const nameOf = (id: string | null | undefined) => (!id ? '—' : id === me?.membershipId ? 'Tú' : formatPersonName(users.find((u) => u.id === id)?.nombre ?? '') || 'Administrador');
  const catOf = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Categoría';
  const list = (rows ?? []).filter((e) => !e.reversesId && !e.refundsExpenseId && (!scope || e.scope === scope)
    && (!from || e.expenseDate >= from) && (!to || e.expenseDate <= to));
  if (!rows || list.length === 0) return null;
  return (
    <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="ge-expenses-list" aria-labelledby="ge-list-h">
      <h2 id="ge-list-h" className="text-sm font-semibold text-gray-900">Gastos generales <span className="font-normal text-gray-500">· aportes de rutas o dinero propio</span></h2>
      <ul className="divide-y divide-gray-100">
        {list.map((e) => (
          <ExpenseRow key={e.id} e={e} category={catOf(e.categoryId)} nameOf={nameOf}
            canReverse={me?.role === 'admin' && canReverseExpense(e, me?.membershipId, myRouteIds, true)} onReverse={() => setReversing({ kind: 'expense', e })} />
        ))}
      </ul>
      <ReverseDialog target={reversing} onClose={() => setReversing(null)} money={money} catOf={catOf} nameOf={nameOf} />
    </section>
  );
}

function Fig({ label, value, hint, tone, testId }: { label: string; value: string; hint?: string; tone?: 'violet'; testId?: string }) {
  return (
    <div className={cn('rounded-xl p-3 min-w-0', tone === 'violet' ? 'bg-violet-50' : 'bg-gray-50')} data-testid={testId}>
      <dt className={cn('text-xs', tone === 'violet' ? 'text-violet-800' : 'text-gray-600')}>{label}</dt>
      <dd className={cn(num, 'text-base font-bold', tone === 'violet' ? 'text-violet-900' : 'text-gray-900')}>{value}</dd>
      {hint && <dd className={cn('text-[11px] leading-tight', tone === 'violet' ? 'text-violet-800' : 'text-gray-500')}>{hint}</dd>}
    </div>
  );
}

const SCOPE_TEXT: Record<string, string> = { administrador: 'General del Administrador', empresa: 'General de empresa' };

export function ExpenseRow({ e, category, nameOf, canReverse, onReverse }: {
  e: ServerExpense; category: string; nameOf: (id: string | null) => string; canReverse: boolean; onReverse: () => void;
}) {
  const money = useMoney();
  const reversed = e.state === 'anulado';
  return (
    <li className="py-2.5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" data-testid={`ge-expense-${e.id}`}>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-1.5">
          {category}
          <Chip tone="gray">{SCOPE_TEXT[e.scope ?? ''] ?? 'General'}</Chip>
          <Chip tone={e.nature === 'bien_duradero' ? 'sky' : 'gray'} testId="ge-nature">{natureLabel(e.nature)}</Chip>
          {reversed ? <Chip tone="red">Anulado</Chip> : <Chip tone="green">Vigente</Chip>}
        </p>
        {e.funding === 'own_money' ? (
          <p className="text-xs text-gray-600" data-testid="ge-funding">{nameOf(e.adminId) === 'Tú' ? 'Pagado con tu dinero propio' : `Pagado con dinero propio de ${nameOf(e.adminId)}`} · reembolsable (crea un saldo a favor, no mueve efectivo)</p>
        ) : (
          <p className="text-xs text-gray-600" data-testid="ge-funding">
            Aportes: {e.contributions.length ? e.contributions.map((c) => `${c.routeName ?? 'Ruta'} ${money(c.amountMinor)}`).join(' · ') : '—'}
          </p>
        )}
        <p className="text-xs text-gray-500">{formatDate(e.expenseDate)} · responsable: {nameOf(e.adminId).replace(/^Tú$/, 'tú')}{e.registeredBy !== e.adminId ? ` · registró ${nameOf(e.registeredBy)}` : ''}</p>
        {e.description && <p className="text-xs text-gray-500 break-words">{e.description}{e.reference ? ` · Ref. ${e.reference}` : ''}</p>}
        {reversed && e.reversalReason && <p className="text-xs text-red-700 break-words">Anulado: {e.reversalReason}</p>}
      </div>
      <div className="flex items-center gap-2 sm:flex-shrink-0 self-end sm:self-auto">
        {canReverse && <Button size="sm" variant="ghost" onClick={onReverse} icon={<Undo2 className="w-3.5 h-3.5" />} data-testid="ge-expense-reverse">Anular</Button>}
        <span className={cn(num, 'text-sm font-bold', reversed ? 'text-gray-400 line-through' : 'text-gray-900')}>{money(e.amountMinor)}</span>
      </div>
    </li>
  );
}

function ReimbursementRow({ r, nameOf, me, rb, canReverse, onReverse }: {
  r: Reimbursement; nameOf: (id: string | null) => string; me?: string; rb: boolean; canReverse: boolean; onReverse: () => void;
}) {
  const money = useMoney();
  const reversed = r.state === 'anulado';
  const self = r.adminId === r.payerId;
  return (
    <li className="py-2.5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" data-testid={`ge-reimb-${r.id}`}>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-1.5">
          Reembolso a {r.adminId === me ? 'ti' : nameOf(r.adminId)}
          {self && <Chip tone="sky" testId="ge-self">Autorreembolso</Chip>}
          {reversed ? <Chip tone="red">Anulado</Chip> : <Chip tone="green">Vigente</Chip>}
        </p>
        <p className="text-xs text-gray-600">
          {r.source === 'admin_pool'
            ? `Pagado desde ${rb ? 'el saldo' : 'la bolsa'} de ${r.payerId === me ? 'ti' : nameOf(r.payerId)}`
            : `Aportes: ${r.contributions.map((c) => `${c.routeName ?? 'Ruta'} ${money(c.amountMinor)}`).join(' · ') || '—'}`}
          {!self ? ` · pagó ${nameOf(r.payerId)}` : ''}
        </p>
        <p className="text-xs text-gray-500">{formatDate(r.entryDate)} · {r.reason}</p>
        {reversed && r.reversalReason && <p className="text-xs text-red-700 break-words">Anulado: {r.reversalReason}</p>}
      </div>
      <div className="flex items-center gap-2 sm:flex-shrink-0 self-end sm:self-auto">
        {canReverse && <Button size="sm" variant="ghost" onClick={onReverse} icon={<RotateCcw className="w-3.5 h-3.5" />} data-testid="ge-reimb-reverse">Anular</Button>}
        <span className={cn(num, 'text-sm font-bold', reversed ? 'text-gray-400 line-through' : 'text-gray-900')}>{money(r.amountMinor)}</span>
      </div>
    </li>
  );
}

function Chip({ tone, children, testId }: { tone: 'gray' | 'green' | 'red' | 'sky'; children: ReactNode; testId?: string }) {
  const cls = { gray: 'bg-gray-100 text-gray-700', green: 'bg-emerald-50 text-emerald-700', red: 'bg-red-50 text-red-700', sky: 'bg-sky-50 text-sky-800' }[tone];
  return <span className={cn('text-[11px] font-semibold rounded-full px-2 py-0.5', cls)} data-testid={testId}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Aportes por ruta (suma en vivo y Base disponible de cada ruta)
// ---------------------------------------------------------------------------

export type ContributionDraft = Record<string, number>;   // routeId → valor en unidades MAYORES

export function contributionsOf(d: ContributionDraft): Contribution[] {
  return Object.entries(d).map(([routeId, v]) => ({ routeId, amountMinor: toMinor(v) })).filter((c) => c.amountMinor > 0);
}

export function ContributionsEditor({ routes, value, onChange, targetMinor }: {
  routes: FundingRoute[]; value: ContributionDraft; onChange: (d: ContributionDraft) => void; targetMinor: number | null;
}) {
  const { currency } = useTenant();
  const money = useMoney();
  const sum = contributionsOf(value).reduce((t, c) => t + c.amountMinor, 0);
  const remaining = targetMinor != null ? targetMinor - sum : null;
  if (routes.length === 0) return <Notice tone="amber" testId="ge-no-routes">No eres el responsable vigente de ninguna ruta activa: no hay rutas que puedan aportar.</Notice>;
  return (
    <fieldset className="rounded-xl border border-gray-200 p-3 space-y-2" data-testid="ge-contributions">
      <legend className="px-1 text-sm font-medium text-gray-800">Aportes de tus rutas</legend>
      <p className="text-xs text-gray-600">Elige de qué rutas sale el dinero y cuánto aporta cada una. Solo tus rutas; ninguna supera su Base disponible.</p>
      <ul className="space-y-2">
        {routes.map((r) => {
          const v = value[r.routeId] ?? 0;
          const over = toMinor(v) > r.baseMinor;
          return (
            <li key={r.routeId} className="grid grid-cols-1 sm:grid-cols-[1fr_12rem] gap-1 sm:gap-3 sm:items-center" data-testid={`ge-contrib-${r.routeId}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                <p className="text-xs text-gray-500">
                  {r.inHandover ? <span className="text-violet-700">Ruta en entrega: no puede aportar</span> : <>Base disponible <span className={num}>{money(r.baseMinor)}</span></>}
                  {!r.inHandover && remaining != null && remaining > 0 && r.baseMinor > toMinor(v) && (
                    <button type="button" className="ml-2 text-primary-700 hover:underline" data-testid="ge-contrib-fill"
                      onClick={() => onChange({ ...value, [r.routeId]: toMajor(Math.min(r.baseMinor, toMinor(v) + remaining)) })}>Completar aquí</button>
                  )}
                </p>
              </div>
              <MoneyInput label={`Aporte de ${r.name}`} currency={currency} value={v} disabled={r.inHandover}
                onValueChange={(x) => onChange({ ...value, [r.routeId]: x })} error={over ? 'Supera la Base disponible' : undefined} />
            </li>
          );
        })}
      </ul>
      <p className={cn('text-sm flex flex-wrap justify-between gap-2 border-t border-gray-100 pt-2', remaining != null && remaining !== 0 ? 'text-amber-800' : 'text-gray-800')} data-testid="ge-contrib-sum">
        <span>Suma de aportes: <b className={num}>{money(sum)}</b>{targetMinor != null ? <> de <span className={num}>{money(targetMinor)}</span></> : null}</span>
        {remaining != null && (remaining === 0 ? <span className="text-emerald-700">Cuadra con el total</span>
          : remaining > 0 ? <span>Faltan <span className={num}>{money(remaining)}</span></span> : <span>Sobran <span className={num}>{money(-remaining)}</span></span>)}
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Registro de un gasto general (A, C1, C2)
// ---------------------------------------------------------------------------

export function GeneralExpenseModal({ open, onClose, model, routes, categories, presetScope }: {
  open: boolean; onClose: () => void; model: CapitalModel; routes: FundingRoute[]; categories: ServerCategory[]; presetScope?: 'administrador' | 'empresa';
}) {
  const { currency } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const rb = routeBaseUi(model);
  const empty = { scope: (presetScope ?? 'administrador') as 'administrador' | 'empresa', source: (rb ? 'routes' : 'own_money') as 'routes' | 'own_money',
    categoryId: '', amount: 0, description: '', reference: '', contribs: {} as ContributionDraft };
  const [f, setF] = useState(empty);
  const [opId, setOpId] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const single = routes.filter((r) => !r.inHandover);
    setF({ ...empty, contribs: single.length === 1 ? { [single[0]!.routeId]: 0 } : {} });
    setOpId(generateId());
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const myName = formatPersonName(me?.displayName) || 'Tú';
  const amountMinor = toMinor(f.amount);
  const contributions = contributionsOf(f.contribs);
  const sum = contributions.reduce((t, c) => t + c.amountMinor, 0);
  const cat = categories.find((c) => c.id === f.categoryId);
  const overBase = contributions.some((c) => c.amountMinor > (routes.find((r) => r.routeId === c.routeId)?.baseMinor ?? 0));
  const chosen = contributions.map((c) => routes.find((r) => r.routeId === c.routeId)?.name ?? 'ruta');
  const problem = !f.categoryId ? 'Selecciona la categoría.'
    : amountMinor <= 0 ? 'Escribe el valor total.'
      : f.description.trim().length < 3 ? 'Escribe la descripción (mínimo 3 caracteres).'
        : f.source === 'routes' && contributions.length === 0 ? 'Indica el aporte de al menos una ruta.'
          : f.source === 'routes' && overBase ? 'Un aporte supera la Base disponible de su ruta.'
            : f.source === 'routes' && sum !== amountMinor ? 'La suma de los aportes debe ser igual al total.' : null;

  const e: Explanation = f.source === 'routes' ? {
    from: chosen.length ? `Base de ${chosen.join(', ')}` : 'Base de las rutas que elijas', to: `Gasto ${f.scope === 'administrador' ? 'general del Administrador' : 'general de empresa'} (se registra una sola vez)`,
    who: myName, responsible: `${myName}, como responsable de las rutas aportantes`, changes: 'La Base de cada ruta aportante baja en su aporte',
    limits: ['Solo aportan rutas de las que eres el responsable vigente (nunca rutas de otro Administrador).', 'La suma de los aportes debe ser igual al total.',
      'Ningún aporte supera la Base disponible de su ruta.', 'No entra en el resultado operativo de esas rutas: se informa aparte como gasto general.',
      'Se corrige solo anulándolo; el dinero vuelve a cada Base.'],
  } : {
    from: 'Tu dinero propio (fuera de ADEX)', to: `Gasto ${f.scope === 'administrador' ? 'general del Administrador' : 'general de empresa'}`, who: myName,
    responsible: 'La empresa queda debiéndote este valor', changes: 'Ninguna Base ni caja cambia: se crea un saldo a favor tuyo (reembolso pendiente)',
    limits: ['Siempre reembolsable; no requiere aprobación.', 'No es efectivo: no suma a ninguna Base ni caja.', 'Se puede reembolsar por partes.',
      'Para corregirlo, anúlalo (si ya se reembolsó, primero anula el reembolso).'],
  };

  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const r = await createGeneralExpense({ scope: f.scope, fundingSource: f.source, categoryId: f.categoryId, amountMinor, description: f.description,
        reference: f.reference, contributions: f.source === 'routes' ? contributions : undefined }, opId);
      toast.success(f.source === 'own_money' ? `Gasto general registrado: saldo a favor tuyo ${money(r.pendingMinor ?? amountMinor)}` : 'Gasto general registrado');
      onClose();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Error'); } finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} guarded={f.amount > 0 || f.description.trim() !== ''} size="xl" title="Registrar gasto general"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={save} loading={saving} disabled={!!problem} data-testid="ge-save">Registrar</Button></>}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="ge-form">
        <div className="space-y-3">
          <Segmented label="Alcance (a quién beneficia)" value={f.scope} onChange={(v) => setF((x) => ({ ...x, scope: v }))} testId="ge-scope"
            options={[['administrador', 'General del Administrador', 'Varias de tus rutas o tu gestión'], ['empresa', 'General de empresa', 'No atribuible a una ruta ni a un Administrador']]} />
          <Segmented label="Fuente del dinero" value={f.source} onChange={(v) => setF((x) => ({ ...x, source: v }))} testId="ge-source"
            options={[...(rb ? [['routes', 'Aportes de mis rutas', 'Sale de la Base de las rutas que elijas'] as [string, string, string]] : []),
              ['own_money', 'Mi dinero propio', 'Reembolsable: crea un saldo a favor tuyo']] as [typeof f.source, string, string][]} />
          <Select label="Categoría" value={f.categoryId} onChange={(ev) => setF((x) => ({ ...x, categoryId: ev.target.value }))} required placeholder="Seleccionar categoría"
            options={categories.filter((c) => c.active).map((c) => ({ value: c.id, label: `${c.name} · ${natureLabel(c.nature)}` }))}
            hint={cat?.nature === 'bien_duradero' ? 'Bien duradero: se informa aparte; no es gasto operativo ni pérdida.' : cat ? `Naturaleza: ${natureLabel(cat.nature)}` : undefined} />
          <MoneyInput label="Valor total" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required />
          <Textarea label="Descripción" value={f.description} onChange={(ev) => setF((x) => ({ ...x, description: ev.target.value }))} rows={2} required maxLength={300} />
          <Input label="Referencia (opcional)" value={f.reference} maxLength={120} onChange={(ev) => setF((x) => ({ ...x, reference: ev.target.value }))} />
        </div>
        <div className="space-y-3">
          {f.source === 'routes'
            ? <ContributionsEditor routes={routes} value={f.contribs} onChange={(d) => setF((x) => ({ ...x, contribs: d }))} targetMinor={amountMinor > 0 ? amountMinor : null} />
            : <Notice tone="violet" testId="ge-own-money-note">Registras un gasto que pagaste con tu dinero. <b>No mueve efectivo</b> y no suma a ninguna Base: crea un saldo a favor tuyo que la empresa te reembolsa (total o por partes).</Notice>}
          <ExplainPanel e={e} />
          {problem && (f.amount > 0 || contributions.length > 0) && <p className="text-xs text-amber-800" role="status" data-testid="ge-problem">{problem}</p>}
        </div>
      </div>
    </Modal>
  );
}

function Segmented<T extends string>({ label, value, onChange, options, testId }: {
  label: string; value: T; onChange: (v: T) => void; options: [T, string, string][]; testId: string;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend className="block text-sm font-medium text-gray-700 mb-1">{label}</legend>
      <div className={cn('grid gap-2', options.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1')}>
        {options.map(([v, title, sub]) => (
          <label key={v} className={cn('flex items-start gap-2 rounded-xl border p-2.5 cursor-pointer text-sm',
            value === v ? 'border-primary-400 bg-primary-50/60 ring-1 ring-primary-200' : 'border-gray-200 hover:bg-gray-50')}>
            <input type="radio" className="mt-0.5 h-4 w-4 text-primary-600 focus:ring-primary-500" checked={value === v} onChange={() => onChange(v)} data-testid={`${testId}-${v}`} />
            <span className="min-w-0"><span className="block font-medium text-gray-900">{title}</span><span className="block text-xs text-gray-600">{sub}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Reembolso (parcial o total; autorreembolso permitido y rotulado)
// ---------------------------------------------------------------------------

function ReimburseModal({ target, onClose, model, routes, payables, poolAvailableMinor, nameOf }: {
  target: { adminId: string } | null; onClose: () => void; model: CapitalModel; routes: FundingRoute[]; payables: Payables | null;
  poolAvailableMinor: number | null; nameOf: (id: string | null) => string;
}) {
  const { currency } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const rb = routeBaseUi(model);
  const [f, setF] = useState({ adminId: '', amount: 0, reason: '', contribs: {} as ContributionDraft });
  const [opId, setOpId] = useState('');
  const [saving, setSaving] = useState(false);
  const owed = (payables?.admins ?? []).filter((a) => a.pendingMinor > 0);
  useEffect(() => {
    if (!target) return;
    const preset = owed.some((a) => a.adminId === target.adminId) ? target.adminId : owed.length === 1 ? owed[0]!.adminId : '';
    const single = routes.filter((r) => !r.inHandover);
    setF({ adminId: preset, amount: 0, reason: '', contribs: single.length === 1 ? { [single[0]!.routeId]: 0 } : {} });
    setOpId(generateId());
  }, [target]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!target) return null;

  const pending = owed.find((a) => a.adminId === f.adminId)?.pendingMinor ?? 0;
  const self = !!f.adminId && f.adminId === me?.membershipId;
  const contributions = contributionsOf(f.contribs);
  const total = rb ? contributions.reduce((t, c) => t + c.amountMinor, 0) : toMinor(f.amount);
  const overBase = rb && contributions.some((c) => c.amountMinor > (routes.find((r) => r.routeId === c.routeId)?.baseMinor ?? 0));
  const myName = formatPersonName(me?.displayName) || 'Tú';
  const who = f.adminId ? (self ? myName : nameOf(f.adminId)) : 'el Administrador';
  const chosen = contributions.map((c) => routes.find((r) => r.routeId === c.routeId)?.name ?? 'ruta');
  const problem = !f.adminId ? 'Selecciona a quién reembolsas.'
    : total <= 0 ? (rb ? 'Indica el aporte de al menos una ruta.' : 'Escribe el valor.')
      : overBase ? 'Un aporte supera la Base disponible de su ruta.'
        : !rb && poolAvailableMinor != null && total > poolAvailableMinor ? 'El valor supera el disponible de tu bolsa.'
          : total > pending ? 'El reembolso supera lo pendiente.'
            : f.reason.trim().length < 3 ? 'Escribe el motivo (mínimo 3 caracteres).' : null;

  const e: Explanation = {
    from: rb ? (chosen.length ? `Base de ${chosen.join(', ')}` : 'Base de las rutas que elijas') : `Tu bolsa (${myName})`,
    to: `${who}: recibe el efectivo del reembolso`, who: myName, responsible: `${who} deja de tener ese saldo a favor`,
    changes: `${rb ? 'La Base de cada ruta aportante baja' : 'Tu bolsa baja'} · el saldo a favor de ${who} pasa de ${money(pending)} a ${money(Math.max(0, pending - total))}`,
    limits: ['No vuelve a registrar el gasto: solo paga la obligación.', 'Nunca más que lo pendiente; puede ser parcial.',
      ...(rb ? ['Solo aportan tus rutas; ninguna supera su Base disponible.'] : []), 'Solo quien pagó puede anularlo; el dinero vuelve a donde salió.'],
  };

  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const r = await reimburseAdmin({ adminId: f.adminId, reason: f.reason, ...(rb ? { contributions } : { amountMinor: total }) }, opId);
      toast.success(`Reembolso registrado: pendiente ${money(r.pendingAfterMinor)}`);
      onClose();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Error'); } finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} guarded={total > 0 || f.reason.trim() !== ''} size="xl" title="Reembolso a un Administrador"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={save} loading={saving} disabled={!!problem} data-testid="ge-reimb-save">Registrar reembolso</Button></>}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="ge-reimb-form">
        <div className="space-y-3">
          <Select label="Reembolsar a" value={f.adminId} onChange={(ev) => setF((x) => ({ ...x, adminId: ev.target.value }))} required placeholder="Seleccionar Administrador"
            options={owed.map((a) => ({ value: a.adminId, label: `${a.adminId === me?.membershipId ? `${myName} (tú)` : nameOf(a.adminId)} · pendiente ${money(a.pendingMinor)}` }))} />
          {self && <Notice tone="sky" testId="ge-self-note"><b>Autorreembolso.</b> Te reembolsas desde {rb ? 'tus propias rutas' : 'tu bolsa'}: permitido hasta lo pendiente{rb ? ', con aportes explícitos por ruta' : ''}. Queda auditado y visible en el panel de rutas.</Notice>}
          {f.adminId && <p className="text-sm text-gray-700">Pendiente de {who}: <b className={num} data-testid="ge-reimb-pending">{money(pending)}</b></p>}
          {!rb && (
            <MoneyInput label="Valor del reembolso" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required
              hint={poolAvailableMinor != null ? `Disponible en tu bolsa: ${money(poolAvailableMinor)}` : undefined}
              error={total > pending && pending > 0 ? 'Supera lo pendiente' : undefined} />
          )}
          <Textarea label="Motivo" value={f.reason} onChange={(ev) => setF((x) => ({ ...x, reason: ev.target.value }))} rows={2} required maxLength={300} />
        </div>
        <div className="space-y-3">
          {rb && <ContributionsEditor routes={routes} value={f.contribs} onChange={(d) => setF((x) => ({ ...x, contribs: d }))} targetMinor={null} />}
          {rb && total > pending && pending > 0 && <p className="text-xs text-amber-800" role="status">El total ({money(total)}) supera lo pendiente ({money(pending)}).</p>}
          <ExplainPanel e={e} />
          {problem && (total > 0 || f.reason) && <p className="text-xs text-amber-800" role="status" data-testid="ge-reimb-problem">{problem}</p>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Anulación con motivo (el error del servidor se muestra en el diálogo, p. ej. «ya reembolsado»)
// ---------------------------------------------------------------------------

function ReverseDialog({ target, onClose, money, catOf, nameOf }: {
  target: { kind: 'expense'; e: ServerExpense } | { kind: 'reimbursement'; r: Reimbursement } | null; onClose: () => void;
  money: (n: number) => string; catOf: (id: string) => string; nameOf: (id: string | null) => string;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** RB-D7 (0036): rutas de la operación conjunta y su responsable vigente cuando el servidor la rechaza. */
  const [jointRoutes, setJointRoutes] = useState<{ name: string; controllerName: string | null; isActor: boolean }[]>([]);
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => { if (target) { setReason(''); setError(null); setJointRoutes([]); setOpId(generateId()); } }, [target]);
  if (!target) return null;
  const isExpense = target.kind === 'expense';
  const title = isExpense ? 'Anular gasto general' : 'Anular reembolso';
  const what = isExpense
    ? `${catOf(target.e.categoryId)} · ${money(target.e.amountMinor)}`
    : `Reembolso a ${nameOf(target.r.adminId)} · ${money(target.r.amountMinor)}`;
  const effect = isExpense
    ? (target.e.funding === 'own_money' ? 'El saldo a favor del Administrador baja en este valor. Si ya se le reembolsó, primero hay que anular ese reembolso.'
      : 'Cada aporte vuelve a la Base de su ruta. Debes seguir siendo el responsable de cada ruta aportante.')
    : 'El dinero vuelve a donde salió y el saldo a favor vuelve a quedar pendiente.';

  async function confirm() {
    if (reason.trim().length < 3) { setError('Escribe el motivo (mínimo 3 caracteres).'); return; }
    setSaving(true); setError(null); setJointRoutes([]);
    try {
      if (target!.kind === 'expense') await reverseExpense(target!.e.id, reason, opId);
      else await reverseReimbursement(target!.r.id, reason, opId);
      toast.success(isExpense ? 'Gasto general anulado' : 'Reembolso anulado');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo anular');
      const routes = (err as { details?: { routes?: { name: string; controllerName: string | null; isActor: boolean }[] } }).details?.routes;
      if (Array.isArray(routes)) setJointRoutes(routes);
      setOpId(generateId());
    } finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} size="sm" title={title}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button variant="danger" onClick={confirm} loading={saving} disabled={reason.trim().length < 3} data-testid="ge-reverse-confirm">Anular</Button></>}>
      <div className="space-y-3 text-sm" data-testid="ge-reverse-dialog">
        <p className="font-medium text-gray-900">{what}</p>
        <p className="text-gray-600">{effect} No se borra nada: queda una anulación enlazada con su motivo.</p>
        <Textarea label="Motivo de la anulación" value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} required maxLength={300} />
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-800 flex gap-2" role="alert" data-testid="ge-reverse-error"><Wallet className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />{error}</div>}
        {jointRoutes.length > 0 && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2" data-testid="ge-joint-routes">
            <p className="text-xs font-medium text-gray-700 mb-1">Rutas de la operación y su responsable vigente</p>
            <ul className="space-y-0.5 text-xs text-gray-700">
              {jointRoutes.map((r) => <li key={r.name}>{r.name}: {r.isActor ? 'tú' : formatPersonName(r.controllerName) || 'sin responsable válido'}</li>)}
            </ul>
            <p className="text-xs text-gray-500 mt-1">Cada Administrador responde por sus rutas: no se anula una parte dejando inconsistente la operación conjunta.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
