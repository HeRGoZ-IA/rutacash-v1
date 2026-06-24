import { useState, useEffect } from 'react'
import { Search, CheckCircle, XCircle, Eye } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate, today, formatPaymentDays } from '@/lib/formatters'
import {
  calculateCurrentInstallment, isSaleDueToday, isSaleDisbursed,
  getCollectionStatus, countOverdueInstallments, getMaxOverdueDays,
  type CollectionStatus,
} from '@/services/installmentEngine'
import type { Sale, Client, Installment } from '@/models/types'

interface RouteItem {
  sale: Sale
  client: Client
  currentInstallment: Installment | null
  paidToday: boolean
  dueToday: boolean
  estado: CollectionStatus
  atrasadas: number
  diasAtraso: number
  ultimoAbono?: string
}

// Estilos por estado de cobro (verde/amarillo/rojo)
const ESTADO_STYLE: Record<CollectionStatus, { border: string; dot: string; label: string; badge: 'success' | 'warning' | 'danger' }> = {
  verde: { border: 'border-emerald-200', dot: 'bg-emerald-500', label: 'Al día', badge: 'success' },
  amarillo: { border: 'border-amber-200', dot: 'bg-amber-500', label: 'Atraso leve', badge: 'warning' },
  rojo: { border: 'border-red-200', dot: 'bg-red-500', label: 'Atraso fuerte', badge: 'danger' },
}

export default function CollectorRoutePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const [items, setItems] = useState<RouteItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null

  useEffect(() => { load() }, [user, routeId])

  async function load() {
    if (!routeId || !user) { setLoading(false); return }
    setLoading(true)
    // Solo ventas activas Y desembolsadas (las no desembolsadas no se cobran)
    const allSales = await db.sales.where('routeId').equals(routeId).and(s => s.status === 'activa').toArray()
    const sales = allSales.filter(isSaleDisbursed)
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const clientMap = new Map(clients.map(c => [c.id, c]))
    const routePayments = await db.payments.where('routeId').equals(routeId).toArray()
    const todayStr = today()
    const paidToday = new Set(routePayments.filter(p => p.fecha === todayStr).map(p => p.saleId))
    // Último abono por venta
    const lastPaymentBySale = new Map<string, string>()
    for (const p of routePayments) {
      const prev = lastPaymentBySale.get(p.saleId)
      if (!prev || p.createdAt > prev) lastPaymentBySale.set(p.saleId, p.fecha)
    }

    const now = new Date()
    const result: RouteItem[] = []
    for (const sale of sales) {
      const client = clientMap.get(sale.clientId)
      if (!client) continue
      const insts = await db.installments.where('saleId').equals(sale.id).toArray()
      result.push({
        sale, client,
        currentInstallment: calculateCurrentInstallment(insts),
        paidToday: paidToday.has(sale.id),
        dueToday: isSaleDueToday(sale.paymentDays, insts, now, todayStr),
        estado: getCollectionStatus(insts, now),
        atrasadas: countOverdueInstallments(insts, todayStr),
        diasAtraso: getMaxOverdueDays(insts, now),
        ultimoAbono: lastPaymentBySale.get(sale.id),
      })
    }
    result.sort((a, b) => rank(a) - rank(b))
    setItems(result)
    setLoading(false)
  }

  function rank(i: RouteItem): number {
    if (i.paidToday) return 2
    return i.dueToday ? 0 : 1
  }

  const filtered = items.filter(item => {
    const q = search.toLowerCase()
    return !q || item.client.nombre.toLowerCase().includes(q) || item.client.documento.includes(q)
  })

  const pendientes = filtered.filter(i => !i.paidToday && i.dueToday).length
  const cobrados = filtered.filter(i => i.paidToday).length
  const noProgramados = filtered.filter(i => !i.paidToday && !i.dueToday).length

  if (!routeId) {
    return <div className="p-4"><EmptyState title="Selecciona una ruta" description="Vuelve al inicio y elige una ruta para trabajar." /></div>
  }

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
          <p className="text-primary-200 text-xs">Abonados</p>
        </div>
        {noProgramados > 0 && (
          <>
            <div className="w-px bg-primary-600" />
            <div className="text-center">
              <p className="text-primary-100 font-bold text-lg">{noProgramados}</p>
              <p className="text-primary-200 text-xs">No hoy</p>
            </div>
          </>
        )}
      </div>

      {/* Search */}
      <div className="px-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente..."
            className="w-full h-10 rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No hay clientes para cobrar" description="No hay ventas activas desembolsadas en esta ruta." />
      ) : (
        <div className="px-4 space-y-2.5">
          {filtered.map(item => (
            <ClientCard key={item.sale.id} item={item} currency={currency}
              onPayment={() => navigate(`/collector/payment/${item.sale.id}`)}
              onNoPayment={() => navigate(`/collector/no-payment/${item.sale.id}`)}
              onView={() => navigate(`/collector/client/${item.client.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ item, currency, onPayment, onNoPayment, onView }: {
  item: RouteItem
  currency: string
  onPayment: () => void
  onNoPayment: () => void
  onView: () => void
}) {
  const { sale, client, currentInstallment, paidToday, dueToday, estado, atrasadas, diasAtraso, ultimoAbono } = item
  const notScheduled = !paidToday && !dueToday
  const st = ESTADO_STYLE[estado]

  return (
    <div className={`bg-white rounded-2xl border shadow-card overflow-hidden ${paidToday ? 'opacity-60 border-gray-100' : notScheduled ? 'opacity-80 border-gray-100' : st.border}`}>
      <div className="px-4 py-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.dot}`} />
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">{client.nombre}</p>
              <p className="text-xs text-gray-400">{client.documento}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {paidToday ? <Badge variant="success" size="sm">Abonado</Badge> : <Badge variant={st.badge} size="sm">{st.label}</Badge>}
            {notScheduled && !paidToday && <span className="text-[10px] text-gray-400">Hoy no programado</span>}
          </div>
        </div>

        {notScheduled && atrasadas === 0 && (
          <p className="text-xs text-gray-400 mb-2">Días de cobro: {formatPaymentDays(sale.paymentDays)}</p>
        )}

        <div className="grid grid-cols-3 gap-2 mb-2">
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Saldo</p>
            <p className="text-sm font-bold text-amber-600">{formatCurrency(sale.saldo, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Parcela</p>
            <p className="text-sm font-bold text-primary-600">{formatCurrency(currentInstallment?.valor ?? sale.valorCuota, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">N° parcela</p>
            <p className="text-sm font-bold text-gray-700">{currentInstallment?.numero ?? '-'}/{sale.numeroCuotas}</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-400 mb-3">
          <span>Último abono: {ultimoAbono ? formatDate(ultimoAbono) : '—'}</span>
          {atrasadas > 0 && <span className="text-red-500 font-medium">{atrasadas} parcela(s) atrasada(s) · {diasAtraso}d</span>}
        </div>

        {!paidToday ? (
          <div className="flex gap-2">
            <button onClick={onPayment} className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-sm font-medium">
              <CheckCircle className="w-4 h-4" /> Abonar
            </button>
            <button onClick={onNoPayment} className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl py-2.5 text-sm font-medium border border-red-100">
              <XCircle className="w-4 h-4" /> No pagó
            </button>
            <button onClick={onView} className="w-10 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-xl text-gray-500">
              <Eye className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button onClick={onView} className="w-full flex items-center justify-center gap-2 bg-gray-100 text-gray-500 rounded-xl py-2.5 text-sm">
            <Eye className="w-4 h-4" /> Ver detalle
          </button>
        )}
      </div>
    </div>
  )
}
