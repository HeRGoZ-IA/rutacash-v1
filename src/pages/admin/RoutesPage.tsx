import { useState, useEffect } from 'react'
import { Plus, MapPin, Users, DollarSign, Edit, ToggleLeft, ToggleRight, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { formatCurrency, nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { assignCobradorToRoute } from '@/services/routeAssignment'
import type { Route, User, RouteFinancialSummary } from '@/models/types'

export default function RoutesPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [routes, setRoutes] = useState<Route[]>([])
  const [cobradores, setCobradores] = useState<User[]>([])
  const [summaryByRoute, setSummaryByRoute] = useState<Record<string, RouteFinancialSummary>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Route | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Route | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    nombre: '', ciudad: '', cobradorId: '',
    tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0,
  })

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
    const rts = await db.routes.where('tenantId').equals(tenantId).toArray()
    setRoutes(rts)
    const cobs = await db.users.where('tenantId').equals(tenantId).and(u => u.rol === 'cobrador').toArray()
    setCobradores(cobs)
    const sum: Record<string, RouteFinancialSummary> = {}
    for (const r of rts) {
      sum[r.id] = await getRouteFinancialSummary(r.id)
    }
    setSummaryByRoute(sum)
    setLoading(false)
  }

  function openCreate() {
    setEditing(null)
    setForm({ nombre: '', ciudad: '', cobradorId: '', tasaInteres: 20, tasaLibre: false, montoMaximoPrestamo: 500000, capitalInicial: 0 })
    setModalOpen(true)
  }

  function openEdit(route: Route) {
    setEditing(route)
    setForm({
      nombre: route.nombre, ciudad: route.ciudad ?? '',
      cobradorId: route.cobradorId ?? '', tasaInteres: route.tasaInteres, tasaLibre: route.tasaLibre,
      montoMaximoPrestamo: route.montoMaximoPrestamo, capitalInicial: route.capitalInicial,
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.nombre) { toast.error('El nombre de la ruta es obligatorio'); return }
    setSaving(true)
    try {
      if (editing) {
        // No tocamos cobradorId aquí: lo sincroniza assignCobradorToRoute (lee el previo).
        await db.routes.update(editing.id, {
          nombre: form.nombre, ciudad: form.ciudad,
          tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre,
          montoMaximoPrestamo: form.montoMaximoPrestamo, updatedAt: nowISO(),
        })
        await assignCobradorToRoute(editing.id, form.cobradorId || undefined)
        toast.success('Ruta actualizada')
      } else {
        const route: Route = {
          id: generateId(), tenantId, officeId: '',
          nombre: form.nombre, codigo: nextRouteCode(routes),
          ciudad: form.ciudad, tasaInteres: form.tasaInteres, tasaLibre: form.tasaLibre,
          montoMaximoPrestamo: form.montoMaximoPrestamo, capitalInicial: form.capitalInicial,
          capitalActual: form.capitalInicial, cobradorId: undefined,
          status: 'activa', createdAt: nowISO(), updatedAt: nowISO(),
        }
        await db.routes.add(route)
        // Vincula el cobrador (y su ruta principal) de forma consistente.
        if (form.cobradorId) await assignCobradorToRoute(route.id, form.cobradorId)
        if (form.capitalInicial > 0) {
          await db.capitalMovements.add({
            id: generateId(), tenantId, officeId: '', routeId: route.id,
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
                  <p className="text-xs text-gray-400">Cartera en calle</p>
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

      {/* Create / Edit modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar ruta' : 'Nueva ruta'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Nombre de la ruta" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
            <Input label="Ciudad" value={form.ciudad} onChange={e => setForm(f => ({ ...f, ciudad: e.target.value }))} placeholder="Ej: Barranquilla" />
          </div>
          {editing && <p className="text-xs text-gray-400">Código de ruta: <span className="font-medium text-gray-600">{editing.codigo}</span></p>}
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
