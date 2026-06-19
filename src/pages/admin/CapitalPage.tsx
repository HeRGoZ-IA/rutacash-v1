import { useState, useEffect } from 'react'
import { Plus, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { CapitalMovement, Route } from '@/models/types'

export default function CapitalPage() {
  const { tenantId, officeId } = useTenant()
  const { user } = useAuth()
  const [movements, setMovements] = useState<CapitalMovement[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeId: '', valor: 0, descripcion: '', fecha: today(), tipo: 'ingresoCapital' as const })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [movs, rts] = await Promise.all([
      db.capitalMovements.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setMovements(movs.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(rts)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.routeId || form.valor <= 0) { toast.error('Selecciona ruta y valor'); return }
    setSaving(true)
    try {
      const mov: CapitalMovement = {
        id: generateId(), tenantId, officeId: routes.find(r => r.id === form.routeId)?.officeId ?? officeId,
        routeId: form.routeId, tipo: form.tipo, valor: form.valor,
        descripcion: form.descripcion, fecha: form.fecha, userId: user?.id ?? '', createdAt: nowISO(),
      }
      await db.capitalMovements.add(mov)
      toast.success('Capital registrado')
      setModalOpen(false)
      setForm({ routeId: '', valor: 0, descripcion: '', fecha: today(), tipo: 'ingresoCapital' })
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  const capitalByRoute = routes.map(r => ({
    route: r,
    total: movements.filter(m => m.routeId === r.id).reduce((s, m) => s + m.valor, 0)
  }))

  const getRouteName = (id: string) => routes.find(r => r.id === id)?.nombre ?? id

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Capital / Base</h1><p className="text-sm text-gray-500 mt-0.5">{movements.length} movimiento(s)</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Inyectar capital</Button>
      </div>

      {/* Summary by route */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {capitalByRoute.map(({ route, total }) => (
          <div key={route.id} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
            <p className="text-xs text-gray-500 truncate">{route.nombre}</p>
            <p className="text-xl font-bold text-primary-600 mt-1">{formatCurrency(total)}</p>
            <p className="text-xs text-gray-400 mt-0.5">Capital acumulado</p>
          </div>
        ))}
      </div>

      {/* Movements list */}
      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-700">Historial de movimientos</h3></div>
        {movements.length === 0 ? (
          <div className="flex justify-center py-12 text-gray-400 text-sm">No hay movimientos</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {movements.map(m => (
              <div key={m.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center">
                    <DollarSign className="w-4 h-4 text-primary-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{getRouteName(m.routeId)}</p>
                    <p className="text-xs text-gray-400">{m.descripcion || m.tipo} · {formatDate(m.fecha)}</p>
                  </div>
                </div>
                <span className="text-sm font-bold text-emerald-600">+{formatCurrency(m.valor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Inyectar capital"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
            options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          <Input label="Valor" type="number" value={form.valor || ''} onChange={e => setForm(f => ({ ...f, valor: Number(e.target.value) }))} required />
          <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
