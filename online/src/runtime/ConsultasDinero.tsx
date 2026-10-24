// CONSULTAS v2 · DINERO (Ronda 74 · bloque B). Solo movimientos de efectivo de la perspectiva elegida:
// resumen que concilia (saldo inicial + entradas − salidas = saldo final; internos aparte), y la lista
// con seis columnas en escritorio (Hora, Movimiento, Persona/concepto, Responsable, Entrada, Salida) o
// tarjetas en móvil. Filtros, totales y páginas vienen del servidor (`GET /v1/movements/cash`).

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, AlertTriangle, Download, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils';
import { serverView } from './projection.ts';
import { isRouteBaseUi, useCapitalModel } from './routeBase/api.ts';
import { DayHeading, money, rowKeys } from './ConsultasParts.tsx';
import {
  CSV_MAX_ROWS, STATUS_LABEL, cashCsv, counterpartOf, dayHeading, extraCount, groupLabel, kindLabel, person, queryOf,
  type CashPage, type CashRow, type Filters,
} from './consultasModel.ts';

const PAGE = 50;

function byDay<T extends { date: string }>(rows: T[]): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === r.date) last[1].push(r); else out.push([r.date, [r]]);
  }
  return out;
}

/** Resumen del periodo: una ecuación que se lee de izquierda a derecha y siempre cuadra. */
function Summary({ page, currency }: { page: CashPage; currency?: string }) {
  const s = page.summary;
  const cells: { op: string; label: string; value: number; tone?: string; id: string }[] = [
    { op: '', label: 'Saldo inicial', value: s.openingMinor, id: 'opening' },
    { op: '+', label: 'Entradas', value: s.inMinor, tone: 'text-emerald-700', id: 'in' },
    { op: '−', label: 'Salidas', value: s.outMinor, id: 'out' },
    { op: '=', label: 'Saldo final', value: s.closingMinor, id: 'closing' },
  ];
  const groups = s.groups.filter((g) => g.count > 0);
  return (
    <section aria-label="Resumen del periodo" className="rounded-2xl border border-gray-200 bg-white shadow-card" data-testid="cash-summary">
      <dl className="grid grid-cols-2 lg:grid-cols-4">
        {cells.map((c, i) => (
          <div key={c.id} data-testid={`sum-${c.id}`}
            className={cn('relative px-4 py-3 sm:px-5 sm:py-4 min-w-0', i % 2 === 1 && 'border-l border-gray-100', i >= 2 && 'border-t lg:border-t-0 border-gray-100', i === 2 && 'lg:border-l')}>
            <dt className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
              {c.op && <span aria-hidden="true" className="inline-flex w-4 justify-center text-sm font-semibold text-gray-400">{c.op}</span>}
              {c.label}
            </dt>
            <dd className={cn('mt-1 text-lg sm:text-xl font-semibold tabular-nums tracking-tight text-gray-900 truncate', c.tone)} title={money(c.value, currency)}>
              {money(c.value, currency)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2 border-t border-gray-100 px-4 py-2.5 sm:px-5 text-sm text-gray-600 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
        <span data-testid="sum-internal">
          <ArrowLeftRight className="mr-1.5 inline w-4 h-4 -mt-0.5 text-gray-400" aria-hidden="true" />
          Traspasos internos: <strong className="font-semibold tabular-nums text-gray-800">{money(s.internalMinor, currency)}</strong>{' '}
          <span className="text-gray-500">(no cambian el saldo)</span>
        </span>
        {s.ledger.ok
          ? <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="w-4 h-4" aria-hidden="true" />Cuadra con el libro contable</span>
          : <span role="alert" className="inline-flex items-center gap-1.5 text-amber-700"><AlertTriangle className="w-4 h-4" aria-hidden="true" />Hay patas de estas cuentas que su rol no puede ver: el saldo puede no coincidir.</span>}
        {groups.length > 0 && (
          <details className="group sm:ml-auto">
            <summary className="cursor-pointer select-none rounded text-primary-700 hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">Desglose por tipo</summary>
            <table className="mt-2 w-full min-w-[18rem] text-sm">
              <thead><tr className="text-xs text-gray-500"><th scope="col" className="py-1 text-left font-medium">Tipo</th><th scope="col" className="py-1 text-right font-medium">Entradas</th><th scope="col" className="py-1 text-right font-medium">Salidas</th><th scope="col" className="py-1 text-right font-medium">Internos</th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {groups.map((g) => (
                  <tr key={g.group}>
                    <th scope="row" className="py-1 pr-3 text-left font-normal text-gray-700">{groupLabel(g.group)} <span className="text-gray-400">({g.count})</span></th>
                    <td className="py-1 pl-2 text-right tabular-nums">{g.inMinor ? money(g.inMinor, currency) : '—'}</td>
                    <td className="py-1 pl-2 text-right tabular-nums">{g.outMinor ? money(g.outMinor, currency) : '—'}</td>
                    <td className="py-1 pl-2 text-right tabular-nums text-gray-500">{g.internalMinor ? money(g.internalMinor, currency) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </section>
  );
}

/** Importe con signo (móvil y lector de pantalla): nunca solo el color. */
function SignedAmount({ r, currency, className }: { r: CashRow; currency?: string; className?: string }) {
  if (r.flow === 'internal') return <span className={cn('tabular-nums text-gray-500', className)}><span className="sr-only">Interno: </span>{money(r.internalMinor, currency)}<span className="ml-1 text-xs">interno</span></span>;
  const isIn = r.flow === 'in';
  return (
    <span className={cn('tabular-nums font-semibold', isIn ? 'text-emerald-700' : 'text-gray-900', className)}>
      <span className="sr-only">{isIn ? 'Entrada: ' : 'Salida: '}</span>
      <span aria-hidden="true">{isIn ? '+' : '−'}</span>{money(isIn ? r.inMinor : r.outMinor, currency)}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === 'aplicada' || status === 'anulacion') return null;
  return <span className="ml-1.5 inline-flex shrink-0 items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">{STATUS_LABEL[status] ?? status}</span>;
}

export function ConsultasDinero({ filters, today, timezone, currency, minorUnits, revision, onOpen, showDate }: {
  filters: Filters; today: string; timezone: string; currency?: string; minorUnits: number; revision: number;
  onOpen: (row: CashRow) => void; showDate: boolean;
}) {
  const rb = isRouteBaseUi(useCapitalModel());
  const [page, setPage] = useState<CashPage | null>(null);
  const [rows, setRows] = useState<CashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // La búsqueda libre espera a que se deje de escribir; el resto de filtros se aplica al instante.
  const [q, setQ] = useState(filters.q);
  useEffect(() => { const t = window.setTimeout(() => setQ(filters.q), 300); return () => window.clearTimeout(t); }, [filters.q]);
  const effective = useMemo(() => ({ ...filters, q }), [filters, q]);

  useEffect(() => {
    if (!effective.perspective) return;
    let alive = true;
    setLoading(true);
    serverView<CashPage>(`/v1/movements/cash?${queryOf(effective, today, 0, PAGE, minorUnits, 'cash')}`)
      .then((p) => { if (alive) { setPage(p); setRows(p.rows); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [effective, today, minorUnits, revision, retry]);

  async function loadMore() {
    setMore(true);
    try {
      const p = await serverView<CashPage>(`/v1/movements/cash?${queryOf(effective, today, rows.length, PAGE, minorUnits, 'cash')}`);
      setRows((prev) => [...prev, ...p.rows]);
      setPage((prev) => (prev ? { ...prev, hasMore: p.hasMore } : p));
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar'); } finally { setMore(false); }
  }

  // D74-B1: exportación con los mismos filtros del servidor (páginas de 200, tope CSV_MAX_ROWS).
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      const all: CashRow[] = [];
      let offset = 0;
      for (;;) {
        const p = await serverView<CashPage>(`/v1/movements/cash?${queryOf(effective, today, offset, 200, minorUnits, 'cash')}`);
        all.push(...p.rows);
        offset += p.rows.length;
        if (!p.hasMore || p.rows.length === 0 || all.length >= CSV_MAX_ROWS) break;
      }
      const blob = new Blob([cashCsv(all.slice(0, CSV_MAX_ROWS), minorUnits, rb)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `consultas-dinero-${page?.period.from ?? 'inicio'}-${page?.period.to ?? today}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (all.length >= CSV_MAX_ROWS) toast.warning(`Se exportaron los primeros ${CSV_MAX_ROWS} movimientos: acote el periodo o los filtros para el resto.`);
      else toast.success(`CSV con ${all.length} movimientos, con los filtros vigentes.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo exportar'); } finally { setExporting(false); }
  }

  const listFiltered = Boolean(filters.group) || extraCount(filters) > 0;
  const days = byDay(rows);
  const hasMore = page?.hasMore ?? false;
  const total = page?.filtered.count ?? 0;

  if (error && !page) {
    return (
      <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex flex-wrap items-center gap-3">
        <span>No se pudieron cargar los movimientos: {error}</span>
        <Button variant="secondary" size="sm" icon={<RotateCcw className="w-4 h-4" />} onClick={() => setRetry((n) => n + 1)}>Reintentar</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="consultas-dinero">
      {page ? <Summary page={page} currency={currency} /> : <div className="h-36 rounded-2xl bg-gray-100 motion-safe:animate-pulse" aria-hidden="true" />}

      {page?.summary.outside && page.summary.outside.count > 0 && (
        <p className="rounded-xl bg-primary-50 px-4 py-2.5 text-sm text-primary-900">
          {rb ? <>
            {page.summary.outside.count === 1 ? 'Una operación' : `${page.summary.outside.count} operaciones`} de esta ruta no tocan su Base ni sus custodias
            (anteriores a Base por Ruta, pagadas o recibidas con el saldo anterior del Administrador). No cambian el efectivo de la ruta.
          </> : <>
            {page.summary.outside.count === 1 ? 'Una operación' : `${page.summary.outside.count} operaciones`} de esta ruta las pagó o recibió directamente la bolsa del
            Administrador (ventas o recaudos del Administrador). No cambian el efectivo en custodia; se ven eligiendo esa bolsa en «Caja o ruta».
          </>}
        </p>
      )}

      {page && page.filtered.count > 0 && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => { void exportCsv(); }} loading={exporting} icon={<Download className="w-4 h-4" />} data-testid="cash-export">
            Exportar CSV
          </Button>
        </div>
      )}

      {listFiltered && page && (
        <p className="text-sm text-gray-600" aria-live="polite" data-testid="cash-filtered">
          Con estos filtros: <strong className="font-semibold text-gray-900">{total} {total === 1 ? 'movimiento' : 'movimientos'}</strong>
          {' · '}entradas <span className="tabular-nums">{money(page.filtered.inMinor, currency)}</span>
          {' · '}salidas <span className="tabular-nums">{money(page.filtered.outMinor, currency)}</span>
          {page.filtered.internalMinor > 0 && <> · internos <span className="tabular-nums">{money(page.filtered.internalMinor, currency)}</span></>}
        </p>
      )}

      {/* Escritorio: seis columnas, sin desplazamiento horizontal (los textos largos se abrevian). */}
      <div className={cn('hidden md:block rounded-2xl border border-gray-200 bg-white shadow-card overflow-hidden', loading && 'opacity-60 transition-opacity')} aria-busy={loading}>
        <table className="w-full table-fixed text-sm" data-testid="cash-table" onKeyDown={rowKeys}>
          <caption className="sr-only">Movimientos de dinero de {page?.perspective.label ?? 'la perspectiva elegida'}. Seleccione una fila para ver el detalle.</caption>
          <colgroup>
            <col className="w-[3.75rem] xl:w-[4.5rem]" /><col className="w-[22%] xl:w-[25%]" /><col /><col className="w-[15%] xl:w-[17%]" /><col className="w-[7.25rem] xl:w-[8.5rem]" /><col className="w-[7.25rem] xl:w-[8.5rem]" />
          </colgroup>
          <thead className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-left font-medium">Hora</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">Movimiento</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Persona / concepto</th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">Responsable</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Entrada</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">Salida</th>
            </tr>
          </thead>
          {days.map(([day, list]) => (
            <tbody key={day} className="divide-y divide-gray-100">
              {showDate && <DayHeading colSpan={6}>{dayHeading(day)}</DayHeading>}
              {list.map((r) => {
                const who = counterpartOf(r, rb);
                const label = kindLabel(r.kind, r.reversesKind, rb);
                return (
                  <tr key={r.id} onClick={() => onOpen(r)} className={cn('cursor-pointer hover:bg-primary-50/50 focus-within:bg-primary-50/50', r.status === 'anulada' && 'text-gray-500')} data-testid="cash-row">
                    <td className="px-4 py-2.5 align-top tabular-nums text-gray-600">{r.localTime}</td>
                    <td className="px-3 py-2.5 align-top min-w-0">
                      <button type="button" data-row onClick={(e) => { e.stopPropagation(); onOpen(r); }} aria-haspopup="dialog"
                        aria-label={`${label}, ${who}, ${r.localTime}. Ver detalle`}
                        className="flex max-w-full items-center text-left font-medium text-gray-900 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2">
                        <span className={cn('truncate', r.status === 'anulada' && 'line-through decoration-gray-400')}>{label}</span>
                        <StatusChip status={r.status} />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 align-top min-w-0">
                      <span className="block truncate text-gray-900" title={who}>{who}</span>
                      {r.concept && <span className="block truncate text-xs text-gray-500" title={r.concept}>{r.concept}</span>}
                    </td>
                    <td className="px-3 py-2.5 align-top min-w-0">
                      <span className="block truncate text-gray-700" title={person(r.actor, '—')}>{person(r.actor, '—')}</span>
                    </td>
                    {r.flow === 'internal' ? (
                      <td colSpan={2} className="px-4 py-2.5 align-top text-right tabular-nums text-gray-500">
                        <span className="inline-flex items-center gap-1"><ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />{money(r.internalMinor, currency)} <span className="text-xs">interno</span></span>
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-2.5 align-top text-right tabular-nums font-medium text-emerald-700 whitespace-nowrap">{r.inMinor ? money(r.inMinor, currency) : ''}</td>
                        <td className="px-4 py-2.5 align-top text-right tabular-nums font-medium text-gray-900 whitespace-nowrap">{r.outMinor ? money(r.outMinor, currency) : ''}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {!loading && rows.length === 0 && <Empty filtered={listFiltered} period={filters.period} />}
      </div>

      {/* Móvil: lista de tarjetas, sin tabla comprimida. */}
      <div className="md:hidden" aria-busy={loading} onKeyDown={rowKeys} data-testid="cash-cards">
        {days.map(([day, list]) => (
          <section key={day} aria-label={dayHeading(day)} className="mb-3">
            {showDate && <DayHeading>{dayHeading(day)}</DayHeading>}
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-card">
              {list.map((r) => {
                const who = counterpartOf(r, rb);
                const label = kindLabel(r.kind, r.reversesKind, rb);
                return (
                  <li key={r.id}>
                    <button type="button" data-row onClick={() => onOpen(r)} aria-haspopup="dialog" data-testid="cash-card"
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-left active:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500">
                      <span className="flex min-w-0 items-center text-sm font-medium text-gray-900">
                        <span className={cn('truncate', r.status === 'anulada' && 'line-through decoration-gray-400')}>{label}</span><StatusChip status={r.status} />
                      </span>
                      <SignedAmount r={r} currency={currency} className="text-sm text-right" />
                      <span className="col-span-2 truncate text-sm text-gray-700">{who}</span>
                      <span className="col-span-2 truncate text-xs text-gray-500">{r.localTime} · {person(r.actor, '—')}{r.concept ? ` · ${r.concept}` : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!loading && rows.length === 0 && <div className="rounded-2xl border border-gray-200 bg-white"><Empty filtered={listFiltered} period={filters.period} /></div>}
      </div>

      {loading && rows.length === 0 && (
        <div className="space-y-2" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-xl bg-gray-100 motion-safe:animate-pulse" />)}</div>
      )}
      {error && page && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {rows.length > 0 && (
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
          <p className="text-sm text-gray-500" aria-live="polite">Mostrando {rows.length} de {total}</p>
          {hasMore && <Button variant="secondary" onClick={loadMore} loading={more} data-testid="cash-more">Cargar {Math.min(PAGE, total - rows.length)} más</Button>}
        </div>
      )}
      {loading && rows.length > 0 && <p className="sr-only" aria-live="polite">Actualizando…</p>}
    </div>
  );
}

function Empty({ filtered, period }: { filtered: boolean; period: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-gray-800">{filtered ? 'Ningún movimiento cumple estos filtros' : period === 'hoy' ? 'Sin movimientos de dinero hoy' : 'Sin movimientos de dinero en este periodo'}</p>
      <p className="mt-1 text-sm text-gray-500">{filtered ? 'Pruebe con otro tipo o quite filtros en «Más filtros».' : 'Elija otro periodo o cambie de caja o ruta.'}</p>
    </div>
  );
}
