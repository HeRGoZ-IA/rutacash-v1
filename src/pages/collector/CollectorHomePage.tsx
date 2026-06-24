import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MapPin, HandCoins, Users, Wallet, RefreshCw, Wifi, WifiOff,
} from 'lucide-react'
import { db } from '@/lib/db'
import { KpiCard } from '@/components/ui/KpiCard'
import { CountBadge } from '@/components/ui/CountBadge'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { isSaleDueToday, isSaleDisbursed } from '@/services/installmentEngine'
import type { Route } from '@/models/types'

export default function CollectorHomePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const isOnline = useOnlineStatus()
  const { activeRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const [route, setRoute] = useState<Route | null>(null)
  const [stats, setStats] = useState({ pendientes: 0, cobradoHoy: 0, activos: 0, porDesembolsar: 0, pendientesSync: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (activeRouteId) load(activeRouteId) }, [activeRouteId])

  async function load(routeId: string) {
    setLoading(true)
    const r = await db.routes.get(routeId)
    setRoute(r ?? null)
    const allSales = await db.sales.where('routeId').equals(routeId).and(s => s.status === 'activa').toArray()
    const desembolsadas = allSales.filter(isSaleDisbursed)
    // Pendientes por desembolsar de la ruta activa (status activa + disbursementStatus 'pendiente')
    const porDesembolsar = allSales.filter(s => s.disbursementStatus === 'pendiente').length
    const todayStr = today()
    const payments = await db.payments.where('routeId').equals(routeId).toArray()
    const cobradoHoy = payments.filter(p => p.fecha === todayStr).reduce((s, p) => s + p.valor, 0)
    const pendientesSync = payments.filter(p => p.syncStatus === 'pending').length
    const salePaidToday = new Set(payments.filter(p => p.fecha === todayStr).map(p => p.saleId))
    const allInst = await db.installments.toArray()
    const instBySale = new Map<string, typeof allInst>()
    for (const inst of allInst) {
      const arr = instBySale.get(inst.saleId) ?? []
      arr.push(inst); instBySale.set(inst.saleId, arr)
    }
    const now = new Date()
    const pendientes = desembolsadas.filter(s =>
      !salePaidToday.has(s.id) && isSaleDueToday(s.paymentDays, instBySale.get(s.id) ?? [], now, todayStr)
    ).length
    setStats({ pendientes, cobradoHoy, activos: desembolsadas.length, porDesembolsar, pendientesSync })
    setLoading(false)
  }

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches'

  // Botón secundario reutilizable (altura, radio y padding uniformes)
  const Chip = ({ label, to, badge }: { label: string; to: string; badge?: number }) => (
    <button onClick={() => navigate(to)}
      className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 active:bg-gray-200 text-gray-700 text-xs font-medium border border-gray-200 transition-colors">
      {label}
      <CountBadge count={badge ?? 0} />
    </button>
  )

  return (
    <div className="p-4 space-y-4">
      {/* Greeting + ruta activa */}
      <div className="bg-gradient-to-br from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <p className="text-primary-200 text-sm">{greeting},</p>
        <h1 className="text-xl font-bold mt-0.5 leading-tight">{user?.nombre}</h1>
        <div className="flex items-center justify-between mt-3">
          {route ? (
            <span className="inline-flex items-center gap-1.5 bg-white/15 rounded-full pl-2 pr-3 py-1 text-sm font-medium">
              <MapPin className="w-3.5 h-3.5" /> {route.nombre}
            </span>
          ) : <span />}
          <span className="text-primary-200 text-xs">{formatDate(today())}</span>
        </div>
      </div>

      {/* KPIs uniformes */}
      <div className="grid grid-cols-3 gap-3">
        <KpiCard color="amber" value={loading ? '—' : stats.pendientes} label="Pendientes" />
        <KpiCard color="emerald" value={loading ? '—' : formatCurrency(stats.cobradoHoy, currency)} label="Abonado hoy" />
        <KpiCard color="primary" value={loading ? '—' : stats.activos} label="Ventas activas" />
      </div>

      {/* BLOQUE 1 — Recaudo (acción principal del día, con más protagonismo) */}
      <button onClick={() => navigate('/collector/route')} className="block w-full text-left bg-white rounded-2xl shadow-card border border-primary-100 ring-1 ring-primary-100 p-4 active:bg-gray-50 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-emerald-100 rounded-2xl flex items-center justify-center flex-shrink-0">
            <HandCoins className="w-6 h-6 text-emerald-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-gray-900 text-[15px]">Recaudo</p>
            <p className="text-xs text-gray-500 mt-0.5">Cobrar parcelas y revisar abonos</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3.5">
          <span className="inline-flex items-center justify-center h-9 px-4 rounded-xl bg-primary-600 text-white text-xs font-semibold">Ir a recaudo</span>
          <span onClick={e => { e.stopPropagation(); navigate('/collector/payment-history') }}
            className="inline-flex items-center h-9 px-3.5 rounded-xl bg-gray-50 hover:bg-gray-100 text-gray-700 text-xs font-medium border border-gray-200 transition-colors">
            Histórico de abonos
          </span>
        </div>
      </button>

      {/* BLOQUE 2 — Clientes y ventas */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-primary-100 rounded-2xl flex items-center justify-center flex-shrink-0">
            <Users className="w-6 h-6 text-primary-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-gray-900 text-[15px]">Clientes y ventas</p>
            <p className="text-xs text-gray-500 mt-0.5">Registrar clientes, ventas y desembolsos</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3.5">
          <Chip label="Nuevo cliente" to="/collector/clients/new" />
          <Chip label="Nueva venta" to="/collector/new-sale" />
          <Chip label="Desembolsos" to="/collector/disbursements" badge={stats.porDesembolsar} />
        </div>
      </div>

      {/* BLOQUE 3 — Gastos y cuadre */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-red-50 rounded-2xl flex items-center justify-center flex-shrink-0">
            <Wallet className="w-6 h-6 text-red-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-gray-900 text-[15px]">Gastos y cuadre</p>
            <p className="text-xs text-gray-500 mt-0.5">Registrar gastos y revisar caja esperada</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3.5">
          <Chip label="Gastos" to="/collector/expenses" />
          <Chip label="Informe del día" to="/collector/daily-report" />
          <Chip label="Cuadre" to="/collector/cashclose" />
        </div>
      </div>

      {/* BLOQUE 4 — Sincronización */}
      <button onClick={() => navigate('/collector/sync')} className="block w-full text-left bg-white rounded-2xl shadow-card border border-gray-100 p-4 active:bg-gray-50 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center flex-shrink-0">
            <RefreshCw className="w-6 h-6 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-gray-900 text-[15px]">Sincronización</p>
            <p className="text-xs text-gray-500 mt-0.5">Revisar pendientes y estado de datos</p>
          </div>
          <div className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full flex-shrink-0 ${isOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {isOnline ? 'Online' : 'Offline'}
          </div>
        </div>
        {stats.pendientesSync > 0 && (
          <p className="text-xs text-amber-600 mt-3">{stats.pendientesSync} abono(s) pendiente(s) por sincronizar</p>
        )}
      </button>
    </div>
  )
}
