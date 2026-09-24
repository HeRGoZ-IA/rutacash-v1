import { useState, useEffect, useCallback } from 'react'
import { CalendarRange, Download, RefreshCw, Lock, LockOpen, History } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { LoadingState } from '@/components/ui/EmptyState'
import { RouteSelector, routeFileTag } from '@/components/ui/RouteSelector'
import { OfficeSelector } from '@/components/ui/OfficeSelector'
import { useAccessibleOffices } from '@/hooks/useAccessibleOffices'
import { ALL_OFFICES, filterRoutesByOffice } from '@/lib/officeGrouping'
import { resolveOfficeParam } from '@/lib/officeRouteFilter'
import { useSearchParams } from 'react-router-dom'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { generateWeeklySettlementForUser } from '@/services/weeklySettlementEngine'
import {
  closeSettlement,
  reopenSettlement,
  listSettlementsOfRoute,
  MIN_REOPEN_REASON,
} from '@/services/settlementService'
import {
  closedSettlementCsvRow,
  closureBlockedReason,
  isProtectingClosure,
  periodBadge,
  settlementHistory,
  type SettlementHistoryRow,
} from '@/lib/settlementPeriods'
import { filterAccessibleRoutes, canAccessRoute, can } from '@/lib/permissions'
import { formatCurrency, formatDate, getWeekStart, getWeekEnd } from '@/lib/formatters'
import { downloadCSV } from '@/lib/utils'
import type { WeeklySettlement, Route } from '@/models/types'

/**
 * LIQUIDACIÓN SEMANAL — SIEMPRE DE UNA RUTA.
 * La ruta es obligatoria: no existe modo "todas las rutas", porque una liquidación
 * consolidada mezclaría cajas independientes. El orden de filtrado es
 * rutas permitidas → ruta seleccionada → cálculo, y el servicio revalida el
 * alcance (fail-closed) antes de leer un solo movimiento.
 *
 * DOS COSAS DISTINTAS EN ESTA PANTALLA:
 *  · GENERAR es una vista previa. Se recalcula cada vez y no queda archivada.
 *  · CERRAR SEMANA archiva el documento. A partir de ese momento las cifras quedan
 *    congeladas y los pagos de esas fechas dejan de ser corregibles directamente:
 *    pasan por Solicitud de ajuste. El CSV de una semana cerrada sale del documento
 *    archivado, nunca de un recálculo.
 */
