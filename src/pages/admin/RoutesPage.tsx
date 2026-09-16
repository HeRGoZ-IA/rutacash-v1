import { useState, useEffect } from 'react'
import { Plus, MapPin, Users, DollarSign, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { ConfirmDiscardModal } from '@/components/ui/ConfirmDiscardModal'
import { RouteAssignedUsers } from '@/components/ui/RouteAssignedUsers'
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
import { cobradorRemovalBlock, validateCobradorInvariant, COBRADOR_REMOVAL_MESSAGE, routeAssignmentWarnings, routeCanOperateCollection, ROUTE_NO_COBRADOR_LABEL, ROUTE_NO_COBRADOR_OPERATION_MESSAGE } from '@/lib/cobradorRules'
import { ASSIGNMENT_ROLE_ORDER } from '@/lib/routeAssignments'
import { effectiveAdminIdsAfterSave, routeAdmins, shouldConfirmRouteWithoutAdmin } from '@/lib/routeAdmins'
import { NO_OFFICE_LABEL, filterRoutesByOffice, ALL_OFFICES } from '@/lib/officeGrouping'
import { resolveOfficeParam } from '@/lib/officeRouteFilter'
import { OfficeSelector } from '@/components/ui/OfficeSelector'
import { filterAccessibleRoutes, assignableRoles, canManageUser, ROLE_LABELS } from '@/lib/permissions'
import { getAssignedRouteIds } from '@/lib/roles'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Office, Route, User, RouteFinancialSummary } from '@/models/types'

