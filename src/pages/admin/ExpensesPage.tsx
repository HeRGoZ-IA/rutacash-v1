import { useState, useEffect } from 'react'
import { Plus, TrendingDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { Expense, ExpenseCategory, Route } from '@/models/types'

export default function ExpensesPage() {
  const { tenantId, officeId } = useTenant()
  const { user } = useAuth()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [filterRoute, setFilterRoute] = useState('')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeId: '', categoryId: '', valor: 0, descripcion: '', fecha: today() })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [exps, cats, rts] = await Promise.all([
      db.expenses.where('tenantId').equals(tenantId).toArray(),
      db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setExpenses(exps.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setCategories(cats)
    setRoutes(rts)
    setLoading(false)
  }

  const filtered = filterRoute ? expenses.filter(e => e.routeId === filterRoute) : expenses
  const totalFiltered = filtered.reduce((s, e) => s + e.valor, 0)

  async function handleSave() {
    if (!form.routeId || !form.categoryId || form.valor <= 0) { toast.error('Ruta, categoría y valor son requeridos'); return }
    setSaving(true)
    try {
      const route = routes.find(r => r.id === form.routeId)
      const expense: Expense = {
        id: generateId(), tenantId, officeId: route?.officeId ?? officeId,
        routeId: form.routeId, categoryId: form.categoryId, valor: form.valor,
        descripcion: form.descripcion, fecha: form.fecha, userId: user?.id ?? '',
        syncStatus: 'synced', createdAt: nowISO(),
      }
      await db.expenses.add(expense)
      toast.success('Gasto registrado')
      setModalOpen(false)
      setForm({ routeId: '', categoryId: '', valor: 0, descripcion: '', fecha: today() })
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  const getRouteName = (id: string) => routes.find(r => r.id === id)?.nombre ?? id
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Gastos</h1><p className="text-sm text-gray-500 mt-0.5">Total: {formatCurrency(totalFiltered)}</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nuevo gasto</Button>
      </div>

      <Select value={filterRoute} onChange={e => setFilterRoute(e.target.value)}
        options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Todas las rutas" className="w-44" />

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState icon={<TrendingDown className="w-8 h-8" />} title="No hay gastos" />
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(e => (
              <div key={e.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-red-50 rounded-xl flex items-center justify-center">
                    <TrendingDown className="w-4 h-4 text-red-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{getCatName(e.categoryId)}</p>
                    <p className="text-xs text-gray-400">{getRouteName(e.routeId)} · {formatDate(e.fecha)}</p>
                    {e.descripcion && <p className="text-xs text-gray-400">{e.descripcion}</p>}
                  </div>
                </div>
                <span className="text-sm font-bold text-red-600">-{formatCurrency(e.valor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Registrar gasto"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
              options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
            <Select label="Categoría" value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
              options={categories.map(c => ({ value: c.id, label: c.nombre }))} placeholder="Seleccionar categoría" required />
          </div>
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
