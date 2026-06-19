import { useState, useEffect } from 'react'
import { Plus, Building2, MapPin, Phone, Edit, ToggleLeft, ToggleRight, Users, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import type { Office } from '@/models/types'

export default function OfficesPage() {
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [offices, setOffices] = useState<Office[]>([])
  const [routeCounts, setRouteCounts] = useState<Record<string, number>>({})
  const [clientCounts, setClientCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Office | null>(null)
  const [form, setForm] = useState({ nombre: '', pais: 'Colombia', ciudad: '', responsable: '', telefono: '', email: '' })
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Office | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const data = await db.offices.where('tenantId').equals(tenantId).toArray()
    setOffices(data)
    const rc: Record<string, number> = {}
    const cc: Record<string, number> = {}
    for (const o of data) {
      rc[o.id] = await db.routes.where('officeId').equals(o.id).count()
      cc[o.id] = await db.clients.where('officeId').equals(o.id).and(c => c.status === 'activo').count()
    }
    setRouteCounts(rc)
    setClientCounts(cc)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    setForm({ nombre: '', pais: 'Colombia', ciudad: '', responsable: '', telefono: '', email: '' })
    setModalOpen(true)
  }

  function openEdit(office: Office) {
    setEditing(office)
    setForm({ nombre: office.nombre, pais: office.pais, ciudad: office.ciudad, responsable: office.responsable ?? '', telefono: office.telefono ?? '', email: office.email ?? '' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.ciudad) { toast.error('Nombre y ciudad son obligatorios'); return }
    setSaving(true)
    try {
      if (editing) {
        await db.offices.update(editing.id, { ...form, updatedAt: nowISO() })
        toast.success('Oficina actualizada')
      } else {
        const office: Office = { id: generateId(), tenantId, ...form, status: 'activa', createdAt: nowISO(), updatedAt: nowISO() }
        await db.offices.add(office)
        toast.success('Oficina creada')
      }
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function toggleStatus(office: Office) {
    const newStatus = office.status === 'activa' ? 'inactiva' : 'activa'
    await db.offices.update(office.id, { status: newStatus, updatedAt: nowISO() })
    toast.success(`Oficina ${newStatus === 'activa' ? 'activada' : 'desactivada'}`)
    await load()
  }

  async function requestDelete(office: Office) {
    setCheckingId(office.id)
    try {
      const [routes, clients, sales, expenses, capital, transfers, withdrawals] = await Promise.all([
        db.routes.where('officeId').equals(office.id).count(),
        db.clients.where('officeId').equals(office.id).count(),
        db.sales.where('officeId').equals(office.id).count(),
        db.expenses.where('officeId').equals(office.id).count(),
        db.capitalMovements.where('officeId').equals(office.id).count(),
        db.transfers.where('officeId').equals(office.id).count(),
        db.withdrawals.where('officeId').equals(office.id).count(),
      ])
      if (routes + clients + sales + expenses + capital + transfers + withdrawals > 0) {
        toast.error('No se puede eliminar esta oficina porque tiene información asociada. Puedes inactivarla.')
        return
      }
      setDeleteTarget(office)
    } finally { setCheckingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.offices.delete(deleteTarget.id)
      if (user) await logAction({ tenantId, userId: user.id, action: 'DELETE_OFFICE', entityType: 'Office', entityId: deleteTarget.id, descripcion: `Oficina eliminada: ${deleteTarget.nombre}` })
      toast.success('Oficina eliminada')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Oficinas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{offices.length} oficina(s) registrada(s)</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva oficina</Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : offices.length === 0 ? (
        <EmptyState
          icon={<Building2 className="w-8 h-8" />}
          title="No hay oficinas"
          description="Crea tu primera oficina para comenzar a gestionar rutas"
          action={<Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Crear oficina</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {offices.map((office) => (
            <Card key={office.id} className="space-y-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-primary-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">{office.nombre}</h3>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <MapPin className="w-3 h-3" />
                      {office.ciudad}, {office.pais}
                    </div>
                  </div>
                </div>
                <Badge variant={office.status === 'activa' ? 'success' : 'gray'}>
                  {office.status === 'activa' ? 'Activa' : 'Inactiva'}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-primary-600">{routeCounts[office.id] ?? 0}</p>
                  <p className="text-xs text-gray-500">Rutas</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-emerald-600">{clientCounts[office.id] ?? 0}</p>
                  <p className="text-xs text-gray-500">Clientes activos</p>
                </div>
              </div>

              {office.responsable && (
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  {office.responsable}
                </div>
              )}
              {office.telefono && (
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <Phone className="w-3.5 h-3.5 text-gray-400" />
                  {office.telefono}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button variant="secondary" size="sm" onClick={() => openEdit(office)} icon={<Edit className="w-3.5 h-3.5" />} className="flex-1">Editar</Button>
                <Button variant="ghost" size="sm" onClick={() => toggleStatus(office)}
                  icon={office.status === 'activa' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />}
                  className="flex-1">
                  {office.status === 'activa' ? 'Desactivar' : 'Activar'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => requestDelete(office)}
                  loading={checkingId === office.id}
                  icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                  className="text-red-400 hover:text-red-600 hover:bg-red-50"
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar oficina' : 'Nueva oficina'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre de la oficina" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Ej: Oficina Central" required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="País" value={form.pais} onChange={e => setForm(f => ({ ...f, pais: e.target.value }))} />
            <Input label="Ciudad" value={form.ciudad} onChange={e => setForm(f => ({ ...f, ciudad: e.target.value }))} required />
          </div>
          <Input label="Responsable / Socio" value={form.responsable} onChange={e => setForm(f => ({ ...f, responsable: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Teléfono" value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} />
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          </div>
        </div>
      </Modal>

      {/* Delete confirm modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar oficina"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará el registro de forma permanente. ¿Deseas continuar?</p>
          </div>
          <p className="text-sm text-gray-600">Oficina: <span className="font-semibold">{deleteTarget?.nombre}</span></p>
        </div>
      </Modal>
    </div>
  )
}
