// CAJA PRINCIPAL (Ronda 59): resumen de la caja de un Administrador con las cifras que calcula el
// servidor sobre su libro (`GET /v1/capital/summary`). Nada se calcula ni se completa aquí: una
// cifra que el servidor no da no se muestra. Sin conciliación parcial ni historiales: el detalle
// está en Consultas.

import { Link } from 'react-router-dom';
import { AlertTriangle, History, Receipt, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/formatters';
import { toMajor } from './mappers.ts';

export interface AdminPoolFigures {
  adminId: string; name: string; status: string;
  availableMinor: number; allocatedNetMinor: number; expensesPaidMinor: number;
  custodyUnderResponsibilityMinor: number; adminTransfersNetMinor?: number; pendingTransfersOutMinor?: number;
}

function Figure({ label, value, tone = 'text-gray-900', bg = 'bg-white border border-gray-100 shadow-card', testId }: { label: string; value: string; tone?: string; bg?: string; testId?: string }) {
  return (
    <div className={`${bg} rounded-xl p-3`} data-testid={testId}>
      <p className={`text-xs ${tone} opacity-80`}>{label}</p>
      <p className={`text-base font-bold ${tone}`}>{value}</p>
    </div>
  );
}

export function PoolSummary({ pool, currency, titular, onRegistrarGasto }: {
  pool: AdminPoolFigures; currency: string;
  /** Nombre del titular cuando la consulta el SuperAdmin. */
  titular?: string;
  onRegistrarGasto?: () => void;
}) {
  const money = (n: number) => formatCurrency(n, currency);
  const disponible = toMajor(pool.availableMinor);
  const negativo = disponible < 0;
  const traspasos = toMajor(pool.adminTransfersNetMinor ?? 0);
  const comprometido = toMajor(pool.pendingTransfersOutMinor ?? 0);
  return (
    <div className="space-y-4" data-testid="admin-pool">
      <section className={`rounded-2xl border p-4 sm:p-5 ${negativo ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100 shadow-card'}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0" data-testid="my-available">
            <p className="text-sm text-gray-600 flex items-center gap-1.5"><Wallet className="w-4 h-4 text-primary-600" aria-hidden />Capital disponible{titular ? ` · ${titular}` : ''}</p>
            <p className={`text-3xl font-bold tracking-tight ${negativo ? 'text-red-700' : 'text-gray-900'}`}>{money(disponible)}</p>
            {comprometido > 0 && <p className="text-xs text-amber-700">{money(comprometido)} comprometido en transferencias por confirmar</p>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {onRegistrarGasto && <Button variant="secondary" onClick={onRegistrarGasto} disabled={disponible <= 0} icon={<Receipt className="w-4 h-4" />}>Registrar gasto</Button>}
            <Link to={`/admin/consultas?adminId=${encodeURIComponent(pool.adminId)}`} data-testid="go-history"
              className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              <History className="w-4 h-4" aria-hidden />Ver movimientos
            </Link>
          </div>
        </div>
        {negativo && (
          <p className="mt-3 flex items-start gap-2 text-sm text-red-700" data-testid="pool-negative">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
            El disponible es negativo: hay una inconsistencia en los registros. Las operaciones que usan fondos quedan bloqueadas hasta revisarla con el SuperAdmin.
          </p>
        )}
      </section>
      <section className={`grid grid-cols-2 ${traspasos !== 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-2`} data-testid="my-capital">
        <Figure label="Capital recibido (neto)" value={money(toMajor(pool.allocatedNetMinor))} testId="pool-received" />
        <Figure label="A cargo de trabajadores" value={money(toMajor(pool.custodyUnderResponsibilityMinor))} tone="text-indigo-700" bg="bg-indigo-50" testId="pool-custody" />
        <Figure label="Gastos pagados" value={money(toMajor(pool.expensesPaidMinor))} tone="text-red-700" bg="bg-red-50" testId="pool-expenses" />
        {traspasos !== 0 && <Figure label="Transferencias con Administradores" value={`${traspasos > 0 ? '+' : '−'}${money(Math.abs(traspasos))}`} tone="text-primary-700" bg="bg-primary-50" testId="pool-transfers" />}
      </section>
    </div>
  );
}
