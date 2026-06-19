import { useState, useEffect } from 'react'
import { Plus, Users, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { nowISO, initials } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import type { User, Office, Route, UserRole } from '@/models/types'

const ROLES = [
  { value: 'admin', label: 'Administrador' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'cobrador', label: 'Cobrador' },
  { value: 'socio', label: 'Socio' },
]

export default function UsersPage() {
  const { user: currentUser } = useAuth()
  const { tenantId } = useTenant()
  const [users, setUsers] = useState<User[]>([])
  const [offices, setOffices] = useState<Office[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [form, setForm] = useState({ nombre: '', email: '', password: '123456', rol: 'cobrador' as UserRole, officeId: '', routeId: '' })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [us, ofs, rts] = await Promise.all([
      db.users.where('tenantId').equals(tenantId).toArray(),
      db.offices.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setUsers(us)
    setOffices(ofs)
    setRoutes(rts)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    setForm({ nombre: '', email: '', password: '123456', rol: 'cobrador', officeId: offices[0]?.id ?? '', routeId: '' })
    setModalOpen(true)
  }

  function openEdit(u: User) {
    setEditing(u)
    setForm({ nombre: u.nombre, email: u.email, password: u.password, rol: u.rol, officeId: u.officeId ?? '', routeId: u.routeId ?? '' })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.email) { toast.error('Nombre y email son requeridos'); return }
    setSaving(true)
    try {
      if (editing) {
        await db.users.update(editing.id, { nombre: form.nombre, email: form.email, password: form.password, rol: form.rol, officeId: form.officeId || undefined, routeId: form.routeId || undefined, updatedAt: nowISO() })
        // Sync route.cobradorId: clear old route if route changed or role changed away from cobrador
        if (editing.routeId && (editing.routeId !== form.routeId || form.rol !== 'cobrador')) {
          await db.routes.update(editing.routeId, { cobradorId: undefined, updatedAt: nowISO() })
        }
        if (form.rol === 'cobrador' && form.routeId) {
          await db.routes.update(form.routeId, { cobradorId: editing.id, updatedAt: nowISO() })
        }
        toast.success('Usuario actualizado')
      } else {
        const existing = await db.users.where('email').equals(form.email).first()
        if (existing) { toast.error('Ya existe un usuario con ese email'); setSaving(false); return }
        const u: User = { id: generateId(), tenantId, ...form, officeId: form.officeId || undefined, routeId: form.routeId || undefined, status: 'activo', createdAt: nowISO(), updatedAt: nowISO() }
        await db.users.add(u)
        if (form.rol === 'cobrador' && form.routeId) {
          await db.routes.update(form.routeId, { cobradorId: u.id, updatedAt: nowISO() })
        }
        toast.success('Usuario creado')
      }
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function toggleStatus(u: User) {
    const ns = u.status === 'activo' ? 'inactivo' : 'activo'
    await db.users.update(u.id, { status: ns, updatedAt: nowISO() })
    toast.success(`Usuario ${ns}`)
    await load()
  }

  async function requestDelete(u: User) {
    if (u.id === currentUser?.id) {
      toast.error('No puedes eliminar tu propio usuario.')
      return
    }

    if (u.rol === 'admin') {
      const activeAdmins = await db.users.where('tenantId').equals(tenantId)
        .and(x => x.rol === 'admin' && x.status === 'activo').count()
      if (activeAdmins <= 1) {
        toast.error('No se puede eliminar el último administrador activo de la empresa.')
        return
      }
    }

    setCheckingId(u.id)
    try {
      const [sales, payments, expenses, transfers, withdrawals] = await Promise.all([
        db.sales.where('tenantId').equals(tenantId).and(s => s.createdByUserId === u.id).count(),
        db.payments.where('collectorId').equals(u.id).count(),
        db.expenses.where('userId').equals(u.id).count(),
        db.transfers.where('tenantId').equals(tenantId).and(t => t.userId === u.id).count(),
        db.withdrawals.where('tenantId').equals(tenantId).and(w => w.userId === u.id).count(),
      ])
      if (sales + payments + expenses + transfers + withdrawals > 0) {
        toast.error('No se puede eliminar este usuario porque tiene movimientos registrados. Puedes inactivarlo.')
        return
      }
      setDeleteTarget(u)
    } finally { setCheckingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.users.delete(deleteTarget.id)
      if (currentUser) await logAction({ tenantId, userId: currentUser.id, action: 'DELETE_USER', entityType: 'User', entityId: deleteTarget.id, descripcion: `Usuario eliminado: ${deleteTarget.nombre} (${deleteTarget.email})` })
      toast.success('Usuario eliminado')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  const rolLabel = (r: string) => ROLES.find(x => x.value === r)?.label ?? r

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Usuarios</h1><p className="text-sm text-gray-500 mt-0.5">{users.length} usuario(s)</p></div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nuevo usuario</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : users.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="No hay usuarios" action={<Button onClick={openCreate}>Crear usuario</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="divide-y divide-gray-50">
            {users.map(u => (
              <div key={u.id} className="flex items-center gap-4 px-4 py-3">
                <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                  {initials(u.nombre)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{u.nombre}</p>
                  <p className="text-xs text-gray-400 truncate">{u.email}</p>
                </div>
                <Badge variant={u.rol === 'admin' ? 'info' : u.rol === 'cobrador' ? 'success' : 'purple'} size="sm">{rolLabel(u.rol)}</Badge>
                <Badge variant={u.status === 'activo' ? 'success' : 'gray'} size="sm">{u.status}</Badge>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(u)} icon={<Edit className="w-3.5 h-3.5" />} />
                  <Button variant="ghost" size="sm" onClick={() => toggleStatus(u)}
                    icon={u.status === 'activo' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => requestDelete(u)}
                    loading={checkingId === u.id}
                    disabled={u.id === currentUser?.id}
                    icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                    className="text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create/Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar usuario' : 'Nuevo usuario'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre completo" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <Input label="Contraseña" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Rol" value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value as UserRole }))} options={ROLES} required />
            <Select label="Oficina" value={form.officeId} onChange={e => setForm(f => ({ ...f, officeId: e.target.value }))} options={offices.map(o => ({ value: o.id, label: o.nombre }))} placeholder="Sin oficina" />
          </div>
          {form.rol === 'cobrador' && (
            <Select label="Ruta asignada" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))} options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Sin ruta" />
          )}
        </div>
      </Modal>

      {/* Delete confirm modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar usuario"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará el registro de forma permanente. ¿Deseas continuar?</p>
          </div>
          <p className="text-sm text-gray-600">Usuario: <span className="font-semibold">{deleteTarget?.nombre}</span> ({deleteTarget?.email})</p>
        </div>
      </Modal>
    </div>
  )
}
