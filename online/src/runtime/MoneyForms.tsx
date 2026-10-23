// Formularios de DINERO de la Ronda 59, con los componentes y el estilo de CLEAN:
//   · RequestModal          pedir capital (no mueve dinero)
//   · ReturnToCompanyModal  el Administrador devuelve capital de SU bolsa al SuperAdmin
//   · DeliverCashModal      el Cobrador entrega SU efectivo al responsable de la ruta
//   · RejectRequestModal    rechazar o cancelar una solicitud, con motivo
// Un id de operación por formulario abierto: un doble clic o un reintento no duplican. Las reglas
// las aplica el servidor; aquí solo se ofrece lo que el rol activo puede hacer y se dice por qué no.

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { db } from '@/lib/db';
import { formatCurrency } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { generateId } from '@/lib/utils';
import type { Route, User } from '@/models/types';
import { adminDirectory, type AdminOption } from './adminTransfers.ts';
import {
  CONCEPT_LABEL, closeRequest, createRequest, deliverOwnCash, returnToCompany, type CapitalRequest, type RequestKind,
} from './capitalRequests.ts';
import { custodyPositions, type CustodyPosition } from './projection.ts';
import { toMajor } from './mappers.ts';
import { useRuntime } from './session.ts';

/** Solicitudes que puede crear cada rol (el servidor lo revalida). */
export const REQUEST_OPTIONS: Record<'superadmin' | 'admin', { kind: RequestKind; label: string }[]> = {
  superadmin: [{ kind: 'admin_return', label: 'Pedir devolución a un Administrador' }],
  admin: [
    { kind: 'admin_allocation', label: 'Pedir capital al SuperAdmin' },
    { kind: 'admin_transfer', label: 'Pedir capital a otro Administrador' },
    { kind: 'worker_return', label: 'Pedir entrega de efectivo a un Cobrador' },
  ],
};

function useCompanyPeople() {
  const tenantId = useRuntime((s) => s.ctx?.company.id ?? '');
  const [users, setUsers] = useState<User[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([db.users.where('tenantId').equals(tenantId).toArray(), db.routes.where('tenantId').equals(tenantId).toArray()])
      .then(([u, r]) => { if (alive) { setUsers(u); setRoutes(r); } }).catch(() => { /* la pantalla lo reintentará */ });
    return () => { alive = false; };
  }, [tenantId]);
  return { users, routes };
}

// ============================================================
// Pedir capital
// ============================================================
export function RequestModal({ open, onClose, onDone, currency, initialKind }: {
  open: boolean; onClose: () => void; onDone: () => void; currency: string; initialKind?: RequestKind;
}) {
  const me = useRuntime((s) => s.ctx);
  const role = me?.role === 'superadmin' ? 'superadmin' : 'admin';
  const options = REQUEST_OPTIONS[role];
  const { users, routes } = useCompanyPeople();
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [f, setF] = useState({ kind: options[0]!.kind, holderId: '', routeId: '', concept: 'recaudo' as 'recaudo' | 'base', amount: 0, note: '' });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => {
    if (!open) return;
    setF({ kind: initialKind ?? options[0]!.kind, holderId: '', routeId: '', concept: 'recaudo', amount: 0, note: '' });
    setOpId(generateId());
    adminDirectory().then(setAdmins).catch(() => setAdmins([]));
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps

  const myRoutes = routes.filter((r) => r.capitalControllerAdminId === me?.membershipId && r.status !== 'inactiva');
  const workers = users.filter((u) => u.rol === 'cobrador' && u.status === 'activo' && (u.authorizedRouteIds ?? []).includes(f.routeId));
  const holders: { value: string; label: string }[] = f.kind === 'admin_return' ? admins.map((a) => ({ value: a.adminId, label: formatPersonName(a.name) }))
    : f.kind === 'admin_transfer' ? admins.filter((a) => !a.self).map((a) => ({ value: a.adminId, label: formatPersonName(a.name) }))
      : f.kind === 'worker_return' ? workers.map((u) => ({ value: u.id, label: formatPersonName(u.nombre) })) : [];
  const blocked = f.kind === 'worker_return' && myRoutes.length === 0 ? 'No eres responsable de capital de ninguna ruta.'
    : (f.kind === 'admin_transfer' || f.kind === 'admin_return') && holders.length === 0 && admins.length > 0 ? 'No hay otros Administradores activos.' : null;

  async function save() {
    if (blocked) return;
    if (f.kind !== 'admin_allocation' && !f.holderId) { toast.error(f.kind === 'worker_return' ? 'Selecciona la ruta y el Cobrador' : 'Selecciona el Administrador'); return; }
    if (f.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return; }
    setSaving(true);
    try {
      await createRequest({ kind: f.kind, holderId: f.kind === 'admin_allocation' ? undefined : f.holderId,
        routeId: f.kind === 'worker_return' ? f.routeId : undefined, concept: f.kind === 'worker_return' ? f.concept : undefined,
        amount: f.amount, note: f.note, operationId: opId });
      toast.success('Solicitud enviada');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={() => { if (!saving) onClose(); }} guarded={f.amount > 0 || f.note.trim() !== ''} title="Nueva solicitud" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving} disabled={!!blocked}>Enviar solicitud</Button></>}>
      <div className="space-y-4" data-testid="request-form">
        {options.length > 1 && (
          <Select label="Solicitud" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value as RequestKind, holderId: '' }))}
            options={options.map((o) => ({ value: o.kind, label: o.label }))} />
        )}
        {f.kind === 'worker_return' && (
          <>
            <Select label="Ruta" value={f.routeId} onChange={(e) => setF((x) => ({ ...x, routeId: e.target.value, holderId: '' }))}
              options={myRoutes.map((r) => ({ value: r.id, label: r.nombre }))} placeholder={myRoutes.length ? 'Seleccionar ruta' : 'Sin rutas a tu cargo'} required />
            <Select label="Concepto" value={f.concept} onChange={(e) => setF((x) => ({ ...x, concept: e.target.value as 'recaudo' | 'base' }))}
              options={[{ value: 'recaudo', label: CONCEPT_LABEL.recaudo }, { value: 'base', label: CONCEPT_LABEL.base }]} />
          </>
        )}
        {f.kind !== 'admin_allocation' && (
          <Select label={f.kind === 'worker_return' ? 'Cobrador' : 'Administrador'} value={f.holderId} onChange={(e) => setF((x) => ({ ...x, holderId: e.target.value }))}
            options={holders} placeholder={holders.length ? 'Seleccionar' : f.kind === 'worker_return' && !f.routeId ? 'Primero elige la ruta' : 'Nadie disponible'} required />
        )}
        <MoneyInput label="Valor" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required />
        <Textarea label="Nota (opcional)" value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} rows={2} />
        {blocked
          ? <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="status">{blocked}</p>
          : <p className="text-xs text-gray-500">No mueve dinero hasta que quien lo tiene lo entregue.</p>}
      </div>
    </Modal>
  );
}

