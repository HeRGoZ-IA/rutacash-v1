import { useState, useEffect } from 'react'
import { Plus, Tag, ToggleLeft, ToggleRight, Edit, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModuleTabs, EXPENSE_TABS } from '@/components/ui/ModuleTabs'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import type { ExpenseCategory } from '@/models/types'

/**
 * Categorías de gastos (Revisión 2 socio 30-jun).
 * Permite crear, editar, activar/desactivar categorías. No se pueden eliminar
 * las que tengan gastos asociados (se bloquea; se puede desactivar). Evita
 * duplicados por nombre (comparación normalizada) al crear/editar.
 */
export default function ExpenseCategoriesPage() {
  const { tenantId } = useTenant()
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ExpenseCategory | null>(null)
  const [nombre, setNombre] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategory | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [cats, exps] = await Promise.all([
      db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      db.expenses.where('tenantId').equals(tenantId).toArray(),
    ])
    const c: Record<string, number> = {}
    for (const e of exps) c[e.categoryId] = (c[e.categoryId] ?? 0) + 1
    setCounts(c)
    setCategories(cats.sort((a, b) => a.nombre.localeCompare(b.nombre)))
    setLoading(false)
  }

  const norm = (s: string) => s.trim().toLowerCase()

  function openCreate() {
    setEditing(null); setNombre(''); setModalOpen(true)
  }
  function openEdit(cat: ExpenseCategory) {
    setEditing(cat); setNombre(cat.nombre); setModalOpen(true)
  }

  async function handleSave() {
    const name = nombre.trim()
    if (!name) { toast.error('El nombre es requerido'); return }
    // Evitar duplicados por nombre (ignorando el propio en edición).
    const dup = categories.find(c => c.id !== editing?.id && norm(c.nombre) === norm(name))
    if (dup) { toast.error('Ya existe una categoría con ese nombre'); return }
    setSaving(true)
    try {
      if (editing) {
        await db.expenseCategories.update(editing.id, { nombre: name })
        toast.success('Categoría actualizada')
      } else {
        const cat: ExpenseCategory = { id: generateId(), tenantId, nombre: name, activa: true }
        await db.expenseCategories.add(cat)
        toast.success('Categoría creada')
      }
      setModalOpen(false)
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  async function toggleActiva(cat: ExpenseCategory) {
    await db.expenseCategories.update(cat.id, { activa: !cat.activa })
    toast.success(cat.activa ? 'Categoría desactivada' : 'Categoría activada')
    await load()
  }

  async function requestDelete(cat: ExpenseCategory) {
    setCheckingId(cat.id)
    try {
      const used = await db.expenses.where('categoryId').equals(cat.id).count()
      if (used > 0) {
        toast.error('No se puede eliminar: tiene gastos asociados. Puedes desactivarla.')
        return
      }
      setDeleteTarget(cat)
    } finally { setCheckingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.expenseCategories.delete(deleteTarget.id)
      toast.success('Categoría eliminada')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <ModuleTabs tabs={EXPENSE_TABS} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Categorías de gastos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{categories.length} categoría(s)</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva categoría</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : categories.length === 0 ? (
        <EmptyState icon={<Tag className="w-8 h-8" />} title="No hay categorías" action={<Button onClick={openCreate}>Crear categoría</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="divide-y divide-gray-50">
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-4 px-4 py-3">
                <div className="w-9 h-9 bg-primary-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Tag className="w-4 h-4 text-primary-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{cat.nombre}</p>
                  <p className="text-xs text-gray-400">{counts[cat.id] ?? 0} gasto(s) asociado(s)</p>
                </div>
                <Badge variant={cat.activa ? 'success' : 'gray'} size="sm">{cat.activa ? 'Activa' : 'Inactiva'}</Badge>
                <div className="flex gap-1 flex-shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => toggleActiva(cat)}
                    icon={cat.activa ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />} />
                  <Button variant="ghost" size="sm" onClick={() => openEdit(cat)} icon={<Edit className="w-3.5 h-3.5 text-gray-500" />} />
                  <Button variant="ghost" size="sm" onClick={() => requestDelete(cat)} loading={checkingId === cat.id}
                    icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />} className="text-red-400 hover:text-red-600 hover:bg-red-50" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Crear / editar */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar categoría' : 'Nueva categoría'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <Input label="Nombre de la categoría" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej: Transporte" required autoFocus />
      </Modal>

      {/* Eliminar */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar categoría"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />}>Sí, eliminar</Button></>}>
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700">Esta acción eliminará la categoría de forma permanente. ¿Deseas continuar?</p>
          </div>
          <p className="text-sm text-gray-600">Categoría: <span className="font-semibold">{deleteTarget?.nombre}</span></p>
        </div>
      </Modal>
    </div>
  )
}
