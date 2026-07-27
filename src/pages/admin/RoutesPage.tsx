import { useState, useEffect } from 'react'
import { Plus, MapPin, Users, DollarSign, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { ConfirmDiscardModal } from '@/components/ui/ConfirmDiscardModal'
import { useDirtyForm } from '@/hooks/useDirtyForm'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { formatCurrency, nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { createRouteWithAdmins, updateRouteWithAssignments } from '@/services/routeService'
import { filterAccessibleRoutes, assignableRoles, canManageUser, ROLE_LABELS } from '@/lib/permissions'
import { getAssignedRouteIds } from '@/lib/roles'
import { useNavigate } from 'react-router-dom'
import type { Route, User, RouteFinancialSummary } from '@/models/types'

export default function RoutesPage() {
  const { user, refreshUser } = useAuth()
  const { tenantId, currency } = useTenant()
  const navigate = useNavigate()
  const [routes, setRoutes] = useState<Route[]>([])
  const [cobradores, setCobradores] = useState<User[]>([])
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [summaryByRoute, setSummaryByRoute] = useState<Record<string, RouteFinancialSummary>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Route | null>(null)
  // Confirmación al Actualizar si la ruta activa quedaría SIN Administrador.
  const [noAdminConfirm, setNoAdminConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Route | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  // Filtro por fecha de creación de la ruta (Revisión 2 — "si aplica").
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [form, setForm] = useState({
    nombre: '', ciudad: '', cobradorId: '', adminIds: [] as string[],
    // BORRADOR de asignaciones de usuarios (edición): NO persiste hasta "Actualizar".
    assignedUserIds: [] as string[],
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0,
  })
  // Dirty-state: snapshot original al abrir vs draft actual (para confirmar descarte).
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dirty = useDirtyForm(original, form)

  // #5/#6 Administradores activos del tenant (requisito para crear rutas).
  const activeAdmins = allUsers.filter(u => u.rol === 'admin' && u.status === 'activo')
  const hasActiveAdmin = activeAdmins.length > 0
  // Administradores que el actor puede fijar como responsables al crear:
  // Super Admin → todos los activos; Administrador → solo él mismo (no gestiona otros admin).
  const selectableAdmins = user?.rol === 'superadmin' ? activeAdmins : activeAdmins.filter(a => a.id === user?.id)
  const lockAdminToSelf = user?.rol === 'admin'

  // Código interno ordenado y secuencial: RT-001, RT-002, ... (no se pide al usuario).
  function nextRouteCode(existing: Route[]): string {
    let max = 0
    for (const r of existing) {
      const m = /^RT-(\d+)$/.exec(r.codigo ?? '')
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return `RT-${String(max + 1).padStart(3, '0')}`
  }

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const all = await db.routes.where('tenantId').equals(tenantId).toArray()
    // RESTRICCIÓN POR RUTAS: el Administrador solo ve sus rutas autorizadas.
    const rts = filterAccessibleRoutes(user, all)
    setRoutes(rts)
    const us = await db.users.where('tenantId').equals(tenantId).toArray()
    setAllUsers(us)
    setCobradores(us.filter(u => u.rol === 'cobrador'))
    const sum: Record<string, RouteFinancialSummary> = {}
    for (const r of rts) {
      sum[r.id] = await getRouteFinancialSummary(r.id)
    }
    setSummaryByRoute(sum)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    // El Administrador creador queda preseleccionado (y bloqueado): se autoasigna.
    const preselect = user?.rol === 'admin' && user?.id ? [user.id] : []
    const init = { nombre: '', ciudad: '', cobradorId: '', adminIds: preselect, assignedUserIds: [], tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0 }
    setForm(init)
    setOriginal({ ...init })   // snapshot para dirty-check
    setModalOpen(true)
  }

  // ¿Puede el actor togglear a este usuario? (jerarquía; nunca superadmin ni, para admin, otros admin).
  const isAssignable = (u: User) => u.rol !== 'superadmin' && assignableRoles(user).includes(u.rol) && canManageUser(user, u)

  function openEdit(route: Route) {
    setEditing(route)
    // Miembros actuales de la ruta (entre los asignables) → snapshot del BORRADOR.
    const assignedUserIds = allUsers.filter(u => isAssignable(u) && getAssignedRouteIds(u).includes(route.id)).map(u => u.id)
    const init = {
      nombre: route.nombre, ciudad: route.ciudad ?? '',
      cobradorId: route.cobradorId ?? '', adminIds: [] as string[], assignedUserIds,
      tasaInteres: route.tasaInteres, tasaLibre: route.tasaLibre,
      montoMaximoPrestamo: route.montoMaximoPrestamo, capitalInicial: route.capitalInicial,
    }
    setForm(init)
    setOriginal({ ...init })   // snapshot de TODO (generales + asignaciones)
    setModalOpen(true)
  }

  // Cierre del editor SIN guardar (descarta también las asignaciones del borrador).
  function closeModal() { setModalOpen(false); setDiscardOpen(false); setNoAdminConfirm(false); setOriginal(null) }
  function tryCloseModal() { if (dirty) setDiscardOpen(true); else closeModal() }

  // Alternar asignación de un usuario: SOLO modifica el borrador (no escribe en Dexie).
  function toggleAssignUser(id: string) {
    setForm(f => ({ ...f, assignedUserIds: f.assignedUserIds.includes(id) ? f.assignedUserIds.filter(x => x !== id) : [...f.assignedUserIds, id] }))
  }

  function toggleAdmin(id: string) {
    if (lockAdminToSelf) return // el Administrador solo se asigna a sí mismo
    setForm(f => ({ ...f, adminIds: f.adminIds.includes(id) ? f.adminIds.filter(x => x !== id) : [...f.adminIds, id] }))
  }

  // Usuarios que el actor puede asignar a la ruta (jerarquía).
  const assignableToRoutes = allUsers.filter(isAssignable)

  async function handleSave(force = false) {
    if (!user) return
    if (!form.nombre) { toast.error('El nombre de la ruta es obligatorio'); return }
    if (!editing) {
      // #6 Al crear, se exige Administrador responsable (Super Admin elige; el
      // Administrador queda autoasignado). El servicio revalida ambas condiciones.
      if (form.adminIds.length === 0) { toast.error('Selecciona al menos un Administrador responsable.'); return }
    }
    // Confirmación al Actualizar: no dejar una ruta ACTIVA sin ningún Administrador.
    if (editing && !force && editing.status === 'activa') {
      const draftAdmins = form.assignedUserIds.filter(id => allUsers.find(u => u.id === id)?.rol === 'admin')
      const prevAdmins = allUsers.filter(a => a.rol === 'admin' && getAssignedRouteIds(a).includes(editing.id))
      if (draftAdmins.length === 0 && prevAdmins.length > 0) { setNoAdminConfirm(true); return }
    }
    setSaving(true)
    try {
      if (editing) {
        // ÚNICO punto de persistencia: todo (generales + cobrador + asignaciones) en una transacción.
        await updateRouteWithAssignments({
          routeId: editing.id, tenantId, nombre: form.nombre, ciudad: form.ciudad,
          tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre, montoMaximoPrestamo: form.montoMaximoPrestamo,
          cobradorId: form.cobradorId || undefined,
          assignedUserIds: form.assignedUserIds,
          assignableUserIds: assignableToRoutes.map(u => u.id),
        }, user)
        // Si el actor se vio afectado (auto-asignación/retiro), refrescar su sesión.
        if (form.assignedUserIds.includes(user.id) || getAssignedRouteIds(user).includes(editing.id)) await refreshUser()
        toast.success('Ruta actualizada')
      } else {
        await createRouteWithAdmins({
          tenantId, nombre: form.nombre, ciudad: form.ciudad,
          tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre,
          montoMaximoPrestamo: form.montoMaximoPrestamo, capitalInicial: form.capitalInicial,
          codigo: nextRouteCode(routes), adminIds: form.adminIds, cobradorId: form.cobradorId || undefined,
        }, user)
        if (form.adminIds.includes(user.id)) await refreshUser()
        toast.success('Ruta creada')
      }
      // Cerrar SOLO tras confirmarse el guardado (el error mantiene el modal abierto y el borrador).
      closeModal()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al guardar')
    } finally { setSaving(false) }
  }

  async function toggleStatus(route: Route) {
    const newStatus = route.status === 'activa' ? 'inactiva' : 'activa'
    await db.routes.update(route.id, { status: newStatus, updatedAt: nowISO() })
    if (user) await logAction({ tenantId, userId: user.id, userRole: user.rol, routeId: route.id, action: 'BLOCK_ROUTE', entityType: 'Route', entityId: route.id, descripcion: `Ruta ${newStatus}: ${route.nombre}`, before: { status: route.status }, after: { status: newStatus } })
    toast.success(`Ruta ${newStatus === 'activa' ? 'activada' : 'desactivada'}`)
    await load()
  }

  async function requestDelete(route: Route) {
    // El Administrador NO elimina rutas; solo el Super Admin (y sin movimientos).
    if (user?.rol !== 'superadmin') { toast.error('Solo el Super Admin puede eliminar rutas. Puedes inactivarla.'); return }
    setCheckingId(route.id)
    try {
      const [clients, sales, payments, expenses, capital, withdrawals, transOrigen, transDest] = await Promise.all([
        db.clients.where('routeId').equals(route.id).count(),
        db.sales.where('routeId').equals(route.id).count(),
        db.payments.where('routeId').equals(route.id).count(),
        db.expenses.where('routeId').equals(route.id).count(),
        db.capitalMovements.where('routeId').equals(route.id).count(),
        db.withdrawals.where('routeId').equals(route.id).count(),
        db.transfers.where('routeOrigenId').equals(route.id).count(),
        db.transfers.where('routeDestinoId').equals(route.id).count(),
      ])
      if (clients + sales + payments + expenses + capital + withdrawals + transOrigen + transDest > 0) {
        toast.error('No se puede eliminar esta ruta porque tiene movimientos asociados. Puedes inactivarla.')
        return
      }
      setDeleteTarget(route)
    } finally { setCheckingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.routes.delete(deleteTarget.id)
      if (user) await logAction({ tenantId, userId: user.id, action: 'DELETE_ROUTE', entityType: 'Route', entityId: deleteTarget.id, descripcion: `Ruta eliminada: ${deleteTarget.nombre}` })
      toast.success('Ruta eliminada')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  const getCobradorName = (id?: string) => cobradores.find(c => c.id === id)?.nombre

  // Filtro por fecha de creación de la ruta. No afecta los cálculos financieros
  // (Base actual / Cartera Activa son saldos a la fecha), solo qué rutas se listan.
  const visibleRoutes = routes.filter(r => {
    const fecha = (r.createdAt ?? '').slice(0, 10)
    return (!desde || fecha >= desde) && (!hasta || fecha <= hasta)
  })

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Rutas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleRoutes.length} de {routes.length} ruta(s)</p>
        </div>
        {/* #5 No se puede crear una ruta sin Administrador activo (botón deshabilitado). */}
        <Button onClick={openCreate} disabled={!hasActiveAdmin} icon={<Plus className="w-4 h-4" />}>Nueva ruta</Button>
      </div>

      {/* #5 Explicación visible + acción para crear el primer Administrador. */}
      {!loading && !hasActiveAdmin && (
        <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-800 font-medium">Primero debes crear al menos un Administrador para asignarlo como responsable de la ruta.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => navigate('/admin/users')} icon={<Users className="w-3.5 h-3.5" />}>Crear Administrador</Button>
          </div>
        </div>
      )}

      {/* Filtro por fecha de creación (compacto) */}
      <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta}
        onClear={() => { setDesde(''); setHasta('') }} />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : routes.length === 0 ? (
        <EmptyState icon={<MapPin className="w-8 h-8" />} title="No hay rutas" description="Crea una ruta para empezar" action={<Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Crear ruta</Button>} />
      ) : visibleRoutes.length === 0 ? (
        <EmptyState icon={<MapPin className="w-8 h-8" />} title="Sin rutas en el rango" description="Ninguna ruta fue creada en las fechas seleccionadas." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleRoutes.map((route) => (
            <Card key={route.id} className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <MapPin className="w-4 h-4 text-primary-500" />
                    <h3 className="font-semibold text-gray-900 text-sm">{route.nombre}</h3>
                  </div>
                  <p className="text-xs text-gray-400 ml-6">{route.codigo}{route.ciudad ? ` · ${route.ciudad}` : ''}</p>
                </div>
                <Badge variant={route.status === 'activa' ? 'success' : 'gray'}>
                  {route.status === 'activa' ? 'Activa' : 'Inactiva'}
                </Badge>
              </div>

              {/* Revisión socio 25-jun — Base actual vs Cartera en calle por ruta */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-primary-50 rounded-xl p-3">
                  <p className="text-sm font-bold text-primary-700 truncate">{formatCurrency(summaryByRoute[route.id]?.baseActual ?? route.capitalInicial, currency)}</p>
                  <p className="text-xs text-gray-400">Base actual</p>
                </div>
                <div className="bg-indigo-50 rounded-xl p-3">
                  <p className="text-sm font-bold text-indigo-600 truncate">{formatCurrency(summaryByRoute[route.id]?.carteraEnCalle ?? 0, currency)}</p>
                  <p className="text-xs text-gray-400">Cartera Activa</p>
                </div>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5 flex items-center justify-between">
                <p className="text-xs text-gray-400">Total controlado</p>
                <p className="text-sm font-bold text-gray-800">{formatCurrency(summaryByRoute[route.id]?.totalControlado ?? 0, currency)}</p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                  <p className="text-base font-bold text-primary-600">{summaryByRoute[route.id]?.ventasActivas ?? 0}</p>
                  <p className="text-xs text-gray-400">Ventas</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                  <p className="text-base font-bold text-emerald-600">{summaryByRoute[route.id]?.clientesActivos ?? 0}</p>
                  <p className="text-xs text-gray-400">Clientes</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                  <p className="text-base font-bold text-gray-700">{route.tasaInteres}%</p>
                  <p className="text-xs text-gray-400">Tasa</p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-gray-600">
                <Users className="w-3.5 h-3.5 text-gray-400" />
                {getCobradorName(route.cobradorId) ?? <span className="text-amber-500">Sin cobrador</span>}
              </div>

              <div className="flex gap-2 pt-1">
                <Button variant="secondary" size="sm" onClick={() => openEdit(route)} icon={<Edit className="w-3.5 h-3.5" />} className="flex-1">Editar</Button>
                <Button variant="ghost" size="sm" onClick={() => toggleStatus(route)} className="flex-1"
                  icon={route.status === 'activa' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />}>
                  {route.status === 'activa' ? 'Desactivar' : 'Activar'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => requestDelete(route)}
                  loading={checkingId === route.id}
                  icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                  className="text-red-400 hover:text-red-600 hover:bg-red-50"
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit modal. X y Cancelar NO guardan (confirman descarte si hay
          cambios). Actualizar/Crear persiste y cierra solo tras el éxito. */}
      <Modal open={modalOpen} onClose={tryCloseModal} title={editing ? 'Editar ruta' : 'Nueva ruta'}
        footer={<><Button variant="secondary" onClick={tryCloseModal} disabled={saving}>Cancelar</Button><Button onClick={() => handleSave()} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Nombre de la ruta" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
            <Input label="Ciudad" value={form.ciudad} onChange={e => setForm(f => ({ ...f, ciudad: e.target.value }))} placeholder="Ej: Barranquilla" />
          </div>
          {editing && <p className="text-xs text-gray-400">Código de ruta: <span className="font-medium text-gray-600">{editing.codigo}</span></p>}

          {/* #6 Administrador responsable (obligatorio al crear). Super Admin elige uno
              o varios activos; el Administrador queda autoasignado (bloqueado a sí mismo). */}
          {!editing && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Administrador responsable <span className="text-red-500">*</span></label>
              {lockAdminToSelf ? (
                <div className="flex items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-700">
                  <Users className="w-4 h-4" /> {user?.nombre} <span className="text-xs text-primary-400">(se asigna automáticamente)</span>
                </div>
              ) : selectableAdmins.length === 0 ? (
                <p className="text-xs text-amber-600">No hay Administradores activos disponibles.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {selectableAdmins.map(a => {
                    const active = form.adminIds.includes(a.id)
                    return (
                      <button key={a.id} type="button" onClick={() => toggleAdmin(a.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                        {a.nombre}
                      </button>
                    )
                  })}
                </div>
              )}
              {!lockAdminToSelf && form.adminIds.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">Selecciona al menos un Administrador responsable.</p>
              )}
            </div>
          )}

          <Select label="Cobrador" value={form.cobradorId} onChange={e => setForm(f => ({ ...f, cobradorId: e.target.value }))}
            options={cobradores.map(c => ({ value: c.id, label: c.nombre }))} placeholder="Sin asignar" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Tasa de interés (%)" type="number" value={form.tasaInteres} onChange={e => setForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} min={0} max={100} />
            <MoneyInput label="Monto máx. préstamo" currency={currency} value={form.montoMaximoPrestamo} onValueChange={v => setForm(f => ({ ...f, montoMaximoPrestamo: v }))} />
          </div>
          {!editing && (
            <MoneyInput label="Capital inicial" currency={currency} value={form.capitalInicial} onValueChange={v => setForm(f => ({ ...f, capitalInicial: v }))} hint="Se registrará como movimiento de capital" />
          )}
          <div className="flex items-center gap-3">
            <input type="checkbox" id="tasaLibre" checked={form.tasaLibre} onChange={e => setForm(f => ({ ...f, tasaLibre: e.target.checked }))} className="w-4 h-4 text-primary-600" />
            <label htmlFor="tasaLibre" className="text-sm text-gray-700">Tasa libre (el cobrador puede variar la tasa)</label>
          </div>

          {/* Usuarios asignados a esta ruta — BORRADOR: no persiste hasta "Actualizar". */}
          {editing && (
            <div className="pt-3 border-t border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-gray-500" />
                <label className="text-sm font-medium text-gray-700">Usuarios asignados a esta ruta</label>
              </div>
              <p className="text-xs text-gray-400 mb-2">Los cambios se guardarán al presionar "Actualizar".</p>
              {assignableToRoutes.length === 0 ? (
                <p className="text-xs text-gray-400">No hay usuarios que puedas asignar.</p>
              ) : (
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {assignableToRoutes.map(u => {
                    const member = form.assignedUserIds.includes(u.id)   // ← lee del BORRADOR
                    return (
                      <button key={u.id} type="button" onClick={() => toggleAssignUser(u.id)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${member ? 'bg-primary-50 border-primary-200' : 'bg-white border-gray-200 hover:bg-gray-50'}`}>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{u.nombre}</p>
                          <p className="text-xs text-gray-400">{ROLE_LABELS[u.rol]}{u.status !== 'activo' ? ' · inactivo' : ''}</p>
                        </div>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${member ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                          {member ? 'Asignado' : 'Asignar'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* Descarte de TODOS los cambios sin guardar (generales + asignaciones del borrador). */}
      <ConfirmDiscardModal
        open={discardOpen}
        onKeepEditing={() => setDiscardOpen(false)}
        onDiscard={closeModal}
      />

      {/* Confirmación al Actualizar: la ruta ACTIVA quedaría sin ningún Administrador. */}
      <Modal open={noAdminConfirm} onClose={() => setNoAdminConfirm(false)} title="Ruta sin Administrador" size="sm"
        footer={<><Button variant="secondary" onClick={() => setNoAdminConfirm(false)}>Seguir editando</Button><Button variant="danger" loading={saving} onClick={() => { setNoAdminConfirm(false); handleSave(true) }}>Guardar de todos modos</Button></>}>
        <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-700">Esta ruta ACTIVA quedará <span className="font-semibold">sin ningún Administrador responsable</span>. ¿Deseas guardar de todos modos?</p>
        </div>
      </Modal>

      {/* Delete confirm modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar ruta"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará el registro de forma permanente. ¿Deseas continuar?</p>
          </div>
          <p className="text-sm text-gray-600">Ruta: <span className="font-semibold">{deleteTarget?.nombre}</span></p>
        </div>
      </Modal>
    </div>
  )
}
