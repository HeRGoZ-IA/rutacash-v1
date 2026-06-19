import { useState, useEffect } from 'react'
import { Plus, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { Withdrawal, Route } from '@/models/types'

export default function WithdrawalsPage() {
  const { tenantId, officeId } = useTenant()
  const { user } = useAuth()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeId: '', valor: 0, descripcion: '', fecha: today() })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [ws, rts] = await Promise.all([
      db.withdrawals.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setWithdrawals(ws.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(rts)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.routeId || form.valor <= 0) { toast.error('Ruta y valor requeridos'); return }
    setSaving(true)
    try {
      const w: Withdrawal = {
        id: generateId(), tenantId, officeId: routes.find(r => r.id === form.routeId)?.officeId ?? officeId,
        routeId: form.routeId, valor: form.valor, descripcion: form.descripcion,
        fecha: form.fecha, userId: user?.id ?? '', createdAt: nowISO(),
      }
      await db.withdrawals.add(w)
      toast.success('Retiro registrado')
      setModalOpen(false)
      setForm({ routeId: '', valor: 0, descripcion: '', fecha: today() })
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  const getRouteName = (id: string) => routes.find(r => r.id === id)?.nombre ?? id
  const total = withdrawals.reduce((s, w) => s + w.valor, 0)

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Retiros</h1><p className="text-sm text-gray-500 mt-0.5">Total: {formatCurrency(total)}</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nuevo retiro</Button>
      </div>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {withdrawals.length === 0 ? (
          <div className="flex justify-center py-12 text-gray-400 text-sm">No hay retiros</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {withdrawals.map(w => (
              <div key={w.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center">
                    <Wallet className="w-4 h-4 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{getRouteName(w.routeId)}</p>
                    <p className="text-xs text-gray-400">{w.descripcion || 'Retiro'} · {formatDate(w.fecha)}</p>
                  </div>
                </div>
                <span className="text-sm font-bold text-amber-600">-{formatCurrency(w.valor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Registrar retiro"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
            options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Valor" type="number" value={form.valor || ''} onChange={e => setForm(f => ({ ...f, valor: Number(e.target.value) }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
