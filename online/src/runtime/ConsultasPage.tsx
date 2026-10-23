// CONSULTAS (Ronda 74 · bloque B). Reemplaza la tabla de 13 columnas de R73 (rechazada).
//
//   Dinero     (por defecto) solo movimientos de EFECTIVO de una perspectiva: Empresa, una ruta (sus
//              custodias), una bolsa de Administrador o una custodia. Resumen que concilia con el libro.
//   Actividad  lo que pasó sin mover efectivo: solicitudes, decisiones, cuadres, cierres, ajustes contables.
//   Detalle    panel lateral: identificadores completos, patas contables, comprobante y vínculos.
//
// Vistas anteriores (Caja por ruta, Transferencias, Historial con comprobantes) siguen disponibles por
// URL (`?vista=`) y desde «Otras vistas»: otras pantallas enlazan a ellas.
// Enlaces anteriores (`?adminId=`, `?routeId=`, `?workerId=`, `?referencia=`, `?categoria=capital`,
// `?desde=`/`?hasta=`) se traducen a los filtros nuevos. Todo el filtrado ocurre en el servidor.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatPersonName } from '@/lib/displayName';
import { cn } from '@/lib/utils';
import { MovementsPanel } from './ConsultasMovements.tsx';
import { TransfersHistory } from './TransfersHistory.tsx';
import { CashboxPanel } from './ConsultasCashbox.tsx';
import { ConsultasDinero } from './ConsultasDinero.tsx';
import { ConsultasActividad } from './ConsultasActividad.tsx';
import { DetailDrawer, FilterBar } from './ConsultasParts.tsx';
import { serverView } from './projection.ts';
import { useRuntime } from './session.ts';
import {
  EMPTY_EXTRA, periodRange, todayIn, type CashRow, type ActivityRow, type Filters, type PeriodPreset, type Perspectives,
} from './consultasModel.ts';

const MAIN = [{ id: 'dinero', label: 'Dinero' }, { id: 'actividad', label: 'Actividad' }] as const;
const LEGACY = [
  { id: 'caja', label: 'Caja por ruta' }, { id: 'transferencias', label: 'Transferencias' }, { id: 'comprobantes', label: 'Historial con comprobantes' },
] as const;
type View = (typeof MAIN)[number]['id'] | (typeof LEGACY)[number]['id'];
const PRESETS: PeriodPreset[] = ['hoy', 'ayer', '7d', 'mes', 'mes-anterior', 'todo', 'rango'];

/** Filtros iniciales desde la URL (incluidos los enlaces de pantallas anteriores). */
function fromUrl(p: URLSearchParams): Partial<Filters> {
  const f: Partial<Filters> = {};
  const persp = p.get('perspectiva') ?? (p.get('adminId') ? `admin:${p.get('adminId')}` : p.get('routeId') ? `route:${p.get('routeId')}` : null);
  if (persp) f.perspective = persp;
  const period = p.get('periodo') as PeriodPreset | null;
  if (period && PRESETS.includes(period)) f.period = period;
  const from = p.get('desde'), to = p.get('hasta');
  if (from || to) { f.period = 'rango'; f.from = from ?? undefined; f.to = to ?? undefined; }
  const group = p.get('tipo') ?? (p.get('categoria') === 'capital' ? 'capital' : null);
  if (group) f.group = group;
  if (p.get('workerId')) f.personId = p.get('workerId')!;
  if (p.get('referencia')) { f.q = p.get('referencia')!; if (!from && !to && !period) f.period = 'todo'; }
  return f;
}

