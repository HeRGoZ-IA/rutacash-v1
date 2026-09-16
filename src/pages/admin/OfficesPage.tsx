import { useState, useEffect } from 'react'
import { Plus, Building2, MapPin, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle, LogIn, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { ConfirmDiscardModal } from '@/components/ui/ConfirmDiscardModal'
import { useDirtyForm } from '@/hooks/useDirtyForm'
import { toast } from '@/components/ui/Toast'
import { useNavigate } from 'react-router-dom'
import { db } from '@/lib/db'
import { NO_OFFICE_LABEL } from '@/lib/officeGrouping'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can } from '@/lib/permissions'
import { createOffice, updateOffice, setOfficeStatus, deleteOffice } from '@/services/officeService'
import type { Office, Route } from '@/models/types'

/**
 * GESTIÓN DE OFICINAS — catálogo de agrupación de rutas (Empresa → Oficina → Ruta).
 *
 * Esta pantalla gestiona el CATÁLOGO. No concede ni refleja acceso operativo: ver
 * una Oficina aquí no significa poder entrar a los datos de sus rutas, que siguen
 * dependiendo exclusivamente de `authorizedRouteIds`.
 *
 * Reglas visibles para el usuario:
 *  · Una Oficina puede existir sin rutas.
 *  · Inactivar una Oficina bloquea las operaciones NUEVAS de sus rutas y conserva
 *    intacta la consulta histórica. No desasigna a nadie.
 *  · Eliminar una Oficina NUNCA elimina rutas: quedan "Sin Oficina".
 */
