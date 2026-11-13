// 3.45 (decisión del propietario 2026-11-13): PIN de bloqueo de la app del Cobrador, en Configuración.
// Lo definen y cambian el SuperAdmin y el Administrador (`settings.access`). Uno para toda la empresa; inicial 0000.
// Mientras siga en 0000 se muestra un aviso (aquí y arriba en la oficina, `CollectorPinNotice`).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, AlertTriangle } from 'lucide-react';
import { create } from 'zustand';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toast';
import { api, useRuntime } from './session.ts';

/** null = sin saber todavía (o sin permiso); true = sigue en 0000. */
const usePinDefault = create<{ isDefault: boolean | null }>(() => ({ isDefault: null }));

async function loadPinDefault(): Promise<void> {
  try {
    const c = await api().get<{ collectorPinIsDefault?: boolean }>('/v1/company');
    usePinDefault.setState({ isDefault: typeof c.collectorPinIsDefault === 'boolean' ? c.collectorPinIsDefault : null });
  } catch { usePinDefault.setState({ isDefault: null }); }
}

const canManage = (role: string | undefined) => role === 'superadmin' || role === 'admin';

export function CollectorPinCard() {
  const role = useRuntime((s) => s.ctx?.role);
  const isDefault = usePinDefault((s) => s.isDefault);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (canManage(role)) void loadPinDefault(); }, [role]);
  if (!canManage(role)) return null;

  const valid = /^[0-9]{4}$/.test(pin);
  async function save() {
    if (!valid) { toast.error('El PIN debe tener exactamente 4 números.'); return; }
    if (pin !== confirm) { toast.error('El PIN y su confirmación no coinciden.'); return; }
    setSaving(true);
    try {
      const r = await api().send<{ collectorPinIsDefault: boolean }>('PUT', '/v1/company/collector-pin', { pin });
      usePinDefault.setState({ isDefault: r.collectorPinIsDefault });
      setPin(''); setConfirm('');
      toast.success(r.collectorPinIsDefault ? 'El PIN volvió al valor inicial 0000.' : 'PIN guardado. Los Cobradores lo reciben la próxima vez que tengan señal.');
    } catch {
      toast.error('No se pudo guardar el PIN. Revisa la conexión e inténtalo de nuevo.');
    } finally { setSaving(false); }
  }

  const digits = (v: string) => v.replace(/[^0-9]/g, '').slice(0, 4);
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5 space-y-4" data-testid="collector-pin-card">
      <h2 className="font-semibold text-gray-800 flex items-center gap-2"><KeyRound className="w-4 h-4" /> PIN de bloqueo de la app del Cobrador</h2>
      <p className="text-sm text-gray-600">
        Si el Cobrador deja la app 10 minutos sin usar, se tapa con una pantalla que no muestra nada de ADEX. Se abre con este PIN,
        que es el mismo para todos los Cobradores de la empresa. Con 5 intentos fallidos se cierra la sesión y hay que volver a
        entrar con usuario y contraseña.
      </p>
      {isDefault === true && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" data-testid="collector-pin-default">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>El PIN sigue siendo el inicial <b>0000</b>. Cámbialo por uno que solo conozcan tus Cobradores.</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input label="PIN nuevo (4 números)" type="password" inputMode="numeric" autoComplete="off" maxLength={4}
          value={pin} onChange={(e) => setPin(digits(e.target.value))} data-testid="collector-pin-new" />
        <Input label="Confirmar PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={4}
          value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} data-testid="collector-pin-confirm" />
      </div>
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-100">
        <p className="text-xs text-gray-500">Los Cobradores reciben el PIN nuevo la próxima vez que la app tenga señal.</p>
        <Button onClick={() => void save()} loading={saving} disabled={!valid || confirm.length !== 4} data-testid="collector-pin-save">Guardar PIN</Button>
      </div>
    </div>
  );
}

/** Aviso en la oficina mientras el PIN siga en 0000 (solo SuperAdmin y Administrador). */
export function CollectorPinNotice({ settingsPath }: { settingsPath: string }) {
  const role = useRuntime((s) => s.ctx?.role);
  const isDefault = usePinDefault((s) => s.isDefault);
  useEffect(() => { if (canManage(role)) void loadPinDefault(); }, [role]);
  if (!canManage(role) || isDefault !== true) return null;
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800 flex items-center gap-2" data-testid="collector-pin-notice">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span>El PIN de bloqueo de la app del Cobrador sigue en 0000. <Link to={settingsPath} className="font-semibold underline">Cámbialo en Configuración</Link>.</span>
    </div>
  );
}
