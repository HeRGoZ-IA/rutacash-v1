import { useState, useEffect } from 'react'
import { Plus, MapPin, Users, DollarSign, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { formatCurrency, nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import type { Route, Office, User } from '@/models/types'

export default function RoutesPage() {
  const { user } = useAuth()
  const { tenantId, officeId } = useTenant()
  const [routes, setRoutes] = useState<Route[]>([])
  const [offices, setOffices] = useState<Office[]>([])
  const [cobradores, setCobradores] = useState<User[]>([])
  const [salesCounts, setSalesCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Route | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Route | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    nombre: '', codigo: '', ciudad: '', officeId: '', cobradorId: '',
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0,
  })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const allOffices = await db.offices.where('tenantId').equals(tenantId).toArray()
    setOffices(allOffices)
    let rts = await db.routes.where('tenantId').equals(tenantId).toArray()
    if (officeId) rts = rts.filter(r => r.officeId === officeId)
    setRoutes(rts)
    const cobs = await db.users.where('tenantId').equals(tenantId).and(u => u.rol === 'cobrador').toArray()
    setCobradores(cobs)
    const sc: Record<string, number> = {}
    for (const r of rts) {
      sc[r.id] = await db.sales.where('routeId').equals(r.id).and(s => s.status === 'activa').count()
    }
    setSalesCounts(sc)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    const firstOffice = offices[0]?.id ?? ''
    setForm({ nombre: '', codigo: '', ciudad: '', officeId: officeId || firstOffice, cobradorId: '', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0 })
    setModalOpen(true)
  }

  function openEdit(route: Route) {
    setEditing(route)
    setForm({
      nombre: route.nombre, codigo: route.codigo, ciudad: route.ciudad ?? '', officeId: route.officeId,
      cobradorId: route.cobradorId ?? '', tasaInteres: route.tasaInteres, tasaLibre: route.tasaLibre,
      montoMaximoPrestamo: route.montoMaximoPrestamo, capitalInicial: route.capitalInicial,
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre || !form.officeId) { toast.error('Nombre y oficina son obligatorios'); return }
    setSaving(true)
    try {
      if (editing) {
        await db.routes.update(editing.id, {
          nombre: form.nombre, codigo: form.codigo, ciudad: form.ciudad,
          officeId: form.officeId, cobradorId: form.cobradorId || undefined,
          tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre,
          montoMaximoPrestamo: form.montoMaximoPrestamo, updatedAt: nowISO(),
        })
        toast.success('Ruta actualizada')
      } else {
        const route: Route = {
          id: generateId(), tenantId, officeId: form.officeId,
          nombre: form.nombre, codigo: form.codigo || `R-${Date.now()}`,
          ciudad: form.ciudad, tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre,
          montoMaximoPrestamo: form.montoMaximoPrestamo, capitalInicial: form.capitalInicial,
          capitalActual: form.capitalInicial, cobradorId: form.cobradorId || undefined,
          status: 'activa', createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.routes.add(route)
        if (form.capitalInicial > 0) {
          await db.capitalMovements.add({
            id: generateId(), tenantId, officeId: form.officeId, routeId: route.id,
            tipo: 'ingresoCapital', valor: form.capitalInicial,
            descripcion: 'Capital inicial', fecha: new Date().toISOString().slice(0, 10),
            userId: 'system', createdAt: nowISO(),
          })
        }
        toast.success('Ruta creada')
      }
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function toggleStatus(route: Route) {
    const newStatus = route.status === 'activa' ? 'inactiva' : 'activa'
    await db.routes.update(route.id, { status: newStatus, updatedAt: nowISO() })
    toast.success(`Ruta ${newStatus === 'activa' ? 'activada' : 'desactivada'}`)
    await load()
  }

  async function requestDelete(route: Route) {
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
  const getOfficeName = (id: string) => offices.find(o => o.id === id)?.nombre ?? id

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Rutas</h1>
          <p className="text-sm text-gray-500 mt-0.5">{routes.length} ruta(s)</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva ruta</Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
        </div>
      ) : routes.length === 0 ? (
        <EmptyState icon={<MapPin className="w-8 h-8" />} title="No hay rutas" description="Crea una ruta para empezar" action={<Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Crear ruta</Button>} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {routes.map((route) => (
            <Card key={route.id} className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <MapPin className="w-4 h-4 text-primary-500" />
                    <h3 className="font-semibold text-gray-900 text-sm">{route.nombre}</h3>
                  </div>
                  <p className="text-xs text-gray-400 ml-6">{route.codigo} · {getOfficeName(route.officeId)}</p>
                </div>
                <Badge variant={route.status === 'activa' ? 'success' : 'gray'}>
                  {route.status === 'activa' ? 'Activa' : 'Inactiva'}
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-base font-bold text-primary-600">{salesCounts[route.id] ?? 0}</p>
                  <p className="text-xs text-gray-400">Ventas</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-base font-bold text-emerald-600">{route.tasaInteres}%</p>
                  <p className="text-xs text-gray-400">Tasa</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-xs font-bold text-amber-600 truncate">{formatCurrency(route.montoMaximoPrestamo)}</p>
                  <p className="text-xs text-gray-400">Máx.</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  {getCobradorName(route.cobradorId) ?? <span className="text-amber-500">Sin cobrador</span>}
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <DollarSign className="w-3.5 h-3.5 text-gray-400" />
                  Capital: {formatCurrency(route.capitalInicial)}
                </div>
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

      {/* Create / Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar ruta' : 'Nueva ruta'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Nombre de la ruta" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
            <Input label="Código" value={form.codigo} onChange={e => setForm(f => ({ ...f, codigo: e.target.value }))} placeholder="RN-001" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Oficina" value={form.officeId} onChange={e => setForm(f => ({ ...f, officeId: e.target.value }))}
              options={offices.map(o => ({ value: o.id, label: o.nombre }))} required />
            <Select label="Cobrador" value={form.cobradorId} onChange={e => setForm(f => ({ ...f, cobradorId: e.target.value }))}
              options={cobradores.map(c => ({ value: c.id, label: c.nombre }))} placeholder="Sin asignar" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Tasa de interés (%)" type="number" value={form.tasaInteres} onChange={e => setForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} min={0} max={100} />
            <Input label="Monto máx. préstamo" type="number" value={form.montoMaximoPrestamo} onChange={e => setForm(f => ({ ...f, montoMaximoPrestamo: Number(e.target.value) }))} />
          </div>
          {!editing && (
            <Input label="Capital inicial" type="number" value={form.capitalInicial} onChange={e => setForm(f => ({ ...f, capitalInicial: Number(e.target.value) }))} hint="Se registrará como movimiento de capital" />
          )}
          <div className="flex items-center gap-3">
            <input type="checkbox" id="tasaLibre" checked={form.tasaLibre} onChange={e => setForm(f => ({ ...f, tasaLibre: e.target.checked }))} className="w-4 h-4 text-primary-600" />
            <label htmlFor="tasaLibre" className="text-sm text-gray-700">Tasa libre (el cobrador puede variar la tasa)</label>
          </div>
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
