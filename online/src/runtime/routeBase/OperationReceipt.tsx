// COMPROBANTE DE OPERACIÓN (R74): vista imprimible de UNA operación del libro del servidor, leída con el
// detalle de Consultas (`/v1/movements/detail`, mismo alcance por RLS: lo ajeno no se muestra). Sirve para los
// tipos que no existen en el historial de CLEAN (Inyección, Retiro y Transferencia de Base, reparto del saldo sin
// asignar, aportes a gastos generales, gasto con dinero propio, reembolsos) y, con Base por Ruta, para toda
// operación, con el vocabulario de la Base (nunca «bolsa» para el dinero de una ruta). La referencia es el id
// de la operación; no se genera otra. No afirma recepción física, firmas ni autorizaciones no registradas.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { useTenant } from '@/hooks/useTenant';
import { formatDateTime } from '@/lib/formatters';
import { formatClientName, formatPersonName } from '@/lib/displayName';
import { serverView } from '../projection.ts';
import { useRuntime } from '../session.ts';
import { ROLE_LABEL, STATUS_LABEL, fullDateTime, kindLabel, partyLabel, type Detail } from '../consultasModel.ts';
import { isRouteBaseUi, useCapitalModel } from './api.ts';
import { useMoney } from './parts.tsx';

export function OperationReceipt() {
  const { id = '' } = useParams();
  const { tenant } = useTenant();
  const me = useRuntime((s) => s.ctx);
  const money = useMoney();
  const rb = isRouteBaseUi(useCapitalModel());
  const [data, setData] = useState<Detail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    serverView<Detail>(`/v1/movements/detail?id=${encodeURIComponent(id)}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'No se pudo cargar el comprobante'); setData(null); } });
    return () => { alive = false; };
  }, [id]);

  if (data === undefined) return <div className="p-6 text-sm text-gray-500">Cargando…</div>;
  if (!data) {
    return (
      <div className="p-6 space-y-2" data-testid="receipt-missing">
        <p className="text-sm text-gray-700">{error ?? 'No existe una operación con esa referencia en tu alcance.'}</p>
        <Link to="/admin/consultas" className="text-sm text-primary-700 hover:underline">Volver a Consultas</Link>
      </div>
    );
  }
  const m = data.movement;
  const base = m.reversesKind ?? m.kind;
  const tz = m.timezone || me?.company.timezone || 'UTC';
  const c = data.contributions;
  const filas: [string, string][] = [
    ['Tipo de movimiento', kindLabel(m.kind, m.reversesKind, rb)],
    ['Fecha y hora del registro', `${fullDateTime(m.at, tz)} (${tz})`],
    ['Fecha contable', m.date],
    ['Importe', m.amountMinor == null ? '—' : money(m.amountMinor)],
    ['Origen', partyLabel(m.from, rb)],
    ['Destino', partyLabel(m.to, rb)],
    ['Registró', m.actor ? `${formatPersonName(m.actor.name ?? '') || 'Usuario'}${m.actorRole ? ` · ${ROLE_LABEL[m.actorRole] ?? m.actorRole}` : ''}` : 'No registrado'],
    ['Concepto / motivo', m.concept || 'No registrado'],
    ['Estado', STATUS_LABEL[m.status] ?? m.status],
    ...(m.route ? [['Ruta', `${m.route.name ?? '—'}${m.toRoute ? ` → ${m.toRoute.name ?? ''}` : ''}`] as [string, string]] : []),
    ...(m.route?.office ? [['Oficina', m.route.office] as [string, string]] : []),
    ...(m.worker ? [[rb ? 'Cobrador' : 'Trabajador', formatPersonName(m.worker.name ?? '') || 'Trabajador'] as [string, string]] : []),
    ...(m.client ? [['Cliente', formatClientName(m.client.name ?? '') || 'Cliente'] as [string, string]] : []),
    ...(m.admin && !['GENERAL_EXPENSE_OWN_MONEY', 'ADMIN_REIMBURSEMENT'].includes(base)
      ? [[rb ? 'Responsable de la ruta' : 'Bolsa / responsable de capital', formatPersonName(m.admin.name ?? '') || 'Administrador'] as [string, string]] : []),
    ...(base === 'ADMIN_REIMBURSEMENT' && m.admin ? [['Pagó', formatPersonName(m.admin.name ?? '') || 'Administrador'] as [string, string]] : []),
    ...(m.reversesOperationId ? [['Anula a la referencia', m.reversesOperationId] as [string, string]] : []),
    ...(m.reversedBy ? [['Anulado por la referencia', m.reversedBy] as [string, string]] : []),
  ];
  const note = base === 'GENERAL_EXPENSE_OWN_MONEY'
    ? 'Este gasto no movió efectivo: lo pagó el Administrador con dinero propio y quedó un saldo a su favor (obligación de la empresa), reembolsable.'
    : base === 'ADMIN_REIMBURSEMENT' ? 'Este reembolso paga una obligación con el Administrador; no vuelve a registrar el gasto.'
      : base === 'GENERAL_EXPENSE_CONTRIBUTION' ? 'Aporte de una ruta a un gasto general: el gasto existe una sola vez; cada ruta aportó desde su Base.' : null;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white py-6 px-4 print:p-0">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-card border border-gray-100 p-6 sm:p-8 print:shadow-none print:border-0 print:rounded-none" data-testid="receipt">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 pb-4">
          <div className="min-w-0">
            <BrandLogo className="h-10" />
            <p className="text-xs text-gray-500 mt-1">{tenant?.nombre ?? ''}</p>
          </div>
          <div className="text-right min-w-0">
            <p className="text-xs uppercase tracking-wide text-gray-500">Referencia</p>
            <p className="text-sm font-mono font-semibold text-gray-900 break-all" data-testid="receipt-ref">{m.id}</p>
          </div>
        </div>
        <h1 className="text-lg font-bold text-gray-900 mt-4" data-testid="receipt-title">Comprobante de movimiento registrado</h1>
        <dl className="mt-4 divide-y divide-gray-100 text-sm">
          {filas.map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 sm:grid-cols-3 gap-1 py-2">
              <dt className="text-gray-500">{k}</dt>
              <dd className="sm:col-span-2 text-gray-900 break-words" data-testid={`receipt-${k}`}>{v}</dd>
            </div>
          ))}
        </dl>
        {c && c.items.length > 0 && (
          <div className="mt-4" data-testid="receipt-contributions">
            <p className="text-sm font-semibold text-gray-900">{c.purpose === 'expense' ? 'Aportes de rutas al gasto general' : 'Aportes al reembolso'}</p>
            <ul className="mt-1 divide-y divide-gray-100 text-sm">
              {c.items.map((i) => (
                <li key={i.operationId} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0 break-words">{i.routeName ?? (i.routeId ? 'Ruta' : 'Desde la bolsa de quien pagó')}{i.operationId === m.id ? ' (esta operación)' : ''}</span>
                  <span className="tabular-nums whitespace-nowrap">{money(i.amountMinor)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 py-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{money(c.totalMinor)}</span></li>
            </ul>
          </div>
        )}
        {note && <p className="mt-4 text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2" data-testid="receipt-note">{note}</p>}
        <p className="mt-6 text-xs text-gray-600 border-t border-gray-100 pt-4" data-testid="receipt-disclaimer">
          Este comprobante acredita que el movimiento quedó registrado en ADEX Soluciones con la referencia indicada.
          No acredita la entrega ni la recepción física del efectivo, y no incluye firmas ni autorizaciones distintas de las registradas.
        </p>
        <p className="mt-1 text-[11px] text-gray-500">Generado el {formatDateTime(new Date().toISOString())} por {formatPersonName(me?.displayName)}.</p>
        <div className="mt-6 flex flex-wrap gap-2 print:hidden">
          <button type="button" onClick={() => window.print()}
            className="inline-flex items-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-primary-600 hover:bg-primary-700 text-white shadow-sm">
            <Printer className="w-4 h-4" /> Imprimir o guardar PDF
          </button>
          <Link to="/admin/consultas" className="inline-flex items-center h-9 px-4 text-sm font-medium rounded-lg bg-white hover:bg-gray-50 text-gray-700 border border-gray-300">Volver a Consultas</Link>
        </div>
      </div>
    </div>
  );
}
