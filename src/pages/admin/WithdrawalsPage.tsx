import { useState, useEffect } from 'react'
import { Plus, Wallet, ChevronRight, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteAvailableCapital } from '@/services/cashboxEngine'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { Withdrawal, Route, User } from '@/models/types'

// Revisión socio 25-jun — Retiros agrupados por ruta (presentación similar a Capital).
// NO cambia la lógica contable de retiros: solo organiza la vista por ruta.
interface WithdrawalGroup {
  routeId: string
  nombre: string
  codigo: string
  totalRetirado: number
  cantidad: number
  ultimoRetiro?: string
  baseActual: number
  withdrawals: Withdrawal[]
}

export default function WithdrawalsPage() {
  const { tenantId, officeId, currency } = useTenant()
  const { user } = useAuth()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  // Base actual (saldo de caja) real por ruta, recalculada en cada carga.
  const [baseByRoute, setBaseByRoute] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeId: '', valor: 0, descripcion: '', fecha: today() })
  // Grupo de ruta seleccionado para ver el detalle de sus retiros.
  const [detailGroup, setDetailGroup] = useState<WithdrawalGroup | null>(null)

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [ws, rts, us] = await Promise.all([
      db.withdrawals.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    setWithdrawals(ws.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(rts)
    setUsers(us)
    const base: Record<string, number> = {}
    for (const r of rts) base[r.id] = await getRouteAvailableCapital(r.id)
    setBaseByRoute(base)
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

  const getUserName = (id?: string) => users.find(u => u.id === id)?.nombre

  // ---- Agrupación por ruta (solo presentación; no recalcula saldos contables) ----
  const groups: WithdrawalGroup[] = (() => {
    const buildGroup = (routeId: string, nombre: string, codigo: string, baseActual: number): WithdrawalGroup => {
      const ws = withdrawals.filter(w => w.routeId === routeId) // ya vienen ordenados desc por fecha
      return {
        routeId, nombre, codigo, baseActual,
        totalRetirado: ws.reduce((s, w) => s + w.valor, 0),
        cantidad: ws.length,
        ultimoRetiro: ws[0]?.fecha,
        withdrawals: ws,
      }
    }

    const list = routes.map(r => buildGroup(r.id, r.nombre, r.codigo, baseByRoute[r.id] ?? 0))

    // Retiros cuya ruta ya no existe (o sin routeId) → grupo "Sin ruta".
    const knownRouteIds = new Set(routes.map(r => r.id))
    const orphan = withdrawals.filter(w => !w.routeId || !knownRouteIds.has(w.routeId))
    if (orphan.length > 0) {
      list.push({
        routeId: '__none__', nombre: 'Sin ruta', codigo: '—', baseActual: 0,
        totalRetirado: orphan.reduce((s, w) => s + w.valor, 0),
        cantidad: orphan.length, ultimoRetiro: orphan[0]?.fecha, withdrawals: orphan,
      })
    }
    return list
  })()

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Retiros</h1>
          <p className="text-sm text-gray-500 mt-0.5">{withdrawals.length} retiro(s) · {routes.length} ruta(s)</p>
        </div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nuevo retiro</Button>
      </div>

      {/* Retiros agrupados por ruta: una tarjeta por ruta */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : groups.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 flex justify-center py-12 text-gray-400 text-sm">No hay rutas ni retiros</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map(g => (
            <div key={g.routeId} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-4 h-4 text-amber-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{g.nombre}</p>
                    <p className="text-xs text-gray-400">{g.codigo}</p>
                  </div>
                </div>
                <span className="text-xs text-gray-400">{g.cantidad} retiro(s)</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div className="bg-amber-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Total retirado</p>
                  <p className="text-sm font-bold text-amber-600">{formatCurrency(g.totalRetirado, currency)}</p>
                </div>
                <div className="bg-primary-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Base actual</p>
                  <p className="text-sm font-bold text-primary-700">{g.routeId === '__none__' ? '—' : formatCurrency(g.baseActual, currency)}</p>
                </div>
              </div>

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">
                  {g.ultimoRetiro ? `Último: ${formatDate(g.ultimoRetiro)}` : 'Sin retiros'}
                </p>
                <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailGroup(g)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  Ver retiros
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Registrar retiro (sin cambios de lógica contable) */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Registrar retiro"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
            options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de retiros de una ruta */}
      <Modal open={!!detailGroup} onClose={() => setDetailGroup(null)} title={detailGroup ? `Retiros · ${detailGroup.nombre}` : 'Retiros'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailGroup(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Total retirado</p><p className="font-bold text-amber-600">{formatCurrency(detailGroup.totalRetirado, currency)}</p></div>
              <div className="bg-primary-50 rounded-xl p-3"><p className="text-xs text-gray-400">Base actual</p><p className="font-bold text-primary-700">{detailGroup.routeId === '__none__' ? '—' : formatCurrency(detailGroup.baseActual, currency)}</p></div>
            </div>
            {detailGroup.withdrawals.length === 0 ? (
              <div className="flex justify-center py-8 text-gray-400 text-sm">Esta ruta no tiene retiros</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                {detailGroup.withdrawals.map(w => (
                  <div key={w.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <Wallet className="w-4 h-4 text-amber-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{w.descripcion || 'Retiro'}</p>
                        <p className="text-xs text-gray-400">{formatDate(w.fecha)}{getUserName(w.userId) ? ` · ${getUserName(w.userId)}` : ''}</p>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-amber-600">-{formatCurrency(w.valor, currency)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