// ============================================================
// Devolver capital al SuperAdmin (Administrador)
// ============================================================
export function ReturnToCompanyModal({ open, onClose, onDone, currency, available, request }: {
  open: boolean; onClose: () => void; onDone: () => void; currency: string;
  /** Disponible de la propia bolsa; `null` = desconocido (el servidor decide). */
  available: number | null; request?: CapitalRequest | null;
}) {
  const [f, setF] = useState({ amount: 0, reason: '' });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => {
    if (!open) return;
    setF({ amount: request?.amount ?? 0, reason: request ? `Devolución solicitada${request.note ? `: ${request.note}` : ''}`.slice(0, 300) : '' });
    setOpId(generateId());
  }, [open, request]);
  const exceeds = available != null && f.amount > available;
  async function save() {
    if (f.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return; }
    if (f.reason.trim().length < 3) { toast.error('Indica el concepto (mínimo 3 caracteres).'); return; }
    if (exceeds) { toast.error('El valor supera tu capital disponible.'); return; }
    setSaving(true);
    try {
      await returnToCompany({ amount: f.amount, reason: f.reason, requestId: request?.id, operationId: opId });
      toast.success('Capital devuelto al SuperAdmin');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!saving) onClose(); }} guarded={f.amount > 0 && !request} title="Devolver capital al SuperAdmin" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving} disabled={exceeds || available === 0}>Devolver</Button></>}>
      <div className="space-y-4" data-testid="return-company-form">
        {request && <RequestBanner r={request} currency={currency} />}
        <MoneyInput label="Valor" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required
          hint={available != null ? `Disponible: ${formatCurrency(available, currency)}` : undefined} error={exceeds ? 'Supera tu capital disponible' : undefined} />
        <Textarea label="Concepto" value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} rows={2} required />
        {available === 0 && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="status">No tienes capital disponible para devolver.</p>}
      </div>
    </Modal>
  );
}

