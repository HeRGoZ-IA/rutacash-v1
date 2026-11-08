// 3.28 (0053, decisión del propietario 2026-11-08): la Liquidación muestra, en una LÍNEA APARTE, el capital de las ventas
// dadas por perdidas en el periodo (neto de deshacer y de lo recuperado). No es efectivo: no entra en la Base del
// trabajador de arriba; baja el resultado del periodo. Cifra del servidor: `route_period_figures.credit.creditLossMinor`.
import { useEffect, useState } from 'react'
import { formatCurrency } from '@/lib/formatters'
import { serverView } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'

export function CreditLossNote({ routeId, from, to, currency }: { routeId: string; from: string; to: string; currency?: string }) {
  const [loss, setLoss] = useState(0)
  useEffect(() => {
    let alive = true
    if (!routeId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) { setLoss(0); return }
    serverView<{ credit?: { creditLossMinor?: number } }>(`/v1/periods/liquidation?routeId=${encodeURIComponent(routeId)}&from=${from}&to=${to}`)
      .then((f) => { if (alive) setLoss(Number(f.credit?.creditLossMinor ?? 0)) })
      .catch(() => { if (alive) setLoss(0) })
    return () => { alive = false }
  }, [routeId, from, to])
  if (!loss) return null
  return (
    <div className="bg-white rounded-2xl shadow-card border border-red-100 px-4 py-3.5 flex items-start justify-between gap-3" data-testid="liquidation-credit-loss">
      <div>
        <p className="text-sm font-semibold text-gray-800">Pérdida por créditos (capital)</p>
        <p className="text-xs text-gray-500 mt-0.5">Ventas dadas por perdidas en el periodo, menos lo recuperado. No es efectivo: no cambia la Base; baja el resultado.</p>
      </div>
      <span className="text-base font-bold text-red-600 whitespace-nowrap">{formatCurrency(toMajor(loss), currency)}</span>
    </div>
  )
}
