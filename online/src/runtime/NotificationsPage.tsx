// NOTIFICACIONES (Ronda 59), con la identidad visual de CLEAN. Una sola pantalla para el
// Administrador y el SuperAdmin (DINERO) y para el Cobrador (barra inferior); el contenido lo
// decide el servidor según la membresía activa (`GET /v1/notifications`).
//
//   Requieren acción  solicitudes que le toca atender y confirmaciones de Secretario.
//                     «Atender» abre el formulario ORDINARIO de esa operación con los datos
//                     precargados; esta pantalla no mueve dinero por sí misma.
//   Enviadas          sus solicitudes pendientes (puede cancelarlas).
//   Informativas      lo que le corresponde saber de los últimos 30 días.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Bell, CheckCircle2, Clock3, Inbox as InboxIcon, Plus, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatCurrency, formatDateTime } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { useRuntime } from './session.ts';
import { CONCEPT_LABEL, REQUEST_STATE_LABEL, fetchInbox, getRequest, requestTitle, type CapitalRequest, type Inbox, type Notice } from './capitalRequests.ts';
import { CloseRequestModal, DeliverCashModal, RequestModal } from './MoneyForms.tsx';
import { listAdminTransfers, type AdminTransfer } from './adminTransfers.ts';
import { TransferDecisionModal } from './AdminTransferUI.tsx';

/** Dónde se atiende cada solicitud (el MISMO formulario de la operación). */
const ATTEND_PATH: Record<string, string> = {
  admin_allocation: '/admin/capital', admin_return: '/admin/transfers', admin_transfer: '/admin/transfers',
};

