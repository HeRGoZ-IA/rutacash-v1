// ADEX Online: CapitalPage (parte de la original de CLEAN, src/pages/admin/CapitalPage.tsx), misma
// identidad visual. Una pantalla para dos roles:
//
//   · SuperAdmin → «Capital»: capital de la empresa, cajas de los Administradores y responsable de
//     capital de cada ruta. UN botón, «Realizar movimientos», abre el formulario de siempre con las
//     operaciones de la empresa (ingreso, asignación, recogida, retiro) y la solicitud de devolución
//     (no mueve dinero). `?solicitud=<id>` lo abre precargado para atender una solicitud de capital.
//     `?admin=<id>` muestra la Caja principal de ese Administrador (consulta y gasto con su caja).
//   · Administrador → «Caja principal»: resumen de su caja (Ronda 59). Las operaciones están en
//     Transferencias y el detalle en Consultas.
//
// R74 · Base por Ruta: la pantalla depende del MODELO DE CAPITAL de la empresa (`GET /v1/capital/model`).
// `admin_pool` (toda empresa real hoy) = esta pantalla, sin cambios. `route_base`/`migrating` = el panel
// consolidado por ruta (`runtime/routeBase/CajaPrincipalRB.tsx`). El SuperAdmin llega a la activación
// (estructural, no mueve dinero) desde «Modelo de capital».
//
// Todas las cifras son las del servidor (`/v1/capital/summary` y custodias); las que el servidor no
// calcula no se muestran. Sin «Conciliación de la bolsa» parcial ni historiales largos (Ronda 59).
import { useState, useEffect } from 'react'
import { History, MapPin, Plus, Repeat, Settings2, ShieldAlert, UserCog, Wallet } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'
import { can, filterAccessibleRoutes, routeCapitalController } from '@/lib/permissions'
import { validRouteAdmins } from '@/lib/capitalAllocation'
import type { ExpenseCategory, Route, RouteCapitalControllerEvent, User } from '@/models/types'
import { AdminExpenseModal } from '@/components/expenses/AdminExpenseModal'
import { generateId } from '@/lib/utils'
import {
  allocateCapitalToAdmin, getCapitalOverview, listRouteControllerHistory, registerCompanyCapital,
  returnCapitalFromAdmin, setRouteCapitalController, withdrawCompanyCapital,
} from '@/services/capitalControlService'
import { custodyPositions, serverView, type CustodyPosition } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'
import { PoolSummary, type AdminPoolFigures } from '../../../runtime/PoolSummary.tsx'
import { getRequest, type CapitalRequest } from '../../../runtime/capitalRequests.ts'
import { RequestBanner, RequestModal } from '../../../runtime/MoneyForms.tsx'
import { isRouteBaseUi, useCapitalModel } from '../../../runtime/routeBase/api.ts'
import { CajaPrincipalRB } from '../../../runtime/routeBase/CajaPrincipalRB.tsx'
import { GeneralExpensesPanel } from '../../../runtime/routeBase/GeneralExpensesRB.tsx'

type SaOperation = 'COMPANY_DEPOSIT' | 'ADMIN_ALLOCATION' | 'ADMIN_RETURN' | 'COMPANY_WITHDRAWAL'

const SA_OPERATION_LABEL: Record<SaOperation, string> = {
  COMPANY_DEPOSIT: 'Ingreso de capital a la empresa',
  ADMIN_ALLOCATION: 'Asignar capital a un Administrador',
  ADMIN_RETURN: 'Recoger capital de un Administrador',
  COMPANY_WITHDRAWAL: 'Retiro de capital de la empresa',
}
/** Opción del mismo selector que no es un movimiento: abre la solicitud de devolución. */
const REQUEST_OPTION = 'REQUEST_RETURN'

const EVENT_LABEL: Record<RouteCapitalControllerEvent['kind'], string> = {
  MIGRATION: 'Responsable inicial (migración)',
  FIRST_ADMIN: 'Primer Administrador asignado',
  CHANGE: 'Cambio de responsable',
  RELEASE: 'Ruta sin responsable',
}

