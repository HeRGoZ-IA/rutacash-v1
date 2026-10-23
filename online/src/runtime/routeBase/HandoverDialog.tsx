// ENTREGA CONTROLADA (O5, R74): el NUEVO responsable de la ruta cuenta la Base física y confirma.
// La Base se quedó con la ruta al cambiar de responsable; mientras no se confirma, la ruta está
// «en entrega» (sin inyecciones, retiros, entregas ni transferencias de salida; cobros y cuadres
// siguen). Una diferencia queda en el acta con una nota (≥ 10 caracteres); el libro no se toca.
// El esperado que se envía es el que la persona VIO: si cambió desde entonces, el servidor lo
// rechaza (SETTLEMENT_STALE) y la pantalla relee.

import { useEffect, useState } from 'react';
import { Handshake } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { useTenant } from '@/hooks/useTenant';
import { generateId } from '@/lib/utils';
import { toMajor, toMinor } from '../mappers.ts';
import { confirmHandover, fetchHandovers, type Handover } from './api.ts';
import { Notice, num, useMoney } from './parts.tsx';

export function HandoverDialog({ routeId, routeName, onClose, onDone }: {
  routeId: string | null; routeName?: string; onClose: () => void; onDone: () => void;
}) {
  const { currency } = useTenant();
  const money = useMoney();
  const [h, setH] = useState<Handover | null | undefined>(undefined);
  const [counted, setCounted] = useState(0);
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [opId, setOpId] = useState('');

  const load = () => {
    if (!routeId) return;
    setH(undefined);
    fetchHandovers({ routeId, status: 'pendiente' })
      .then((l) => { const x = l[0] ?? null; setH(x); setCounted(x ? toMajor(x.currentBaseMinor ?? 0) : 0); })
      .catch(() => setH(null));
  };
  useEffect(() => {
    if (!routeId) return;
    setTouched(false); setNote(''); setOpId(generateId());
    load();
  }, [routeId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const expected = h?.currentBaseMinor ?? 0;
  const countedMinor = toMinor(counted);
  const diff = countedMinor - expected;
  const needsNote = diff !== 0 && note.trim().length < 10;

  async function save() {
    if (!h || !routeId) return;
    if (!touched && counted === 0 && expected > 0) { toast.error('Escribe el valor que contaste.'); return; }
    if (needsNote) { toast.error('Hay diferencia: explica qué pasó (mínimo 10 caracteres).'); return; }
    setSaving(true);
    try {
      const r = await confirmHandover(routeId, { countedMinor, expectedSeenMinor: expected, note }, opId);
      toast.success(r.result === 'exacto' ? 'Entrega confirmada: el conteo coincide' : `Entrega confirmada con ${r.result} de ${money(Math.abs(r.differenceMinor))}`);
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error';
      toast.error(msg);
      if ((e as { code?: string }).code === 'SETTLEMENT_STALE') { setOpId(generateId()); load(); }
    } finally { setSaving(false); }
  }

  return (
    <Modal open={!!routeId} onClose={() => { if (!saving) onClose(); }} guarded={touched} size="mdPlus"
      title={`Recibir la ruta${routeName ? ` · ${routeName}` : ''}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={save} loading={saving} disabled={!h || needsNote} data-testid="handover-confirm">Confirmar conteo</Button></>}>
      <div className="space-y-4" data-testid="handover-dialog">
        {h === undefined ? (
          <div className="flex justify-center py-8"><div className="w-7 h-7 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : h === null ? (
          <Notice tone="gray">Esta ruta no tiene una entrega pendiente de confirmar.</Notice>
        ) : (
          <>
            <p className="text-sm text-gray-700 flex gap-2">
              <Handshake className="w-4 h-4 mt-0.5 text-violet-600 flex-shrink-0" aria-hidden />
              <span>Ahora eres el responsable de esta ruta. Cuenta el efectivo de la <b>Base</b> que recibes y confirma. La Base sigue siendo de la ruta: este conteo no mueve dinero, solo deja el acta.</span>
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl bg-gray-50 p-3">
                <dt className="text-xs text-gray-500">Base al iniciar la entrega</dt>
                <dd className={`${num} font-semibold text-gray-900`}>{money(h.baseAtStartMinor)}</dd>
              </div>
              <div className="rounded-xl bg-violet-50 p-3">
                <dt className="text-xs text-violet-800">Base esperada ahora</dt>
                <dd className={`${num} font-semibold text-violet-900`} data-testid="handover-expected">{money(expected)}</dd>
              </div>
            </dl>
            <MoneyInput label="Valor contado" currency={currency} value={counted} onValueChange={(v) => { setCounted(v); setTouched(true); }} required
              hint="El efectivo físico de la Base que recibes (no incluye lo que tienen los Cobradores)." />
            {diff !== 0 && (
              <Notice tone={diff < 0 ? 'amber' : 'sky'} testId="handover-diff">
                {diff < 0 ? 'Faltante' : 'Sobrante'} de <b className={num}>{money(Math.abs(diff))}</b> frente a lo esperado. Queda registrado en el acta; no se crea ningún movimiento.
              </Notice>
            )}
            <Textarea label={diff !== 0 ? 'Nota de la diferencia' : 'Nota (opcional)'} value={note} onChange={(e) => { setNote(e.target.value); setTouched(true); }} rows={2}
              required={diff !== 0} error={diff !== 0 && note.length > 0 && note.trim().length < 10 ? 'Mínimo 10 caracteres' : undefined} />
            <p className="text-xs text-gray-500">Mientras no confirmes, la ruta no admite inyecciones, retiros, entregas a Cobradores ni transferencias de salida. Los recaudos y los cuadres siguen.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