// ============================================================
// Entregar efectivo al Administrador (Cobrador)
// ============================================================
export function DeliverCashModal({ open, onClose, onDone, currency, request }: {
  open: boolean; onClose: () => void; onDone: () => void; currency: string; request?: CapitalRequest | null;
}) {
  const me = useRuntime((s) => s.ctx);
  const { routes } = useCompanyPeople();
  const [positions, setPositions] = useState<CustodyPosition[] | null>(null);
  const [f, setF] = useState({ routeId: '', concept: 'recaudo' as 'recaudo' | 'base', amount: 0, note: '' });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  const myRoutes = useMemo(() => routes.filter((r) => (me?.routeIds ?? []).includes(r.id)), [routes, me]);
  useEffect(() => {
    if (!open) return;
    setOpId(generateId());
    setPositions(null);
    custodyPositions().then(setPositions).catch(() => setPositions([]));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setF({ routeId: request?.routeId ?? (myRoutes.length === 1 ? myRoutes[0]!.id : ''), concept: request?.concept ?? 'recaudo', amount: request?.amount ?? 0, note: '' });
  }, [open, request, myRoutes]);
  const pos = positions?.find((p) => p.routeId === f.routeId && p.workerId === me?.membershipId);
  const cash = positions == null ? null : pos ? toMajor(pos.transferableMinor) : 0;
  const exceeds = cash != null && f.amount > cash;
  const controller = routes.find((r) => r.id === f.routeId)?.capitalControllerAdminId;
  async function save() {
    if (!f.routeId) { toast.error('Selecciona la ruta'); return; }
    if (f.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return; }
    if (exceeds) { toast.error('El valor supera el efectivo a tu cargo.'); return; }
    setSaving(true);
    try {
      await deliverOwnCash({ routeId: f.routeId, amount: f.amount, concept: f.concept, note: f.note, requestId: request?.id, operationId: opId });
      toast.success('Entrega registrada');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!saving) onClose(); }} guarded={f.amount > 0 && !request} title="Entregar efectivo" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving} disabled={exceeds || cash === 0 || !controller}>Registrar entrega</Button></>}>
      <div className="space-y-4" data-testid="deliver-cash-form">
        {request && <RequestBanner r={request} currency={currency} />}
        {myRoutes.length > 1 && (
          <Select label="Ruta" value={f.routeId} onChange={(e) => setF((x) => ({ ...x, routeId: e.target.value }))} disabled={!!request}
            options={myRoutes.map((r) => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
        )}
        <Select label="Concepto" value={f.concept} onChange={(e) => setF((x) => ({ ...x, concept: e.target.value as 'recaudo' | 'base' }))}
          options={[{ value: 'recaudo', label: CONCEPT_LABEL.recaudo }, { value: 'base', label: CONCEPT_LABEL.base }]} />
        <MoneyInput label="Valor" currency={currency} value={f.amount} onValueChange={(v) => setF((x) => ({ ...x, amount: v }))} required
          hint={cash != null && f.routeId ? `Efectivo a tu cargo: ${formatCurrency(cash, currency)}` : undefined} error={exceeds ? 'Supera el efectivo a tu cargo' : undefined} />
        <Textarea label="Nota (opcional)" value={f.note} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} rows={2} />
        {f.routeId && !controller && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="status">La ruta no tiene responsable de capital: pide al SuperAdmin que lo asigne.</p>}
        {f.routeId && controller && cash === 0 && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="status">No tienes efectivo a tu cargo en esta ruta.</p>}
      </div>
    </Modal>
  );
}

// ============================================================
// Rechazar / cancelar
// ============================================================
export function CloseRequestModal({ target, currency, onClose, onDone }: {
  target: { r: CapitalRequest; action: 'reject' | 'cancel' } | null; currency: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => { if (target) { setReason(''); setOpId(generateId()); } }, [target]);
  if (!target) return null;
  const reject = target.action === 'reject';
  async function go() {
    if (reason.trim().length < 3) { toast.error('Indica el motivo (mínimo 3 caracteres).'); return; }
    setSaving(true);
    try {
      await closeRequest(target!.r.id, target!.action, reason, opId);
      toast.success(reject ? 'Solicitud rechazada' : 'Solicitud cancelada');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title={reject ? 'Rechazar solicitud' : 'Cancelar solicitud'} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Volver</Button><Button variant="danger" onClick={go} loading={saving}>{reject ? 'Rechazar' : 'Cancelar solicitud'}</Button></>}>
      <div className="space-y-3">
        <RequestBanner r={target.r} currency={currency} />
        <Textarea label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
      </div>
    </Modal>
  );
}

export function RequestBanner({ r, currency }: { r: CapitalRequest; currency: string }) {
  const who = formatPersonName(r.mySide === 'requester' ? r.holder.name : r.requester.name);
  return (
    <div className="rounded-xl border border-primary-100 bg-primary-50 px-3 py-2 text-sm text-gray-800" data-testid="request-banner">
      <p><b>{formatCurrency(r.amount, currency)}</b>{r.concept ? ` · ${CONCEPT_LABEL[r.concept]}` : ''}{who ? ` · ${r.mySide === 'requester' ? 'a' : 'de'} ${who}` : ''}</p>
      {r.note && <p className="text-xs text-gray-600 break-words">«{r.note}»</p>}
    </div>
  );
}
