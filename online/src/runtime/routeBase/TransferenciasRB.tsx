// TRANSFERENCIAS con Base por Ruta (R74 · bloque F, O1/O2/O3/O11). Pantalla del Administrador.
//
// Categorías: Base de la ruta (inyección, retiro) · Cobradores (entrega de Base, recepción de
// devolución, pedir entrega — no mueve dinero) · Entre rutas (transferencia, reparto del saldo «sin
// asignar») · Historial y comprobantes (Consultas). Cada formulario dice de dónde sale el dinero, a
// dónde llega, quién lo registra, quién queda responsable, qué saldo cambia y qué lo impide, con una
// vista previa del saldo; el servidor decide (PostgreSQL bajo bloqueo) y nunca deja saldos negativos.
//
// Sin flujos del modelo anterior: no se pide ni devuelve dinero al SuperAdmin, no hay bolsas ni
// transferencias entre Administradores. El cuadre NO es una transferencia: sigue en Liquidación.
// `?op=inject|withdraw|deliver|receive|transfer|assign` abre directamente esa operación.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, ArrowUpRight, CalendarRange, ChevronRight, Handshake, History, Layers, MapPin, Send,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatPersonName } from '@/lib/displayName';
import { generateId, cn } from '@/lib/utils';
import type { User } from '@/models/types';
import { todayIn, ROLE } from '../../lib/format.ts';
import { toMinor } from '../mappers.ts';
import { custodyPositions, type CustodyPosition } from '../projection.ts';
import { useRuntime } from '../session.ts';
import { RequestModal } from '../MoneyForms.tsx';
import {
  assignUnassigned, deliverToWorker, fetchDestinations, fetchHandovers, fetchPanel, injectBase, receiveFromWorker, transferBase, withdrawBase,
  type CapitalModel, type Destination, type Handover, type PanelRoute, type RoutePanel,
} from './api.ts';
import { BalancePreview, ExplainPanel, Notice, num, useMoney, type Explanation } from './parts.tsx';
import { HandoverDialog } from './HandoverDialog.tsx';

type Kind = 'inject' | 'withdraw' | 'deliver' | 'receive' | 'transfer' | 'assign';
const KINDS: Kind[] = ['inject', 'withdraw', 'deliver', 'receive', 'transfer', 'assign'];

const TITLE: Record<Kind, string> = {
  inject: 'Inyección de Base', withdraw: 'Retiro de Base', deliver: 'Entrega de Base a Cobrador',
  receive: 'Recepción de devolución de Cobrador', transfer: 'Transferencia entre rutas', assign: 'Reparto de saldo sin asignar',
};
const FLOW: Record<Kind, string> = {
  inject: 'Aporte externo → Base de tu ruta', withdraw: 'Base de tu ruta → fuera de ADEX', deliver: 'Base de tu ruta → efectivo del Cobrador',
  receive: 'Efectivo del Cobrador → Base de tu ruta', transfer: 'Base de tu ruta → Base de otra ruta', assign: 'Saldo sin asignar → Base de tu ruta',
};
const ICON: Record<Kind, ReactNode> = {
  inject: <ArrowDownToLine className="w-5 h-5" />, withdraw: <ArrowUpFromLine className="w-5 h-5" />, deliver: <ArrowUpRight className="w-5 h-5" />,
  receive: <ArrowDownLeft className="w-5 h-5" />, transfer: <ArrowRightLeft className="w-5 h-5" />, assign: <Layers className="w-5 h-5" />,
};

