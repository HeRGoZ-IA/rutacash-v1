import { useState, useEffect } from 'react'
import { Plus, TrendingDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { ModuleTabs, EXPENSE_TABS } from '@/components/ui/ModuleTabs'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { filterAccessibleRoutes, filterByAccessibleRoute, canAccessRoute, can } from '@/lib/permissions'
import { EXPENSE_SCOPE_LABEL, expenseAttribution } from '@/lib/expenseAttribution'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import type { Expense, ExpenseCategory, ExpenseScope, Route, User } from '@/models/types'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import { canRegisterExpenseScope, createExpense } from '@/services/expenseService'

/** Gasto con ruta (de ruta o de trabajador): el único que filtra Oficina → Ruta. */
type RoutedExpense = Expense & { routeId: string }
const conRuta = (e: Expense): e is RoutedExpense => !!e.routeId

/**
 * A QUIÉN CORRESPONDE el gasto (punto 9): decide qué efectivo reduce. Se elige
 * siempre de forma explícita; nunca se deduce de quién lo registra.
 */
const EFECTO: Record<ExpenseScope, string> = {
  empresa: 'Gasto general de la empresa. No resta la Base de ninguna ruta ni el efectivo de ningún trabajador.',
  ruta: 'Pagado con la caja de la ruta: resta su Base y lo Sin asignar. No se carga a ningún trabajador.',
  trabajador: 'Pagado con el efectivo de un trabajador: resta lo que tiene en manos y aparece en sus Gastos y en su cuadre.',
}

const SCOPE_TONE: Record<ExpenseScope, string> = {
  empresa: 'bg-gray-100 text-gray-700',
  ruta: 'bg-blue-50 text-blue-700',
  trabajador: 'bg-amber-50 text-amber-700',
}

const FORM_VACIO = { scope: '' as ExpenseScope | '', routeId: '', collectorId: '', categoryId: '', valor: 0, descripcion: '', fecha: today() }

export default function ExpensesPage() {
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [tipo, setTipo] = useState<ExpenseScope | ''>('')
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(FORM_VACIO)

  /** Los gastos de empresa son información consolidada (fuera de las rutas). */
  const veEmpresa = !!user && can(user, 'cashbox.viewConsolidated', { tenantId })

  // Un gasto registrado en otra pestaña (Cobrador, Supervisor) se refleja sin F5.
  const revision = useDataRevision(['expenses', 'users', 'routes', 'expenseCategories'])
  useEffect(() => { load() }, [tenantId, user, revision])

  async function load() {
    setLoading(true)
    const [exps, cats, rts, us] = await Promise.all([
      db.expenses.where('tenantId').equals(tenantId).toArray(),
      db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: gastos y rutas limitados a las autorizadas. Los de
    // empresa (sin ruta) solo para quien ve el consolidado.
    const deRutas = filterByAccessibleRoute(user, exps.filter(conRuta))
    const deEmpresa = veEmpresa ? exps.filter(e => !e.routeId) : []
    setExpenses([...deRutas, ...deEmpresa].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.createdAt.localeCompare(a.createdAt)))
    setCategories(cats)
    setRoutes(filterAccessibleRoutes(user, rts))
    setUsers(us)
    setLoading(false)
  }

  const officeRoutes = routes
  /** Solo para etiquetar históricos (ver `expenseAttribution`). */
  const conCaja = (id: string) => { const u = users.find(x => x.id === id); return !!u && hasPersonalCashbox(u.rol) }
  // Oficina → Ruta solo estrecha gastos con ruta. Los de empresa no pertenecen a
  // ninguna Oficina: se muestran únicamente sin filtro de Oficina/Ruta.
  const sinFiltroDeRuta = !officeFilter.hasOfficeFilter && !officeFilter.routeId
  const expensesEnAlcance: Expense[] = [
    ...officeFilter.filterRows(expenses.filter(conRuta)),
    ...(sinFiltroDeRuta ? expenses.filter(e => !e.routeId) : []),
  ]
  const filtered = expensesEnAlcance.filter(e =>
    (!desde || e.fecha >= desde) &&
    (!hasta || e.fecha <= hasta) &&
    (!tipo || expenseAttribution(e, conCaja).scope === tipo)
  ).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.createdAt.localeCompare(a.createdAt))
  const totalFiltered = filtered.reduce((s, e) => s + e.valor, 0)

  const tiposPermitidos = (['empresa', 'ruta', 'trabajador'] as ExpenseScope[])
    .filter(s => s !== 'empresa' ? !!user && can(user, 'expense.register', { tenantId }) : canRegisterExpenseScope(user, 'empresa'))
  const trabajadores = form.routeId
    ? users.filter(u => custodianBlockedReason(u, form.routeId, tenantId) === null).sort((a, b) => a.nombre.localeCompare(b.nombre))
    : []

  async function handleSave() {
    if (!form.scope) { toast.error('Indica a quién corresponde el gasto'); return }
    if (form.scope !== 'empresa' && !form.routeId) { toast.error('Selecciona la ruta'); return }
    if (form.scope === 'trabajador' && !form.collectorId) { toast.error('Selecciona el trabajador que pagó'); return }
    if (!form.categoryId || form.valor <= 0) { toast.error('Categoría y valor son requeridos'); return }
    if (form.routeId && form.scope !== 'empresa' && !canAccessRoute(user, form.routeId)) { toast.error('No tienes permiso sobre esa ruta.'); return }
    setSaving(true)
    try {
      // El servicio valida permisos, Oficina activa, trabajador de la ruta y fondos.
      await createExpense({
        actor: user, tenantId, scope: form.scope,
        routeId: form.scope === 'empresa' ? undefined : form.routeId,
        collectorId: form.scope === 'trabajador' ? form.collectorId : undefined,
        categoryId: form.categoryId, valor: form.valor, descripcion: form.descripcion, fecha: form.fecha,
        syncStatus: 'synced',
      })
      toast.success('Gasto registrado')
      setModalOpen(false)
      setForm(FORM_VACIO)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  const getRouteName = (id?: string) => routes.find(r => r.id === id)?.nombre ?? id ?? ''
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id
  const getUserName = (id?: string) => users.find(u => u.id === id)?.nombre ?? id ?? ''
  /** "Ruta Barreiro · Fabio" / "Ruta Barreiro" / "Empresa". */
  const atribucionDe = (e: Expense) => {
    const a = expenseAttribution(e, conCaja)
    if (a.scope === 'empresa') return 'Empresa'
    if (a.scope === 'trabajador') return `${getRouteName(e.routeId)} · ${getUserName(a.cashHolderId)}`
    return getRouteName(e.routeId)
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <ModuleTabs tabs={EXPENSE_TABS} />
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Gastos</h1><p className="text-sm text-gray-500 mt-0.5">Total: {formatCurrency(totalFiltered, currency)}</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nuevo gasto</Button>
      </div>

      {/* FILTRO OFICINA → RUTA. La Oficina solo estrecha las rutas autorizadas;
          el contexto activo queda a la vista cuando se llega desde una Oficina. */}
      <OfficeRouteFilterBar
        offices={officeFilter.offices}
        officeId={officeFilter.officeId}
        onOfficeChange={officeFilter.setOfficeId}
        routesInOffice={officeFilter.routesInOffice}
        routeId={officeFilter.routeId}
        onRouteChange={officeFilter.setRouteId}
        hasUnassigned={officeFilter.hasUnassigned}
        contextLabel={officeFilter.contextLabel}
        showContext={officeFilter.hasOfficeFilter}
      />

      <DateRangeFilter desde={desde} hasta={hasta} onDesde={setDesde} onHasta={setHasta}
        onClear={() => { setDesde(''); setHasta(''); setTipo('') }}>
        <div className="w-full sm:w-48">
          <Select aria-label="Tipo de gasto" value={tipo} onChange={e => setTipo(e.target.value as ExpenseScope | '')}
            options={(veEmpresa ? ['empresa', 'ruta', 'trabajador'] as ExpenseScope[] : ['ruta', 'trabajador'] as ExpenseScope[])
              .map(s => ({ value: s, label: EXPENSE_SCOPE_LABEL[s] }))}
            placeholder="Todos los tipos" />
        </div>
      </DateRangeFilter>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {loading ? null : filtered.length === 0 ? (
          <EmptyState icon={<TrendingDown className="w-8 h-8" />} title="No hay gastos" />
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(e => {
              const scope = expenseAttribution(e, conCaja).scope
              return (
                <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
                      <TrendingDown className="w-4 h-4 text-red-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-1.5">
                        {getCatName(e.categoryId)}
                        <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${SCOPE_TONE[scope]}`}>{EXPENSE_SCOPE_LABEL[scope]}</span>
                      </p>
                      <p className="text-xs text-gray-400">{atribucionDe(e)} · {formatDate(e.fecha)}</p>
                      {e.descripcion && <p className="text-xs text-gray-400">{e.descripcion}</p>}
                    </div>
                  </div>
                  <span className="text-sm font-bold text-red-600 flex-shrink-0">-{formatCurrency(e.valor, currency)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Registrar gasto"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="¿A quién corresponde este gasto?" value={form.scope} required
            onChange={e => setForm(f => ({ ...f, scope: e.target.value as ExpenseScope | '', collectorId: '' }))}
            options={tiposPermitidos.map(s => ({ value: s, label: EXPENSE_SCOPE_LABEL[s] }))}
            placeholder="Seleccionar tipo"
            hint={form.scope ? EFECTO[form.scope] : 'Decide qué efectivo reduce el gasto, no quién lo registra.'} />
          {(form.scope === 'ruta' || form.scope === 'trabajador') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value, collectorId: '' }))}
                options={officeRoutes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
              {form.scope === 'trabajador' && (
                <Select label="Trabajador que pagó" value={form.collectorId} onChange={e => setForm(f => ({ ...f, collectorId: e.target.value }))}
                  options={trabajadores.map(u => ({ value: u.id, label: u.nombre }))}
                  placeholder={form.routeId ? (trabajadores.length ? 'Seleccionar trabajador' : 'La ruta no tiene trabajadores') : 'Elige primero la ruta'} required />
              )}
            </div>
          )}
          <Select label="Categoría" value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
            options={categories.filter(c => c.activa).map(c => ({ value: c.id, label: c.nombre }))} placeholder="Seleccionar categoría" required />
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
