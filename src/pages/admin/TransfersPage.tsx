import { useState, useEffect } from 'react'
import { Plus, ArrowLeftRight, ChevronRight, MapPin, Users, Search } from 'lucide-react'
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
import { createPartnerMovement } from '@/services/partnerCashService'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import { filterAccessibleRoutes, authorizedRouteIdsOf, isPartnerInScope, isTransferInScope } from '@/lib/permissions'
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
  const { tenantId, officeId, currency } = useTenant()
  const { user } = useAuth()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [partners, setPartners] = useState<User[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [detailGroup, setDetailGroup] = useState<EntityGroup | null>(null)
  // Filtros
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [tipoFiltro, setTipoFiltro] = useState<'all' | 'route' | 'partner'>('all')
  const [search, setSearch] = useState('')
  // Origen/destino codificados como `route:id` / `partner:id`
  const [form, setForm] = useState({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today() })

  useEffect(() => { load() }, [tenantId, user])

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
  function originLabel(t: Transfer): string {
    if (t.socioOrigenId) return `Socio: ${partnerName(t.socioOrigenId)}`
    if (t.routeOrigenId) return `Ruta: ${routeName(t.routeOrigenId)}`
    return 'Externo'
  }
  function destinoLabel(t: Transfer): string {
    if (t.socioDestinoId) return `Socio: ${partnerName(t.socioDestinoId)}`
    if (t.routeDestinoId) return `Ruta: ${routeName(t.routeDestinoId)}`
    return 'Externo/Socio'
  }

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
    if (form.origen === form.destino) { toast.error('Origen y destino no pueden ser iguales'); return }
    const transferId = generateId()
    const t: Transfer = {
      id: transferId, tenantId, officeId,
      origenType: origen.type, destinoType: destino.type,
      routeOrigenId: origen.type === 'route' ? origen.id : '',
      routeDestinoId: destino.type === 'route' ? destino.id : undefined,
      socioOrigenId: origen.type === 'partner' ? origen.id : undefined,
      socioDestinoId: destino.type === 'partner' ? destino.id : undefined,
      valor: form.valor, descripcion: form.descripcion, fecha: form.fecha,
      userId: user?.id ?? '', createdAt: nowISO(),
    }
    // Guard de datos: AMBAS entidades (origen y destino) deben estar en alcance.
    if (!isTransferInScope(user, t, partnerRouteIds)) {
      toast.error('No puedes transferir desde/hacia una ruta o socio fuera de tu alcance.')
      return
    }
    setSaving(true)
    try {
      await db.transfers.add(t)

      // Impacto en Caja socios: si un socio participa, se crea su movimiento.
      const origenName = origen.type === 'route' ? `Ruta ${routeName(origen.id)}` : `Socio ${partnerName(origen.id)}`
      const destinoName = destino.type === 'route' ? `Ruta ${routeName(destino.id)}` : `Socio ${partnerName(destino.id)}`
      if (origen.type === 'partner') {
        await createPartnerMovement({
          tenantId, partnerId: origen.id, type: 'salida', category: 'transferencia',
          amount: form.valor, description: `Transferencia a ${destinoName}${form.descripcion ? ` · ${form.descripcion}` : ''}`,
          fecha: form.fecha, relatedTransferId: transferId, createdBy: user?.id,
        })
      }
      if (destino.type === 'partner') {
        await createPartnerMovement({
          tenantId, partnerId: destino.id, type: 'ingreso', category: 'transferencia',
          amount: form.valor, description: `Transferencia de ${origenName}${form.descripcion ? ` · ${form.descripcion}` : ''}`,
          fecha: form.fecha, relatedTransferId: transferId, createdBy: user?.id,
        })
      }

      toast.success('Transferencia registrada')
      setModalOpen(false)
      setForm({ origen: '', destino: '', valor: 0, descripcion: '', fecha: today() })
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  // Transferencias dentro del rango de fecha (para totales y detalle).
  const visibleTransfers = transfers.filter(t =>
    (!desde || t.fecha >= desde) && (!hasta || t.fecha <= hasta)
  )

  // ---- Agrupación por entidad (rutas + socios) ----
  const groups: EntityGroup[] = (() => {
    const build = (type: TransferEntityType, id: string, nombre: string): EntityGroup => {
      const isOrigin = (t: Transfer) => type === 'route' ? t.routeOrigenId === id : t.socioOrigenId === id
      const isDest = (t: Transfer) => type === 'route' ? t.routeDestinoId === id : t.socioDestinoId === id
      const mine = visibleTransfers.filter(t => isOrigin(t) || isDest(t))
      const entrante = mine.filter(isDest).reduce((s, t) => s + t.valor, 0)
      const saliente = mine.filter(isOrigin).reduce((s, t) => s + t.valor, 0)
      return {
        key: encodeEndpoint(type, id), type, id, nombre,
        entrante, saliente, neto: entrante - saliente,
        cantidad: mine.length, ultimoMovimiento: mine[0]?.fecha, transfers: mine,
      }
    }
    const routeGroups = routes.map(r => build('route', r.id, r.nombre))
    const partnerGroups = partners.map(p => build('partner', p.id, p.nombre))
    return [...routeGroups, ...partnerGroups]
  })()

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
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva transferencia</Button>
      </div>

      {/* Filtros (compacto, una sola fila en desktop) */}
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
                <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailGroup(g)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
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
            <Select label="Destino" value={form.destino} onChange={e => setForm(f => ({ ...f, destino: e.target.value }))}
              options={endpointOptions} placeholder="Seleccionar destino" required />
          </div>
          <p className="text-xs text-gray-400">Puedes transferir entre rutas y socios. Si participa un socio, se registra automáticamente en Caja socios.</p>
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de movimientos de una entidad */}
      <Modal open={!!detailGroup} onClose={() => setDetailGroup(null)} title={detailGroup ? `Movimientos · ${detailGroup.nombre}` : 'Movimientos'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailGroup(null)}>Cerrar</Button>}>
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
                {detailGroup.transfers.map(t => {
                  const entrada = detailGroup.type === 'route' ? t.routeDestinoId === detailGroup.id : t.socioDestinoId === detailGroup.id
                  return (
                    <div key={t.id} className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
                          <ArrowLeftRight className="w-4 h-4 text-blue-500" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{originLabel(t)} → {destinoLabel(t)}</p>
                          <p className="text-xs text-gray-400">{formatDate(t.fecha)}{userName(t.userId) ? ` · ${userName(t.userId)}` : ''}{t.descripcion ? ` · ${t.descripcion}` : ''}</p>
                        </div>
                      </div>
                      <span className={`text-sm font-bold ${entrada ? 'text-emerald-600' : 'text-amber-600'}`}>{entrada ? '+' : '-'}{formatCurrency(t.valor, currency)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
