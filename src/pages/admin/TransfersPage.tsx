import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ArrowLeftRight, ChevronRight, MapPin, Users, Search, Wallet, Info } from 'lucide-react'
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
import { registerTransfer, getRouteAvailableFunds } from '@/services/routeFundsService'
import { canReverseTransfer, reverseTransfer } from '@/services/movementReversalService'
import { pairReversals, reversalStateOf } from '@/lib/movementReversal'
import { transferTotalsFor } from '@/lib/transferTotals'
import { AnnulledBadge, ReversalDetail, ReverseButton, ReverseMovementModal, signedMoney } from '@/components/ui/MovementReversal'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, formatDateTime, today, nowISO } from '@/lib/formatters'
import { can, canOperateRouteCash, filterAccessibleRoutes, authorizedRouteIdsOf, isPartnerInScope, isTransferInScope } from '@/lib/permissions'
import { CapitalControllerBadge } from '@/components/ui/CapitalControllerBadge'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import type { Transfer, Route, User, TransferEntityType } from '@/models/types'

// Entidad participante (ruta o socio) para la vista agrupada (Revisión 2).
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

// Un endpoint (origen o destino) codificado como `route:<id>` / `partner:<id>`.
function encodeEndpoint(type: TransferEntityType, id: string) { return `${type}:${id}` }
function decodeEndpoint(v: string): { type: TransferEntityType; id: string } | null {
  const [type, id] = v.split(':')
  if ((type === 'route' || type === 'partner') && id) return { type, id }
  return null
}

