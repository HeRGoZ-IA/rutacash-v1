// ADEX Online: COPIA de la TransfersPage original de CLEAN (src/pages/admin/TransfersPage.tsx).
// Misma pantalla; entregas, devoluciones, aportes de socio, historial y anulaciones van al
// libro central del servidor por los servicios del puente. Único cambio, marcado: la
// «Operación con socio» (Caja socios, decisión D1) no existe en el servidor y se muestra
// deshabilitada con el motivo, nunca como disponible.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ArrowLeftRight, ChevronRight, MapPin, Users, Search, Wallet, Info, AlertTriangle, History } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { registerTransfer } from '@/services/routeFundsService'
import { canReverseTransfer, reverseTransfer } from '@/services/movementReversalService'
import { getRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { getAdminAvailableCapital } from '@/services/capitalControlService'
import { listCustodyMovements } from '@/services/cashCustodyService'
import { pairReversals, reversalStateOf } from '@/lib/movementReversal'
import { transferTotalsFor } from '@/lib/transferTotals'
import { availableOperations, operationButtonLabel, operationsOfMode, routesForOperation, transferCategories, type TransferMode, type TransferOperationKind } from '@/lib/transferOperations'
import { useCentralCapital } from '@/hooks/useCentralCapital'
import { registerPartnerContribution } from '@/services/centralCapitalService'
import { AnnulledBadge, ReversalDetail, ReverseButton, ReverseMovementModal, signedMoney } from '@/components/ui/MovementReversal'
import { OperationWizard } from '@/components/transfers/OperationWizard'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, formatDateTime, today } from '@/lib/formatters'
import { can, canOperateRouteCash, filterAccessibleRoutes, authorizedRouteIdsOf, isPartnerInScope, isTransferInScope } from '@/lib/permissions'
import { CapitalControllerBadge } from '@/components/ui/CapitalControllerBadge'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import type { CashCustodyMovement, Transfer, Route, User, TransferEntityType } from '@/models/types'

// Entidad participante (ruta o socio) para el historial agrupado.
interface EntityGroup {
  key: string          // `${type}:${id}`
  type: TransferEntityType
  id: string
  nombre: string
  entrante: number
  saliente: number
  neto: number
  cantidad: number
  ultimoMovimiento?: string
  transfers: Transfer[]
}

/** Saldos de la caja de una ruta (conciliación con permiso). `null` = no disponibles. */
interface RouteSummary { disponible: number; sinAsignar: number; enTrabajadores: number }

function encodeEndpoint(type: TransferEntityType, id: string) { return `${type}:${id}` }
function decodeEndpoint(v: string): { type: TransferEntityType; id: string } | null {
  const [type, id] = v.split(':')
  if ((type === 'route' || type === 'partner') && id) return { type, id }
  return null
}

/**
 * TRANSFERENCIAS — MÓDULO UNIFICADO (Ronda 4/6).
 *
 * Una sola pantalla para las operaciones de caja EXISTENTES, cada una con su
 * servicio (ver `OperationWizard` y `lib/transferOperations`): entregar y recibir
 * Base, transferir entre rutas del mismo responsable, distribuir y retirar
 * capital. No hay libro paralelo: el historial muestra los registros reales.
 *
 * Fuera del flujo nuevo, a propósito:
 *  · Traspaso de efectivo ENTRE TRABAJADORES: sigue en Liquidación → Cuadre por
 *    trabajador (`transferBaseBetweenWorkers`); el botón que solo navegaba se retiró
 *    (2026-10-07) y no vuelve.
 *  · Operaciones con SOCIOS: se conservan como estaban (sección propia), sin nuevos
 *    accesos, por los riesgos R1/R2 de la auditoría (decisión D1 pendiente).
 *  · Entre bolsas de Administradores distintos: no existe (D2 pendiente).
 *
 * CAPITAL CENTRALIZADO (C2): con el modelo activo la caja de la ruta no es una
 * bolsa. Se ofrecen entregar y recibir capital (bolsa ⇄ trabajador) y, solo donde
 * queda, vaciar el saldo heredado. No aparecen Ruta → Ruta, colocar en la caja ni
 * Socio → Ruta: el aporte de un socio entra a la bolsa del responsable.
 */
