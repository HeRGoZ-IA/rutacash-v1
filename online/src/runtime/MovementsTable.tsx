// CONSULTAS · TABLA DE MOVIMIENTOS (Ronda 73 · SOC-08). Pedido del propietario: una TABLA de varias
// columnas con los filtros EN LOS ENCABEZADOS (como una tabla dinámica de Excel), orden por columnas,
// rango de fechas, columnas visibles, detalle expandible y exportación.
//
//   · Fuente: `GET /v1/movements` (servidor): UNA fila por operación lógica. La entrega de la bolsa al
//     trabajador es una sola fila; sus dos patas (origen y destino) se ven al abrir el detalle
//     (`GET /v1/capital/operations/:id`). Dos operaciones con igual importe y fecha siguen siendo dos.
//   · Filtros y orden se resuelven en el servidor (RLS por empresa, rol y rutas) y la lista llega por
//     páginas: nunca se descarga todo el historial. Origen y Destino se derivan del tipo y de las
//     personas de la operación; su filtro de texto actúa sobre las filas ya cargadas (se indica).
//   · Eventos sin dinero (solicitudes, autorizaciones, cuadres, cierres) llevan la marca «Sin dinero».

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Columns3, Download, Filter, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { db } from '@/lib/db';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatCurrency } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { serverView } from './projection.ts';
import { toMajor, toMinor } from './mappers.ts';

interface Movement {
  id: string; money: boolean; kind: string; reversesKind: string | null; at: string; date: string; routeId: string | null; toRouteId: string | null;
  workerId: string | null; counterpartId: string | null; adminId: string | null; clientId: string | null; amountMinor: number | null; concept: string;
  status: string; reference: string | null; actorId: string | null; saleId: string | null; paymentId: string | null; expenseId: string | null; settlementId: string | null;
}
interface Leg { leg: number; account: { kind: string; membershipId: string | null; routeId: string | null }; amountMinor: number }

const KIND_LABEL: Record<string, string> = {
  COMPANY_DEPOSIT: 'Depósito de capital', COMPANY_WITHDRAWAL: 'Retiro de capital', ADMIN_ALLOCATION: 'Asignación a bolsa',
  ADMIN_RETURN: 'Devolución a la empresa', PARTNER_CONTRIBUTION: 'Aporte de socio (histórico)', WORKER_DELIVERY: 'Entrega a trabajador',
  WORKER_RETURN: 'Devolución del trabajador', WORKER_TRANSFER: 'Traspaso entre trabajadores', ROUTE_REASSIGNMENT: 'Traspaso entre rutas',
  REVERSAL: 'Anulación', LOAN_DISBURSEMENT: 'Desembolso', COLLECTION: 'Recaudo', WORKER_EXPENSE: 'Gasto del trabajador',
  ROUTE_EXPENSE: 'Gasto de ruta', COMPANY_EXPENSE: 'Gasto de empresa', EXPENSE_REFUND: 'Reintegro de gasto',
  SETTLEMENT_RETURN: 'Entrega por cuadre', SETTLEMENT_SURPLUS: 'Sobrante de cuadre', ADMIN_TRANSFER_HOLD: 'Traspaso entre Administradores (reserva)',
  ADMIN_TRANSFER_APPLY: 'Traspaso entre Administradores', ADMIN_TRANSFER_RELEASE: 'Traspaso entre Administradores (liberado)',
  DISBURSEMENT_ADJUSTMENT: 'Corrección de desembolso', SALE_REQUEST: 'Solicitud de venta', SALE_APPROVAL: 'Autorización de venta',
  SALE_REJECTION: 'Rechazo de solicitud', SALE_CANCELLATION: 'Cancelación de venta aprobada', CUSTODY_SETTLEMENT: 'Cuadre',
  PERIOD_CLOSURE: 'Cierre de periodo', CREDIT_RECTIFICATION: 'Corrección de venta (sin dinero)',
};
const STATUS_LABEL: Record<string, string> = {
  aplicada: 'Aplicada', anulada: 'Anulada', anulacion: 'Anulación', pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada',
  disbursed: 'Desembolsada', cancelled: 'Cancelada', cerrada: 'Cerrado', reabierta: 'Reabierto', cerrado: 'Cerrado',
};
const ACCOUNT_LABEL: Record<string, string> = {
  company: 'Empresa', admin: 'Bolsa', custody: 'Custodia', portfolio: 'Cartera de la ruta', external: 'Externo', income: 'Intereses',
  expense: 'Gastos', suspense: 'Sobrante en control', unidentified: 'Sin identificar', transit: 'En tránsito', partner: 'Socio (histórico)',
};

