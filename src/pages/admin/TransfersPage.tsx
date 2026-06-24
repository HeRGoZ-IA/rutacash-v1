import { useState, useEffect } from 'react'
import { Plus, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { Transfer, Route } from '@/models/types'

export default function TransfersPage() {
  const { tenantId, officeId, currency } = useTenant()
  const { user } = useAuth()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeOrigenId: '', routeDestinoId: '', valor: 0, descripcion: '', fecha: today() })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [ts, rts] = await Promise.all([
      db.transfers.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setTransfers(ts.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(rts)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.routeOrigenId || form.valor <= 0) { toast.error('Origen y valor requeridos'); return }
    if (form.routeOrigenId === form.routeDestinoId) { toast.error('Origen y destino no pueden ser iguales'); return }
    setSaving(true)
    try {
      const t: Transfer = {
        id: generateId(), tenantId, officeId,
        routeOrigenId: form.routeOrigenId, routeDestinoId: form.routeDestinoId || undefined,
        valor: form.valor, descripcion: form.descripcion, fecha: form.fecha,
        userId: user?.id ?? '', createdAt: nowISO(),
      }
      await db.transfers.add(t)
      toast.success('Transferencia registrada')
      setModalOpen(false)
      setForm({ routeOrigenId: '', routeDestinoId: '', valor: 0, descripcion: '', fecha: today() })
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  const getRouteName = (id?: string) => id ? (routes.find(r => r.id === id)?.nombre ?? id) : 'Externo/Socio'
  const officeRoutes = routes
  const visibleTransfers = transfers

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Transferencias</h1><p className="text-sm text-gray-500 mt-0.5">{visibleTransfers.length} transferencia(s)</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva transferencia</Button>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {visibleTransfers.length === 0 ? (
          <div className="flex justify-center py-12 text-gray-400 text-sm">No hay transferencias</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {visibleTransfers.map(t => (
              <div key={t.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center">
                    <ArrowLeftRight className="w-4 h-4 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{getRouteName(t.routeOrigenId)} → {getRouteName(t.routeDestinoId)}</p>
                    <p className="text-xs text-gray-400">{t.descripcion || 'Sin descripción'} · {formatDate(t.fecha)}</p>
                  </div>
                </div>
                <span className="text-sm font-bold text-blue-600">{formatCurrency(t.valor, currency)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nueva transferencia"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Ruta origen" value={form.routeOrigenId} onChange={e => setForm(f => ({ ...f, routeOrigenId: e.target.value }))}
              options={officeRoutes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar origen" required />
            <Select label="Ruta destino" value={form.routeDestinoId} onChange={e => setForm(f => ({ ...f, routeDestinoId: e.target.value }))}
              options={officeRoutes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Externo/Socio" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