export default function OfficesPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tenantId } = useTenant()
  const [offices, setOffices] = useState<Office[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Office | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Office | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [form, setForm] = useState({ nombre: '', codigo: '' })
  const [original, setOriginal] = useState<Record<string, unknown> | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const dirty = useDirtyForm(original, form)

  const puedeCrear = can(user, 'office.create', { tenantId })
  const puedeEditar = can(user, 'office.edit', { tenantId })
  const puedeEstado = can(user, 'office.changeStatus', { tenantId })
  const puedeEliminar = can(user, 'office.delete', { tenantId })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [ofs, rts] = await Promise.all([
      db.offices.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setOffices(ofs.sort((a, b) => a.nombre.localeCompare(b.nombre)))
    // Todas las rutas de la EMPRESA: el conteo de la tarjeta describe la Oficina,
    // no el acceso del usuario (gestionar el catálogo ≠ ver los datos de sus rutas).
    setRoutes(rts)
    setLoading(false)
  }

  const routesOf = (officeId: string) => routes.filter(r => r.officeId === officeId)

  function openCreate() {
    setEditing(null)
    const init = { nombre: '', codigo: '' }
    setForm(init)
    setOriginal({ ...init })
    setModalOpen(true)
  }

  function openEdit(office: Office) {
    setEditing(office)
    const init = { nombre: office.nombre, codigo: office.codigo ?? '' }
    setForm(init)
    setOriginal({ ...init })
    setModalOpen(true)
  }

  function closeModal() { setModalOpen(false); setDiscardOpen(false); setOriginal(null) }
  function tryCloseModal() { if (dirty) setDiscardOpen(true); else closeModal() }

  async function handleSave() {
    if (!user) return
    if (!form.nombre.trim()) { toast.error('El nombre de la oficina es obligatorio.'); return }
    setSaving(true)
    try {
      if (editing) {
        await updateOffice({ officeId: editing.id, tenantId, nombre: form.nombre, codigo: form.codigo }, user)
        toast.success('Oficina actualizada')
      } else {
        await createOffice({ tenantId, nombre: form.nombre, codigo: form.codigo }, user)
        toast.success('Oficina creada')
      }
      closeModal()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al guardar')
    } finally { setSaving(false) }
  }

  async function toggleStatus(office: Office) {
    if (!user) return
    const status = office.status === 'activa' ? 'inactiva' : 'activa'
    try {
      await setOfficeStatus({ officeId: office.id, tenantId, status }, user)
      toast.success(status === 'inactiva'
        ? `Oficina inactivada. Sus rutas conservan el historial, pero no admiten operaciones nuevas.`
        : `Oficina activada. Sus rutas vuelven a operar con normalidad.`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al cambiar el estado')
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || !user) return
    setDeleting(true)
    try {
      // `detachRoutes` deja las rutas Sin Oficina en la MISMA transacción.
      // Nunca se elimina una ruta, ni sus clientes, ventas o pagos.
      const { detached } = await deleteOffice(
        { officeId: deleteTarget.id, tenantId, detachRoutes: true }, user,
      )
      toast.success(detached.length > 0
        ? `Oficina eliminada. ${detached.length} ruta(s) quedaron Sin Oficina.`
        : 'Oficina eliminada')
      setDeleteTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al eliminar')
    } finally { setDeleting(false) }
  }

  const sinOficina = routes.filter(r => !r.officeId).length

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Oficinas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {offices.length} oficina(s){sinOficina > 0 ? ` · ${sinOficina} ruta(s) sin oficina` : ''}
          </p>
        </div>
        {puedeCrear && <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva oficina</Button>}
      </div>

      <div className="flex items-start gap-3 p-4 rounded-2xl bg-gray-50 border border-gray-200">
        <Building2 className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-gray-600">
          Las oficinas <span className="font-medium">agrupan rutas</span>. No cambian quién puede ver qué:
          el acceso sigue dependiendo de las rutas asignadas a cada usuario. Una ruta puede
          existir sin oficina, y los usuarios pueden trabajar en rutas de oficinas distintas.
        </p>
      </div>

      {/* SIN OFICINA — agrupación DERIVADA (route.officeId === undefined).
          No existe ningún registro Office llamado así: es donde quedaron las rutas
          que ya existían cuando se introdujeron las Oficinas. */}
      {!loading && sinOficina > 0 && (
        <Card className="border-dashed">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                <MapPin className="w-5 h-5 text-gray-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-gray-800 text-sm">{NO_OFFICE_LABEL}</p>
                  <Badge variant="gray">Agrupación</Badge>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {sinOficina} ruta(s) pendiente(s) de organizar ·{' '}
                  <span className="text-gray-400">
                    {routes.filter(r => !r.officeId).slice(0, 3).map(r => r.nombre).join(', ')}
                    {sinOficina > 3 ? ` +${sinOficina - 3} más` : ''}
                  </span>
                </p>
              </div>
            </div>
            <Button variant="secondary" size="sm" icon={<ChevronRight className="w-3.5 h-3.5" />}
              onClick={() => navigate('/admin/offices/sin-oficina')}>
              Organizar rutas
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : offices.length === 0 ? (
        <EmptyState
          icon={<Building2 className="w-8 h-8" />}
          title="No hay oficinas"
          description="Las oficinas son opcionales: puedes crear rutas sin ninguna y agruparlas más adelante."
          action={puedeCrear ? <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Crear oficina</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {offices.map(office => {
            const suyas = routesOf(office.id)
            const activas = suyas.filter(r => r.status === 'activa').length
            return (
              <Card key={office.id} className="space-y-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Building2 className="w-4 h-4 text-primary-500 flex-shrink-0" />
                      <h3 className="font-semibold text-gray-900 text-sm truncate">{office.nombre}</h3>
                    </div>
                    {office.codigo && <p className="text-xs text-gray-400 ml-6">{office.codigo}</p>}
                  </div>
                  <Badge variant={office.status === 'activa' ? 'success' : 'danger'}>
                    {office.status === 'activa' ? 'Activa' : 'Inactiva'}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-primary-50 rounded-xl p-3 text-center">
                    <p className="text-base font-bold text-primary-700">{suyas.length}</p>
                    <p className="text-xs text-gray-400">Rutas</p>
                  </div>
                  <div className="bg-emerald-50 rounded-xl p-3 text-center">
                    <p className="text-base font-bold text-emerald-600">{activas}</p>
                    <p className="text-xs text-gray-400">Rutas activas</p>
                  </div>
                </div>

                <div className="border-t border-gray-50 pt-2">
                  {suyas.length === 0 ? (
                    <p className="text-xs text-gray-400 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" /> Sin rutas asignadas todavía
                    </p>
                  ) : (
                    <p className="text-xs text-gray-600 leading-snug">
                      <span className="font-medium text-gray-500">Rutas: </span>
                      {suyas.slice(0, 3).map(r => r.nombre).join(', ')}
                      {suyas.length > 3 && <span className="text-gray-400"> +{suyas.length - 3} más</span>}
                    </p>
                  )}
                </div>

                {office.status === 'inactiva' && (
                  <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-50 border border-amber-100">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-amber-700">
                      Sus rutas no admiten operaciones nuevas. La consulta histórica y los reportes siguen disponibles.
                    </p>
                  </div>
                )}

                {/* ENTRAR: la Oficina deja de ser un registro de catálogo y pasa a ser
                    una unidad de gestión con su propio panel. */}
                <Button size="sm" className="w-full" icon={<LogIn className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/admin/offices/${office.id}`)}>
                  Entrar
                </Button>

                <div className="flex gap-2 pt-1">
                  {puedeEditar && (
                    <Button variant="secondary" size="sm" onClick={() => openEdit(office)} icon={<Edit className="w-3.5 h-3.5" />} className="flex-1">Editar</Button>
                  )}
                  {puedeEstado && (
                    <Button variant="ghost" size="sm" onClick={() => toggleStatus(office)} className="flex-1"
                      icon={office.status === 'activa' ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />}>
                      {office.status === 'activa' ? 'Inactivar' : 'Activar'}
                    </Button>
                  )}
                  {puedeEliminar && (
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(office)}
                      icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                      className="text-red-400 hover:text-red-600 hover:bg-red-50" />
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Crear / editar */}
      <Modal open={modalOpen} onClose={tryCloseModal} title={editing ? 'Editar oficina' : 'Nueva oficina'} size="sm"
        footer={<><Button variant="secondary" onClick={tryCloseModal} disabled={saving}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre de la oficina" value={form.nombre} required
            onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
            placeholder="Ej: Oficina Leticia" />
          <Input label="Código" value={form.codigo}
            onChange={e => setForm(f => ({ ...f, codigo: e.target.value }))}
            placeholder="Opcional. Ej: LET"
            hint="Opcional. Si lo usas, no puede repetirse dentro de la empresa." />
          <p className="text-xs text-gray-400">
            Una oficina puede crearse vacía: las rutas se le asignan después desde cada ruta.
          </p>
        </div>
      </Modal>

      <ConfirmDiscardModal open={discardOpen} onKeepEditing={() => setDiscardOpen(false)} onDiscard={closeModal} />

      {/* Eliminar: nunca borra rutas */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar oficina" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Oficina: <span className="font-semibold">{deleteTarget?.nombre}</span>
          </p>
          {deleteTarget && routesOf(deleteTarget.id).length > 0 ? (
            <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
              <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-700">
                Sus <span className="font-semibold">{routesOf(deleteTarget.id).length} ruta(s)</span> quedarán
                <span className="font-semibold"> Sin Oficina</span>. No se elimina ninguna ruta, ni sus clientes,
                ventas o pagos, y los usuarios conservan sus asignaciones.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
              <Building2 className="w-5 h-5 text-gray-400 flex-shrink-0" />
              <p className="text-sm text-gray-600">Esta oficina no tiene rutas asignadas.</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
