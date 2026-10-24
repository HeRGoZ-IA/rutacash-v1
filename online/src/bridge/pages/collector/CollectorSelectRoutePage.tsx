// ADEX Online: COPIA de src/pages/collector/CollectorSelectRoutePage.tsx (CLEAN). Cambios marcados «ADEX Online»
// (R74, indicador del Supervisor en «Selecciona tu ruta»):
//   · En CLEAN la cifra es la Base de la ruta (`getRouteBase`: libro completo de la ruta, caja + trabajadores) y su
//     rótulo es correcto: el original no se toca.
//   · En Online, `getRouteAvailableCapital` (puente de cashboxEngine) devuelve Σ custodias de la ruta. Con el modelo de
//     bolsas (`admin_pool`) la ruta no tiene caja propia, así que esa cifra es el EFECTIVO EN CUSTODIAS, no una Base:
//     se rotula «Efectivo en custodias» (mismo criterio que el Dashboard de R74).
//   · Con Base por Ruta (`route_base` o `migrating`), la Base REAL es el saldo de la cuenta de Base de la ruta y sale
//     del panel por ruta del servidor (`GET /v1/capital/route-panel`, `cashbox.viewRoute`). Se muestran por separado
//     «Base disponible» y «Efectivo en custodias» (las dos del mismo panel, sin sumar una dentro de la otra).
//   · Guarda intacta: sin `cashbox.viewRoute` (Cobrador) no se consulta ni el modelo ni el panel ni las custodias.
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { MapPin, ChevronRight, ArrowRight } from 'lucide-react'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useDataRevision } from '@/hooks/useDataRevision'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { can } from '@/lib/permissions'
import { formatCurrency } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'
import { isSaleDisbursed } from '@/services/installmentEngine'
import { carteraEnCalleOf, getRouteAvailableCapital } from '@/services/cashboxEngine'
import { groupRoutesByOffice } from '@/lib/officeGrouping'
import type { Office, Route } from '@/models/types'
// ADEX Online: modelo de capital y panel por ruta del servidor.
import { calendar } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'
import { fetchModel, fetchPanel, isRouteBaseUi } from '../../../runtime/routeBase/api.ts'

interface RouteSummary {
  route: Route
  clientes: number
  ventasActivas: number
  cartera: number
  /**
   * ADEX Online: cifras de efectivo de la ruta. `undefined` cuando el usuario NO tiene `cashbox.viewRoute`: no se
   * piden (el Cobrador no debe conocer la cifra financiera de la ruta ni por accidente).
   *   · `custodia`: efectivo en manos de los trabajadores de la ruta (servidor).
   *   · `base`: Base disponible de la ruta (cuenta de Base del servidor); SOLO con Base por Ruta. En el modelo de
   *     bolsas la ruta no tiene Base propia y queda `undefined`.
   */
  efectivo?: { custodia: number; base?: number }
}

/** ADEX Online: Base y custodias por ruta del panel del servidor (Base por Ruta); `null` en el modelo de bolsas. */
async function routeBaseFigures(): Promise<Map<string, { base: number; custodia: number }> | null> {
  const model = await fetchModel().then((m) => m.model).catch(() => 'admin_pool' as const)
  if (!isRouteBaseUi(model)) return null
  const hoy = (await calendar()).businessDate
  const panel = await fetchPanel(hoy, hoy)
  return new Map(panel.routes.map((r) => [r.routeId, { base: toMajor(r.baseMinor), custodia: toMajor(r.custody.grossMinor) }]))
}

