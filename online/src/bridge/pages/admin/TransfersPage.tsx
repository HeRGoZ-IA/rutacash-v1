// ADEX Online: pantalla de TRANSFERENCIAS (Ronda 53). Parte de la TransfersPage de CLEAN
// (src/pages/admin/TransfersPage.tsx) con la misma identidad visual, reorganizada:
//
//   · Arriba, lo que decide una operación: capital disponible, capital en manos de
//     trabajadores y transferencias pendientes.
//   · UN punto de entrada, «Nueva operación», con SOLO las operaciones que el rol activo
//     puede ejecutar (mismas reglas que cada servicio: `availableOperations`). Las de
//     trabajadores abren el asistente de CLEAN (`OperationWizard`, sus servicios de
//     siempre); el traspaso entre Administradores, su formulario (servidor, 0023).
//   · Rutas solo de consulta (responsable y efectivo en manos), sin botones repetidos.
//   · «Ver movimientos» abre una ventana con filtros; nada de historial permanente.
//
// Sin Socio ni Caja socios (retirados de ADEX Online en la Ronda 53).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronDown, History, MapPin, Plus, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { getRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { listCustodyMovements } from '@/services/cashCustodyService'
import { availableOperations, operationDef, type TransferMode, type TransferOperationKind } from '@/lib/transferOperations'
import { OperationWizard } from '@/components/transfers/OperationWizard'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import { filterAccessibleRoutes } from '@/lib/permissions'
import { CapitalControllerBadge } from '@/components/ui/CapitalControllerBadge'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import { useCentralCapital } from '@/hooks/useCentralCapital'
import type { CashCustodyMovement, Route, User } from '@/models/types'
import { serverView } from '../../../runtime/projection.ts'
import { toMajor } from '../../../runtime/mappers.ts'
import { listAdminTransfers, STATE_LABEL, type AdminTransfer } from '../../../runtime/adminTransfers.ts'
import { TransferCard, TransferDecisionModal, TransferRegisterModal } from '../../../runtime/AdminTransferUI.tsx'

interface PoolSummary { admins: { adminId: string; availableMinor: number; pendingTransfersOutMinor?: number }[]; company?: { availableMinor: number; inTransitMinor?: number } }

/** Operaciones del menú «Nueva operación»: las del asistente de CLEAN y el traspaso entre Administradores. */
type NewOp = { kind: TransferOperationKind } | { kind: 'admin-transfer' }

