// Piezas de interfaz de los TRASPASOS ENTRE ADMINISTRADORES (Rondas 53 y 59), con los componentes
// y el estilo de CLEAN (Modal, Button, Select, MoneyInput, Badge). Las usan la pantalla de
// Transferencias del Administrador y la del Secretario. Las reglas viven en el servidor: aquí
// solo se muestran las acciones que el servidor ofrece a cada persona (`canConfirm`…).

import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { formatCurrency, formatDateTime } from '@/lib/formatters';
import { generateId } from '@/lib/utils';
import {
  DECISION_LABEL, STATE_LABEL, adminDirectory, decideAdminTransfer, registerAdminTransfer,
  type AdminOption, type AdminTransfer, type AdminTransferParty,
} from './adminTransfers.ts';
import type { CapitalRequest } from './capitalRequests.ts';
import { RequestBanner } from './MoneyForms.tsx';

const STATE_VARIANT = { pending: 'warning', applied: 'success', rejected: 'danger', cancelled: 'gray' } as const;

export function TransferStateBadge({ t }: { t: AdminTransfer }) {
  return <Badge variant={STATE_VARIANT[t.state]} size="sm">{STATE_LABEL[t.state]}</Badge>;
}

const name = (p: AdminTransferParty) => p.name ?? 'Administrador';

