// ADEX Online: pantalla de TRANSFERENCIAS del Administrador (Rondas 53 y 59). Parte de la
// TransfersPage de CLEAN (src/pages/admin/TransfersPage.tsx) con la misma identidad visual:
//
//   · Arriba, lo que decide una operación: capital disponible y capital en manos de trabajadores.
//   · UN punto de entrada, «Nueva operación», con TODO el catálogo del rol. Una operación que el
//     rol puede hacer no se oculta por falta de saldo, rutas o destinatarios: dice por qué no se
//     puede ahora. Las de trabajadores abren el asistente de CLEAN (`OperationWizard`); el resto,
//     sus formularios. Regla R59: quien tiene el capital lo entrega sin aprobación; quien lo
//     necesita, lo solicita (no mueve dinero).
//   · `?solicitud=<id>` abre el formulario ORDINARIO que atiende esa solicitud, precargado.
//   · Rutas solo de consulta. «Ver movimientos» lleva a Consultas (no hay historial aquí).
//
// El SuperAdmin no tiene esta pantalla (opera su capital en Capital).
//
// R74 · Base por Ruta: con `route_base`/`migrating` (`GET /v1/capital/model`) la pantalla es
// `runtime/routeBase/TransferenciasRB.tsx` (sin bolsas ni devoluciones al SuperAdmin). Con `admin_pool`,
// esta pantalla sin cambios.
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDownLeft, ArrowUpRight, Bell, CornerUpLeft, History, MapPin, Plus, Send, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { getRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { routesForOperation, type TransferMode, type TransferOperationKind } from '@/lib/transferOperations'
import { OperationWizard } from '@/components/transfers/OperationWizard'
import { formatCurrency } from '@/lib/formatters'
import { filterAccessibleRoutes } from '@/lib/permissions'
import { CapitalControllerBadge } from '@/components/ui/CapitalControllerBadge'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import type { Route, User } from '@/models/types'
import { serverView } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'
import { listAdminTransfers } from '../../../runtime/adminTransfers.ts'
import { TransferRegisterModal } from '../../../runtime/AdminTransferUI.tsx'
import { getRequest, type CapitalRequest, type RequestKind } from '../../../runtime/capitalRequests.ts'
import { RequestModal, ReturnToCompanyModal } from '../../../runtime/MoneyForms.tsx'
import { isRouteBaseUi, useCapitalModel } from '../../../runtime/routeBase/api.ts'
import { TransferenciasRB } from '../../../runtime/routeBase/TransferenciasRB.tsx'

interface PoolSummary { admins: { adminId: string; availableMinor: number }[] }

type OpKind = 'entregar-capital' | 'devolver-capital' | 'admin-transfer' | 'return-company' | 'request-sa' | 'request-admin' | 'request-worker'
interface OpDef { kind: OpKind; title: string; help: string; icon: React.ReactNode; blocked?: string | null }

/** Centralizado sin saldo heredado: en ADEX Online las rutas nunca tuvieron caja propia. */
const MODO: TransferMode = { central: true, heredado: {} }
const REQUEST_KIND: Partial<Record<OpKind, RequestKind>> = { 'request-sa': 'admin_allocation', 'request-admin': 'admin_transfer', 'request-worker': 'worker_return' }

export default function TransfersPage() {
  const model = useCapitalModel()
  const { user } = useAuth()
  if (user?.rol === 'superadmin') return <Navigate to="/admin/capital" replace />
  if (model === null) return <div className="flex justify-center py-16" role="status" aria-label="Cargando"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  if (isRouteBaseUi(model)) return <TransferenciasRB model={model} />
  return <PoolTransfersPage />
}

function PoolTransfersPage() {
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  const navigate = useNavigate()
  const money = (n: number) => formatCurrency(n, currency)
  const [params, setParams] = useSearchParams()
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [enManos, setEnManos] = useState<Record<string, number | null>>({})
  const [available, setAvailable] = useState<number | null>(null)
  const [toConfirm, setToConfirm] = useState(0)
  const [loading, setLoading] = useState(true)
  const [chooser, setChooser] = useState(false)
  const [wizard, setWizard] = useState<{ kind?: TransferOperationKind } | null>(null)
  const [adminForm, setAdminForm] = useState<{ request: CapitalRequest | null } | null>(null)
  const [returnForm, setReturnForm] = useState<{ request: CapitalRequest | null } | null>(null)
  const [requestForm, setRequestForm] = useState<RequestKind | null>(null)

  const revision = useDataRevision()
  useEffect(() => { void load() }, [tenantId, user, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const [rts, us] = await Promise.all([
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    const scoped = filterAccessibleRoutes(user, rts)
    setRoutes(scoped)
    setUsers(us)
    // Efectivo en manos de trabajadores: MISMA fuente que Caja por ruta y Liquidación.
    const saldos = await Promise.all(scoped.map(async r => {
      try { return [r.id, (await getRouteCashReconciliation({ actor: user, tenantId, routeId: r.id })).enPersonas] as const } catch { return [r.id, null] as const }
    }))
    setEnManos(Object.fromEntries(saldos))
    const summary = await serverView<PoolSummary>('/v1/capital/summary').catch(() => null)
    const own = summary?.admins.find(a => a.adminId === user?.id)
    // Sin caja todavía = 0 (el servidor respondió); sin respuesta = desconocido.
    setAvailable(summary ? (own ? toMajor(own.availableMinor) : 0) : null)
    setToConfirm((await listAdminTransfers().catch(() => [])).filter(t => t.canConfirm).length)
    setLoading(false)
  }

  // ?solicitud=<id>: abre el formulario ordinario que la atiende (desde Notificaciones).
  const solicitud = params.get('solicitud')
  useEffect(() => {
    if (!solicitud) return
    let alive = true
    getRequest(solicitud).then(r => {
      if (!alive) return
      if (!r.canAttend) { toast.error('Esta solicitud ya no está pendiente.'); return }
      if (r.kind === 'admin_return') setReturnForm({ request: r })
      else if (r.kind === 'admin_transfer') setAdminForm({ request: r })
    }).catch(e => toast.error(e instanceof Error ? e.message : 'No se encontró la solicitud'))
      .finally(() => { if (alive) setParams(p => { const n = new URLSearchParams(p); n.delete('solicitud'); return n }, { replace: true }) })
    return () => { alive = false }
  }, [solicitud])  // eslint-disable-line react-hooks/exhaustive-deps

  if (user?.rol === 'superadmin') return <Navigate to="/admin/capital" replace />

  const otherAdmins = users.filter(u => u.rol === 'admin' && u.status === 'activo' && u.id !== user?.id)
  const sinRutas = 'No eres responsable de capital de ninguna ruta activa.'
  const misRutas = routes.filter(r => r.capitalControllerAdminId === user?.id && r.status === 'activa')
  const groups: { title: string; ops: OpDef[] }[] = [
    { title: 'Mover capital', ops: [
      { kind: 'entregar-capital', title: 'Entregar capital a un trabajador', help: 'De tu caja a un cobrador o supervisor de tu ruta.', icon: <ArrowUpRight className="w-5 h-5" />,
        blocked: routesForOperation('entregar-capital', user, routes, users, tenantId, MODO).length === 0 ? sinRutas : null },
      { kind: 'devolver-capital', title: 'Recibir devolución de un trabajador', help: 'Efectivo que un trabajador de tu ruta te entrega.', icon: <ArrowDownLeft className="w-5 h-5" />,
        blocked: routesForOperation('devolver-capital', user, routes, users, tenantId, MODO).length === 0 ? sinRutas : null },
      { kind: 'admin-transfer', title: 'Transferir a otro Administrador', help: 'Sale de tu caja y llega a la suya en el acto.', icon: <Users className="w-5 h-5" />,
        blocked: otherAdmins.length === 0 ? 'No hay otros Administradores activos.' : null },
      { kind: 'return-company', title: 'Devolver capital al SuperAdmin', help: 'Sale de tu caja y vuelve a la empresa.', icon: <CornerUpLeft className="w-5 h-5" /> },
    ] },
    { title: 'Solicitar (no mueve dinero)', ops: [
      { kind: 'request-sa', title: 'Pedir capital al SuperAdmin', help: 'Lo atiende el SuperAdmin.', icon: <Send className="w-5 h-5" /> },
      { kind: 'request-admin', title: 'Pedir capital a otro Administrador', help: 'Lo atiende quien tiene el capital.', icon: <Send className="w-5 h-5" />,
        blocked: otherAdmins.length === 0 ? 'No hay otros Administradores activos.' : null },
      { kind: 'request-worker', title: 'Pedir entrega de efectivo a un trabajador', help: 'Recaudo o devolución de base.', icon: <Send className="w-5 h-5" />,
        blocked: misRutas.length === 0 ? sinRutas : null },
    ] },
  ]

  function start(op: OpDef) {
    if (op.blocked) return
    setChooser(false)
    if (op.kind === 'entregar-capital' || op.kind === 'devolver-capital') setWizard({ kind: op.kind })
    else if (op.kind === 'admin-transfer') setAdminForm({ request: null })
    else if (op.kind === 'return-company') setReturnForm({ request: null })
    else setRequestForm(REQUEST_KIND[op.kind]!)
  }

  const rutasVisibles = routes.filter(r => officeFilter.visibleRouteIds.has(r.id))
  const totalEnManos = rutasVisibles.reduce((s, r) => s + (enManos[r.id] ?? 0), 0)
  const done = () => { void load() }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button variant="secondary" onClick={() => navigate('/admin/consultas?vista=transferencias')} icon={<History className="w-4 h-4" />} data-testid="open-movements">Ver movimientos</Button>
          <Button onClick={() => setChooser(true)} icon={<Plus className="w-4 h-4" />} data-testid="new-operation">Nueva operación</Button>
        </div>
      </div>

      {/* ---------- RESUMEN ---------- */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="transfers-summary">
        <div className="rounded-2xl bg-primary-50 border border-primary-100 p-4">
          <p className="text-xs text-gray-600">Capital disponible</p>
          <p className="text-lg font-bold text-primary-700" data-testid="summary-pool">{available == null ? '—' : money(available)}</p>
        </div>
        <div className="rounded-2xl bg-white border border-gray-100 shadow-card p-4">
          <p className="text-xs text-gray-600">Base del trabajador</p>
          <p className="text-lg font-bold text-gray-900" data-testid="summary-workers">{money(totalEnManos)}</p>
          <p className="text-[11px] text-gray-500">{rutasVisibles.length} ruta(s)</p>
        </div>
      </section>

      {toConfirm > 0 && (
        <Link to="/admin/notificaciones" className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100" data-testid="pending-confirmations">
          <Bell className="w-4 h-4 flex-shrink-0" aria-hidden />
          {toConfirm === 1 ? 'Una transferencia espera tu confirmación' : `${toConfirm} transferencias esperan tu confirmación`} · Notificaciones
        </Link>
      )}

      {/* ---------- RUTAS (consulta) ---------- */}
      <section className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Rutas</h2>
          <OfficeRouteFilterBar
            offices={officeFilter.offices} officeId={officeFilter.officeId} onOfficeChange={officeFilter.setOfficeId}
            routesInOffice={officeFilter.routesInOffice} routeId={officeFilter.routeId} onRouteChange={officeFilter.setRouteId}
            hasUnassigned={officeFilter.hasUnassigned} contextLabel={officeFilter.contextLabel} showContext={officeFilter.hasOfficeFilter}
          />
        </div>
        {loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : rutasVisibles.length === 0 ? (
          <EmptyState icon={<MapPin className="w-8 h-8" />} title="No hay rutas en tu alcance" />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {rutasVisibles.map(r => (
              <div key={r.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 flex items-start justify-between gap-3" data-testid={`route-card-${r.id}`}>
                <div className="flex items-start gap-2 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-primary-100 flex items-center justify-center flex-shrink-0"><MapPin className="w-4 h-4 text-primary-600" /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{r.nombre}</p>
                    <CapitalControllerBadge className="block mt-0.5" route={r} users={users} currentUserId={user?.id} />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-[11px] text-gray-500">Base del trabajador</p>
                  <p className="text-sm font-bold text-gray-800">{enManos[r.id] == null ? '—' : money(enManos[r.id] ?? 0)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------- NUEVA OPERACIÓN: el catálogo completo del rol ---------- */}
      <Modal open={chooser} onClose={() => setChooser(false)} title="Nueva operación" size="md">
        <div className="space-y-4" data-testid="op-chooser">
          {groups.map(g => (
            <div key={g.title} className="space-y-2" role="group" aria-label={g.title}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{g.title}</p>
              {g.ops.map(op => (
                <button key={op.kind} type="button" onClick={() => start(op)} data-testid={`op-${op.kind}`} aria-disabled={!!op.blocked}
                  className={`w-full flex items-center gap-3 text-left rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${op.blocked ? 'border-gray-100 bg-gray-50 cursor-not-allowed' : 'border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50/40'}`}>
                  <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${op.blocked ? 'bg-gray-100 text-gray-400' : 'bg-primary-100 text-primary-700'}`}>{op.icon}</span>
                  <span className="min-w-0">
                    <span className={`block text-sm font-semibold ${op.blocked ? 'text-gray-500' : 'text-gray-900'}`}>{op.title}</span>
                    <span className={`block text-xs ${op.blocked ? 'text-amber-700' : 'text-gray-500'}`} data-testid={op.blocked ? `blocked-${op.kind}` : undefined}>{op.blocked ?? op.help}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Modal>

      <OperationWizard open={!!wizard} onClose={() => setWizard(null)} onDone={done}
        routes={routes} users={users} inicial={wizard ?? undefined} modo={MODO} />
      <TransferRegisterModal open={!!adminForm} onClose={() => setAdminForm(null)} onDone={() => { setAdminForm(null); done() }}
        currency={currency} asSecretary={false} available={available} request={adminForm?.request ?? null} />
      <ReturnToCompanyModal open={!!returnForm} onClose={() => setReturnForm(null)} onDone={() => { setReturnForm(null); done() }}
        currency={currency} available={available} request={returnForm?.request ?? null} />
      <RequestModal open={!!requestForm} onClose={() => setRequestForm(null)} onDone={() => setRequestForm(null)}
        currency={currency} initialKind={requestForm ?? undefined} />
    </div>
  )
}