export default function WeeklySettlementPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const [routes, setRoutes] = useState<Route[]>([])
  const [routeId, setRouteId] = useState('')
  // Oficinas derivadas de las rutas accesibles. Filtro PREVIO: la liquidación sigue
  // siendo de UNA ruta; no existe liquidación consolidada por Oficina.
  const { offices, allOffices, hasUnassigned } = useAccessibleOffices()
  const [officeId, setOfficeId] = useState(ALL_OFFICES)
  /**
   * CONTEXTO DESDE EL PANEL DE OFICINA (`?officeId=`). Se valida contra el catálogo
   * de la empresa: un id ajeno o inventado se ignora y se cae a "todas las
   * oficinas" — nunca amplía el alcance, porque el filtro se aplica sobre rutas ya
   * autorizadas. Se consume una sola vez para que un refresco no reimponga un
   * filtro que el usuario ya cambió.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const [officeParamAplicado, setOfficeParamAplicado] = useState(false)
  useEffect(() => {
    if (officeParamAplicado) return
    const crudo = searchParams.get('officeId')
    if (crudo && allOffices.length > 0) {
      setOfficeId(resolveOfficeParam(crudo, allOffices))
      const limpios = new URLSearchParams(searchParams)
      limpios.delete('officeId')
      setSearchParams(limpios, { replace: true })
      setOfficeParamAplicado(true)
    } else if (!crudo) {
      setOfficeParamAplicado(true)
    }
  }, [officeParamAplicado, searchParams, allOffices, setSearchParams])

  const [semanaInicio, setSemanaInicio] = useState(getWeekStart())
  const [semanaFin, setSemanaFin] = useState(getWeekEnd())
  const [settlement, setSettlement] = useState<WeeklySettlement | null>(null)
  /** Ruta con la que se generó la liquidación mostrada (para encabezado y CSV). */
  const [generatedRoute, setGeneratedRoute] = useState<Route | null>(null)
  const [loading, setLoading] = useState(false)
  const [closing, setClosing] = useState(false)

  /** Liquidaciones ARCHIVADAS de la ruta seleccionada (historial y protección). */
  const [archivadas, setArchivadas] = useState<WeeklySettlement[]>([])
  const [reabrir, setReabrir] = useState<WeeklySettlement | null>(null)
  const [motivo, setMotivo] = useState('')
  const [reabriendo, setReabriendo] = useState(false)

  const puedeCerrar = can(user, 'settlement.close', { routeId: routeId || undefined, tenantId })
  const puedeReabrir = can(user, 'settlement.reopen', { routeId: routeId || undefined, tenantId })

  useEffect(() => { loadMeta() }, [tenantId, user])

  /** Historial de la ruta. Se recarga tras cada cierre o reapertura. */
  const loadHistorial = useCallback(async () => {
    if (!routeId || !canAccessRoute(user, routeId)) { setArchivadas([]); return }
    setArchivadas(await listSettlementsOfRoute(routeId))
  }, [routeId, user])

  useEffect(() => { loadHistorial() }, [loadHistorial])

  /**
   * VISTA PREVIA VIVA. La vista previa es un cálculo, no un documento: si mientras
   * está en pantalla un Cobrador o Supervisor registra un cobro en esta ruta (en
   * otra pestaña del mismo navegador), se recalcula con los MISMOS parámetros con
   * los que se generó. Un documento CERRADO nunca se recalcula: sus cifras son las
   * archivadas.
   */
  const [previewKey, setPreviewKey] = useState<{ routeId: string; semanaInicio: string; semanaFin: string } | null>(null)
  const revision = useDataRevision()
  useEffect(() => {
    if (revision === 0) return
    loadHistorial()
    if (!previewKey) return
    let alive = true
    generateWeeklySettlementForUser({ user, tenantId, ...previewKey })
      .then(data => { if (alive && data) setSettlement(data) })
      .catch(() => { /* la vista previa anterior sigue visible */ })
    return () => { alive = false }
  }, [revision])  // eslint-disable-line react-hooks/exhaustive-deps

  // Rutas ofrecidas: las accesibles, recortadas por la Oficina elegida.
  const routesInOffice = filterRoutesByOffice(routes, officeId)

  /**
   * Al cambiar de Oficina, si la ruta seleccionada ya no pertenece al filtro se
   * LIMPIA: dejarla puesta mostraría "Generar" habilitado sobre una ruta invisible.
   */
  function changeOffice(next: string) {
    setOfficeId(next)
    if (routeId && !filterRoutesByOffice(routes, next).some(r => r.id === routeId)) setRouteId('')
  }

  async function loadMeta() {
    // RESTRICCIÓN POR RUTAS: el selector solo ofrece rutas autorizadas.
    const rts = filterAccessibleRoutes(user, await db.routes.where('tenantId').equals(tenantId).toArray())
    setRoutes(rts)
    // Con una sola ruta accesible, se preselecciona (sigue siendo obligatoria).
    if (rts.length === 1) setRouteId(rts[0].id)
  }

  async function generate() {
    if (!routeId) { toast.error('Selecciona la ruta que deseas liquidar.'); return }
    // Guarda de datos en la pantalla; el servicio la repite (defensa en profundidad).
    if (!canAccessRoute(user, routeId)) { toast.error('No tienes acceso a esa ruta.'); return }
    setLoading(true)
    try {
      const data = await generateWeeklySettlementForUser({ user, tenantId, routeId, semanaInicio, semanaFin })
      if (!data) {
        setSettlement(null)
        setPreviewKey(null)
        setGeneratedRoute(null)
        toast.error('No tienes acceso a esa ruta.')
        return
      }
      setSettlement(data)
      setPreviewKey({ routeId, semanaInicio, semanaFin })
      setGeneratedRoute(routes.find(r => r.id === routeId) ?? null)
      toast.success(`Liquidación generada: ${routes.find(r => r.id === routeId)?.nombre ?? 'ruta'}`)
    } catch { toast.error('Error al generar liquidación') } finally { setLoading(false) }
  }

  /**
   * CIERRE. El servicio vuelve a calcular con el motor financiero y archiva: esta
   * pantalla no le entrega importes, solo la ruta y el rango.
   */
  async function cerrarSemana() {
    if (!routeId) { toast.error('Selecciona la ruta que deseas cerrar.'); return }
    setClosing(true)
    try {
      const doc = await closeSettlement({ actor: user, tenantId, routeId, semanaInicio, semanaFin })
      toast.success(`Semana cerrada (versión ${doc.version ?? 1}). Las cifras quedan congeladas.`)
      setSettlement(doc)
      setPreviewKey(null)  // se muestra el documento archivado: ya no se recalcula
      setGeneratedRoute(routes.find(r => r.id === routeId) ?? null)
      await loadHistorial()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cerrar la semana.')
    } finally { setClosing(false) }
  }

  async function confirmarReapertura() {
    if (!reabrir) return
    setReabriendo(true)
    try {
      await reopenSettlement({ actor: user, settlementId: reabrir.id, motivo })
      toast.success('Período reabierto. Los pagos de esas fechas vuelven a ser corregibles.')
      setReabrir(null)
      setMotivo('')
      await loadHistorial()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo reabrir el período.')
    } finally { setReabriendo(false) }
  }

  /** Vista previa: se advierte que NO es un documento archivado. */
  function exportCSV() {
    if (!settlement) { toast.warning('Genera primero'); return }
    // Una sola fila: la de la ruta liquidada. Imposible que contenga otra ruta.
    const rows = [{
      Ruta: generatedRoute?.nombre ?? settlement.routeId,
      'Código ruta': generatedRoute?.codigo ?? '',
      'Semana inicio': formatDate(settlement.semanaInicio),
      'Semana fin': formatDate(settlement.semanaFin),
      'Saldo anterior': settlement.saldoAnterior,
      'Ingreso capital': settlement.ingresoCapital,
      Cobros: settlement.cobros,
      'Préstamos entregados': settlement.prestamosEntregados,
      Gastos: settlement.gastos,
      'Transferencias entrada': settlement.transferenciasEntradas,
      'Transferencias salida': settlement.transferenciasSalidas,
      Retiros: settlement.retiros,
      'Saldo final': settlement.saldoFinal,
    }]
    downloadCSV(rows, `liquidacion_${routeFileTag(routes, settlement.routeId)}_${semanaInicio}_${semanaFin}.csv`)
    toast.success('CSV descargado')
  }

  /**
   * CSV DE UNA SEMANA CERRADA: sale ÍNTEGRO del documento archivado.
   * Si se recalculase, un pago corregido después del cierre cambiaría el CSV de una
   * semana ya cerrada y el documento dejaría de probar nada.
   */
  function exportCierre(fila: SettlementHistoryRow) {
    const s = fila.settlement
    downloadCSV(
      [closedSettlementCsvRow(s, fila.routeName, fila.routeCode)],
      `cierre_${routeFileTag(routes, s.routeId)}_${s.semanaInicio}_${s.semanaFin}_v${s.version ?? 1}.csv`,
    )
    toast.success('CSV del cierre descargado')
  }

  // Motivo del bloqueo del botón Cerrar (rango inválido o semana ya cerrada).
  const bloqueoCierre = routeId ? closureBlockedReason(archivadas, routeId, semanaInicio, semanaFin) : null
  const historial = settlementHistory(archivadas, routes, allOffices)

  const Row = ({ label, value, tone = 'text-gray-700' }: { label: string; value: number; tone?: string }) => (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{formatCurrency(value, currency)}</span>
    </div>
  )

  const StatusPill = ({ s }: { s: WeeklySettlement }) => {
    const badge = periodBadge(s)
    const tonos = {
      closed: 'bg-gray-100 text-gray-700',
      reopened: 'bg-amber-100 text-amber-700',
      open: 'bg-emerald-100 text-emerald-700',
    } as const
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tonos[badge.tone]}`}>
        {badge.label}
      </span>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Liquidación Semanal</h1><p className="text-sm text-gray-500 mt-0.5">Lunes a Sábado · por ruta</p></div>
        <div className="flex gap-2">
          {settlement && <Button variant="secondary" onClick={exportCSV} icon={<Download className="w-4 h-4" />}>CSV</Button>}
          <Button onClick={generate} loading={loading} disabled={!routeId} icon={<RefreshCw className="w-4 h-4" />}>Generar</Button>
          {puedeCerrar && (
            <Button
              onClick={cerrarSemana}
              loading={closing}
              disabled={!routeId || Boolean(bloqueoCierre)}
              title={bloqueoCierre ?? 'Archiva la semana y congela sus cifras'}
              icon={<Lock className="w-4 h-4" />}
            >
              Cerrar semana
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        {/* Ruta OBLIGATORIA: sin "Todas las rutas". */}
        <OfficeSelector offices={offices} value={officeId} onChange={changeOffice}
          includeUnassigned={hasUnassigned} className="w-56" />
        <RouteSelector routes={routesInOffice} value={routeId} onChange={setRouteId} className="w-64" />
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Inicio semana</label>
          <input type="date" value={semanaInicio} onChange={e => setSemanaInicio(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Fin semana</label>
          <input type="date" value={semanaFin} onChange={e => setSemanaFin(e.target.value)}
            className="h-9 rounded-lg border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      {routes.length === 0 && (
        <p className="text-sm text-amber-600">No tienes rutas autorizadas: no hay nada que liquidar.</p>
      )}

      {routeId && bloqueoCierre && puedeCerrar && (
        <p className="text-sm text-amber-600">{bloqueoCierre}</p>
      )}

      {loading ? (
        <LoadingState message="Calculando liquidación..." />
      ) : settlement ? (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-600 flex flex-wrap items-center gap-2">
            <span>
              Ruta: {generatedRoute?.nombre ?? settlement.routeId}
              {generatedRoute?.codigo ? ` · ${generatedRoute.codigo}` : ''}
              {' · '}{formatDate(settlement.semanaInicio)} – {formatDate(settlement.semanaFin)}
            </span>
            {settlement.closedAt && <StatusPill s={settlement} />}
          </h2>

          {/* KPI de ESTA ruta */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-primary-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Cobros</p>
              <p className="text-xl font-bold text-primary-700 mt-1">{formatCurrency(settlement.cobros, currency)}</p>
            </div>
            <div className="bg-red-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Gastos</p>
              <p className="text-xl font-bold text-red-600 mt-1">{formatCurrency(settlement.gastos, currency)}</p>
            </div>
            <div className="bg-emerald-50 rounded-xl p-4 text-center">
              <p className="text-xs text-gray-500">Saldo final</p>
              <p className={`text-xl font-bold mt-1 ${settlement.saldoFinal >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                {formatCurrency(settlement.saldoFinal, currency)}
              </p>
            </div>
          </div>

          {/* Detalle completo de la ruta liquidada */}
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden divide-y divide-gray-50">
            <Row label="Saldo anterior" value={settlement.saldoAnterior} />
            <Row label="(+) Ingreso capital" value={settlement.ingresoCapital} tone="text-emerald-600" />
            <Row label="(+) Cobros" value={settlement.cobros} tone="text-emerald-600" />
            {/* ETIQUETA NEUTRA (decisión D-6): NO se renombra a "Base recibida" porque
                este total agrega naturalezas distintas — una transferencia socio→ruta
                sí es base nueva, pero una ruta→ruta es un traslado interno que otra
                ruta perdió. Distinguirlas exige modelado nuevo (Fase 2). Hasta
                entonces, una sola etiqueta consistente en toda la app. */}
            <Row label="(+) Transferencias entrantes" value={settlement.transferenciasEntradas} tone="text-emerald-600" />
            <Row label="(−) Préstamos entregados" value={settlement.prestamosEntregados} tone="text-blue-600" />
            <Row label="(−) Gastos" value={settlement.gastos} tone="text-red-500" />
            <Row label="(−) Transferencias salientes" value={settlement.transferenciasSalidas} tone="text-red-500" />
            <Row label="(−) Retiros" value={settlement.retiros} tone="text-amber-600" />
            <div className="flex items-center justify-between px-4 py-3.5 bg-gray-50">
              <span className="text-sm font-semibold text-gray-800">Saldo final</span>
              <span className={`text-base font-bold ${settlement.saldoFinal >= 0 ? 'text-primary-700' : 'text-red-600'}`}>
                {formatCurrency(settlement.saldoFinal, currency)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <CalendarRange className="w-10 h-10 mb-3" />
          <p className="text-sm">Selecciona la ruta y el rango de la semana, luego haz clic en Generar</p>
        </div>
      )}

      {/* ---------------- HISTORIAL DE CIERRES DE LA RUTA ---------------- */}
      {routeId && historial.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <History className="w-4 h-4 text-gray-400" /> Liquidaciones archivadas
          </h2>
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Semana</th>
                  <th className="text-left font-medium px-4 py-2.5">Oficina al cierre</th>
                  <th className="text-left font-medium px-4 py-2.5">Estado</th>
                  <th className="text-right font-medium px-4 py-2.5">Saldo final</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {historial.map(fila => (
                  <tr key={fila.settlement.id} className={fila.superseded ? 'text-gray-400' : ''}>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {formatDate(fila.settlement.semanaInicio)} – {formatDate(fila.settlement.semanaFin)}
                      <span className="ml-2 text-xs text-gray-400">v{fila.version}</span>
                    </td>
                    {/* Oficina HISTÓRICA del documento, no la actual de la ruta. */}
                    <td className="px-4 py-2.5">{fila.officeLabel}</td>
                    <td className="px-4 py-2.5">
                      <StatusPill s={fila.settlement} />
                      {fila.superseded && <span className="ml-2 text-xs">sustituida</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {formatCurrency(fila.settlement.saldoFinal, currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => exportCierre(fila)}
                        className="text-xs text-primary-600 hover:underline">CSV</button>
                      {puedeReabrir && isProtectingClosure(fila.settlement) && !fila.superseded && (
                        <button onClick={() => { setReabrir(fila.settlement); setMotivo('') }}
                          className="ml-3 text-xs text-amber-600 hover:underline">Reabrir</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {historial.some(f => f.settlement.reopenReason) && (
            <div className="text-xs text-gray-500 space-y-1">
              {historial.filter(f => f.settlement.reopenReason).map(f => (
                <p key={f.settlement.id}>
                  Reapertura {formatDate(f.settlement.semanaInicio)}–{formatDate(f.settlement.semanaFin)} v{f.version}:
                  {' '}«{f.settlement.reopenReason}»
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- REAPERTURA CONTROLADA ---------------- */}
      <Modal
        open={Boolean(reabrir)}
        onClose={() => { setReabrir(null); setMotivo('') }}
        title="Reabrir período"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setReabrir(null); setMotivo('') }}>Cancelar</Button>
            <Button
              onClick={confirmarReapertura}
              loading={reabriendo}
              disabled={motivo.trim().length < MIN_REOPEN_REASON}
              icon={<LockOpen className="w-4 h-4" />}
            >
              Reabrir
            </Button>
          </div>
        }
      >
        {reabrir && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Semana {formatDate(reabrir.semanaInicio)} – {formatDate(reabrir.semanaFin)}.
              Los pagos de esas fechas volverán a ser corregibles directamente.
            </p>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Motivo (obligatorio)</label>
              <textarea
                value={motivo}
                onChange={e => setMotivo(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="Ej.: pago mal registrado el jueves, se corrige y se vuelve a cerrar."
              />
              <p className="mt-1 text-xs text-gray-400">
                Mínimo {MIN_REOPEN_REASON} caracteres. Queda guardado de forma permanente.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