type ColKey = 'fecha' | 'hora' | 'ruta' | 'trabajador' | 'cliente' | 'tipo' | 'concepto' | 'origen' | 'destino' | 'importe' | 'estado' | 'referencia' | 'usuario';
const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'fecha', label: 'Fecha' }, { key: 'hora', label: 'Hora' }, { key: 'ruta', label: 'Ruta' }, { key: 'trabajador', label: 'Trabajador' },
  { key: 'cliente', label: 'Cliente' }, { key: 'tipo', label: 'Tipo' }, { key: 'concepto', label: 'Concepto' }, { key: 'origen', label: 'Origen' },
  { key: 'destino', label: 'Destino' }, { key: 'importe', label: 'Importe' }, { key: 'estado', label: 'Estado' }, { key: 'referencia', label: 'Referencia' },
  { key: 'usuario', label: 'Registró' },
];
const PAGE = 100;

interface Filters {
  from?: string; to?: string; routeId: string[]; kind: string[]; workerId: string[]; clientId: string[]; actorId: string[]; status: string[];
  adminId: string[]; money: '' | 'yes' | 'no'; q?: string; minAmount?: string; maxAmount?: string; origen?: string; destino?: string;
}
type Sort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

/** Columnas visibles: preferencia de la pantalla (ADEX Online no guarda nada en el dispositivo, SEC5-003). */
function readCols(): Set<ColKey> {
  return new Set(COLUMNS.map((c) => c.key));
}

function queryOf(f: Filters, sort: Sort, offset: number, limit = PAGE): string {
  const q = new URLSearchParams({ sort, limit: String(limit), offset: String(offset) });
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  for (const k of ['routeId', 'kind', 'workerId', 'clientId', 'actorId', 'status', 'adminId'] as const) if (f[k].length) q.set(k, f[k].join(','));
  if (f.money) q.set('money', f.money);
  if (f.q?.trim()) q.set('q', f.q.trim());
  if (f.minAmount) q.set('minAmount', String(toMinor(Number(f.minAmount))));
  if (f.maxAmount) q.set('maxAmount', String(toMinor(Number(f.maxAmount))));
  return q.toString();
}

/** Encabezado con su filtro desplegable (estilo tabla dinámica). */
function HeaderFilter({ label, active, children, onSort, sortState, align }: {
  label: string; active: boolean; children?: ReactNode; onSort?: () => void; sortState?: 'asc' | 'desc' | null; align?: 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} className={cn('relative flex items-center gap-1', align === 'right' && 'justify-end')}>
      {onSort ? (
        <button type="button" onClick={onSort} className="font-semibold text-gray-700 hover:text-primary-700 whitespace-nowrap">
          {label}{sortState === 'desc' ? ' ↓' : sortState === 'asc' ? ' ↑' : ''}
        </button>
      ) : <span className="font-semibold text-gray-700 whitespace-nowrap">{label}</span>}
      {children && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`Filtrar ${label}`} aria-expanded={open}
          className={cn('p-1 rounded hover:bg-gray-200', active ? 'text-primary-700 bg-primary-50' : 'text-gray-400')}>
          <Filter className="w-3.5 h-3.5" />
        </button>
      )}
      {open && children && (
        <div className={cn('absolute top-full mt-1 z-30 w-64 max-w-[80vw] rounded-xl border border-gray-200 bg-white shadow-lg p-3 text-sm font-normal normal-case',
          align === 'right' ? 'right-0' : 'left-0')}>
          {children}
        </div>
      )}
    </div>
  );
}

