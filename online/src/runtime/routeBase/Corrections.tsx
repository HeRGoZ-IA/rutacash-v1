// CORRECCIONES DEL RESPONSABLE DE CAPITAL (R74 · migración 0037, regla definitiva del propietario).
//
// «La autoridad financiera máxima de una ruta es su Administrador responsable de capital (uno por ruta).» En SUS
// rutas corrige y anula, también lo que él mismo registró, sin pedir aprobación. Esta pantalla nunca deja un
// rechazo sin salida:
//   · antes de confirmar muestra QUÉ CAMBIA (Base, efectivo de trabajadores, cartera, gasto u obligación) con la
//     vista previa del servidor (`/v1/corrections/preview`);
//   · gasto con dinero propio ya reembolsado → «Anular el reembolso y luego el gasto» (una sola operación);
//   · periodo cerrado → reapertura explícita con motivo (solo el responsable de la ruta) y después la anulación;
//   · operación conjunta con rutas de otros responsables → anulación conjunta: propones, cada responsable confirma
//     SU parte desde su pantalla y, con la última confirmación, se asienta todo junto; puedes cancelarla.
// Nada se borra: cada anulación es un asiento espejo enlazado, con motivo y auditoría. Las cifras y las reglas son del
// servidor (PostgreSQL bajo bloqueo).

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, GitMerge, History, RotateCcw, Undo2, Unlock, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { useDataRevision } from '@/hooks/useDataRevision';
import { formatDate } from '@/lib/formatters';
import { formatPersonName } from '@/lib/displayName';
import { generateId, cn } from '@/lib/utils';
import { serverView } from '../projection.ts';
import { useRuntime } from '../session.ts';
import {
  cancelJointReversal, confirmJointReversal, fetchCorrectionPreview, fetchJointReversals, proposeJointReversal, reopenPeriod, reverseCapitalOperation,
  reverseExpenseWith, reverseReimbursement,
  type CorrectionKind, type CorrectionPreview, type JointProposal, type JointTargetKind,
} from './api.ts';
import { Notice, num, useMoney } from './parts.tsx';

export interface CorrectionTarget { kind: CorrectionKind; id: string; title: string }

const BLOCKED_TEXT: Record<string, string> = {
  ALREADY_REVERSED: 'Ya está anulado.',
  REVERSAL_NOT_ALLOWED: 'Este movimiento no se anula por esta vía (p. ej. una anulación, un desembolso o un reparto de saldo sin asignar).',
  CAPITAL_AUTHORITY_REQUIRED: 'Solo el Administrador responsable de capital de las rutas afectadas corrige esta operación.',
  SELF_CORRECTION_FORBIDDEN: 'Nadie anula un gasto pagado con su propio efectivo (tampoco con otra membresía).',
};
const TARGET_TEXT: Record<JointTargetKind, string> = { expense: 'Gasto general', reimbursement: 'Reembolso', route_transfer: 'Transferencia entre rutas' };

/** Texto de una cuenta afectada (sin vocabulario de bolsas en Base por Ruta). */
function effectLabel(e: CorrectionPreview['effects'][number]): string {
  const who = formatPersonName(e.personName ?? '') || null;
  switch (e.account.kind) {
    case 'route_base': return `Base de ${e.routeName ?? 'la ruta'}`;
    case 'custody': return `Efectivo de ${who ?? 'un trabajador'}${e.routeName ? ` (${e.routeName})` : ''}`;
    case 'portfolio': return `Cartera de ${e.routeName ?? 'la ruta'}`;
    case 'income': return `Intereses cobrados de ${e.routeName ?? 'la ruta'}`;
    case 'expense': return 'Gastos';
    case 'admin_payable': return `Saldo a favor de ${who ?? 'el Administrador'} (obligación, no es efectivo)`;
    case 'route_funding': return `Aportes y retiros externos de ${e.routeName ?? 'la ruta'}`;
    case 'admin': return `Saldo de ${who ?? 'un Administrador'}`;
    default: return e.label;
  }
}

