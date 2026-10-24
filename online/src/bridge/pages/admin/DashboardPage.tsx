// ADEX Online: COPIA de src/pages/admin/DashboardPage.tsx (CLEAN). Cambios marcados (R74, §4.2 y §15.2):
//   · Modelo de bolsas (admin_pool): mismas cifras de siempre, con los DOS rótulos que engañaban corregidos:
//     «Base total» era Σ custodias (no incluye bolsas) → «Efectivo en custodias»; «Total controlado» sumaba la
//     cartera con interés no cobrado → «Custodias + cartera activa», aclarando que la cartera no es efectivo.
//   · Base por Ruta: las cifras de efectivo salen del panel por ruta (`/v1/capital/route-panel`): Base disponible,
//     efectivo en custodia, efectivo total de las rutas, cartera pendiente (nunca mezclada con el efectivo),
//     resultado operativo (no es utilidad contable ni dinero retirable), faltantes/sobrantes y reembolsos
//     pendientes a Administradores (obligación, nunca efectivo). Sin «ganancia retirable».
import { useState, useEffect } from 'react'
import {
  DollarSign, Users, TrendingUp, TrendingDown, CreditCard,
  MapPin, AlertTriangle, WifiOff, ArrowUpRight, Wallet, Scale, HandCoins
} from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { KPICard } from '@/components/ui/Card'
import { LoadingState } from '@/components/ui/EmptyState'
import { SetupChecklist } from '@/components/ui/SetupChecklist'
import { OfficesExecutivePanel } from '@/components/ui/OfficesExecutivePanel'
import { PendingSettlementsNotice } from '@/components/ui/PendingSettlementsNotice'
import { PendingShortagesNotice } from '@/components/settlement/WorkerCashSettlementPanel'
import { getAdminDashboardData, type DashboardData } from '@/services/adminDashboardService'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency, formatCompactCurrency, formatDate, getWeekStart, today } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'
import { parseISO } from 'date-fns'
import { calendar } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'
import { fetchPanel, isRouteBaseUi, sumRows, useCapitalModel, type RoutePanel } from '../../../runtime/routeBase/api.ts'

