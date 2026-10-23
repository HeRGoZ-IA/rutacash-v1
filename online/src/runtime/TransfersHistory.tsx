// CONSULTAS · Transferencias (Ronda 59): entregas y devoluciones de trabajadores, traspasos entre
// trabajadores y transferencias entre Administradores, con filtros. Antes vivía en una ventana
// de Transferencias (Ronda 53); ahora es parte de Consultas, la única pantalla de historial.
// Se lee al mostrarse. Quien responde por el capital de la ruta (o el SuperAdmin) puede anular
// una entrega o devolución que no ocurrió (asiento espejo en el servidor, nunca se borra nada).

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { ReverseMovementModal } from '@/components/ui/MovementReversal';
import { db } from '@/lib/db';
import { useAuth } from '@/hooks/useAuth';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { filterAccessibleRoutes } from '@/lib/permissions';
import { listCustodyMovements } from '@/services/cashCustodyService';
import { reverseCapitalDelivery } from '@/services/centralCapitalService';
import { formatCurrency, formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import type { CashCustodyMovement, Route, User } from '@/models/types';
import { listAdminTransfers, STATE_LABEL, type AdminTransfer } from './adminTransfers.ts';

type MovementKind = 'entrega' | 'devolucion' | 'traspaso' | 'administradores';
interface MovementRow {
  key: string; kind: MovementKind; createdAt: string; amount: number; title: string; routeId?: string
  participants: string[]; estado: string; ref: string; detail: [string, string][]
  /** Operación del servidor que se puede anular desde aquí (entregas y devoluciones vigentes). */
  reversible?: { operationId: string; tipo: string }
}

const KIND_LABEL: Record<MovementKind, string> = {
  entrega: 'Entregas a trabajadores', devolucion: 'Devoluciones y entregas de efectivo', traspaso: 'Traspasos entre trabajadores', administradores: 'Entre Administradores',
};
const EMPTY = { kind: '', estado: '', desde: '', hasta: '', ruta: '', persona: '', q: '' };
const DECISION = (d: string) => (d === 'confirmed' ? 'Confirmó' : d === 'rejected' ? 'Rechazó' : d === 'not_required' ? 'Entrega directa' : 'Pendiente');

export function TransfersHistory() {
  const { tenantId, currency } = useTenant();
  const { user } = useAuth();
  const revision = useDataRevision();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [custody, setCustody] = useState<CashCustodyMovement[] | null>(null);
  const [transfers, setTransfers] = useState<AdminTransfer[]>([]);
  const [f, setF] = useState(EMPTY);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reversing, setReversing] = useState<MovementRow | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [rts, us] = await Promise.all([db.routes.where('tenantId').equals(tenantId).toArray(), db.users.where('tenantId').equals(tenantId).toArray()]);
      const scoped = filterAccessibleRoutes(user, rts);
      const [cs, ts] = await Promise.all([
        Promise.all(scoped.map((r) => listCustodyMovements(r.id).catch(() => [] as CashCustodyMovement[]))),
        listAdminTransfers().catch(() => [] as AdminTransfer[]),
      ]);
      if (!alive) return;
      setRoutes(scoped); setUsers(us); setCustody(cs.flat()); setTransfers(ts);
    })();
    return () => { alive = false; };
  }, [tenantId, user, revision]);

  const userName = (id?: string) => formatPersonName(users.find((u) => u.id === id)?.nombre);
  const routeLabel = (id?: string) => routes.find((r) => r.id === id)?.nombre ?? '—';
  // R74: solo el Administrador responsable de la ruta anula sus entregas y devoluciones; el SuperAdmin
  // ya no (no opera la caja de la ruta: la API y PostgreSQL también lo niegan).
  const canReverse = (routeId: string) => user?.rol !== 'superadmin' && routes.find((r) => r.id === routeId)?.capitalControllerAdminId === user?.id;

  const rows = useMemo<MovementRow[]>(() => {
    const out: MovementRow[] = [];
    for (const m of custody ?? []) {
      const kind: MovementKind = m.tipo === 'BASE_ASSIGNMENT' ? 'entrega' : m.tipo === 'BASE_RETURN' ? 'devolucion' : 'traspaso';
      const anulacion = !!m.reversesId;
      const own = kind === 'devolucion' && !!m.fromUserId && m.createdByUserId === m.fromUserId;
      const who = kind === 'entrega' ? userName(m.toUserId) : kind === 'devolucion' ? userName(m.fromUserId) : `${userName(m.fromUserId)} → ${userName(m.toUserId)}`;
      const opId = m.centralLink?.operationId;
      out.push({
        key: `c:${m.id}`, kind, createdAt: m.createdAt, amount: m.amount, routeId: m.routeId,
        title: `${anulacion ? 'Anulación · ' : ''}${kind === 'entrega' ? 'Entrega a' : kind === 'devolucion' ? (own ? 'Entrega de efectivo de' : 'Devolución de') : 'Traspaso'} ${who}`,
        participants: [m.toUserId, m.fromUserId, m.createdByUserId].filter(Boolean) as string[],
        estado: anulacion ? 'Anulación' : m.reversalId ? 'Anulada' : 'Vigente', ref: m.id.slice(0, 8).toUpperCase(),
        detail: [['Ruta', routeLabel(m.routeId)], ['Registró', userName(m.createdByUserId) || '—'], ['Concepto', m.motivo || '—'], ['Referencia', m.id.slice(0, 8).toUpperCase()]],
        reversible: !anulacion && !m.reversalId && opId && kind !== 'traspaso' && canReverse(m.routeId)
          ? { operationId: opId, tipo: kind === 'entrega' ? 'Entrega de capital a trabajador' : 'Entrega de efectivo al Administrador' } : undefined,
      });
    }
    for (const t of transfers) {
      out.push({
        key: `t:${t.id}`, kind: 'administradores', createdAt: t.createdAt, amount: t.amount,
        title: `${formatPersonName(t.origin.name) || 'Administrador'} → ${formatPersonName(t.destination.name) || 'Administrador'}`,
        participants: [t.origin.adminId, t.destination.adminId, t.registeredBy.membershipId], estado: STATE_LABEL[t.state], ref: t.id.slice(0, 8).toUpperCase(),
        detail: [['Concepto', t.reason], ['Modalidad', t.mode === 'secretary' ? `Registrada por ${formatPersonName(t.registeredBy.name) || 'Secretaría'}` : 'Directa'],
          ['Origen', `${DECISION(t.origin.decision)}${t.origin.reason ? ` · ${t.origin.reason}` : ''}`],
          ['Destino', `${DECISION(t.destination.decision)}${t.destination.reason ? ` · ${t.destination.reason}` : ''}`],
          ...(t.closeReason ? [['Motivo de cierre', t.closeReason] as [string, string]] : []), ['Referencia', t.id.slice(0, 8).toUpperCase()]],
      });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [custody, transfers, users, routes]);  // eslint-disable-line react-hooks/exhaustive-deps

  const q = f.q.trim().toLowerCase();
  const visible = rows.filter((r) => (!f.kind || r.kind === f.kind) && (!f.estado || r.estado === f.estado)
    && (!f.desde || r.createdAt.slice(0, 10) >= f.desde) && (!f.hasta || r.createdAt.slice(0, 10) <= f.hasta)
    && (!f.ruta || r.routeId === f.ruta) && (!f.persona || r.participants.includes(f.persona))
    && (!q || r.title.toLowerCase().includes(q) || r.ref.toLowerCase().includes(q) || r.detail.some(([, v]) => v.toLowerCase().includes(q))));
  const estados = [...new Set(rows.map((r) => r.estado))];
  const personas = users.filter((u) => rows.some((r) => r.participants.includes(u.id))).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const limpio = !Object.values(f).some(Boolean);

  async function reverse(reason: string) {
    if (!reversing?.reversible) return;
    await reverseCapitalDelivery({ actor: user, tenantId, operationId: reversing.reversible.operationId, reason });
    toast.success('Movimiento anulado');
    setReversing(null);
  }

  return (
    <div className="space-y-3" data-testid="transfers-history">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Select label="Tipo" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))} placeholder="Todos"
          options={(Object.keys(KIND_LABEL) as MovementKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        <Select label="Estado" value={f.estado} onChange={(e) => setF((x) => ({ ...x, estado: e.target.value }))} placeholder="Todos" options={estados.map((s) => ({ value: s, label: s }))} />
        <Input label="Desde" type="date" value={f.desde} onChange={(e) => setF((x) => ({ ...x, desde: e.target.value }))} />
        <Input label="Hasta" type="date" value={f.hasta} onChange={(e) => setF((x) => ({ ...x, hasta: e.target.value }))} />
        <Select label="Ruta" value={f.ruta} onChange={(e) => setF((x) => ({ ...x, ruta: e.target.value }))} placeholder="Todas" options={routes.map((r) => ({ value: r.id, label: r.nombre }))} />
        <Select label="Persona" value={f.persona} onChange={(e) => setF((x) => ({ ...x, persona: e.target.value }))} placeholder="Todas" options={personas.map((u) => ({ value: u.id, label: formatPersonName(u.nombre) }))} />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden />
          <input value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} placeholder="Referencia, nombre o concepto" aria-label="Buscar transferencias"
            className="h-10 w-full rounded-lg border border-gray-300 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
        {!limpio && <Button variant="ghost" size="sm" onClick={() => setF(EMPTY)}>Limpiar filtros</Button>}
        <p className="text-xs text-gray-500 sm:ml-auto">{custody == null ? 'Cargando…' : `${visible.length} de ${rows.length}`}</p>
      </div>
      {custody == null ? (
        <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : visible.length === 0 ? (
        <EmptyState icon={<ArrowLeftRight className="w-8 h-8" />} title={rows.length ? 'Ningún movimiento con estos filtros' : 'Sin transferencias'} />
      ) : (
        <ul className="bg-white divide-y divide-gray-100 border border-gray-100 rounded-2xl shadow-card">
          {visible.slice(0, 300).map((r) => (
            <li key={r.key}>
              <button type="button" onClick={() => setOpenKey((k) => (k === r.key ? null : r.key))} aria-expanded={openKey === r.key}
                className="w-full flex items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 break-words">{r.title}</span>
                  <span className="block text-xs text-gray-500">{KIND_LABEL[r.kind]} · {formatDateTime(r.createdAt)}{r.routeId ? ` · ${routeLabel(r.routeId)}` : ''} · {r.estado}</span>
                </span>
                <span className="flex items-center gap-1 flex-shrink-0">
                  <span className={`text-sm font-bold ${r.estado === 'Anulada' || r.estado === 'Cancelada' || r.estado === 'Rechazada' ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{formatCurrency(r.amount, currency)}</span>
                  <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${openKey === r.key ? 'rotate-180' : ''}`} aria-hidden />
                </span>
              </button>
              {openKey === r.key && (
                <div className="px-3 pb-3 space-y-2">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {r.detail.map(([k, v]) => <div key={k} className="min-w-0"><dt className="inline text-gray-500">{k}: </dt><dd className="inline text-gray-800 break-words">{v}</dd></div>)}
                  </dl>
                  {r.reversible && <Button size="sm" variant="secondary" onClick={() => setReversing(r)} data-testid="reverse-movement">Anular</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {visible.length > 300 && <p className="text-xs text-gray-500">Se muestran los 300 más recientes. Usa los filtros.</p>}
      <ReverseMovementModal currency={currency} onCancel={() => setReversing(null)} onConfirm={reverse}
        target={reversing?.reversible ? { tipo: reversing.reversible.tipo, valor: reversing.amount, fecha: reversing.createdAt.slice(0, 10), detalle: [routeLabel(reversing.routeId), reversing.title].join(' · ') } : null} />
    </div>
  );
}