export default function TransfersPage() {
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  // El traspaso de efectivo ENTRE TRABAJADORES de una misma ruta no es una
  // Transferencia: vive en Liquidación → Cuadre por trabajador
  // (`transferBaseBetweenWorkers`). El antiguo botón "Traspaso entre trabajadores"
  // de esta pantalla solo navegaba allí y anunciaba una operación que no ocurría
  // aquí; se retiró (2026-10-07) y NO vuelve. Lo que sí ofrece esta pantalla (Ronda
  // 1/6) es la guía «Entregar Base a un trabajador»: explica que la entrega desde la
  // caja de la ruta es custodia y lleva al botón «Entregar Base» del cuadre con ruta y
  // trabajador elegidos. No registra nada aquí.
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [partners, setPartners] = useState<User[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // Clave de la entidad abierta: el detalle se DERIVA de los datos recargados
  // (tras anular, el modal se actualiza sin cerrarse).
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [reversing, setReversing] = useState<Transfer | null>(null)
  // Filtros
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [tipoFiltro, setTipoFiltro] = useState<'all' | 'route' | 'partner'>('all')
  const [search, setSearch] = useState('')
  // Origen/destino codificados como `route:id` / `partner:id`
  const [form, setForm] = useState({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today(), entregarA: '' })
  /**
   * DOS OPERACIONES DISTINTAS EN EL MISMO MODAL (Ronda 1/6, 2026-10-11):
   *  · 'transferencia' → entre LIBROS (ruta ↔ ruta, ruta ↔ socio). `registerTransfer`.
   *  · 'base'          → caja sin asignar de una ruta → un trabajador de ESA ruta. No
   *    es una Transferencia (Ruta X → Ruta X sigue rechazada): es «Entregar Base»
   *    (`assignBaseToWorker`), que vive en Liquidación → Cuadre por trabajador. Aquí
   *    solo se explica y se lleva allí con ruta y trabajador preseleccionados; esta
   *    pantalla NO registra la entrega.
   */
  const [modo, setModo] = useState<'transferencia' | 'base'>('transferencia')
  const [base, setBase] = useState({ routeId: '', userId: '' })
  /**
   * DISPONIBLE PARA TRANSFERIR por ruta: MISMA fuente que Retiros y Capital
   * (`getRouteAvailableFunds` = conciliación `disponible` = caja sin asignar,
   * acotada por la Base). `null` = no se pudo calcular: se dice, no se inventa.
   * Es una foto (`saldosAt`); el servicio revalida al registrar.
   */
  const [disponibles, setDisponibles] = useState<Record<string, number | null>>({})
  const [saldosAt, setSaldosAt] = useState('')

  // Reactiva: otra pestaña del mismo navegador registra y esta vista se entera sin F5.
  const revision = useDataRevision()
  useEffect(() => { load() }, [tenantId, user, revision])

  // Rutas del socio (relación socio↔ruta) para decidir alcance de transferencias/caja socios.
  const partnerRouteIds = (socioId: string) => authorizedRouteIdsOf(users.find(u => u.id === socioId))

  async function load() {
    setLoading(true)
    const [ts, rts, us] = await Promise.all([
      db.transfers.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: rutas autorizadas, socios vinculados a ellas y
    // transferencias cuyas DOS entidades están en alcance (antes de agregar).
    const socioRoute = (id: string) => authorizedRouteIdsOf(us.find(u => u.id === id))
    const scopedRoutes = filterAccessibleRoutes(user, rts)
    const scopedPartners = us.filter(u => u.rol === 'socio' && isPartnerInScope(user, authorizedRouteIdsOf(u)))
    const scopedTransfers = ts.filter(t => isTransferInScope(user, t, socioRoute))
    setTransfers(scopedTransfers.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(scopedRoutes)
    setUsers(us)
    setPartners(scopedPartners)
    // Solo rutas en alcance (las mismas que ya se listan): nunca rutas ajenas.
    const saldos = await Promise.all(scopedRoutes.map(r =>
      getRouteAvailableFunds(tenantId, r.id).then(v => [r.id, v] as const, () => [r.id, null] as const)))
    setDisponibles(Object.fromEntries(saldos))
    setSaldosAt(nowISO())
    setLoading(false)
  }

  const routeName = (id?: string) => id ? (routes.find(r => r.id === id)?.nombre ?? id) : undefined
  const partnerName = (id?: string) => id ? (users.find(u => u.id === id)?.nombre ?? id) : undefined
  const userName = (id?: string) => id ? (users.find(u => u.id === id)?.nombre ?? '') : ''

  // Etiqueta de un endpoint de la transferencia (origen/destino).
  // La Oficina de cada extremo se DERIVA de su `routeId`; la transferencia no
  // guarda officeId (y no debe guardarlo: una ruta puede cambiar de Oficina).
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

  // Entrega en mano: solo personas elegibles de la ruta destino (misma regla que el servicio).
  const destinoRuta = decodeEndpoint(form.destino)?.type === 'route' ? decodeEndpoint(form.destino)!.id : ''
  const receptores = destinoRuta ? users.filter(u => !custodianBlockedReason(u, destinoRuta, tenantId)) : []

  // v16: una ruta solo puede ser origen o destino si el actor es su Administrador
  // responsable de capital (la caja de la ruta tiene UN responsable). Ruta → Ruta
  // solo entre rutas del mismo responsable: lo garantiza ofrecer solo las propias.
  const rutasControladas = routes.filter(r => canOperateRouteCash(user, r, 'structural', users))

  // Opciones del selector origen/destino: cada una nombra la CUENTA que se mueve.
  const endpointOptions = [
    ...rutasControladas.map(r => ({ value: encodeEndpoint('route', r.id), label: `Ruta ${r.nombre} · caja sin asignar` })),
    ...partners.map(p => ({ value: encodeEndpoint('partner', p.id), label: `Socio ${p.nombre} · Caja socios` })),
  ]
  // Origen y destino se excluyen entre sí: Ruta X → Ruta X no se puede elegir. Dar
  // efectivo de la caja de una ruta a su cobrador es «Entregar Base» (modo 'base').
  const origenOptions = endpointOptions.filter(o => o.value !== form.destino)
  const destinoOptions = endpointOptions.filter(o => o.value !== form.origen)

  const origenSel = decodeEndpoint(form.origen)
  const destinoSel = decodeEndpoint(form.destino)
  const routeNombre = (id: string) => routes.find(r => r.id === id)?.nombre ?? id
  /** Disponible conocido de una ruta: número, o `null` si no pudo calcularse. */
  const disponibleDe = (routeId: string): number | null => disponibles[routeId] ?? null
  const origenDisponible = origenSel?.type === 'route' ? disponibleDe(origenSel.id) : null
  // Vista previa: el origen pierde exactamente el valor (mismo término en Base y en
  // caja sin asignar). Solo se muestra si el disponible es conocido.
  const origenDespues = origenDisponible != null ? origenDisponible - form.valor : null
  const superaDisponible = origenDisponible != null && form.valor > origenDisponible
  const receptorSel = users.find(u => u.id === form.entregarA)

  // ENTREGAR BASE: rutas cuya caja maneja el actor (responsable de capital) y en las
  // que tiene `cashCustody.manage` — la misma regla que el botón del cuadre.
  const rutasBase = rutasControladas.filter(r => can(user, 'cashCustody.manage', { routeId: r.id, tenantId }))
  const trabajadoresBase = base.routeId ? users.filter(u => !custodianBlockedReason(u, base.routeId, tenantId)) : []
  const baseDisponible = base.routeId ? disponibleDe(base.routeId) : null
  const enlaceBase = base.routeId && base.userId
    ? `/admin/weekly-settlement?vista=trabajadores&routeId=${encodeURIComponent(base.routeId)}&userId=${encodeURIComponent(base.userId)}&accion=entregar-base`
    : ''
  const nombreTrabajador = (u: User) => `${u.nombre} · ${u.rol === 'supervisor' ? 'Supervisor' : 'Cobrador'}`

  function abrir(m: 'transferencia' | 'base', routeId = '') {
    setModo(m)
    if (m === 'base') {
      // Solo se preselecciona una ruta en la que el actor puede entregar Base.
      const valida = rutasBase.some(r => r.id === routeId) ? routeId : rutasBase.length === 1 ? rutasBase[0].id : ''
      setBase({ routeId: valida, userId: '' })
    }
    setModalOpen(true)
  }

  async function handleSave() {
    const origen = decodeEndpoint(form.origen)
    const destino = decodeEndpoint(form.destino)
    if (!origen) { toast.error('Selecciona el origen'); return }
    if (!destino) { toast.error('Selecciona el destino'); return }
    if (form.valor <= 0) { toast.error('El valor debe ser mayor a 0'); return }
    if (form.origen === form.destino) {
      toast.error(origen.type === 'route'
        ? 'Origen y destino no pueden ser la misma ruta. Para dar efectivo de la caja de una ruta a su cobrador usa «Entregar Base a un trabajador».'
        : 'Origen y destino no pueden ser iguales')
      return
    }
    if (superaDisponible) {
      toast.error(`El valor supera el disponible de la ruta origen (${formatCurrency(origenDisponible ?? 0, currency)}).`)
      return
    }
    setSaving(true)
    try {
      // Alcance, Oficina activa, fondos del origen, Caja socios y entrega en mano:
      // TODO en el servicio y en UNA transacción.
      await registerTransfer({
        actor: user, tenantId, origen, destino, valor: form.valor, descripcion: form.descripcion, fecha: form.fecha,
        entregarA: destino.type === 'route' && form.entregarA ? { userId: form.entregarA } : undefined,
      })
      toast.success('Transferencia registrada')
      setModalOpen(false)
      setForm({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today(), entregarA: '' })
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  // Transferencias dentro del rango de fecha (para totales y detalle).
  /**
   * Una transferencia entra en el filtro si ALGUNO de sus extremos de tipo ruta
   * está dentro. Las de socio a socio no tienen ruta: solo aparecen sin filtro de
   * Oficina, porque no pueden atribuirse a ninguna.
   */
  const enFiltroDeOficina = (t: Transfer): boolean => {
    if (!officeFilter.hasOfficeFilter && !officeFilter.routeId) return true
    const extremos = [t.routeOrigenId, t.routeDestinoId].filter(Boolean) as string[]
    return extremos.some(id => officeFilter.visibleRouteIds.has(id))
  }

  const visibleTransfers = transfers.filter(t =>
    enFiltroDeOficina(t) && (!desde || t.fecha >= desde) && (!hasta || t.fecha <= hasta)
  )

  // ---- Agrupación por entidad (rutas + socios) ----
  const groups: EntityGroup[] = (() => {
    // Totales = efecto VIGENTE (original anulado + su reversión suman 0).
    const build = (type: TransferEntityType, id: string, nombre: string): EntityGroup => {
      const t = transferTotalsFor(visibleTransfers, type, id)
      return {
        key: encodeEndpoint(type, id), type, id, nombre,
        entrante: t.entrante, saliente: t.saliente, neto: t.neto,
        cantidad: t.cantidad, ultimoMovimiento: t.transfers[0]?.fecha, transfers: t.transfers,
      }
    }
    const routeGroups = routes.map(r => build('route', r.id, r.nombre))
    const partnerGroups = partners.map(p => build('partner', p.id, p.nombre))
    return [...routeGroups, ...partnerGroups]
  })()

  const detailGroup = detailKey ? groups.find(g => g.key === detailKey) ?? null : null

  async function handleReverse(reason: string) {
    if (!reversing) return
    // Permiso, alcance, estado vigente, fondos y TODAS las patas: en el servicio, atómico.
    await reverseTransfer({ actor: user, tenantId, movementId: reversing.id, reason })
    toast.success('Transferencia anulada')
    setReversing(null)
    await load()
  }

  const filteredGroups = groups.filter(g => {
    if (tipoFiltro !== 'all' && g.type !== tipoFiltro) return false
    if (search && !g.nombre.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleTransfers.length} transferencia(s) · {routes.length} ruta(s) · {partners.length} socio(s)</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {rutasBase.length > 0 && (
            <Button variant="secondary" onClick={() => abrir('base')} icon={<Wallet className="w-4 h-4" />}>Entregar Base a un trabajador</Button>
          )}
          <Button onClick={() => abrir('transferencia')} icon={<Plus className="w-4 h-4" />}>Nueva transferencia</Button>
        </div>
      </div>

      {!loading && rutasControladas.length === 0 && (
        <p className="flex items-start gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-testid="transfers-readonly">
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
          {user?.rol === 'superadmin'
            ? 'Consulta: el SuperAdmin asigna capital a los Administradores (Capital). El efectivo de cada ruta solo lo transfiere su Administrador responsable de capital.'
            : 'Consulta: no eres el Administrador responsable de capital de ninguna de estas rutas. Solo su responsable puede transferir su efectivo.'}
        </p>
      )}

      {/* Filtros (compacto, una sola fila en desktop) */}
      {/* FILTRO OFICINA → RUTA (patrón compartido). Solo estrecha lo autorizado. */}
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

      <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta}
        onClear={() => { setDesde(''); setHasta('') }}>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Buscar</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre..."
              className="h-9 w-48 rounded-lg border border-gray-300 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
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

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filteredGroups.length === 0 ? (
        <EmptyState icon={<ArrowLeftRight className="w-8 h-8" />} title="No hay entidades" description="Crea rutas o socios para registrar transferencias." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredGroups.map(g => (
            <div key={g.key} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${g.type === 'route' ? 'bg-primary-100' : 'bg-purple-100'}`}>
                    {g.type === 'route' ? <MapPin className="w-4 h-4 text-primary-600" /> : <Users className="w-4 h-4 text-purple-600" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{g.nombre}</p>
                    <Badge variant={g.type === 'route' ? 'info' : 'purple'} size="sm">{g.type === 'route' ? 'Ruta' : 'Socio'}</Badge>
                    {g.type === 'route' && <CapitalControllerBadge className="block mt-1" route={routes.find(r => r.id === g.id)} users={users} currentUserId={user?.id} />}
                  </div>
                </div>
                <span className="text-xs text-gray-400">{g.cantidad} mov.</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div className="bg-emerald-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Entrante</p>
                  <p className="text-sm font-bold text-emerald-600">{formatCurrency(g.entrante, currency)}</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Saliente</p>
                  <p className="text-sm font-bold text-amber-600">{formatCurrency(g.saliente, currency)}</p>
                </div>
              </div>
              <div className="mt-2 bg-gray-50 rounded-xl p-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">Neto de transferencias</p>
                  <p className="text-[11px] text-gray-400">Entrante − saliente. No es el efectivo en caja.</p>
                </div>
                <p className={`text-sm font-bold ${g.neto >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{formatCurrency(g.neto, currency)}</p>
              </div>
              {g.type === 'route' && (
                <div className="mt-2 bg-primary-50 rounded-xl p-2.5 flex items-center justify-between gap-2" data-testid="route-available">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-600">Disponible para transferir</p>
                    <p className="text-[11px] text-gray-400">Caja sin asignar de la ruta (sin lo que tienen los trabajadores)</p>
                  </div>
                  <p className="text-sm font-bold text-primary-700">
                    {disponibleDe(g.id) == null ? 'No disponible' : formatCurrency(disponibleDe(g.id)!, currency)}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">{g.ultimoMovimiento ? `Último: ${formatDate(g.ultimoMovimiento)}` : 'Sin movimientos'}</p>
                <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailKey(g.key)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  Ver movimientos
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Nueva transferencia */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}
        title={modo === 'base' ? 'Entregar Base a un trabajador' : 'Nueva transferencia'}
        footer={modo === 'base'
          ? <>
              <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
              {enlaceBase
                ? <Link to={enlaceBase} data-testid="go-entregar-base"
                    className="inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-primary-600 hover:bg-primary-700 text-white shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1">
                    <Wallet className="w-4 h-4" /> Ir a «Entregar Base»
                  </Link>
                : <Button disabled icon={<Wallet className="w-4 h-4" />}>Ir a «Entregar Base»</Button>}
            </>
          : <><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving} disabled={superaDisponible}>Registrar</Button></>}>
        <div className="space-y-4">
          {/* ¿Qué operación es? Dos tipos distintos, nunca mezclados. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="tablist" aria-label="Tipo de operación">
            {([
              ['transferencia', 'Transferir entre rutas o socios', 'El dinero cambia de libro: sale de una cuenta y entra en otra.'],
              ['base', 'Entregar Base a un trabajador', 'De la caja de una ruta a un cobrador o supervisor de esa misma ruta.'],
            ] as const).map(([k, titulo, ayuda]) => (
              <button key={k} type="button" role="tab" aria-selected={modo === k}
                onClick={() => (k === 'base' ? abrir('base', origenSel?.type === 'route' ? origenSel.id : '') : setModo('transferencia'))}
                className={`text-left rounded-xl border px-3 py-2 transition-colors ${modo === k ? 'border-primary-500 bg-primary-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                <span className={`block text-sm font-semibold ${modo === k ? 'text-primary-700' : 'text-gray-800'}`}>{titulo}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{ayuda}</span>
              </button>
            ))}
          </div>

          {modo === 'transferencia' ? (<>
            <p className="text-xs text-gray-500">
              <b>Origen</b>: la cuenta de la que sale el dinero. <b>Destino</b>: la cuenta a la que llega. Solo ves tus rutas
              (de las que eres responsable de capital) y los socios de tus rutas. Si participa un socio, se registra también en Caja socios.
            </p>
            {/* Una columna: los nombres de cuenta («Ruta X · caja sin asignar») se leen completos. */}
            <div className="grid grid-cols-1 gap-3">
              <Select label="Origen (sale de)" value={form.origen} onChange={e => setForm(f => ({ ...f, origen: e.target.value }))}
                options={origenOptions} placeholder="Seleccionar origen" required />
              <Select label="Destino (llega a)" value={form.destino} onChange={e => setForm(f => ({ ...f, destino: e.target.value, entregarA: '' }))}
                options={destinoOptions} placeholder="Seleccionar destino" required />
            </div>
            {origenSel?.type === 'route' && rutasBase.some(r => r.id === origenSel.id) && (
              <button type="button" onClick={() => abrir('base', origenSel.id)}
                className="text-xs text-primary-700 hover:underline text-left">
                ¿Quieres dar efectivo de la caja de {routeNombre(origenSel.id)} a uno de sus cobradores? Eso no es una transferencia: es «Entregar Base» →
              </button>
            )}
            {destinoRuta && (
              <Select label={`¿Quién recibe el efectivo en ${routeNombre(destinoRuta)}? (opcional)`} value={form.entregarA}
                onChange={e => setForm(f => ({ ...f, entregarA: e.target.value }))}
                options={receptores.map(u => ({ value: u.id, label: nombreTrabajador(u) }))}
                placeholder={`Nadie: entra a la caja sin asignar de ${routeNombre(destinoRuta)}`}
                hint="Si eliges a alguien, el efectivo queda a su cargo en la ruta destino (entrega de Base enlazada a esta transferencia)." />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
              <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
            </div>

            {/* VISTA PREVIA: cifras del servicio, nunca calculadas aquí más allá de restar el valor. */}
            {(origenSel || destinoSel) && (
              <div className="rounded-xl border border-gray-100 divide-y divide-gray-50 text-sm" data-testid="transfer-preview">
                {origenSel?.type === 'route' && (
                  <div className="px-3 py-2 space-y-1">
                    <p className="text-xs font-semibold text-gray-700">Origen · Ruta {routeNombre(origenSel.id)} (caja sin asignar)</p>
                    {origenDisponible == null ? (
                      <p className="text-xs text-amber-700">No se pudo calcular el disponible. Al registrar, el sistema lo comprobará y rechazará el movimiento si no alcanza.</p>
                    ) : (<>
                      <div className="flex justify-between gap-2"><span className="text-gray-500">Disponible para transferir</span><b data-testid="origin-available">{formatCurrency(origenDisponible, currency)}</b></div>
                      <div className="flex justify-between gap-2"><span className="text-gray-500">Valor</span><span>− {formatCurrency(form.valor, currency)}</span></div>
                      <div className="flex justify-between gap-2">
                        <span className="text-gray-500">Disponible después</span>
                        <b className={superaDisponible ? 'text-red-600' : 'text-gray-900'} data-testid="origin-after">{superaDisponible ? 'Insuficiente' : formatCurrency(origenDespues!, currency)}</b>
                      </div>
                      {superaDisponible && <p className="text-xs text-red-600">El valor supera lo disponible. El efectivo en manos de los trabajadores no se puede transferir desde aquí.</p>}
                    </>)}
                  </div>
                )}
                {origenSel?.type === 'partner' && (
                  <div className="px-3 py-2">
                    <p className="text-xs font-semibold text-gray-700">Origen · Socio {partnerName(origenSel.id)}</p>
                    <p className="text-xs text-gray-500">Aporte de socio: esta operación no valida un saldo de Caja socios, así que no se muestra disponible.</p>
                  </div>
                )}
                {destinoSel?.type === 'route' && (
                  <div className="px-3 py-2 space-y-1">
                    <p className="text-xs font-semibold text-gray-700">Destino · Ruta {routeNombre(destinoSel.id)}</p>
                    <div className="flex justify-between gap-2"><span className="text-gray-500">Disponible actual</span><span>{disponibleDe(destinoSel.id) == null ? 'No disponible' : formatCurrency(disponibleDe(destinoSel.id)!, currency)}</span></div>
                    <p className="text-xs text-gray-500">
                      {receptorSel
                        ? `Recibe ${formatCurrency(form.valor, currency)}, que queda a cargo de ${receptorSel.nombre} (no en la caja sin asignar).`
                        : `Recibe ${formatCurrency(form.valor, currency)} en su caja sin asignar.`}
                    </p>
                  </div>
                )}
                {destinoSel?.type === 'partner' && (
                  <div className="px-3 py-2">
                    <p className="text-xs font-semibold text-gray-700">Destino · Socio {partnerName(destinoSel.id)}</p>
                    <p className="text-xs text-gray-500">Se registra como ingreso en su Caja socios.</p>
                  </div>
                )}
                {saldosAt && <p className="px-3 py-1.5 text-[11px] text-gray-400">Saldos calculados {formatDateTime(saldosAt)}. Se vuelven a comprobar al registrar.</p>}
              </div>
            )}
            <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
          </>) : (
            <div className="space-y-3" data-testid="base-guide">
              <p className="text-sm text-gray-700">
                Entregar efectivo de la caja de una ruta a un trabajador de <b>esa misma ruta</b> no es una transferencia: es una
                <b> entrega de Base</b>. El dinero no cambia de ruta; pasa de la caja sin asignar a estar a cargo del trabajador,
                y entra en su próximo cuadre.
              </p>
              {rutasBase.length === 0 ? (
                <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
                  Solo el Administrador responsable de capital de una ruta puede entregar su Base. No lo eres de ninguna ruta.
                </p>
              ) : (<>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select label="Ruta" value={base.routeId} onChange={e => setBase({ routeId: e.target.value, userId: '' })}
                    options={rutasBase.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" />
                  <Select label="Trabajador que recibe" value={base.userId} onChange={e => setBase(b => ({ ...b, userId: e.target.value }))}
                    options={trabajadoresBase.map(u => ({ value: u.id, label: nombreTrabajador(u) }))}
                    placeholder={!base.routeId ? 'Primero elige la ruta' : trabajadoresBase.length ? 'Seleccionar trabajador' : 'Sin trabajadores activos en la ruta'}
                    disabled={!base.routeId} />
                </div>
                {base.routeId && (
                  <div className="flex justify-between gap-2 rounded-xl bg-primary-50 px-3 py-2 text-sm">
                    <span className="text-gray-600">Disponible en la caja sin asignar de {routeNombre(base.routeId)}</span>
                    <b className="text-primary-700" data-testid="base-available">{baseDisponible == null ? 'No disponible' : formatCurrency(baseDisponible, currency)}</b>
                  </div>
                )}
                <ol className="text-xs text-gray-600 list-decimal pl-5 space-y-0.5">
                  <li>Pulsa <b>Ir a «Entregar Base»</b>: se abre Liquidación → <b>Cuadre por trabajador</b> con la ruta y el trabajador elegidos.</li>
                  <li>Allí pulsa el botón <b>«Entregar Base»</b>, escribe el valor y el motivo, y registra.</li>
                </ol>
              </>)}
            </div>
          )}
        </div>
      </Modal>

      {/* Detalle de movimientos de una entidad */}
      <Modal open={!!detailGroup} onClose={() => setDetailKey(null)} title={detailGroup ? `Movimientos · ${detailGroup.nombre}` : 'Movimientos'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailKey(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3"><p className="text-xs text-gray-400">Entrante</p><p className="font-bold text-emerald-600">{formatCurrency(detailGroup.entrante, currency)}</p></div>
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Saliente</p><p className="font-bold text-amber-600">{formatCurrency(detailGroup.saliente, currency)}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Neto</p><p className="font-bold text-gray-800">{formatCurrency(detailGroup.neto, currency)}</p></div>
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
                          <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
                            <ArrowLeftRight className="w-4 h-4 text-blue-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                              {estado === 'reversion' ? 'Reversión · ' : ''}{originLabel(t)} → {destinoLabel(t)}
                              {estado === 'anulado' && <AnnulledBadge />}
                            </p>
                            <p className="text-xs text-gray-400">{formatDate(t.fecha)}{userName(t.userId) ? ` · ${userName(t.userId)}` : ''}{t.descripcion ? ` · ${t.descripcion}` : ''}</p>
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