export default function DashboardPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  // R74 · Base por Ruta: panel por ruta de la semana (cifras de efectivo correctas y separadas).
  const model = useCapitalModel()
  const rb = isRouteBaseUi(model)
  const [panel, setPanel] = useState<RoutePanel | null>(null)
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
  useEffect(() => {
    if (!rb) { setPanel(null); return }
    let alive = true
    calendar().then(cal => {
      const hoy = cal.businessDate
      const desde = getWeekStart(parseISO(`${hoy}T12:00:00`))
      return fetchPanel(desde <= hoy ? desde : hoy, hoy)
    }).then(p => { if (alive) setPanel(p) }).catch(() => undefined)
    return () => { alive = false }
  }, [rb, revision])

  if (loading) return <LoadingState message="Cargando dashboard..." />
  if (!data) return null

  // Ronda 50: ejes abreviados y legibles en la moneda de la empresa (los tooltips, exactos).
  const axisMoney = (v: number) => formatCompactCurrency(v, currency)
  const money = (v: number) => formatCurrency(v, currency)
  const m = (minor: number) => money(toMajor(minor))
  const t = panel ? sumRows(panel.routes) : null

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
      {rb && t && panel ? (
        <>
          {/* R74 · Base por Ruta: el efectivo (Base + custodias) y la cartera, nunca sumados entre sí. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="dashboard-kpis">
            <KPICard title="Base disponible" value={m(t.baseMinor)} icon={<Wallet className="w-5 h-5" />} color="blue" subtitle="De tus rutas" />
            <KPICard title="Base del trabajador" value={m(t.custodyMinor)} icon={<Users className="w-5 h-5" />} color="purple" subtitle="En manos de trabajadores" />
            <KPICard title="Efectivo de las rutas" value={m(t.cashMinor)} icon={<DollarSign className="w-5 h-5" />} color="green" subtitle="Base disponible + Base del trabajador" />
            <KPICard title="Capital colocado" value={m(t.principalPlacedMinor)} icon={<CreditCard className="w-5 h-5" />} color="gray"
              subtitle="Sin interés · no es efectivo" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="dashboard-route-base">
            <MiniStat label="Recaudo hoy" value={money(data.recaudoHoy)} icon={<TrendingUp className="w-4 h-4 text-emerald-600" />} />
            <MiniStat label="Resultado operativo" value={m(t.resultMinor)} tone={t.resultMinor < 0 ? 'text-red-600' : undefined}
              hint="Semana · no es utilidad contable ni dinero retirable" icon={<Scale className="w-4 h-4 text-gray-500" />} />
            <MiniStat label={t.differences ? 'Faltantes pendientes' : 'Faltantes arrastrados'} value={m(t.differences ? t.differences.shortagePendingMinor : t.shortageMinor)}
              tone={(t.differences ? t.differences.shortagePendingMinor : t.shortageMinor) > 0 ? 'text-amber-700' : undefined}
              hint="No es billete" icon={<AlertTriangle className="w-4 h-4 text-amber-600" />} />
            <MiniStat label={t.differences ? 'Sobrantes pendientes' : 'Sobrantes en control'} value={m(t.differences ? t.differences.surplusPendingMinor : t.surplusMinor)}
              hint="Aparte; no es Base disponible" icon={<Scale className="w-4 h-4 text-gray-500" />} />
            <MiniStat label="Reembolsos pendientes" value={m(panel.general.pendingAdminReimbursements?.totalMinor ?? 0)}
              hint="A Administradores · obligación; no es efectivo" icon={<HandCoins className="w-4 h-4 text-violet-600" />} />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="dashboard-kpis">
          <KPICard
            title="Recaudo hoy"
            value={money(data.recaudoHoy)}
            icon={<TrendingUp className="w-5 h-5" />}
            color="green"
            subtitle="Del día"
          />
          <KPICard
            title="Cartera activa"
            value={money(data.carteraEnCalle)}
            icon={<CreditCard className="w-5 h-5" />}
            color="purple"
            subtitle={`${data.ventasActivas} ventas activas · incluye interés no cobrado`}
          />
          {/* R74 (§4.2): era «Base total», pero es Σ custodias (efectivo en manos de trabajadores; sin bolsas). */}
          <KPICard
            title="Base del trabajador"
            value={money(data.baseActualTotal)}
            icon={<DollarSign className="w-5 h-5" />}
            color="blue"
            subtitle="Efectivo de los trabajadores · sin bolsas"
          />
          {/* R74 (§4.2): era «Total controlado» e incluía interés no cobrado sin decirlo. */}
          <KPICard
            title="Base del trabajador + Cartera activa"
            value={money(data.totalControlado)}
            icon={<TrendingUp className="w-5 h-5" />}
            color="green"
            subtitle="La cartera (con interés) no es efectivo"
          />
        </div>
      )}

      {/* Indicadores secundarios, en una franja compacta. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="dashboard-secondary">
        <MiniStat label="Recaudo semanal" value={money(data.recaudoSemana)} icon={<ArrowUpRight className="w-4 h-4 text-emerald-600" />} />
        <MiniStat label="Gastos semana" value={money(data.gastosSemana)} icon={<TrendingDown className="w-4 h-4 text-red-500" />} />
        <MiniStat label="Clientes activos" value={String(data.clientesActivos)} icon={<Users className="w-4 h-4 text-primary-600" />} />
        <MiniStat label="Rutas con mora" value={String(data.rutasConMora)} tone={data.rutasConMora > 0 ? 'text-red-600' : undefined}
          icon={<AlertTriangle className={`w-4 h-4 ${data.rutasConMora > 0 ? 'text-red-500' : 'text-emerald-600'}`} />} />
        {rb
          ? <MiniStat label="Ventas activas" value={String(data.ventasActivas)} icon={<MapPin className="w-4 h-4 text-gray-500" />} />
          : <MiniStat label="Pendiente sync" value={String(data.pagosPendientesSync)} tone={data.pagosPendientesSync > 0 ? 'text-amber-600' : undefined}
              icon={<WifiOff className="w-4 h-4 text-gray-500" />} />}
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

/** Indicador secundario compacto (Ronda 50). R74: con una aclaración opcional (p. ej. «no es efectivo»). */
function MiniStat({ label, value, icon, tone, hint }: { label: string; value: string; icon: React.ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-card px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">{icon}<span className="truncate" title={label}>{label}</span></div>
      <p className={`mt-1 text-base font-bold tabular-nums leading-tight ${tone ?? 'text-gray-900'}`}>{value}</p>
      {hint && <p className="text-[11px] leading-tight text-gray-500">{hint}</p>}
    </div>
  )
}
