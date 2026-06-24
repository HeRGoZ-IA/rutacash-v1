import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Search, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { formatCurrency, formatPaymentDays, today } from '@/lib/formatters'
import { calculateCurrentInstallment, isSaleDueToday } from '@/services/installmentEngine'
import type { Sale, Client, Installment, Route } from '@/models/types'

interface RouteItem {
  sale: Sale
  client: Client
  currentInstallment: Installment | null
  paidToday: boolean
  dueToday: boolean
}

/**
 * Paquete 3 — Vista de revisión de una ruta para el Supervisor.
 * Reutiliza la lógica del cobrador (días programados + cuotas vencidas) pero
 * es de SOLO LECTURA: el supervisor revisa, no registra pagos.
 */
export default function SupervisorRoutePage() {
  const { routeId } = useParams<{ routeId: string }>()
  const { user } = useAuth()
  const { currency } = useTenant()
  const [route, setRoute] = useState<Route | null>(null)
  const [items, setItems] = useState<RouteItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [authorized, setAuthorized] = useState(true)

  useEffect(() => { load() }, [user, routeId])

  async function load() {
    if (!user || !routeId) { setLoading(false); return }
    // Restricción simple: la ruta debe estar entre las autorizadas del supervisor.
    if (!getAuthorizedRouteIds(user).includes(routeId)) {
      setAuthorized(false); setLoading(false); return
    }
    setAuthorized(true)

    const r = await db.routes.get(routeId)
    setRoute(r ?? null)

    const sales = await db.sales.where('routeId').equals(routeId).and(s => s.status === 'activa').toArray()
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const clientMap = new Map(clients.map(c => [c.id, c]))
    const todayStr = today()
    const todayPayments = await db.payments.where('routeId').equals(routeId).and(p => p.fecha === todayStr).toArray()
    const paidSales = new Set(todayPayments.map(p => p.saleId))

    const now = new Date()
    const result: RouteItem[] = []
    for (const sale of sales) {
      const client = clientMap.get(sale.clientId)
      if (!client) continue
      const insts = await db.installments.where('saleId').equals(sale.id).toArray()
      const currentInstallment = calculateCurrentInstallment(insts)
      const dueToday = isSaleDueToday(sale.paymentDays, insts, now, todayStr)
      result.push({ sale, client, currentInstallment, paidToday: paidSales.has(sale.id), dueToday })
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
  const carteraTotal = filtered.reduce((s, i) => s + i.sale.saldo, 0)

  if (!authorized) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<ShieldAlert className="w-8 h-8" />}
          title="Ruta no autorizada"
          description="No tienes permiso para revisar esta ruta. Contacta al administrador."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Route header + stats */}
      <div className="bg-primary-700 px-4 py-3">
        <p className="text-white font-bold text-sm">{route?.nombre ?? 'Ruta'}</p>
        <p className="text-primary-200 text-xs">{route?.codigo}{route?.ciudad ? ` · ${route.ciudad}` : ''}</p>
        <div className="flex gap-4 mt-3">
          <div className="text-center">
            <p className="text-white font-bold text-lg">{pendientes}</p>
            <p className="text-primary-200 text-xs">Pendientes hoy</p>
          </div>
          <div className="w-px bg-primary-600" />
          <div className="text-center">
            <p className="text-emerald-300 font-bold text-lg">{cobrados}</p>
            <p className="text-primary-200 text-xs">Cobrados hoy</p>
          </div>
          <div className="w-px bg-primary-600" />
          <div className="text-center">
            <p className="text-amber-300 font-bold text-lg leading-tight">{formatCurrency(carteraTotal, currency)}</p>
            <p className="text-primary-200 text-xs">Cartera</p>
          </div>
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

      {/* List (read-only review) */}
      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No hay clientes activos en esta ruta" />
      ) : (
        <div className="px-4 space-y-2.5">
          {filtered.map(item => (
            <ReviewCard key={item.sale.id} item={item} currency={currency} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewCard({ item, currency }: { item: RouteItem; currency: string }) {
  const { sale, client, currentInstallment, paidToday, dueToday } = item
  const isOverdue = currentInstallment?.status === 'vencida'
  const notScheduled = !paidToday && !dueToday

  return (
    <div className={`bg-white rounded-2xl border shadow-card overflow-hidden ${paidToday ? 'opacity-60' : notScheduled ? 'opacity-70 border-gray-100' : isOverdue ? 'border-red-200' : 'border-gray-100'}`}>
      <div className="px-4 py-3">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="font-semibold text-gray-900 text-sm">{client.nombre}</p>
            <p className="text-xs text-gray-400">{client.negocio || client.documento}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {paidToday && <Badge variant="success" size="sm">Cobrado</Badge>}
            {notScheduled && <Badge variant="gray" size="sm">Hoy no programado</Badge>}
            {!paidToday && !notScheduled && isOverdue && <Badge variant="danger" size="sm">Vencida</Badge>}
            {!paidToday && !notScheduled && !isOverdue && currentInstallment && <Badge variant="warning" size="sm">Pendiente</Badge>}
          </div>
        </div>
        {notScheduled && (
          <p className="text-xs text-gray-400 mb-2">Días de cobro: {formatPaymentDays(sale.paymentDays)}</p>
        )}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Saldo</p>
            <p className="text-sm font-bold text-amber-600">{formatCurrency(sale.saldo, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">Cuota</p>
            <p className="text-sm font-bold text-primary-600">{formatCurrency(currentInstallment?.valor ?? sale.valorCuota, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-400">N° cuota</p>
            <p className="text-sm font-bold text-gray-700">{currentInstallment?.numero ?? '-'}/{sale.numeroCuotas}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