function PartyLine({ label, p }: { label: string; p: AdminTransferParty }) {
  const ok = p.decision === 'confirmed' || p.decision === 'not_required';
  const Icon = ok ? CheckCircle2 : p.decision === 'rejected' ? XCircle : Clock3;
  const tone = ok ? 'text-emerald-600' : p.decision === 'rejected' ? 'text-red-600' : 'text-amber-600';
  return (
    <p className="flex items-start gap-1.5 text-xs text-gray-600">
      <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${tone}`} aria-hidden />
      <span className="min-w-0 break-words">{label}: <b className="text-gray-800">{name(p)}</b> · {DECISION_LABEL[p.decision]}
        {p.decidedAt ? ` ${formatDateTime(p.decidedAt)}` : ''}{p.reason ? ` · «${p.reason}»` : ''}</span>
    </p>
  );
}

/** Tarjeta de un traspaso: quién, cuánto, estado de cada parte y SUS acciones. */
export function TransferCard({ t, currency, onAction }: {
  t: AdminTransfer; currency: string; onAction?: (t: AdminTransfer, what: 'confirm' | 'reject' | 'cancel') => void;
}) {
  const actions = onAction && (t.canConfirm || t.canReject || t.canCancel);
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid={`admin-transfer-${t.id}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 flex flex-wrap items-center gap-1.5 min-w-0">
          <span className="break-words">{name(t.origin)}</span><ArrowRight className="w-3.5 h-3.5 text-gray-400" aria-label="a" /><span className="break-words">{name(t.destination)}</span>
        </p>
        <p className="text-sm font-bold text-gray-900 whitespace-nowrap">{formatCurrency(t.amount, currency)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TransferStateBadge t={t} />
        <span className="text-xs text-gray-500">{t.mode === 'secretary' ? `Registró ${t.registeredBy.name ?? 'Secretaría'} (Secretario)` : 'Directa'} · {formatDateTime(t.createdAt)}</span>
      </div>
      <p className="text-xs text-gray-600 break-words">{t.reason}</p>
      <PartyLine label="Origen" p={t.origin} />
      <PartyLine label="Destino" p={t.destination} />
      {t.closeReason && t.state === 'cancelled' && <p className="text-xs text-gray-500">Cancelada: «{t.closeReason}»</p>}
      {actions && (
        <div className="flex flex-wrap gap-2 pt-1">
          {t.canConfirm && <Button size="sm" onClick={() => onAction!(t, 'confirm')}>{t.mySide === 'destination' ? 'Confirmar recepción' : 'Confirmar envío'}</Button>}
          {t.canReject && <Button size="sm" variant="secondary" onClick={() => onAction!(t, 'reject')}>Rechazar</Button>}
          {t.canCancel && <Button size="sm" variant="secondary" onClick={() => onAction!(t, 'cancel')}>Cancelar registro</Button>}
        </div>
      )}
    </div>
  );
}

/**
 * Confirmar, rechazar o cancelar. Confirmar pide una comprobación consciente; rechazar y
 * cancelar, un motivo. Un id de operación por diálogo abierto: un doble clic no duplica.
 */
export function TransferDecisionModal({ target, currency, onClose, onDone }: {
  target: { t: AdminTransfer; what: 'confirm' | 'reject' | 'cancel' } | null; currency: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => { if (target) { setReason(''); setOpId(generateId()); } }, [target]);
  if (!target) return null;
  const { t, what } = target;
  const amount = formatCurrency(t.amount, currency);
  const applies = what === 'confirm' && (t.mode === 'direct' || (t.mySide === 'origin' ? t.destination.decision === 'confirmed' : t.origin.decision === 'confirmed'));
  const title = what === 'confirm' ? 'Confirmar transferencia' : what === 'reject' ? 'Rechazar transferencia' : 'Cancelar registro';
  async function go() {
    if (what !== 'confirm' && reason.trim().length < 3) { toast.error('Indica el motivo (mínimo 3 caracteres).'); return; }
    setSaving(true);
    try {
      const r = await decideAdminTransfer(t.id, what, opId, reason);
      toast.success(r.state === 'applied' ? 'Transferencia aplicada' : r.state === 'pending' ? 'Confirmación registrada' : r.state === 'rejected' ? 'Transferencia rechazada' : 'Registro cancelado');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title={title} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Volver</Button>
        <Button onClick={go} loading={saving} variant={what === 'confirm' ? 'primary' : 'danger'}>{what === 'confirm' ? 'Confirmar' : what === 'reject' ? 'Rechazar' : 'Cancelar registro'}</Button></>}>
      <div className="space-y-3" data-testid="transfer-decision">
        <p className="text-sm text-gray-800"><b>{amount}</b> · {name(t.origin)} → {name(t.destination)}</p>
        {what === 'confirm' && (
          <p className="text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
            {t.mySide === 'destination' ? `Confirmas que recibiste ${amount}.` : `Confirmas que enviaste ${amount}.`}{' '}
            {applies ? 'Con tu confirmación el capital pasa a la bolsa de destino.' : 'Falta la confirmación de la otra parte.'}
          </p>
        )}
        {what === 'reject' && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">El capital comprometido vuelve a la bolsa de origen. Si el dinero ya se movió, resuélvelo con la otra parte y regístralo de nuevo.</p>}
        {what === 'cancel' && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">El capital comprometido vuelve a la bolsa de origen.</p>}
        {what !== 'confirm' && <Textarea label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />}
      </div>
    </Modal>
  );
}

/**
 * Registrar un traspaso. Administrador (`asSecretary` falso): desde SU bolsa, elige el destino;
 * se aplica en el acto (R59). Con `request`, atiende la solicitud de capital de otro Administrador.
 * Secretario: origen y destino, como traspaso ya hecho o comunicado (confirman ambos).
 */
export function TransferRegisterModal({ open, onClose, onDone, currency, asSecretary, available, request }: {
  open: boolean; onClose: () => void; onDone: () => void; currency: string; asSecretary: boolean;
  /** Disponible de la propia bolsa (Administrador). `null` = desconocido. */
  available?: number | null;
  /** Solicitud de capital que se atiende (destino e importe precargados). */
  request?: CapitalRequest | null;
}) {
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [form, setForm] = useState({ origin: '', destination: '', amount: 0, reason: '' });
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  useEffect(() => {
    if (!open) return;
    setForm(request
      ? { origin: '', destination: request.requester.membershipId, amount: request.amount, reason: (request.note ? `Atiendo la solicitud: ${request.note}` : 'Atiendo la solicitud').slice(0, 300) }
      : { origin: '', destination: '', amount: 0, reason: '' });
    setOpId(generateId());
    adminDirectory().then(setAdmins).catch(() => setAdmins([]));
  }, [open, request]);
  const others = admins.filter((a) => !a.self);
  const origins = asSecretary ? admins : [];
  const destinations = (asSecretary ? admins.filter((a) => a.adminId !== form.origin) : others);
  const exceeds = !asSecretary && available != null && form.amount > available;
  const dirty = !request && (form.amount > 0 || form.reason.trim() !== '');
  async function save() {
    if (asSecretary && !form.origin) { toast.error('Selecciona el Administrador de origen'); return; }
    if (!form.destination) { toast.error('Selecciona el Administrador de destino'); return; }
    if (form.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return; }
    if (form.reason.trim().length < 3) { toast.error('Indica el concepto (mínimo 3 caracteres).'); return; }
    if (exceeds) { toast.error('El valor supera tu capital disponible.'); return; }
    setSaving(true);
    try {
      await registerAdminTransfer({ originAdminId: asSecretary ? form.origin : undefined, destinationAdminId: form.destination, amount: form.amount, reason: form.reason, operationId: opId, requestId: request?.id });
      toast.success(asSecretary ? 'Transferencia registrada · pendiente de ambos Administradores' : 'Transferencia realizada');
      onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); } finally { setSaving(false); }
  }
  const destName = admins.find((a) => a.adminId === form.destination)?.name;
  return (
    <Modal open={open} onClose={() => { if (!saving) onClose(); }} guarded={dirty} title={asSecretary ? 'Registrar transferencia entre Administradores' : 'Transferir a otro Administrador'} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button><Button onClick={save} loading={saving} disabled={exceeds || (!asSecretary && available === 0)}>{asSecretary ? 'Registrar' : 'Transferir'}</Button></>}>
      <div className="space-y-4" data-testid="admin-transfer-form">
        {request && <RequestBanner r={request} currency={currency} />}
        {!asSecretary && available === 0 && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="status">No tienes capital disponible para transferir.</p>}
        {asSecretary && (
          <Select label="Administrador de origen" value={form.origin} onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value, destination: f.destination === e.target.value ? '' : f.destination }))}
            options={origins.map((a) => ({ value: a.adminId, label: a.name }))} placeholder="Seleccionar" required />
        )}
        <Select label="Administrador de destino" value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} disabled={!!request}
          options={destinations.map((a) => ({ value: a.adminId, label: a.name }))} placeholder={destinations.length ? 'Seleccionar' : 'No hay otros Administradores activos'} required />
        <MoneyInput label="Valor" currency={currency} value={form.amount} onValueChange={(v) => setForm((f) => ({ ...f, amount: v }))} required
          hint={!asSecretary && available != null ? `Disponible: ${formatCurrency(available, currency)}` : undefined}
          error={exceeds ? 'Supera tu capital disponible' : undefined} />
        <Textarea label="Concepto" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} required
          placeholder={asSecretary ? 'Ej.: transferencia bancaria del 20/10' : undefined} />
        {form.amount > 0 && form.destination && (
          <p className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-testid="admin-transfer-effect">
            {asSecretary
              ? `El valor queda comprometido en la bolsa de origen y pendiente de que confirmen ambos Administradores.`
              : `${formatCurrency(form.amount, currency)} salen de tu caja y llegan a ${destName ?? 'destino'} en el acto.`}
          </p>
        )}
      </div>
    </Modal>
  );
}
