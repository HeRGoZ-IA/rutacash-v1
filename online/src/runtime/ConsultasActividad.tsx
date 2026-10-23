// CONSULTAS v2 · ACTIVIDAD (Ronda 74 · bloque B): lo que pasó SIN mover efectivo — solicitudes,
// autorizaciones y rechazos, cuadres, cierres, correcciones sin diferencia y ajustes contables (p. ej. la
// reclasificación capital/interés). Sin columnas de entrada/salida: aquí no hay dinero que sumar.

import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatClientName } from '@/lib/displayName';
import { cn } from '@/lib/utils';
import { serverView } from './projection.ts';
import { DayHeading, money, rowKeys } from './ConsultasParts.tsx';
import { STATUS_LABEL, dayHeading, extraCount, kindLabel, person, queryOf, type ActivityPage, type ActivityRow, type Filters } from './consultasModel.ts';

const PAGE = 50;

function subject(r: ActivityRow): string {
  if (r.client) return formatClientName(r.client.name ?? '') || 'Cliente';
  if (r.worker) return person(r.worker);
  if (r.route) return r.route.name ?? 'Ruta';
  return '—';
}

function byDay(rows: ActivityRow[]): [string, ActivityRow[]][] {
  const out: [string, ActivityRow[]][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === r.date) last[1].push(r); else out.push([r.date, [r]]);
  }
  return out;
}

