import { formatCurrency } from '@/lib/formatters'
import { CAPITAL_FLOW_LABELS, type CapitalFlowBreakdown } from '@/lib/capitalFlowBreakdown'

/**
 * DETALLE DE "INGRESO CAPITAL" Y "RETIROS" (C2). Solo presenta el desglose de
 * `getCapitalFlowBreakdown`, cuyas sumas son exactamente los totales de la caja. Se
 * muestra cuando hay registros del capital centralizado: un retorno de cuadre o un
 * cobro por transferencia no se confunde con un retiro voluntario.
 */
export function CapitalFlowDetail({ breakdown, currency }: { breakdown: CapitalFlowBreakdown | null; currency: string }) {
  if (!breakdown?.hayCentralizados) return null
  const money = (n: number) => formatCurrency(n, currency)
  const filas = (grupo: 'capital' | 'retiros') =>
    (Object.keys(breakdown[grupo]) as (keyof CapitalFlowBreakdown[typeof grupo])[])
      .filter(k => (breakdown[grupo] as Record<string, number>)[k] !== 0)
      .map(k => ({ label: (CAPITAL_FLOW_LABELS[grupo] as Record<string, string>)[k], valor: (breakdown[grupo] as Record<string, number>)[k] }))
  const bloques = [
    { titulo: 'Detalle de las entregas de Base', filas: filas('capital') },
    { titulo: 'Detalle de las devoluciones de Base', filas: filas('retiros') },
  ].filter(b => b.filas.length > 0)
  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden" data-testid="capital-flow-detail">
      {bloques.map(b => (
        <div key={b.titulo} className="divide-y divide-gray-50">
          <p className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600">{b.titulo}</p>
          {b.filas.map(f => (
            <div key={f.label} className="flex items-center justify-between px-4 py-2">
              <span className="text-sm text-gray-600">{f.label}</span>
              <span className="text-sm font-semibold text-gray-800">{money(f.valor)}</span>
            </div>
          ))}
        </div>
      ))}
      <p className="px-4 py-2 text-[11px] text-gray-500">Las devoluciones, el efectivo entregado en cuadres y el recaudo no en efectivo salen de la Base del trabajador hacia la Base disponible de la ruta (antes de Base por Ruta, hacia el saldo del Administrador responsable); no son retiros.</p>
    </div>
  )
}
