import { useState, useEffect } from 'react'
import { Plus, Search, Users, Trash2, AlertTriangle, FileText, Phone, MapPin, Building2, ImageOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { PhotoInput } from '@/components/ui/PhotoInput'
import { ClientStatusBadge, SaleStatusBadge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useRouteCapital } from '@/hooks/useRouteCapital'
import { generateId } from '@/lib/utils'
import { nowISO, formatDate, today, formatCurrency, normalizeDoc } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import {
  calculateTotalWithInterest, calculateInstallmentValue,
  estimateFinalDate, generateInstallments,
} from '@/services/installmentEngine'
import type { Client, Route, Sale, Payment } from '@/models/types'

// Tasa fija seleccionable (igual que en Ventas Activas): solo 10% o 20%
const TASA_OPTIONS = [
  { value: '10', label: '10%' },
  { value: '20', label: '20%' },
]

// Frecuencias de pago (igual que en Ventas Activas)
const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]

// Días de pago (1=lunes ... 6=sábado, 0=domingo)
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
]

const EMPTY_SALE_FORM = {
  valorVenta: 0, tasaInteres: 20, numeroCuotas: 30,
  frecuenciaPago: 'diaria' as Sale['frecuenciaPago'], fechaInicio: today(),
  paymentDays: [1, 2, 3, 4, 5, 6] as number[],
}