interface Summary {
  company?: { availableMinor: number; externalNetInMinor: number; adminPoolsMinor: number; custodyMinor: number; portfolioMinor: number }
  admins: AdminPoolFigures[]
}

function Stat({ label, value, tone = 'text-gray-900', bg = 'bg-gray-50', testId }: { label: string; value: string; tone?: string; bg?: string; testId?: string }) {
  return (
    <div className={`${bg} rounded-xl p-3`} data-testid={testId}>
      <p className={`text-xs ${tone} opacity-80`}>{label}</p>
      <p className={`text-base font-bold ${tone}`}>{value}</p>
    </div>
  )
}

/** Elige la pantalla por el modelo de capital de la empresa (sin parpadeo: espera la primera respuesta). */
export default function CapitalPage() {
  const model = useCapitalModel()
  if (model === null) return <div className="flex justify-center py-16" role="status" aria-label="Cargando"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  if (isRouteBaseUi(model)) return <CajaPrincipalRB model={model} />
  return <PoolCapitalPage />
}

function PoolCapitalPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const officeFilter = useOfficeRouteFilter()
  const money = (n: number) => formatCurrency(n, currency)
  const esSuperAdmin = can(user, 'capital.allocateAdmins', { tenantId })

  const [summary, setSummary] = useState<Summary | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [events, setEvents] = useState<RouteCapitalControllerEvent[]>([])
  const [custody, setCustody] = useState<CustodyPosition[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [saOp, setSaOp] = useState<{ tipo: SaOperation; adminId: string; amount: number; descripcion: string; request?: CapitalRequest } | null>(null)
  const [asking, setAsking] = useState(false)
  const [changing, setChanging] = useState<{ routeId: string; adminId: string; motivo: string } | null>(null)
  const [historyRouteId, setHistoryRouteId] = useState<string | null>(null)
  const [gastoAbierto, setGastoAbierto] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const verAdminId = esSuperAdmin ? searchParams.get('admin') ?? '' : ''
  const titularId = esSuperAdmin ? verAdminId : user?.id ?? ''

  const revision = useDataRevision()
  useEffect(() => { void load() }, [tenantId, user, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!user) return
    setLoading(true)
    try {
      const [s, rts, us, cats] = await Promise.all([
        serverView<Summary>('/v1/capital/summary'),
        db.routes.where('tenantId').equals(tenantId).toArray(),
        db.users.where('tenantId').equals(tenantId).toArray(),
        db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      ])
      setSummary(s)
      setRoutes(filterAccessibleRoutes(user, rts))
      setUsers(us)
      setCategories(cats)
      if (esSuperAdmin) {
        const [ov, evs, pos] = await Promise.all([
          getCapitalOverview({ actor: user, tenantId }),
          listRouteControllerHistory({ actor: user, tenantId }),
          custodyPositions().catch(() => [] as CustodyPosition[]),
        ])
        setIssues(ov.issues)
        setEvents(evs)
        setCustody(pos)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el capital')
    } finally {
      setLoading(false)
    }
  }

  // ?solicitud=<id>: atender una solicitud de capital con el MISMO formulario (asignación).
  const solicitud = esSuperAdmin ? searchParams.get('solicitud') : null
  useEffect(() => {
    if (!solicitud) return
    let alive = true
    getRequest(solicitud).then(r => {
      if (!alive) return
      if (!r.canAttend || r.kind !== 'admin_allocation') { toast.error('Esta solicitud ya no está pendiente.'); return }
      setSaOp({ tipo: 'ADMIN_ALLOCATION', adminId: r.requester.membershipId, amount: r.amount,
        descripcion: (r.note ? `Atiendo la solicitud: ${r.note}` : 'Atiendo la solicitud').slice(0, 300), request: r })
    }).catch(e => toast.error(e instanceof Error ? e.message : 'No se encontró la solicitud'))
      .finally(() => { if (alive) setSearchParams(p => { const n = new URLSearchParams(p); n.delete('solicitud'); return n }, { replace: true }) })
    return () => { alive = false }
  }, [solicitud])  // eslint-disable-line react-hooks/exhaustive-deps

  // IDEMPOTENCIA: cada formulario abierto es UNA operación (su id viaja en cada intento).
  const [saOpId, setSaOpId] = useState('')
  const saAbierta = !!saOp
  useEffect(() => { if (saAbierta) setSaOpId(generateId()) }, [saAbierta])

  async function guardarSaOp() {
    if (!saOp || !user) return
    if ((saOp.tipo === 'ADMIN_ALLOCATION' || saOp.tipo === 'ADMIN_RETURN') && !saOp.adminId) { toast.error('Selecciona el Administrador'); return }
    if (saOp.amount <= 0) { toast.error('El valor debe ser mayor a 0'); return }
    setSaving(true)
    try {
      const base = { actor: user, tenantId, amount: saOp.amount, descripcion: saOp.descripcion, operationId: saOpId || undefined }
      if (saOp.tipo === 'COMPANY_DEPOSIT') await registerCompanyCapital(base)
      if (saOp.tipo === 'COMPANY_WITHDRAWAL') await withdrawCompanyCapital(base)
      if (saOp.tipo === 'ADMIN_ALLOCATION') await (allocateCapitalToAdmin as (p: unknown) => Promise<unknown>)({ ...base, adminId: saOp.adminId, requestId: saOp.request?.id })
      if (saOp.tipo === 'ADMIN_RETURN') await returnCapitalFromAdmin({ ...base, adminId: saOp.adminId })
      toast.success(saOp.request ? 'Solicitud atendida' : 'Movimiento de capital registrado')
      setSaOp(null)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  async function guardarResponsable() {
    if (!changing || !user) return
    setSaving(true)
    try {
      await setRouteCapitalController({ actor: user, tenantId, routeId: changing.routeId, adminId: changing.adminId, motivo: changing.motivo })
      toast.success('Responsable de capital actualizado')
      setChanging(null)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  const nombre = (id?: string) => (id ? formatPersonName(users.find(u => u.id === id)?.nombre ?? id) : '—')
  const routeName = (id?: string) => (id ? routes.find(r => r.id === id)?.nombre ?? id : '—')
  const admins = users.filter(u => u.rol === 'admin')
  const pools = summary?.admins ?? []
  const poolOf = (id: string) => pools.find(a => a.adminId === id)
  const adminRows = [...admins.filter(a => a.status === 'activo' || poolOf(a.id)).map(a => ({ user: a, pool: poolOf(a.id) }))]
    .sort((a, b) => a.user.nombre.localeCompare(b.user.nombre))
  const rutasVisibles = routes.filter(r => officeFilter.visibleRouteIds.has(r.id))
  const enRuta = (routeId: string) => toMajor(custody.filter(p => p.routeId === routeId).reduce((s, p) => s + p.balanceMinor, 0))
  const changingRoute = changing ? routes.find(r => r.id === changing.routeId) : undefined
  const candidatos = changingRoute ? validRouteAdmins(users, changingRoute).filter(a => a.id !== changingRoute.capitalControllerAdminId) : []
  const titularPool = titularId ? poolOf(titularId) : undefined
  const companyAvailable = summary?.company ? toMajor(summary.company.availableMinor) : null

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-gray-900">{titularId ? 'Caja principal' : 'Capital'}</h1>
        {verAdminId && (
          <p className="text-sm text-gray-500 mt-0.5">
            Caja de <b>{nombre(verAdminId)}</b> · <button type="button" className="text-primary-700 hover:underline" onClick={() => setSearchParams({}, { replace: true })}>Volver a Capital</button>
          </p>
        )}
      </div>
      {esSuperAdmin && !verAdminId && (
        <div className="flex flex-wrap gap-2">
          <Link to="/admin/capital/modelo" className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50" data-testid="sa-capital-model">
            <Settings2 className="w-4 h-4" aria-hidden />Modelo de capital
          </Link>
          <Link to="/admin/consultas?categoria=capital" className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
            <History className="w-4 h-4" aria-hidden />Ver movimientos
          </Link>
          {/* R74 (0036): diferencias y conciliaciones (solo lectura para el SuperAdmin). */}
          <Link to="/admin/diferencias" className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50" data-testid="pool-go-differences">
            Diferencias
          </Link>
          <Button onClick={() => setSaOp({ tipo: 'COMPANY_DEPOSIT', adminId: '', amount: 0, descripcion: '' })} icon={<Plus className="w-4 h-4" />} data-testid="sa-movements">
            Realizar movimientos
          </Button>
        </div>
      )}
    </div>
  )

  if (loading && !summary) {
    return <div className="p-4 md:p-6 space-y-6">{header}<div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div></div>
  }
  if (error) {
    return <div className="p-4 md:p-6 space-y-6">{header}<p className="text-sm text-red-600">{error}</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      {header}

      {issues.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="capital-issues">
          <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div><p className="font-medium">El capital no cuadra</p><ul className="text-xs list-disc ml-4">{issues.map(i => <li key={i}>{i}</li>)}</ul></div>
        </div>
      )}

      {titularId ? (
        <>
          {titularPool
            ? <PoolSummary pool={titularPool} currency={currency} titular={verAdminId ? nombre(verAdminId) : undefined} onRegistrarGasto={() => setGastoAbierto(true)} />
            : <p className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 text-sm text-gray-500" data-testid="pool-empty">{verAdminId ? 'Este Administrador aún no ha recibido capital.' : 'Aún no has recibido capital del SuperAdmin.'}</p>}
          {/* R74 (0035, C2 y RB-D9): gastos pagados con dinero propio y reembolsos desde la bolsa propia. */}
          {!verAdminId && (
            <Link to="/admin/diferencias" className="block rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm hover:bg-gray-50" data-testid="pool-go-differences">
              <b className="text-gray-900">Diferencias y conciliación</b>
              <span className="block text-xs text-gray-600">Faltantes y sobrantes de cuadres de tus rutas: los concilias tú, sin autorización superior.</span>
            </Link>
          )}
          {!verAdminId && <GeneralExpensesPanel model="admin_pool" />}
        </>
      ) : summary?.company ? (
        <>
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Capital de la empresa</h2>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
              <Stat label="Aportado (neto)" value={money(toMajor(summary.company.externalNetInMinor))} testId="company-total" />
              <Stat label="Disponible sin asignar" value={money(toMajor(summary.company.availableMinor))} tone="text-emerald-700" bg="bg-emerald-50" testId="company-available" />
              <Stat label="En cajas de Administradores" value={money(toMajor(summary.company.adminPoolsMinor))} tone="text-primary-700" bg="bg-primary-50" testId="company-assigned" />
              <Stat label="A cargo de trabajadores" value={money(toMajor(summary.company.custodyMinor))} tone="text-indigo-700" bg="bg-indigo-50" />
              <Stat label="Prestado (cartera)" value={money(toMajor(summary.company.portfolioMinor))} />
            </div>
          </section>

          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="admins-capital">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Administradores</h2>
              <span className="text-xs text-gray-500">{adminRows.length} administrador(es)</span>
            </div>
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3 font-medium">Administrador</th>
                    <th className="py-2 pr-3 font-medium text-right">Recibido (neto)</th>
                    <th className="py-2 pr-3 font-medium text-right">A cargo de trabajadores</th>
                    <th className="py-2 pr-3 font-medium text-right">Disponible</th>
                    <th className="py-2 pr-3 font-medium text-center">Rutas</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {adminRows.map(({ user: a, pool }) => (
                    <tr key={a.id} data-testid={`admin-row-${a.id}`}>
                      <td className="py-2.5 pr-3">
                        <p className="font-medium text-gray-900">{formatPersonName(a.nombre)}</p>
                        {a.status !== 'activo' && <Badge variant="gray" size="sm">Inactivo</Badge>}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-semibold text-gray-900">{money(toMajor(pool?.allocatedNetMinor ?? 0))}</td>
                      <td className="py-2.5 pr-3 text-right text-indigo-700">{money(toMajor(pool?.custodyUnderResponsibilityMinor ?? 0))}</td>
                      <td className="py-2.5 pr-3 text-right text-emerald-700 font-semibold">{money(toMajor(pool?.availableMinor ?? 0))}</td>
                      <td className="py-2.5 pr-3 text-center">{routes.filter(r => r.capitalControllerAdminId === a.id).length}</td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setSearchParams({ admin: a.id })} icon={<Wallet className="w-3.5 h-3.5" />}>Caja</Button>
                      </td>
                    </tr>
                  ))}
                  {adminRows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-gray-400">No hay Administradores activos.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="routes-controller">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Rutas y responsable de capital</h2>
              <OfficeRouteFilterBar offices={officeFilter.offices} officeId={officeFilter.officeId} onOfficeChange={officeFilter.setOfficeId}
                routesInOffice={officeFilter.routesInOffice} routeId={officeFilter.routeId} onRouteChange={officeFilter.setRouteId}
                hasUnassigned={officeFilter.hasUnassigned} contextLabel={officeFilter.contextLabel} showContext={officeFilter.hasOfficeFilter} />
            </div>
            <div className="divide-y divide-gray-50">
              {rutasVisibles.map(r => {
                const resp = routeCapitalController(r, users)
                const otros = validRouteAdmins(users, r).filter(a => a.id !== resp?.id)
                return (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid={`route-row-${r.id}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 bg-primary-100 rounded-lg flex items-center justify-center flex-shrink-0"><MapPin className="w-4 h-4 text-primary-600" /></div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{r.nombre}</p>
                        {resp
                          ? <p className="text-xs text-gray-500">Responsable: <span className="font-medium text-gray-700">{formatPersonName(resp.nombre)}</span>{otros.length > 0 ? ` · también asignados: ${otros.map(o => formatPersonName(o.nombre)).join(', ')}` : ''}</p>
                          : <p className="text-xs font-medium text-amber-700">Sin responsable de capital{otros.length ? '' : ' · sin Administradores asignados'}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-xs text-gray-500">A cargo de trabajadores</p>
                        <p className="text-sm font-semibold text-gray-800">{money(enRuta(r.id))}</p>
                      </div>
                      <Button size="sm" variant="secondary" disabled={validRouteAdmins(users, r).filter(a => a.id !== r.capitalControllerAdminId).length === 0}
                        onClick={() => setChanging({ routeId: r.id, adminId: '', motivo: '' })} icon={<Repeat className="w-3.5 h-3.5" />}>
                        {resp ? 'Cambiar' : 'Asignar'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setHistoryRouteId(r.id)} icon={<UserCog className="w-3.5 h-3.5" />}>Responsables</Button>
                    </div>
                  </div>
                )
              })}
              {rutasVisibles.length === 0 && <p className="py-6 text-center text-sm text-gray-400">No hay rutas.</p>}
            </div>
          </section>

          {/* R74 (0035): obligaciones con los Administradores y reembolsos, solo lectura para el SuperAdmin. */}
          <GeneralExpensesPanel model="admin_pool" />
        </>
      ) : null}

      {/* SuperAdmin: «Realizar movimientos» (mismo formulario y mismos servicios para las cuatro operaciones) */}
      <Modal open={!!saOp} onClose={() => { if (!saving) setSaOp(null) }} guarded={!!saOp && saOp.amount > 0 && !saOp.request} title={saOp?.request ? 'Atender solicitud de capital' : 'Realizar movimiento'}
        footer={<><Button variant="secondary" onClick={() => setSaOp(null)} disabled={saving}>Cancelar</Button><Button onClick={guardarSaOp} loading={saving}>Registrar</Button></>}>
        {saOp && (
          <div className="space-y-4" data-testid="sa-movement-form">
            {saOp.request && <RequestBanner r={saOp.request} currency={currency} />}
            {!saOp.request && (
              <Select label="Operación" value={saOp.tipo}
                onChange={e => {
                  if (e.target.value === REQUEST_OPTION) { setSaOp(null); setAsking(true); return }
                  setSaOp(o => o && { ...o, tipo: e.target.value as SaOperation })
                }}
                options={[...(Object.keys(SA_OPERATION_LABEL) as SaOperation[]).map(k => ({ value: k, label: SA_OPERATION_LABEL[k] })),
                  { value: REQUEST_OPTION, label: 'Pedir devolución a un Administrador (no mueve capital)' }]} />
            )}
            {(saOp.tipo === 'ADMIN_ALLOCATION' || saOp.tipo === 'ADMIN_RETURN') && (
              <Select label="Administrador" value={saOp.adminId} onChange={e => setSaOp(o => o && { ...o, adminId: e.target.value })} required placeholder="Seleccionar Administrador"
                disabled={!!saOp.request} options={admins.filter(a => saOp.tipo === 'ADMIN_RETURN' || a.status === 'activo').map(a => ({ value: a.id, label: formatPersonName(a.nombre) }))} />
            )}
            <MoneyInput label="Valor" currency={currency} value={saOp.amount} onValueChange={v => setSaOp(o => o && { ...o, amount: v })} required
              hint={saOp.tipo === 'ADMIN_RETURN'
                ? (saOp.adminId ? `Disponible del Administrador: ${money(toMajor(poolOf(saOp.adminId)?.availableMinor ?? 0))}` : undefined)
                : saOp.tipo === 'COMPANY_DEPOSIT' ? undefined : companyAvailable != null ? `Disponible sin asignar: ${money(companyAvailable)}` : undefined} />
            <Textarea label="Concepto" value={saOp.descripcion} onChange={e => setSaOp(o => o && { ...o, descripcion: e.target.value })} rows={2} required />
          </div>
        )}
      </Modal>

      <RequestModal open={asking} onClose={() => setAsking(false)} onDone={() => setAsking(false)} currency={currency} initialKind="admin_return" />

      {/* SuperAdmin: cambiar responsable */}
      <Modal open={!!changing} onClose={() => setChanging(null)} title={changingRoute ? `Responsable de capital · ${changingRoute.nombre}` : ''}
        footer={<><Button variant="secondary" onClick={() => setChanging(null)}>Cancelar</Button><Button onClick={guardarResponsable} loading={saving} disabled={!changing?.adminId}>Cambiar responsable</Button></>}>
        {changing && changingRoute && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Responsable actual: <span className="font-semibold">{formatPersonName(routeCapitalController(changingRoute, users)?.nombre) || 'ninguno'}</span>.
              El efectivo a cargo de los trabajadores de la ruta pasa a responsabilidad del nuevo Administrador desde este momento.
            </p>
            <Select label="Nuevo responsable" value={changing.adminId} onChange={e => setChanging(c => c && { ...c, adminId: e.target.value })} required placeholder="Seleccionar Administrador asignado"
              options={candidatos.map(a => ({ value: a.id, label: formatPersonName(a.nombre) }))}
              hint="Solo Administradores activos asignados a esta ruta." />
            <Textarea label="Motivo" value={changing.motivo} onChange={e => setChanging(c => c && { ...c, motivo: e.target.value })} rows={2} required />
          </div>
        )}
      </Modal>

      {/* Historial de responsables de una ruta */}
      <Modal open={!!historyRouteId} onClose={() => setHistoryRouteId(null)} title={historyRouteId ? `Responsables · ${routeName(historyRouteId)}` : ''}
        footer={<Button variant="secondary" onClick={() => setHistoryRouteId(null)}>Cerrar</Button>}>
        <div className="divide-y divide-gray-50" data-testid="controller-history">
          {events.filter(e => e.routeId === historyRouteId).map(e => (
            <div key={e.id} className="py-2">
              <p className="text-sm text-gray-900 flex items-center gap-1.5"><UserCog className="w-4 h-4 text-gray-400" />{EVENT_LABEL[e.kind]}: {e.fromAdminId ? nombre(e.fromAdminId) : 'ninguno'} → {e.toAdminId ? nombre(e.toAdminId) : 'ninguno'}</p>
              <p className="text-xs text-gray-500">
                {formatDateTime(e.createdAt)} · registró {e.actorUserId.startsWith('system:') ? 'migración' : nombre(e.actorUserId)}{e.motivo ? ` · ${e.motivo}` : ''}
              </p>
            </div>
          ))}
          {events.filter(e => e.routeId === historyRouteId).length === 0 && <p className="py-4 text-sm text-gray-400">Sin cambios registrados.</p>}
        </div>
      </Modal>

      <AdminExpenseModal open={gastoAbierto} onClose={() => setGastoAbierto(false)} onSaved={() => { void load() }}
        users={users} categories={categories} bolsaInicial={titularId ? `admin:${titularId}` : undefined} />
    </div>
  )
}