export default function TransfersPage() {
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  const money = (n: number) => formatCurrency(n, currency)
  const central = useCentralCapital(tenantId)
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [enManos, setEnManos] = useState<Record<string, number | null>>({})
  const [heredado, setHeredado] = useState<Record<string, number>>({})
  const [pool, setPool] = useState<{ available: number; pendingOut: number } | null>(null)
  const [companyAvailable, setCompanyAvailable] = useState<number | null>(null)
  const [transfers, setTransfers] = useState<AdminTransfer[]>([])
  const [loading, setLoading] = useState(true)
  const [chooser, setChooser] = useState(false)
  const [wizard, setWizard] = useState<{ kind?: TransferOperationKind } | null>(null)
  const [adminForm, setAdminForm] = useState(false)
  const [decision, setDecision] = useState<{ t: AdminTransfer; what: 'confirm' | 'reject' | 'cancel' } | null>(null)
  const [movements, setMovements] = useState(false)

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
    // Efectivo en manos de trabajadores y saldo heredado: MISMA fuente que Caja y Liquidación.
    const saldos = await Promise.all(scoped.map(async r => {
      try {
        const c = await getRouteCashReconciliation({ actor: user, tenantId, routeId: r.id })
        return [r.id, c.enPersonas, Math.max(0, c.noAsignado)] as const
      } catch { return [r.id, null, 0] as const }
    }))
    setEnManos(Object.fromEntries(saldos.map(([id, p]) => [id, p])))
    setHeredado(Object.fromEntries(saldos.map(([id, , h]) => [id, h])))
    const summary = await serverView<PoolSummary>('/v1/capital/summary').catch(() => null)
    const own = summary?.admins.find(a => a.adminId === user?.id)
    setPool(user?.rol === 'admin' && own ? { available: toMajor(own.availableMinor), pendingOut: toMajor(own.pendingTransfersOutMinor ?? 0) } : null)
    setCompanyAvailable(user?.rol === 'superadmin' && summary?.company ? toMajor(summary.company.availableMinor) : null)
    setTransfers(await listAdminTransfers().catch(() => []))
    setLoading(false)
  }

  const modo: TransferMode | undefined = central.activo ? { central: true, heredado } : undefined
  const workerOps = central.listo ? availableOperations(user, routes, users, tenantId, modo) : []
  const otherAdmins = users.filter(u => u.rol === 'admin' && u.status === 'activo' && u.id !== user?.id)
  const canAdminTransfer = user?.rol === 'admin' && otherAdmins.length > 0
  const ops: NewOp[] = [...workerOps.map(kind => ({ kind })), ...(canAdminTransfer ? [{ kind: 'admin-transfer' as const }] : [])]

  const rutasVisibles = routes.filter(r => officeFilter.visibleRouteIds.has(r.id))
  const totalEnManos = rutasVisibles.reduce((s, r) => s + (enManos[r.id] ?? 0), 0)
  const pendientes = transfers.filter(t => t.state === 'pending')
  const porDecidir = pendientes.filter(t => t.canConfirm || t.canReject)
  const userName = (id?: string) => users.find(u => u.id === id)?.nombre ?? ''

  function start(op: NewOp) {
    setChooser(false)
    if (op.kind === 'admin-transfer') setAdminForm(true)
    else setWizard({ kind: op.kind })
  }
  const opTitle = (op: NewOp) => op.kind === 'admin-transfer' ? 'Transferir a otro Administrador' : operationDef(op.kind, modo).titulo
  const opHelp = (op: NewOp) => op.kind === 'admin-transfer' ? 'Sale de tu bolsa al confirmarlo el destino.'
    : op.kind === 'entregar-capital' ? 'De tu bolsa a un cobrador o supervisor de tu ruta.'
      : op.kind === 'devolver-capital' ? 'Efectivo que un trabajador devuelve a la bolsa.'
        : operationDef(op.kind, modo).ayuda
  const opIcon = (op: NewOp) => op.kind === 'admin-transfer' ? <Users className="w-5 h-5" />
    : op.kind === 'devolver-capital' || op.kind === 'devolver-base' || op.kind === 'retirar' ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button variant="secondary" onClick={() => setMovements(true)} icon={<History className="w-4 h-4" />} data-testid="open-movements">Ver movimientos</Button>
          {ops.length > 0 && <Button onClick={() => setChooser(true)} icon={<Plus className="w-4 h-4" />} data-testid="new-operation">Nueva operación</Button>}
        </div>
      </div>

      {/* ---------- RESUMEN ---------- */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="transfers-summary">
        {user?.rol === 'admin' && (
          <div className="rounded-2xl bg-primary-50 border border-primary-100 p-4">
            <p className="text-xs text-gray-600">Capital disponible</p>
            <p className="text-lg font-bold text-primary-700" data-testid="summary-pool">{pool == null ? 'No disponible' : money(pool.available)}</p>
            {pool && pool.pendingOut > 0 && <p className="text-[11px] text-amber-700">{money(pool.pendingOut)} comprometido en transferencias pendientes</p>}
          </div>
        )}
        {user?.rol === 'superadmin' && (
          <div className="rounded-2xl bg-primary-50 border border-primary-100 p-4">
            <p className="text-xs text-gray-600">Capital de la empresa sin asignar</p>
            <p className="text-lg font-bold text-primary-700">{companyAvailable == null ? 'No disponible' : money(companyAvailable)}</p>
            <Link to="/admin/capital" className="text-[11px] text-primary-700 hover:underline">Asignar en Capital</Link>
          </div>
        )}
        <div className="rounded-2xl bg-white border border-gray-100 shadow-card p-4">
          <p className="text-xs text-gray-600">En manos de trabajadores</p>
          <p className="text-lg font-bold text-gray-900" data-testid="summary-workers">{money(totalEnManos)}</p>
          <p className="text-[11px] text-gray-500">{rutasVisibles.length} ruta(s)</p>
        </div>
        <div className={`rounded-2xl border p-4 ${porDecidir.length ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-100 shadow-card'}`}>
          <p className="text-xs text-gray-600">Pendientes</p>
          <p className="text-lg font-bold text-gray-900" data-testid="summary-pending">{pendientes.length}</p>
          <p className="text-[11px] text-gray-500">{porDecidir.length ? `${porDecidir.length} esperan tu confirmación` : 'Transferencias entre Administradores'}</p>
        </div>
      </section>

      {/* ---------- PENDIENTES ---------- */}
      {pendientes.length > 0 && (
        <section className="space-y-3" data-testid="pending-transfers">
          <h2 className="text-sm font-semibold text-gray-900">Por confirmar</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pendientes.map(t => <TransferCard key={t.id} t={t} currency={currency} onAction={(x, what) => setDecision({ t: x, what })} />)}
          </div>
        </section>
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
                    {central.bloqueos[r.id] && <p className="text-[11px] font-medium text-amber-700 mt-1" data-testid="route-blocked">Bloqueada para capital nuevo</p>}
                    {(heredado[r.id] ?? 0) > 0 && <p className="text-[11px] text-gray-500 mt-1">Saldo heredado {money(heredado[r.id])}</p>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-[11px] text-gray-500">En trabajadores</p>
                  <p className="text-sm font-bold text-gray-800">{enManos[r.id] == null ? '—' : money(enManos[r.id] ?? 0)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------- NUEVA OPERACIÓN: solo lo que el rol activo puede hacer ---------- */}
      <Modal open={chooser} onClose={() => setChooser(false)} title="Nueva operación" size="md">
        <div className="grid grid-cols-1 gap-2" data-testid="op-chooser">
          {ops.map(op => (
            <button key={op.kind} type="button" onClick={() => start(op)} data-testid={`op-${op.kind}`}
              className="flex items-center gap-3 text-left rounded-xl border border-gray-200 bg-white p-3 hover:border-primary-300 hover:bg-primary-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition-colors">
              <span className="w-10 h-10 rounded-xl bg-primary-100 text-primary-700 flex items-center justify-center flex-shrink-0">{opIcon(op)}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-gray-900">{opTitle(op)}</span>
                <span className="block text-xs text-gray-500">{opHelp(op)}</span>
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <OperationWizard open={!!wizard} onClose={() => setWizard(null)} onDone={() => { void load() }}
        routes={routes} users={users} inicial={wizard ?? undefined} modo={modo} />
      <TransferRegisterModal open={adminForm} onClose={() => setAdminForm(false)} onDone={() => { setAdminForm(false); void load() }}
        currency={currency} asSecretary={false} available={pool?.available ?? null} />
      <TransferDecisionModal target={decision} currency={currency} onClose={() => setDecision(null)} onDone={() => { setDecision(null); void load() }} />
      <MovementsModal open={movements} onClose={() => setMovements(false)} routes={routes} users={users} transfers={transfers}
        currency={currency} userName={userName} routeLabel={officeFilter.labelFor} />
    </div>
  )
}

// ============================================================
// Movimientos bajo demanda (entregas, devoluciones, traspasos)
// ============================================================

type MovementKind = 'entrega' | 'devolucion' | 'traspaso' | 'administradores'
interface MovementRow {
  key: string; kind: MovementKind; createdAt: string; amount: number; title: string; routeId?: string
  participants: string[]; estado: string; ref: string; detail: [string, string][]
}

const KIND_LABEL: Record<MovementKind, string> = {
  entrega: 'Entregas a trabajadores', devolucion: 'Devoluciones', traspaso: 'Traspasos entre trabajadores', administradores: 'Entre Administradores',
}

function MovementsModal({ open, onClose, routes, users, transfers, currency, userName, routeLabel }: {
  open: boolean; onClose: () => void; routes: Route[]; users: User[]; transfers: AdminTransfer[]; currency: string
  userName: (id?: string) => string; routeLabel: (id: string) => string
}) {
  const [custody, setCustody] = useState<CashCustodyMovement[] | null>(null)
  const [f, setF] = useState({ kind: '', estado: '', desde: '', hasta: '', ruta: '', persona: '', q: '' })
  const [openKey, setOpenKey] = useState<string | null>(null)

  // Se lee al abrir (no con la pantalla): el historial no viaja si nadie lo consulta.
  useEffect(() => {
    if (!open) return
    setCustody(null)
    let alive = true
    Promise.all(routes.map(r => listCustodyMovements(r.id).catch(() => [] as CashCustodyMovement[])))
      .then(list => { if (alive) setCustody(list.flat()) })
    return () => { alive = false }
  }, [open, routes])

  const rows = useMemo<MovementRow[]>(() => {
    const out: MovementRow[] = []
    for (const m of custody ?? []) {
      const kind: MovementKind = m.tipo === 'BASE_ASSIGNMENT' ? 'entrega' : m.tipo === 'BASE_RETURN' ? 'devolucion' : 'traspaso'
      const anulacion = !!m.reversesId
      const who = kind === 'entrega' ? userName(m.toUserId) : kind === 'devolucion' ? userName(m.fromUserId) : `${userName(m.fromUserId)} → ${userName(m.toUserId)}`
      out.push({
        key: `c:${m.id}`, kind, createdAt: m.createdAt, amount: m.amount, routeId: m.routeId,
        title: `${anulacion ? 'Anulación · ' : ''}${kind === 'entrega' ? 'Entrega a' : kind === 'devolucion' ? 'Devolución de' : 'Traspaso'} ${who}`,
        participants: [m.toUserId, m.fromUserId, m.createdByUserId].filter(Boolean) as string[],
        estado: anulacion ? 'Anulación' : m.reversalId ? 'Anulada' : 'Vigente', ref: m.id.slice(0, 8).toUpperCase(),
        detail: [['Ruta', routeLabel(m.routeId)], ['Registró', userName(m.createdByUserId) || '—'], ['Concepto', m.motivo || '—'], ['Referencia', m.id.slice(0, 8).toUpperCase()]],
      })
    }
    for (const t of transfers) {
      out.push({
        key: `t:${t.id}`, kind: 'administradores', createdAt: t.createdAt, amount: t.amount,
        title: `${t.origin.name ?? 'Administrador'} → ${t.destination.name ?? 'Administrador'}`,
        participants: [t.origin.adminId, t.destination.adminId, t.registeredBy.membershipId], estado: STATE_LABEL[t.state], ref: t.id.slice(0, 8).toUpperCase(),
        detail: [['Concepto', t.reason], ['Modalidad', t.mode === 'secretary' ? `Registrada por ${t.registeredBy.name ?? 'Secretaría'}` : 'Directa'],
          ['Origen', `${t.origin.decision === 'confirmed' ? 'Confirmó' : t.origin.decision === 'rejected' ? 'Rechazó' : 'Pendiente'}${t.origin.reason ? ` · ${t.origin.reason}` : ''}`],
          ['Destino', `${t.destination.decision === 'confirmed' ? 'Confirmó' : t.destination.decision === 'rejected' ? 'Rechazó' : 'Pendiente'}${t.destination.reason ? ` · ${t.destination.reason}` : ''}`],
          ...(t.closeReason ? [['Motivo de cierre', t.closeReason] as [string, string]] : []), ['Referencia', t.id.slice(0, 8).toUpperCase()]],
      })
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [custody, transfers, userName, routeLabel])

  const q = f.q.trim().toLowerCase()
  const visible = rows.filter(r => (!f.kind || r.kind === f.kind) && (!f.estado || r.estado === f.estado)
    && (!f.desde || r.createdAt.slice(0, 10) >= f.desde) && (!f.hasta || r.createdAt.slice(0, 10) <= f.hasta)
    && (!f.ruta || r.routeId === f.ruta) && (!f.persona || r.participants.includes(f.persona))
    && (!q || r.title.toLowerCase().includes(q) || r.ref.toLowerCase().includes(q) || r.detail.some(([, v]) => v.toLowerCase().includes(q))))
  const estados = [...new Set(rows.map(r => r.estado))]
  const personas = users.filter(u => rows.some(r => r.participants.includes(u.id))).sort((a, b) => a.nombre.localeCompare(b.nombre))
  const limpio = !Object.values(f).some(Boolean)

  return (
    <Modal open={open} onClose={onClose} title="Movimientos" size="xl"
      footer={<><Link to="/admin/movements" className="text-sm text-primary-700 hover:underline mr-auto" data-testid="go-history">Historial general y comprobantes</Link>
        <Button variant="secondary" onClick={onClose}>Cerrar</Button></>}>
      <div className="space-y-3" data-testid="movements-modal">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Select label="Tipo" value={f.kind} onChange={e => setF(x => ({ ...x, kind: e.target.value }))} placeholder="Todos"
            options={(Object.keys(KIND_LABEL) as MovementKind[]).map(k => ({ value: k, label: KIND_LABEL[k] }))} />
          <Select label="Estado" value={f.estado} onChange={e => setF(x => ({ ...x, estado: e.target.value }))} placeholder="Todos" options={estados.map(s => ({ value: s, label: s }))} />
          <Input label="Desde" type="date" value={f.desde} onChange={e => setF(x => ({ ...x, desde: e.target.value }))} />
          <Input label="Hasta" type="date" value={f.hasta} onChange={e => setF(x => ({ ...x, hasta: e.target.value }))} />
          <Select label="Ruta" value={f.ruta} onChange={e => setF(x => ({ ...x, ruta: e.target.value }))} placeholder="Todas" options={routes.map(r => ({ value: r.id, label: r.nombre }))} />
          <Select label="Persona" value={f.persona} onChange={e => setF(x => ({ ...x, persona: e.target.value }))} placeholder="Todas" options={personas.map(u => ({ value: u.id, label: u.nombre }))} />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden />
            <input value={f.q} onChange={e => setF(x => ({ ...x, q: e.target.value }))} placeholder="Referencia, nombre o concepto" aria-label="Buscar movimientos"
              className="h-10 w-full rounded-lg border border-gray-300 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
          {!limpio && <Button variant="ghost" size="sm" onClick={() => setF({ kind: '', estado: '', desde: '', hasta: '', ruta: '', persona: '', q: '' })}>Limpiar filtros</Button>}
          <p className="text-xs text-gray-500 sm:ml-auto">{custody == null ? 'Cargando…' : `${visible.length} de ${rows.length}`}</p>
        </div>
        {custody == null ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : visible.length === 0 ? (
          <EmptyState icon={<ArrowLeftRight className="w-8 h-8" />} title={rows.length ? 'Ningún movimiento con estos filtros' : 'Sin movimientos'} />
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl max-h-[55vh] overflow-y-auto">
            {visible.slice(0, 300).map(r => (
              <li key={r.key}>
                <button type="button" onClick={() => setOpenKey(k => k === r.key ? null : r.key)} aria-expanded={openKey === r.key}
                  className="w-full flex items-start justify-between gap-3 px-3 py-2.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900 break-words">{r.title}</span>
                    <span className="block text-xs text-gray-500">{KIND_LABEL[r.kind]} · {formatDateTime(r.createdAt)}{r.routeId ? ` · ${routeLabel(r.routeId)}` : ''} · {r.estado}</span>
                  </span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    <span className={`text-sm font-bold ${r.estado === 'Anulada' || r.estado === 'Cancelada' || r.estado === 'Rechazada' ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{formatCurrency(r.amount, currency)}</span>
                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${openKey === r.key ? 'rotate-180' : ''}`} aria-hidden />
                  </span>
                </button>
                {openKey === r.key && (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 px-3 pb-3 text-xs">
                    {r.detail.map(([k, v]) => <div key={k} className="min-w-0"><dt className="inline text-gray-500">{k}: </dt><dd className="inline text-gray-800 break-words">{v}</dd></div>)}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
        {visible.length > 300 && <p className="text-xs text-gray-500">Se muestran los 300 más recientes. Usa los filtros o el Historial general.</p>}
      </div>
    </Modal>
  )
}
