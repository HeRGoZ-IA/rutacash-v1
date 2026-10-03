import { useState, useEffect } from 'react'
import { Plus, DollarSign, Image as ImageIcon } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { PhotoInput } from '@/components/ui/PhotoInput'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { expenseAttribution, isExpenseOf } from '@/lib/expenseAttribution'
import { can } from '@/lib/permissions'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol, formatDate, today } from '@/lib/formatters'
import type { Expense, ExpenseCategory, User } from '@/models/types'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import { canRegisterExpenseScope, createExpense } from '@/services/expenseService'

/** Opción "caja de la ruta" del selector de quién pagó (no es un id de usuario). */
const CAJA_RUTA = '__ruta__'

export default function CollectorExpensesPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [team, setTeam] = useState<User[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ categoryId: '', valor: 0, descripcion: '', receiptPhotoDataUrl: undefined as string | undefined, pagadoPor: '' })
  const [saving, setSaving] = useState(false)

  // Gastos de la ruta activa (o la ruta principal del cobrador)
  const routeId = activeRouteId ?? user?.routeId ?? null

  // ATRIBUCIÓN (punto 9): quien tiene caja personal paga sus gastos con su propio
  // efectivo, sin selector (`hasPersonalCashbox(user.rol)`, el mismo predicado que
  // cobros y desembolsos). Solo quien administra la caja de la ruta (Supervisor)
  // puede indicar que pagó OTRO trabajador o la caja de la ruta.
  const pagaConSuEfectivo = !!user && hasPersonalCashbox(user.rol)
  const eligeQuienPaga = !!user && !!routeId && canRegisterExpenseScope(user, 'ruta', routeId)
  // Ver los gastos de la ruta (no solo los propios) es información de la caja de la
  // ruta: el Cobrador no la tiene (`cashbox.viewRoute`), el Supervisor sí.
  const veGastosDeRuta = !!user && !!routeId && can(user, 'cashbox.viewRoute', { routeId, tenantId: user.tenantId })

  // Un gasto registrado en otra pestaña (Admin, Supervisor) se refleja sin F5.
  const revision = useDataRevision(['expenses', 'users'])
  useEffect(() => { load() }, [user, routeId, revision])

  async function load() {
    if (!user || !routeId) return
    const [exps, cats, users] = await Promise.all([
      db.expenses.where('routeId').equals(routeId).toArray(),
      db.expenseCategories.where('tenantId').equals(user.tenantId).toArray(),
      db.users.where('tenantId').equals(user.tenantId).toArray(),
    ])
    // Solo lo que corresponde ver: el Cobrador, sus gastos (por ATRIBUCIÓN, no por
    // quién los registró); el Supervisor, los de la ruta y de sus trabajadores.
    // Los gastos de empresa no tienen ruta: nunca llegan aquí.
    const visibles = exps.filter(e => e.tenantId === user.tenantId && (veGastosDeRuta || isExpenseOf(e, user.id)))
    setExpenses(visibles.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.createdAt.localeCompare(a.createdAt)))
    setCategories(cats)
    setTeam(users.filter(u => custodianBlockedReason(u, routeId, user.tenantId) === null).sort((a, b) => a.nombre.localeCompare(b.nombre)))
  }

  async function handleSave() {
    if (!form.categoryId || !form.valor || form.valor <= 0) { toast.error('Selecciona categoría y valor'); return }
    if (!user || !routeId) return
    // Por defecto paga quien registra; el Supervisor puede indicar otra cosa.
    const pagadoPor = eligeQuienPaga && form.pagadoPor ? form.pagadoPor : (pagaConSuEfectivo ? user.id : CAJA_RUTA)
    setSaving(true)
    try {
      // `userId` = quién REGISTRÓ; la atribución (`scope` + `collectorId`) = a qué
      // efectivo se carga. El servicio valida permisos, ruta, Oficina activa y que
      // el gasto no supere el efectivo de quien lo paga. El instante se sella BAJO
      // BLOQUEO: frontera exacta del cuadre por trabajador.
      await createExpense({
        actor: user, tenantId: user.tenantId, routeId,
        scope: pagadoPor === CAJA_RUTA ? 'ruta' : 'trabajador',
        collectorId: pagadoPor === CAJA_RUTA ? undefined : pagadoPor,
        categoryId: form.categoryId, valor: form.valor,
        descripcion: form.descripcion, receiptPhotoDataUrl: form.receiptPhotoDataUrl,
        syncStatus: navigator.onLine ? 'synced' : 'pending',
      })
      toast.success('Gasto registrado')
      setForm({ categoryId: '', valor: 0, descripcion: '', receiptPhotoDataUrl: undefined, pagadoPor: '' })
      setShowForm(false)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  const mios = expenses.filter(e => user && isExpenseOf(e, user.id))
  const todayTotal = mios.filter(e => e.fecha === today()).reduce((s, e) => s + e.valor, 0)
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id
  const nombreDe = (id?: string) => team.find(u => u.id === id)?.nombre ?? 'Trabajador'
  /** Para el Supervisor: a quién se cargó cada gasto. */
  const etiqueta = (e: Expense) => {
    const a = expenseAttribution(e)
    if (user && a.cashHolderId === user.id) return 'A tu cargo'
    if (a.scope === 'trabajador') return `A cargo de ${nombreDe(a.cashHolderId)}`
    return 'Caja de la ruta'
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-gray-900">Gastos</h1>
          <p className="text-xs text-gray-500">{veGastosDeRuta ? 'A tu cargo hoy' : 'Hoy'}: {formatCurrency(todayTotal, currency)}</p>
        </div>
        <button onClick={() => setShowForm(true)} className="w-10 h-10 bg-primary-600 text-white rounded-full flex items-center justify-center">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
          <p className="font-semibold text-sm text-gray-700">Registrar gasto</p>
          {categories.filter(c => c.activa).length === 0 ? (
            <p className="text-xs text-amber-600">No hay categorías de gasto. Pide al administrador que configure las categorías.</p>
          ) : (
            // Selector expandible (dropdown): escala bien aunque haya muchas categorías.
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Categoría</label>
              <select
                value={form.categoryId}
                onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full h-12 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="">Seleccionar categoría…</option>
                {categories.filter(c => c.activa).map(c => (
                  <option key={c.id} value={c.id}>{c.nombre}</option>
                ))}
              </select>
            </div>
          )}
          {eligeQuienPaga && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">¿Con qué efectivo se pagó?</label>
              <select
                value={form.pagadoPor || (pagaConSuEfectivo ? user!.id : CAJA_RUTA)}
                onChange={e => setForm(f => ({ ...f, pagadoPor: e.target.value }))}
                className="w-full h-12 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {pagaConSuEfectivo && <option value={user!.id}>Mi efectivo</option>}
                {team.filter(u => u.id !== user!.id).map(u => (
                  <option key={u.id} value={u.id}>Efectivo de {u.nombre}</option>
                ))}
                <option value={CAJA_RUTA}>Caja de la ruta (sin trabajador)</option>
              </select>
            </div>
          )}
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-base font-bold text-gray-400">{getCurrencySymbol(currency)}</span>
            <input type="text" inputMode="numeric" value={formatCurrencyInput(form.valor, currency)} onChange={e => setForm(f => ({ ...f, valor: parseCurrencyInput(e.target.value) }))}
              placeholder="Valor" className="w-full h-12 rounded-xl border border-gray-200 pl-10 pr-4 text-lg font-bold focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
          <input value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))}
            placeholder="Descripción (opcional)" className="w-full h-10 rounded-xl border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          <PhotoInput label="Foto de factura / soporte (opcional)" value={form.receiptPhotoDataUrl} onChange={url => setForm(f => ({ ...f, receiptPhotoDataUrl: url }))} />
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
                <p className="text-xs text-gray-400">{formatDate(e.fecha)}{e.descripcion ? ` · ${e.descripcion}` : ''}</p>
                {veGastosDeRuta && <p className="text-[11px] font-medium text-gray-500">{etiqueta(e)}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {e.receiptPhotoDataUrl && (
                <a href={e.receiptPhotoDataUrl} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-primary-600" aria-label="Ver soporte">
                  <ImageIcon className="w-4 h-4" />
                </a>
              )}
              <span className="text-sm font-bold text-red-500">-{formatCurrency(e.valor, currency)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
