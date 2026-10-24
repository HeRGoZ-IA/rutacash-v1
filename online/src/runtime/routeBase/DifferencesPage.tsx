// DIFERENCIAS Y CONCILIACIÓN (R74 · migración 0036, decisión RB-D3 del propietario).
//
// Regla rectora: el Administrador es el máximo responsable del dinero. El Administrador responsable VIGENTE de
// la ruta concilia faltantes y sobrantes SIN autorización superior: ve lo esperado, lo contado y la diferencia,
// elige una resolución expresa, ve la vista previa (qué se movería y qué lo impediría), escribe el motivo y
// confirma. Cada conciliación es una operación NUEVA balanceada (no reescribe asientos ni cierres); al resolver,
// la ruta continúa. Por defecto un faltante NO se convierte en deuda del trabajador ni un sobrante en ganancia:
// hay que elegirlo. Funciona con Base por Ruta y con el modelo de bolsas. SuperAdmin y Supervisor: solo lectura.
// `?ruta=<id>` filtra por ruta (desde la alerta «Diferencias por conciliar» del panel).

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, History, Scale } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatDate, formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { generateId, cn } from '@/lib/utils';
import { useRuntime } from '../session.ts';
import {
  fetchConciliations, fetchDifferences, previewDifference, resolveDifference, useCapitalModel, isRouteBaseUi,
  type Conciliation, type DifferenceBlocker, type DifferenceItem, type DifferencePreview, type DifferencesPage as Page, type Resolution,
} from './api.ts';
import { Notice, num, useMoney } from './parts.tsx';

export const BLOCKER_TEXT: Record<DifferenceBlocker, string> = {
  ONLY_ADMINISTRATOR: 'Solo el Administrador responsable de la ruta concilia; tu rol la consulta.',
  NO_VALID_CONTROLLER: 'La ruta no tiene un Administrador responsable válido: primero hay que asignarlo.',
  NOT_ROUTE_CONTROLLER: 'No eres el Administrador responsable vigente de esta ruta.',
  PERIOD_CLOSED: 'El periodo de hoy de la ruta está cerrado.',
  OWN_CASH: 'Es tu propio efectivo: nadie concilia lo suyo, tampoco con otra membresía.',
  ROUTE_IN_HANDOVER: 'La ruta está en entrega: el nuevo responsable debe confirmar el conteo antes.',
  CAPITAL_MIGRATION_IN_PROGRESS: 'La empresa está pasando a Base por Ruta: esta resolución espera a que termine la activación.',
};

/** Qué significa cada resolución, en una frase (sin tecnicismos contables). */
const RESOLUTION_HELP: Record<Resolution, string> = {
  route_shortage: 'La ruta asume el faltante. Queda registrado como faltante conciliado; no es un gasto ni una pérdida de resultado.',
  worker_owes: 'El trabajador debe reponerlo: queda como faltante pendiente a su cargo (se ve en sus cuadres).',
  surplus_to_base: 'El sobrante pasa a la Base de la ruta. Queda registrado como sobrante conciliado; no es ganancia.',
  surplus_returned: 'El sobrante se devuelve a quien pertenece: sale del control y no es ingreso.',
};

const LEG_TEXT: Record<string, string> = {
  route_base: 'Base de la ruta', route_difference: 'Faltante/sobrante conciliado (no es efectivo)', custody: 'Efectivo del trabajador',
  suspense: 'Sobrante en control', admin: 'Bolsa del Administrador', unidentified: 'Origen sin identificar (contrapartida)',
};