export default function CollectorSelectRoutePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId, setActiveRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const base = useOpBase()
  const [summaries, setSummaries] = useState<RouteSummary[]>([])
  // Oficinas SOLO para agrupar visualmente. Elegir una Oficina no existe como paso
  // ni habilita rutas: las rutas mostradas son exactamente las autorizadas.
  const [offices, setOffices] = useState<Office[]>([])
  const [loading, setLoading] = useState(true)

  // Se recalcula en silencio (sin spinner) con cada escritura, y una carga superada
  // por otra más nueva no pisa el resultado (`vigente`).
  const revision = useDataRevision()
  useEffect(() => {
    let alive = true
    load(() => alive)
    return () => { alive = false }
  }, [user, revision])

  async function load(vigente: () => boolean) {
    if (!user) { setLoading(false); return }
    const ids = getAuthorizedRouteIds(user)
    const all = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    const mine = all.filter(r => ids.includes(r.id))
    const oficinas = await db.offices.where('tenantId').equals(user.tenantId).toArray()
    // ADEX Online: el panel por ruta se pide UNA vez y solo si alguna ruta pasa la guarda de caja.
    const verAlguna = mine.some(r => can(user, 'cashbox.viewRoute', { routeId: r.id, tenantId: user.tenantId }))
    const rb = verAlguna ? await routeBaseFigures().catch(() => null) : null
    const result: RouteSummary[] = []
    for (const route of mine) {
      const sales = (await db.sales.where('routeId').equals(route.id).and(s => s.status === 'activa').toArray()).filter(isSaleDisbursed)
      // Cifras de efectivo: solo para quien puede ver la caja financiera de ESA ruta (Supervisor,
      // Admin, Super Admin). Fail-closed: sin la capacidad el dato ni se consulta.
      const verBase = can(user, 'cashbox.viewRoute', { routeId: route.id, tenantId: user.tenantId })
      const fila = rb?.get(route.id)
      result.push({
        route,
        clientes: new Set(sales.map(s => s.clientId)).size,
        ventasActivas: sales.length,
        cartera: carteraEnCalleOf(sales),
        efectivo: !verBase ? undefined
          : fila ? { base: fila.base, custodia: fila.custodia }
          : { custodia: await getRouteAvailableCapital(route.id) },
      })
    }
    if (!vigente()) return
    setOffices(oficinas)
    setSummaries(result)
    setLoading(false)
  }

  function enter(routeId: string) {
    setActiveRouteId(routeId)
    navigate(`${base}/home`)
  }

  return (
    <div className="p-4 space-y-5">
      <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-5 text-white">
        <p className="text-primary-200 text-sm">Hola, {formatPersonName(user?.nombre)}</p>
        <h1 className="text-xl font-bold mt-0.5">Selecciona tu ruta</h1>
        <p className="text-primary-200 text-xs mt-1">Elige la ruta que vas a trabajar hoy</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : (
        <div className="space-y-5">
          {groupRoutesByOffice(summaries.map(s => s.route), offices).map(grupo => (
          <div key={grupo.key} className="space-y-3">
            {(offices.length > 0 || grupo.key !== '__sin_oficina__') && summaries.length > 1 && (
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-500 px-1">{grupo.label}</p>
            )}
          {grupo.routes.map(r => summaries.find(s => s.route.id === r.id)!).map(({ route, clientes, ventasActivas, cartera, efectivo }) => {
            const isActive = route.id === activeRouteId
            const single = summaries.length === 1
            // ADEX Online: con Base por Ruta la cifra principal es la Base disponible; en el modelo de bolsas, las custodias.
            const conBase = efectivo?.base !== undefined
            return (
              <div key={route.id} data-testid={`sel-route-${route.id}`} className={`bg-white rounded-2xl border shadow-card p-4 ${isActive ? 'border-primary-300' : 'border-gray-100'}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                      <MapPin className="w-5 h-5 text-primary-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm truncate">{route.nombre}</p>
                      <p className="text-xs text-gray-500">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                    </div>
                  </div>
                  {isActive && <span className="text-[10px] font-semibold text-primary-600 bg-primary-50 rounded-full px-2 py-0.5">Activa</span>}
                </div>

                {/* Importes: tamaño fluido y corte seguro para que cifras de 8+ dígitos no se salgan en 360 px. */}
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-gray-700">{clientes}</p>
                    <p className="text-xs text-gray-500">Clientes</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-sm font-bold text-primary-600">{ventasActivas}</p>
                    <p className="text-xs text-gray-500">Ventas</p>
                  </div>
                  {efectivo === undefined ? (
                    <div className="bg-gray-50 rounded-xl p-2 text-center">
                      <p className="text-[clamp(11px,3.4vw,14px)] font-bold text-amber-600 leading-tight break-all">{formatCurrency(cartera, currency)}</p>
                      <p className="text-xs text-gray-500">Cartera</p>
                    </div>
                  ) : conBase ? (
                    <div className="bg-primary-50 rounded-xl p-2 text-center" data-testid={`sel-route-base-${route.id}`}>
                      <p className="text-[clamp(11px,3.4vw,14px)] font-bold text-primary-700 leading-tight break-all">{formatCurrency(efectivo.base!, currency)}</p>
                      <p className="text-xs text-primary-500">Base disponible</p>
                    </div>
                  ) : (
                    <div className="bg-primary-50 rounded-xl p-2 text-center" data-testid={`sel-route-custody-${route.id}`}>
                      <p className="text-[clamp(11px,3.4vw,14px)] font-bold text-primary-700 leading-tight break-all">{formatCurrency(efectivo.custodia, currency)}</p>
                      <p className="text-xs text-primary-500 leading-tight">Efectivo en custodias</p>
                    </div>
                  )}
                </div>

                {conBase && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-1.5" data-testid={`sel-route-custody-${route.id}`}>
                    <span className="text-xs text-gray-500">Efectivo en custodias <span className="text-gray-400">(en manos de trabajadores)</span></span>
                    <span className="text-xs font-semibold text-gray-700 whitespace-nowrap">{formatCurrency(efectivo!.custodia, currency)}</span>
                  </div>
                )}

                {efectivo !== undefined && (
                  <div className="mt-2 flex items-center justify-between rounded-xl bg-gray-50 px-3 py-1.5">
                    <span className="text-xs text-gray-500">Cartera</span>
                    <span className="text-xs font-semibold text-amber-600">{formatCurrency(cartera, currency)}</span>
                  </div>
                )}

                <button
                  onClick={() => enter(route.id)}
                  className="mt-3 w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2"
                >
                  {single ? <>Entrar a la ruta <ArrowRight className="w-4 h-4" /></> : <>Trabajar esta ruta <ChevronRight className="w-4 h-4" /></>}
                </button>
              </div>
            )
          })}
          </div>
          ))}
        </div>
      )}
    </div>
  )
}