/**
 * Diálogo de corrección: vista previa del efecto y el camino que corresponde (directa, en cadena, conjunta o
 * reapertura del periodo). `onDone` se llama cuando se asentó algo (la pantalla se recarga sola por la revisión).
 */
export function CorrectionDialog({ target, onClose }: { target: CorrectionTarget | null; onClose: () => void }) {
  const money = useMoney();
  const me = useRuntime((s) => s.ctx);
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reopenWhy, setReopenWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { if (target) { setReason(''); setReopenWhy(''); setError(null); setOpId(generateId()); } }, [target]);
  useEffect(() => {
    if (!target) { setPreview(null); return; }
    let alive = true;
    setPreview(null); setLoadError(null);
    fetchCorrectionPreview(target.kind, target.id)
      .then((p) => { if (alive) setPreview(p); })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : 'No se pudo preparar la corrección'); });
    return () => { alive = false; };
  }, [target, tick]);
  if (!target) return null;

  const deps = preview?.dependencies ?? [];
  const closed = deps.filter((d) => d.kind === 'closed_period');
  const reimbs = deps.filter((d) => d.kind === 'reimbursement');
  const joint = deps.find((d) => d.kind === 'joint_controllers');
  const proposal = preview?.jointProposal ?? null;
  const askOthers = reimbs.filter((d) => !d.reversibleByActor);
  const reasonOk = reason.trim().length >= (preview?.reasonMinLength ?? 3);
  const reload = () => { setOpId(generateId()); setTick((t) => t + 1); };

  async function run(fn: () => Promise<unknown>, ok: string, close = true) {
    setSaving(true); setError(null);
    try {
      await fn();
      toast.success(ok);
      if (close) onClose(); else reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar');
      reload();
    } finally { setSaving(false); }
  }
  const reverse = () => run(() => {
    if (target!.kind === 'expense') return reverseExpenseWith(target!.id, reason, opId, preview?.mode === 'cascade');
    if (target!.kind === 'reimbursement') return reverseReimbursement(target!.id, reason, opId);
    return reverseCapitalOperation(target!.id, reason, opId);
  }, preview?.mode === 'cascade' ? 'Reembolso y gasto anulados en una sola operación' : 'Anulación registrada');
  const propose = () => run(() => proposeJointReversal({ targetKind: (joint?.targetKind ?? 'expense'), targetId: target!.id, reason }, opId),
    'Anulación conjunta propuesta: los demás responsables confirmarán su parte', false);
  const reopen = (closureId: string) => run(() => reopenPeriod(closureId, reopenWhy, opId), 'Periodo reabierto: ya puedes asentar la corrección', false);

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={saving}>Cerrar</Button>
      {preview?.mode === 'direct' && <Button variant="danger" onClick={reverse} loading={saving} disabled={!reasonOk} data-testid="corr-confirm">Anular</Button>}
      {preview?.mode === 'cascade' && (
        <Button variant="danger" onClick={reverse} loading={saving} disabled={!reasonOk} data-testid="corr-cascade" icon={<GitMerge className="w-4 h-4" />}>
          Anular el reembolso y luego el gasto
        </Button>
      )}
      {preview?.mode === 'joint' && !proposal && (
        <Button onClick={propose} loading={saving} disabled={!reasonOk} data-testid="corr-propose" icon={<Users className="w-4 h-4" />}>Proponer anulación conjunta</Button>
      )}
    </>
  );

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} size="lg" title="Corregir operación" footer={footer}>
      <div className="space-y-3 text-sm" data-testid="corr-dialog">
        <div>
          <p className="font-medium text-gray-900 break-words">{target.title}</p>
          {preview && <p className="text-gray-600">Valor <span className={cn(num, 'font-semibold text-gray-900')}>{money(preview.amountMinor)}</span></p>}
        </div>
        {loadError ? <Notice tone="red">{loadError}</Notice> : !preview ? <div className="h-20 rounded-xl bg-gray-100 animate-pulse" aria-busy="true" /> : (
          <>
            {preview.effects.length > 0 && (
              <section aria-labelledby="corr-effects" className="rounded-xl border border-gray-200 p-3" data-testid="corr-effects">
                <h3 id="corr-effects" className="text-xs font-semibold text-gray-700 mb-1.5">Qué cambia si se anula</h3>
                <ul className="space-y-1">
                  {preview.effects.map((e, i) => {
                    // La obligación con un Administrador se guarda en negativo: se muestra cuánto sube (+) o baja (−) lo que se le debe.
                    const shown = e.account.kind === 'admin_payable' ? -e.deltaMinor : e.deltaMinor;
                    return (
                      <li key={i} className="flex items-start justify-between gap-3 text-xs" data-testid="corr-effect">
                        <span className="text-gray-700 min-w-0 break-words">{effectLabel(e)}{!e.isCash && e.account.kind !== 'admin_payable' ? <span className="text-gray-400"> · no es efectivo</span> : null}</span>
                        <span className={cn(num, 'font-semibold', shown > 0 ? 'text-emerald-700' : 'text-red-700')}>{shown > 0 ? '+' : '−'}{money(Math.abs(shown))}</span>
                      </li>
                    );
                  })}
                </ul>
                {preview.mode === 'joint' && <p className="text-[11px] text-gray-500 mt-1.5">Solo ves las cuentas de tus rutas; cada responsable ve las suyas.</p>}
              </section>
            )}

            {preview.mode === 'cascade' && (
              <Notice tone="violet" testId="corr-cascade-note">
                <b>Este gasto ya se reembolsó.</b> Para anularlo sin dejar un reembolso huérfano se anulan primero
                {reimbs.length === 1 ? ' el reembolso' : ` los ${reimbs.length} reembolsos`} ({reimbs.map((d) => money(d.amountMinor)).join(', ')}) y luego el gasto,
                todo en una sola operación. El dinero vuelve a las rutas que pagaron y la obligación desaparece.
              </Notice>
            )}

            {askOthers.length > 0 && (
              <Notice tone="amber" testId="corr-ask-controller">
                <b>Primero hay que anular {askOthers.length === 1 ? 'un reembolso' : 'unos reembolsos'} que pagó otro Administrador:</b>
                <ul className="mt-1 list-disc pl-4">
                  {askOthers.map((d) => <li key={d.id}>{money(d.amountMinor)} · pagó {formatPersonName(d.payerName ?? '') || 'otro Administrador'} desde sus rutas: lo anula desde su Caja principal → Gastos generales y reembolsos → Historial de reembolsos.</li>)}
                </ul>
                Cuando lo haga, vuelve aquí y anula el gasto.
              </Notice>
            )}

            {closed.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2" data-testid="corr-closed-period">
                <p className="text-amber-900 flex gap-2"><Unlock className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
                  <span>La corrección se asienta hoy y {closed.length === 1 ? 'este periodo está cerrado' : 'estos periodos están cerrados'}. Reábrelo explícitamente (queda registrado con tu motivo) y después anula.</span></p>
                {closed.map((d) => (
                  <div key={d.id} className="space-y-1.5">
                    <p className="text-xs text-amber-900 font-medium">{d.label}</p>
                    {d.action === 'reopen_period' ? (
                      <>
                        <Textarea label="Motivo de la reapertura (mínimo 10 caracteres)" value={reopenWhy} onChange={(ev) => setReopenWhy(ev.target.value)} rows={2} maxLength={300} />
                        <Button size="sm" variant="secondary" onClick={() => { void reopen(d.id); }} loading={saving} disabled={reopenWhy.trim().length < 10} data-testid="corr-reopen">Reabrir periodo</Button>
                      </>
                    ) : <p className="text-xs text-amber-900">Solo el responsable de capital de esa ruta puede reabrirlo.</p>}
                  </div>
                ))}
              </div>
            )}

            {preview.mode === 'joint' && joint && (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 space-y-2" data-testid="corr-joint">
                <p className="text-sky-900 flex gap-2"><Users className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
                  <span><b>Operación conjunta con rutas de otros responsables.</b> Nadie toca el dinero de otro: propones la anulación, cada responsable confirma su parte desde su pantalla y, cuando confirma el último, se asienta todo junto. Puedes cancelarla mientras esté pendiente.</span></p>
                <ul className="text-xs text-sky-900 space-y-0.5">
                  {(joint.routes ?? []).map((r, i) => <li key={i}>{r.name ?? r.routeName}: {r.isActor ? 'tú' : formatPersonName(r.controllerName ?? '') || 'sin responsable válido'}</li>)}
                </ul>
                {proposal && <JointProposalCard p={proposal} compact />}
              </div>
            )}

            {preview.mode === 'blocked' && preview.blockedBy && <Notice tone="gray" testId="corr-blocked">{
              preview.blockedBy === 'CAPITAL_AUTHORITY_REQUIRED' && preview.authorizedAdmins?.length
                ? `Solo puede anularla ${preview.authorizedAdmins.map((n) => formatPersonName(n)).join(' o ')}: quien la registró o, si ya no responde por esas rutas, su responsable actual.`
                : BLOCKED_TEXT[preview.blockedBy] ?? 'Esta operación no se puede corregir desde aquí.'}</Notice>}

            {(preview.mode === 'direct' || preview.mode === 'cascade' || (preview.mode === 'joint' && !proposal)) && (
              <Textarea label={preview.mode === 'joint' ? 'Motivo de la anulación (lo verán los demás responsables)' : 'Motivo de la anulación'}
                value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} required maxLength={300} data-testid="corr-reason" />
            )}
            <p className="text-xs text-gray-500">No se borra nada: queda una anulación enlazada al original, con tu motivo y la fecha de hoy.{me?.role === 'admin' ? ' Como responsable de capital puedes corregir también lo que tú registraste.' : ''}</p>
          </>
        )}
        {error && <Notice tone="red" testId="corr-error">{error}</Notice>}
      </div>
    </Modal>
  );
}

