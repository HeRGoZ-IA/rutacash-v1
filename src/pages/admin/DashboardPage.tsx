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
import { OfficesExecutivePanel } from '@/components/ui/OfficesExecutivePanel'
import { PendingSettlementsNotice } from '@/components/ui/PendingSettlementsNotice'
import { PendingShortagesNotice } from '@/components/settlement/WorkerCashSettlementPanel'
import { getAdminDashboardData, type DashboardData } from '@/services/adminDashboardService'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency, formatDate, today } from '@/lib/formatters'

export default function DashboardPage() {
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  // Se recalcula cuando cambian pagos, ventas, gastos… en ESTA pestaña o en otra
  // del mismo navegador (p. ej. el Cobrador registra un abono en otra ventana).
  const revision = useDataRevision()

  useEffect(() => {
    let alive = true
    // El cálculo vive en `getAdminDashboardData` (probado con Dexie real). Solo la
    // PRIMERA carga muestra el spinner; los refrescos sustituyen las cifras en sitio.
    getAdminDashboardData({ user, tenantId })
      .then(d => { if (alive) setData(d) })
      .catch(err => console.error('Dashboard error:', err))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tenantId, user, revision])

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

      {/* Onboarding "Primeros pasos": aparece mientras existan pasos esenciales
          pendientes (empresa nueva); se auto-oculta al completarse. */}
      <SetupChecklist />

      {/* Semanas sin cerrar de las rutas autorizadas. Se oculta si no hay ninguna. */}
      <PendingSettlementsNotice />

      {/* Trabajadores con faltante pendiente en su último cuadre (no bloquea). */}
      <PendingShortagesNotice />

      {/* Resumen ejecutivo por Oficina: tarjetas + comparativo objetivo, siempre
          sobre las rutas autorizadas del usuario. Se oculta solo si no hay ninguna. */}
      <OfficesExecutivePanel />

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
          title="Base actual"
          value={formatCurrency(data.baseActualTotal)}
          icon={<DollarSign className="w-5 h-5" />}
          color="blue"
          subtitle="Disponible en rutas"
        />
        <KPICard
          title="Cartera Activa"
          value={formatCurrency(data.carteraEnCalle)}
          icon={<CreditCard className="w-5 h-5" />}
          color="purple"
          subtitle={`${data.ventasActivas} ventas activas`}
        />
        <KPICard
          title="Total controlado"
          value={formatCurrency(data.totalControlado)}
          icon={<TrendingUp className="w-5 h-5" />}
          color="green"
          subtitle="Base + Cartera Activa"
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
