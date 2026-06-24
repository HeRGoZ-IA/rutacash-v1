import { useState, useEffect } from 'react'
import { Banknote, CheckCircle } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { confirmDisbursement } from '@/services/saleRequestService'
import type { Sale, Client } from '@/models/types'

export default function CollectorDisbursementsPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [sales, setSales] = useState<Sale[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [loading, setLoading] = useState(true)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  useEffect(() => { load() }, [user, activeRouteId])

  async function load() {
    if (!user || !activeRouteId) { setSales([]); setLoading(false); return }
    setLoading(true)
    // Ventas aprobadas pendientes por desembolsar de la RUTA ACTIVA (coincide con el badge)
    const all = await db.sales.where('routeId').equals(activeRouteId).toArray()
    const pending = all.filter(s => s.status === 'activa' && s.disbursementStatus === 'pendiente')
    pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setSales(pending)
    setLoading(false)
  }

  async function handleConfirm(sale: Sale) {
    setConfirmingId(sale.id)
    try {
      await confirmDisbursement(sale.id)
      toast.success('Desembolso confirmado. La venta ya está activa para recaudo.')
      await load()
    } catch { toast.error('Error al confirmar el desembolso') } finally { setConfirmingId(null) }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Desembolsos</h1>
        <p className="text-xs text-gray-500">Ventas aprobadas pendientes por desembolsar</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : sales.length === 0 ? (
        <EmptyState icon={<Banknote className="w-8 h-8" />} title="No hay desembolsos pendientes" description="Cuando el administrador apruebe una solicitud, aparecerá aquí." />
      ) : (
        <div className="space-y-2.5">
          {sales.map(s => {
            const client = clientMap.get(s.clientId)
            return (
              <div key={s.id} className="bg-white rounded-2xl border border-amber-200 shadow-card p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{client?.nombre ?? 'Cliente'}</p>
                    <p className="text-xs text-gray-400">{client?.documento} · Inicio {formatDate(s.fechaInicio)}</p>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Por desembolsar</span>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-400">Valor</p>
                    <p className="text-sm font-bold text-gray-800">{formatCurrency(s.valorVenta, currency)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-400">Parcela</p>
                    <p className="text-sm font-bold text-primary-600">{formatCurrency(s.valorCuota, currency)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-400">Parcelas</p>
                    <p className="text-sm font-bold text-gray-700">{s.numeroCuotas}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleConfirm(s)}
                  disabled={confirmingId === s.id}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2"
                >
                  {confirmingId === s.id ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  Confirmar desembolso
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
