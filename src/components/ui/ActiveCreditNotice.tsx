import { AlertTriangle, Info } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { CREDIT_STATUS_LABEL } from '@/lib/creditHistory'
import type { ActiveCreditContext, ActiveCreditContextItem } from '@/lib/activeCreditContext'

/**
 * Aviso de crédito activo en el detalle de una solicitud (punto 2, ajustes del socio
 * 2026-10-02). Muestra el estado ACTUAL de cada crédito y, solo cuando difiere, lo
 * que había al solicitar. Sin contexto (`null`) no se renderiza nada.
 */
export function ActiveCreditNotice({ context, currency, routeName }: {
  context: ActiveCreditContext | null
  currency: string
  routeName: (routeId: string) => string | undefined
}) {
  if (!context) return null
  const activos = context.activeNowCount
  const alerta = activos > 0
  const titulo = alerta
    ? (activos === 1 ? 'Cliente con crédito activo' : `Cliente con ${activos} créditos activos`)
    : 'Solicitada con crédito activo · hoy ya no está activo'
  const money = (v: number) => formatCurrency(v, currency)

  return (
    <div data-testid="active-credit-notice"
      className={`rounded-xl border p-3 ${alerta ? 'bg-amber-50 border-amber-100' : 'bg-gray-50 border-gray-200'}`}>
      <div className="flex items-start gap-2">
        {alerta
          ? <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          : <Info className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />}
        <div className="min-w-0 flex-1 space-y-2">
          <p className={`text-sm font-semibold ${alerta ? 'text-amber-800' : 'text-gray-700'}`}>{titulo}</p>
          <ul className="space-y-1.5">
            {context.items.map(i => <Row key={i.saleId} item={i} money={money} routeName={routeName} />)}
          </ul>
        </div>
      </div>
    </div>
  )
}

function Row({ item, money, routeName }: {
  item: ActiveCreditContextItem
  money: (v: number) => string
  routeName: (routeId: string) => string | undefined
}) {
  const { current, snapshot } = item
  const estado = current ? CREDIT_STATUS_LABEL[current.status] : undefined
  const notas = [
    !item.atRequest && 'posterior a la solicitud',
    item.saldoChanged && snapshot && `al solicitar: saldo ${money(snapshot.saldo)}`,
  ].filter(Boolean).join(' · ')

  return (
    <li className="text-xs rounded-lg bg-white/70 px-2.5 py-1.5">
      {current ? (
        <>
          <div className="flex justify-between gap-2">
            <span className="text-gray-700 truncate">
              {money(current.valorVenta)} · {routeName(current.routeId) ?? 'Ruta'}
            </span>
            <span className={`font-medium whitespace-nowrap ${item.activeNow ? 'text-amber-700' : 'text-gray-500'}`}>{estado}</span>
          </div>
          <p className="text-gray-500">Saldo {money(current.saldo)} de {money(current.valorTotal)} · desde {formatDate(current.fechaInicio)}</p>
        </>
      ) : item.restricted ? (
        <p className="text-gray-700">{item.activeNow ? 'Crédito activo' : 'Crédito'} en una ruta fuera de tu alcance</p>
      ) : (
        <p className="text-gray-700">
          Crédito no disponible{snapshot ? ` · al solicitar: saldo ${money(snapshot.saldo)} de ${money(snapshot.valorTotal)}` : ''}
        </p>
      )}
      {notas && <p className="text-gray-400">{notas}</p>}
    </li>
  )
}
