// SECRETARIO · transferencias entre Administradores (Ronda 53, solo ADEX Online).
//
// El Secretario registra una transferencia de capital que dos Administradores hicieron (o
// que él hizo por ellos fuera de ADEX). ADEX no toca cuentas bancarias: registra el hecho.
// Queda pendiente hasta que AMBOS Administradores confirmen desde su perfil; el Secretario
// no confirma por nadie y solo puede cancelar lo que él registró mientras esté pendiente.
import { useEffect, useState } from 'react';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTenant } from '@/hooks/useTenant';
import { useDataRevision } from '@/hooks/useDataRevision';
import { listAdminTransfers, STATE_LABEL, type AdminTransfer, type TransferState } from './adminTransfers.ts';
import { TransferCard, TransferDecisionModal, TransferRegisterModal } from './AdminTransferUI.tsx';

export default function SecretarioTransfersPage() {
  const { currency } = useTenant();
  const [transfers, setTransfers] = useState<AdminTransfer[] | null>(null);
  const [state, setState] = useState<'' | TransferState>('');
  const [form, setForm] = useState(false);
  const [decision, setDecision] = useState<{ t: AdminTransfer; what: 'confirm' | 'reject' | 'cancel' } | null>(null);
  const revision = useDataRevision();
  const load = () => listAdminTransfers().then(setTransfers).catch(() => setTransfers([]));
  useEffect(() => { void load(); }, [revision]);

  const pending = (transfers ?? []).filter((t) => t.state === 'pending');
  const others = (transfers ?? []).filter((t) => t.state !== 'pending' && (!state || t.state === state));

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900">Transferencias entre Administradores</h1>
        <Button onClick={() => setForm(true)} icon={<Plus className="w-4 h-4" />} data-testid="register-admin-transfer">Registrar transferencia</Button>
      </div>

      {transfers == null ? (
        <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : (
        <>
          <section className="space-y-3" data-testid="secretary-pending">
            <h2 className="text-sm font-semibold text-gray-900">Pendientes de confirmación ({pending.length})</h2>
            {pending.length === 0 ? <p className="text-sm text-gray-500">No hay transferencias pendientes.</p> : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pending.map((t) => <TransferCard key={t.id} t={t} currency={currency} onAction={(x, what) => setDecision({ t: x, what })} />)}
              </div>
            )}
          </section>
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900">Cerradas</h2>
              <div className="w-48">
                <Select label="Estado" value={state} onChange={(e) => setState(e.target.value as '' | TransferState)} placeholder="Todas"
                  options={(['applied', 'rejected', 'cancelled'] as const).map((s) => ({ value: s, label: STATE_LABEL[s] }))} />
              </div>
            </div>
            {others.length === 0 ? <EmptyState icon={<ArrowLeftRight className="w-8 h-8" />} title="Sin transferencias cerradas" /> : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {others.map((t) => <TransferCard key={t.id} t={t} currency={currency} />)}
              </div>
            )}
          </section>
        </>
      )}

      <TransferRegisterModal open={form} onClose={() => setForm(false)} onDone={() => { setForm(false); void load(); }} currency={currency} asSecretary />
      <TransferDecisionModal target={decision} currency={currency} onClose={() => setDecision(null)} onDone={() => { setDecision(null); void load(); }} />
    </div>
  );
}