export default function ConsultasPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('vista');
  const view: View = [...MAIN, ...LEGACY].some((v) => v.id === raw) ? (raw as View) : 'dinero';
  const company = useRuntime((s) => s.ctx?.company);
  const timezone = company?.timezone ?? 'UTC';
  const minorUnits = company?.minorUnits ?? 2;
  const { tenantId, currency } = useTenant();
  const revision = useDataRevision();
  const today = useMemo(() => todayIn(timezone), [timezone]);

  const [perspectives, setPerspectives] = useState<Perspectives | null>(null);
  const [perspError, setPerspError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(() => ({ perspective: '', period: 'hoy', group: '', ...EMPTY_EXTRA, ...fromUrl(params) }));
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  const [detail, setDetail] = useState<{ id: string; hint: CashRow | null } | null>(null);

  useEffect(() => {
    let alive = true;
    serverView<Perspectives>('/v1/movements/perspectives')
      .then((p) => {
        if (!alive) return;
        setPerspectives(p);
        setFilters((f) => (f.perspective && p.options.some((o) => o.key === f.perspective) ? f : { ...f, perspective: p.default ?? p.options[0]?.key ?? '' }));
      })
      .catch((e) => { if (alive) setPerspError(e instanceof Error ? e.message : 'No se pudo cargar'); });
    return () => { alive = false; };
  }, [revision]);

  useEffect(() => {
    let alive = true;
    void db.users.where('tenantId').equals(tenantId).toArray().then((us) => {
      if (alive) setPeople(us.map((u) => ({ value: u.id, label: formatPersonName(u.nombre) })).sort((a, b) => a.label.localeCompare(b.label, 'es')));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [tenantId, revision]);

  // La URL refleja vista, perspectiva, periodo y tipo (enlaces que se pueden compartir); el resto no.
  useEffect(() => {
    if (view !== 'dinero' && view !== 'actividad') return;
    const next = new URLSearchParams();
    if (view !== 'dinero') next.set('vista', view);
    if (filters.perspective) next.set('perspectiva', filters.perspective);
    if (filters.period !== 'hoy') next.set('periodo', filters.period);
    if (filters.period === 'rango') { if (filters.from) next.set('desde', filters.from); if (filters.to) next.set('hasta', filters.to); }
    if (filters.group) next.set('tipo', filters.group);
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [view, filters.perspective, filters.period, filters.from, filters.to, filters.group]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const choose = (id: View) => {
    if (id === 'dinero' || id === 'actividad') { setFilters((f) => ({ ...f, group: '', flow: '', status: '', minAmount: '', maxAmount: '' })); setParams(id === 'dinero' ? new URLSearchParams() : new URLSearchParams({ vista: id }), { replace: true }); }
    else setParams(new URLSearchParams({ vista: id }), { replace: true });
  };
  const range = periodRange(filters.period, today, { from: filters.from, to: filters.to });
  const showDate = !(range.from && range.from === range.to);
  const current = perspectives?.options.find((o) => o.key === filters.perspective);
  const perspectiveLabel = current ? (current.kind === 'company' ? 'la empresa' : current.kind === 'route' ? `la ruta ${current.label}` : current.label) : 'la caja elegida';
  const legacy = LEGACY.find((v) => v.id === view);

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="consultas-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-gray-900">Consultas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{legacy ? legacy.label : view === 'dinero' ? 'Entradas y salidas de efectivo, con saldo inicial y final' : 'Solicitudes, decisiones, cuadres y cierres sin movimiento de efectivo'}</p>
        </div>
        {!legacy && (
          <div className="inline-flex w-full sm:w-auto rounded-xl border border-gray-200 bg-white p-1 shadow-sm" role="group" aria-label="Vista de Consultas">
            {MAIN.map((v) => (
              <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => choose(v.id)} data-testid={`vista-${v.id}`}
                className={cn('flex-1 sm:flex-none min-h-[40px] px-5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  view === v.id ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-50')}>
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {legacy ? (
        <>
          <button type="button" onClick={() => choose('dinero')} className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <ChevronLeft className="w-4 h-4" /> Volver a Consultas
          </button>
          {view === 'comprobantes' ? <MovementsPanel /> : view === 'transferencias' ? <TransfersHistory /> : <CashboxPanel />}
        </>
      ) : perspError ? (
        <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">No se pudieron cargar las cajas y rutas disponibles: {perspError}</p>
      ) : !perspectives ? (
        <div className="space-y-3" aria-hidden="true"><div className="h-24 rounded-2xl bg-gray-100 motion-safe:animate-pulse" /><div className="h-36 rounded-2xl bg-gray-100 motion-safe:animate-pulse" /></div>
      ) : perspectives.options.length === 0 ? (
        <p className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">Todavía no hay cajas ni rutas a su cargo para consultar.</p>
      ) : (
        <>
          <FilterBar view={view === 'actividad' ? 'activity' : 'cash'} filters={filters} set={set} perspectives={perspectives.options} people={people} />
          {view === 'dinero'
            ? <ConsultasDinero filters={filters} today={today} timezone={timezone} currency={currency} minorUnits={minorUnits} revision={revision} showDate={showDate}
                onOpen={(r: CashRow) => setDetail({ id: r.id, hint: r })} />
            : <ConsultasActividad filters={filters} today={today} minorUnits={minorUnits} currency={currency} revision={revision} showDate={showDate}
                onOpen={(r: ActivityRow) => setDetail({ id: r.id, hint: null })} />}
          <nav aria-label="Otras vistas" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 pt-3 text-sm text-gray-500">
            <span>Otras vistas:</span>
            {LEGACY.map((v) => (
              <Link key={v.id} to={`/admin/consultas?vista=${v.id}`} className="text-primary-700 hover:underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">{v.label}</Link>
            ))}
          </nav>
        </>
      )}

      {detail && (
        <DetailDrawer id={detail.id} timezone={timezone} currency={currency} perspectiveLabel={perspectiveLabel}
          flowHint={detail.hint ? { inMinor: detail.hint.inMinor, outMinor: detail.hint.outMinor, internalMinor: detail.hint.internalMinor } : null}
          onClose={() => setDetail(null)} onOpen={(id) => setDetail({ id, hint: null })} onFilter={set} />
      )}
    </div>
  );
}
