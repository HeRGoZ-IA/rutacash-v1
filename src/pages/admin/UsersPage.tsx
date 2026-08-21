import { useState, useEffect } from 'react'
import { Plus, Users, ToggleLeft, ToggleRight, Trash2, AlertTriangle, Search, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { ConfirmDiscardModal } from '@/components/ui/ConfirmDiscardModal'
import { useDirtyForm } from '@/hooks/useDirtyForm'
import { toast } from '@/components/ui/Toast'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId, generateTemporaryPassword } from '@/lib/utils'
import { nowISO, initials } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { getAssignedRouteIds } from '@/lib/roles'
import { setCobradorRoutes, clearRouteResponsibilities } from '@/services/routeAssignment'
import { resetUserPassword } from '@/services/passwordService'
import {
  assignableRoles, canManageUser, filterAccessibleRoutes,
  authorizedRouteIdsOf, isRouteUnrestricted,
  ROLE_LABELS,
} from '@/lib/permissions'
import type { User, Route, UserRole } from '@/models/types'

// Roles que exigen al menos una ruta autorizada para operar.
const ROLE_REQUIRES_ROUTES: Record<UserRole, boolean> = {
  superadmin: false, admin: false, socio: false, supervisor: false, cobrador: true, secretario: true,
}