export default function TransfersPage() {
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  const money = (n: number) => formatCurrency(n, currency)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [partners, setPartners] = useState<User[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  /** Saldos por ruta: MISMA fuente que Caja y Liquidación (`getRouteCashReconciliation`). */
  const [resumen, setResumen] = useState<Record<string, RouteSummary | null>>({})
  const [bolsa, setBolsa] = useState<number | null>(null)
  const [custodia, setCustodia] = useState<CashCustodyMovement[]>([])
  const [saldosAt, setSaldosAt] = useState('')
  const [wizard, setWizard] = useState<{ kind?: TransferOperationKind; routeId?: string } | null>(null)
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [reversing, setReversing] = useState<Transfer | null>(null)
  // Historial: filtros
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [tipoFiltro, setTipoFiltro] = useState<'all' | 'route' | 'partner'>('all')
  const [search, setSearch] = useState('')
  // Operación con socio (formulario existente, sin cambios de reglas).
  const [socioOpen, setSocioOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today() })
  const [socioOpId, setSocioOpId] = useState('')
  // Capital centralizado: aporte de socio a la bolsa del responsable de una ruta.
  const central = useCentralCapital(tenantId)
  const [aporteOpen, setAporteOpen] = useState(false)
  const [aporte, setAporte] = useState({ partnerId: '', routeId: '', valor: 0, descripcion: '', fecha: today() })
  const [aporteOpId, setAporteOpId] = useState('')

  // Reactiva: otra pestaña del mismo navegador registra y esta vista se entera sin F5.
  const revision = useDataRevision()
  useEffect(() => { load() }, [tenantId, user, revision])  // eslint-disable-line react-hooks/exhaustive-deps

  const partnerRouteIds = (socioId: string) => authorizedRouteIdsOf(users.find(u => u.id === socioId))

  async function load() {
    setLoading(true)
    const [ts, rts, us] = await Promise.all([
      db.transfers.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: rutas autorizadas, socios vinculados y transferencias
    // cuyas DOS entidades están en alcance.
    const socioRoute = (id: string) => authorizedRouteIdsOf(us.find(u => u.id === id))
    const scopedRoutes = filterAccessibleRoutes(user, rts)
    setTransfers(ts.filter(t => isTransferInScope(user, t, socioRoute)).sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(scopedRoutes)
    setUsers(us)
    setPartners(us.filter(u => u.rol === 'socio' && isPartnerInScope(user, authorizedRouteIdsOf(u))))
    // Saldos SOLO de rutas en alcance (nunca rutas ajenas), con el permiso del servicio.
    const saldos = await Promise.all(scopedRoutes.map(async r => {
      try {
        const c = await getRouteCashReconciliation({ actor: user, tenantId, routeId: r.id })
        return [r.id, { disponible: c.disponible, sinAsignar: c.noAsignado, enTrabajadores: c.enPersonas }] as const
      } catch { return [r.id, null] as const }
    }))
    setResumen(Object.fromEntries(saldos))
    // Bolsa del Administrador (Caja principal): solo la propia; el SuperAdmin no tiene caja personal.
    setBolsa(user?.rol === 'admin' ? await getAdminAvailableCapital(tenantId, user.id).catch(() => null) : null)
    const movs = (await Promise.all(scopedRoutes.map(r => listCustodyMovements(r.id)))).flat()
      .filter(m => m.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    setCustodia(movs.slice(0, 15))
    setSaldosAt(new Date().toISOString())
    setLoading(false)
  }

  const routeNombre = (id: string) => routes.find(r => r.id === id)?.nombre ?? id
  const partnerName = (id?: string) => id ? (users.find(u => u.id === id)?.nombre ?? id) : undefined
  const userName = (id?: string) => id ? (users.find(u => u.id === id)?.nombre ?? '') : ''

  function originLabel(t: Transfer): string {
    if (t.socioOrigenId) return `Socio: ${partnerName(t.socioOrigenId)}`
    if (t.routeOrigenId) return `Ruta: ${officeFilter.labelFor(t.routeOrigenId)}`
    return 'Externo'
  }
  function destinoLabel(t: Transfer): string {
    if (t.socioDestinoId) return `Socio: ${partnerName(t.socioDestinoId)}`
    if (t.routeDestinoId) return `Ruta: ${officeFilter.labelFor(t.routeDestinoId)}`
    return 'Externo/Socio'
  }

  // Operaciones que el actor puede iniciar (mismas reglas que cada servicio). Hasta
  // saber qué modelo rige la empresa no se ofrece ninguna (nunca el circuito equivocado).
  const modo: TransferMode | undefined = central.activo
    ? { central: true, heredado: Object.fromEntries(routes.map(r => [r.id, Math.max(0, resumen[r.id]?.sinAsignar ?? 0)])) }
    : undefined
  const operaciones = central.listo ? availableOperations(user, routes, users, tenantId, modo) : []
  const opsDeRuta = (r: Route) => operationsOfMode(modo)
    .filter(k => operaciones.includes(k) && routesForOperation(k, user, [r], users, tenantId, modo).length > 0)

  // ---------- Operación con socio (sin cambios de reglas; sin nuevos accesos) ----------
  const rutasControladas = routes.filter(r => canOperateRouteCash(user, r, 'structural', users))
  const puedeSocios = can(user, 'transfer.create', { tenantId }) && partners.length > 0
  const endpointOptions = [
    ...partners.map(p => ({ value: encodeEndpoint('partner', p.id), label: `Socio ${p.nombre} · Caja socios` })),
    ...rutasControladas.map(r => ({ value: encodeEndpoint('route', r.id), label: `Ruta ${r.nombre} · caja sin asignar` })),
  ]
  // Origen y destino se excluyen entre sí, y al menos un extremo es un socio
  // (Ruta → Ruta va por el asistente, con su vista previa).
  const origenOptions = endpointOptions.filter(o => o.value !== form.destino)
  // Capital centralizado: ninguna ruta como destino (Socio → Ruta no existe; el aporte va a la bolsa).
  const destinoOptions = endpointOptions.filter(o => o.value !== form.origen)
    .filter(o => !(central.activo && o.value.startsWith('route:')))
  const origenSel = decodeEndpoint(form.origen)
  const destinoSel = decodeEndpoint(form.destino)
  const origenDisponible = origenSel?.type === 'route' ? resumen[origenSel.id]?.disponible ?? null : null
  const superaDisponible = origenDisponible != null && form.valor > origenDisponible

  async function guardarSocio() {
    if (!origenSel || !destinoSel) { toast.error('Selecciona origen y destino'); return }
    if (origenSel.type !== 'partner' && destinoSel.type !== 'partner') { toast.error('Entre rutas usa «Nueva operación» → Transferir entre rutas.'); return }
    if (form.valor <= 0) { toast.error('El valor debe ser mayor a 0'); return }
    if (form.origen === form.destino) { toast.error('Origen y destino no pueden ser iguales'); return }
    if (superaDisponible) { toast.error(`El valor supera el disponible de la ruta origen (${money(origenDisponible ?? 0)}).`); return }
    setSaving(true)
    try {
      // El servicio valida alcance, Oficina activa, responsable y fondos de la ruta origen.
      const r = await registerTransfer({ actor: user, tenantId, origen: origenSel, destino: destinoSel, valor: form.valor, descripcion: form.descripcion, fecha: form.fecha, operationId: socioOpId })
      toast.success(`Transferencia registrada · Ref. ${r.transfer.id.slice(0, 8).toUpperCase()}`)
      setSocioOpen(false)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  // ---------- Aporte de socio a la bolsa (capital centralizado) ----------
  async function guardarAporte() {
    if (!aporte.partnerId || !aporte.routeId || aporte.valor <= 0) { toast.error('Socio, ruta y valor son obligatorios'); return }
    setSaving(true)
    try {
      // Alcance, responsable, empresa y fecha: en el servicio.
      const r = await registerPartnerContribution({ actor: user, tenantId, partnerId: aporte.partnerId, routeId: aporte.routeId, amount: aporte.valor, descripcion: aporte.descripcion, fecha: aporte.fecha, operationId: aporteOpId })
      toast.success(`Aporte registrado en tu bolsa · Ref. ${r.entry.id.slice(0, 8).toUpperCase()}`)
      setAporteOpen(false)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  // ---------- Historial agrupado ----------
  const enFiltroDeOficina = (t: Transfer): boolean => {
    if (!officeFilter.hasOfficeFilter && !officeFilter.routeId) return true
    const extremos = [t.routeOrigenId, t.routeDestinoId].filter(Boolean) as string[]
    return extremos.some(id => officeFilter.visibleRouteIds.has(id))
  }
  const visibleTransfers = transfers.filter(t => enFiltroDeOficina(t) && (!desde || t.fecha >= desde) && (!hasta || t.fecha <= hasta))
  const groups: EntityGroup[] = (() => {
    const build = (type: TransferEntityType, id: string, nombre: string): EntityGroup => {
      const t = transferTotalsFor(visibleTransfers, type, id)
      return { key: encodeEndpoint(type, id), type, id, nombre, entrante: t.entrante, saliente: t.saliente, neto: t.neto, cantidad: t.cantidad, ultimoMovimiento: t.transfers[0]?.fecha, transfers: t.transfers }
    }
    return [...routes.map(r => build('route', r.id, r.nombre)), ...partners.map(p => build('partner', p.id, p.nombre))]
  })()
  const detailGroup = detailKey ? groups.find(g => g.key === detailKey) ?? null : null
  const filteredGroups = groups.filter(g => (tipoFiltro === 'all' || g.type === tipoFiltro) && (!search || g.nombre.toLowerCase().includes(search.toLowerCase())))
  const rutasVisibles = routes.filter(r => officeFilter.visibleRouteIds.has(r.id))

  async function handleReverse(reason: string) {
    if (!reversing) return
    await reverseTransfer({ actor: user, tenantId, movementId: reversing.id, reason })
    toast.success('Transferencia anulada')
    setReversing(null)
    await load()
  }

  const etiquetaCustodia = (m: CashCustodyMovement) =>
    m.origen === 'admin-pool' && m.tipo === 'BASE_ASSIGNMENT' ? `${m.reversesId ? 'Anulación de entrega' : 'Entrega de capital'} · bolsa → ${userName(m.toUserId)} (${routeNombre(m.routeId)})`
      : m.origen === 'admin-pool' && m.tipo === 'BASE_RETURN' ? `${m.reversesId ? 'Anulación de entrega' : 'Devolución de capital'} · ${userName(m.fromUserId)} → bolsa (${routeNombre(m.routeId)})`
      : m.tipo === 'BASE_ASSIGNMENT' ? `Entrega de Base · caja de ${routeNombre(m.routeId)} → ${userName(m.toUserId)}`
      : m.tipo === 'BASE_RETURN' ? `Devolución · ${userName(m.fromUserId)} → caja de ${routeNombre(m.routeId)}`
        : `Traspaso · ${userName(m.fromUserId)} → ${userName(m.toUserId)} (${routeNombre(m.routeId)})`

  const sumaRutas = (k: keyof RouteSummary) => rutasVisibles.reduce((s, r) => s + (resumen[r.id]?.[k] ?? 0), 0)
  const heredadoTotal = rutasVisibles.reduce((s, r) => s + Math.max(0, resumen[r.id]?.sinAsignar ?? 0), 0)

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
          <p className="text-sm text-gray-500 mt-0.5">{central.activo
            ? 'Capital centralizado: entregas capital de tu bolsa a los trabajadores de tus rutas y recibes sus devoluciones. Las rutas ya no tienen caja propia.'
            : 'Mover efectivo entre la caja de tus rutas, sus trabajadores y tu bolsa. Cada operación usa su registro de siempre.'}</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {user?.rol === 'admin' && (
            <Link to="/admin/capital" className="inline-flex items-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 shadow-sm">
              <Wallet className="w-4 h-4" /> Caja principal
            </Link>
          )}
          {operaciones.length > 0 && <Button onClick={() => setWizard({})} icon={<Plus className="w-4 h-4" />}>Nueva operación</Button>}
        </div>
      </div>

      {!loading && operaciones.length === 0 && (
        <p className="flex items-start gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-testid="transfers-readonly">
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
          {user?.rol === 'superadmin'
            ? 'Consulta: el SuperAdmin asigna capital a los Administradores (Capital). El efectivo de cada ruta solo lo mueve su Administrador responsable de capital.'
            : 'Consulta: no eres el Administrador responsable de capital de ninguna de estas rutas. Solo su responsable puede mover su efectivo.'}
        </p>
      )}

      {/* ---------- OPERACIONES (solo las autorizadas) ---------- */}
      {operaciones.length > 0 && (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" data-testid="op-categories">
          {transferCategories(modo).filter(c => c.kinds.some(k => operaciones.includes(k))).map(c => (
            <button key={c.categoria} type="button" onClick={() => setWizard(c.kinds.filter(k => operaciones.includes(k)).length === 1 ? { kind: c.kinds.find(k => operaciones.includes(k)) } : {})}
              className="text-left rounded-2xl border border-gray-100 bg-white shadow-card p-4 hover:border-primary-300 focus:outline-none focus:ring-2 focus:ring-primary-500">
              <span className="block text-sm font-semibold text-gray-900">{c.titulo}</span>
              <span className="block text-xs text-gray-500 mt-1">{c.ayuda}</span>
            </button>
          ))}
          <a href="#historial" className="rounded-2xl border border-gray-100 bg-white shadow-card p-4 hover:border-primary-300">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900"><History className="w-4 h-4 text-gray-400" />Consultar movimientos</span>
            <span className="block text-xs text-gray-500 mt-1">Transferencias, entregas y devoluciones registradas.</span>
          </a>
        </section>
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

      {/* ---------- RESUMEN: bolsa, cajas de ruta y efectivo en manos de trabajadores (separados) ---------- */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="transfers-summary">
        {user?.rol === 'admin' && (
          <div className="rounded-2xl bg-primary-50 border border-primary-100 p-4">
            <p className="text-xs text-gray-600">Mi bolsa (Caja principal)</p>
            <p className="text-lg font-bold text-primary-700" data-testid="summary-pool">{bolsa == null ? 'No disponible' : money(bolsa)}</p>
            <p className="text-[11px] text-gray-500">{central.activo ? 'Para entregar capital a tus trabajadores o pagar gastos.' : 'Para distribuir a tus rutas o pagar gastos administrativos.'}</p>
          </div>
        )}
        {central.activo ? (
          <div className="rounded-2xl bg-white border border-gray-100 shadow-card p-4">
            <p className="text-xs text-gray-600">Saldo heredado de cajas de ruta</p>
            <p className="text-lg font-bold text-gray-900" data-testid="summary-heritage">{money(heredadoTotal)}</p>
            <p className="text-[11px] text-gray-500">Lo que quedó en la antigua caja de {rutasVisibles.length} ruta(s). Solo puede bajar.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-white border border-gray-100 shadow-card p-4">
            <p className="text-xs text-gray-600">Disponible en cajas de ruta</p>
            <p className="text-lg font-bold text-gray-900" data-testid="summary-routes">{money(sumaRutas('disponible'))}</p>
            <p className="text-[11px] text-gray-500">{rutasVisibles.length} ruta(s) en tu alcance. Caja sin asignar, acotada por la Base.</p>
          </div>
        )}
        <div className="rounded-2xl bg-white border border-gray-100 shadow-card p-4">
          <p className="text-xs text-gray-600">En manos de trabajadores</p>
          <p className="text-lg font-bold text-gray-900" data-testid="summary-workers">{money(sumaRutas('enTrabajadores'))}</p>
          <p className="text-[11px] text-gray-500">Base entregada y recaudo aún no cuadrado. No se mueve desde la caja.</p>
        </div>
      </section>

      {/* ---------- CAJAS DE RUTA ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">{central.activo ? 'Rutas' : 'Cajas de ruta'}</h2>
        {loading ? (
          <div className="flex justify-center py-10"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : rutasVisibles.length === 0 ? (
          <EmptyState icon={<MapPin className="w-8 h-8" />} title="No hay rutas en tu alcance" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {rutasVisibles.map(r => {
              const s = resumen[r.id]
              const ops = opsDeRuta(r)
              const neto = groups.find(g => g.key === encodeEndpoint('route', r.id))?.neto ?? 0
              return (
                <div key={r.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-3" data-testid={`route-card-${r.id}`}>
                  <div className="flex items-start gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-primary-100 flex items-center justify-center flex-shrink-0"><MapPin className="w-4 h-4 text-primary-600" /></div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{r.nombre}</p>
                      <CapitalControllerBadge className="block mt-0.5" route={r} users={users} currentUserId={user?.id} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {central.activo ? (
                      <div className="bg-primary-50 rounded-xl p-2.5" data-testid="route-heritage">
                        <p className="text-xs text-gray-600">Saldo heredado</p>
                        <p className="text-sm font-bold text-primary-700">{s == null ? 'No disponible' : money(s.sinAsignar)}</p>
                      </div>
                    ) : (
                      <div className="bg-primary-50 rounded-xl p-2.5" data-testid="route-available">
                        <p className="text-xs text-gray-600">Disponible para mover</p>
                        <p className="text-sm font-bold text-primary-700">{s == null ? 'No disponible' : money(s.disponible)}</p>
                      </div>
                    )}
                    <div className="bg-gray-50 rounded-xl p-2.5">
                      <p className="text-xs text-gray-600">En manos de trabajadores</p>
                      <p className="text-sm font-bold text-gray-800">{s == null ? 'No disponible' : money(s.enTrabajadores)}</p>
                    </div>
                  </div>
                  {central.bloqueos[r.id] && <p className="text-[11px] font-medium text-amber-700" data-testid="route-blocked">Bloqueada para capital nuevo hasta que el SuperAdmin la revise.</p>}
                  <p className="text-[11px] text-gray-400">Neto de transferencias: {money(neto)} (entrante − saliente). No es el efectivo en caja.</p>
                  {ops.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {ops.map(k => (
                        <Button key={k} size="sm" variant={k === 'entregar-base' && !central.activo || k === 'entregar-capital' ? 'primary' : 'secondary'} onClick={() => setWizard({ kind: k, routeId: r.id })}>
                          {operationButtonLabel(k, modo)}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {saldosAt && <p className="text-[11px] text-gray-400">Saldos calculados {formatDateTime(saldosAt)}. Cada operación los vuelve a comprobar al registrar.</p>}
      </section>

      {/* ---------- OPERACIONES CON SOCIOS (existentes; sin nuevos accesos) ---------- */}
      {puedeSocios && central.activo && rutasControladas.length > 0 && (
        <section className="rounded-2xl border border-purple-200 bg-purple-50 p-4 space-y-2" data-testid="partner-contribution">
          <p className="flex items-center gap-2 text-sm font-semibold text-purple-900"><Users className="w-4 h-4" />Aporte de socio a mi bolsa</p>
          <p className="text-xs text-purple-900">El capital que un socio aporta para trabajar una ruta entra primero a tu bolsa (Caja principal). Desde ahí lo entregas a los trabajadores.</p>
          <Button size="sm" variant="secondary" onClick={() => { setAporte({ partnerId: '', routeId: rutasControladas.length === 1 ? rutasControladas[0].id : '', valor: 0, descripcion: '', fecha: today() }); setAporteOpId(generateId()); setAporteOpen(true) }}
            icon={<Plus className="w-4 h-4" />}>Registrar aporte de socio</Button>
        </section>
      )}

      {puedeSocios && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-2" data-testid="partner-ops">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900"><AlertTriangle className="w-4 h-4" />Operaciones con socios</p>
          <p className="text-xs text-amber-900">
            {central.activo
              ? 'Con capital centralizado solo quedan la salida desde el saldo heredado de una ruta hacia un socio y los movimientos entre socios. Pendiente de revisión (D1).'
              : 'Se conservan como estaban. Pendientes de revisión (D1): una salida Ruta → Socio no pasa por tu bolsa y un aporte Socio → Ruta no comprueba el saldo de Caja socios. Por eso no forman parte del asistente.'}
          </p>
          {/* ADEX Online: sin Caja socios en el servidor (D1): no disponible. */}
          <Button size="sm" variant="secondary" disabled onClick={() => { setForm({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today() }); setSocioOpId(generateId()); setSocioOpen(true) }}
            icon={<Users className="w-4 h-4" />}>Operación con socio</Button>
          <p className="text-xs font-medium text-amber-900" data-testid="partner-ops-unavailable">No disponible en ADEX Online: Caja socios no existe en el servidor hasta resolver D1.</p>
        </section>
      )}

      {/* ---------- HISTORIAL ---------- */}
      <section id="historial" className="space-y-4 scroll-mt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Historial</h2>
          <Link to="/admin/movements" className="text-sm text-primary-700 hover:underline" data-testid="go-history">Historial completo y comprobantes</Link>
        </div>
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 space-y-2" data-testid="custody-history">
          <p className="text-sm font-semibold text-gray-800">Entregas y devoluciones de Base recientes</p>
          {custodia.length === 0 ? <p className="text-sm text-gray-400">Sin movimientos de Base.</p> : (
            <div className="divide-y divide-gray-50">
              {custodia.map(m => (
                <div key={m.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 break-words">{etiquetaCustodia(m)}</p>
                    <p className="text-gray-500 break-words">{formatDateTime(m.createdAt)} · registró {userName(m.createdByUserId)} · {m.motivo} · Ref. {m.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <span className="font-semibold text-gray-800 whitespace-nowrap">{money(m.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {user?.rol === 'admin' && <p className="text-[11px] text-gray-400">Colocaciones y retiros de capital: en <Link className="text-primary-700 hover:underline" to="/admin/capital">Caja principal</Link> → Movimientos de la bolsa.</p>}
        </div>

        <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta} onClear={() => { setDesde(''); setHasta('') }}>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Buscar</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre..."
                className="h-9 w-full sm:w-48 rounded-lg border border-gray-300 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tipo</label>
            <select value={tipoFiltro} onChange={e => setTipoFiltro(e.target.value as 'all' | 'route' | 'partner')}
              className="h-9 rounded-lg border border-gray-300 pl-3 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
              <option value="all">Todas</option>
              <option value="route">Rutas</option>
              <option value="partner">Socios</option>
            </select>
          </div>
        </DateRangeFilter>

        {filteredGroups.length === 0 ? (
          <EmptyState icon={<ArrowLeftRight className="w-8 h-8" />} title="Sin transferencias" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredGroups.map(g => (
              <div key={g.key} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${g.type === 'route' ? 'bg-primary-100' : 'bg-purple-100'}`}>
                      {g.type === 'route' ? <MapPin className="w-4 h-4 text-primary-600" /> : <Users className="w-4 h-4 text-purple-600" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{g.nombre}</p>
                      <Badge variant={g.type === 'route' ? 'info' : 'purple'} size="sm">{g.type === 'route' ? 'Ruta' : 'Socio'}</Badge>
                    </div>
                  </div>
                  <span className="text-xs text-gray-400">{g.cantidad} mov.</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="bg-emerald-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Entrante</p><p className="text-sm font-bold text-emerald-600">{money(g.entrante)}</p></div>
                  <div className="bg-amber-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Saliente</p><p className="text-sm font-bold text-amber-600">{money(g.saliente)}</p></div>
                </div>
                <div className="mt-2 bg-gray-50 rounded-xl p-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0"><p className="text-xs text-gray-500">Neto de transferencias</p><p className="text-[11px] text-gray-400">Entrante − saliente. No es el efectivo en caja.</p></div>
                  <p className={`text-sm font-bold ${g.neto >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{money(g.neto)}</p>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <p className="text-xs text-gray-400">{g.ultimoMovimiento ? `Último: ${formatDate(g.ultimoMovimiento)}` : 'Sin movimientos'}</p>
                  <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailKey(g.key)} icon={<ChevronRight className="w-3.5 h-3.5" />}>Ver movimientos</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Asistente: cada operación con su servicio existente */}
      <OperationWizard open={!!wizard} onClose={() => setWizard(null)} onDone={() => { void load() }}
        routes={routes} users={users} inicial={wizard ?? undefined} modo={modo} />

      {/* Aporte de socio a la bolsa del responsable (capital centralizado) */}
      <Modal open={aporteOpen} onClose={() => { if (!saving) setAporteOpen(false) }} title="Aporte de socio a mi bolsa"
        footer={<><Button variant="secondary" onClick={() => setAporteOpen(false)}>Cancelar</Button><Button onClick={guardarAporte} loading={saving}>Registrar aporte</Button></>}>
        <div className="space-y-4" data-testid="partner-contribution-form">
          <p className="text-xs text-purple-800 bg-purple-50 border border-purple-100 rounded-xl px-3 py-2">Entra a tu bolsa, no a la ruta ni a un trabajador. Queda también en Caja socios como salida del socio.</p>
          <Select label="Socio" value={aporte.partnerId} onChange={e => setAporte(a => ({ ...a, partnerId: e.target.value }))} required placeholder="Seleccionar socio"
            options={partners.map(p => ({ value: p.id, label: p.nombre }))} />
          <Select label="Ruta que el aporte va a operar" value={aporte.routeId} onChange={e => setAporte(a => ({ ...a, routeId: e.target.value }))} required placeholder="Seleccionar ruta"
            options={rutasControladas.map(r => ({ value: r.id, label: r.nombre }))} hint="Solo rutas de las que eres responsable de capital." />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={aporte.valor} onValueChange={v => setAporte(a => ({ ...a, valor: v }))} required />
            <Input label="Fecha" type="date" value={aporte.fecha} onChange={e => setAporte(a => ({ ...a, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={aporte.descripcion} onChange={e => setAporte(a => ({ ...a, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Operación con socio (formulario y reglas existentes) */}
      <Modal open={socioOpen} onClose={() => { if (!saving) setSocioOpen(false) }} title="Operación con socio"
        footer={<><Button variant="secondary" onClick={() => setSocioOpen(false)}>Cancelar</Button><Button onClick={guardarSocio} loading={saving} disabled={superaDisponible}>Registrar</Button></>}>
        <div className="space-y-4">
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">{central.activo
            ? 'Al menos un extremo es un socio. Una ruta solo puede ser origen y por su saldo heredado.'
            : 'Al menos un extremo es un socio; se registra también en Caja socios. Entre rutas usa el asistente.'}</p>
          <div className="grid grid-cols-1 gap-3">
            <Select label="Origen (sale de)" value={form.origen} onChange={e => setForm(f => ({ ...f, origen: e.target.value }))} options={origenOptions} placeholder="Seleccionar origen" required />
            <Select label="Destino (llega a)" value={form.destino} onChange={e => setForm(f => ({ ...f, destino: e.target.value }))} options={destinoOptions} placeholder="Seleccionar destino" required />
          </div>
          {origenSel?.type === 'route' && (
            <p className="text-xs text-gray-600" data-testid="partner-origin-available">Disponible de la ruta origen: <b>{origenDisponible == null ? 'No disponible' : money(origenDisponible)}</b>{superaDisponible && <span className="text-red-600"> · Insuficiente</span>}</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de movimientos de una entidad */}
      <Modal open={!!detailGroup} onClose={() => setDetailKey(null)} title={detailGroup ? `Movimientos · ${detailGroup.nombre}` : 'Movimientos'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailKey(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3"><p className="text-xs text-gray-400">Entrante</p><p className="font-bold text-emerald-600">{money(detailGroup.entrante)}</p></div>
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Saliente</p><p className="font-bold text-amber-600">{money(detailGroup.saliente)}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Neto</p><p className="font-bold text-gray-800">{money(detailGroup.neto)}</p></div>
            </div>
            {detailGroup.transfers.length === 0 ? (
              <div className="flex justify-center py-8 text-gray-400 text-sm">Sin movimientos</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                {pairReversals(detailGroup.transfers).map(({ movement: t, reversal }) => {
                  const entrada = detailGroup.type === 'route' ? t.routeDestinoId === detailGroup.id : t.socioDestinoId === detailGroup.id
                  const estado = reversalStateOf(t)
                  const signo = entrada ? 1 : -1
                  return (
                    <div key={t.id}>
                      <div className="flex items-center justify-between gap-2 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0"><ArrowLeftRight className="w-4 h-4 text-blue-500" /></div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                              {estado === 'reversion' ? 'Reversión · ' : ''}{originLabel(t)} → {destinoLabel(t)}
                              {estado === 'anulado' && <AnnulledBadge />}
                            </p>
                            <p className="text-xs text-gray-400">{formatDate(t.fecha)}{userName(t.userId) ? ` · ${userName(t.userId)}` : ''}{t.descripcion ? ` · ${t.descripcion}` : ''} · Ref. {t.id.slice(0, 8).toUpperCase()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {canReverseTransfer(user, t, partnerRouteIds, routes, users) && <ReverseButton onClick={() => setReversing(t)} />}
                          <span className={`text-sm font-bold ${estado === 'anulado' ? 'text-gray-400 line-through' : signo * t.valor >= 0 ? 'text-emerald-600' : 'text-amber-600'}`}>{signedMoney(signo * t.valor, currency)}</span>
                        </div>
                      </div>
                      {estado === 'anulado' && <ReversalDetail original={t} reversal={reversal} currency={currency} signo={signo} userName={userName} />}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ReverseMovementModal currency={currency} onCancel={() => setReversing(null)} onConfirm={handleReverse}
        target={reversing && { tipo: 'Transferencia', valor: reversing.valor, fecha: reversing.fecha, detalle: `${originLabel(reversing)} → ${destinoLabel(reversing)}` }} />
    </div>
  )
}
