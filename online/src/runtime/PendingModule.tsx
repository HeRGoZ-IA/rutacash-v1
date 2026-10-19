// Módulo de CLEAN todavía NO conectado al servidor. En vez de mostrar la pantalla
// original con cifras vacías o calculadas en el navegador (que parecerían reales), se
// explica qué falta y, si existe, se enlaza la pantalla Online de transición que sí
// opera contra la API. Mismo marco visual que la pantalla informativa original de CLEAN
// (AdminNoRoutes): tarjeta ámbar + tarjeta blanca.

import { Clock } from 'lucide-react';

export interface PendingInfo {
  title: string;
  /** Qué hace la pantalla en CLEAN. */
  what: string;
  /** Estado frente al servidor (clasificación del informe). */
  status: 'server-no-ui' | 'not-in-server' | 'partial';
  detail: string;
  /** Pantalla Online de transición equivalente (bajo /operaciones). */
  transition?: { href: string; label: string };
}

const STATUS: Record<PendingInfo['status'], string> = {
  'server-no-ui': 'Implementado en el servidor; falta conectarlo a esta pantalla original.',
  'not-in-server': 'No implementado todavía en el servidor.',
  partial: 'Parcialmente disponible en el servidor.',
};

export function PendingModule({ info }: { info: PendingInfo }) {
  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Clock className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-lg font-bold text-gray-900">{info.title}: pendiente de conexión</h1>
        <p className="text-sm text-gray-600 mt-2">{info.what}</p>
        <p className="text-xs text-amber-700 font-medium mt-3">{STATUS[info.status]}</p>
      </div>

      <div className="bg-white border border-gray-100 shadow-card rounded-2xl p-5">
        <h2 className="font-semibold text-gray-900 text-sm mb-2">Situación en ADEX Online</h2>
        <p className="text-sm text-gray-600">{info.detail}</p>
        {info.transition && (
          <a
            href={info.transition.href}
            className="mt-4 inline-flex items-center justify-center h-10 px-4 bg-primary-600 hover:bg-primary-700 text-white rounded-xl font-medium text-sm transition-colors"
          >
            {info.transition.label}
          </a>
        )}
        <p className="text-xs text-gray-400 mt-3">
          No se muestran cifras calculadas en el navegador ni se guarda nada en el dispositivo: el servidor es la única fuente financiera.
        </p>
      </div>
    </div>
  );
}
