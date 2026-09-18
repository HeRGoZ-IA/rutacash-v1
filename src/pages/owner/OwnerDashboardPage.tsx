import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, CheckCircle, PauseCircle, FlaskConical, Route as RouteIcon, Receipt } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { controlPlane } from '@/platform/controlPlane'
import { ownerKpis, type OwnerKpis } from '@/platform/companyControlService'
import { COMMERCIAL_STATUS_LABEL } from '@/platform/types'
import type { CompanyControlRecord, SaaSPayment } from '@/platform/types'

/**
 * DASHBOARD RutaCash — pantalla inicial del Owner.
 *
 * Es lo PRIMERO que ve al entrar: no hay pantalla genérica intermedia ni panel de
 * empresa reutilizado. Los indicadores son los que sirven para administrar el
 * negocio: cuántas empresas hay y en qué estado, cuántas rutas se facturan y cuánto
 * se espera cobrar. Ningún indicador operativo del cliente aparece aquí, porque
 * ninguno se lee.
 */
export default function OwnerDashboardPage() {
  const navigate = useNavigate()
  const [kpis, setKpis] = useState<OwnerKpis | null>(null)
  const [companies, setCompanies] = useState<CompanyControlRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      const [records, payments]: [CompanyControlRecord[], SaaSPayment[]] =
        await Promise.all([controlPlane.listCompanies(), controlPlane.listPayments()])
      if (!vivo) return
      setCompanies(records)
      setKpis(ownerKpis(records, payments))
      setLoading(false)
    })().catch(() => setLoading(false))
    return () => { vivo = false }
  }, [])

  if (loading || !kpis) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
      </div>
    )
  }

  const tiles = [
    { label: 'Empresas totales', value: kpis.empresasTotales, icon: <Building2 className="w-4 h-4" />, tone: 'bg-gray-50 text-gray-700 border-gray-200' },
    { label: 'Activas', value: kpis.empresasActivas, icon: <CheckCircle className="w-4 h-4" />, tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    { label: 'En prueba', value: kpis.empresasPrueba, icon: <FlaskConical className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-700 border-amber-200' },
    { label: 'Suspendidas', value: kpis.empresasSuspendidas, icon: <PauseCircle className="w-4 h-4" />, tone: 'bg-red-50 text-red-700 border-red-200' },
    { label: 'Rutas actuales', value: kpis.rutasActuales, icon: <RouteIcon className="w-4 h-4" />, tone: 'bg-gray-50 text-gray-700 border-gray-200' },
    { label: 'Rutas facturables', value: kpis.rutasFacturables, icon: <RouteIcon className="w-4 h-4" />, tone: 'bg-primary-50 text-primary-700 border-primary-200' },
    { label: 'Cobro esperado', value: formatCurrency(kpis.cobroEsperadoPeriodo), icon: <Receipt className="w-4 h-4" />, tone: 'bg-primary-50 text-primary-700 border-primary-200' },
    { label: 'Cobros pendientes', value: kpis.cobrosPendientes, icon: <Receipt className="w-4 h-4" />, tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Dashboard RutaCash</h1>
        <p className="text-sm text-gray-500 mt-0.5">Estado comercial de la plataforma</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map(t => (
          <div key={t.label} className={`rounded-2xl border p-4 ${t.tone}`}>
            <div className="flex items-center gap-1.5 opacity-70">{t.icon}<span className="text-xs font-medium">{t.label}</span></div>
            <p className="text-2xl font-bold mt-1.5 tabular-nums">{t.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="font-semibold text-gray-900 text-sm">Empresas</p>
          <button onClick={() => navigate('/owner/empresas')} className="text-xs font-medium text-primary-600 hover:underline">
            Ver todas
          </button>
        </div>
        {companies.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-500">Todavía no hay empresas.</p>
            <button onClick={() => navigate('/owner/empresas')}
              className="mt-3 h-10 px-4 bg-gray-900 hover:bg-black text-white rounded-xl text-sm font-medium">
              Crear la primera empresa
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {companies.slice(0, 6).map(c => (
              <button key={c.companyId} onClick={() => navigate(`/owner/empresas/${c.companyId}`)}
                className="w-full flex items-center gap-4 px-5 py-3 hover:bg-gray-50 text-left transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.nombre}</p>
                  <p className="text-xs text-gray-400">Alta {formatDate(c.createdAt)}</p>
                </div>
                <span className="text-xs text-gray-500 tabular-nums">{c.billableRouteCount} rutas fact.</span>
                <span className="text-xs font-medium text-gray-600">{COMMERCIAL_STATUS_LABEL[c.status]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