export function ConsultasActividad({ filters, today, minorUnits, currency, revision, onOpen, showDate }: {
  filters: Filters; today: string; minorUnits: number; currency?: string; revision: number; onOpen: (row: ActivityRow) => void; showDate: boolean;
}) {
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [q, setQ] = useState(filters.q);
  useEffect(() => { const t = window.setTimeout(() => setQ(filters.q), 300); return () => window.clearTimeout(t); }, [filters.q]);
  const effective = useMemo(() => ({ ...filters, q }), [filters, q]);

  useEffect(() => {
    if (!effective.perspective) return;
    let alive = true;
    setLoading(true);
    serverView<ActivityPage>(`/v1/movements/activity?${queryOf(effective, today, 0, PAGE, minorUnits, 'activity')}`)
      .then((p) => { if (alive) { setPage(p); setRows(p.rows); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [effective, today, minorUnits, revision, retry]);

  async function loadMore() {
    setMore(true);
    try {
      const p = await serverView<ActivityPage>(`/v1/movements/activity?${queryOf(effective, today, rows.length, PAGE, minorUnits, 'activity')}`);
      setRows((prev) => [...prev, ...p.rows]);
      setPage((prev) => (prev ? { ...prev, hasMore: p.hasMore } : p));
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar'); } finally { setMore(false); }
  }

  if (error && !page) {
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex flex-wrap items-center gap-3">
        <span>No se pudo cargar la actividad: {error}</span>
        <Button variant="secondary" size="sm" icon={<RotateCcw className="w-4 h-4" />} onClick={() => setRetry((n) => n + 1)}>Reintentar</Button>
      </div>
    );
  }
  const filtered = Boolean(filters.group) || extraCount(filters) > 0;
  const days = byDay(rows);
  const total = page?.total ?? 0;
  const note = (r: ActivityRow) => [r.concept, r.amountMinor !== null && r.amountMinor !== 0 ? `Monto: ${money(Math.abs(r.amountMinor), currency)}` : ''].filter(Boolean).join(' · ');

  return (
    <div className="space-y-4" data-testid="consultas-actividad">
      <p className="text-sm text-gray-600">Eventos que no movieron efectivo. Los montos son de referencia: no suman en ninguna caja.</p>
      <div className={cn('hidden md:block rounded-2xl border border-gray-200 bg-white shadow-card overflow-hidden', loading && 'opacity-60')} aria-busy={loading}>
        <table className="w-full table-fixed text-sm" onKeyDown={rowKeys} data-testid="activity-table">
          <caption className="sr-only">Actividad sin dinero. Seleccione una fila para ver el detalle.</caption>
          <colgroup><col className="w-[4.5rem]" /><col className="w-[24%]" /><col /><col className="w-[18%]" /><col className="w-[7.5rem]" /></colgroup>
          <thead className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">Hora</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">Evento</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">Persona / concepto</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">Responsable</th>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">Estado</th>
            </tr>
          </thead>
          {days.map(([day, list]) => (
            <tbody key={day} className="divide-y divide-gray-100">
              {showDate && <DayHeading colSpan={5}>{dayHeading(day)}</DayHeading>}
              {list.map((r) => {
                const label = kindLabel(r.kind, r.reversesKind);
                const n = note(r);
                return (
                  <tr key={r.id} onClick={() => onOpen(r)} className="cursor-pointer hover:bg-primary-50/50 focus-within:bg-primary-50/50" data-testid="activity-row">
                    <td className="px-4 py-2.5 align-top tabular-nums text-gray-600">{r.localTime}</td>
                    <td className="px-3 py-2.5 align-top min-w-0">
                      <button type="button" data-row aria-haspopup="dialog" onClick={(e) => { e.stopPropagation(); onOpen(r); }} aria-label={`${label}, ${subject(r)}, ${r.localTime}. Ver detalle`}
                        className="block max-w-full truncate text-left font-medium text-gray-900 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2">{label}</button>
                    </td>
                    <td className="px-3 py-2.5 align-top min-w-0">
                      <span className="block truncate text-gray-900" title={subject(r)}>{subject(r)}</span>
                      {n && <span className="block truncate text-xs text-gray-500" title={n}>{n}</span>}
                    </td>
                    <td className="px-3 py-2.5 align-top min-w-0"><span className="block truncate text-gray-700">{person(r.actor, '—')}</span></td>
                    <td className="px-4 py-2.5 align-top text-gray-600">{STATUS_LABEL[r.status] ?? r.status}</td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {!loading && rows.length === 0 && <Empty filtered={filtered} />}
      </div>
      <div className="md:hidden" onKeyDown={rowKeys} aria-busy={loading}>
        {days.map(([day, list]) => (
          <section key={day} aria-label={dayHeading(day)} className="mb-3">
            {showDate && <DayHeading>{dayHeading(day)}</DayHeading>}
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-card">
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" data-row aria-haspopup="dialog" onClick={() => onOpen(r)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-left active:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500">
                    <span className="truncate text-sm font-medium text-gray-900">{kindLabel(r.kind, r.reversesKind)}</span>
                    <span className="text-xs text-gray-500">{STATUS_LABEL[r.status] ?? r.status}</span>
                    <span className="col-span-2 truncate text-sm text-gray-700">{subject(r)}</span>
                    <span className="col-span-2 truncate text-xs text-gray-500">{r.localTime} · {person(r.actor, '—')}{note(r) ? ` · ${note(r)}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!loading && rows.length === 0 && <div className="rounded-2xl border border-gray-200 bg-white"><Empty filtered={filtered} /></div>}
      </div>
      {loading && rows.length === 0 && <div className="space-y-2" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-xl bg-gray-100 motion-safe:animate-pulse" />)}</div>}
      {error && page && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {rows.length > 0 && (
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
          <p className="text-sm text-gray-500" aria-live="polite">Mostrando {rows.length} de {total}</p>
          {page?.hasMore && <Button variant="secondary" onClick={loadMore} loading={more}>Cargar {Math.min(PAGE, total - rows.length)} más</Button>}
        </div>
      )}
    </div>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-gray-800">{filtered ? 'Ningún evento cumple estos filtros' : 'Sin actividad en este periodo'}</p>
      <p className="mt-1 text-sm text-gray-500">Las solicitudes, autorizaciones, cuadres y cierres aparecerán aquí.</p>
    </div>
  );
}