export default function DifferencesPage() {
  const me = useRuntime((s) => s.ctx);
  const isAdmin = me?.role === 'admin';
  const money = useMoney();
  const revision = useDataRevision();
  const rb = isRouteBaseUi(useCapitalModel());
  const [params, setParams] = useSearchParams();
  const routeId = params.get('ruta') ?? '';
  const [page, setPage] = useState<Page | null>(null);
  const [history, setHistory] = useState<Conciliation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<DifferenceItem | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchDifferences('pending', routeId || undefined), fetchConciliations(routeId || undefined)])
      .then(([p, h]) => { if (alive) { setPage(p); setHistory(h); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudieron cargar las diferencias'); });
    return () => { alive = false; };
  }, [revision, routeId]);

  const routes = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of page?.items ?? []) m.set(i.routeId, i.routeName);
    for (const c of history) if (c.routeName) m.set(c.routeId, c.routeName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [page, history]);
  const s = page?.summary;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto w-full" data-testid="dif-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Scale className="w-5 h-5 text-gray-500" aria-hidden />Diferencias y conciliación</h1>
          <p className="text-sm text-gray-600 mt-0.5 max-w-2xl">
            Faltantes y sobrantes de cuadres y de entregas de ruta. {isAdmin
              ? 'Como Administrador responsable de la ruta, los concilias tú, sin autorización superior: eliges qué pasa con cada diferencia y queda auditado.'
              : 'Vista de solo lectura: concilia el Administrador responsable de cada ruta.'}
          </p>
        </div>
        {routes.length > 1 && (
          <Select label="Ruta" value={routeId} containerClassName="sm:w-64" placeholder="Todas las rutas"
            onChange={(e) => setParams((p) => { const n = new URLSearchParams(p); if (e.target.value) n.set('ruta', e.target.value); else n.delete('ruta'); return n; }, { replace: true })}
            options={routes.map(([id, name]) => ({ value: id, label: name }))} />
        )}
      </div>

      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : !page ? (
        <div className="h-40 rounded-2xl bg-gray-100 animate-pulse" aria-busy="true" />
      ) : (
        <>
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-2" data-testid="dif-summary">
            <Fig label="Diferencias por conciliar" value={String(s!.pendingCount)} />
            <Fig label="Faltantes pendientes" value={money(s!.pendingShortageMinor)} hint="No es billete" />
            <Fig label="Sobrantes pendientes" value={money(s!.pendingSurplusMinor)} hint="En control; no es Base ni ganancia" />
            <Fig label="A cargo de trabajadores" value={money(s!.workerOwedMinor)} hint="Faltantes decididos como del trabajador" />
          </dl>
          <p className="text-xs text-gray-500">Ninguna de estas cifras es efectivo ni resultado operativo.</p>

          <section className="space-y-2" aria-labelledby="dif-pending-h">
            <h2 id="dif-pending-h" className="text-sm font-semibold text-gray-900">Pendientes</h2>
            {page.items.length === 0 ? (
              <EmptyState icon={<Scale className="w-8 h-8" />} title="No hay diferencias por conciliar" />
            ) : (
              <ul className="space-y-2" data-testid="dif-list">
                {page.items.map((i) => (
                  <li key={`${i.sourceKind}:${i.sourceId}`} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                    data-testid={`dif-item-${i.sourceId}`}>
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', i.kind === 'faltante' ? 'bg-amber-50 text-amber-900' : 'bg-sky-50 text-sky-800')}>
                          {i.kind === 'faltante' ? 'Faltante' : 'Sobrante'}
                        </span>
                        {i.sourceLabel ?? i.sourceKind} · {i.routeName}
                      </p>
                      <p className="text-xs text-gray-600">
                        {i.workerName ? `${formatPersonName(i.workerName)} · ` : i.holderName ? `${formatPersonName(i.holderName)} · ` : ''}{formatDate(i.businessDate)}
                        {' · '}esperado <span className={num}>{money(i.expectedMinor)}</span>, contado <span className={num}>{money(i.countedMinor)}</span>
                      </p>
                      {i.workerOwedMinor > 0 && <p className="text-xs text-gray-500">Ya a cargo del trabajador: {money(i.workerOwedMinor)}</p>}
                    </div>
                    <div className="flex items-center gap-3 sm:flex-shrink-0">
                      <div className="text-right">
                        <p className="text-[11px] text-gray-500">Pendiente</p>
                        <p className={cn(num, 'text-sm font-bold', i.kind === 'faltante' ? 'text-amber-900' : 'text-sky-900')}>{money(i.pendingMinor)}</p>
                      </div>
                      <Button size="sm" variant={isAdmin ? 'primary' : 'secondary'} onClick={() => setOpen(i)} data-testid="dif-open">{isAdmin ? 'Conciliar' : 'Ver'}</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" aria-labelledby="dif-hist-h" data-testid="dif-history">
            <h2 id="dif-hist-h" className="text-sm font-semibold text-gray-900 flex items-center gap-2"><History className="w-4 h-4 text-gray-500" aria-hidden />Historial de conciliaciones</h2>
            {history.length === 0 ? <p className="text-sm text-gray-500">Todavía no hay conciliaciones.</p> : (
              <ul className="divide-y divide-gray-100">
                {history.map((c) => (
                  <li key={c.id} className="py-2.5 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between" data-testid={`dif-conc-${c.id}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{c.resolutionLabel}</p>
                      <p className="text-xs text-gray-600">{c.sourceLabel} · {c.routeName ?? 'Ruta'}{c.workerName ? ` · ${formatPersonName(c.workerName)}` : ''} · esperado {money(c.expectedMinor)}, contado {money(c.countedMinor)}</p>
                      <p className="text-xs text-gray-500 break-words">{formatDateTime(c.createdAt)} · {formatPersonName(c.actorName) || 'Administrador'} · {c.reason}</p>
                      {!c.movesMoney && <p className="text-xs text-gray-500">Sin movimiento de dinero (queda registrado).</p>}
                    </div>
                    <div className="flex items-center gap-3 sm:flex-shrink-0">
                      {c.ledgerOperationId && <Link to={`/comprobante/operacion/${encodeURIComponent(c.ledgerOperationId)}`} target="_blank" rel="noopener" className="text-xs text-primary-700 hover:underline">Comprobante</Link>}
                      <span className={cn(num, 'text-sm font-bold text-gray-900')}>{money(c.amountMinor)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ResolveDialog item={open} onClose={() => setOpen(null)} canWrite={isAdmin} rb={rb} />
    </div>
  );
}

function Fig({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-white border border-gray-100 shadow-card p-3 min-w-0">
      <dt className="text-xs text-gray-600">{label}</dt>
      <dd className={cn(num, 'text-base font-bold text-gray-900')}>{value}</dd>
      {hint && <dd className="text-[11px] leading-tight text-gray-500">{hint}</dd>}
    </div>
  );
}

function ResolveDialog({ item, onClose, canWrite, rb }: { item: DifferenceItem | null; onClose: () => void; canWrite: boolean; rb: boolean }) {
  const money = useMoney();
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [preview, setPreview] = useState<DifferencePreview | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');

  useEffect(() => {
    if (!item) return;
    setResolution(item.allowedResolutions.length === 1 ? item.allowedResolutions[0]! : ''); setReason(''); setError(null); setPreview(null); setAmount(null); setOpId(generateId());
  }, [item]);
  useEffect(() => {
    if (!item) return;
    let alive = true;
    previewDifference(item.sourceKind, item.sourceId, resolution || null)
      .then((p) => { if (alive) { setPreview(p); setAmount(p.amountMinor ?? null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo calcular la vista previa'); });
    return () => { alive = false; };
  }, [item, resolution]);
  if (!item) return null;

  const blockers = preview?.blockers ?? [];
  const problem = !resolution ? 'Elige una resolución.' : !preview ? 'Calculando…' : !preview.canResolve ? 'Hay impedimentos: ver abajo.'
    : amount == null ? 'Elige el importe.' : reason.trim().length < 10 ? 'Explica el motivo (mínimo 10 caracteres).' : null;

  async function confirm() {
    if (problem || !resolution || amount == null) return;
    setSaving(true); setError(null);
    try {
      await resolveDifference({ sourceKind: item!.sourceKind, sourceId: item!.sourceId, resolution, amountMinor: amount, reason }, opId);
      toast.success('Diferencia conciliada');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo conciliar');
      // Un rechazo definitivo es UN intento: el siguiente usa un id nuevo (un reintento por red reutiliza el mismo dentro de `money`).
      setOpId(generateId());
    } finally { setSaving(false); }
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} size="lg" title={`${item.kind === 'faltante' ? 'Faltante' : 'Sobrante'} · ${item.routeName}`} guarded={reason.trim() !== ''}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>{canWrite ? 'Cancelar' : 'Cerrar'}</Button>
        {canWrite && <Button onClick={confirm} loading={saving} disabled={!!problem} data-testid="dif-confirm">Conciliar</Button>}</>}>
      <div className="space-y-4" data-testid="dif-dialog">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          {[['Esperado', item.expectedMinor], ['Contado', item.countedMinor], ['Diferencia', item.differenceMinor]].map(([k, v]) => (
            <div key={k as string} className="rounded-xl bg-gray-50 p-2.5 min-w-0">
              <dt className="text-xs text-gray-500">{k}</dt><dd className={cn(num, 'font-semibold text-gray-900')}>{money(v as number)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-gray-700">{item.sourceLabel} · {item.workerName ? formatPersonName(item.workerName) : item.holderName ? formatPersonName(item.holderName) : ''} · pendiente <b className={num}>{money(item.pendingMinor)}</b></p>
        <fieldset data-testid="dif-resolutions">
          <legend className="block text-sm font-medium text-gray-700 mb-1">Resolución</legend>
          <div className="space-y-2">
            {item.resolutions.map((r) => (
              <label key={r.code} className={cn('flex items-start gap-2 rounded-xl border p-2.5 text-sm', canWrite ? 'cursor-pointer' : '',
                resolution === r.code ? 'border-primary-400 bg-primary-50/60 ring-1 ring-primary-200' : 'border-gray-200')}>
                <input type="radio" className="mt-0.5 h-4 w-4 text-primary-600" checked={resolution === r.code} onChange={() => setResolution(r.code)} data-testid={`dif-res-${r.code}`} />
                <span className="min-w-0"><span className="block font-medium text-gray-900">{r.label}</span><span className="block text-xs text-gray-600">{RESOLUTION_HELP[r.code]}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        {preview && resolution && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2 text-sm" data-testid="dif-preview">
            <p className="font-medium text-gray-900">Vista previa</p>
            {preview.allowedAmountsMinor.length > 1 ? (
              <Select label="Importe a conciliar" value={String(amount ?? '')} onChange={(e) => setAmount(Number(e.target.value))}
                options={preview.allowedAmountsMinor.map((a, ix) => ({ value: String(a), label: ix === 0 ? `${money(a)} · lo pendiente` : `${money(a)} · lo pendiente más lo ya a cargo del trabajador` }))} />
            ) : <p>Importe: <b className={num}>{money(amount)}</b></p>}
            {preview.movesMoney ? (
              <ul className="space-y-1" data-testid="dif-legs">
                {preview.legs.map((l, ix) => (
                  <li key={ix} className="flex items-center gap-2 text-gray-700">
                    <span className={cn('w-14 text-xs font-semibold', l.sign < 0 ? 'text-gray-900' : 'text-emerald-700')}>{l.sign < 0 ? 'Sale de' : 'Llega a'}</span>
                    <span className="min-w-0">{l.kind === 'admin' && rb ? 'Saldo del Administrador' : LEG_TEXT[l.kind] ?? l.kind}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-gray-700" data-testid="dif-no-money">No mueve dinero: queda registrado como decisión del Administrador.</p>}
            {blockers.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800" role="alert" data-testid="dif-blockers">
                <p className="font-medium">No se puede conciliar ahora:</p>
                <ul className="list-disc pl-4 text-xs">{blockers.map((b) => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}</ul>
              </div>
            )}
          </div>
        )}
        {canWrite && <Textarea label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required maxLength={500}
          hint="Qué pasó y por qué eliges esta resolución (mínimo 10 caracteres)." />}
        {canWrite && problem && resolution && <p className="text-xs text-amber-800" role="status">{problem}</p>}
        {!canWrite && <Notice tone="gray">Solo lectura: concilia el Administrador responsable de la ruta.</Notice>}
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert" data-testid="dif-error">{error}</div>}
        <p className="text-xs text-gray-500 flex items-center gap-1"><ArrowRight className="w-3 h-3" aria-hidden />No se reescribe ningún asiento ni cierre: se registra una operación nueva y la ruta continúa.</p>
      </div>
    </Modal>
  );
}
