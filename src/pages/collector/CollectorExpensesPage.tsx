import { useState, useEffect } from 'react'
import { Plus, DollarSign } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { Expense, ExpenseCategory } from '@/models/types'

export default function CollectorExpensesPage() {
  const { user } = useAuth()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ categoryId: '', valor: '', descripcion: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user?.routeId) return
    const [exps, cats] = await Promise.all([
      db.expenses.where('routeId').equals(user.routeId).toArray(),
      db.expenseCategories.where('tenantId').equals(user.tenantId).toArray(),
    ])
    setExpenses(exps.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setCategories(cats)
  }

  async function handleSave() {
    if (!form.categoryId || !form.valor || Number(form.valor) <= 0) { toast.error('Selecciona categoría y valor'); return }
    if (!user?.routeId) return
    setSaving(true)
    try {
      const route = await db.routes.get(user.routeId)
      const expense: Expense = {
        id: generateId(), tenantId: user.tenantId, officeId: route?.officeId ?? '',
        routeId: user.routeId, categoryId: form.categoryId, valor: Number(form.valor),
        descripcion: form.descripcion, fecha: today(), userId: user.id,
        syncStatus: navigator.onLine ? 'synced' : 'pending', createdAt: nowISO(),
      }
      await db.expenses.add(expense)
      toast.success('Gasto registrado')
      setForm({ categoryId: '', valor: '', descripcion: '' })
      setShowForm(false)
      await load()
    } catch { toast.error('Error') } finally { setSaving(false) }
  }

  const todayTotal = expenses.filter(e => e.fecha === today()).reduce((s, e) => s + e.valor, 0)
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-gray-900">Gastos</h1>
          <p className="text-xs text-gray-500">Hoy: {formatCurrency(todayTotal)}</p>
        </div>
        <button onClick={() => setShowForm(true)} className="w-10 h-10 bg-primary-600 text-white rounded-full flex items-center justify-center">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
          <p className="font-semibold text-sm text-gray-700">Registrar gasto</p>
          <div className="grid grid-cols-2 gap-2">
            {categories.map(c => (
              <button key={c.id} onClick={() => setForm(f => ({ ...f, categoryId: c.id }))}
                className={`py-2.5 rounded-xl text-sm font-medium border transition-colors ${form.categoryId === c.id ? 'bg-primary-600 text-white border-primary-600' : 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                {c.nombre}
              </button>
            ))}
          </div>
          <input type="number" value={form.valor} onChange={e => setForm(f => ({ ...f, valor: e.target.value }))}
            placeholder="Valor" className="w-full h-12 rounded-xl border border-gray-200 px-4 text-lg font-bold focus:outline-none focus:ring-2 focus:ring-primary-500" />
          <input value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
            placeholder="Descripción (opcional)" className="w-full h-10 rounded-xl border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600">Cancelar</button>
            <button onClick={handleSave} disabled={saving} className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50">
              {saving ? '...' : 'Guardar'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {expenses.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">No hay gastos registrados</div>
        ) : expenses.map(e => (
          <div key={e.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-red-50 rounded-xl flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-red-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">{getCatName(e.categoryId)}</p>
                <p className="text-xs text-gray-400">{formatDate(e.fecha)}</p>
              </div>
            </div>
            <span className="text-sm font-bold text-red-500">-{formatCurrency(e.valor)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
