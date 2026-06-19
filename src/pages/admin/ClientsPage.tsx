import { useState, useEffect } from 'react'
import { Plus, Search, Users, Eye, Edit, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { ClientStatusBadge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { nowISO, formatDate } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import type { Client, Route, Office } from '@/models/types'

export default function ClientsPage() {
  const { user } = useAuth()
  const { tenantId, officeId } = useTenant()
  const [clients, setClients] = useState<Client[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [offices, setOffices] = useState<Office[]>([])
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterRoute, setFilterRoute] = useState('')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [selected, setSelected] = useState<Client | null>(null)
  const [editing, setEditing] = useState<Client | null>(null)
  const [saving, setSaving] = useState(false)
  const [salesCount, setSalesCount] = useState<Record<string, number>>({})
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    nombre: '', documento: '', telefonoPrincipal: '', telefonoSecundario: '',
    direccionPrincipal: '', direccionSecundaria: '', negocio: '',
    routeId: '', officeId: '', notas: '',
  })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [allClients, allRoutes, allOffices] = await Promise.all([
      db.clients.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.offices.where('tenantId').equals(tenantId).toArray(),
    ])
    setClients(allClients)
    setRoutes(allRoutes)
    setOffices(allOffices)
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
    setForm({ nombre: '', documento: '', telefonoPrincipal: '', telefonoSecundario: '', direccionPrincipal: '', direccionSecundaria: '', negocio: '', routeId: routes[0]?.id ?? '', officeId: (officeId || offices[0]?.id) ?? '', notas: '' })
    setModalOpen(true)
  }

  function openEdit(client: Client) {
    setEditing(client)
    setForm({
      nombre: client.nombre, documento: client.documento,
      telefonoPrincipal: client.telefonoPrincipal, telefonoSecundario: client.telefonoSecundario ?? '',
      direccionPrincipal: client.direccionPrincipal, direccionSecundaria: client.direccionSecundaria ?? '',
      negocio: client.negocio ?? '', routeId: client.routeId, officeId: client.officeId, notas: client.notas ?? '',
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.documento || !form.telefonoPrincipal) { toast.error('Nombre, documento y teléfono son obligatorios'); return }
    setSaving(true)
    try {
      if (editing) {
        await db.clients.update(editing.id, { ...form, updatedAt: nowISO() })
        toast.success('Cliente actualizado')
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
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Ruta</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Teléfono</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Estado</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Ventas</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{c.nombre}</p>
                        <p className="text-xs text-gray-400">{c.documento}</p>
                        {c.negocio && <p className="text-xs text-gray-400 truncate max-w-xs">{c.negocio}</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-sm text-gray-600">{getRouteName(c.routeId)}</span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="text-sm text-gray-600">{c.telefonoPrincipal}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ClientStatusBadge status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <span className="text-sm font-medium text-primary-600">{salesCount[c.id] ?? 0}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => { setSelected(c); setDetailOpen(true) }} icon={<Eye className="w-3.5 h-3.5" />} />
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)} icon={<Edit className="w-3.5 h-3.5" />} />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => requestDelete(c)}
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
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar cliente' : 'Nuevo cliente'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Nombre completo" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
            <Input label="Documento" value={form.documento} onChange={e => setForm(f => ({ ...f, documento: e.target.value }))} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Teléfono principal" value={form.telefonoPrincipal} onChange={e => setForm(f => ({ ...f, telefonoPrincipal: e.target.value }))} required />
            <Input label="Teléfono secundario" value={form.telefonoSecundario} onChange={e => setForm(f => ({ ...f, telefonoSecundario: e.target.value }))} />
          </div>
          <Input label="Dirección principal" value={form.direccionPrincipal} onChange={e => setForm(f => ({ ...f, direccionPrincipal: e.target.value }))} />
          <Input label="Negocio" value={form.negocio} onChange={e => setForm(f => ({ ...f, negocio: e.target.value }))} placeholder="Nombre del negocio o actividad" />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Oficina" value={form.officeId} onChange={e => setForm(f => ({ ...f, officeId: e.target.value }))}
              options={offices.map(o => ({ value: o.id, label: o.nombre }))} required />
            <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
              options={routes.map(r => ({ value: r.id, label: r.nombre }))} required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Notas</label>
            <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" rows={3} />
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={detailOpen} onClose={() => setDetailOpen(false)} title="Ficha del cliente" size="lg"
        footer={<><Button variant="secondary" onClick={() => setDetailOpen(false)}>Cerrar</Button><Button onClick={() => { if (selected) { openEdit(selected); setDetailOpen(false) } }}>Editar</Button></>}>
        {selected && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-primary-100 rounded-2xl flex items-center justify-center text-2xl font-bold text-primary-600">
                {selected.nombre.charAt(0)}
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">{selected.nombre}</h3>
                <p className="text-sm text-gray-500">{selected.documento}</p>
                <ClientStatusBadge status={selected.status} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-gray-400">Teléfono</p><p className="text-sm font-medium">{selected.telefonoPrincipal}</p></div>
              {selected.telefonoSecundario && <div><p className="text-xs text-gray-400">Tel. secundario</p><p className="text-sm font-medium">{selected.telefonoSecundario}</p></div>}
              <div><p className="text-xs text-gray-400">Dirección</p><p className="text-sm font-medium">{selected.direccionPrincipal}</p></div>
              {selected.negocio && <div><p className="text-xs text-gray-400">Negocio</p><p className="text-sm font-medium">{selected.negocio}</p></div>}
              <div><p className="text-xs text-gray-400">Ruta</p><p className="text-sm font-medium">{getRouteName(selected.routeId)}</p></div>
              <div><p className="text-xs text-gray-400">Registrado</p><p className="text-sm font-medium">{formatDate(selected.createdAt)}</p></div>
            </div>
            {selected.notas && <div><p className="text-xs text-gray-400 mb-1">Notas</p><p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3">{selected.notas}</p></div>}
            <div><p className="text-xs text-gray-400 mb-1">Ventas activas</p><p className="text-2xl font-bold text-primary-600">{salesCount[selected.id] ?? 0}</p></div>
          </div>
        )}
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
