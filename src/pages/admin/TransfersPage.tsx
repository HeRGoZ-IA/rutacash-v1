import { useState, useEffect } from 'react'
import { Plus, ArrowLeftRight, ArrowRightLeft, ChevronRight, MapPin, Users, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
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
import { pairReversals, reversalStateOf } from '@/lib/movementReversal'
import { transferTotalsFor } from '@/lib/transferTotals'
import { AnnulledBadge, ReversalDetail, ReverseButton, ReverseMovementModal, signedMoney } from '@/components/ui/MovementReversal'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import { can, filterAccessibleRoutes, authorizedRouteIdsOf, isPartnerInScope, isTransferInScope } from '@/lib/permissions'
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
  const navigate = useNavigate()
  // Punto 6: mover efectivo ENTRE TRABAJADORES de una misma ruta no es una
  // Transferencia (Ruta→Ruta exige rutas distintas). Vive en el cuadre por
  // trabajador; aquí solo se ofrece el acceso.
  const puedeTraspasar = can(user, 'cashCustody.manage', { tenantId: user?.tenantId })
  const irATraspaso = () => navigate('/admin/weekly-settlement?vista=trabajadores')
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

  // Opciones del selector origen/destino: rutas y socios diferenciados.
  const endpointOptions = [
    ...routes.map(r => ({ value: encodeEndpoint('route', r.id), label: `Ruta: ${r.nombre}` })),
    ...partners.map(p => ({ value: encodeEndpoint('partner', p.id), label: `Socio: ${p.nombre}` })),
  ]

  async function handleSave() {
    const origen = decodeEndpoint(form.origen)
    const destino = decodeEndpoint(form.destino)
    if (!origen) { toast.error('Selecciona el origen'); return }
    if (!destino) { toast.error('Selecciona el destino'); return }
    if (form.valor <= 0) { toast.error('El valor debe ser mayor a 0'); return }
    if (form.origen === form.destino) {
      toast.error(origen.type === 'route' && puedeTraspasar
        ? 'Origen y destino no pueden ser iguales. Para mover efectivo entre trabajadores de la misma ruta usa «Traspaso entre trabajadores».'
        : 'Origen y destino no pueden ser iguales')
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Transferencias</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleTransfers.length} transferencia(s) · {routes.length} ruta(s) · {partners.length} socio(s)</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {puedeTraspasar && (
            <Button variant="secondary" onClick={irATraspaso} icon={<ArrowRightLeft className="w-4 h-4" />}>Traspaso entre trabajadores</Button>
          )}
          <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva transferencia</Button>
        </div>
      </div>

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
              <div className="mt-2 bg-gray-50 rounded-xl p-2.5 flex items-center justify-between">
                <p className="text-xs text-gray-400">Saldo neto</p>
                <p className={`text-sm font-bold ${g.neto >= 0 ? 'text-gray-800' : 'text-red-600'}`}>{formatCurrency(g.neto, currency)}</p>
              </div>

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
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nueva transferencia"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Origen" value={form.origen} onChange={e => setForm(f => ({ ...f, origen: e.target.value }))}
              options={endpointOptions} placeholder="Seleccionar origen" required />
            <Select label="Destino" value={form.destino} onChange={e => setForm(f => ({ ...f, destino: e.target.value, entregarA: '' }))}
              options={endpointOptions} placeholder="Seleccionar destino" required />
          </div>
          {destinoRuta && (
            <Select label="Entregar en mano a (opcional)" value={form.entregarA} onChange={e => setForm(f => ({ ...f, entregarA: e.target.value }))}
              options={receptores.map(u => ({ value: u.id, label: `${u.nombre} · ${u.rol === 'supervisor' ? 'Supervisor' : 'Cobrador'}` }))}
              placeholder="No: queda en la caja de la ruta" />
          )}
          <p className="text-xs text-gray-400">Puedes transferir entre rutas y socios. Si participa un socio, se registra automáticamente en Caja socios.</p>
          <div className="grid grid-cols-2 gap-3">
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
                          {canReverseTransfer(user, t, partnerRouteIds) && <ReverseButton onClick={() => setReversing(t)} />}
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