function CheckList({ options, selected, onChange }: { options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const [term, setTerm] = useState('');
  const shown = options.filter((o) => o.label.toLowerCase().includes(term.toLowerCase())).slice(0, 200);
  return (
    <div className="space-y-2">
      {options.length > 8 && (
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar…" aria-label="Buscar opción"
          className="w-full h-9 rounded-lg border border-gray-300 px-2 text-sm" />
      )}
      <div className="max-h-56 overflow-y-auto space-y-1">
        {shown.map((o) => (
          <label key={o.value} className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-primary-600" checked={selected.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))} />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="text-xs text-gray-500">Sin opciones</p>}
      </div>
      {selected.length > 0 && <button type="button" className="text-xs text-primary-700 hover:underline" onClick={() => onChange([])}>Quitar filtro</button>}
    </div>
  );
}

export function MovementsTable() {
  const { tenantId, currency } = useTenant();
  const revision = useDataRevision();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => ({
    routeId: params.getAll('routeId'), kind: [], workerId: params.getAll('workerId'), clientId: [], actorId: [], status: [],
    adminId: params.getAll('adminId'), money: params.get('categoria') === 'capital' ? 'yes' : '', q: params.get('referencia') ?? undefined,
    from: params.get('desde') ?? undefined, to: params.get('hasta') ?? undefined,
  }));
  const [sort, setSort] = useState<Sort>('date_desc');
  const [rows, setRows] = useState<Movement[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState<Set<ColKey>>(readCols);
  const [colsOpen, setColsOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [legs, setLegs] = useState<Record<string, Leg[] | 'loading' | 'error'>>({});
  const [exporting, setExporting] = useState(false);
  const [names, setNames] = useState<{ routes: Map<string, string>; people: Map<string, string>; clients: Map<string, string> }>(
    { routes: new Map(), people: new Map(), clients: new Map() });

  useEffect(() => {
    let alive = true;
    void Promise.all([
      db.routes.where('tenantId').equals(tenantId).toArray(), db.users.where('tenantId').equals(tenantId).toArray(),
      db.clients.where('tenantId').equals(tenantId).toArray(),
    ]).then(([rs, us, cs]) => {
      if (!alive) return;
      setNames({ routes: new Map(rs.map((r) => [r.id, r.nombre])), people: new Map(us.map((u) => [u.id, u.nombre])), clients: new Map(cs.map((c) => [c.id, c.nombre])) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [tenantId, revision]);

  // Primera página con los filtros y el orden vigentes (se relee tras cada escritura).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    serverView<{ movements: Movement[]; hasMore: boolean }>(`/v1/movements?${queryOf(filters, sort, 0)}`)
      .then((r) => { if (alive) { setRows(r.movements); setHasMore(r.hasMore); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filters, sort, revision]);

  async function more() {
    setLoading(true);
    try {
      const r = await serverView<{ movements: Movement[]; hasMore: boolean }>(`/v1/movements?${queryOf(filters, sort, rows.length)}`);
      setRows((prev) => [...prev, ...r.movements]);
      setHasMore(r.hasMore);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar'); } finally { setLoading(false); }
  }

  const person = (id: string | null) => (id ? names.people.get(id) ?? 'Usuario' : '');
  const route = (id: string | null) => (id ? names.routes.get(id) ?? 'Ruta' : '');
  const clientName = (id: string | null) => (id ? names.clients.get(id) ?? 'Cliente' : '');
  const pool = (m: Movement) => `Bolsa ${person(m.adminId)}`.trim();
  const custody = (id: string | null) => `Custodia ${person(id)}`.trim();

  /** Origen y destino legibles según el tipo (el detalle muestra las patas exactas del libro). */
  function flow(m: Movement): [string, string] {
    const k = m.kind === 'REVERSAL' ? m.reversesKind ?? '' : m.kind;
    const payer = m.workerId ? custody(m.workerId) : pool(m);
    let f: [string, string];
    switch (k) {
      case 'COMPANY_DEPOSIT': f = ['Externo', 'Empresa']; break;
      case 'COMPANY_WITHDRAWAL': f = ['Empresa', 'Externo']; break;
      case 'ADMIN_ALLOCATION': f = ['Empresa', pool(m)]; break;
      case 'ADMIN_RETURN': f = [pool(m), 'Empresa']; break;
      case 'WORKER_DELIVERY': f = [pool(m), custody(m.workerId)]; break;
      case 'WORKER_RETURN': case 'SETTLEMENT_RETURN': f = [custody(m.workerId), pool(m)]; break;
      case 'WORKER_TRANSFER': f = [custody(m.workerId), custody(m.counterpartId)]; break;
      case 'ROUTE_REASSIGNMENT': f = [`${custody(m.workerId)} · ${route(m.routeId)}`, `${custody(m.counterpartId)} · ${route(m.toRouteId)}`]; break;
      case 'LOAN_DISBURSEMENT': f = [payer, clientName(m.clientId) || 'Cliente']; break;
      case 'COLLECTION': f = [clientName(m.clientId) || 'Cliente', payer]; break;
      case 'WORKER_EXPENSE': f = [custody(m.workerId), 'Gasto']; break;
      case 'ROUTE_EXPENSE': f = [pool(m), 'Gasto']; break;
      case 'COMPANY_EXPENSE': f = ['Empresa', 'Gasto']; break;
      case 'EXPENSE_REFUND': f = ['Gasto', m.workerId ? custody(m.workerId) : m.adminId ? pool(m) : 'Empresa']; break;
      case 'SETTLEMENT_SURPLUS': f = [custody(m.workerId), 'Sobrante en control']; break;
      case 'ADMIN_TRANSFER_HOLD': case 'ADMIN_TRANSFER_APPLY': case 'ADMIN_TRANSFER_RELEASE': f = [pool(m), `Bolsa ${person(m.counterpartId)}`]; break;
      case 'DISBURSEMENT_ADJUSTMENT': f = [payer, 'Cartera (ver detalle)']; break;
      default: return ['—', '—'];
    }
    return m.kind === 'REVERSAL' ? [f[1], f[0]] : f;
  }

  const flowMatches = (m: Movement) => {
    if (!filters.origen && !filters.destino) return true;
    const [o, d] = flow(m);
    return (!filters.origen || o.toLowerCase().includes(filters.origen.toLowerCase())) && (!filters.destino || d.toLowerCase().includes(filters.destino.toLowerCase()));
  };
  const shown = useMemo(() => rows.filter(flowMatches), [rows, filters.origen, filters.destino, names]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggleCol = (k: ColKey) => setCols((prev) => {
    const next = new Set(prev);
    if (next.has(k)) { if (next.size > 1) next.delete(k); } else next.add(k);
    return next;
  });
  const anyFilter = Boolean(filters.from || filters.to || filters.money || filters.q || filters.minAmount || filters.maxAmount || filters.origen || filters.destino)
    || (['routeId', 'kind', 'workerId', 'clientId', 'actorId', 'status', 'adminId'] as const).some((k) => filters[k].length > 0);

  async function toggleDetail(m: Movement) {
    if (open === m.id) { setOpen(null); return; }
    setOpen(m.id);
    if (m.money && !legs[m.id]) {
      setLegs((l) => ({ ...l, [m.id]: 'loading' }));
      try {
        const r = await serverView<{ entries: Leg[] }>(`/v1/capital/operations/${encodeURIComponent(m.id)}`);
        setLegs((l) => ({ ...l, [m.id]: r.entries }));
      } catch { setLegs((l) => ({ ...l, [m.id]: 'error' })); }
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all: Movement[] = [];
      for (let offset = 0; offset < 5000; offset += 200) {
        const r = await serverView<{ movements: Movement[]; hasMore: boolean }>(`/v1/movements?${queryOf(filters, sort, offset, 200)}`);
        all.push(...r.movements);
        if (!r.hasMore) break;
      }
      const visible = COLUMNS.filter((c) => cols.has(c.key));
      const cell = (m: Movement, k: ColKey) => String(value(m, k)).replace(/"/g, '""');
      const lines = [visible.map((c) => `"${c.label}"`).join(';'), ...all.filter(flowMatches).map((m) => visible.map((c) => `"${cell(m, c.key)}"`).join(';'))];
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `consultas-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally { setExporting(false); }
  }

  function value(m: Movement, k: ColKey): string {
    const [o, d] = flow(m);
    switch (k) {
      case 'fecha': return m.date;
      case 'hora': return new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      case 'ruta': return route(m.routeId);
      case 'trabajador': return person(m.workerId);
      case 'cliente': return clientName(m.clientId);
      case 'tipo': return `${KIND_LABEL[m.kind] ?? m.kind}${m.kind === 'REVERSAL' && m.reversesKind ? ` de ${(KIND_LABEL[m.reversesKind] ?? m.reversesKind).toLowerCase()}` : ''}`;
      case 'concepto': return m.concept;
      case 'origen': return o;
      case 'destino': return d;
      case 'importe': return m.amountMinor === null ? '' : String(toMajor(m.amountMinor)).replace('.', ',');
      case 'estado': return STATUS_LABEL[m.status] ?? m.status;
      case 'referencia': return m.reference ?? '';
      case 'usuario': return person(m.actorId);
    }
  }

  const routeOptions = [...names.routes].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const peopleOptions = [...names.people].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const clientOptions = [...names.clients].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const kindOptions = Object.entries(KIND_LABEL).filter(([k]) => k !== 'PARTNER_CONTRIBUTION').map(([value, label]) => ({ value, label }));
  const statusOptions = ['aplicada', 'anulada', 'anulacion', 'pending', 'approved', 'rejected', 'disbursed', 'cancelled', 'cerrada', 'reabierta']
    .map((value) => ({ value, label: STATUS_LABEL[value]! }));
  const dateSort = sort === 'date_desc' ? 'desc' : sort === 'date_asc' ? 'asc' : null;
  const amountSort = sort === 'amount_desc' ? 'desc' : sort === 'amount_asc' ? 'asc' : null;
  const textInput = (val: string | undefined, onChange: (v: string) => void, label: string, type = 'text') => (
    <input type={type} value={val ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={label}
      className="w-full h-9 rounded-lg border border-gray-300 px-2 text-sm" />
  );

  const header: Record<ColKey, ReactNode> = {
    fecha: (
      <HeaderFilter label="Fecha" active={Boolean(filters.from || filters.to)} sortState={dateSort}
        onSort={() => setSort(sort === 'date_desc' ? 'date_asc' : 'date_desc')}>
        <div className="space-y-2">
          <label className="block text-xs text-gray-500">Desde{textInput(filters.from, (v) => set({ from: v || undefined }), 'Desde', 'date')}</label>
          <label className="block text-xs text-gray-500">Hasta{textInput(filters.to, (v) => set({ to: v || undefined }), 'Hasta', 'date')}</label>
        </div>
      </HeaderFilter>
    ),
    hora: <HeaderFilter label="Hora" active={false} />,
    ruta: <HeaderFilter label="Ruta" active={filters.routeId.length > 0}><CheckList options={routeOptions} selected={filters.routeId} onChange={(v) => set({ routeId: v })} /></HeaderFilter>,
    trabajador: <HeaderFilter label="Trabajador" active={filters.workerId.length > 0}><CheckList options={peopleOptions} selected={filters.workerId} onChange={(v) => set({ workerId: v })} /></HeaderFilter>,
    cliente: <HeaderFilter label="Cliente" active={filters.clientId.length > 0}><CheckList options={clientOptions} selected={filters.clientId} onChange={(v) => set({ clientId: v })} /></HeaderFilter>,
    tipo: (
      <HeaderFilter label="Tipo" active={filters.kind.length > 0 || Boolean(filters.money)}>
        <div className="space-y-2">
          <div className="flex gap-1" role="group" aria-label="Movimiento de dinero">
            {([['', 'Todos'], ['yes', 'Con dinero'], ['no', 'Sin dinero']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => set({ money: v })} aria-pressed={filters.money === v}
                className={cn('flex-1 h-8 rounded-lg text-xs border', filters.money === v ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-300 text-gray-600')}>{l}</button>
            ))}
          </div>
          <CheckList options={kindOptions} selected={filters.kind} onChange={(v) => set({ kind: v })} />
        </div>
      </HeaderFilter>
    ),
    concepto: <HeaderFilter label="Concepto" active={Boolean(filters.q)}>{textInput(filters.q, (v) => set({ q: v || undefined }), 'Contiene…')}</HeaderFilter>,
    origen: (
      <HeaderFilter label="Origen" active={Boolean(filters.origen)}>
        {textInput(filters.origen, (v) => set({ origen: v || undefined }), 'Contiene…')}
        <p className="mt-1 text-xs text-gray-500">Filtra las filas ya cargadas.</p>
      </HeaderFilter>
    ),
    destino: (
      <HeaderFilter label="Destino" active={Boolean(filters.destino)}>
        {textInput(filters.destino, (v) => set({ destino: v || undefined }), 'Contiene…')}
        <p className="mt-1 text-xs text-gray-500">Filtra las filas ya cargadas.</p>
      </HeaderFilter>
    ),
    importe: (
      <HeaderFilter label="Importe" align="right" active={Boolean(filters.minAmount || filters.maxAmount)} sortState={amountSort}
        onSort={() => setSort(sort === 'amount_desc' ? 'amount_asc' : 'amount_desc')}>
        <div className="space-y-2">
          {textInput(filters.minAmount, (v) => set({ minAmount: v || undefined }), 'Mínimo', 'number')}
          {textInput(filters.maxAmount, (v) => set({ maxAmount: v || undefined }), 'Máximo', 'number')}
        </div>
      </HeaderFilter>
    ),
    estado: <HeaderFilter label="Estado" active={filters.status.length > 0}><CheckList options={statusOptions} selected={filters.status} onChange={(v) => set({ status: v })} /></HeaderFilter>,
    referencia: <HeaderFilter label="Referencia" active={Boolean(filters.q)}>{textInput(filters.q, (v) => set({ q: v || undefined }), 'Contiene…')}</HeaderFilter>,
    usuario: <HeaderFilter label="Registró" active={filters.actorId.length > 0}><CheckList options={peopleOptions} selected={filters.actorId} onChange={(v) => set({ actorId: v })} /></HeaderFilter>,
  };

  const visible = COLUMNS.filter((c) => cols.has(c.key));
  return (
    <div className="space-y-3" data-testid="movements-table">
      <div className="flex flex-wrap items-center gap-2">
        {anyFilter && (
          <Button variant="secondary" size="sm" icon={<X className="w-4 h-4" />}
            onClick={() => setFilters({ routeId: [], kind: [], workerId: [], clientId: [], actorId: [], status: [], adminId: [], money: '' })}>Quitar filtros</Button>
        )}
        <div className="relative">
          <Button variant="secondary" size="sm" icon={<Columns3 className="w-4 h-4" />} onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen}>Columnas</Button>
          {colsOpen && (
            <div className="absolute z-30 mt-1 w-56 rounded-xl border border-gray-200 bg-white shadow-lg p-3 space-y-1 text-sm">
              {COLUMNS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-primary-600" checked={cols.has(c.key)} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} onClick={exportCsv} loading={exporting}>Exportar CSV</Button>
        <span className="text-xs text-gray-500 ml-auto">{shown.length} fila(s){hasMore ? ' · hay más' : ''}</span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-card">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide">
            <tr>
              <th className="w-8 px-2 py-2" aria-label="Detalle" />
              {visible.map((c) => <th key={c.key} className={cn('px-3 py-2 text-left align-top', c.key === 'importe' && 'text-right')}>{header[c.key]}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {shown.map((m) => {
              const isOpen = open === m.id;
              const detail = legs[m.id];
              return [
                <tr key={m.id} className={cn('hover:bg-primary-50/40 cursor-pointer', !m.money && 'text-gray-600')} onClick={() => toggleDetail(m)}>
                  <td className="px-2 py-2 text-gray-400">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                  {visible.map((c) => (
                    <td key={c.key} className={cn('px-3 py-2 whitespace-nowrap', c.key === 'concepto' && 'whitespace-normal min-w-[12rem] max-w-xs',
                      c.key === 'importe' && 'text-right font-semibold tabular-nums')}>
                      {c.key === 'importe'
                        ? (m.amountMinor === null ? '—' : formatCurrency(toMajor(m.amountMinor), currency))
                        : c.key === 'tipo'
                          ? <span className="inline-flex items-center gap-1.5">{value(m, 'tipo')}{!m.money && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">Sin dinero</span>}</span>
                          : value(m, c.key) || '—'}
                    </td>
                  ))}
                </tr>,
                isOpen && (
                  <tr key={`${m.id}:detalle`} className="bg-gray-50/60">
                    <td />
                    <td colSpan={visible.length} className="px-3 py-3 text-xs text-gray-700 space-y-2">
                      <p><span className="text-gray-500">Referencia:</span> {m.reference ?? '—'} · <span className="text-gray-500">Registró:</span> {person(m.actorId) || '—'} · {new Date(m.at).toLocaleString()}</p>
                      {m.money ? (
                        detail === 'loading' ? <p className="flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando efectos contables…</p>
                          : detail === 'error' || !detail ? <p>No se pudieron cargar los efectos contables (o no son visibles para su rol).</p>
                            : (
                              <div>
                                <p className="font-semibold text-gray-600 mb-1">Efectos contables ({detail.length} patas, Σ = 0)</p>
                                <ul className="space-y-0.5">
                                  {detail.map((l) => (
                                    <li key={l.leg} className="flex justify-between gap-4 max-w-md">
                                      <span>{ACCOUNT_LABEL[l.account.kind] ?? l.account.kind}{l.account.membershipId ? ` · ${person(l.account.membershipId)}` : ''}{l.account.routeId ? ` · ${route(l.account.routeId)}` : ''}</span>
                                      <span className={cn('tabular-nums', l.amountMinor < 0 ? 'text-red-600' : 'text-emerald-700')}>{formatCurrency(toMajor(l.amountMinor), currency)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )
                      ) : <p>Evento sin movimiento de dinero.</p>}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <div className="p-6"><EmptyState title="Sin movimientos" description={anyFilter ? 'Ningún registro cumple los filtros.' : 'Todavía no hay movimientos.'} /></div>}
      </div>
      {loading && <p className="text-sm text-gray-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Cargando…</p>}
      {hasMore && !loading && <div className="flex justify-center"><Button variant="secondary" onClick={more}>Cargar más</Button></div>}
    </div>
  );
}
