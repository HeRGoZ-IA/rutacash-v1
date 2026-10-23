// PIEZAS VISUALES DEL MODO SIN CONEXIÓN (Ronda 62), con las clases y la identidad de ADEX.
// Textos cortos y sin tecnicismos: qué quedó guardado, qué falta enviar, qué se confirmó y qué
// necesita atención. Nunca «confirmado» para algo que solo está en el dispositivo.

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronLeft, Clock, Loader2, PhoneCall, RefreshCw, Smartphone, Wifi, WifiOff, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatDateTime } from '@/lib/formatters';
import { formatClientName } from '@/lib/displayName';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { toMajor } from '../runtime/mappers.ts';
import { ALERT_12H, ALERT_24H, alertLevel, isOpen, summary, useOffline, type OpStatus, type PendingOp } from './state.ts';
import { useRuntime } from '../runtime/session.ts';
import { OFFLINE_BLOCK_TEXT, OFFLINE_BLOCK_TITLE } from './sales.ts';

/** Vuelve a dibujar cada minuto (los avisos de 12 y 24 h dependen de la hora). */
export function useMinuteTick(): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setT(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

/** ¿Hay servidor? (red del navegador + última respuesta de la API). */
export function useReachable(): boolean {
  const online = useOnlineStatus();
  const [nav, setNav] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setNav(true), down = () => setNav(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online && nav;
}

export const STATUS_LABEL: Record<OpStatus, string> = {
  local: 'Guardado solo en este dispositivo',
  sending: 'Sincronizando',
  confirmed: 'Confirmado por el servidor',
  review: 'Requiere revisión',
  rejected: 'Rechazado por el servidor',
};

const STATUS_STYLE: Record<OpStatus, string> = {
  local: 'bg-amber-50 text-amber-700 border-amber-200',
  sending: 'bg-primary-50 text-primary-700 border-primary-200',
  confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  review: 'bg-orange-50 text-orange-700 border-orange-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
};

export function OpStatusBadge({ status }: { status: OpStatus }) {
  const Icon = status === 'confirmed' ? CheckCircle : status === 'rejected' ? XCircle : status === 'review' ? AlertTriangle : status === 'sending' ? RefreshCw : Smartphone;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[status])} data-testid="op-status">
      <Icon className="w-3 h-3" /> {STATUS_LABEL[status]}
    </span>
  );
}

/** Indicador discreto del encabezado: En línea / Sin conexión / Sincronizando / Pendientes / Revisar. */
export function OfflineIndicator({ onOpen }: { onOpen: () => void }) {
  const reachable = useReachable();
  const enabled = useOffline((s) => s.enabled);
  const syncing = useOffline((s) => s.syncing);
  const ops = useOffline((s) => s.ops);
  const { pending, attention } = summary(ops);
  let tone = reachable ? 'bg-emerald-500/25 text-emerald-100' : 'bg-red-500/25 text-red-100';
  let icon = reachable ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />;
  let text = reachable ? 'En línea' : 'Sin conexión';
  if (enabled && syncing && reachable) { tone = 'bg-white/20 text-white'; icon = <Loader2 className="w-3 h-3 animate-spin" />; text = 'Sincronizando'; }
  else if (enabled && attention > 0) { tone = 'bg-orange-500/40 text-white'; icon = <AlertTriangle className="w-3 h-3" />; text = `Revisar ${attention}`; }
  else if (enabled && pending > 0) { tone = 'bg-amber-400/40 text-white'; icon = reachable ? <Clock className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />; text = `${pending} pendiente${pending === 1 ? '' : 's'}`; }
  return (
    <button type="button" onClick={onOpen} className={cn('flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full', tone)} data-testid="offline-indicator" aria-label={`Estado de conexión: ${text}`}>
      {icon}{text}
    </button>
  );
}

/** Avisos bajo el encabezado del Cobrador: sin conexión, datos guardados y avisos de 12 / 24 h. */
export function OfflineBanners({ onOpen }: { onOpen: () => void }) {
  const reachable = useReachable();
  const enabled = useOffline((s) => s.enabled);
  const unavailable = useOffline((s) => s.unavailable);
  const ops = useOffline((s) => s.ops);
  const savedAt = useOffline((s) => s.dataSavedAt);
  const now = useMinuteTick();
  const level = enabled ? alertLevel(ops, now) : 0;
  return (
    <>
      {!reachable && (
        <div className="bg-amber-500 text-white text-xs text-center px-3 py-1.5 font-medium" data-testid="offline-banner">
          {enabled
            ? <>Sin conexión. Los abonos, visitas, gastos y desembolsos aprobados se guardan en este dispositivo y se envían al volver internet.{savedAt ? <> Datos de la ruta del {formatDateTime(savedAt)}.</> : null}</>
            : <>Sin conexión con el servidor{unavailable ? ` — ${unavailable}` : ''}</>}
        </div>
      )}
      {reachable && savedAt && enabled && (
        <div className="bg-amber-50 text-amber-800 text-xs text-center px-3 py-1.5 border-b border-amber-200">Mostrando datos guardados del {formatDateTime(savedAt)} mientras se actualizan.</div>
      )}
      {level > 0 && (
        <button type="button" onClick={onOpen} data-testid={`offline-alert-${level}`}
          className={cn('w-full text-left text-xs px-3 py-2 flex items-start gap-2 border-b',
            level === 24 ? 'bg-red-600 text-white border-red-700 font-semibold' : 'bg-amber-100 text-amber-900 border-amber-300')}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{level === 24 ? ALERT_24H : ALERT_12H}</span>
        </button>
      )}
    </>
  );
}

