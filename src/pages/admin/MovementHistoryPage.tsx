import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FileText, History, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { filterAccessibleRoutes } from '@/lib/permissions'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters'
import {
  ACCOUNT_KIND_LABEL, HISTORY_CATEGORY_LABEL, HISTORY_STATE_LABEL, accountLabel,
  type AccountKind, type HistoryCategory, type HistoryEntry, type HistoryFilters, type HistoryState,
} from '@/lib/movementHistory'
import { canViewMovementHistory, listMovementHistory } from '@/services/movementHistoryService'
import type { ExpenseCategory, Route, User } from '@/models/types'

const PAGINA = 30
const FILTROS_URL = ['desde', 'hasta', 'categoria', 'routeId', 'adminId', 'workerId', 'cuenta', 'estado', 'referencia'] as const

const TONO_ESTADO: Record<HistoryState, string> = {
  vigente: 'bg-emerald-50 text-emerald-700', anulado: 'bg-red-50 text-red-600',
  correccion: 'bg-amber-50 text-amber-700', historico: 'bg-gray-100 text-gray-600',
}

/**
 * HISTORIAL UNIFICADO (Ronda 5/6). Vista de los registros financieros REALES
 * (`movementHistoryService`, alcance aplicado en el servicio). Los filtros de la
 * URL solo estrechan lo que el servicio ya permite: un id ajeno no aparece.
 */
