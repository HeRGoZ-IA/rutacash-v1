import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, MapPin, LogIn, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency } from '@/lib/formatters'
import { NO_OFFICE } from '@/lib/officeGrouping'
import { getOfficesExecutiveSummary, type OfficesExecutiveSummary } from '@/services/officeService'

/**
 * RESUMEN EJECUTIVO DE OFICINAS para el panel de empresa.
 *
 * Es un RESUMEN, no una copia del panel de Oficina: una tarjeta por Oficina con lo
 * imprescindible y un botón para entrar. Debajo, el comparativo objetivo en tabla
 * —sin ranking ni juicios—, porque comparar Oficinas es una lectura, no una
 * clasificación.
 *
 * Cada fila se calcula SOLO con las rutas que el usuario tiene autorizadas. Cuando
 * su alcance sobre una Oficina es parcial, la fila lo declara ("2/4 rutas") en vez
 * de aparentar el total. "Sin Oficina" aparece como agrupación derivada.
 */
export function OfficesExecutivePanel() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [data, setData] = useState<OfficesExecutiveSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    if (!user || !tenantId) { setLoading(false); return }
    getOfficesExecutiveSummary({ user, tenantId }).then(r => {
      if (!alive) return
      setData(r)
      setLoading(false)
    })
    return () => { alive = false }
  }, [user, tenantId])

  if (loading || !data || data.rows.length === 0) return null

  const { rows, company } = data
  const entrar = (officeId: string) =>
    navigate(officeId === NO_OFFICE ? '/admin/offices/sin-oficina' : `/admin/offices/${officeId}`)

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Building2 className="w-4 h-4 text-gray-400" /> Oficinas
        </h2>
        <span className="text-xs text-gray-400">
          {company.oficinasVisibles} oficina(s) · {company.rutasVisibles} ruta(s)
          {company.rutasSinOficina > 0 ? ` · ${company.rutasSinOficina} sin oficina` : ''}
        </span>
      </div>

      {/* Tarjetas por Oficina */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {rows.map(row => (
          <Card key={row.officeId} className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {row.officeId === NO_OFFICE
                    ? <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    : <Building2 className="w-4 h-4 text-primary-500 flex-shrink-0" />}
                  <h3 className="font-semibold text-gray-900 text-sm truncate">{row.nombre}</h3>
                </div>
                <p className={`text-xs ml-6 ${row.parcial ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>
                  {row.alcance}{row.parcial ? ' autorizadas' : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                {row.status === 'inactiva' && <Badge variant="danger">Inactiva</Badge>}
                {row.alertas > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                    <AlertTriangle className="w-3 h-3" />{row.alertas}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-50 rounded-xl p-2 text-center">
                <p className="text-sm font-bold text-gray-700">{row.totals.clientesActivos}</p>
                <p className="text-xs text-gray-400">Clientes</p>
              </div>
              <div className="bg-indigo-50 rounded-xl p-2 text-center">
                <p className="text-sm font-bold text-indigo-600 truncate">{formatCurrency(row.totals.carteraActiva, currency)}</p>
                <p className="text-xs text-gray-400">Cartera</p>
              </div>
              <div className="bg-emerald-50 rounded-xl p-2 text-center">
                <p className="text-sm font-bold text-emerald-600 truncate">{formatCurrency(row.totals.recaudadoHoy, currency)}</p>
                <p className="text-xs text-gray-400">Hoy</p>
              </div>
            </div>

            {row.totals.aCobrarHoy > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Cumplimiento</span>
                  <span>{row.totals.cumplimiento}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div className={`h-full rounded-full ${row.totals.cumplimiento >= 80 ? 'bg-emerald-500' : row.totals.cumplimiento >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                    style={{ width: `${row.totals.cumplimiento}%` }} />
                </div>
              </div>
            )}

            <Button size="sm" className="w-full" icon={<LogIn className="w-3.5 h-3.5" />}
              onClick={() => entrar(row.officeId)}>
              Entrar
            </Button>
          </Card>
        ))}
      </div>

      {/* Comparativo objetivo. Sin ranking: es una lectura, no una clasificación. */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="text-left font-medium px-3 py-2">Oficina</th>
              <th className="text-right font-medium px-3 py-2">Rutas</th>
              <th className="text-right font-medium px-3 py-2">Clientes</th>
              <th className="text-right font-medium px-3 py-2">Ventas</th>
              <th className="text-right font-medium px-3 py-2">Cartera</th>
              <th className="text-right font-medium px-3 py-2">Vencida</th>
              <th className="text-right font-medium px-3 py-2">Recaudo hoy</th>
              <th className="text-right font-medium px-3 py-2">Cumpl.</th>
              <th className="text-right font-medium px-3 py-2">Gastos</th>
              <th className="text-right font-medium px-3 py-2">Alertas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map(row => (
              <tr key={row.officeId} className="hover:bg-gray-50 cursor-pointer" onClick={() => entrar(row.officeId)}>
                <td className="px-3 py-2">
                  <span className="font-medium text-gray-800">{row.nombre}</span>
                  {row.parcial && <span className="ml-1.5 text-xs text-amber-600">rutas autorizadas</span>}
                </td>
                <td className="px-3 py-2 text-right text-gray-600">{row.alcance}</td>
                <td className="px-3 py-2 text-right text-gray-600">{row.totals.clientesActivos}</td>
                <td className="px-3 py-2 text-right text-gray-600">{row.totals.ventasActivas}</td>
                <td className="px-3 py-2 text-right text-gray-700">{formatCurrency(row.totals.carteraActiva, currency)}</td>
                <td className={`px-3 py-2 text-right ${row.totals.carteraVencida > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                  {formatCurrency(row.totals.carteraVencida, currency)}
                </td>
                <td className="px-3 py-2 text-right text-emerald-600">{formatCurrency(row.totals.recaudadoHoy, currency)}</td>
                <td className="px-3 py-2 text-right text-gray-600">{row.totals.aCobrarHoy > 0 ? `${row.totals.cumplimiento}%` : '—'}</td>
                <td className="px-3 py-2 text-right text-gray-600">{formatCurrency(row.totals.gastosHoy, currency)}</td>
                <td className={`px-3 py-2 text-right ${row.alertas > 0 ? 'text-amber-600 font-medium' : 'text-gray-300'}`}>{row.alertas}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 text-xs">
            <tr>
              <td className="px-3 py-2 font-semibold text-gray-700">Total visible</td>
              <td className="px-3 py-2 text-right text-gray-600">{company.rutasVisibles}</td>
              <td className="px-3 py-2 text-right text-gray-600">{company.totals.clientesActivos}</td>
              <td className="px-3 py-2 text-right text-gray-600">{company.totals.ventasActivas}</td>
              <td className="px-3 py-2 text-right text-gray-700">{formatCurrency(company.totals.carteraActiva, currency)}</td>
              <td className="px-3 py-2 text-right text-gray-600">{formatCurrency(company.totals.carteraVencida, currency)}</td>
              <td className="px-3 py-2 text-right text-emerald-600">{formatCurrency(company.totals.recaudadoHoy, currency)}</td>
              <td className="px-3 py-2 text-right text-gray-600">{company.totals.aCobrarHoy > 0 ? `${company.totals.cumplimiento}%` : '—'}</td>
              <td className="px-3 py-2 text-right text-gray-600">{formatCurrency(company.totals.gastosHoy, currency)}</td>
              <td className="px-3 py-2 text-right text-gray-600">{company.alertas}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
