import { useState, useEffect } from 'react'
import {
  Plus, DollarSign, ChevronRight, MapPin, UserCog, History, ArrowDownLeft, ArrowUpRight, ShieldAlert, Repeat,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import { can, filterAccessibleRoutes, filterByAccessibleRoute, isRouteCapitalController, routeCapitalController } from '@/lib/permissions'
import { validRouteAdmins } from '@/lib/capitalAllocation'
import type { CapitalLedgerEntry, CapitalMovement, Route, RouteCapitalControllerEvent, RouteFinancialSummary, User } from '@/models/types'
import { registerCapital, registerWithdrawal, getRouteAvailableFunds } from '@/services/routeFundsService'
import {
  allocateCapitalToAdmin, getCapitalOverview, listCapitalLedger, listRouteControllerHistory, registerCompanyCapital,
  returnCapitalFromAdmin, setRouteCapitalController, withdrawCompanyCapital, type CapitalOverview,
} from '@/services/capitalControlService'
import { canReverseRouteFund, reverseCapitalMovement } from '@/services/movementReversalService'
import { pairReversals, reversalStateOf } from '@/lib/movementReversal'
import { AnnulledBadge, ReversalDetail, ReverseButton, ReverseMovementModal, signedMoney } from '@/components/ui/MovementReversal'

// ============================================================
// CAPITAL (v16) — SuperAdmin → Administrador → Ruta
// ------------------------------------------------------------
// · SuperAdmin: la pantalla empieza por los ADMINISTRADORES (asignado / en rutas /
//   disponible / rutas controladas). Registra el capital de la empresa, lo asigna o
//   lo recoge de cada Administrador y decide el responsable de capital de cada ruta.
//   No coloca capital directamente en rutas (no existe ese atajo).
// · Administrador: ve SU bolsa y las rutas cuyo capital controla; solo en esas
//   puede colocar o retirar capital. Las rutas donde está asignado pero no es
//   responsable se muestran en consulta, con el nombre del responsable.
// Toda cifra sale de `capitalControlService` / `lib/capitalAllocation` (fuente única);
// la pantalla no calcula saldos ni valida: el servicio revalida todo.
// ============================================================

type SaOperation = 'COMPANY_DEPOSIT' | 'ADMIN_ALLOCATION' | 'ADMIN_RETURN' | 'COMPANY_WITHDRAWAL'

const SA_OPERATION_LABEL: Record<SaOperation, string> = {
  COMPANY_DEPOSIT: 'Ingreso de capital a la empresa',
  ADMIN_ALLOCATION: 'Asignar capital a un Administrador',
  ADMIN_RETURN: 'Recoger capital de un Administrador',
  COMPANY_WITHDRAWAL: 'Retiro de capital de la empresa',
}

const LEDGER_LABEL: Record<CapitalLedgerEntry['tipo'], string> = {
  COMPANY_DEPOSIT: 'Ingreso a la empresa',
  COMPANY_WITHDRAWAL: 'Retiro de la empresa',
  ADMIN_ALLOCATION: 'Asignación a Administrador',
  ADMIN_RETURN: 'Devolución de Administrador',
  ROUTE_CONTROL_TRANSFER: 'Traspaso de responsabilidad de ruta',
}

const EVENT_LABEL: Record<RouteCapitalControllerEvent['kind'], string> = {
  MIGRATION: 'Responsable inicial (migración)',
  FIRST_ADMIN: 'Primer Administrador asignado',
  CHANGE: 'Cambio de responsable',
  RELEASE: 'Ruta sin responsable',
}

/** Tono de alerta (ámbar sobre ámbar) para cifras que exigen atención. */
const ALERTA = { tone: 'text-amber-800', bg: 'bg-amber-50' }

function Stat({ label, value, tone = 'text-gray-900', bg = 'bg-gray-50', testId }: { label: string; value: string; tone?: string; bg?: string; testId?: string }) {
  return (
    <div className={`${bg} rounded-xl p-3`} data-testid={testId}>
      <p className={`text-xs ${tone} opacity-75`}>{label}</p>
      <p className={`text-base font-bold ${tone}`}>{value}</p>
    </div>
  )
}

export default function CapitalPage() {
  const { tenantId, currency } = useTenant()
  const { user } = useAuth()
  const officeFilter = useOfficeRouteFilter()
  const money = (n: number) => formatCurrency(n, currency)
  const esSuperAdmin = can(user, 'capital.allocateAdmins', { tenantId })

  const [overview, setOverview] = useState<CapitalOverview | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [movements, setMovements] = useState<CapitalMovement[]>([])
  const [ledger, setLedger] = useState<CapitalLedgerEntry[]>([])
  const [events, setEvents] = useState<RouteCapitalControllerEvent[]>([])
  const [summaryByRoute, setSummaryByRoute] = useState<Record<string, RouteFinancialSummary>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // SuperAdmin: operación sobre la bolsa de la empresa / de un Administrador.
  const [saOp, setSaOp] = useState<{ tipo: SaOperation; adminId: string; amount: number; descripcion: string; fecha: string } | null>(null)
  // SuperAdmin: cambio de responsable.
  const [changing, setChanging] = useState<{ routeId: string; adminId: string; motivo: string } | null>(null)
  // Admin: colocar / retirar capital de una ruta propia.
  const [routeOp, setRouteOp] = useState<{ tipo: 'colocar' | 'retirar'; routeId: string; valor: number; descripcion: string; fecha: string; disponibleRuta?: number } | null>(null)
  const [detailAdminId, setDetailAdminId] = useState<string | null>(null)
  const [historyRouteId, setHistoryRouteId] = useState<string | null>(null)
  const [detailRouteId, setDetailRouteId] = useState<string | null>(null)
  const [reversing, setReversing] = useState<CapitalMovement | null>(null)

  // Reactiva: otra pestaña del mismo navegador registra y esta vista se entera sin F5.
  const revision = useDataRevision()
  useEffect(() => { load() }, [tenantId, user, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!user) return
    setLoading(true)
    try {
      const [ov, rts, us, movs, led, evs] = await Promise.all([
        getCapitalOverview({ actor: user, tenantId }),
        db.routes.where('tenantId').equals(tenantId).toArray(),
        db.users.where('tenantId').equals(tenantId).toArray(),
        db.capitalMovements.where('tenantId').equals(tenantId).toArray(),
        listCapitalLedger({ actor: user, tenantId }),
        listRouteControllerHistory({ actor: user, tenantId }),
      ])
      const scoped = filterAccessibleRoutes(user, rts)
      setOverview(ov)
      setRoutes(scoped)
      setUsers(us)
      setMovements(filterByAccessibleRoute(user, movs).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.createdAt.localeCompare(a.createdAt)))
      setLedger(led)
      setEvents(evs)
      const sum: Record<string, RouteFinancialSummary> = {}
      for (const r of scoped) sum[r.id] = await getRouteFinancialSummary(r.id)
      setSummaryByRoute(sum)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el capital')
    } finally {
      setLoading(false)
    }
  }

  const nombre = (id?: string) => (id ? users.find(u => u.id === id)?.nombre ?? id : '—')
  const routeName = (id?: string) => (id ? routes.find(r => r.id === id)?.nombre ?? id : '—')
  const admins = users.filter(u => u.rol === 'admin')
  const adminRows = (overview?.admins ?? [])
    .map(a => ({ ...a, user: users.find(u => u.id === a.adminId) }))
    .filter(a => a.user)
    .sort((a, b) => (a.user!.nombre).localeCompare(b.user!.nombre))
  // Administradores sin bolsa todavía (se muestran en cero para poder asignarles).
  const sinBolsa = esSuperAdmin
    ? admins.filter(a => a.status === 'activo' && !adminRows.some(r => r.adminId === a.id))
    : []

  // ---------- SuperAdmin ----------
  async function guardarSaOp() {
    if (!saOp || !user) return
    setSaving(true)
    try {
      const base = { actor: user, tenantId, amount: saOp.amount, descripcion: saOp.descripcion, fecha: saOp.fecha }
      if (saOp.tipo === 'COMPANY_DEPOSIT') await registerCompanyCapital(base)
      if (saOp.tipo === 'COMPANY_WITHDRAWAL') await withdrawCompanyCapital(base)
      if (saOp.tipo === 'ADMIN_ALLOCATION') await allocateCapitalToAdmin({ ...base, adminId: saOp.adminId })
      if (saOp.tipo === 'ADMIN_RETURN') await returnCapitalFromAdmin({ ...base, adminId: saOp.adminId })
      toast.success('Movimiento de capital registrado')
      setSaOp(null)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  async function guardarResponsable() {
    if (!changing || !user) return
    setSaving(true)
    try {
      await setRouteCapitalController({ actor: user, tenantId, routeId: changing.routeId, adminId: changing.adminId, motivo: changing.motivo })
      toast.success('Responsable de capital actualizado')
      setChanging(null)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  // ---------- Administrador ----------
  async function abrirRouteOp(tipo: 'colocar' | 'retirar', routeId: string) {
    const disponibleRuta = tipo === 'retirar' ? await getRouteAvailableFunds(tenantId, routeId) : undefined
    setRouteOp({ tipo, routeId, valor: 0, descripcion: '', fecha: today(), disponibleRuta })
  }

  async function guardarRouteOp() {
    if (!routeOp || !user) return
    setSaving(true)
    try {
      const p = { actor: user, tenantId, routeId: routeOp.routeId, valor: routeOp.valor, descripcion: routeOp.descripcion, fecha: routeOp.fecha }
      if (routeOp.tipo === 'colocar') await registerCapital(p)
      else await registerWithdrawal(p)
      toast.success(routeOp.tipo === 'colocar' ? 'Capital colocado en la ruta' : 'Retiro registrado: el dinero vuelve a tu bolsa')
      setRouteOp(null)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  async function handleReverse(reason: string) {
    if (!reversing) return
    // Permiso, responsable, estado vigente y fondos: en el servicio, atómico.
    await reverseCapitalMovement({ actor: user, tenantId, movementId: reversing.id, reason })
    toast.success('Movimiento anulado')
    setReversing(null)
    await load()
  }

  const miBolsa = overview?.admins.find(a => a.adminId === user?.id)
  // FILTRO OFICINA → RUTA (patrón compartido): solo estrecha las rutas listadas;
  // las bolsas de los Administradores son de la empresa y no se filtran.
  const rutasVisibles = routes.filter(r => officeFilter.visibleRouteIds.has(r.id))
  const misRutas = rutasVisibles.filter(r => isRouteCapitalController(user, r))
  const otrasRutas = rutasVisibles.filter(r => !isRouteCapitalController(user, r))
  const detailAdmin = detailAdminId ? adminRows.find(a => a.adminId === detailAdminId) : undefined
  const changingRoute = changing ? routes.find(r => r.id === changing.routeId) : undefined
  const candidatos = changingRoute ? validRouteAdmins(users, changingRoute).filter(a => a.id !== changingRoute.capitalControllerAdminId) : []
  const capitalColocado = (routeId: string) => overview?.routes.find(r => r.routeId === routeId)?.colocado ?? 0
  const detailMovs = detailRouteId ? movements.filter(m => m.routeId === detailRouteId) : []

  // ============================================================
  // RENDER
  // ============================================================
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Capital</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {esSuperAdmin
            ? 'SuperAdmin → Administradores → Rutas. Asignas capital a cada Administrador; él lo distribuye en sus rutas.'
            : 'Tu capital asignado por el SuperAdmin y las rutas cuyo capital controlas.'}
        </p>
      </div>
      {esSuperAdmin && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setSaOp({ tipo: 'COMPANY_DEPOSIT', adminId: '', amount: 0, descripcion: '', fecha: today() })} icon={<Plus className="w-4 h-4" />}>
            Ingresar capital
          </Button>
          <Button onClick={() => setSaOp({ tipo: 'ADMIN_ALLOCATION', adminId: '', amount: 0, descripcion: '', fecha: today() })} icon={<ArrowUpRight className="w-4 h-4" />}>
            Asignar a Administrador
          </Button>
        </div>
      )}
    </div>
  )

  if (loading && !overview) {
    return <div className="p-4 md:p-6 space-y-6">{header}<div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div></div>
  }
  if (error) {
    return <div className="p-4 md:p-6 space-y-6">{header}<p className="text-sm text-red-600">{error}</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      {header}

      {overview && overview.issues.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="capital-issues">
          <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div><p className="font-medium">El capital no cuadra</p><ul className="text-xs list-disc ml-4">{overview.issues.map(i => <li key={i}>{i}</li>)}</ul></div>
        </div>
      )}

      <OfficeRouteFilterBar
        offices={officeFilter.offices}
        officeId={officeFilter.officeId}
        onOfficeChange={officeFilter.setOfficeId}
        routesInOffice={officeFilter.routesInOffice}
        routeId={officeFilter.routeId}
        onRouteChange={officeFilter.setRouteId}
        hasUnassigned={officeFilter.hasUnassigned}
        contextLabel={officeFilter.contextLabel}
        showContext={officeFilter.hasOfficeFilter}
      />

      {esSuperAdmin && overview ? (
        <>
          {/* Empresa */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Capital de la empresa</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Capital total controlado" value={money(overview.company.total)} testId="company-total" />
              <Stat label="Disponible (sin asignar)" value={money(overview.company.disponible)} tone="text-emerald-700" bg="bg-emerald-50" testId="company-available" />
              <Stat label="Asignado a Administradores" value={money(overview.admins.reduce((s, a) => s + a.asignado, 0))} tone="text-primary-700" bg="bg-primary-50" testId="company-assigned" />
              <Stat label="En rutas sin responsable" value={money(overview.company.sinResponsable)} {...(overview.company.sinResponsable ? ALERTA : {})} />
            </div>
          </section>

          {/* Administradores */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="admins-capital">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Administradores</h2>
              <span className="text-xs text-gray-400">{adminRows.length + sinBolsa.length} administrador(es)</span>
            </div>
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-3 font-medium">Administrador</th>
                    <th className="py-2 pr-3 font-medium text-right">Asignado</th>
                    <th className="py-2 pr-3 font-medium text-right">En rutas</th>
                    <th className="py-2 pr-3 font-medium text-right">Disponible</th>
                    <th className="py-2 pr-3 font-medium text-center">Rutas</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {adminRows.map(a => (
                    <tr key={a.adminId} data-testid={`admin-row-${a.adminId}`}>
                      <td className="py-2.5 pr-3">
                        <p className="font-medium text-gray-900">{a.user!.nombre}</p>
                        {a.user!.status !== 'activo' && <Badge variant="gray" size="sm">Inactivo</Badge>}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-semibold text-gray-900">{money(a.asignado)}</td>
                      <td className="py-2.5 pr-3 text-right text-indigo-700">{money(a.enRutas)}</td>
                      <td className="py-2.5 pr-3 text-right text-emerald-700 font-semibold">{money(a.disponible)}</td>
                      <td className="py-2.5 pr-3 text-center">{a.rutas.filter(r => routes.find(x => x.id === r.routeId)?.capitalControllerAdminId === a.adminId).length}</td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setDetailAdminId(a.adminId)} icon={<ChevronRight className="w-3.5 h-3.5" />}>Detalle</Button>
                      </td>
                    </tr>
                  ))}
                  {sinBolsa.map(a => (
                    <tr key={a.id}>
                      <td className="py-2.5 pr-3 font-medium text-gray-900">{a.nombre}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{money(0)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{money(0)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{money(0)}</td>
                      <td className="py-2.5 pr-3 text-center text-gray-400">0</td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setSaOp({ tipo: 'ADMIN_ALLOCATION', adminId: a.id, amount: 0, descripcion: '', fecha: today() })}>Asignar</Button>
                      </td>
                    </tr>
                  ))}
                  {adminRows.length + sinBolsa.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-gray-400">No hay Administradores activos.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Rutas y responsable */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="routes-controller">
            <h2 className="text-sm font-semibold text-gray-900">Rutas y responsable de capital</h2>
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
                          ? <p className="text-xs text-gray-500">Responsable: <span className="font-medium text-gray-700">{resp.nombre}</span>{otros.length > 0 ? ` · también asignados: ${otros.map(o => o.nombre).join(', ')}` : ''}</p>
                          : <p className="text-xs font-medium text-amber-700">Sin responsable de capital{otros.length ? '' : ' · sin Administradores asignados'}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-xs text-gray-400">Capital colocado</p>
                        <p className="text-sm font-semibold text-gray-800">{money(capitalColocado(r.id))}</p>
                      </div>
                      <div className="text-right hidden sm:block">
                        <p className="text-xs text-gray-400">Base de la ruta</p>
                        <p className="text-sm font-semibold text-primary-700">{money(summaryByRoute[r.id]?.baseActual ?? 0)}</p>
                      </div>
                      <Button size="sm" variant="secondary" disabled={validRouteAdmins(users, r).filter(a => a.id !== r.capitalControllerAdminId).length === 0}
                        onClick={() => setChanging({ routeId: r.id, adminId: '', motivo: '' })} icon={<Repeat className="w-3.5 h-3.5" />}>
                        {resp ? 'Cambiar' : 'Asignar'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setHistoryRouteId(r.id)} icon={<History className="w-3.5 h-3.5" />}>Historial</Button>
                    </div>
                  </div>
                )
              })}
              {rutasVisibles.length === 0 && <p className="py-6 text-center text-sm text-gray-400">No hay rutas.</p>}
            </div>
          </section>
        </>
      ) : (
        <>
          {/* Administrador: su bolsa */}
          <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid="my-capital">
            <h2 className="text-sm font-semibold text-gray-900">Mi capital</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Stat label="Capital asignado" value={money(miBolsa?.asignado ?? 0)} testId="my-assigned" />
              <Stat label="Distribuido en mis rutas" value={money(miBolsa?.enRutas ?? 0)} tone="text-indigo-700" bg="bg-indigo-50" testId="my-in-routes" />
              <Stat label="Disponible" value={money(miBolsa?.disponible ?? 0)} tone="text-emerald-700" bg="bg-emerald-50" testId="my-available" />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Rutas cuyo capital controlo</h2>
            {misRutas.length === 0 ? (
              <p className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 text-sm text-gray-500">No eres responsable de capital de ninguna ruta.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {misRutas.map(r => (
                  <div key={r.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4" data-testid={`my-route-${r.id}`}>
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0"><MapPin className="w-4 h-4 text-primary-600" /></div>
                      <div className="min-w-0"><p className="text-sm font-semibold text-gray-900 truncate">{r.nombre}</p><p className="text-xs text-gray-400">{r.codigo}</p></div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <Stat label="Capital colocado" value={money(capitalColocado(r.id))} />
                      <Stat label="Base de la ruta" value={money(summaryByRoute[r.id]?.baseActual ?? 0)} tone="text-primary-700" bg="bg-primary-50" />
                      <Stat label="Cartera Activa" value={money(summaryByRoute[r.id]?.carteraEnCalle ?? 0)} tone="text-indigo-700" bg="bg-indigo-50" />
                    </div>
                    <div className="flex flex-wrap justify-end gap-2 mt-3">
                      <Button size="sm" variant="ghost" onClick={() => setDetailRouteId(r.id)} icon={<ChevronRight className="w-3.5 h-3.5" />}>Movimientos</Button>
                      <Button size="sm" variant="secondary" onClick={() => abrirRouteOp('retirar', r.id)} icon={<ArrowDownLeft className="w-3.5 h-3.5" />}>Retirar</Button>
                      <Button size="sm" onClick={() => abrirRouteOp('colocar', r.id)} icon={<ArrowUpRight className="w-3.5 h-3.5" />}>Colocar capital</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {otrasRutas.length > 0 && (
            <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="other-routes">
              <h2 className="text-sm font-semibold text-gray-900">Otras rutas asignadas (sin control de capital)</h2>
              <p className="text-xs text-gray-500">Puedes operarlas según tus permisos, pero su capital y su caja los maneja su responsable.</p>
              <div className="divide-y divide-gray-50">
                {otrasRutas.map(r => {
                  const resp = routeCapitalController(r, users)
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-2 py-2">
                      <p className="text-sm text-gray-800">{r.nombre}</p>
                      {resp ? <p className="text-xs text-gray-500">Responsable: <span className="font-medium text-gray-700">{resp.nombre}</span></p>
                        : <p className="text-xs font-medium text-amber-700">Sin responsable de capital</p>}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}

      {/* Historial del libro de capital */}
      <section className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="capital-ledger">
        <h2 className="text-sm font-semibold text-gray-900">Historial de capital</h2>
        {ledger.length === 0 ? <p className="text-sm text-gray-400">Sin movimientos.</p> : (
          <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
            {ledger.slice(0, 100).map(e => (
              <div key={e.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">{LEDGER_LABEL[e.tipo]}{e.routeId ? ` · ${routeName(e.routeId)}` : ''}</p>
                  <p className="text-xs text-gray-400">
                    {formatDateTime(e.createdAt)} · {e.fromAdminId ? `de ${nombre(e.fromAdminId)}` : e.tipo === 'ADMIN_ALLOCATION' || e.tipo === 'COMPANY_WITHDRAWAL' ? 'de la empresa' : e.tipo === 'COMPANY_DEPOSIT' ? 'externo' : 'sin responsable'}
                    {' → '}{e.toAdminId ? nombre(e.toAdminId) : e.tipo === 'ADMIN_RETURN' || e.tipo === 'COMPANY_DEPOSIT' ? 'empresa' : e.tipo === 'COMPANY_WITHDRAWAL' ? 'externo' : 'sin responsable'}
                    {' · '}registró {e.actorUserId.startsWith('system:') ? 'migración' : nombre(e.actorUserId)}{e.descripcion ? ` · ${e.descripcion}` : ''}
                  </p>
                </div>
                <span className="text-sm font-bold text-gray-800 whitespace-nowrap">{money(e.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* SuperAdmin: movimiento de capital */}
      <Modal open={!!saOp} onClose={() => setSaOp(null)} title={saOp ? SA_OPERATION_LABEL[saOp.tipo] : ''}
        footer={<><Button variant="secondary" onClick={() => setSaOp(null)}>Cancelar</Button><Button onClick={guardarSaOp} loading={saving}>Registrar</Button></>}>
        {saOp && (
          <div className="space-y-4">
            <Select label="Operación" value={saOp.tipo} onChange={e => setSaOp(o => o && { ...o, tipo: e.target.value as SaOperation })}
              options={(Object.keys(SA_OPERATION_LABEL) as SaOperation[]).map(k => ({ value: k, label: SA_OPERATION_LABEL[k] }))} />
            {(saOp.tipo === 'ADMIN_ALLOCATION' || saOp.tipo === 'ADMIN_RETURN') && (
              <Select label="Administrador" value={saOp.adminId} onChange={e => setSaOp(o => o && { ...o, adminId: e.target.value })} required placeholder="Seleccionar Administrador"
                options={admins.filter(a => saOp.tipo === 'ADMIN_RETURN' || a.status === 'activo').map(a => ({ value: a.id, label: a.nombre }))} />
            )}
            <p className="text-xs text-gray-500">
              {saOp.tipo === 'ADMIN_RETURN'
                ? `Disponible del Administrador: ${money(overview?.admins.find(a => a.adminId === saOp.adminId)?.disponible ?? 0)} (lo colocado en sus rutas no se puede recoger).`
                : saOp.tipo === 'COMPANY_DEPOSIT' ? 'Capital nuevo que entra a la empresa.'
                  : `Disponible de la empresa: ${money(overview?.company.disponible ?? 0)}.`}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <MoneyInput label="Valor" currency={currency} value={saOp.amount} onValueChange={v => setSaOp(o => o && { ...o, amount: v })} required />
              <Input label="Fecha" type="date" value={saOp.fecha} onChange={e => setSaOp(o => o && { ...o, fecha: e.target.value })} />
            </div>
            <Textarea label="Descripción" value={saOp.descripcion} onChange={e => setSaOp(o => o && { ...o, descripcion: e.target.value })} rows={2} />
          </div>
        )}
      </Modal>

      {/* SuperAdmin: cambiar responsable */}
      <Modal open={!!changing} onClose={() => setChanging(null)} title={changingRoute ? `Responsable de capital · ${changingRoute.nombre}` : ''}
        footer={<><Button variant="secondary" onClick={() => setChanging(null)}>Cancelar</Button><Button onClick={guardarResponsable} loading={saving} disabled={!changing?.adminId}>Cambiar responsable</Button></>}>
        {changing && changingRoute && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Responsable actual: <span className="font-semibold">{routeCapitalController(changingRoute, users)?.nombre ?? 'ninguno'}</span>.
              El capital colocado en la ruta ({money(capitalColocado(changingRoute.id))}) pasa a la bolsa del nuevo responsable; el anterior deja de responder desde este momento. Los históricos no cambian.
            </p>
            <Select label="Nuevo responsable" value={changing.adminId} onChange={e => setChanging(c => c && { ...c, adminId: e.target.value })} required placeholder="Seleccionar Administrador asignado"
              options={candidatos.map(a => ({ value: a.id, label: a.nombre }))}
              hint="Solo Administradores activos asignados a esta ruta." />
            <Textarea label="Motivo" value={changing.motivo} onChange={e => setChanging(c => c && { ...c, motivo: e.target.value })} rows={2} required />
          </div>
        )}
      </Modal>

      {/* Admin: colocar / retirar */}
      <Modal open={!!routeOp} onClose={() => setRouteOp(null)} title={routeOp ? `${routeOp.tipo === 'colocar' ? 'Colocar capital en' : 'Retirar capital de'} ${routeName(routeOp.routeId)}` : ''}
        footer={<><Button variant="secondary" onClick={() => setRouteOp(null)}>Cancelar</Button><Button onClick={guardarRouteOp} loading={saving}>Registrar</Button></>}>
        {routeOp && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500">
              {routeOp.tipo === 'colocar'
                ? `Sale de tu bolsa. Disponible: ${money(miBolsa?.disponible ?? 0)}.`
                : `Vuelve a tu bolsa. Disponible para retiro en la ruta (caja no asignada): ${money(routeOp.disponibleRuta ?? 0)}.`}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <MoneyInput label="Valor" currency={currency} value={routeOp.valor} onValueChange={v => setRouteOp(o => o && { ...o, valor: v })} required />
              <Input label="Fecha" type="date" value={routeOp.fecha} onChange={e => setRouteOp(o => o && { ...o, fecha: e.target.value })} />
            </div>
            <Textarea label="Descripción" value={routeOp.descripcion} onChange={e => setRouteOp(o => o && { ...o, descripcion: e.target.value })} rows={2} />
          </div>
        )}
      </Modal>

      {/* Detalle de un Administrador (SuperAdmin) */}
      <Modal open={!!detailAdmin} onClose={() => setDetailAdminId(null)} title={detailAdmin ? `Capital · ${detailAdmin.user!.nombre}` : ''} size="lg"
        footer={detailAdmin && (<>
          <Button variant="secondary" onClick={() => { setSaOp({ tipo: 'ADMIN_RETURN', adminId: detailAdmin.adminId, amount: 0, descripcion: '', fecha: today() }); setDetailAdminId(null) }} icon={<ArrowDownLeft className="w-4 h-4" />}>Recoger</Button>
          <Button onClick={() => { setSaOp({ tipo: 'ADMIN_ALLOCATION', adminId: detailAdmin.adminId, amount: 0, descripcion: '', fecha: today() }); setDetailAdminId(null) }} icon={<ArrowUpRight className="w-4 h-4" />}>Asignar más</Button>
        </>)}>
        {detailAdmin && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Asignado" value={money(detailAdmin.asignado)} />
              <Stat label="En rutas" value={money(detailAdmin.enRutas)} tone="text-indigo-700" bg="bg-indigo-50" />
              <Stat label="Disponible" value={money(detailAdmin.disponible)} tone="text-emerald-700" bg="bg-emerald-50" />
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Rutas que controla</p>
              {detailAdmin.rutas.length === 0 ? <p className="text-sm text-gray-400">Ninguna.</p> : (
                <div className="divide-y divide-gray-50">
                  {detailAdmin.rutas.map(r => (
                    <div key={r.routeId} className="flex items-center justify-between py-1.5 text-sm">
                      <span>{routeName(r.routeId)}</span><span className="font-semibold">{money(r.colocado)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Movimientos</p>
              <div className="divide-y divide-gray-50 max-h-60 overflow-y-auto">
                {ledger.filter(e => e.fromAdminId === detailAdmin.adminId || e.toAdminId === detailAdmin.adminId).map(e => (
                  <div key={e.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate">{LEDGER_LABEL[e.tipo]}{e.routeId ? ` · ${routeName(e.routeId)}` : ''} <span className="text-xs text-gray-400">{formatDate(e.fecha)}</span></span>
                    <span className={`font-semibold ${e.toAdminId === detailAdmin.adminId ? 'text-emerald-600' : 'text-amber-600'}`}>{signedMoney(e.toAdminId === detailAdmin.adminId ? e.amount : -e.amount, currency)}</span>
                  </div>
                ))}
                {movements.filter(m => m.adminId === detailAdmin.adminId).map(m => (
                  <div key={m.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate">Capital colocado · {routeName(m.routeId)} <span className="text-xs text-gray-400">{formatDate(m.fecha)}</span></span>
                    <span className="font-semibold text-amber-600">{signedMoney(-m.valor, currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Historial de responsables de una ruta */}
      <Modal open={!!historyRouteId} onClose={() => setHistoryRouteId(null)} title={historyRouteId ? `Historial de responsables · ${routeName(historyRouteId)}` : ''}
        footer={<Button variant="secondary" onClick={() => setHistoryRouteId(null)}>Cerrar</Button>}>
        <div className="divide-y divide-gray-50" data-testid="controller-history">
          {events.filter(e => e.routeId === historyRouteId).map(e => (
            <div key={e.id} className="py-2">
              <p className="text-sm text-gray-900 flex items-center gap-1.5"><UserCog className="w-4 h-4 text-gray-400" />{EVENT_LABEL[e.kind]}: {e.fromAdminId ? nombre(e.fromAdminId) : 'ninguno'} → {e.toAdminId ? nombre(e.toAdminId) : 'ninguno'}</p>
              <p className="text-xs text-gray-400">
                {formatDateTime(e.createdAt)} · registró {e.actorUserId.startsWith('system:') ? 'migración' : nombre(e.actorUserId)} · capital traspasado {money(e.capitalTransferido)}
                {e.baseAlCambio !== undefined ? ` · Base al cambio ${money(e.baseAlCambio)}` : ''}{e.motivo ? ` · ${e.motivo}` : ''}
              </p>
            </div>
          ))}
          {events.filter(e => e.routeId === historyRouteId).length === 0 && <p className="py-4 text-sm text-gray-400">Sin cambios registrados.</p>}
        </div>
      </Modal>

      {/* Movimientos de capital de una ruta propia */}
      <Modal open={!!detailRouteId} onClose={() => setDetailRouteId(null)} title={detailRouteId ? `Movimientos de capital · ${routeName(detailRouteId)}` : ''} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailRouteId(null)}>Cerrar</Button>}>
        {detailMovs.length === 0 ? <div className="flex justify-center py-8 text-gray-400 text-sm">Esta ruta no tiene movimientos de capital</div> : (
          <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
            {pairReversals(detailMovs).map(({ movement: m, reversal }) => {
              const estado = reversalStateOf(m)
              return (
                <div key={m.id}>
                  <div className="flex items-center justify-between gap-2 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0"><DollarSign className="w-4 h-4 text-primary-600" /></div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                          {estado === 'reversion' ? 'Reversión de capital' : m.descripcion || 'Capital colocado'}
                          {estado === 'anulado' && <AnnulledBadge />}
                        </p>
                        <p className="text-xs text-gray-400">{formatDate(m.fecha)} · {m.adminId ? `bolsa de ${nombre(m.adminId)}` : 'anterior a la asignación por Administrador'}{estado === 'reversion' && m.reversalReason ? ` · Motivo: ${m.reversalReason}` : ''}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {canReverseRouteFund(user, m, routes, users) && <ReverseButton onClick={() => setReversing(m)} />}
                      <span className={`text-sm font-bold ${estado === 'anulado' ? 'text-gray-400 line-through' : m.valor >= 0 ? 'text-emerald-600' : 'text-amber-600'}`}>{signedMoney(m.valor, currency)}</span>
                    </div>
                  </div>
                  {estado === 'anulado' && <ReversalDetail original={m} reversal={reversal} currency={currency} signo={1} userName={nombre} />}
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      <ReverseMovementModal currency={currency} onCancel={() => setReversing(null)} onConfirm={handleReverse}
        target={reversing && { tipo: 'Capital colocado', valor: reversing.valor, fecha: reversing.fecha, detalle: [routeName(reversing.routeId), reversing.descripcion].filter(Boolean).join(' · ') }} />
    </div>
  )
}
