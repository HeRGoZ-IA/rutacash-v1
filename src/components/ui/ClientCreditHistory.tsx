// ============================================================
// HISTORIAL DE CRÉDITOS DEL CLIENTE — COMPONENTE COMPARTIDO
// ------------------------------------------------------------
// Una sola vista para todas las áreas administrativas (Admin/Super Admin,
// Secretario, Socio). Antes cada pantalla armaba su propio resumen y mostraban
// cosas distintas; ahora todas consumen `buildClientCreditHistory`.
//
// Consulta SIEMPRE por `clientId` (nunca por nombre ni documento) y respeta el
// scoping: recibe ya filtradas las ventas y los pagos de rutas accesibles, y
// además comprueba `sale.viewHistory` sobre la ruta del cliente (fail-closed).
// ============================================================
import { useEffect, useState } from 'react'
import { History, Lock } from 'lucide-react'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can, filterByAccessibleRoute } from '@/lib/permissions'
import { buildClientCreditHistory, type ClientCreditHistory } from '@/lib/creditHistory'
import { formatCurrency, formatDate } from '@/lib/formatters'
import type { Client } from '@/models/types'

interface Props {
  /** Cliente cuyo historial se consulta. El cruce es por `client.id`. */
  client: Pick<Client, 'id' | 'nombre' | 'documento' | 'routeId'>
  /** Título opcional de la sección. */
  title?: string
}

export function ClientCreditHistory({ client, title = 'Historial de créditos' }: Props) {
  const { user } = useAuth()
  const { currency } = useTenant()
  const [history, setHistory] = useState<ClientCreditHistory | null>(null)
  const [loading, setLoading] = useState(true)

  // Fail-closed: además del recorte por rutas, se exige la capacidad sobre la ruta
  // del cliente. Sin ella no se consulta nada.
  const allowed = can(user, 'sale.viewHistory', { routeId: client.routeId, tenantId: user?.tenantId })

  useEffect(() => {
    let alive = true
    if (!user || !allowed) { setHistory(null); setLoading(false); return }
    setLoading(true)
    Promise.all([
      db.sales.where('clientId').equals(client.id).toArray(),
      db.payments.where('clientId').equals(client.id).toArray(),
    ]).then(([sales, payments]) => {
      if (!alive) return
      // RESTRICCIÓN POR RUTAS antes de agregar nada.
      const misVentas = filterByAccessibleRoute(user, sales.filter(s => s.tenantId === user.tenantId))
      const misPagos = filterByAccessibleRoute(user, payments.filter(p => p.tenantId === user.tenantId))
      setHistory(buildClientCreditHistory(client.id, misVentas, misPagos))
      setLoading(false)
    })
    return () => { alive = false }
  }, [user, allowed, client.id])

  if (!allowed) {
    return (
      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl text-xs text-gray-500">
        <Lock className="w-3.5 h-3.5" /> No tienes permiso para ver el historial de créditos de este cliente.
      </div>
    )
  }

  if (loading) return <p className="text-xs text-gray-400">Cargando historial…</p>

  if (!history || history.total === 0) {
    return (
      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl text-xs text-gray-500">
        <History className="w-3.5 h-3.5" /> Este cliente no tiene créditos registrados.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</p>
        <p className="text-xs text-gray-400">
          {history.total} crédito(s) · {history.activos} activo(s) · {history.finalizados} finalizado(s)
          {history.perdidos > 0 ? ` · ${history.perdidos} perdido(s)` : ''}
          {history.refinanciados > 0 ? ` · ${history.refinanciados} refinanciado(s)` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Mini label="Créditos" value={String(history.total)} />
        <Mini label="Total prestado" value={formatCurrency(history.totalPrestado, currency)} />
        <Mini label="Total abonado" value={formatCurrency(history.totalAbonado, currency)} tone="text-emerald-600" />
        <Mini label="Saldo pendiente" value={formatCurrency(history.saldoPendiente, currency)} tone="text-amber-600" />
      </div>

      <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-3 py-2">Valor del crédito</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Fecha de creación</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Fin estimado</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Finalización real</th>
              <th className="text-left px-3 py-2">Estado</th>
              <th className="text-right px-3 py-2">Abonado</th>
              <th className="text-right px-3 py-2">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {history.entries.map(e => (
              <tr key={e.saleId} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{formatCurrency(e.valorVenta, currency)}</td>
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatDate(e.fechaInicio)}</td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDate(e.fechaFinEstimada)}</td>
                {/* "—" cuando no hay fecha REAL: activo, perdido, refinanciado o
                    histórico sin pago del que inferirla. Nunca se rellena con la estimada. */}
                <td className="px-3 py-2 whitespace-nowrap">
                  {e.fechaFinalizacion
                    ? <span className="text-emerald-700 font-medium">{formatDate(e.fechaFinalizacion)}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${estadoTone(e.status)}`}>{e.estado}</span>
                </td>
                <td className="px-3 py-2 text-right text-emerald-600 whitespace-nowrap">{formatCurrency(e.totalAbonado, currency)}</td>
                <td className="px-3 py-2 text-right text-amber-600 whitespace-nowrap">{formatCurrency(e.saldo, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function estadoTone(status: string): string {
  switch (status) {
    case 'activa': return 'bg-primary-100 text-primary-700'
    case 'finalizada': return 'bg-emerald-100 text-emerald-700'
    case 'perdida': return 'bg-red-100 text-red-600'
    case 'refinanciada': return 'bg-amber-100 text-amber-700'
    default: return 'bg-gray-100 text-gray-600'
  }
}

function Mini({ label, value, tone = 'text-gray-800' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-2.5">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-sm font-semibold ${tone}`}>{value}</p>
    </div>
  )
}