export default function RoutesPage() {
  const { user, refreshUser } = useAuth()
  const { tenantId, currency } = useTenant()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [routes, setRoutes] = useState<Route[]>([])
  const [cobradores, setCobradores] = useState<User[]>([])
  // Catálogo de Oficinas de la empresa (para el selector y las etiquetas). NO
  // decide qué rutas se ven: eso lo sigue haciendo `filterAccessibleRoutes`.
  const [offices, setOffices] = useState<Office[]>([])
  // Filtro de listado por Oficina. Solo ESTRECHA lo que ya es accesible.
  const [officeFilter, setOfficeFilter] = useState(ALL_OFFICES)
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
    nombre: '', ciudad: '', cobradorId: '', officeId: '', adminIds: [] as string[],
    // BORRADOR de asignaciones de usuarios (edición): NO persiste hasta "Actualizar".
    assignedUserIds: [] as string[],
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0,
  })
  // Dirty-state: snapshot original al abrir vs draft actual (para confirmar descarte).
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dirty = useDirtyForm(original, form)

  // Administradores activos del tenant. El Administrador responsable es OPCIONAL al
  // crear la ruta: su ausencia ya NO bloquea nada, solo se avisa (se puede asignar
  // después desde el editor de ruta o desde Gestión de usuarios).
  const activeAdmins = allUsers.filter(u => u.rol === 'admin' && u.status === 'activo')
  const hasActiveAdmin = activeAdmins.length > 0
  // Administradores que el actor puede fijar como responsables al crear:
  // Super Admin → todos los activos; Administrador → solo él mismo (no gestiona otros admin).
  const selectableAdmins = user?.rol === 'superadmin' ? activeAdmins : activeAdmins.filter(a => a.id === user?.id)
  // El Administrador creador SIEMPRE queda dentro de la ruta que crea: su acceso es
  // fail-closed por rutas, así que quedarse fuera sería auto-bloquearse. El servicio
  // revalida esta autoasignación (no depende de la pantalla).
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

  /**
   * ENLACES PROFUNDOS desde el panel de una Oficina, para REUTILIZAR este mismo
   * formulario en vez de duplicarlo:
   *   · `?nueva=1&officeId=<id>` → abre "Nueva ruta" con esa Oficina preseleccionada.
   *   · `?editar=<routeId>`      → abre el editor de esa ruta.
   * Los parámetros se consumen una sola vez (se limpian de la URL) para que un
   * refresco no vuelva a abrir el modal. La pantalla sigue funcionando igual si se
   * entra directamente a /admin/routes sin parámetros.
   */
  useEffect(() => {
    if (loading) return
    const nueva = searchParams.get('nueva')
    const editar = searchParams.get('editar')
    const office = searchParams.get('officeId')

    // Contexto de Oficina desde su panel: preselecciona el filtro del listado.
    // Se valida contra el catálogo; un id inválido se ignora sin ampliar nada.
    if (office) setOfficeFilter(resolveOfficeParam(office, offices))

    if (!nueva && !editar) {
      if (office) setSearchParams({}, { replace: true })
      return
    }

    if (nueva) {
      openCreate(searchParams.get('officeId') ?? undefined)
    } else if (editar) {
      const route = routes.find(r => r.id === editar)
      // Si la ruta no está entre las accesibles no se abre nada: el enlace no puede
      // servir de atajo para editar una ruta fuera de alcance.
      if (route) openEdit(route)
      else toast.error('No tienes acceso a esa ruta.')
    }
    setSearchParams({}, { replace: true })
  }, [loading, routes, offices, searchParams])

  async function load() {
    setLoading(true)
    const all = await db.routes.where('tenantId').equals(tenantId).toArray()
    // RESTRICCIÓN POR RUTAS: el Administrador solo ve sus rutas autorizadas.
    const rts = filterAccessibleRoutes(user, all)
    setRoutes(rts)
    setOffices(await db.offices.where('tenantId').equals(tenantId).toArray())
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

  function openCreate(officePreseleccionada?: string) {
    setEditing(null)
    // El Administrador creador queda preseleccionado (y bloqueado): se autoasigna.
    const preselect = user?.rol === 'admin' && user?.id ? [user.id] : []
    // Si el listado está filtrado por una Oficina concreta, se propone esa (sigue
    // siendo opcional: puede dejarse en "Sin Oficina").
    // Preselección: la que llegue por parámetro (al venir desde una Oficina) o,
    // si no, la del filtro activo del listado. Sigue siendo modificable y opcional.
    const officePorDefecto = officePreseleccionada && offices.some(o => o.id === officePreseleccionada)
      ? officePreseleccionada
      : (officeFilter !== ALL_OFFICES && offices.some(o => o.id === officeFilter) ? officeFilter : '')
    const init = { nombre: '', ciudad: '', cobradorId: '', officeId: officePorDefecto, adminIds: preselect, assignedUserIds: [], tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0 }
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
      cobradorId: route.cobradorId ?? '', officeId: route.officeId ?? '', adminIds: [] as string[], assignedUserIds,
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
  // RETIRO de un cobrador: se valida EN EL INSTANTE del clic. Si es el último cobrador
  // o el responsable (con otros), NO se modifica el borrador y se avisa con un toast.
  function toggleAssignUser(id: string) {
    const u = allUsers.find(x => x.id === id)
    const removing = form.assignedUserIds.includes(id)
    if (removing && u?.rol === 'cobrador') {
      const cobradoresAsignados = form.assignedUserIds.filter(x => allUsers.find(y => y.id === x)?.rol === 'cobrador')
      const block = cobradorRemovalBlock({
        isCobrador: true,
        assignedCobradorIds: cobradoresAsignados,
        responsibleId: form.cobradorId || undefined,
        userId: id,
      })
      if (block) { toast.error(COBRADOR_REMOVAL_MESSAGE[block]); return }  // borrador intacto
    }
    setForm(f => {
      const assigned = removing ? f.assignedUserIds.filter(x => x !== id) : [...f.assignedUserIds, id]
      // Al AGREGAR un cobrador cuando aún no hay responsable, se vuelve responsable
      // (un único cobrador asignado es, por definición, el responsable de la ruta).
      // Al RETIRAR al responsable (permitido si era el último), la ruta queda SIN
      // Cobrador: estado válido, se limpia el responsable en vez de bloquear.
      let cobradorId = f.cobradorId
      if (!removing && u?.rol === 'cobrador' && !f.cobradorId) cobradorId = id
      if (removing && id === f.cobradorId) cobradorId = ''
      return { ...f, assignedUserIds: assigned, cobradorId }
    })
  }

  // Cambiar el Cobrador RESPONSABLE (borrador). Si el elegido aún no está asignado, se
  // agrega automáticamente al conjunto de asignados (el responsable siempre es miembro).
  function setResponsible(id: string) {
    setForm(f => ({
      ...f,
      cobradorId: id,
      assignedUserIds: id && !f.assignedUserIds.includes(id) ? [...f.assignedUserIds, id] : f.assignedUserIds,
    }))
  }

  function toggleAdmin(id: string) {
    if (lockAdminToSelf) return // el Administrador solo se asigna a sí mismo
    setForm(f => ({ ...f, adminIds: f.adminIds.includes(id) ? f.adminIds.filter(x => x !== id) : [...f.adminIds, id] }))
  }

  // Usuarios que el actor puede asignar a la ruta (jerarquía).
  const assignableToRoutes = allUsers.filter(isAssignable)
  // Cobradores válidos para responsable: activos del tenant (+ el actual si quedó inactivo).
  const responsibleOptions = cobradores.filter(c => c.status === 'activo' || c.id === form.cobradorId)
  // Cobradores del BORRADOR (edición: membresía; creación: solo el responsable elegido).
  const draftCobradorIds = form.assignedUserIds.filter(id => allUsers.find(u => u.id === id)?.rol === 'cobrador')
  // ADVERTENCIAS, NO BLOQUEOS: la ruta se crea/guarda igual sin responsables. Solo se
  // informa qué implica (sin Administrador nadie aprueba; sin Cobrador no hay cobro).
  /**
   * Administradores que tendrá la ruta DESPUÉS de guardar.
   *
   * No se mira solo el borrador: un Administrador no puede gestionar a otros
   * Administradores, así que el borrador de un actor Admin nunca los contiene y
   * mirarlo daba el falso «quedará sin Administrador» aunque no se tocara nada.
   * Los admins fuera del alcance del actor conservan su asignación porque el
   * guardado (`computeRouteAssignmentDiff`) solo retira dentro de `assignableUserIds`.
   */
  const effectiveAdminIds = editing
    ? effectiveAdminIdsAfterSave({
        routeId: editing.id,
        users: allUsers,
        assignableUserIds: assignableToRoutes.map(u => u.id),
        draftAssignedUserIds: form.assignedUserIds,
        tenantId,
      })
    : (lockAdminToSelf && user ? [user.id] : form.adminIds)

  const assignmentWarnings = routeAssignmentWarnings({
    hasOffice: !!form.officeId,
    hasAdmin: effectiveAdminIds.length > 0,
    hasCobrador: routeCanOperateCollection({ assignedCobradorIds: draftCobradorIds, cobradorId: form.cobradorId || undefined }),
    mode: editing ? 'edit' : 'create',
  })
  /** ¿La ruta YA GUARDADA tiene operación de cobro? (fuente única + responsable legado). */
  const routeHasCobrador = (route: Route) => routeCanOperateCollection({
    assignedCobradorIds: allUsers.filter(u => u.rol === 'cobrador' && getAssignedRouteIds(u).includes(route.id)).map(u => u.id),
    cobradorId: route.cobradorId,
  })
  // Asignables agrupados por rol (orden Administrador→…→Secretario; alfabético dentro de cada rol).
  const assignableGroups = ASSIGNMENT_ROLE_ORDER
    .map(g => ({ ...g, list: assignableToRoutes.filter(u => u.rol === g.rol).sort((a, b) => a.nombre.localeCompare(b.nombre)) }))
    .filter(g => g.list.length > 0)

  async function handleSave(force = false) {
    if (!user) return
    if (!form.nombre) { toast.error('El nombre de la ruta es obligatorio'); return }
    // CREACIÓN LIBRE: ni el Administrador ni el Cobrador son obligatorios. Una ruta
    // sin responsables se crea igual (queda "pendiente de asignación") y solo se
    // muestran advertencias. Lo único que se valida es la COHERENCIA del responsable
    // designado, si lo hay. El servicio revalida lo mismo (rollback).
    const inv = validateCobradorInvariant({
      routeTenantId: tenantId,
      assignedUserIds: form.assignedUserIds,
      cobradorId: form.cobradorId || undefined,
      userById: (id) => allUsers.find(u => u.id === id),
    })
    if (editing && !inv.ok) { toast.error(inv.message); return }
    // Confirmación al Actualizar: solo si el guardado REALMENTE deja la ruta ACTIVA
    // sin ningún Administrador efectivo. Antes se comparaba el borrador (que nunca
    // contiene admins cuando el actor es Administrador) contra los previos, y por eso
    // la advertencia saltaba en falso al editar una ruta que sí tenía Administrador.
    if (editing && !force) {
      const confirmar = shouldConfirmRouteWithoutAdmin({
        routeStatus: editing.status,
        adminIdsBefore: routeAdmins(allUsers, editing.id, tenantId).map(a => a.id),
        effectiveAdminIdsAfterSave: effectiveAdminIds,
      })
      if (confirmar) { setNoAdminConfirm(true); return }
    }
    setSaving(true)
    try {
      if (editing) {
        // ÚNICO punto de persistencia: todo (generales + cobrador + asignaciones) en una transacción.
        await updateRouteWithAssignments({
          routeId: editing.id, tenantId, nombre: form.nombre, ciudad: form.ciudad,
          tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre, montoMaximoPrestamo: form.montoMaximoPrestamo,
          cobradorId: form.cobradorId || undefined,
          officeId: form.officeId || undefined,
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
          officeId: form.officeId || undefined,
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


  // Filtro por fecha de creación de la ruta. No afecta los cálculos financieros
  // (Base actual / Cartera Activa son saldos a la fecha), solo qué rutas se listan.
  const visibleRoutes = filterRoutesByOffice(routes, officeFilter).filter(r => {
    const fecha = (r.createdAt ?? '').slice(0, 10)
    return (!desde || fecha >= desde) && (!hasta || fecha <= hasta)
  })
  /** Nombre de la Oficina de una ruta (o "Sin Oficina"). Nunca lanza. */
  const officeNameOf = (route: Route) =>
    route.officeId ? (offices.find(o => o.id === route.officeId)?.nombre ?? route.officeId) : NO_OFFICE_LABEL
  const officeInactivaDe = (route: Route) =>
    !!route.officeId && offices.find(o => o.id === route.officeId)?.status === 'inactiva'

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Rutas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{visibleRoutes.length} de {routes.length} ruta(s)</p>
        </div>
        {/* Crear ruta NO depende de responsables: ni Administrador ni Cobrador. */}
        <Button onClick={() => openCreate()} icon={<Plus className="w-4 h-4" />}>Nueva ruta</Button>
      </div>

      {/* Aviso INFORMATIVO (no bloquea): sin Administradores la ruta se crea igual,
          pero conviene asignar uno para que alguien pueda aprobar solicitudes. */}
      {!loading && !hasActiveAdmin && (
        <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-800 font-medium">Aún no hay Administradores en la empresa.</p>
            <p className="text-xs text-amber-700 mt-0.5">Puedes crear la ruta igualmente (no se exige ningún responsable) y asignarle un Administrador más adelante.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => navigate('/admin/users')} icon={<Users className="w-3.5 h-3.5" />}>Crear Administrador</Button>
          </div>
        </div>
      )}

      {/* Filtros: Oficina (agrupación) + fecha de creación. El de Oficina SOLO
          estrecha las rutas que el usuario ya tiene autorizadas. */}
      <div className="flex flex-wrap items-end gap-3">
        <OfficeSelector
          offices={offices}
          value={officeFilter}
          onChange={setOfficeFilter}
          includeUnassigned={routes.some(r => !r.officeId)}
        />
        <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta}
          onClear={() => { setDesde(''); setHasta('') }} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : routes.length === 0 ? (
        <EmptyState icon={<MapPin className="w-8 h-8" />} title="No hay rutas" description="Crea una ruta para empezar" action={<Button onClick={() => openCreate()} icon={<Plus className="w-4 h-4" />}>Crear ruta</Button>} />
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
                  <p className={`text-xs ml-6 mt-0.5 font-medium ${route.officeId ? 'text-gray-500' : 'text-gray-400'}`}>
                    <Building2 className="w-3 h-3 inline-block mr-1 -mt-0.5" />{officeNameOf(route)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant={route.status === 'activa' ? 'success' : 'gray'}>
                    {route.status === 'activa' ? 'Activa' : 'Inactiva'}
                  </Badge>
                  {/* Ruta válida pero PENDIENTE DE ASIGNACIÓN: existe, no opera cobros. */}
                  {officeInactivaDe(route) && (
                    <span title="Esta ruta pertenece a una Oficina inactiva. No se pueden registrar nuevas operaciones; la consulta histórica sigue disponible.">
                      <Badge variant="danger">Oficina inactiva</Badge>
                    </span>
                  )}
                  {!routeHasCobrador(route) && (
                    <span title={ROUTE_NO_COBRADOR_OPERATION_MESSAGE}>
                      <Badge variant="warning">{ROUTE_NO_COBRADOR_LABEL}</Badge>
                    </span>
                  )}
                </div>
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

              {/* Usuarios asignados — fuente única authorizedRouteIds (coherente con
                  el editor y con Usuarios). Ya NO se lee solo route.cobradorId. */}
              <div className="border-t border-gray-50 pt-2">
                <RouteAssignedUsers users={allUsers} routeId={route.id} tenantId={tenantId} responsibleCobradorId={route.cobradorId} />
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

          {/* OFICINA: OPCIONAL, tanto al crear como al editar. Cambiarla aquí MUEVE la
              ruta de Oficina: una sola escritura sobre la ruta, sin tocar clientes,
              ventas ni pagos (todos derivan la Oficina por su ruta). */}
          <div>
            <Select
              label="Oficina"
              value={form.officeId}
              onChange={e => setForm(f => ({ ...f, officeId: e.target.value }))}
              options={offices.map(o => ({
                value: o.id,
                label: o.status === 'inactiva' ? `${o.nombre} (inactiva)` : (o.codigo ? `${o.nombre} · ${o.codigo}` : o.nombre),
              }))}
              placeholder={`${NO_OFFICE_LABEL} (opcional)`}
              hint={offices.length === 0
                ? 'Aún no hay Oficinas. La ruta se creará sin Oficina; podrás asignarle una más adelante.'
                : (editing ? 'Cambiar la Oficina solo reagrupa la ruta: no altera clientes, ventas ni pagos.' : undefined)}
            />
          </div>

          {/* Administrador responsable: OPCIONAL al crear. El Super Admin puede elegir
              uno, varios o ninguno; el Administrador queda SIEMPRE autoasignado (si no,
              se auto-bloquearía por el fail-closed de rutas). */}
          {!editing && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Administrador responsable <span className="text-xs font-normal text-gray-400">(opcional)</span>
              </label>
              {lockAdminToSelf ? (
                <div className="flex items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-700">
                  <Users className="w-4 h-4" /> {user?.nombre} <span className="text-xs text-primary-400">(se asigna automáticamente)</span>
                </div>
              ) : selectableAdmins.length === 0 ? (
                <p className="text-xs text-gray-500">No hay Administradores activos. La ruta se creará sin Administrador; podrás asignarle uno más adelante.</p>
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
              {!lockAdminToSelf && selectableAdmins.length > 0 && form.adminIds.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">Sin Administrador asignado. La ruta se creará igualmente; recuerda que nadie podrá aprobar solicitudes de esta ruta hasta que le asignes uno.</p>
              )}
            </div>
          )}

          {/* Cobrador RESPONSABLE: OPCIONAL. Se puede dejar vacío y asignarlo después;
              al elegir uno no asignado, se agrega automáticamente al borrador de
              asignados. Solo lista cobradores válidos. */}
          <div>
            <Select label="Cobrador responsable" value={form.cobradorId} onChange={e => setResponsible(e.target.value)}
              options={responsibleOptions.map(c => ({ value: c.id, label: c.status === 'activo' ? c.nombre : `${c.nombre} (inactivo)` }))}
              placeholder={`${ROUTE_NO_COBRADOR_LABEL} (opcional)`}
              hint={responsibleOptions.length === 0 ? 'No hay Cobradores activos. La ruta se creará sin Cobrador; podrás asignarle uno más adelante.' : undefined} />
          </div>
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

          {/* Usuarios asignados a esta ruta — BORRADOR: no persiste hasta "Actualizar".
              Agrupado por rol (Administrador→Socio→Supervisor→Cobrador→Secretario).
              En Cobradores: el responsable se marca "Responsable"; el resto "Asignado". */}
          {editing && (
            <div className="pt-3 border-t border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-gray-500" />
                <label className="text-sm font-medium text-gray-700">Usuarios asignados a esta ruta</label>
              </div>
              {assignableGroups.length === 0 ? (
                <p className="text-xs text-gray-400">No hay usuarios que puedas asignar.</p>
              ) : (
                <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                  {assignableGroups.map(g => (
                    <div key={g.key} className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{g.plural}</p>
                      {g.list.map(u => {
                        const member = form.assignedUserIds.includes(u.id)   // ← lee del BORRADOR
                        const isResp = g.rol === 'cobrador' && member && u.id === form.cobradorId
                        const tag = !member ? 'Asignar' : isResp ? 'Responsable' : 'Asignado'
                        return (
                          <button key={u.id} type="button" onClick={() => toggleAssignUser(u.id)}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${member ? 'bg-primary-50 border-primary-200' : 'bg-white border-gray-200 hover:bg-gray-50'}`}>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-800 truncate">{u.nombre}</p>
                              <p className="text-xs text-gray-400">{ROLE_LABELS[u.rol]}{g.rol === 'cobrador' && member ? ` · ${isResp ? 'Responsable' : 'Asignado'}` : ''}{u.status !== 'activo' ? ' · inactivo' : ''}</p>
                            </div>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${isResp ? 'bg-amber-500 text-white' : member ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                              {tag}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ADVERTENCIAS (no bloquean): responsables ausentes. El botón Crear /
              Actualizar sigue habilitado; la ruta queda "pendiente de asignación". */}
          {assignmentWarnings.length > 0 && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
              <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
              <ul className="space-y-1">
                {assignmentWarnings.map(w => (
                  <li key={w} className="text-xs text-amber-800">{w}</li>
                ))}
              </ul>
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