export function TransferenciasRB({ model }: { model: CapitalModel }) {
  const { tenantId, currency } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const revision = useDataRevision();
  const today = useMemo(() => todayIn(me?.company.timezone ?? 'UTC'), [me?.company.timezone]);
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState<RoutePanel | null>(null);
  const [positions, setPositions] = useState<CustodyPosition[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [pending, setPending] = useState<Handover[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState<Kind | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState<{ routeId: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchPanel(today, today), custodyPositions().catch(() => []), db.users.where('tenantId').equals(tenantId).toArray(),
      fetchDestinations().catch(() => [] as Destination[]), fetchHandovers({ status: 'pendiente' }).catch(() => [] as Handover[])])
      .then(([p, pos, us, d, h]) => {
        if (!alive) return;
        setPanel(p); setPositions(pos); setUsers(us); setDestinations(d); setPending(h.filter((x) => x.toId === me?.membershipId)); setError(null);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar'); });
    return () => { alive = false; };
  }, [today, revision, tenantId, me?.membershipId]);

  // ?op=<tipo>: abre esa operación (desde la Caja principal).
  const opParam = params.get('op') as Kind | null;
  useEffect(() => {
    if (!opParam || !panel) return;
    if (KINDS.includes(opParam)) setOp(opParam);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('op'); return n; }, { replace: true });
  }, [opParam, panel]);  // eslint-disable-line react-hooks/exhaustive-deps

  const mine = (panel?.routes ?? []).filter((r) => r.controller.id === me?.membershipId && r.status === 'activa');
  const operable = mine.filter((r) => r.handoverState !== 'en_entrega');
  const ownPool = panel?.general.unassignedPools?.find((p) => p.adminId === me?.membershipId)?.balanceMinor ?? 0;
  const withCash = positions.filter((p) => mine.some((r) => r.routeId === p.routeId) && p.transferableMinor > 0);
  const noRoutes = 'No eres responsable de ninguna ruta activa.';
  const allInHandover = 'Todas tus rutas están en entrega: confirma el conteo primero.';
  const blocked: Record<Kind, string | null> = {
    inject: mine.length === 0 ? noRoutes : operable.length === 0 ? allInHandover : null,
    withdraw: mine.length === 0 ? noRoutes : operable.length === 0 ? allInHandover : !operable.some((r) => r.baseMinor > 0) ? 'Tus rutas no tienen Base disponible.' : null,
    deliver: mine.length === 0 ? noRoutes : operable.length === 0 ? allInHandover : !operable.some((r) => r.baseMinor > 0) ? 'Tus rutas no tienen Base disponible.' : null,
    receive: mine.length === 0 ? noRoutes : withCash.length === 0 ? 'Ningún trabajador de tus rutas tiene efectivo entregable.' : null,
    transfer: mine.length === 0 ? noRoutes : operable.length === 0 ? allInHandover : !operable.some((r) => r.baseMinor > 0) ? 'Tus rutas no tienen Base disponible.'
      : destinations.length < 2 ? 'No hay otra ruta operativa con responsable.' : null,
    assign: ownPool <= 0 ? 'No tienes saldo sin asignar.' : operable.length === 0 ? (mine.length === 0 ? noRoutes : allInHandover) : null,
  };
  const groups: { title: string; note?: string; kinds: Kind[]; extra?: ReactNode }[] = [
    { title: 'Base de la ruta', kinds: ['inject', 'withdraw'] },
    { title: 'Cobradores', kinds: ['deliver', 'receive'], extra: (
      <ActionRow icon={<Send className="w-5 h-5" />} title="Pedir entrega de efectivo a un Cobrador" sub="Solicitud: no mueve dinero hasta que el Cobrador entregue"
        blocked={mine.length === 0 ? noRoutes : null} onClick={() => setAsking(true)} testId="rb-op-request" />
    ) },
    { title: 'Entre rutas', kinds: ['transfer', 'assign'] },
  ];

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto w-full" data-testid="rb-transfers">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
          <p className="text-sm text-gray-600 mt-0.5 max-w-2xl">Mueve la <b>Base</b> de las rutas de las que eres responsable. Cada operación se aplica en el acto y queda con su comprobante.</p>
        </div>
        <Link to="/admin/consultas?periodo=7d" data-testid="rb-history"
          className="flex-shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-2 h-10 sm:h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
          <History className="w-4 h-4" aria-hidden />Historial y comprobantes
        </Link>
      </div>

      {model === 'migrating' && <Notice tone="violet">La empresa está pasando a Base por Ruta: las operaciones de Base se habilitan cuando el SuperAdmin complete la activación.</Notice>}
      {pending.map((h) => {
        const name = panel?.routes.find((r) => r.routeId === h.routeId)?.name ?? 'la ruta';
        return (
          <div key={h.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3">
            <p className="text-sm text-violet-900 flex gap-2"><Handshake className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden /><span><b>{name}</b> está en entrega: cuenta la Base y confirma para operarla.</span></p>
            <Button size="sm" onClick={() => setConfirming({ routeId: h.routeId, name })}>Confirmar conteo</Button>
          </div>
        );
      })}

      {error ? <p className="text-sm text-red-600">{error}</p> : !panel ? (
        <div className="space-y-3" aria-busy="true"><div className="h-24 rounded-2xl bg-gray-100 animate-pulse" /><div className="h-64 rounded-2xl bg-gray-100 animate-pulse" /></div>
      ) : (
        <>
          <section aria-labelledby="rb-my-routes" className="space-y-2">
            <h2 id="rb-my-routes" className="text-sm font-semibold text-gray-900">Tus rutas</h2>
            {mine.length === 0 ? <EmptyState icon={<MapPin className="w-8 h-8" />} title="No eres responsable de ninguna ruta activa" /> : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2" data-testid="rb-my-routes">
                {mine.map((r) => (
                  <li key={r.routeId} className={cn('rounded-xl border bg-white px-3 py-2 flex items-center justify-between gap-3', r.handoverState === 'en_entrega' ? 'border-violet-200' : 'border-gray-200')}
                    data-testid={`rb-myroute-${r.routeId}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                      <p className="text-xs text-gray-500">{r.handoverState === 'en_entrega' ? <span className="text-violet-700 font-medium">Ruta en entrega</span> : `Custodias ${money(r.custody.grossMinor)}`}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-gray-500">Base disponible</p>
                      <p className={`${num} text-sm font-bold text-gray-900`} data-testid="rb-myroute-base">{money(r.baseMinor)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {ownPool > 0 && <p className="text-xs text-gray-600">Saldo sin asignar a tu nombre (anterior a Base por Ruta): <b className={num}>{money(ownPool)}</b>. Repártelo a una ruta tuya en «Entre rutas».</p>}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {groups.map((g) => (
              <section key={g.title} className="bg-white rounded-2xl shadow-card border border-gray-100 p-3 space-y-1" aria-label={g.title}>
                <h2 className="text-sm font-semibold text-gray-900 px-1 pb-1">{g.title}</h2>
                {g.kinds.map((k) => (
                  <ActionRow key={k} icon={ICON[k]} title={TITLE[k]} sub={FLOW[k]} blocked={blocked[k]} onClick={() => setOp(k)} testId={`rb-op-${k}`} />
                ))}
                {g.extra}
              </section>
            ))}
          </div>

          <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <Link to="/admin/consultas?periodo=7d" className="rounded-2xl border border-gray-200 bg-white px-4 py-3 flex items-center gap-3 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
              <History className="w-5 h-5 text-gray-500" aria-hidden />
              <span className="min-w-0 flex-1"><b className="block text-gray-900">Historial y comprobantes</b><span className="text-xs text-gray-600">En Consultas · Dinero, eligiendo la ruta: inyecciones, retiros, transferencias, entregas y devoluciones. Cada una abre su comprobante.</span></span>
              <ChevronRight className="w-4 h-4 text-gray-400" aria-hidden />
            </Link>
            <Link to="/admin/weekly-settlement" className="rounded-2xl border border-gray-200 bg-white px-4 py-3 flex items-center gap-3 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
              <CalendarRange className="w-5 h-5 text-gray-500" aria-hidden />
              <span className="min-w-0 flex-1"><b className="block text-gray-900">El cuadre no es una transferencia</b><span className="text-xs text-gray-600">Cuadrar el efectivo de un Cobrador se hace en Liquidación.</span></span>
              <ChevronRight className="w-4 h-4 text-gray-400" aria-hidden />
            </Link>
          </section>
        </>
      )}

      <OperationModal kind={op} onClose={() => setOp(null)} routes={mine} positions={positions} users={users} destinations={destinations} ownPool={ownPool} />
      <RequestModal open={asking} onClose={() => setAsking(false)} onDone={() => setAsking(false)} currency={currency} initialKind="worker_return" kinds={['worker_return']} />
      <HandoverDialog routeId={confirming?.routeId ?? null} routeName={confirming?.name} onClose={() => setConfirming(null)} onDone={() => setConfirming(null)} />
    </div>
  );
}

function ActionRow({ icon, title, sub, blocked, onClick, testId }: { icon: ReactNode; title: string; sub: string; blocked: string | null; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={() => { if (!blocked) onClick(); }} aria-disabled={!!blocked} data-testid={testId}
      className={cn('w-full flex items-center gap-3 text-left rounded-xl p-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        blocked ? 'cursor-not-allowed' : 'hover:bg-primary-50/60')}>
      <span className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', blocked ? 'bg-gray-100 text-gray-400' : 'bg-primary-100 text-primary-700')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm font-semibold', blocked ? 'text-gray-500' : 'text-gray-900')}>{title}</span>
        <span className={cn('block text-xs', blocked ? 'text-amber-800' : 'text-gray-600')} data-testid={blocked ? `${testId}-blocked` : undefined}>{blocked ?? sub}</span>
      </span>
      {!blocked && <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Formulario de una operación (un id de operación por formulario abierto)
// ---------------------------------------------------------------------------

function OperationModal({ kind, onClose, routes, positions, users, destinations, ownPool }: {
  kind: Kind | null; onClose: () => void; routes: PanelRoute[]; positions: CustodyPosition[]; users: User[]; destinations: Destination[]; ownPool: number;
}) {
  const { currency } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const [f, setF] = useState({ routeId: '', toRouteId: '', workerId: '', amount: 0, reason: '', sourceNote: '', evidence: '', confirmed: false });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => {
    if (!kind) return;
    const candidates = kind === 'receive' ? routes : routes.filter((r) => r.handoverState !== 'en_entrega');
    setF({ routeId: candidates.length === 1 ? candidates[0]!.routeId : '', toRouteId: '', workerId: '', amount: 0, reason: '', sourceNote: '', evidence: '', confirmed: false });
    setOpId(generateId());
  }, [kind]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!kind) return null;

  const route = routes.find((r) => r.routeId === f.routeId);
  const routeName = route?.name ?? 'la ruta';
  const inHandover = route?.handoverState === 'en_entrega';
  const amountMinor = toMinor(f.amount);
  const base = route?.baseMinor ?? 0;
  const myName = formatPersonName(me?.displayName) || 'Tú';
  const workersOf = (routeId: string) => users.filter((u) => (u.rol === 'cobrador' || u.rol === 'supervisor') && u.status === 'activo'
    && u.id !== me?.membershipId && (u.authorizedRouteIds ?? []).includes(routeId));
  const holders = positions.filter((p) => p.routeId === f.routeId && p.transferableMinor > 0);
  const worker = kind === 'receive' ? holders.find((p) => p.workerId === f.workerId) : undefined;
  const workerName = kind === 'receive' ? formatPersonName(worker?.workerName) : formatPersonName(users.find((u) => u.id === f.workerId)?.nombre);
  const dest = destinations.find((d) => d.routeId === f.toRouteId);
  const otherController = !!dest && dest.controllerId !== me?.membershipId;

  const routeOptions = (kind === 'receive' ? routes.filter((r) => positions.some((p) => p.routeId === r.routeId && p.transferableMinor > 0)) : routes)
    .map((r) => ({ value: r.routeId, label: `${r.name}${r.handoverState === 'en_entrega' && kind !== 'receive' ? ' (en entrega)' : ''} · Base ${money(r.baseMinor)}` }));

  // Tope y vista previa (el servidor vuelve a comprobarlo bajo bloqueo).
  const cap = kind === 'withdraw' || kind === 'deliver' || kind === 'transfer' ? base : kind === 'receive' ? worker?.transferableMinor ?? 0 : kind === 'assign' ? ownPool : null;
  const exceeds = cap != null && amountMinor > cap;
  const delta = kind === 'inject' || kind === 'receive' || kind === 'assign' ? amountMinor : -amountMinor;

  const e: Explanation = (() => {
    switch (kind) {
      case 'inject': return { from: 'Fuera de ADEX: un aporte (el origen queda solo como nota).', to: `Base de ${routeName}`, who: `${myName}, responsable de la ruta`,
        responsible: `${myName}, como responsable de ${routeName}`, changes: `Base de ${routeName} sube`,
        limits: ['Solo el responsable vigente de la ruta.', 'No con la ruta en entrega.', 'Una inyección es un aporte a la Base: no es pérdida ni gasto.'] };
      case 'withdraw': return { from: `Base de ${routeName}`, to: 'Fuera de ADEX', who: `${myName}, responsable de la ruta`, responsible: 'Quien recibe el retiro, fuera de ADEX',
        changes: `Base de ${routeName} baja`, limits: ['No puede superar la Base disponible.', 'Un solo concepto, «Retiro de Base»: no es una ganancia calculada.', 'No con la ruta en entrega.'] };
      case 'deliver': return { from: `Base de ${routeName}`, to: workerName ? `Efectivo de ${workerName}` : 'Efectivo del Cobrador elegido', who: `${myName}, responsable de la ruta`,
        responsible: `${workerName || 'El Cobrador'} responde por ese efectivo hasta devolverlo o cuadrar`, changes: 'Base baja · efectivo del Cobrador sube',
        limits: ['No puede superar la Base disponible.', 'No con la ruta en entrega.', 'Nadie se entrega efectivo a sí mismo.'] };
      case 'receive': return { from: workerName ? `Efectivo de ${workerName}` : 'Efectivo del Cobrador elegido', to: `Base de ${routeName}`, who: `${myName}, responsable de la ruta`,
        responsible: `${myName}, por la Base de ${routeName}`, changes: 'Efectivo del Cobrador baja · Base sube',
        limits: ['Hasta el efectivo entregable del trabajador (no cubre faltantes ni saldos negativos).', 'Esto no es un cuadre: el cuadre se hace en Liquidación.'] };
      case 'transfer': return { from: `Base de ${routeName}`, to: dest ? `Base de ${dest.name}` : 'Base de la ruta destino', who: `${myName}, responsable de la ruta de origen`,
        responsible: dest ? `${otherController ? formatPersonName(dest.controllerName) : myName}, como responsable de ${dest.name}` : 'El responsable de la ruta destino',
        changes: 'Base de origen baja · Base de destino sube',
        limits: ['Se aplica en el acto, sin aceptación: quien tiene el dinero lo entrega.', 'Si el destino es de otro responsable, recibe un aviso.', 'No puede superar la Base disponible; no con la ruta de origen en entrega.', 'No se anula: para devolver, el destino hace otra transferencia.'] };
      case 'assign': return { from: `Saldo sin asignar de ${myName}`, to: `Base de ${routeName}`, who: myName, responsible: `${myName}, como responsable de ${routeName}`,
        changes: `Saldo sin asignar baja · Base de ${routeName} sube`, limits: ['Solo a rutas de las que eres responsable.', 'Requiere confirmación y evidencia (mínimo 10 caracteres).', 'No se anula.'] };
    }
  })();

  const problem = !f.routeId ? 'Selecciona la ruta.'
    : inHandover && kind !== 'receive' ? 'La ruta está en entrega: confirma el conteo primero.'
      : (kind === 'deliver' || kind === 'receive') && !f.workerId ? 'Selecciona el trabajador.'
        : kind === 'transfer' && !f.toRouteId ? 'Selecciona la ruta destino.'
          : amountMinor <= 0 ? 'Escribe el valor.'
            : exceeds ? 'El valor supera el saldo disponible.'
              : f.reason.trim().length < 3 ? 'Escribe el concepto (mínimo 3 caracteres).'
                : kind === 'assign' && f.evidence.trim().length < 10 ? 'La evidencia necesita mínimo 10 caracteres.'
                  : kind === 'assign' && !f.confirmed ? 'Confirma el reparto.' : null;

  async function save() {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const b = { amountMinor, reason: f.reason };
      if (kind === 'inject') await injectBase({ routeId: f.routeId, ...b, sourceNote: f.sourceNote }, opId);
      if (kind === 'withdraw') await withdrawBase({ routeId: f.routeId, ...b }, opId);
      if (kind === 'deliver') await deliverToWorker({ routeId: f.routeId, workerId: f.workerId, ...b }, opId);
      if (kind === 'receive') await receiveFromWorker({ routeId: f.routeId, workerId: f.workerId, ...b }, opId);
      if (kind === 'transfer') await transferBase({ fromRouteId: f.routeId, toRouteId: f.toRouteId, ...b }, opId);
      if (kind === 'assign') await assignUnassigned({ routeId: f.routeId, ...b, evidence: f.evidence }, opId);
      toast.success(`${TITLE[kind!]} registrada`);
      onClose();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Error'); } finally { setSaving(false); }
  }

  const preview = route && amountMinor > 0 ? (
    <div className="space-y-1">
      {kind === 'assign'
        ? <BalancePreview label="Saldo sin asignar" before={ownPool} after={ownPool - amountMinor} money={money} />
        : kind === 'receive' && worker ? <BalancePreview label={`Efectivo de ${workerName}`} before={worker.transferableMinor} after={worker.transferableMinor - amountMinor} money={money} /> : null}
      <BalancePreview label={`Base de ${routeName}`} before={base} after={base + delta} money={money} />
      {kind === 'transfer' && dest && <p className="text-xs text-gray-600">{dest.name} recibe {money(amountMinor)}{otherController ? ` · se notificará a ${formatPersonName(dest.controllerName)}` : ''}.</p>}
    </div>
  ) : undefined;

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} guarded={f.amount > 0 || f.reason.trim() !== ''} size="lg" title={TITLE[kind]}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={save} loading={saving} disabled={!!problem} data-testid="rb-op-save">Registrar</Button></>}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid={`rb-form-${kind}`}>
        <div className="space-y-3">
          <Select label={kind === 'transfer' ? 'Ruta de origen' : 'Ruta'} value={f.routeId} onChange={(ev) => setF((x) => ({ ...x, routeId: ev.target.value, workerId: '', toRouteId: '' }))}
            options={routeOptions} placeholder={routeOptions.length ? 'Seleccionar ruta' : 'Sin rutas disponibles'} required />
          {inHandover && kind !== 'receive' && <Notice tone="violet">Ruta en entrega: confirma el conteo antes de mover su Base.</Notice>}
          {kind === 'deliver' && (
            <Select label="Cobrador" value={f.workerId} onChange={(ev) => setF((x) => ({ ...x, workerId: ev.target.value }))} required
              options={f.routeId ? workersOf(f.routeId).map((u) => ({ value: u.id, label: `${formatPersonName(u.nombre)}${u.rol !== 'cobrador' ? ` (${ROLE[u.rol] ?? u.rol})` : ''}` })) : []}
              placeholder={!f.routeId ? 'Primero elige la ruta' : workersOf(f.routeId).length ? 'Seleccionar' : 'Nadie asignado a la ruta'} />
          )}
          {kind === 'receive' && (
            <Select label="Cobrador que devuelve" value={f.workerId} onChange={(ev) => setF((x) => ({ ...x, workerId: ev.target.value }))} required
              options={holders.map((p) => ({ value: p.workerId, label: `${formatPersonName(p.workerName)} · entregable ${money(p.transferableMinor)}` }))}
              placeholder={!f.routeId ? 'Primero elige la ruta' : holders.length ? 'Seleccionar' : 'Nadie con efectivo entregable'} />
          )}
          {kind === 'transfer' && (
            <Select label="Ruta destino" value={f.toRouteId} onChange={(ev) => setF((x) => ({ ...x, toRouteId: ev.target.value }))} required
              options={destinations.filter((d) => d.routeId !== f.routeId).map((d) => ({ value: d.routeId, label: `${d.name} · ${d.controllerId === me?.membershipId ? 'tú' : formatPersonName(d.controllerName)}` }))}
              placeholder="Seleccionar ruta destino" hint={otherController ? `Ruta de ${formatPersonName(dest?.controllerName)}: recibirá un aviso.` : undefined} />
          )}
          <MoneyInput label="Valor" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required
            hint={cap != null && f.routeId ? `Disponible: ${money(cap)}` : undefined} error={exceeds ? 'Supera el saldo disponible' : undefined} />
          {kind === 'inject' && <Input label="Origen del dinero (nota, opcional)" value={f.sourceNote} maxLength={120} onChange={(ev) => setF((x) => ({ ...x, sourceNote: ev.target.value }))} />}
          <Textarea label="Concepto" value={f.reason} onChange={(ev) => setF((x) => ({ ...x, reason: ev.target.value }))} rows={2} required maxLength={300} />
          {kind === 'assign' && (
            <>
              <Textarea label="Evidencia" value={f.evidence} onChange={(ev) => setF((x) => ({ ...x, evidence: ev.target.value }))} rows={2} required maxLength={200}
                hint="Por qué este saldo corresponde a esta ruta (mínimo 10 caracteres)." />
              <label className="flex items-start gap-2 text-sm text-gray-800">
                <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" checked={f.confirmed}
                  onChange={(ev) => setF((x) => ({ ...x, confirmed: ev.target.checked }))} data-testid="rb-assign-confirm" />
                Confirmo que este saldo sin asignar pasa a la Base de {routeName}. No se puede anular.
              </label>
            </>
          )}
        </div>
        <div className="space-y-3">
          <ExplainPanel e={e} preview={preview} />
          {problem && f.amount > 0 && <p className="text-xs text-amber-800" role="status">{problem}</p>}
        </div>
      </div>
    </Modal>
  );
}
