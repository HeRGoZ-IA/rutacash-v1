// CONSULTAS (Ronda 59): la pestaña «Caja» pasa a ser el lugar ÚNICO de exploración histórica de
// DINERO. Las demás pantallas operan o resumen y enlazan aquí («Ver movimientos»).
//
//   Movimientos      Ronda 73 (SOC-08): TABLA con filtros en los encabezados, una fila por operación
//                    lógica y eventos sin dinero (`GET /v1/movements`, paginada en el servidor)
//   Comprobantes     el historial anterior (copia de CLEAN) con sus comprobantes, sin la fila espejo
//   Transferencias   entregas, devoluciones y traspasos (también entre Administradores)
//   Caja por ruta    resumen del periodo de una ruta
//
// La vista va en la URL (`?vista=`), junto con los filtros del historial: los enlaces de otras
// pantallas llegan ya filtrados (p. ej. `?adminId=…` o `?referencia=…`).

import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { MovementsPanel } from './ConsultasMovements.tsx';
import { MovementsTable } from './MovementsTable.tsx';
import { TransfersHistory } from './TransfersHistory.tsx';
import { CashboxPanel } from './ConsultasCashbox.tsx';

const VIEWS = [
  { id: 'movimientos', label: 'Movimientos' },
  { id: 'comprobantes', label: 'Comprobantes' },
  { id: 'transferencias', label: 'Transferencias' },
  { id: 'caja', label: 'Caja por ruta' },
] as const;
type View = (typeof VIEWS)[number]['id'];

export default function ConsultasPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('vista');
  const view: View = VIEWS.some((v) => v.id === raw) ? (raw as View) : 'movimientos';
  const choose = (id: View) => {
    // Al cambiar de vista se limpian los filtros del historial (cada vista tiene los suyos).
    setParams(id === 'movimientos' ? new URLSearchParams() : new URLSearchParams({ vista: id }), { replace: true });
  };
  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="consultas-page">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Consultas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Movimientos, caja por ruta, historial y filtros</p>
        </div>
        <div className="inline-flex w-full sm:w-auto rounded-xl border border-gray-200 bg-white p-1 shadow-sm" role="group" aria-label="Vista de Consultas">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => choose(v.id)} aria-pressed={view === v.id} data-testid={`vista-${v.id}`}
              className={cn('flex-1 sm:flex-none min-h-[40px] px-2 sm:px-3 rounded-lg text-[13px] sm:text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                view === v.id ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-50')}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'movimientos' ? <MovementsTable /> : view === 'comprobantes' ? <MovementsPanel /> : view === 'transferencias' ? <TransfersHistory /> : <CashboxPanel />}
    </div>
  );
}