export default function ClientsPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [clients, setClients] = useState<Client[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterRoute, setFilterRoute] = useState('')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [selected, setSelected] = useState<Client | null>(null)
  // Datos de la ficha del cliente
  const [detailSales, setDetailSales] = useState<Sale[]>([])
  const [detailPayments, setDetailPayments] = useState<Payment[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [editing, setEditing] = useState<Client | null>(null)
  const [saving, setSaving] = useState(false)
  const [salesCount, setSalesCount] = useState<Record<string, number>>({})
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  // Cliente existente (mismo tenant, cualquier oficina/ruta) que ya usa este documento.
  const [dupClient, setDupClient] = useState<Client | null>(null)
  const [form, setForm] = useState({
    nombre: '', documento: '', telefonoPrincipal: '', telefonoSecundario: '',
    direccionPrincipal: '', direccionSecundaria: '', negocio: '',
    routeId: '', officeId: '', notas: '',
    fotoDocumentoUrl: '' as string | undefined,
    fotoNegocioUrl: '' as string | undefined,
  })
  // Paquete 2: crear venta/crédito en el mismo flujo de Nuevo Cliente
  const [addSale, setAddSale] = useState(false)
  const [saleForm, setSaleForm] = useState({ ...EMPTY_SALE_FORM })
  // Capital disponible de la ruta del cliente (no se permite vender por encima).
  const { available: capDisponible } = useRouteCapital(addSale ? form.routeId : null)
  const capExcedido = addSale && capDisponible != null && saleForm.valorVenta > capDisponible

  function toggleSalePaymentDay(day: number) {
    setSaleForm(f => ({
      ...f,
      paymentDays: f.paymentDays.includes(day)
        ? f.paymentDays.filter(d => d !== day)
        : [...f.paymentDays, day].sort((a, b) => a - b),
    }))
  }

  // Preview financiero del crédito (mismos helpers que Ventas Activas)
  const saleCalc = (() => {
    if (!addSale || saleForm.valorVenta <= 0 || saleForm.numeroCuotas <= 0) return null
    const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: saleForm.valorVenta, tasaInteres: saleForm.tasaInteres })
    const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: saleForm.numeroCuotas })
    const fechaFinal = estimateFinalDate({ fechaInicio: saleForm.fechaInicio, numeroCuotas: saleForm.numeroCuotas, frecuencia: saleForm.frecuenciaPago, paymentDays: saleForm.paymentDays })
    return { valorInteres, valorTotal, valorCuota, fechaFinal }
  })()

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [allClients, allRoutes] = await Promise.all([
      db.clients.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setClients(allClients)
    setRoutes(allRoutes)
    const sc: Record<string, number> = {}
    for (const c of allClients) {
      sc[c.id] = await db.sales.where('clientId').equals(c.id).and(s => s.status === 'activa').count()
    }
    setSalesCount(sc)
    setLoading(false)
  }

  const filtered = clients.filter(c => {
    const q = search.toLowerCase()
    const matchSearch = !q || c.nombre.toLowerCase().includes(q) || c.documento.includes(q) || c.telefonoPrincipal.includes(q)
    const matchStatus = !filterStatus || c.status === filterStatus
    const matchRoute = !filterRoute || c.routeId === filterRoute
    return matchSearch && matchStatus && matchRoute
  })

  function openCreate() {
    setEditing(null)
    setDupClient(null)
    setForm({ nombre: '', documento: '', telefonoPrincipal: '', telefonoSecundario: '', direccionPrincipal: '', direccionSecundaria: '', negocio: '', routeId: routes[0]?.id ?? '', officeId: '', notas: '', fotoDocumentoUrl: undefined, fotoNegocioUrl: undefined })
    setAddSale(false)
    setSaleForm({ ...EMPTY_SALE_FORM, fechaInicio: today() })
    setModalOpen(true)
  }

  function openEdit(client: Client) {
    setEditing(client)
    setDupClient(null)
    setAddSale(false)
    setForm({
      nombre: client.nombre, documento: client.documento,
      telefonoPrincipal: client.telefonoPrincipal, telefonoSecundario: client.telefonoSecundario ?? '',
      direccionPrincipal: client.direccionPrincipal, direccionSecundaria: client.direccionSecundaria ?? '',
      negocio: client.negocio ?? '', routeId: client.routeId, officeId: client.officeId ?? '', notas: client.notas ?? '',
      fotoDocumentoUrl: client.fotoDocumentoUrl, fotoNegocioUrl: client.fotoNegocioUrl,
    })
    setModalOpen(true)
  }

  // Abre la Ficha del Cliente y carga su historial (ventas + abonos).
  async function openDetail(client: Client) {
    setSelected(client)
    setDetailOpen(true)
    setDetailLoading(true)
    const [sales, payments] = await Promise.all([
      db.sales.where('clientId').equals(client.id).toArray(),
      db.payments.where('clientId').equals(client.id).toArray(),
    ])
    setDetailSales(sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    setDetailPayments(payments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    setDetailLoading(false)
  }

  // Validación global de documento duplicado (mismo tenant, sin importar oficina/ruta).
  // Compara con el documento normalizado (sin espacios, puntos ni guiones).
  // Al editar, ignora al propio cliente.
  async function checkDuplicateDoc(doc: string) {
    const norm = normalizeDoc(doc)
    if (!norm) { setDupClient(null); return }
    const all = await db.clients.where('tenantId').equals(tenantId).toArray()
    const match = all.find(c => c.id !== editing?.id && normalizeDoc(c.documento) === norm)
    setDupClient(match ?? null)
  }

  async function handleSave() {
    if (!form.nombre.trim() || !form.documento.trim() || !form.telefonoPrincipal.trim()) { toast.error('Nombre, documento y teléfono son obligatorios'); return }
    if (!form.direccionPrincipal.trim()) { toast.error('La dirección de la casa es obligatoria'); return }
    if (!form.direccionSecundaria.trim()) { toast.error('La dirección del negocio es obligatoria'); return }
    if (!form.routeId) { toast.error('Debes seleccionar una ruta'); return }

    // Validación global de documento duplicado (re-chequeo autoritativo antes de guardar,
    // por si el onBlur no se disparó). Aplica al crear cliente normal y con crédito.
    const norm = normalizeDoc(form.documento)
    const allClients = await db.clients.where('tenantId').equals(tenantId).toArray()
    const existing = allClients.find(c => c.id !== editing?.id && normalizeDoc(c.documento) === norm)
    if (existing) {
      setDupClient(existing)
      toast.error('Este documento ya está registrado como cliente.')
      return
    }

    // Validación de la venta opcional (solo al crear cliente con crédito)
    if (!editing && addSale) {
      if (saleForm.valorVenta <= 0) { toast.error('El valor del préstamo debe ser mayor a 0'); return }
      if (capDisponible != null && saleForm.valorVenta > capDisponible) { toast.error(`La venta supera el capital disponible de la ruta (${formatCurrency(capDisponible, currency)})`); return }
      if (saleForm.numeroCuotas <= 0) { toast.error('El número de cuotas debe ser mayor a 0'); return }
      if (![10, 20].includes(saleForm.tasaInteres)) { toast.error('La tasa de interés debe ser 10% o 20%'); return }
      if (saleForm.fechaInicio < today()) { toast.error('La fecha de inicio de cobro no puede ser anterior a hoy'); return }
      if (saleForm.paymentDays.length === 0) { toast.error('Selecciona al menos un día de pago'); return }
    }

    setSaving(true)
    try {
      if (editing) {
        await db.clients.update(editing.id, { ...form, updatedAt: nowISO() })
        toast.success('Cliente actualizado')
      } else if (addSale) {
        // Cliente + venta + cuotas de forma atómica: si algo falla, no queda nada a medias
        const client: Client = { id: generateId(), tenantId, ...form, status: 'activo', createdAt: nowISO(), updatedAt: nowISO() }
        const route = routes.find(r => r.id === form.routeId)
        const saleId = generateId()
        const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: saleForm.valorVenta, tasaInteres: saleForm.tasaInteres })
        const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: saleForm.numeroCuotas })
        const fechaFinalEstimada = estimateFinalDate({ fechaInicio: saleForm.fechaInicio, numeroCuotas: saleForm.numeroCuotas, frecuencia: saleForm.frecuenciaPago, paymentDays: saleForm.paymentDays })
        const installments = generateInstallments({ saleId, valorTotal, numeroCuotas: saleForm.numeroCuotas, valorCuota, frecuencia: saleForm.frecuenciaPago, fechaInicio: saleForm.fechaInicio, paymentDays: saleForm.paymentDays })
        const sale: Sale = {
          id: saleId, tenantId, officeId: route?.officeId ?? form.officeId,
          routeId: form.routeId, clientId: client.id, createdByUserId: user?.id ?? '',
          valorVenta: saleForm.valorVenta, tasaInteres: saleForm.tasaInteres, valorInteres, valorTotal,
          saldo: valorTotal, numeroCuotas: saleForm.numeroCuotas, valorCuota,
          frecuenciaPago: saleForm.frecuenciaPago, paymentDays: saleForm.paymentDays,
          fechaInicio: saleForm.fechaInicio, fechaFinalEstimada, status: 'activa',
          createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.transaction('rw', db.clients, db.sales, db.installments, async () => {
          await db.clients.add(client)
          await db.sales.add(sale)
          await db.installments.bulkAdd(installments)
        })
        if (user) await logAction({ tenantId, userId: user.id, action: 'CREATE_CLIENT', entityType: 'Client', entityId: client.id, descripcion: `Cliente creado con crédito: ${client.nombre}` })
        toast.success('Cliente y crédito creados')
      } else {
        const client: Client = { id: generateId(), tenantId, ...form, status: 'activo', createdAt: nowISO(), updatedAt: nowISO() }
        await db.clients.add(client)
        toast.success('Cliente creado')
      }
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function requestDelete(client: Client) {
    setCheckingId(client.id)
    try {
      const totalSales = await db.sales.where('clientId').equals(client.id).count()
      if (totalSales > 0) {
        toast.error('No se puede eliminar este cliente porque tiene créditos asociados. Puedes inactivarlo.')
        return
      }
      setDeleteTarget(client)
    } finally { setCheckingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.clients.delete(deleteTarget.id)
      if (user) await logAction({ tenantId, userId: user.id, action: 'DELETE_CLIENT', entityType: 'Client', entityId: deleteTarget.id, descripcion: `Cliente eliminado: ${deleteTarget.nombre}` })
      toast.success('Cliente eliminado')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  const getRouteName = (id: string) => routes.find(r => r.id === id)?.nombre ?? id

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Clientes</h1>
          <p className="text-sm text-gray-500 mt-0.5">{filtered.length} de {clients.length} cliente(s)</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nuevo cliente</Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-48">
          <Input placeholder="Buscar nombre, doc, teléfono..." value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
        </div>
        <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          options={[{ value: 'activo', label: 'Activo' }, { value: 'inactivo', label: 'Inactivo' }, { value: 'moroso', label: 'Moroso' }, { value: 'perdido', label: 'Perdido' }]}
          placeholder="Todos los estados" className="w-44" />
        <Select value={filterRoute} onChange={e => setFilterRoute(e.target.value)}
          options={routes.map(r => ({ value: r.id, label: r.nombre }))}
          placeholder="Todas las rutas" className="w-44" />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="No se encontraron clientes" action={<Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nuevo cliente</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Cliente</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Documento</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Ruta</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Teléfono</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Estado</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Ventas</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Registro</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(c => (
                  <tr key={c.id} onClick={() => openDetail(c)} className="hover:bg-primary-50/40 cursor-pointer transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{c.nombre}</p>
                        {c.negocio && <p className="text-xs text-gray-400 truncate max-w-xs">{c.negocio}</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="text-sm text-gray-600">{c.documento}</span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-sm text-gray-600">{getRouteName(c.routeId)}</span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className="text-sm text-gray-600">{c.telefonoPrincipal}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ClientStatusBadge status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <span className="text-sm font-medium text-primary-600">{salesCount[c.id] ?? 0}</span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className="text-sm text-gray-500">{c.createdAt ? formatDate(c.createdAt) : 'Sin fecha'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); requestDelete(c) }}
                          loading={checkingId === c.id}
                          icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                          className="text-red-400 hover:text-red-600 hover:bg-red-50"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar cliente' : 'Nuevo cliente'} size="mdPlus"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving} disabled={!!dupClient || capExcedido}>{editing ? 'Actualizar' : addSale ? 'Crear cliente y crédito' : 'Crear cliente'}</Button></>}>
        <div className="space-y-4">
          {/* Documento primero (Paquete 2.5) con validación de duplicado global */}
          <Input
            label="Número de documento"
            value={form.documento}
            onChange={e => { setForm(f => ({ ...f, documento: e.target.value })); if (dupClient) setDupClient(null) }}
            onBlur={e => checkDuplicateDoc(e.target.value)}
            error={dupClient ? 'Este documento ya está registrado como cliente.' : undefined}
            required
            autoFocus
          />
          {dupClient && (
            <div className="flex items-start gap-2 p-3 bg-red-50 rounded-xl border border-red-100">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-red-700">
                <p className="font-semibold">Este documento ya está registrado como cliente.</p>
                <p className="mt-0.5">
                  <span className="font-medium">{dupClient.nombre}</span>
                  {' · '}Ruta: {getRouteName(dupClient.routeId)}
                </p>
              </div>
            </div>
          )}
          <Input label="Nombre completo" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Teléfono principal" value={form.telefonoPrincipal} onChange={e => setForm(f => ({ ...f, telefonoPrincipal: e.target.value }))} required />
            <Input label="Teléfono secundario" value={form.telefonoSecundario} onChange={e => setForm(f => ({ ...f, telefonoSecundario: e.target.value }))} />
          </div>
          <Input label="Dirección de la casa" value={form.direccionPrincipal} onChange={e => setForm(f => ({ ...f, direccionPrincipal: e.target.value }))} required placeholder="Ej: Cll 45 #23-12, Barrio Centro" />
          <Input label="Dirección del negocio" value={form.direccionSecundaria} onChange={e => setForm(f => ({ ...f, direccionSecundaria: e.target.value }))} required placeholder="Ej: Cra 8 #12-30, Local 2" />
          <Input label="Negocio" value={form.negocio} onChange={e => setForm(f => ({ ...f, negocio: e.target.value }))} placeholder="Nombre del negocio o actividad" />
          {/* Fotos (Paquete 2.5): documento y negocio/lugar de cobro */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <PhotoInput label="Foto del documento" value={form.fotoDocumentoUrl} onChange={url => setForm(f => ({ ...f, fotoDocumentoUrl: url }))} />
            <PhotoInput label="Foto del negocio / lugar de cobro" value={form.fotoNegocioUrl} onChange={url => setForm(f => ({ ...f, fotoNegocioUrl: url }))} />
          </div>
          <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
            options={routes.map(r => ({ value: r.id, label: r.nombre }))} required />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Notas</label>
            <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" rows={3} />
          </div>

          {/* Paquete 2: crear crédito en el mismo flujo (solo al crear cliente nuevo) */}
          {!editing && (
            <div className="rounded-xl border border-gray-200 p-3">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={addSale}
                  onChange={e => setAddSale(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm font-medium text-gray-800">Crear crédito ahora</span>
                <span className="text-xs text-gray-400">Agrega una venta al guardar el cliente</span>
              </label>

              {addSale && (
                <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
                  <p className="text-xs text-gray-500">
                    El crédito se crea en la ruta del cliente: <span className="font-medium text-gray-700">{routes.find(r => r.id === form.routeId)?.nombre ?? 'sin ruta'}</span>
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    <MoneyInput label="Valor del préstamo" currency={currency} value={saleForm.valorVenta} onValueChange={v => setSaleForm(f => ({ ...f, valorVenta: v }))} required />
                    <Select label="Tasa interés" value={String(saleForm.tasaInteres)} onChange={e => setSaleForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} options={TASA_OPTIONS} />
                    <Input label="N° cuotas" type="number" min={1} value={saleForm.numeroCuotas} onChange={e => setSaleForm(f => ({ ...f, numeroCuotas: Number(e.target.value) }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Select label="Frecuencia de pago" value={saleForm.frecuenciaPago} onChange={e => setSaleForm(f => ({ ...f, frecuenciaPago: e.target.value as Sale['frecuenciaPago'] }))} options={FREQ_OPTIONS} />
                    <Input label="Fecha inicio de cobro" type="date" min={today()} value={saleForm.fechaInicio} onChange={e => setSaleForm(f => ({ ...f, fechaInicio: e.target.value }))} hint="No puede ser anterior a hoy" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</label>
                    <div className="flex flex-wrap gap-2">
                      {WEEK_DAYS.map(d => {
                        const active = saleForm.paymentDays.includes(d.value)
                        return (
                          <button
                            key={d.value}
                            type="button"
                            onClick={() => toggleSalePaymentDay(d.value)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                              active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            {d.label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1 text-xs text-gray-400">Selecciona los días en que se cobrará. Para frecuencia semanal puedes dejar un solo día.</p>
                  </div>
                  {capDisponible != null && (
                    <div className={`rounded-xl p-3 text-sm border ${capExcedido ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-100 text-gray-600'}`}>
                      Capital disponible de la ruta: <span className="font-bold">{formatCurrency(capDisponible, currency)}</span>
                      {capExcedido && <p className="text-xs mt-1 font-medium">El valor supera el capital disponible. Reduce el monto o inyecta capital a la ruta.</p>}
                    </div>
                  )}
                  {saleCalc && (
                    <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
                      <div><p className="text-xs text-gray-500">Interés total</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorInteres, currency)}</p></div>
                      <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorTotal, currency)}</p></div>
                      <div><p className="text-xs text-gray-500">Valor cuota</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorCuota, currency)}</p></div>
                      <div><p className="text-xs text-gray-500">Fecha estimada fin</p><p className="font-bold text-primary-700">{formatDate(saleCalc.fechaFinal)}</p></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* Ficha del cliente */}
      <Modal open={detailOpen} onClose={() => setDetailOpen(false)} title="Ficha del cliente" size="lg"
        footer={<><Button variant="secondary" onClick={() => setDetailOpen(false)}>Cerrar</Button><Button onClick={() => { if (selected) { openEdit(selected); setDetailOpen(false) } }}>Editar</Button></>}>
        {selected && (() => {
          const activas = detailSales.filter(s => s.status === 'activa')
          const cerradas = detailSales.filter(s => s.status === 'finalizada')
          const perdidas = detailSales.filter(s => s.status === 'perdida')
          const totalTrabajado = detailSales.reduce((s, x) => s + x.valorVenta, 0)
          const saldoActual = activas.reduce((s, x) => s + x.saldo, 0)
          const totalAbonado = detailPayments.reduce((s, p) => s + p.valor, 0)
          const saleById = new Map(detailSales.map(s => [s.id, s]))
          return (
            <div className="space-y-5">
              {/* A. Encabezado */}
              <div className="flex items-start gap-4">
                <div className="w-14 h-14 bg-primary-100 rounded-2xl flex items-center justify-center text-xl font-bold text-primary-600 flex-shrink-0">
                  {selected.nombre.charAt(0)}
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900 leading-tight">{selected.nombre}</h3>
                  <p className="text-sm text-gray-500">Doc: {selected.documento}</p>
                  <div className="mt-1"><ClientStatusBadge status={selected.status} /></div>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Ruta</p><p className="text-sm font-medium text-gray-800">{getRouteName(selected.routeId)}</p></div>
                <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Registro</p><p className="text-sm font-medium text-gray-800">{selected.createdAt ? formatDate(selected.createdAt) : 'Sin fecha'}</p></div>
              </div>

              {/* B. Información de contacto */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Contacto</p>
                <div className="bg-white border border-gray-100 rounded-xl divide-y divide-gray-50">
                  <ContactRow icon={<Phone className="w-4 h-4 text-gray-400" />} label="Teléfono" value={selected.telefonoPrincipal} />
                  {selected.telefonoSecundario && <ContactRow icon={<Phone className="w-4 h-4 text-gray-400" />} label="Teléfono adicional" value={selected.telefonoSecundario} />}
                  <ContactRow icon={<MapPin className="w-4 h-4 text-gray-400" />} label="Residencia" value={selected.direccionPrincipal} />
                  {selected.direccionSecundaria && <ContactRow icon={<MapPin className="w-4 h-4 text-gray-400" />} label="Cobro / negocio" value={selected.direccionSecundaria} />}
                  {selected.negocio && <ContactRow icon={<Building2 className="w-4 h-4 text-gray-400" />} label="Negocio" value={selected.negocio} />}
                  {selected.notas && <ContactRow icon={<FileText className="w-4 h-4 text-gray-400" />} label="Observaciones" value={selected.notas} />}
                </div>
              </div>

              {/* C. Fotos */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Fotos</p>
                <div className="grid grid-cols-2 gap-3">
                  <PhotoCard label="Documento" url={selected.fotoDocumentoUrl} />
                  <PhotoCard label="Negocio / lugar de cobro" url={selected.fotoNegocioUrl} />
                </div>
              </div>

              {/* D. Resumen financiero */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Resumen financiero</p>
                {detailLoading ? (
                  <p className="text-xs text-gray-400">Cargando…</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <MiniStat label="Ventas" value={String(detailSales.length)} />
                    <MiniStat label="Activas" value={String(activas.length)} color="text-primary-600" />
                    <MiniStat label="Cerradas" value={String(cerradas.length)} color="text-emerald-600" />
                    <MiniStat label="Perdidas" value={String(perdidas.length)} color="text-red-500" />
                    <MiniStat label="Total trabajado" value={formatCurrency(totalTrabajado, currency)} />
                    <MiniStat label="Total abonado" value={formatCurrency(totalAbonado, currency)} color="text-emerald-600" />
                    <MiniStat label="Saldo actual" value={formatCurrency(saldoActual, currency)} color="text-amber-600" />
                  </div>
                )}
              </div>

              {/* E. Historial de ventas */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historial de ventas</p>
                {detailSales.length === 0 ? (
                  <p className="text-xs text-gray-400">Este cliente no tiene ventas.</p>
                ) : (
                  <div className="space-y-1.5 max-h-52 overflow-y-auto">
                    {detailSales.map(s => (
                      <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 border border-gray-100">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800">{formatCurrency(s.valorVenta, currency)} <span className="text-xs text-gray-400">· total {formatCurrency(s.valorTotal, currency)}</span></p>
                          <p className="text-xs text-gray-400">Inicio {formatDate(s.fechaInicio)}{s.status !== 'activa' ? ` · Cierre ${formatDate(s.updatedAt)}` : ''}</p>
                        </div>
                        <div className="text-right flex-shrink-0 ml-2">
                          <SaleStatusBadge status={s.status} />
                          <p className="text-xs text-amber-600 mt-0.5">Saldo {formatCurrency(s.saldo, currency)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* F. Abonos recientes */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Abonos recientes</p>
                {detailPayments.length === 0 ? (
                  <p className="text-xs text-gray-400">Sin abonos registrados.</p>
                ) : (
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {detailPayments.slice(0, 12).map(p => {
                      const sale = saleById.get(p.saleId)
                      return (
                        <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800">{formatDate(p.fecha)}</p>
                            <p className="text-xs text-gray-400 truncate">Venta {sale ? formatCurrency(sale.valorVenta, currency) : '—'}{p.observacion ? ` · ${p.observacion}` : ''}</p>
                          </div>
                          <span className="text-sm font-bold text-emerald-600 flex-shrink-0 ml-2">+{formatCurrency(p.valor, currency)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Delete confirm modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar cliente"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará el registro de forma permanente. ¿Deseas continuar?</p>
          </div>
          <p className="text-sm text-gray-600">Cliente: <span className="font-semibold">{deleteTarget?.nombre}</span></p>
        </div>
      </Modal>
    </div>
  )
}

function ContactRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <div className="mt-0.5 flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-400">{label}</p>
        <p className="text-sm text-gray-800 break-words">{value}</p>
      </div>
    </div>
  )
}

function PhotoCard({ label, url }: { label: string; url?: string }) {
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <p className="text-xs text-gray-500 mb-1">{label}</p>
        <img src={url} alt={label} className="w-full h-28 object-cover rounded-xl border border-gray-200" />
      </a>
    )
  }
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <div className="w-full h-28 rounded-xl border border-dashed border-gray-200 bg-gray-50 flex flex-col items-center justify-center text-gray-300 gap-1">
        <ImageOff className="w-5 h-5" />
        <span className="text-[11px] text-gray-400">Sin foto</span>
      </div>
    </div>
  )
}

function MiniStat({ label, value, color = 'text-gray-800' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-2.5 text-center">
      <p className={`text-sm font-bold leading-tight truncate ${color}`}>{value}</p>
      <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>
    </div>
  )
}
