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
 * Categorías de gastos (copia de ADEX Online de `src/pages/admin/ExpenseCategoriesPage.tsx`).
 * 3.14 (0040): casilla «Para Cobradores»: el Cobrador y el Supervisor solo ven y usan los tipos
 * marcados; el Administrador, todos. Eliminar un tipo con gastos lo quita de la lista y sus
 * gastos registrados conservan el tipo y el nombre (lo decide el servidor). Evita duplicados
 * por nombre (comparación normalizada) entre los tipos de la lista.
 */
export default function ExpenseCategoriesPage() {
  const { tenantId } = useTenant()
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ExpenseCategory | null>(null)
  const [nombre, setNombre] = useState('')
  const [paraCobradores, setParaCobradores] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategory | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

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
    setCategories(cats.filter(x => !x.eliminada).sort((a, b) => a.nombre.localeCompare(b.nombre)))
    setLoading(false)
  }

  const norm = (s: string) => s.trim().toLowerCase()

  function openCreate() {
    setEditing(null); setNombre(''); setParaCobradores(false); setModalOpen(true)
  }
  function openEdit(cat: ExpenseCategory) {
    setEditing(cat); setNombre(cat.nombre); setParaCobradores(cat.paraCobradores === true); setModalOpen(true)
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
        const changes: Partial<ExpenseCategory> = {}
        if (name !== editing.nombre) changes.nombre = name
        if (paraCobradores !== (editing.paraCobradores === true)) changes.paraCobradores = paraCobradores
        if (Object.keys(changes).length) await db.expenseCategories.update(editing.id, changes)
        toast.success('Categoría actualizada')
      } else {
        const cat: ExpenseCategory = { id: generateId(), tenantId, nombre: name, activa: true, paraCobradores }
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

  async function toggleCobradores(cat: ExpenseCategory) {
    setTogglingId(cat.id)
    try {
      await db.expenseCategories.update(cat.id, { paraCobradores: !cat.paraCobradores })
      toast.success(cat.paraCobradores ? `«${cat.nombre}» ya no aparece a Cobradores ni Supervisores` : `«${cat.nombre}» disponible para Cobradores y Supervisores`)
      await load()
    } catch { toast.error('No se pudo cambiar la casilla') } finally { setTogglingId(null) }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await db.expenseCategories.delete(deleteTarget.id)
      toast.success((counts[deleteTarget.id] ?? 0) > 0 ? 'Categoría eliminada de la lista; sus gastos se conservan' : 'Categoría eliminada')
      setDeleteTarget(null)
      await load()
    } catch { toast.error('Error al eliminar') } finally { setDeleting(false) }
  }

  const usedByTarget = deleteTarget ? counts[deleteTarget.id] ?? 0 : 0

  return (
    <div className="p-4 md:p-6 space-y-6">
      <ModuleTabs tabs={EXPENSE_TABS} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Categorías de gastos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{categories.length} categoría(s) · {categories.filter(c => c.activa && c.paraCobradores).length} para Cobradores</p>
        </div>
        <Button onClick={openCreate} icon={<Plus className="w-4 h-4" />}>Nueva categoría</Button>
      </div>
      <p className="text-xs text-gray-500 -mt-3">
        Marca «Para Cobradores» en los tipos que pueden usar los Cobradores y Supervisores. Tú ves y usas todos los tipos activos.
      </p>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : categories.length === 0 ? (
        <EmptyState icon={<Tag className="w-8 h-8" />} title="No hay categorías" action={<Button onClick={openCreate}>Crear categoría</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="divide-y divide-gray-50">
            {categories.map(cat => (
              <div key={cat.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid={`cat-row-${cat.id}`}>
                <div className="w-9 h-9 bg-primary-50 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Tag className="w-4 h-4 text-primary-600" />
                </div>
                {/* En el celular el nombre ocupa su línea; la casilla y las acciones van debajo. */}
                <div className="min-w-0 basis-[calc(100%-3.25rem)] sm:basis-0 sm:flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{cat.nombre}</p>
                  <p className="text-xs text-gray-500">{counts[cat.id] ?? 0} gasto(s) asociado(s)</p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none">
                  <input type="checkbox" className="w-4 h-4 accent-primary-600" checked={cat.paraCobradores === true}
                    disabled={togglingId === cat.id} onChange={() => toggleCobradores(cat)} data-testid={`cat-collectors-${cat.id}`} />
                  Para Cobradores
                </label>
                <Badge variant={cat.activa ? 'success' : 'gray'} size="sm">{cat.activa ? 'Activa' : 'Inactiva'}</Badge>
                <div className="flex gap-1 flex-shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => toggleActiva(cat)} aria-label={cat.activa ? 'Desactivar' : 'Activar'}
                    icon={cat.activa ? <ToggleRight className="w-3.5 h-3.5 text-emerald-500" /> : <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />} />
                  <Button variant="ghost" size="sm" onClick={() => openEdit(cat)} aria-label="Editar" data-testid={`cat-edit-${cat.id}`}
                    icon={<Edit className="w-3.5 h-3.5 text-gray-500" />} />
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(cat)} aria-label="Eliminar" data-testid={`cat-delete-${cat.id}`}
                    icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />} className="text-red-400 hover:text-red-600 hover:bg-red-50" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Crear / editar */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar categoría' : 'Nueva categoría'}
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving} data-testid="cat-save">{editing ? 'Actualizar' : 'Crear'}</Button></>}>
        <div className="space-y-4">
          <Input label="Nombre de la categoría" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej: Transporte" required autoFocus />
          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" className="w-4 h-4 mt-0.5 accent-primary-600" checked={paraCobradores} onChange={e => setParaCobradores(e.target.checked)} data-testid="cat-form-collectors" />
            <span>Para Cobradores<span className="block text-xs text-gray-500">Los Cobradores y Supervisores podrán registrar gastos de este tipo.</span></span>
          </label>
          {editing && (counts[editing.id] ?? 0) > 0 && nombre.trim() !== editing.nombre && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg p-2">
              El nuevo nombre también se mostrará en los {counts[editing.id]} gasto(s) ya registrados con esta categoría.
            </p>
          )}
        </div>
      </Modal>

      {/* Eliminar */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eliminar categoría"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button variant="danger" onClick={confirmDelete} loading={deleting} icon={<AlertTriangle className="w-4 h-4" />} data-testid="cat-delete-confirm">Sí, eliminar</Button></>}>
        <div className="space-y-3">
          {usedByTarget > 0 ? (
            <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl" data-testid="cat-delete-keeps">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
              <p className="text-sm text-amber-800">
                La categoría saldrá de la lista y nadie podrá usarla en gastos nuevos. Los {usedByTarget} gasto(s) ya registrados
                no cambian: siguen apareciendo con esta categoría en el historial, las consultas y los cierres.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-red-50 rounded-xl">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
              <p className="text-sm text-red-700">No tiene gastos registrados: se eliminará de forma permanente. ¿Deseas continuar?</p>
            </div>
          )}
          <p className="text-sm text-gray-600">Categoría: <span className="font-semibold">{deleteTarget?.nombre}</span></p>
        </div>
      </Modal>
    </div>
  )
}