export default function NotificationsPage() {
  const { currency } = useTenant();
  const role = useRuntime((s) => s.ctx?.role);
  const navigate = useNavigate();
  const revision = useDataRevision();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<{ r: CapitalRequest; action: 'reject' | 'cancel' } | null>(null);
  const [asking, setAsking] = useState(false);
  const [delivering, setDelivering] = useState<{ request: CapitalRequest | null } | null>(null);
  const [deciding, setDeciding] = useState<{ t: AdminTransfer; what: 'confirm' | 'reject' } | null>(null);
  const money = (n: number) => formatCurrency(n, currency);
  const cobrador = role === 'cobrador';
  const consultas = role === 'admin' || role === 'superadmin';

  useEffect(() => {
    let alive = true;
    fetchInbox().then((x) => { if (alive) { setInbox(x); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'No se pudieron cargar las notificaciones'); });
    return () => { alive = false; };
  }, [revision]);

  async function attend(r: CapitalRequest) {
    if (r.kind === 'worker_return') { setDelivering({ request: await getRequest(r.id) }); return; }
    navigate(`${ATTEND_PATH[r.kind]}?solicitud=${encodeURIComponent(r.id)}`);
  }
  async function decide(id: string, what: 'confirm' | 'reject') {
    const t = (await listAdminTransfers()).find((x) => x.id === id);
    if (t) setDeciding({ t, what });
  }
  const reload = () => { void fetchInbox().then(setInbox).catch(() => { /* se reintenta con el refresco */ }); };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto w-full" data-testid="notifications-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900">Notificaciones</h1>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {cobrador && <Button onClick={() => setDelivering({ request: null })} icon={<Send className="w-4 h-4" />} data-testid="deliver-cash">Entregar efectivo</Button>}
          {(role === 'admin' || role === 'superadmin') && (
            <Button variant="secondary" onClick={() => setAsking(true)} icon={<Plus className="w-4 h-4" />} data-testid="new-request">Nueva solicitud</Button>
          )}
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : !inbox ? (
        <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : (
        <>
          <section className="space-y-2" aria-labelledby="n-action" data-testid="notices-action">
            <h2 id="n-action" className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              Requieren acción {inbox.actionRequired.length > 0 && <Badge variant="warning" size="sm">{inbox.actionRequired.length}</Badge>}
            </h2>
            {inbox.actionRequired.length === 0 ? (
              <p className="bg-white rounded-2xl shadow-card border border-gray-100 px-4 py-3 text-sm text-gray-500">Nada pendiente.</p>
            ) : (
              <ul className="space-y-2">
                {inbox.actionRequired.map((n) => (
                  <li key={key(n)} className="bg-white rounded-2xl shadow-card border border-amber-200 p-4" data-testid="notice-action">
                    {n.type === 'request' ? (
                      <RequestRow r={n.request} money={money} actions={
                        <>
                          <Button size="sm" onClick={() => { void attend(n.request); }} data-testid="attend">Atender</Button>
                          <Button size="sm" variant="secondary" onClick={() => setClosing({ r: n.request, action: 'reject' })}>Rechazar</Button>
                        </>} />
                    ) : n.type === 'transfer-confirmation' ? (
                      <Row icon={<Clock3 className="w-4 h-4 text-amber-600" />} amount={money(n.transfer.amount)}
                        title={n.transfer.mode === 'secretary' ? `Confirmar transferencia registrada por ${formatPersonName(n.transfer.registeredBy.name) || 'Secretaría'}` : 'Confirmar transferencia recibida'}
                        detail={`${formatPersonName(n.transfer.origin.name) || 'Administrador'} → ${formatPersonName(n.transfer.destination.name) || 'Administrador'} · ${n.transfer.reason}`} at={n.at}
                        actions={<>
                          <Button size="sm" onClick={() => { void decide(n.transfer.id, 'confirm'); }}>{n.transfer.mySide === 'destination' ? 'Confirmar recepción' : 'Confirmar envío'}</Button>
                          <Button size="sm" variant="secondary" onClick={() => { void decide(n.transfer.id, 'reject'); }}>Rechazar</Button>
                        </>} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inbox.waiting.length > 0 && (
            <section className="space-y-2" aria-labelledby="n-wait" data-testid="notices-waiting">
              <h2 id="n-wait" className="text-sm font-semibold text-gray-900">Enviadas · esperando respuesta</h2>
              <ul className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
                {inbox.waiting.map((n) => n.type === 'request' && (
                  <li key={key(n)} className="p-4">
                    <RequestRow r={n.request} money={money}
                      actions={<Button size="sm" variant="ghost" onClick={() => setClosing({ r: n.request, action: 'cancel' })}>Cancelar</Button>} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2" aria-labelledby="n-info" data-testid="notices-info">
            <div className="flex items-center justify-between gap-2">
              <h2 id="n-info" className="text-sm font-semibold text-gray-900">Informativas</h2>
              {consultas && <Link to="/admin/consultas" className="text-xs text-primary-700 hover:underline">Ver todos los movimientos</Link>}
            </div>
            {inbox.info.length === 0 ? (
              <EmptyState icon={<InboxIcon className="w-8 h-8" />} title={`Sin avisos en los últimos ${inbox.days} días`} />
            ) : (
              <ul className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
                {inbox.info.map((n) => <li key={key(n)} className="px-4 py-3"><InfoRow n={n} money={money} consultas={consultas} /></li>)}
              </ul>
            )}
          </section>
        </>
      )}

      <RequestModal open={asking} onClose={() => setAsking(false)} onDone={() => { setAsking(false); reload(); }} currency={currency} />
      <CloseRequestModal target={closing} currency={currency} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />
      <DeliverCashModal open={!!delivering} request={delivering?.request ?? null} currency={currency}
        onClose={() => setDelivering(null)} onDone={() => { setDelivering(null); reload(); }} />
      <TransferDecisionModal target={deciding} currency={currency} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} />
    </div>
  );
}

function key(n: Notice): string {
  if ('request' in n) return `r:${n.request.id}:${n.type}`;
  if ('transfer' in n) return `t:${n.transfer.id}:${n.type}`;
  return `o:${n.operation.id}`;
}

function Row({ icon, title, detail, amount, at, actions }: { icon: React.ReactNode; title: string; detail?: string; amount: string; at: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="mt-0.5 flex-shrink-0" aria-hidden>{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 break-words">{title}</p>
          {detail && <p className="text-xs text-gray-600 break-words">{detail}</p>}
          <p className="text-xs text-gray-500">{formatDateTime(at)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:flex-shrink-0">
        <span className="text-sm font-bold text-gray-900 whitespace-nowrap">{amount}</span>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

function RequestRow({ r, money, actions }: { r: CapitalRequest; money: (n: number) => string; actions?: React.ReactNode }) {
  const detail = [r.concept ? CONCEPT_LABEL[r.concept] : null, r.note ? `«${r.note}»` : null].filter(Boolean).join(' · ');
  return <Row icon={<Bell className="w-4 h-4 text-amber-600" />} title={requestTitle(r)} detail={detail || undefined} amount={money(r.amount)} at={r.createdAt} actions={actions} />;
}

const OP_TEXT: Record<string, (o: { actor: { name: string | null }; workerName: string | null; adminName: string | null }) => string> = {
  'capital-received': (o) => `Capital recibido de ${formatPersonName(o.actor.name) || 'el SuperAdmin'}`,
  'capital-collected': (o) => `${formatPersonName(o.actor.name) || 'El SuperAdmin'} recogió capital de tu caja`,
  'cash-delivered': (o) => `Entrega de efectivo de ${formatPersonName(o.actor.name) || 'un Cobrador'}`,
  'capital-returned': (o) => `${formatPersonName(o.actor.name) || 'Un Administrador'} devolvió capital`,
  'capital-delivered': (o) => `Capital recibido de ${formatPersonName(o.actor.name) || 'tu Administrador'}`,
  'return-registered': (o) => `${formatPersonName(o.actor.name) || 'Tu Administrador'} registró una devolución tuya`,
};

function InfoRow({ n, money, consultas }: { n: Notice; money: (n: number) => string; consultas: boolean }) {
  if (n.type === 'request-resolved') {
    const r = n.request;
    const icon = r.state === 'fulfilled' ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-500" />;
    const by = formatPersonName(r.resolvedBy?.name);
    const title = r.mySide === 'requester'
      ? `Tu solicitud: ${REQUEST_STATE_LABEL[r.state].toLowerCase()}${by ? ` por ${by}` : ''}`
      : `Solicitud ${REQUEST_STATE_LABEL[r.state].toLowerCase()}${by ? ` por ${by}` : ''}`;
    return <Row icon={icon} title={title} detail={[requestTitle(r), r.resolutionReason ? `Motivo: ${r.resolutionReason}` : null].filter(Boolean).join(' · ')}
      amount={money(r.amount)} at={n.at} />;
  }
  if (n.type === 'transfer-received' || n.type === 'transfer-closed') {
    const t = n.transfer;
    const title = n.type === 'transfer-received' ? `Transferencia recibida de ${formatPersonName(t.origin.name) || 'otro Administrador'}`
      : `Transferencia ${t.state === 'rejected' ? 'rechazada' : t.state === 'cancelled' ? 'cancelada' : 'aplicada'}`;
    return <Row icon={<ArrowDownLeft className="w-4 h-4 text-emerald-600" />} title={title} detail={[t.reason, t.closeReason ? `Motivo: ${t.closeReason}` : null].filter(Boolean).join(' · ')}
      amount={money(t.amount)} at={n.at} />;
  }
  if ('operation' in n) {
    const o = n.operation;
    const incoming = n.type === 'capital-received' || n.type === 'cash-delivered' || n.type === 'capital-returned' || n.type === 'capital-delivered';
    return <Row icon={incoming ? <ArrowDownLeft className="w-4 h-4 text-emerald-600" /> : <ArrowUpRight className="w-4 h-4 text-amber-600" />}
      title={OP_TEXT[n.type]?.(o) ?? 'Movimiento registrado'} detail={o.reason} amount={money(o.amount)} at={n.at}
      actions={consultas ? <Link to={`/admin/consultas?referencia=${encodeURIComponent(o.id.slice(0, 8))}`} className="text-xs text-primary-700 hover:underline">Ver movimiento</Link> : undefined} />;
  }
  return null;
}
