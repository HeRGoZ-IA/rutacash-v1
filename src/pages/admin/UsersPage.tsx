import { useState, useEffect } from 'react'
import { Plus, Users, ToggleLeft, ToggleRight, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { nowISO, initials, formatCurrency } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { getAssignedRouteIds } from '@/lib/roles'
import { setCobradorRoutes, clearRouteResponsibilities } from '@/services/routeAssignment'
import type { User, Route, UserRole } from '@/models/types'

const ROLES = [
  { value: 'admin', label: 'Administrador' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'cobrador', label: 'Cobrador' },
  { value: 'socio', label: 'Socio' },
]

export default function UsersPage() {
  const { user: currentUser } = useAuth()
  const { tenantId, currency } = useTenant()
  const [users, setUsers] = useState<User[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [form, setForm] = useState({ nombre: '', email: '', password: '123456', rol: 'cobrador' as UserRole, officeId: '', routeId: '', authorizedRouteIds: [] as string[], canCreateDirectSales: false, maxDirectSaleAmount: 0 })

  function toggleAuthorizedRoute(routeId: string) {
    setForm(f => ({
      ...f,
      authorizedRouteIds: f.authorizedRouteIds.includes(routeId)
        ? f.authorizedRouteIds.filter(id => id !== routeId)
        : [...f.authorizedRouteIds, routeId],
    }))
  }

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [us, rts] = await Promise.all([
      db.users.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setUsers(us)
    setRoutes(rts)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    setForm({ nombre: '', email: '', password: '123456', rol: 'cobrador', officeId: '', routeId: '', authorizedRouteIds: [], canCreateDirectSales: false, maxDirectSaleAmount: 0 })
    setModalOpen(true)
  }

  function openEdit(u: User) {
    setEditing(u)
    // Rutas asignadas consolidadas (incluye routeId legacy) para cobrador y supervisor.
    const assigned = getAssignedRouteIds(u)
    setForm({ nombre: u.nombre, email: u.email, password: u.password, rol: u.rol, officeId: u.officeId ?? '', routeId: u.routeId ?? '', authorizedRouteIds: assigned, canCreateDirectSales: !!u.canCreateDirectSales, maxDirectSaleAmount: u.maxDirectSaleAmount ?? 0 })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.email) { toast.error('Nombre y email son requeridos'); return }
    setSaving(true)
    try {
      // Config de ventas directas: solo aplica al cobrador.
      const canCreateDirectSales = form.rol === 'cobrador' ? form.canCreateDirectSales : undefined
      const maxDirectSaleAmount = form.rol === 'cobrador' && form.canCreateDirectSales && form.maxDirectSaleAmount > 0 ? form.maxDirectSaleAmount : undefined
      const userId = editing ? editing.id : generateId()

      if (editing) {
        await db.users.update(editing.id, {
          nombre: form.nombre, email: form.email, password: form.password, rol: form.rol,
          officeId: form.officeId || undefined, canCreateDirectSales, maxDirectSaleAmount, updatedAt: nowISO(),
        })
      } else {
        const existing = await db.users.where('email').equals(form.email).first()
        if (existing) { toast.error('Ya existe un usuario con ese email'); setSaving(false); return }
        const u: User = {
          id: userId, tenantId, nombre: form.nombre, email: form.email, password: form.password, rol: form.rol,
          officeId: form.officeId || undefined, canCreateDirectSales, maxDirectSaleAmount,
          status: 'activo', createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.users.add(u)
      }

      // Sincronización de rutas según rol
      if (form.rol === 'cobrador') {
        // Rutas asignadas (lista) ↔ route.cobradorId
        await setCobradorRoutes(userId, form.authorizedRouteIds)
      } else if (form.rol === 'supervisor') {
        // Rutas autorizadas independientes; libera responsabilidad de cobrador si la tenía
        await clearRouteResponsibilities(userId)
        await db.users.update(userId, { authorizedRouteIds: form.authorizedRouteIds, routeId: undefined, updatedAt: nowISO() })
      } else {
        // Admin / otros: sin rutas
        await clearRouteResponsibilities(userId)
        await db.users.update(userId, { authorizedRouteIds: undefined, routeId: undefined, updatedAt: nowISO() })
      }
      toast.success(editing ? 'Usuario actualizado' : 'Usuario creado')
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
  const routeName = (id: string) => routes.find(r => r.id === id)?.nombre ?? '—'

  type BadgeVar = 'info' | 'success' | 'warning' | 'gray' | 'purple' | 'danger'

  // Badges informativos por rol. Incluye el propio rol como primer badge para que
  // todo viva en la columna central amplia.
  function roleBadges(u: User): { label: string; variant: BadgeVar }[] {
    const out: { label: string; variant: BadgeVar }[] = []
    if (u.rol === 'cobrador') {
      out.push({ label: 'Cobrador', variant: 'success' })
      const assigned = getAssignedRouteIds(u)
      if (assigned.length === 0) {
        out.push({ label: 'Sin rutas asignadas', variant: 'danger' })
      } else {
        out.push({ label: `${assigned.length} ${assigned.length === 1 ? 'ruta asignada' : 'rutas asignadas'}`, variant: 'info' })
        if (assigned.length <= 3) {
          for (const id of assigned) out.push({ label: routeName(id), variant: 'gray' })
        }
      }
      if (u.canCreateDirectSales) {
        out.push({ label: u.maxDirectSaleAmount && u.maxDirectSaleAmount > 0 ? `Venta directa ≤ ${formatCurrency(u.maxDirectSaleAmount, currency)}` : 'Venta directa habilitada', variant: 'success' })
      } else {
        out.push({ label: 'Requiere autorización', variant: 'warning' })
      }
    } else if (u.rol === 'supervisor') {
      out.push({ label: 'Supervisor', variant: 'purple' })
      const assigned = getAssignedRouteIds(u)
      if (assigned.length === 0) {
        out.push({ label: 'Sin rutas autorizadas', variant: 'gray' })
      } else {
        out.push({ label: `${assigned.length} ${assigned.length === 1 ? 'ruta autorizada' : 'rutas autorizadas'}`, variant: 'info' })
        if (assigned.length <= 3) for (const id of assigned) out.push({ label: routeName(id), variant: 'gray' })
      }
    } else if (u.rol === 'admin') {
      out.push({ label: 'Administrador', variant: 'info' })
      out.push({ label: 'Acceso total', variant: 'gray' })
    } else {
      out.push({ label: rolLabel(u.rol), variant: 'gray' })
    }
    return out
  }

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
              <div key={u.id} onClick={() => openEdit(u)} className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-primary-50/40 transition-colors">
                {/* Columna 1: identidad */}
                <div className="flex items-center gap-3 w-56 flex-shrink-0 min-w-0">
                  <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                    {initials(u.nombre)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{u.nombre}</p>
                    <p className="text-xs text-gray-400 truncate">{u.email}</p>
                  </div>
                </div>
                {/* Columna 2: badges / permisos / rutas (espacio central amplio) */}
                <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
                  {roleBadges(u).map((b, i) => (
                    <Badge key={i} variant={b.variant} size="sm">{b.label}</Badge>
                  ))}
                </div>
                {/* Columna 3: estado */}
                <Badge variant={u.status === 'activo' ? 'success' : 'gray'} size="sm">{u.status}</Badge>
                {/* Columna 4: acciones */}
                <div className="flex gap-1 flex-shrink-0">
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); toggleStatus(u) }}
                    icon={u.status === 'activo' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); requestDelete(u) }}
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
          <Select label="Rol" value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value as UserRole }))} options={ROLES} required />
          {form.rol === 'cobrador' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Rutas asignadas</label>
                {routes.length === 0 ? (
                  <p className="text-xs text-gray-400">No hay rutas creadas todavía.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {routes.map(r => {
                      const active = form.authorizedRouteIds.includes(r.id)
                      return (
                        <button key={r.id} type="button" onClick={() => toggleAuthorizedRoute(r.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                          {r.nombre}
                        </button>
                      )
                    })}
                  </div>
                )}
                {form.authorizedRouteIds.length === 0 ? (
                  <p className="mt-1.5 text-xs text-amber-600">Este cobrador no podrá operar hasta tener rutas asignadas.</p>
                ) : (
                  <p className="mt-1 text-xs text-gray-400">El cobrador puede tener una o muchas rutas asignadas.</p>
                )}
              </div>
              {/* Config de ventas directas del cobrador */}
              <div className="rounded-xl border border-gray-200 p-3 space-y-3">
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={form.canCreateDirectSales} onChange={e => setForm(f => ({ ...f, canCreateDirectSales: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
                  <span className="text-sm font-medium text-gray-800">Puede crear ventas directas</span>
                </label>
                {form.canCreateDirectSales ? (
                  <MoneyInput label="Monto máximo de venta directa (0 = sin límite)" currency={currency} value={form.maxDirectSaleAmount} onValueChange={v => setForm(f => ({ ...f, maxDirectSaleAmount: v }))} />
                ) : (
                  <p className="text-xs text-gray-400">Si está desactivado, toda venta del cobrador requerirá autorización del administrador.</p>
                )}
              </div>
            </>
          )}
          {form.rol === 'supervisor' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Rutas autorizadas</label>
              {routes.length === 0 ? (
                <p className="text-xs text-gray-400">No hay rutas creadas todavía.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {routes.map(r => {
                    const active = form.authorizedRouteIds.includes(r.id)
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleAuthorizedRoute(r.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {r.nombre}
                      </button>
                    )
                  })}
                </div>
              )}
              <p className="mt-1 text-xs text-gray-400">El supervisor solo podrá revisar las rutas seleccionadas. Puede tener una o varias.</p>
            </div>
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