export default function UsersPage() {
  const { user: currentUser } = useAuth()
  const { tenantId } = useTenant()
  const [users, setUsers] = useState<User[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [resetPass, setResetPass] = useState(generateTemporaryPassword)

  const roleOptions = assignableRoles(currentUser).map(r => ({ value: r, label: ROLE_LABELS[r] }))
  const defaultRole: UserRole = (assignableRoles(currentUser)[0] ?? 'cobrador') as UserRole

  // MODELO PURO (#7): ROL BASE + RUTAS AUTORIZADAS. Sin permisos individuales.
  const [form, setForm] = useState({
    nombre: '', email: '', password: generateTemporaryPassword(), rol: defaultRole,
    authorizedRouteIds: [] as string[],
  })
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dirty = useDirtyForm(original, form)
  function closeModal() { setModalOpen(false); setDiscardOpen(false); setOriginal(null) }
  function tryCloseModal() { if (dirty) setDiscardOpen(true); else closeModal() }

  // Rutas que el usuario actual puede asignar (limitado a sus rutas accesibles).
  const assignableRoutes = filterAccessibleRoutes(currentUser, routes)

  function toggleRoute(routeId: string) {
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
    // Cada alta propone una contraseña TEMPORAL distinta y aleatoria: ninguna cuenta
    // nace con una credencial conocida.
    const init = { nombre: '', email: '', password: generateTemporaryPassword(), rol: defaultRole, authorizedRouteIds: [] as string[] }
    setForm(init); setOriginal({ ...init })
    setModalOpen(true)
  }

  function openEdit(u: User) {
    if (currentUser && !canManageUser(currentUser, u)) {
      toast.error('No tienes permiso para editar este usuario.')
      return
    }
    setEditing(u)
    const init = {
      nombre: u.nombre, email: u.email, password: u.password, rol: u.rol,
      authorizedRouteIds: getAssignedRouteIds(u),
    }
    setForm(init); setOriginal({ ...init })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!currentUser) return
    if (!form.nombre || !form.email) { toast.error('Nombre y email son requeridos'); return }
    // #5 Guard de datos: no editar usuarios de rango superior aunque se manipule el estado.
    if (editing && !canManageUser(currentUser, editing)) {
      toast.error('No tienes permiso para editar este usuario.')
      return
    }
    // Jerarquía: el actor solo puede crear/editar roles permitidos.
    if (!assignableRoles(currentUser).includes(form.rol)) {
      toast.error('No puedes asignar ese rol.')
      return
    }
    // Estados inválidos: rutas obligatorias para cobrador/secretario.
    if (ROLE_REQUIRES_ROUTES[form.rol] && form.authorizedRouteIds.length === 0) {
      toast.error(`Un ${ROLE_LABELS[form.rol]} necesita al menos una ruta autorizada.`)
      return
    }
    // Un actor NO Super Admin no puede asignar rutas que él mismo no administra.
    if (!isRouteUnrestricted(currentUser)) {
      const actorAllowed = new Set(authorizedRouteIdsOf(currentUser))
      const prevAssigned = new Set(editing ? getAssignedRouteIds(editing) : [])
      const illegal = form.authorizedRouteIds.filter(id => !actorAllowed.has(id) && !prevAssigned.has(id))
      if (illegal.length > 0) { toast.error('No puedes asignar rutas que no administras.'); return }
    }
    setSaving(true)
    try {
      const userId = editing ? editing.id : generateId()
      const isNew = !editing
      // Cobrador: modelo NO permite venta directa → flags legacy en false.
      // #7 Sin permisos individuales: grantedCapabilities/revokedCapabilities siempre vacíos.
      const legacyDirect = { canCreateDirectSales: form.rol === 'cobrador' ? false : undefined, maxDirectSaleAmount: undefined }
      const noGrants = { grantedCapabilities: undefined, revokedCapabilities: undefined }

      if (editing) {
        await db.users.update(editing.id, {
          nombre: form.nombre, email: form.email, password: form.password, rol: form.rol,
          ...noGrants, ...legacyDirect, updatedAt: nowISO(),
        })
      } else {
        const existing = await db.users.where('email').equals(form.email).first()
        if (existing) { toast.error('Ya existe un usuario con ese email'); setSaving(false); return }
        const u: User = {
          id: userId, tenantId, nombre: form.nombre, email: form.email, password: form.password, rol: form.rol,
          // La contraseña la eligió un superior: es TEMPORAL. El usuario debe definir
          // la suya en su primer acceso (PasswordChangeGate).
          mustChangePassword: true,
          ...noGrants, ...legacyDirect, status: 'activo', createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.users.add(u)
      }

      // Sincronización de rutas según rol.
      if (form.rol === 'cobrador') {
        await setCobradorRoutes(userId, form.authorizedRouteIds)
      } else if (form.rol === 'admin' || form.rol === 'socio' || form.rol === 'supervisor' || form.rol === 'secretario') {
        await clearRouteResponsibilities(userId)
        await db.users.update(userId, {
          authorizedRouteIds: form.authorizedRouteIds.length ? form.authorizedRouteIds : undefined,
          routeId: undefined, updatedAt: nowISO(),
        })
      } else {
        await clearRouteResponsibilities(userId)
        await db.users.update(userId, { authorizedRouteIds: undefined, routeId: undefined, updatedAt: nowISO() })
      }

      await logAction({
        tenantId, userId: currentUser.id, userRole: currentUser.rol,
        action: isNew ? 'CREATE_USER' : 'UPDATE_USER', entityType: 'User', entityId: userId,
        descripcion: `${isNew ? 'Usuario creado' : 'Usuario actualizado'}: ${form.nombre} (${ROLE_LABELS[form.rol]})`,
        after: { rol: form.rol, routes: form.authorizedRouteIds },
      })
      toast.success(editing ? 'Usuario actualizado' : 'Usuario creado')
      closeModal()
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function toggleStatus(u: User) {
    if (currentUser && !canManageUser(currentUser, u)) { toast.error('No tienes permiso sobre este usuario.'); return }
    const ns = u.status === 'activo' ? 'inactivo' : 'activo'
    await db.users.update(u.id, { status: ns, updatedAt: nowISO() })
    if (currentUser) await logAction({ tenantId, userId: currentUser.id, userRole: currentUser.rol, action: 'BLOCK_USER', entityType: 'User', entityId: u.id, descripcion: `Usuario ${ns}: ${u.nombre}`, before: { status: u.status }, after: { status: ns } })
    toast.success(`Usuario ${ns}`)
    await load()
  }

  async function handleReset() {
    if (!currentUser || !resetTarget) return
    const res = await resetUserPassword(currentUser, resetTarget.id, resetPass)
    if (res.success) { toast.success('Contraseña restablecida'); setResetTarget(null); setResetPass(generateTemporaryPassword()) }
    else toast.error(res.error ?? 'No se pudo restablecer')
  }

  async function requestDelete(u: User) {
    // Solo Super Admin elimina usuarios (Administrador no elimina usuarios).
    if (currentUser?.rol !== 'superadmin') { toast.error('Solo el Super Admin puede eliminar usuarios. Puedes inactivarlo.'); return }
    if (u.id === currentUser?.id) { toast.error('No puedes eliminar tu propio usuario.'); return }
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
        toast.error('No se puede eliminar: tiene movimientos registrados. Puedes inactivarlo.')
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
      if (currentUser) await logAction({ tenantId, userId: currentUser.id, userRole: currentUser.rol, action: 'DELETE_USER', entityType: 'User', entityId: deleteTarget.id, descripcion: `Usuario eliminado: ${deleteTarget.nombre}` })
      toast.success('Usuario eliminado')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  const routeName = (id: string) => routes.find(r => r.id === id)?.nombre ?? '—'
  type BadgeVar = 'info' | 'success' | 'warning' | 'gray' | 'purple' | 'danger'

  function roleBadges(u: User): { label: string; variant: BadgeVar }[] {
    const out: { label: string; variant: BadgeVar }[] = []
    const roleVariant: Record<UserRole, BadgeVar> = { superadmin: 'purple', admin: 'info', socio: 'purple', supervisor: 'info', cobrador: 'success', secretario: 'warning' }
    out.push({ label: ROLE_LABELS[u.rol], variant: roleVariant[u.rol] })
    if (u.rol === 'superadmin') { out.push({ label: 'Plataforma', variant: 'gray' }); return out }
    if (u.rol === 'admin' && getAssignedRouteIds(u).length === 0) { out.push({ label: 'Sin rutas (sin acceso)', variant: 'danger' }); return out }
    const assigned = getAssignedRouteIds(u)
    if (assigned.length === 0) {
      out.push({ label: ROLE_REQUIRES_ROUTES[u.rol] ? 'Sin rutas (no opera)' : 'Sin rutas', variant: ROLE_REQUIRES_ROUTES[u.rol] ? 'danger' : 'gray' })
    } else {
      out.push({ label: `${assigned.length} ${assigned.length === 1 ? 'ruta' : 'rutas'}`, variant: 'info' })
      if (assigned.length <= 3) for (const id of assigned) out.push({ label: routeName(id), variant: 'gray' })
    }
    return out
  }

  // Visibilidad por rutas: un actor NO Super Admin no ve subordinados que pertenezcan
  // EXCLUSIVAMENTE a rutas ajenas. Ve: a sí mismo, gestionables con solape de ruta, y
  // gestionables aún sin rutas (pendientes de asignación).
  const visibleByScope = (u: User): boolean => {
    if (!currentUser) return false
    if (isRouteUnrestricted(currentUser)) return true
    if (u.id === currentUser.id) return true
    if (!canManageUser(currentUser, u)) return false
    const actorRoutes = new Set(authorizedRouteIdsOf(currentUser))
    const targetRoutes = getAssignedRouteIds(u)
    if (targetRoutes.length === 0) return true
    return targetRoutes.some(r => actorRoutes.has(r))
  }

  // #5 VISIBILIDAD JERÁRQUICA: el universo visible (lista, contador, buscador) se
  // limita a los usuarios que el actor puede ver. No se expone el total del tenant.
  const scopedUsers = users.filter(visibleByScope)
  const filteredUsers = scopedUsers.filter(u => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return u.nombre.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || ROLE_LABELS[u.rol].toLowerCase().includes(q)
  })

  const showRoutes = form.rol !== 'superadmin'

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Usuarios</h1><p className="text-sm text-gray-500 mt-0.5">{filteredUsers.length} de {scopedUsers.length} usuario(s)</p></div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nuevo usuario</Button>
      </div>

      <div className="max-w-sm">
        <Input placeholder="Buscar por nombre, email o rol..." value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filteredUsers.length === 0 ? (
        <EmptyState icon={<Users className="w-8 h-8" />} title="Sin usuarios" action={<Button onClick={openCreate}>Crear usuario</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="divide-y divide-gray-50">
            {filteredUsers.map(u => {
              const manageable = !!currentUser && canManageUser(currentUser, u)
              return (
                <div key={u.id} onClick={() => manageable && openEdit(u)} className={`flex items-center gap-4 px-4 py-3 transition-colors ${manageable ? 'cursor-pointer hover:bg-primary-50/40' : 'opacity-70'}`}>
                  <div className="flex items-center gap-3 w-56 flex-shrink-0 min-w-0">
                    <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">{initials(u.nombre)}</div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{u.nombre}</p>
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
                    {roleBadges(u).map((b, i) => <Badge key={i} variant={b.variant} size="sm">{b.label}</Badge>)}
                  </div>
                  <Badge variant={u.status === 'activo' ? 'success' : 'gray'} size="sm">{u.status}</Badge>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" title="Restablecer contraseña" disabled={!manageable}
                      onClick={(e) => { e.stopPropagation(); setResetTarget(u); setResetPass(generateTemporaryPassword()) }}
                      icon={<KeyRound className="w-3.5 h-3.5 text-primary-500" />} />
                    <Button variant="ghost" size="sm" disabled={!manageable} onClick={(e) => { e.stopPropagation(); toggleStatus(u) }}
                      icon={u.status === 'activo' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />} />
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); requestDelete(u) }} loading={checkingId === u.id}
                      disabled={u.id === currentUser?.id || currentUser?.rol !== 'superadmin'}
                      icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />} className="text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30" />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Create/Edit modal. X/Cancelar no guardan (confirman descarte si hay cambios). */}
      <Modal open={modalOpen} onClose={tryCloseModal} title={editing ? 'Editar usuario' : 'Nuevo usuario'}
        footer={<><Button variant="secondary" onClick={tryCloseModal} disabled={saving}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre completo" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          <Input label="Contraseña temporal" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            hint="Generada al azar. Compártela con la persona: deberá cambiarla en su primer acceso." />
          <Select label="Rol" value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value as UserRole, grantedCapabilities: [] }))} options={roleOptions} required />

          {showRoutes && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Rutas autorizadas {ROLE_REQUIRES_ROUTES[form.rol] && <span className="text-red-500">*</span>}
              </label>
              {assignableRoutes.length === 0 ? (
                <p className="text-xs text-gray-400">No hay rutas disponibles para asignar.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {assignableRoutes.map(r => {
                    const active = form.authorizedRouteIds.includes(r.id)
                    return (
                      <button key={r.id} type="button" onClick={() => toggleRoute(r.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                        {r.nombre}
                      </button>
                    )
                  })}
                </div>
              )}
              {form.rol === 'admin' && form.authorizedRouteIds.length === 0 && (
                <p className="mt-1 text-xs text-gray-400">Sin selección: el administrador verá todas las rutas de la empresa. Selecciona rutas para limitarlo.</p>
              )}
              {ROLE_REQUIRES_ROUTES[form.rol] && form.authorizedRouteIds.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">Este rol necesita al menos una ruta para poder operar.</p>
              )}
            </div>
          )}

          {/* #7 Sin "Permisos adicionales": el acceso depende solo de rol + rutas. */}
          {form.rol !== 'superadmin' && (
            <p className="text-xs text-gray-400">
              Los permisos de este usuario dependen únicamente de su <span className="font-medium text-gray-500">rol</span> y de sus <span className="font-medium text-gray-500">rutas autorizadas</span>.
            </p>
          )}
        </div>
      </Modal>

      {/* Reset password modal */}
      <Modal open={!!resetTarget} onClose={() => setResetTarget(null)} title="Restablecer contraseña"
        footer={<><Button variant="secondary" onClick={() => setResetTarget(null)}>Cancelar</Button><Button onClick={handleReset} icon={<KeyRound className="w-4 h-4" />}>Restablecer</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Usuario: <span className="font-semibold">{resetTarget?.nombre}</span></p>
          <Input label="Nueva contraseña" value={resetPass} onChange={e => setResetPass(e.target.value)} />
        </div>
      </Modal>

      {/* Delete confirm modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar usuario"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Solo se permite eliminar usuarios SIN movimientos. Los históricos financieros nunca se borran.</p>
          </div>
          <p className="text-sm text-gray-600">Usuario: <span className="font-semibold">{deleteTarget?.nombre}</span> ({deleteTarget?.email})</p>
        </div>
      </Modal>

      <ConfirmDiscardModal open={discardOpen} onKeepEditing={() => setDiscardOpen(false)} onDiscard={closeModal} />
    </div>
  )
}