export default function MovementHistoryPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const revision = useDataRevision()
  const [params, setParams] = useSearchParams()
  const filtros: HistoryFilters = Object.fromEntries(FILTROS_URL.map(k => [k, params.get(k) || undefined]).filter(([, v]) => v)) as HistoryFilters
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibles, setVisibles] = useState(PAGINA)
  const [abierta, setAbierta] = useState<string | null>(null)
  const [todas, setTodas] = useState<HistoryEntry[]>([])
  const [ref, setRef] = useState(filtros.referencia ?? '')

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const [es, todasEs, us, rts, cats] = await Promise.all([
          listMovementHistory({ actor: user, tenantId, filtros }),
          listMovementHistory({ actor: user, tenantId }),
          db.users.where('tenantId').equals(tenantId).toArray(),
          db.routes.where('tenantId').equals(tenantId).toArray(),
          db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
        ])
        if (!alive) return
        setEntries(es); setTodas(todasEs); setUsers(us); setRoutes(filterAccessibleRoutes(user, rts)); setCategories(cats); setError(null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar el historial')
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [tenantId, user, revision, params.toString()])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setVisibles(PAGINA) }, [params.toString()])  // eslint-disable-line react-hooks/exhaustive-deps

  const setFiltro = (k: (typeof FILTROS_URL)[number], v: string) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v); else p.delete(k)
    setParams(p, { replace: true })
  }
  const userName = (id?: string) => (id ? id.startsWith('system:') ? 'Migración del sistema' : users.find(u => u.id === id)?.nombre ?? 'Usuario no identificado' : 'No registrado')
  const routeName = (id?: string) => (id ? routes.find(r => r.id === id)?.nombre ?? 'Ruta fuera de tu alcance' : '—')
  const nombres = { user: userName, route: routeName }
  const money = (n: number) => formatCurrency(n, currency)
  const cat = (id: string) => categories.find(c => c.id === id)?.nombre ?? id
  const extraValor = (k: string, v: string) => (k === 'Categoría' ? cat(v) : v)

  if (!canViewMovementHistory(user, tenantId)) {
    return <div className="p-4 md:p-6"><p className="text-sm text-gray-600">No tienes acceso al historial de movimientos.</p></div>
  }
  const detalle = abierta ? todas.find(e => e.key === abierta) ?? null : null
  const admins = users.filter(u => u.rol === 'admin')
  const trabajadores = users.filter(u => hasPersonalCashbox(u.rol) && routes.some(r => (u.authorizedRouteIds ?? []).includes(r.id)))

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2"><History className="w-5 h-5 text-primary-600" />Historial de movimientos</h1>
          <p className="text-sm text-gray-500 mt-0.5">Registros reales de capital, Base, transferencias, gastos y Caja socios. Una fila por operación.</p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="text-primary-700 hover:underline" to="/admin/transfers">Transferencias</Link>
          <Link className="text-primary-700 hover:underline" to="/admin/capital">{user?.rol === 'admin' ? 'Caja principal' : 'Capital'}</Link>
        </div>
      </div>

      {/* Ronda 48 (H-08): cada selector toma el ancho de su opción más larga (con tope),
          en vez de 11 rem fijos que cortaban «Todos los estados» o «Todos los trabajadores». */}
      <DateRangeFilter desde={filtros.desde ?? ''} hasta={filtros.hasta ?? ''} onDesde={v => setFiltro('desde', v)} onHasta={v => setFiltro('hasta', v)}
        onClear={() => { setParams(new URLSearchParams(), { replace: true }); setRef('') }}>
        <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Tipo" value={filtros.categoria ?? ''} onChange={e => setFiltro('categoria', e.target.value)}
          options={(Object.keys(HISTORY_CATEGORY_LABEL) as HistoryCategory[]).map(c => ({ value: c, label: HISTORY_CATEGORY_LABEL[c] }))} placeholder="Todos los tipos" /></div>
        <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Estado" value={filtros.estado ?? ''} onChange={e => setFiltro('estado', e.target.value)}
          options={(Object.keys(HISTORY_STATE_LABEL) as HistoryState[]).map(c => ({ value: c, label: HISTORY_STATE_LABEL[c] }))} placeholder="Todos los estados" /></div>
        <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Ruta" value={filtros.routeId ?? ''} onChange={e => setFiltro('routeId', e.target.value)}
          options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Todas las rutas" /></div>
        {user?.rol === 'superadmin' && (
          <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Administrador" value={filtros.adminId ?? ''} onChange={e => setFiltro('adminId', e.target.value)}
            options={admins.map(a => ({ value: a.id, label: a.nombre }))} placeholder="Todos los Administradores" /></div>
        )}
        <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Trabajador" value={filtros.workerId ?? ''} onChange={e => setFiltro('workerId', e.target.value)}
          options={trabajadores.map(u => ({ value: u.id, label: u.nombre }))} placeholder="Todos los trabajadores" /></div>
        <div className="w-full sm:w-auto sm:min-w-[10rem] sm:max-w-[17rem]"><Select aria-label="Cuenta" value={filtros.cuenta ?? ''} onChange={e => setFiltro('cuenta', e.target.value)}
          options={(Object.keys(ACCOUNT_KIND_LABEL) as AccountKind[]).map(c => ({ value: c, label: ACCOUNT_KIND_LABEL[c] }))} placeholder="Todas las cuentas" /></div>
        <form className="w-full sm:w-48" onSubmit={e => { e.preventDefault(); setFiltro('referencia', ref.trim()) }}>
          <label className="block text-xs text-gray-500 mb-1">Referencia</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input aria-label="Referencia" value={ref} onChange={e => setRef(e.target.value)} onBlur={() => setFiltro('referencia', ref.trim())} placeholder="Ref."
              className="h-9 w-full rounded-lg border border-gray-300 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
        </form>
      </DateRangeFilter>

      {error ? <p className="text-sm text-red-600">{error}</p> : loading ? (
        <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={<History className="w-8 h-8" />} title="Sin movimientos" description="No hay registros con estos filtros en tu alcance." />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-gray-500" data-testid="history-count">{entries.length} movimiento(s)</p>
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
            {entries.slice(0, visibles).map(e => (
              <button key={e.key} type="button" onClick={() => setAbierta(e.key)} data-testid="history-row" data-key={e.key}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 focus:outline-none focus:bg-gray-50">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-1.5">
                      {e.tipo}
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-gray-100 text-gray-600">{HISTORY_CATEGORY_LABEL[e.categoria]}</span>
                      {e.estado !== 'vigente' && <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${TONO_ESTADO[e.estado]}`}>{HISTORY_STATE_LABEL[e.estado]}</span>}
                    </p>
                    <p className="text-xs text-gray-600 break-words">{accountLabel(e.origen, nombres)} → {accountLabel(e.destino, nombres)}</p>
                    <p className="text-xs text-gray-500 break-words">{formatDateTime(e.createdAt)} · registró {userName(e.registradoPor)} · Ref. {e.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <span className={`text-sm font-bold whitespace-nowrap ${e.estado === 'anulado' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{money(e.importe)}</span>
                </div>
              </button>
            ))}
          </div>
          {entries.length > visibles && (
            <div className="flex justify-center"><Button variant="secondary" onClick={() => setVisibles(v => v + PAGINA)}>Cargar más ({entries.length - visibles})</Button></div>
          )}
        </div>
      )}

      {/* Detalle: solo datos registrados; lo que no existe se dice. */}
      <Modal open={!!detalle} onClose={() => setAbierta(null)} title={detalle ? detalle.tipo : ''} size="lg"
        footer={detalle && <>
          <Button variant="secondary" onClick={() => setAbierta(null)}>Cerrar</Button>
          <Link to={`/comprobante/${detalle.fuente}/${detalle.id}`} target="_blank" rel="noopener" data-testid="open-receipt"
            className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-primary-600 hover:bg-primary-700 text-white shadow-sm">
            <FileText className="w-4 h-4" /> Comprobante
          </Link>
        </>}>
        {detalle && (
          <div className="space-y-3 text-sm" data-testid="history-detail">
            <div className="rounded-xl border border-gray-100 divide-y divide-gray-50">
              {([
                ['Importe', `${money(detalle.importe)} (${currency})`],
                ['Origen', accountLabel(detalle.origen, nombres)],
                ['Destino', accountLabel(detalle.destino, nombres)],
                ['Rutas', detalle.routeIds.length ? detalle.routeIds.map(routeName).join(', ') : '—'],
                ['Trabajador', detalle.workerIds.length ? [...new Set(detalle.workerIds)].map(userName).join(', ') : '—'],
                ['Bolsa / responsable de capital', detalle.adminIds.length ? detalle.adminIds.map(userName).join(', ') : '—'],
                ['Registró', userName(detalle.registradoPor)],
                ['Fecha y hora del registro', formatDateTime(detalle.createdAt)],
                ['Fecha contable', formatDate(detalle.fecha)],
                ['Concepto / motivo', detalle.concepto || 'No registrado'],
                ['Estado', HISTORY_STATE_LABEL[detalle.estado]],
                ['Referencia', detalle.id],
                ...detalle.extra.map(([k, v]) => [k, extraValor(k, v)] as [string, string]),
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 px-3 py-2"><span className="text-gray-500">{k}</span><span className="text-right break-all" data-testid={`detail-${k}`}>{v}</span></div>
              ))}
            </div>
            {detalle.patas.length > 0 && (
              <div><p className="text-xs font-semibold text-gray-500 mb-1">Registros enlazados de esta misma operación</p>
                <ul className="text-xs text-gray-600 list-disc ml-4" data-testid="history-legs">{detalle.patas.map(p => (
                  <li key={p.key}>
                    {p.clase === 'caja-socios' ? `Caja socios de ${userName(p.personaId)}: ${p.movimiento === 'ingreso' ? 'ingreso' : 'salida'} de ${money(p.importe)}`
                      : p.clase === 'entrega-en-mano' ? `Entregado en mano a ${userName(p.personaId)}: ${money(p.importe)}`
                        : `Devolución técnica de ${userName(p.personaId)}: ${money(p.importe)}`}
                    {' · Ref. '}{p.key.split(':')[1].slice(0, 8).toUpperCase()}
                  </li>
                ))}</ul>
              </div>
            )}
            {detalle.corrigeA && <p className="text-xs">Corrige a: <button type="button" className="text-primary-700 hover:underline" data-testid="link-original" onClick={() => setAbierta(detalle.corrigeA!)}>Ref. {detalle.corrigeA.split(':')[1].slice(0, 8).toUpperCase()}</button></p>}
            {detalle.corregidoPor.length > 0 && <p className="text-xs">Corregido por: {detalle.corregidoPor.map(c => <button key={c} type="button" className="text-primary-700 hover:underline mr-2" data-testid="link-correction" onClick={() => setAbierta(c)}>Ref. {c.split(':')[1].slice(0, 8).toUpperCase()}</button>)}</p>}
            <p className="text-[11px] text-gray-500">El registro acredita que la operación quedó anotada en ADEX. No acredita la entrega o recepción física del efectivo.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
