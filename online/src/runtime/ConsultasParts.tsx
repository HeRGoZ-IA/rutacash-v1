// CONSULTAS v2 (Ronda 74 · bloque B): piezas compartidas por Dinero y Actividad — barra de filtros,
// importes, encabezados de día y el DETALLE de un movimiento (panel lateral; hoja completa en móvil).

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Copy, ExternalLink, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/formatters';
import { formatClientName } from '@/lib/displayName';
import { cn } from '@/lib/utils';
import { serverView } from './projection.ts';
import { toMajor } from './mappers.ts';
import {
  CASH_GROUPS, ACTIVITY_GROUPS, EMPTY_EXTRA, PERIODS, ROLE_LABEL, STATUS_LABEL, extraCount, fullDateTime, kindLabel, partyLabel, person,
  receiptPath, type Detail, type Filters, type PeriodPreset, type PerspectiveOption,
} from './consultasModel.ts';

export const money = (minor: number, currency?: string) => formatCurrency(toMajor(minor), currency);

const FIELD = 'w-full h-11 sm:h-9 rounded-lg border border-gray-300 bg-white text-base sm:text-sm text-gray-900 px-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent';
const LABEL = 'block text-xs font-medium text-gray-600 mb-1';

const KIND_GROUP_LABEL: Record<PerspectiveOption['kind'], string> = { company: 'Empresa', route: 'Rutas (efectivo en custodia)', admin: 'Bolsas de Administradores', custody: 'Custodias de trabajadores' };

