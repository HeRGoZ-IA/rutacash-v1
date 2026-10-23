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
import { formatCurrency, formatCompactCurrency, formatDate, today } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'

export default function DashboardPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
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

  // Ronda 50: ejes abreviados y legibles en la moneda de la empresa (los tooltips, exactos).
  const axisMoney = (v: number) => formatCompactCurrency(v, currency)
  const money = (v: number) => formatCurrency(v, currency)

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Bienvenido, {formatPersonName(user?.nombre)} — {formatDate(today())}
        </p>
      </div>

      {/* Onboarding "Primeros pasos": aparece mientras existan pasos esenciales
          pendientes (empresa nueva); se auto-oculta al completarse. */}
      <SetupChecklist />

      {/* Semanas sin cerrar de las rutas autorizadas. Se oculta si no hay ninguna.
          Ronda 50: siempre ARRIBA, antes de las cifras. */}
      <PendingSettlementsNotice />

      {/* Trabajadores con faltante pendiente en su último cuadre (no bloquea). */}
      <PendingShortagesNotice />

      {/* Alerts */}
      {data.alertas.length > 0 && (
        <div className="space-y-2">
          {data.alertas.map((a, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm border ${
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

      {/* KPI principales (Ronda 50): lo que se mira primero. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="dashboard-kpis">
        <KPICard
          title="Recaudo hoy"
          value={money(data.recaudoHoy)}
          icon={<TrendingUp className="w-5 h-5" />}
          color="green"
          subtitle="Cobros del día"
        />
        <KPICard
          title="Cartera Activa"
          value={money(data.carteraEnCalle)}
          icon={<CreditCard className="w-5 h-5" />}
          color="purple"
          subtitle={`${data.ventasActivas} ventas activas`}
        />
        <KPICard
          title="Base total"
          value={money(data.baseActualTotal)}
          icon={<DollarSign className="w-5 h-5" />}
          color="blue"
          subtitle="Efectivo de las rutas"
        />
        <KPICard
          title="Total controlado"
          value={money(data.totalControlado)}
          icon={<TrendingUp className="w-5 h-5" />}
          color="green"
          subtitle="Base + Cartera Activa"
        />
      </div>

      {/* Indicadores secundarios, en una franja compacta. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="dashboard-secondary">
        <MiniStat label="Recaudo semanal" value={money(data.recaudoSemana)} icon={<ArrowUpRight className="w-4 h-4 text-emerald-600" />} />
        <MiniStat label="Gastos semana" value={money(data.gastosSemana)} icon={<TrendingDown className="w-4 h-4 text-red-500" />} />
        <MiniStat label="Clientes activos" value={String(data.clientesActivos)} icon={<Users className="w-4 h-4 text-primary-600" />} />
        <MiniStat label="Rutas con mora" value={String(data.rutasConMora)} tone={data.rutasConMora > 0 ? 'text-red-600' : undefined}
          icon={<AlertTriangle className={`w-4 h-4 ${data.rutasConMora > 0 ? 'text-red-500' : 'text-emerald-600'}`} />} />
        <MiniStat label="Pendiente sync" value={String(data.pagosPendientesSync)} tone={data.pagosPendientesSync > 0 ? 'text-amber-600' : undefined}
          icon={<WifiOff className="w-4 h-4 text-gray-500" />} />
      </div>

      {/* Resumen ejecutivo por Oficina: tarjetas + comparativo objetivo, siempre
          sobre las rutas autorizadas del usuario. Se oculta solo si no hay ninguna. */}
      <OfficesExecutivePanel />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Recaudo diario */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Recaudo últimos 7 días</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.recaudoDiario}>
              <defs>
                <linearGradient id="recaudoGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563EB" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="dia" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={axisMoney} width={72} />
              <Tooltip formatter={(v: number) => money(v)} labelStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="valor" stroke="#2563EB" strokeWidth={2} fill="url(#recaudoGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Top rutas */}
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Top rutas por recaudo semanal</h3>
          {data.topRoutes.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.topRoutes} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={axisMoney} width={72} />
                <YAxis type="category" dataKey="nombre" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                <Tooltip formatter={(v: number) => money(v)} />
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

/** Indicador secundario compacto (Ronda 50). */
function MiniStat({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">{icon}<span className="truncate">{label}</span></div>
      <p className={`mt-1 text-base font-bold tabular-nums leading-tight ${tone ?? 'text-gray-900'}`}>{value}</p>
    </div>
  )
}
