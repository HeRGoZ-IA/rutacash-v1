import { useState, useEffect } from 'react'
import { Search, CheckCircle, XCircle, Eye, Phone } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { calculateCurrentInstallment } from '@/services/installmentEngine'
import type { Sale, Client, Installment } from '@/models/types'

interface RouteItem {
  sale: Sale
  client: Client
  currentInstallment: Installment | null
  paidToday: boolean
}

export default function CollectorRoutePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState<RouteItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user?.routeId) { setLoading(false); return }
    const sales = await db.sales.where('routeId').equals(user.routeId).and(s => s.status === 'activa').toArray()
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const clientMap = new Map(clients.map(c => [c.id, c]))
    const todayPayments = await db.payments.where('routeId').equals(user.routeId).and(p => p.fecha === today()).toArray()
    const paidSales = new Set(todayPayments.map(p => p.saleId))

    const result: RouteItem[] = []
    for (const sale of sales) {
      const client = clientMap.get(sale.clientId)
      if (!client) continue
      const insts = await db.installments.where('saleId').equals(sale.id).toArray()
      const currentInstallment = calculateCurrentInstallment(insts)
      result.push({ sale, client, currentInstallment, paidToday: paidSales.has(sale.id) })
    }
    result.sort((a, b) => (a.paidToday ? 1 : 0) - (b.paidToday ? 1 : 0))
    setItems(result)
    setLoading(false)
  }

  const filtered = items.filter(item => {
    const q = search.toLowerCase()
    return !q || item.client.nombre.toLowerCase().includes(q) || item.client.documento.includes(q)
  })

  const pendientes = filtered.filter(i => !i.paidToday).length
  const cobrados = filtered.filter(i => i.paidToday).length

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="bg-primary-700 px-4 py-3 flex gap-4">
        <div className="text-center">
          <p className="text-white font-bold text-lg">{pendientes}</p>
          <p className="text-primary-200 text-xs">Pendientes</p>
        </div>
        <div className="w-px bg-primary-600" />
        <div className="text-center">
          <p className="text-emerald-300 font-bold text-lg">{cobrados}</p>
          <p className="text-primary-200 text-xs">Cobrados</p>
        </div>
      </div>

      {/* Search */}
      <div className="px-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar cliente..."
            className="w-full h-10 rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No hay clientes en tu ruta" description="Contacta al administrador si crees que hay un error" />
      ) : (
        <div className="px-4 space-y-2.5">
          {filtered.map(item => (
            <ClientCard key={item.sale.id} item={item} onPayment={() => navigate(`/collector/payment/${item.sale.id}`)} onNoPayment={() => navigate(`/collector/no-payment/${item.sale.id}`)} onView={() => navigate(`/collector/client/${item.client.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ item, onPayment, onNoPayment, onView }: {
  item: RouteItem
  onPayment: () => void
  onNoPayment: () => void
  onView: () => void
}) {
  const { sale, client, currentInstallment, paidToday } = item
  const isOverdue = currentInstallment?.status === 'vencida'

  return (
    <div className={`bg-white rounded-2xl border shadow-card overflow-hidden ${paidToday ? 'opacity-60' : isOverdue ? 'border-red-200' : 'border-gray-100'}`}>
      <div className="px-4 py-3">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="font-semibold text-gray-900 text-sm">{client.nombre}</p>
            <p className="text-xs text-gray-400">{client.negocio}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {paidToday && <Badge variant="success" size="sm">Cobrado</Badge>}
            {!paidToday && isOverdue && <Badge variant="danger" size="sm">Vencida</Badge>}
            {!paidToday && !isOverdue && currentInstallment && <Badge variant="warning" size="sm">Pendiente</Badge>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Saldo</p>
            <p className="text-sm font-bold text-amber-600">{formatCurrency(sale.saldo)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Cuota</p>
            <p className="text-sm font-bold text-primary-600">{formatCurrency(currentInstallment?.valor ?? sale.valorCuota)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">N° cuota</p>
            <p className="text-sm font-bold text-gray-700">{currentInstallment?.numero ?? '-'}/{sale.numeroCuotas}</p>
          </div>
        </div>

        {!paidToday && (
          <div className="flex gap-2">
            <button onClick={onPayment}
              className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-sm font-medium">
              <CheckCircle className="w-4 h-4" /> Cobrar
            </button>
            <button onClick={onNoPayment}
              className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl py-2.5 text-sm font-medium border border-red-100">
              <XCircle className="w-4 h-4" /> No pagó
            </button>
            <button onClick={onView}
              className="w-10 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-xl text-gray-500">
              <Eye className="w-4 h-4" />
            </button>
          </div>
        )}
        {paidToday && (
          <button onClick={onView} className="w-full flex items-center justify-center gap-2 bg-gray-100 text-gray-500 rounded-xl py-2.5 text-sm">
            <Eye className="w-4 h-4" /> Ver detalle
          </button>
        )}
      </div>
    </div>
  )
}