/** Selector de perspectiva: «Caja o ruta». Agrupado por tipo; la oficina o la ruta acompañan al nombre. */
export function PerspectiveSelect({ options, value, onChange, id }: { options: PerspectiveOption[]; value: string; onChange: (v: string) => void; id: string }) {
  const kinds = (['company', 'route', 'admin', 'custody'] as const).filter((k) => options.some((o) => o.kind === k));
  return (
    <select id={id} className={cn(FIELD, 'pr-8')} value={value} onChange={(e) => onChange(e.target.value)} data-testid="consultas-perspective">
      {kinds.map((k) => (
        <optgroup key={k} label={KIND_GROUP_LABEL[k]}>
          {options.filter((o) => o.kind === k).map((o) => (
            <option key={o.key} value={o.key}>
              {o.kind === 'custody' ? `${person({ name: o.label.replace(/^Custodia de /, '') })}${o.office ? ` · ${o.office}` : ''}`
                : o.kind === 'admin' ? `Bolsa de ${person({ name: o.label.replace(/^Bolsa de /, '') })}`
                  : `${o.label}${o.office ? ` · ${o.office}` : ''}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Filtros visibles arriba: Caja o ruta, Periodo y Tipo. El resto, en «Más filtros» (en la página, nunca
 * en un desplegable recortado por la tabla). Todo se resuelve en el servidor.
 */
export function FilterBar({ view, filters, set, perspectives, people }: {
  view: 'cash' | 'activity'; filters: Filters; set: (p: Partial<Filters>) => void; perspectives: PerspectiveOption[];
  people: { value: string; label: string }[];
}) {
  const uid = useId();
  const [more, setMore] = useState(() => extraCount(filters) > 0);
  const extras = extraCount(filters);
  const groups = view === 'cash' ? CASH_GROUPS : ACTIVITY_GROUPS;
  return (
    <section aria-label="Filtros" className="rounded-2xl border border-gray-200 bg-white p-3 sm:p-4 shadow-card">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0 col-span-2 lg:col-span-1">
          <label htmlFor={`${uid}-p`} className={LABEL}>Caja o ruta</label>
          <PerspectiveSelect id={`${uid}-p`} options={perspectives} value={filters.perspective} onChange={(v) => set({ perspective: v })} />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${uid}-d`} className={LABEL}>Periodo</label>
          <select id={`${uid}-d`} className={cn(FIELD, 'pr-8')} value={filters.period} data-testid="consultas-period"
            onChange={(e) => set({ period: e.target.value as PeriodPreset })}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${uid}-t`} className={LABEL}>{view === 'cash' ? 'Tipo de movimiento' : 'Tipo de evento'}</label>
          <select id={`${uid}-t`} className={cn(FIELD, 'pr-8')} value={filters.group} onChange={(e) => set({ group: e.target.value })} data-testid="consultas-group">
            <option value="">Todos</option>
            {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
        <div className="flex gap-2 col-span-2 lg:col-span-1">
          <Button variant="secondary" className="flex-1 lg:flex-none h-11 sm:h-9" icon={<SlidersHorizontal className="w-4 h-4" />} aria-expanded={more}
            aria-controls={`${uid}-more`} onClick={() => setMore((m) => !m)} data-testid="consultas-more">
            Más filtros{extras ? ` (${extras})` : ''}
          </Button>
          {extras > 0 && (
            <Button variant="ghost" className="h-11 sm:h-9" onClick={() => set({ ...EMPTY_EXTRA })}>Quitar</Button>
          )}
        </div>
      </div>
      {filters.period === 'rango' && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
          <div><label htmlFor={`${uid}-f`} className={LABEL}>Desde</label>
            <input id={`${uid}-f`} type="date" className={FIELD} value={filters.from ?? ''} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value || undefined })} /></div>
          <div><label htmlFor={`${uid}-h`} className={LABEL}>Hasta</label>
            <input id={`${uid}-h`} type="date" className={FIELD} value={filters.to ?? ''} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value || undefined })} /></div>
        </div>
      )}
      <div id={`${uid}-more`} hidden={!more} className="mt-3 border-t border-gray-100 pt-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 lg:col-span-2">
            <label htmlFor={`${uid}-q`} className={LABEL}>Buscar</label>
            <input id={`${uid}-q`} type="search" className={FIELD} value={filters.q} placeholder="Cliente, persona, concepto o referencia"
              onChange={(e) => set({ q: e.target.value })} data-testid="consultas-q" maxLength={100} />
          </div>
          <div className="min-w-0">
            <label htmlFor={`${uid}-per`} className={LABEL}>Persona</label>
            <select id={`${uid}-per`} className={cn(FIELD, 'pr-8')} value={filters.personId} onChange={(e) => set({ personId: e.target.value })}>
              <option value="">Todas</option>
              {people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor={`${uid}-o`} className={LABEL}>Orden</label>
            <select id={`${uid}-o`} className={cn(FIELD, 'pr-8')} value={filters.sort} onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}>
              <option value="date_desc">Más recientes primero</option>
              <option value="date_asc">Más antiguos primero</option>
              {view === 'cash' && <option value="amount_desc">Importe mayor primero</option>}
              {view === 'cash' && <option value="amount_asc">Importe menor primero</option>}
            </select>
          </div>
          {view === 'cash' && (
            <>
              <div className="min-w-0">
                <label htmlFor={`${uid}-fl`} className={LABEL}>Sentido</label>
                <select id={`${uid}-fl`} className={cn(FIELD, 'pr-8')} value={filters.flow} onChange={(e) => set({ flow: e.target.value as Filters['flow'] })} data-testid="consultas-flow">
                  <option value="">Entradas, salidas e internos</option>
                  <option value="in">Solo entradas</option>
                  <option value="out">Solo salidas</option>
                  <option value="internal">Solo traspasos internos</option>
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor={`${uid}-st`} className={LABEL}>Estado</label>
                <select id={`${uid}-st`} className={cn(FIELD, 'pr-8')} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
                  <option value="">Todos</option>
                  <option value="aplicada">Aplicados</option>
                  <option value="anulada">Anulados</option>
                  <option value="anulacion">Anulaciones</option>
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor={`${uid}-mn`} className={LABEL}>Importe desde</label>
                <input id={`${uid}-mn`} inputMode="decimal" className={FIELD} value={filters.minAmount} onChange={(e) => set({ minAmount: e.target.value.replace(/[^\d.,]/g, '') })} />
              </div>
              <div className="min-w-0">
                <label htmlFor={`${uid}-mx`} className={LABEL}>Importe hasta</label>
                <input id={`${uid}-mx`} inputMode="decimal" className={FIELD} value={filters.maxAmount} onChange={(e) => set({ maxAmount: e.target.value.replace(/[^\d.,]/g, '') })} />
              </div>
            </>
          )}
        </div>
        {filters.clientId && (
          <p className="mt-3 text-sm text-gray-600">Solo un cliente seleccionado desde el detalle.{' '}
            <button type="button" className="text-primary-700 underline underline-offset-2" onClick={() => set({ clientId: '' })}>Quitar</button></p>
        )}
      </div>
    </section>
  );
}

export function DayHeading({ children, colSpan }: { children: ReactNode; colSpan?: number }) {
  return colSpan
    ? <tr className="bg-gray-50/80"><th scope="colgroup" colSpan={colSpan} className="px-4 py-1.5 text-left text-xs font-semibold text-gray-500 first-letter:uppercase">{children}</th></tr>
    : <h3 className="sticky top-0 z-[1] bg-gray-50/95 backdrop-blur px-1 py-1.5 text-xs font-semibold text-gray-500 first-letter:uppercase">{children}</h3>;
}

/** Flechas ↑/↓ entre las filas (botones con `data-row`) de una lista: navegación por teclado. */
export function rowKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const all = [...(e.currentTarget.querySelectorAll<HTMLElement>('[data-row]'))].filter((x) => x.offsetParent !== null);
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

function CopyId({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ml-1 inline-flex items-center rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      aria-label={done ? 'Copiado' : 'Copiar identificador'}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1500); }, () => undefined); }}>
      {done ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] sm:grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1.5 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="min-w-0 text-gray-900 break-words">{children}</dd>
    </div>
  );
}

/**
 * DETALLE de un movimiento: panel lateral (pantalla completa en móvil) con foco atrapado, Escape para
 * cerrar y retorno del foco a la fila. Aquí, y solo aquí, se ven identificadores completos, patas
 * contables, comprobante y vínculos.
 */
export function DetailDrawer({ id, timezone, currency, perspectiveLabel, flowHint, onClose, onOpen, onFilter }: {
  id: string; timezone: string; currency?: string; perspectiveLabel: string;
  flowHint?: { inMinor: number; outMinor: number; internalMinor: number } | null;
  onClose: () => void; onOpen: (id: string) => void; onFilter: (p: Partial<Filters>) => void;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    opener.current ??= document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
      if (opener.current && document.contains(opener.current)) opener.current.focus();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    serverView<Detail>(`/v1/movements/detail?id=${encodeURIComponent(id)}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar el detalle'); });
    window.setTimeout(() => panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 0);
    return () => { alive = false; };
  }, [id]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const m = data?.movement;
  const receipt = m && m.money ? receiptPath(m) : null;
  const legSum = data?.legs.reduce((a, l) => a + l.amountMinor, 0) ?? 0;
  return (
    <div className="fixed inset-0 z-[70] flex justify-end" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-gray-900/30" aria-hidden="true" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="movement-detail"
        className="relative flex h-full w-full sm:max-w-xl flex-col bg-white shadow-modal motion-safe:animate-[slideIn_180ms_cubic-bezier(0.16,1,0.3,1)]">
        <style>{'@keyframes slideIn{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}'}</style>
        <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 sm:px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900">{m ? kindLabel(m.kind, m.reversesKind) : 'Detalle del movimiento'}</h2>
            {m && <p className="mt-0.5 text-sm text-gray-500">{STATUS_LABEL[m.status] ?? m.status}{m.money ? '' : ' · sin efectivo'}</p>}
          </div>
          <button type="button" data-autofocus onClick={onClose} aria-label="Cerrar detalle"
            className="-mr-1 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-6">
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {!m && !error && <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Cargando detalle…</p>}
          {m && (
            <>
              {m.amountMinor !== null && (
                <div>
                  <p className="text-2xl font-semibold tabular-nums text-gray-900">{money(m.amountMinor, currency)}</p>
                  {flowHint && (
                    <p className="mt-1 text-sm text-gray-600">
                      {flowHint.inMinor > 0 && <>Entrada de {money(flowHint.inMinor, currency)} en {perspectiveLabel}. </>}
                      {flowHint.outMinor > 0 && <>Salida de {money(flowHint.outMinor, currency)} de {perspectiveLabel}. </>}
                      {flowHint.internalMinor > 0 && flowHint.inMinor === 0 && flowHint.outMinor === 0 && <>Traspaso interno de {perspectiveLabel}: no cambia su saldo.</>}
                    </p>
                  )}
                  {!m.money && <p className="mt-1 text-sm text-gray-600">Importe de referencia: este evento no movió efectivo.</p>}
                </div>
              )}
              {(m.from || m.to) && (
                <section aria-label="Origen y destino">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1 rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-xs text-gray-500">Desde</p>
                      <p className="text-sm font-medium text-gray-900 break-words">{partyLabel(m.from)}</p>
                      {m.from?.routeName && <p className="text-xs text-gray-500">{m.from.routeName}</p>}
                    </div>
                    <ArrowRight className="w-4 h-4 shrink-0 self-center text-gray-400 rotate-90 sm:rotate-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1 rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-xs text-gray-500">Hacia</p>
                      <p className="text-sm font-medium text-gray-900 break-words">{partyLabel(m.to)}</p>
                      {m.to?.routeName && <p className="text-xs text-gray-500">{m.to.routeName}</p>}
                    </div>
                  </div>
                </section>
              )}
              <section aria-labelledby={`${titleId}-q`}>
                <h3 id={`${titleId}-q`} className="text-sm font-semibold text-gray-900 mb-1">Cuándo y quién</h3>
                <dl className="divide-y divide-gray-50">
                  <Field label="Fecha y hora"><span className="first-letter:uppercase inline-block">{fullDateTime(m.at, timezone)}</span><span className="block text-xs text-gray-500">Hora de la empresa ({timezone})</span></Field>
                  <Field label="Día contable">{m.date}</Field>
                  <Field label="Registró">{m.actor ? `${person(m.actor)}${m.actorRole ? ` · ${ROLE_LABEL[m.actorRole] ?? m.actorRole}` : ''}` : '—'}</Field>
                  {m.route && <Field label="Ruta">{m.route.name ?? '—'}{m.toRoute ? ` → ${m.toRoute.name ?? ''}` : ''}</Field>}
                  {m.route && <Field label="Oficina">{m.route.office ?? 'Sin oficina'}</Field>}
                  {m.client && <Field label="Cliente">{formatClientName(m.client.name ?? '') || 'Cliente'}</Field>}
                  {m.worker && <Field label="Trabajador">{person(m.worker)}</Field>}
                  {m.concept && <Field label="Concepto">{m.concept}</Field>}
                </dl>
              </section>
              {data!.legs.length > 0 && (
                <section aria-labelledby={`${titleId}-l`}>
                  <h3 id={`${titleId}-l`} className="text-sm font-semibold text-gray-900 mb-1">Asientos contables</h3>
                  <table className="w-full text-sm">
                    <caption className="sr-only">Patas del asiento: cuenta, importe y saldo de la cuenta después</caption>
                    <thead><tr className="text-xs text-gray-500"><th scope="col" className="py-1 text-left font-medium">Cuenta</th><th scope="col" className="py-1 text-right font-medium">Importe</th><th scope="col" className="py-1 text-right font-medium hidden sm:table-cell">Saldo después</th></tr></thead>
                    <tbody className="divide-y divide-gray-50">
                      {data!.legs.map((l) => (
                        <tr key={l.leg}>
                          <td className="py-1.5 pr-2 min-w-0">
                            <span className="text-gray-900">{l.account.label}{l.account.name ? ` · ${person({ name: l.account.name })}` : ''}</span>
                            {l.account.routeName && <span className="block text-xs text-gray-500">{l.account.routeName}</span>}
                            {!l.cash && <span className="block text-xs text-gray-500">Cuenta contable (no es efectivo)</span>}
                          </td>
                          <td className={cn('py-1.5 text-right tabular-nums whitespace-nowrap', l.amountMinor < 0 ? 'text-gray-900' : 'text-emerald-700')}>
                            {l.amountMinor > 0 ? '+' : '−'}{money(Math.abs(l.amountMinor), currency)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-gray-500 whitespace-nowrap hidden sm:table-cell">{money(l.balanceAfterMinor, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1 text-xs text-gray-500">
                    {data!.legsComplete ? (legSum === 0 ? 'Asiento completo: las patas suman cero.' : 'Las patas visibles no suman cero.') : 'Solo se muestran las cuentas que su rol puede ver.'}
                  </p>
                </section>
              )}
              <section aria-labelledby={`${titleId}-r`}>
                <h3 id={`${titleId}-r`} className="text-sm font-semibold text-gray-900 mb-1">Referencias</h3>
                <dl className="divide-y divide-gray-50">
                  <Field label="Identificador"><span className="font-mono text-xs break-all">{m.id}</span><CopyId value={m.id} /></Field>
                  {m.reference && m.reference !== m.id && <Field label="Operación"><span className="font-mono text-xs break-all">{m.reference}</span></Field>}
                  {m.saleId && <Field label="Venta"><span className="font-mono text-xs break-all">{m.saleId}</span></Field>}
                  {m.paymentId && <Field label="Pago"><span className="font-mono text-xs break-all">{m.paymentId}</span></Field>}
                  {m.expenseId && <Field label="Gasto"><span className="font-mono text-xs break-all">{m.expenseId}</span></Field>}
                  {m.settlementId && <Field label="Cuadre"><span className="font-mono text-xs break-all">{m.settlementId}</span></Field>}
                </dl>
              </section>
              <section aria-label="Acciones" className="flex flex-wrap gap-2">
                {receipt && (
                  <Link to={receipt} target="_blank" rel="noopener" data-testid="detail-receipt"
                    className="inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                    <ExternalLink className="w-4 h-4" /> Ver comprobante
                  </Link>
                )}
                {m.reversesOperationId && <Button variant="secondary" onClick={() => onOpen(m.reversesOperationId!)}>Ver movimiento anulado</Button>}
                {m.reversedBy && <Button variant="secondary" onClick={() => onOpen(m.reversedBy!)}>Ver su anulación</Button>}
                {m.client && <Button variant="ghost" onClick={() => { onFilter({ clientId: m.client!.id }); onClose(); }}>Movimientos de este cliente</Button>}
                {m.worker && <Button variant="ghost" onClick={() => { onFilter({ personId: m.worker!.id }); onClose(); }}>Movimientos de {person(m.worker)}</Button>}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
