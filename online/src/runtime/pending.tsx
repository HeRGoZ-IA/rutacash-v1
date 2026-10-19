// Inventario de módulos de CLEAN aún no conectados en esta primera entrega, con su
// situación real frente al servidor (revalidada contra `saas/src/http/companyApi.ts`).

import { useNavigate } from 'react-router-dom';
import { Clock, LogOut, Repeat } from 'lucide-react';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { ROLE_LABELS } from '@/lib/permissions';
import { useAuth } from '@/hooks/useAuth';
import type { PendingInfo } from './PendingModule.tsx';
import { leaveContext } from './session.ts';

const T = (path: string, label: string) => ({ href: `/operaciones${path}`, label });

export const PENDING = {
  paymentAdjustments: {
    title: 'Ajustes de pago',
    what: 'Solicitudes de corrección de pagos en periodos cerrados, que aprueba un Administrador o el Super Admin.',
    status: 'not-in-server',
    detail: 'El servidor anula recaudos (POST /v1/collections/:id/reverse) pero no tiene solicitudes de ajuste con aprobación. La anulación directa está en Recaudos (transición).',
    transition: T('/app/recaudos', 'Abrir Recaudos (transición)'),
  },
  partnerCash: {
    title: 'Caja de socios',
    what: 'Ingresos y salidas de la caja de cada socio.',
    status: 'partial',
    detail: 'El servidor registra aportes de socio a una ruta (POST /v1/capital/partner-contributions) pero no tiene la caja de socios de CLEAN (pendiente de decisión D1).',
  },
  cashbox: {
    title: 'Caja',
    what: 'Caja diaria por ruta: Base, recaudo, desembolsos y gastos del día.',
    status: 'server-no-ui',
    detail: 'El servidor calcula la liquidación por ruta y rango (GET /v1/periods/liquidation) y la custodia por trabajador. Falta adaptar la pantalla original a esas cifras. Disponible en Cierres (transición).',
    transition: T('/app/cierres', 'Abrir Cierres (transición)'),
  },
  reports: {
    title: 'Reportes',
    what: 'Reportes de cartera, recaudo, mora y gastos con exportación.',
    status: 'not-in-server',
    detail: 'El servidor no tiene todavía endpoints de reportes (cartera con interés, mora por ruta, exportaciones). No se calculan en el navegador.',
  },
  weeklySettlement: {
    title: 'Liquidación',
    what: 'Liquidación semanal por ruta y cierre del periodo.',
    status: 'server-no-ui',
    detail: 'El servidor liquida y cierra periodos (GET /v1/periods/liquidation, POST /v1/periods/close) y cuadra trabajadores (/v1/settlements). Falta conectar la pantalla original. Disponible en Cierres y Cuadres (transición).',
    transition: T('/app/cierres', 'Abrir Cierres (transición)'),
  },
} satisfies Record<string, PendingInfo>;

/** Roles cuya interfaz CLEAN aún no se ha convertido en esta entrega. */
export function RoleConversionPending() {
  const { user, tenant, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <BrandLogo variant="primary" className="h-11 -ml-1" />
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
          <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Clock className="w-7 h-7 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">Interfaz de {user ? ROLE_LABELS[user.rol] : ''} en conversión</h1>
          <p className="text-sm text-gray-600 mt-2">
            Esta primera entrega convierte el panel del Super Admin. Mientras tanto, las operaciones de este rol siguen disponibles en las pantallas Online de transición, conectadas al servidor.
          </p>
          <p className="text-xs text-gray-400 mt-3">{tenant?.nombre} · {user?.nombre}</p>
        </div>
        <a href="/operaciones/app" className="flex items-center justify-center h-11 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium text-sm transition-colors">
          Abrir operaciones (transición)
        </a>
        <div className="flex gap-2">
          <button onClick={() => void leaveContext().then(() => navigate('/contexto'))} className="flex-1 flex items-center justify-center gap-2 h-10 text-gray-600 hover:bg-gray-100 rounded-xl text-sm transition-colors">
            <Repeat className="w-4 h-4" /> Cambiar empresa o rol
          </button>
          <button onClick={() => { logout(); navigate('/login'); }} className="flex-1 flex items-center justify-center gap-2 h-10 text-gray-600 hover:bg-gray-100 rounded-xl text-sm transition-colors">
            <LogOut className="w-4 h-4" /> Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}