/** Tarjeta de una anulación conjunta: partes, quién falta y las acciones del contexto (confirmar / cancelar). */
export function JointProposalCard({ p: initial, compact }: { p: JointProposal; compact?: boolean }) {
  const money = useMoney();
  // La respuesta del servidor reemplaza la tarjeta (confirmada, asentada o cancelada) sin esperar a la recarga.
  const [p, setP] = useState(initial);
  useEffect(() => { setP(initial); }, [initial]);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [why, setWhy] = useState('');
  const [opId, setOpId] = useState(() => generateId());
  const t = p.target ?? {};
  const detail = p.targetKind === 'expense' ? [t['categoryName'], t['description']].filter(Boolean).join(' · ')
    : p.targetKind === 'reimbursement' ? `A ${formatPersonName(String(t['beneficiaryName'] ?? '')) || 'un Administrador'}`
      : `${String(t['fromRouteName'] ?? '')} → ${String(t['toRouteName'] ?? '')}`;
  async function act(fn: () => Promise<{ proposal: JointProposal }>, ok: (x: JointProposal) => string) {
    setSaving(true);
    try { const r = await fn(); setP(r.proposal); toast.success(ok(r.proposal)); setCancelling(false); } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo completar'); }
    finally { setSaving(false); setOpId(generateId()); }
  }
  return (
    <div className={cn('rounded-xl border bg-white p-3 space-y-2', p.canConfirm ? 'border-amber-300' : 'border-gray-200')} data-testid={`joint-${p.id}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">Anulación conjunta · {TARGET_TEXT[p.targetKind]}</p>
          {!compact && <p className="text-xs text-gray-600 break-words">{detail}</p>}
          <p className="text-xs text-gray-500 break-words">Propuso {formatPersonName(p.proposedBy.name ?? '') || 'un Administrador'} · {formatDate(p.createdAt.slice(0, 10))} · «{p.reason}»</p>
        </div>
        <span className={cn(num, 'text-sm font-bold text-gray-900')}>{money(p.amountMinor)}</span>
      </div>
      <ul className="space-y-1" aria-label="Partes por ruta">
        {p.parts.map((x) => (
          <li key={x.routeId} className="flex items-center justify-between gap-2 text-xs" data-testid="joint-part">
            <span className="min-w-0 text-gray-700">
              {x.confirmed ? <CheckCircle2 className="inline w-3.5 h-3.5 text-emerald-600 mr-1" aria-hidden /> : <Clock3 className="inline w-3.5 h-3.5 text-amber-600 mr-1" aria-hidden />}
              {x.routeName} · {x.isMine ? 'tú' : formatPersonName(x.controllerName ?? '') || 'sin responsable válido'}
              <span className="text-gray-500"> · {x.direction === 'returns_to_route' ? 'recupera' : 'devuelve'} {money(x.amountMinor)}</span>
            </span>
            <span className={x.confirmed ? 'text-emerald-700' : 'text-amber-700'}>{x.confirmed ? 'Confirmó' : 'Pendiente'}</span>
          </li>
        ))}
      </ul>
      {p.status !== 'pending' ? (
        <p className="text-xs text-gray-600" data-testid="joint-status">{p.status === 'posted' ? 'Asentada: la anulación completa quedó registrada.' : p.status === 'cancelled' ? `Cancelada${p.closeReason ? `: ${p.closeReason}` : ''}.` : 'Caducó: la operación ya estaba anulada.'}</p>
      ) : (
        <div className="space-y-2">
          {p.canConfirm && (
            <p className="text-xs text-gray-700">Al confirmar aceptas la anulación de <b>tu parte</b>. {p.pendingParts <= p.parts.filter((x) => x.isMine && !x.confirmed).length
              ? 'Eres el último: la anulación completa se asentará ahora, en una sola operación.' : 'Se asentará cuando confirme el último responsable.'}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {p.canConfirm && <Button size="sm" onClick={() => { void act(() => confirmJointReversal(p.id, opId), (x) => x.status === 'posted' ? 'Anulación conjunta asentada' : 'Tu parte quedó confirmada'); }} loading={saving} data-testid="joint-confirm">Confirmar mi parte</Button>}
            {p.canCancel && !cancelling && <Button size="sm" variant="secondary" onClick={() => setCancelling(true)} data-testid="joint-cancel">Cancelar propuesta</Button>}
          </div>
          {cancelling && (
            <div className="space-y-1.5">
              <Textarea label="Motivo de la cancelación" value={why} onChange={(ev) => setWhy(ev.target.value)} rows={2} maxLength={300} />
              <div className="flex gap-2">
                <Button size="sm" variant="danger" onClick={() => { void act(() => cancelJointReversal(p.id, why, opId), () => 'Propuesta cancelada: no se asentó nada'); }} loading={saving}
                  disabled={why.trim().length < 3} data-testid="joint-cancel-confirm">Cancelar la propuesta</Button>
                <Button size="sm" variant="ghost" onClick={() => setCancelling(false)}>Volver</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Anulaciones conjuntas pendientes del contexto (las que debe confirmar y las que propuso). Nada si no hay. */
export function JointReversalsPanel() {
  const revision = useDataRevision();
  const [list, setList] = useState<JointProposal[]>([]);
  useEffect(() => {
    let alive = true;
    fetchJointReversals('pending').then((l) => { if (alive) setList(l); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [revision]);
  if (list.length === 0) return null;
  const mine = list.filter((p) => p.canConfirm);
  return (
    <section className="space-y-2" aria-labelledby="joint-h" data-testid="joint-panel">
      <h3 id="joint-h" className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Users className="w-4 h-4 text-gray-500" aria-hidden />
        Anulaciones conjuntas pendientes{mine.length > 0 ? <span className="text-xs font-medium text-amber-700">· {mine.length} esperan tu confirmación</span> : null}</h3>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">{list.map((p) => <JointProposalCard key={p.id} p={p} />)}</div>
    </section>
  );
}

/** Ventana con una propuesta (desde Notificaciones). */
export function JointProposalModal({ proposal, onClose }: { proposal: JointProposal | null; onClose: () => void }) {
  if (!proposal) return null;
  return (
    <Modal open onClose={onClose} size="lg" title="Anulación conjunta" footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}>
      <JointProposalCard p={proposal} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Operaciones recientes de la Base de MIS rutas (inyecciones, retiros, transferencias, entregas) con «Corregir».
// ---------------------------------------------------------------------------

interface OpRowView { id: string; kind: string; amountMinor: number; routeId: string | null; toRouteId: string | null; reason: string; entryDate: string;
  createdAt: string; reversesOperationId: string | null }
const OP_TEXT: Record<string, string> = {
  ROUTE_BASE_INJECTION: 'Inyección de Base', ROUTE_BASE_WITHDRAWAL: 'Retiro de Base', ROUTE_TRANSFER: 'Transferencia entre rutas',
  WORKER_DELIVERY: 'Entrega de Base a Cobrador', WORKER_RETURN: 'Devolución de Cobrador',
};

export function RecentBaseOperations({ routes, otherNames = [] }: { routes: { routeId: string; name: string }[]; otherNames?: { routeId: string; name: string }[] }) {
  const money = useMoney();
  const revision = useDataRevision();
  const [rows, setRows] = useState<OpRowView[] | null>(null);
  const [fixing, setFixing] = useState<CorrectionTarget | null>(null);
  const key = routes.map((r) => r.routeId).join(',');
  useEffect(() => {
    let alive = true;
    if (!routes.length) { setRows([]); return; }
    Promise.all(routes.map((r) => serverView<{ operations: OpRowView[] }>(`/v1/capital/operations?routeId=${encodeURIComponent(r.routeId)}&limit=60`).then((x) => x.operations).catch(() => [])))
      .then((all) => {
        if (!alive) return;
        const flat = new Map<string, OpRowView>();
        for (const o of all.flat()) flat.set(o.id, o);
        setRows([...flat.values()]);
      });
    return () => { alive = false; };
  }, [key, revision]);  // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string | null) => routes.find((r) => r.routeId === id)?.name ?? otherNames.find((r) => r.routeId === id)?.name ?? 'otra ruta';
  const reversed = new Set((rows ?? []).filter((o) => o.reversesOperationId).map((o) => o.reversesOperationId!));
  const list = (rows ?? []).filter((o) => o.kind in OP_TEXT && !o.reversesOperationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  if (!rows || list.length === 0) return null;
  return (
    <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" aria-labelledby="rb-recent-h" data-testid="rb-recent-ops">
      <h2 id="rb-recent-h" className="text-sm font-semibold text-gray-900 flex items-center gap-2"><History className="w-4 h-4 text-gray-500" aria-hidden />Operaciones recientes de tus rutas</h2>
      <p className="text-xs text-gray-600">Como responsable de capital corriges también lo que tú registraste. Si la operación toca la ruta de otro responsable, se propone una anulación conjunta.</p>
      <ul className="divide-y divide-gray-100">
        {list.map((o) => {
          const done = reversed.has(o.id);
          const title = `${OP_TEXT[o.kind]} · ${o.kind === 'ROUTE_TRANSFER' ? `${name(o.routeId)} → ${name(o.toRouteId)}` : name(o.routeId)}`;
          return (
            <li key={o.id} className="py-2 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between" data-testid={`rb-op-${o.id}`}>
              <div className="min-w-0">
                <p className="text-sm text-gray-900 break-words">{title}{done ? <span className="ml-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5 bg-red-50 text-red-700">Anulada</span> : null}</p>
                <p className="text-xs text-gray-500 break-words">{formatDate(o.entryDate)} · {o.reason}</p>
              </div>
              <div className="flex items-center gap-2 self-end sm:self-auto">
                {!done && <Button size="sm" variant="ghost" icon={<Undo2 className="w-3.5 h-3.5" />} onClick={() => setFixing({ kind: 'operation', id: o.id, title })} data-testid="rb-op-fix">Corregir</Button>}
                <span className={cn(num, 'text-sm font-bold', done ? 'text-gray-400 line-through' : 'text-gray-900')}>{money(o.amountMinor)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <CorrectionDialog target={fixing} onClose={() => setFixing(null)} />
    </section>
  );
}

/** Botón «Corregir» reutilizable (icono de deshacer). */
export function CorrectButton({ onClick, testId = 'corr-open' }: { onClick: () => void; testId?: string }) {
  return <Button size="sm" variant="ghost" onClick={onClick} icon={<RotateCcw className="w-3.5 h-3.5" />} data-testid={testId}>Anular</Button>;
}