const KIND_LABEL: Record<PendingOp['kind'], string> = {
  payment: 'Abono', visit: 'Visita sin pago', expense: 'Gasto', disbursement: 'Desembolso',
  // Solo registros de una versión anterior (65-C1).
  client: 'Cliente nuevo', credit_request: 'Solicitud de venta',
};

/** Ronda 65: lo que significa «confirmado» en un desembolso. */
const CONFIRMED_NOTE: Partial<Record<PendingOp['kind'], string>> = {
  disbursement: 'Crédito activo para recaudo.',
};

/**
 * 65-C1: el Cobrador sin servidor al alcance no registra clientes ni ventas (llama a la oficina).
 * Reactivo: con la conexión de vuelta, la pantalla muestra otra vez el formulario.
 */
export function useNewClientsAndSalesBlocked(): boolean {
  const reachable = useReachable();
  const role = useRuntime((s) => s.ctx?.role);
  const fromCache = useOffline((s) => s.ctxFromCache);
  return role === 'cobrador' && (!reachable || fromCache);
}

/** Aviso en lugar del formulario de cliente nuevo o de venta (sin campos que no se podrían guardar). */
export function OfflineOperationBlocked({ onBack }: { onBack: () => void }) {
  return (
    <div className="pb-6" data-testid="offline-blocked">
      <div className="bg-primary-700 px-4 py-4">
        <button onClick={onBack} className="flex items-center gap-1 text-primary-200 text-sm">
          <ChevronLeft className="w-4 h-4" /> Volver
        </button>
      </div>
      <div className="p-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center space-y-3">
          <WifiOff className="w-8 h-8 text-amber-600 mx-auto" />
          <p className="font-bold text-gray-900">{OFFLINE_BLOCK_TITLE}</p>
          <p className="text-sm text-gray-700">{OFFLINE_BLOCK_TEXT}</p>
          <p className="text-xs text-gray-500 flex items-center justify-center gap-1"><PhoneCall className="w-3.5 h-3.5" /> La oficina lo registrará en tu ruta.</p>
        </div>
      </div>
    </div>
  );
}

/** Una operación en la lista de pendientes. */
export function PendingOpRow({ op, name, onRetry, onReviewed }: { op: PendingOp; name?: string; onRetry?: () => void; onReviewed?: () => void }) {
  const amount = op.ref.amountMinor != null ? formatCurrency(toMajor(op.ref.amountMinor)) : null;
  const who = op.kind === 'expense' ? op.ref.label : formatClientName(name ?? op.ref.clientName) || 'Cliente';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-3 space-y-2" data-testid="pending-op" data-op-id={op.id} data-op-status={op.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{KIND_LABEL[op.kind]}{who ? ` · ${who}` : ''}</p>
          <p className="text-xs text-gray-500">Capturado {formatDateTime(op.capturedAt)}{op.kind === 'visit' && op.ref.label ? ` · ${op.ref.label}` : ''}</p>
        </div>
        {amount && <p className="text-sm font-bold text-gray-900 tabular-nums flex-shrink-0">{amount}</p>}
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <OpStatusBadge status={op.status} />
        {op.status === 'confirmed' && op.result?.date && <span className="text-[11px] text-gray-500">Registrado con fecha {op.result.date}</span>}
      </div>
      {op.status === 'confirmed' && CONFIRMED_NOTE[op.kind] && <p className="text-xs text-gray-600" data-testid="pending-op-note">{CONFIRMED_NOTE[op.kind]}</p>}
      {op.error && op.status !== 'confirmed' && (
        <p className={cn('text-xs', op.status === 'sending' || op.status === 'local' ? 'text-gray-500' : 'text-orange-700')} data-testid="pending-op-reason">{op.error.message}</p>
      )}
      {(onRetry || onReviewed) && (
        <div className="flex gap-2">
          {onRetry && <button type="button" onClick={onRetry} className="flex-1 h-9 rounded-xl bg-primary-600 text-white text-xs font-medium" data-testid="pending-op-retry">Reintentar</button>}
          {onReviewed && <button type="button" onClick={onReviewed} className="flex-1 h-9 rounded-xl border border-gray-200 text-gray-600 text-xs font-medium" data-testid="pending-op-reviewed">Ya lo revisé</button>}
        </div>
      )}
    </div>
  );
}

export { isOpen };
