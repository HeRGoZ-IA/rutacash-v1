// UBICACIÓN DE REFERENCIA DEL CLIENTE en la ficha del Cobrador y del Supervisor (Ronda 67).
//
// Estando en el lugar del cliente, la persona pulsa «Estoy en el lugar del cliente»: se toma UNA
// lectura del GPS del dispositivo y (Ronda 73 · SOC-06) se MUESTRA su precisión antes de guardar;
// solo «Guardar esta ubicación» la registra como referencia con su origen («GPS en el lugar»), su
// precisión y quién la tomó (auditado; la anterior queda en el historial, visible aquí).
// Nada se guarda automáticamente: un abono o una venta registrados en otro sitio nunca mueven al
// cliente. Solo con conexión (no hay registro de ubicación sin internet) y sin seguimiento.

import { useEffect, useState } from 'react';
import { Crosshair, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/formatters';
import { captureLocation, GEO_STATUS_LABEL } from '@/lib/geolocation';
import { generateId } from '@/lib/utils';
import { api } from './session.ts';
import { money } from './commands.ts';

interface Current { source: 'gps_on_site' | 'map_pin'; setAt: string; setByName: string | null; accuracyM: number | null; note?: string | null }
interface Reading { lat: number; lng: number; accuracyM: number | null; capturedAt: string | null }
/** Por encima de esta precisión se advierte antes de guardar (la lectura podría no ser la del lugar). */
const POOR_ACCURACY_M = 100;

export function ClientReferenceLocation({ clientId, canSet }: { clientId: string; canSet: boolean }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [history, setHistory] = useState<Current[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [reading, setReading] = useState<Reading | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api().get<{ current: Current | null; history?: Current[] }>(`/v1/clients/${encodeURIComponent(clientId)}/location`);
      setCurrent(r.current); setHistory(r.history ?? []); setState('ready');
    } catch {
      setState('unavailable');
    }
  };
  useEffect(() => { void load(); }, [clientId]);

  // Paso 1: una lectura del GPS (nada se guarda todavía).
  const read = async () => {
    setBusy(true);
    try {
      const g = await captureLocation();
      if (g.status !== 'captured' || g.lat == null || g.lng == null) {
        toast.error(`${GEO_STATUS_LABEL[g.status]}. No se guardó ninguna ubicación.`);
        return;
      }
      setReading({ lat: g.lat, lng: g.lng, accuracyM: g.accuracyM ?? null, capturedAt: g.capturedAt ?? null });
    } finally {
      setBusy(false);
    }
  };

  // Paso 2: guardar la lectura que la persona vio y confirmó.
  const save = async () => {
    if (!reading) return;
    setBusy(true);
    try {
      await money('POST', `/v1/clients/${encodeURIComponent(clientId)}/location`, {
        source: 'gps_on_site', lat: reading.lat, lng: reading.lng, ...(reading.accuracyM != null ? { accuracyM: reading.accuracyM } : {}),
        ...(reading.capturedAt ? { capturedAt: reading.capturedAt } : {}),
      }, generateId());
      toast.success('Ubicación del cliente guardada.');
      setConfirm(false); setReading(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2" data-testid="client-reference-location">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Ubicación del cliente</p>
      {state === 'loading' && <p className="text-sm text-gray-400">Consultando…</p>}
      {state === 'unavailable' && <p className="text-sm text-gray-500">Disponible con conexión a internet.</p>}
      {state === 'ready' && (current
        ? <p className="text-sm text-gray-700"><MapPin className="inline w-4 h-4 mr-1 text-emerald-600" />Registrada ({current.source === 'gps_on_site' ? 'GPS en el lugar' : 'marcada en el mapa'}
            {current.setByName ? `, por ${current.setByName}` : ''}, {formatDate(current.setAt)}{current.accuracyM != null ? `, ±${current.accuracyM} m` : ''}).</p>
        : <p className="text-sm text-amber-700">Sin ubicación registrada.</p>)}
      {state === 'ready' && canSet && (
        <Button variant="secondary" size="sm" icon={<Crosshair className="w-3.5 h-3.5" />} onClick={() => setConfirm(true)} data-testid="client-location-set">
          Estoy en el lugar del cliente
        </Button>
      )}
      {state === 'ready' && history.length > 1 && (
        <button type="button" className="block text-xs text-primary-700 hover:underline" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
          {showHistory ? 'Ocultar historial' : `Ver historial (${history.length})`}
        </button>
      )}
      {showHistory && (
        <ul className="text-xs text-gray-600 space-y-0.5" data-testid="client-location-history">
          {history.map((h, i) => (
            <li key={i}>{formatDate(h.setAt)} · {h.source === 'gps_on_site' ? 'GPS en el lugar' : 'marcada en el mapa'}{h.accuracyM != null ? ` ±${h.accuracyM} m` : ''}{h.setByName ? ` · ${h.setByName}` : ''}</li>
          ))}
        </ul>
      )}
      <Modal open={confirm} onClose={() => { if (!busy) { setConfirm(false); setReading(null); } }} title="Guardar ubicación del cliente" size="sm"
        footer={reading
          ? <><Button variant="secondary" onClick={() => void read()} disabled={busy}>Repetir lectura</Button><Button onClick={() => void save()} loading={busy} data-testid="client-location-save">Guardar esta ubicación</Button></>
          : <><Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancelar</Button><Button onClick={() => void read()} loading={busy} data-testid="client-location-confirm">Tomar mi ubicación actual</Button></>}>
        <div className="space-y-2 text-sm">
          {!reading ? (
            <>
              <p>Confirme que está <b>en el lugar donde se atiende a este cliente</b>. Se tomará una sola lectura del GPS de este dispositivo; podrá revisarla antes de guardarla.</p>
              {current && <p className="text-amber-700">Sustituye a la ubicación actual; la anterior queda en el historial.</p>}
              <p className="text-gray-500">Si no está en el lugar, no la guarde: la oficina puede marcarla en el mapa.</p>
            </>
          ) : (
            <>
              <p data-testid="client-location-reading">Lectura tomada: precisión <b>{reading.accuracyM != null ? `±${Math.round(reading.accuracyM)} m` : 'desconocida'}</b>.</p>
              {(reading.accuracyM == null || reading.accuracyM > POOR_ACCURACY_M) && (
                <p className="text-amber-700">La precisión es baja: acérquese a un lugar abierto y repita la lectura, o deje que la oficina la marque en el mapa.</p>
              )}
              <p className="text-gray-500">Se guardará como «GPS en el lugar», con su nombre y la fecha.</p>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
