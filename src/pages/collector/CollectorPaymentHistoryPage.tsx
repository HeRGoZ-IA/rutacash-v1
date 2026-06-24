import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { History } from 'lucide-react'
import { Select } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { formatCurrency, formatDate } from '@/lib/formatters'
import type { Client, Sale, Payment } from '@/models/types'

/**
 * Histórico de abonos por cliente/venta. Sirve para revisar diferencias cuando
 * un cliente dice que pagó y el sistema muestra algo distinto.
 * Nota: los abonos no guardan la parcela exacta afectada (el motor distribuye el
 * pago entre parcelas), por eso esa columna no se muestra en V1.
 */
export default function CollectorPaymentHistoryPage() {
  const { saleId: paramSaleId } = useParams<{ saleId?: string }>()
  const { user } = useAuth()
  const { currency } = useTenant()
  const [clients, setClients] = useState<Client[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [clientId, setClientId] = useState('')
  const [saleId, setSaleId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { init() }, [user])

  async function init() {
    if (!user) { setLoading(false); return }
    const routeIds = getAuthorizedRouteIds(user)
    const allClients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const mine = allClients.filter(c => routeIds.includes(c.routeId))
    setClients(mine)

    // Si viene un saleId en la URL, preselecciona cliente + venta
    if (paramSaleId) {
      const sale = await db.sales.get(paramSaleId)
      if (sale) {
        setClientId(sale.clientId)
        const cs = await db.sales.where('clientId').equals(sale.clientId).toArray()
        setSales(cs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
        setSaleId(sale.id)
        await loadPayments(sale.id)
      }
    }
    setLoading(false)
  }

  async function onSelectClient(id: string) {
    setClientId(id); setSaleId(''); setPayments([])
    if (!id) { setSales([]); return }
    const cs = await db.sales.where('clientId').equals(id).toArray()
    setSales(cs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }

  async function onSelectSale(id: string) {
    setSaleId(id)
    if (id) await loadPayments(id); else setPayments([])
  }

  async function loadPayments(sid: string) {
    const ps = await db.payments.where('saleId').equals(sid).toArray()
    setPayments(ps.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  }

  const selectedSale = sales.find(s => s.id === saleId)
  const totalAbonado = payments.reduce((s, p) => s + p.valor, 0)

  const saleLabel = (s: Sale) => `${formatCurrency(s.valorVenta, currency)} · ${formatDate(s.fechaInicio)} · ${s.status}`

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Histórico de abonos</h1>
        <p className="text-xs text-gray-500">Abonos registrados por venta</p>
      </div>

      <Select label="Cliente" value={clientId} onChange={e => onSelectClient(e.target.value)}
        options={clients.map(c => ({ value: c.id, label: `${c.nombre} - ${c.documento}` }))} placeholder="Seleccionar cliente" />

      {clientId && (
        <Select label="Venta" value={saleId} onChange={e => onSelectSale(e.target.value)}
          options={sales.map(s => ({ value: s.id, label: saleLabel(s) }))} placeholder="Seleccionar venta" />
      )}

      {selectedSale && (
        <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-3 gap-2">
          <div><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600">{formatCurrency(selectedSale.saldo, currency)}</p></div>
          <div><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700">{formatCurrency(selectedSale.valorCuota, currency)}</p></div>
          <div><p className="text-xs text-gray-500">Total abonado</p><p className="font-bold text-emerald-600">{formatCurrency(totalAbonado, currency)}</p></div>
        </div>
      )}

      {saleId && (
        payments.length === 0 ? (
          <EmptyState icon={<History className="w-8 h-8" />} title="Sin abonos registrados" />
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
            {payments.map(p => (
              <div key={p.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-800">{formatDate(p.fecha)}</p>
                  <span className="text-sm font-bold text-emerald-600">+{formatCurrency(p.valor, currency)}</span>
                </div>
                {p.observacion && <p className="text-xs text-gray-400 mt-0.5">{p.observacion}</p>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
