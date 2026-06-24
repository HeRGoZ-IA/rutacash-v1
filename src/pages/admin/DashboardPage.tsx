import { useState, useEffect } from 'react'
import {
  DollarSign, Users, TrendingUp, TrendingDown, CreditCard,
  MapPin, AlertTriangle, WifiOff, ArrowUpRight
} from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { KPICard } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/EmptyState'
import { SetupChecklist } from '@/components/ui/SetupChecklist'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate, today, getWeekStart, getWeekEnd } from '@/lib/formatters'
import { format, subDays } from 'date-fns'
import { es } from 'date-fns/locale'
import { IS_CLEAN } from '@/lib/appMode'

interface DashboardData {
  capitalTotal: number
  carteraActiva: number
  recaudoHoy: number
  recaudoSemana: number
  ventasActivas: number
  clientesActivos: number
  gastosSemana: number
  pagosPendientesSync: number
  rutasConMora: number
  topRoutes: { nombre: string; cobrado: number }[]
  recaudoDiario: { dia: string; valor: number }[]
  alertas: { tipo: string; mensaje: string; severity: 'warning' | 'error' | 'info' }[]
}

export default function DashboardPage() {
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDashboard()
  }, [tenantId])

  async function loadDashboard() {
    setLoading(true)
    try {
      const todayStr = today()
      const weekStart = getWeekStart()
      const weekEnd = getWeekEnd()

      // Routes (toda la empresa)
      const routes = await db.routes.where('tenantId').equals(tenantId).toArray()

      // Sales
      const allSales = await db.sales.where('tenantId').equals(tenantId).toArray()
      const ventasActivas = allSales.filter(s => s.status === 'activa')
      const carteraActiva = ventasActivas.reduce((s, v) => s + v.saldo, 0)

      // Capital
      const capitalMovs = await db.capitalMovements.where('tenantId').equals(tenantId).toArray()
      const capitalTotal = capitalMovs.reduce((s, m) => s + m.valor, 0)

      // Payments
      const allPayments = await db.payments.where('tenantId').equals(tenantId).toArray()
      const recaudoHoy = allPayments
        .filter(p => p.fecha === todayStr)
        .reduce((s, p) => s + p.valor, 0)
      const recaudoSemana = allPayments
        .filter(p => p.fecha >= weekStart && p.fecha <= weekEnd)
        .reduce((s, p) => s + p.valor, 0)

      // Clients
      const allClients = await db.clients.where('tenantId').equals(tenantId).toArray()
      const clientesActivos = allClients.filter(c => c.status === 'activo').length

      // Expenses
      const allExpenses = await db.expenses.where('tenantId').equals(tenantId).toArray()
      const gastosSemana = allExpenses
        .filter(e => e.fecha >= weekStart && e.fecha <= weekEnd)
        .reduce((s, e) => s + e.valor, 0)

      // Pending sync (de los pagos en alcance)
      const pagosPendientesSync = allPayments.filter(p => p.syncStatus === 'pending').length

      // Rutas con mora
      const installments = await db.installments.toArray()
      const rutasConMoraSet = new Set<string>()
      const salesMap = new Map(allSales.map(s => [s.id, s]))
      for (const inst of installments) {
        if (inst.status === 'vencida' && inst.diasMora > 0) {
          const sale = salesMap.get(inst.saleId)
          if (sale) rutasConMoraSet.add(sale.routeId)
        }
      }

      // Top routes
      const routePayments: Record<string, number> = {}
      for (const p of allPayments.filter(p => p.fecha >= weekStart && p.fecha <= weekEnd)) {
        routePayments[p.routeId] = (routePayments[p.routeId] ?? 0) + p.valor
      }
      const routeMap = new Map(routes.map(r => [r.id, r]))
      const topRoutes = Object.entries(routePayments)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, cobrado]) => ({ nombre: routeMap.get(id)?.nombre ?? id, cobrado }))

      // Recaudo diario 7 días
      const recaudoDiario = Array.from({ length: 7 }, (_, i) => {
        const date = format(subDays(new Date(), 6 - i), 'yyyy-MM-dd')
        const label = format(subDays(new Date(), 6 - i), 'EEE', { locale: es })
        const valor = allPayments
          .filter(p => p.fecha === date)
          .reduce((s, p) => s + p.valor, 0)
        return { dia: label, valor }
      })

      // Alertas
      const alertas: DashboardData['alertas'] = []
      if (pagosPendientesSync > 0) {
        alertas.push({ tipo: 'sync', mensaje: `${pagosPendientesSync} pagos pendientes de sincronizar`, severity: 'warning' })
      }
      const rutasSinCobrador = routes.filter(r => !r.cobradorId && r.status === 'activa')
      if (rutasSinCobrador.length > 0) {
        alertas.push({ tipo: 'ruta', mensaje: `${rutasSinCobrador.length} ruta(s) sin cobrador asignado`, severity: 'error' })
      }
      if (rutasConMoraSet.size > 0) {
        alertas.push({ tipo: 'mora', mensaje: `${rutasConMoraSet.size} ruta(s) tienen clientes en mora`, severity: 'warning' })
      }

      setData({
        capitalTotal,
        carteraActiva,
        recaudoHoy,
        recaudoSemana,
        ventasActivas: ventasActivas.length,
        clientesActivos,
        gastosSemana,
        pagosPendientesSync,
        rutasConMora: rutasConMoraSet.size,
        topRoutes,
        recaudoDiario,
        alertas,
      })
    } catch (err) {
      console.error('Dashboard error:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <LoadingState message="Cargando dashboard..." />
  if (!data) return null

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Bienvenido, {user?.nombre} — {formatDate(today())}
        </p>
      </div>

      {/* Setup checklist (modo limpio) */}
      {IS_CLEAN && <SetupChecklist />}

      {/* Alerts */}
      {data.alertas.length > 0 && (
        <div className="space-y-2">
          {data.alertas.map((a, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm border ${
                a.severity === 'error'
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : a.severity === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-700'
                  : 'bg-blue-50 border-blue-200 text-blue-700'
              }`}
            >
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{a.mensaje}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Capital total"
          value={formatCurrency(data.capitalTotal)}
          icon={<DollarSign className="w-5 h-5" />}
          color="blue"
          subtitle="Fondos en rutas"
        />
        <KPICard
          title="Cartera activa"
          value={formatCurrency(data.carteraActiva)}
          icon={<CreditCard className="w-5 h-5" />}
          color="purple"
          subtitle={`${data.ventasActivas} ventas`}
        />
        <KPICard
          title="Recaudo hoy"
          value={formatCurrency(data.recaudoHoy)}
          icon={<TrendingUp className="w-5 h-5" />}
          color="green"
          subtitle="Cobros del día"
        />
        <KPICard
          title="Recaudo semanal"
          value={formatCurrency(data.recaudoSemana)}
          icon={<ArrowUpRight className="w-5 h-5" />}
          color="green"
          subtitle="Esta semana"
        />
        <KPICard
          title="Clientes activos"
          value={data.clientesActivos}
          icon={<Users className="w-5 h-5" />}
          color="blue"
        />
        <KPICard
          title="Gastos semana"
          value={formatCurrency(data.gastosSemana)}
          icon={<TrendingDown className="w-5 h-5" />}
          color="red"
        />
        <KPICard
          title="Rutas con mora"
          value={data.rutasConMora}
          icon={<AlertTriangle className="w-5 h-5" />}
          color={data.rutasConMora > 0 ? 'red' : 'green'}
        />
        <KPICard
          title="Pendiente sync"
          value={data.pagosPendientesSync}
          icon={<WifiOff className="w-5 h-5" />}
          color={data.pagosPendientesSync > 0 ? 'yellow' : 'gray'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recaudo diario */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Recaudo últimos 7 días</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.recaudoDiario}>
              <defs>
                <linearGradient id="recaudoGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563EB" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="dia" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} labelStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="valor" stroke="#2563EB" strokeWidth={2} fill="url(#recaudoGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Top rutas */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Top rutas por recaudo semanal</h3>
          {data.topRoutes.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.topRoutes} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <YAxis type="category" dataKey="nombre" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="cobrado" fill="#2563EB" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-gray-400 text-sm">
              Sin datos de recaudo esta semana
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
