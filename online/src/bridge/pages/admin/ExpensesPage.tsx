// ADEX Online: COPIA de src/pages/admin/ExpensesPage.tsx (CLEAN). Único cambio, marcado: filtros en una fila (Ronda 53).
import { useState, useEffect } from 'react'
import { Plus, TrendingDown, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModuleTabs, EXPENSE_TABS } from '@/components/ui/ModuleTabs'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { formatPersonName } from '@/lib/displayName'
import { filterAccessibleRoutes, canAccessRoute, can } from '@/lib/permissions'
import { EXPENSE_SCOPE_LABEL, expenseAttribution } from '@/lib/expenseAttribution'
import { POOL_STATE_LABEL, expenseFundingOf, poolExpenseStateOf, refundedAmountOf } from '@/lib/expenseFunding'
import { generateId } from '@/lib/utils'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import { ReverseMovementModal } from '@/components/ui/MovementReversal'
import type { Expense, ExpenseCategory, ExpenseScope, Route, User } from '@/models/types'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import {
  canCorrectPoolExpense, canRegisterExpenseScope, createExpense, listVisibleExpenses, refundAdminExpense, reverseAdminExpense,
} from '@/services/expenseService'
import { AdminExpenseModal } from '@/components/expenses/AdminExpenseModal'

/** Gasto con ruta (de ruta o de trabajador): el único que filtra Oficina → Ruta. */
type RoutedExpense = Expense & { routeId: string }
const conRuta = (e: Expense): e is RoutedExpense => !!e.routeId

/**
 * A QUIÉN CORRESPONDE el gasto (punto 9): decide qué efectivo reduce. Se elige
 * siempre de forma explícita; nunca se deduce de quién lo registra.
 */
const EFECTO: Record<ExpenseScope, string> = {
  empresa: 'Gasto administrativo: se paga con una bolsa (la del Administrador o la de la empresa) y reduce su disponible. No resta la Base de ninguna ruta ni el efectivo de ningún trabajador.',
  ruta: 'Pagado con la caja de la ruta: resta su Base y lo Sin asignar. No se carga a ningún trabajador.',
  trabajador: 'Pagado con el efectivo de un trabajador: resta lo que tiene en manos y aparece en sus Gastos y en su cuadre.',
}

const SCOPE_TONE: Record<ExpenseScope, string> = {
  empresa: 'bg-gray-100 text-gray-700',
  ruta: 'bg-blue-50 text-blue-700',
  trabajador: 'bg-amber-50 text-amber-700',
}

// Gastos de ruta y de trabajador. El de EMPRESA (pagado con una bolsa) usa el
// formulario compartido `AdminExpenseModal` (también en Caja principal).
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
  /**
   * Id de la OPERACIÓN: se genera al abrir el formulario y se reutiliza en cada
   * reintento o doble clic; el servicio devuelve el mismo gasto (no lo duplica).
   */
  const [operationId, setOperationId] = useState(() => generateId())
  /** Gasto administrativo (empresa): formulario compartido con Caja principal. */
  const [adminModal, setAdminModal] = useState(false)
  const [anulando, setAnulando] = useState<Expense | null>(null)
  const [reintegrando, setReintegrando] = useState<Expense | null>(null)
  const [reintegro, setReintegro] = useState({ valor: 0, motivo: '', operationId: '' })
  const [guardandoReintegro, setGuardandoReintegro] = useState(false)

  /** Los gastos de empresa son información consolidada (fuera de las rutas). */
  const veEmpresa = !!user && can(user, 'cashbox.viewConsolidated', { tenantId })

  // Un gasto registrado en otra pestaña (Cobrador, Supervisor) se refleja sin F5.
  const revision = useDataRevision(['expenses', 'users', 'routes', 'expenseCategories'])
  useEffect(() => { load() }, [tenantId, user, revision])

  async function load() {
    setLoading(true)
    const [exps, cats, rts, us] = await Promise.all([
      // ALCANCE EN EL SERVICIO: gastos de rutas autorizadas y, de los de empresa,
      // solo los de la bolsa propia (Administrador) o todos (SuperAdmin).
      listVisibleExpenses({ actor: user, tenantId }),
      db.expenseCategories.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    setExpenses(exps.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.createdAt.localeCompare(a.createdAt)))
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
    // R74: gastos de ruta y de trabajador exigen custodia de la ruta; el SuperAdmin solo registra los de empresa.
    .filter(s => s !== 'empresa' ? !!user && can(user, 'expense.register', { tenantId }) && can(user, 'cashCustody.manage', { tenantId }) : canRegisterExpenseScope(user, 'empresa'))
  const trabajadores = form.routeId
    ? users.filter(u => custodianBlockedReason(u, form.routeId, tenantId) === null).sort((a, b) => a.nombre.localeCompare(b.nombre))
    : []

  const nombreDe = (id: string) => formatPersonName(users.find(u => u.id === id)?.nombre ?? id)
  function abrirNuevo() {
    setForm(FORM_VACIO)
    setOperationId(generateId())
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.scope) { toast.error('Indica a quién corresponde el gasto'); return }
    if (form.scope !== 'empresa' && !form.routeId) { toast.error('Selecciona la ruta'); return }
    if (form.scope === 'trabajador' && !form.collectorId) { toast.error('Selecciona el trabajador que pagó'); return }
    if (!form.categoryId || form.valor <= 0) { toast.error('Categoría y valor son requeridos'); return }
    if (form.routeId && form.scope !== 'empresa' && !canAccessRoute(user, form.routeId)) { toast.error('No tienes permiso sobre esa ruta.'); return }
    setSaving(true)
    try {
      // El servicio valida permisos, bolsa, Oficina activa, trabajador de la ruta y
      // fondos DENTRO de la transacción. `operationId` evita duplicados por reintento.
      await createExpense({
        actor: user, tenantId, scope: form.scope,
        routeId: form.scope === 'empresa' ? undefined : form.routeId,
        collectorId: form.scope === 'trabajador' ? form.collectorId : undefined,
        categoryId: form.categoryId, valor: form.valor, descripcion: form.descripcion, fecha: form.fecha,
        syncStatus: 'synced', operationId,
      })
      toast.success('Gasto registrado')
      setModalOpen(false)
      setForm(FORM_VACIO)
      setOperationId(generateId())
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  async function anular(reason: string) {
    if (!anulando) return
    // Permiso, bolsa, estado y vínculo: en el servicio, atómico.
    await reverseAdminExpense({ actor: user, tenantId, expenseId: anulando.id, reason })
    toast.success('Gasto anulado: el valor volvió a la bolsa')
    setAnulando(null)
    await load()
  }

  async function guardarReintegro() {
    if (!reintegrando || guardandoReintegro) return
    setGuardandoReintegro(true)
    try {
      await refundAdminExpense({
        actor: user, tenantId, expenseId: reintegrando.id, amount: reintegro.valor, reason: reintegro.motivo, operationId: reintegro.operationId,
      })
      toast.success('Reintegro registrado')
      setReintegrando(null)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo registrar el reintegro') } finally { setGuardandoReintegro(false) }
  }

  /** Bolsa de un gasto (solo gastos de empresa). */
  const bolsaDe = (e: Expense): string | null => {
    const f = expenseFundingOf(e)
    if (f.kind === 'admin') return `Bolsa de ${nombreDe(f.adminId)}`
    if (f.kind === 'empresa') return 'Bolsa de la empresa'
    if (f.kind === 'historico') return 'Histórico · sin bolsa'
    return null
  }

  const getRouteName = (id?: string) => routes.find(r => r.id === id)?.nombre ?? id ?? ''
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id
  const getUserName = (id?: string) => formatPersonName(users.find(u => u.id === id)?.nombre ?? id ?? '')
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
        <Button onClick={abrirNuevo} icon={<Plus className="w-4 h-4" />}>Nuevo gasto</Button>
      </div>

      {/* ADEX Online (Ronda 53): Oficina, Ruta, Tipo, Desde y Hasta en UNA fila en escritorio;
          en tableta y móvil la barra los reordena sola. Misma lógica de filtrado. */}
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
      >
        <Select label="Tipo" value={tipo} onChange={e => setTipo(e.target.value as ExpenseScope | '')} containerClassName="min-w-0 lg:w-44"
          options={(veEmpresa ? ['empresa', 'ruta', 'trabajador'] as ExpenseScope[] : ['ruta', 'trabajador'] as ExpenseScope[])
            .map(s => ({ value: s, label: EXPENSE_SCOPE_LABEL[s] }))}
          placeholder="Todos los tipos" />
        <Input label="Desde" type="date" value={desde} onChange={e => setDesde(e.target.value)} containerClassName="min-w-0 lg:w-40" />
        <Input label="Hasta" type="date" value={hasta} onChange={e => setHasta(e.target.value)} containerClassName="min-w-0 lg:w-40" />
        {(desde || hasta || tipo) && (
          <button onClick={() => { setDesde(''); setHasta(''); setTipo('') }} type="button"
            className="h-11 sm:h-9 inline-flex items-center justify-center gap-1 px-3 text-xs text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg self-end">
            <X className="w-3.5 h-3.5" /> Limpiar
          </button>
        )}
      </OfficeRouteFilterBar>

      <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
        {loading ? null : filtered.length === 0 ? (
          <EmptyState icon={<TrendingDown className="w-8 h-8" />} title="No hay gastos" />
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(e => {
              const scope = expenseAttribution(e, conCaja).scope
              const estado = poolExpenseStateOf(e)
              const bolsa = bolsaDe(e)
              const correccion = estado === 'anulacion' || estado === 'reintegro'
              return (
                <div key={e.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3" data-testid="expense-row">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
                      <TrendingDown className="w-4 h-4 text-red-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-1.5">
                        {getCatName(e.categoryId)}
                        <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${SCOPE_TONE[scope]}`}>{EXPENSE_SCOPE_LABEL[scope]}</span>
                        {estado !== 'ruta' && estado !== 'vigente' && (
                          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${estado === 'historico' ? 'bg-gray-100 text-gray-500' : estado === 'anulado' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
                            {POOL_STATE_LABEL[estado]}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">{bolsa ?? atribucionDe(e)} · {formatDate(e.fecha)}{e.userId ? ` · registró ${getUserName(e.userId)}` : ''}</p>
                      {e.descripcion && <p className="text-xs text-gray-500 break-words">{e.descripcion}{e.referencia ? ` · Ref. ${e.referencia}` : ''}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                    {canCorrectPoolExpense(user, e) && (<>
                      <Button size="sm" variant="ghost" onClick={() => { setReintegrando(e); setReintegro({ valor: 0, motivo: '', operationId: generateId() }) }}>Reintegro</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAnulando(e)}>Anular</Button>
                    </>)}
                    <span className={`text-sm font-bold ${correccion ? 'text-emerald-600' : estado === 'anulado' ? 'text-gray-400 line-through' : 'text-red-600'}`}>
                      {correccion ? `+${formatCurrency(-e.valor, currency)}` : `-${formatCurrency(e.valor, currency)}`}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => { if (!saving) setModalOpen(false) }} title="Registrar gasto"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="¿A quién corresponde este gasto?" value={form.scope} required
            onChange={e => {
              const scope = e.target.value as ExpenseScope | ''
              // Empresa = gasto administrativo pagado con una bolsa: formulario propio.
              if (scope === 'empresa') { setModalOpen(false); setAdminModal(true); return }
              setForm(f => ({ ...f, scope, collectorId: '' }))
            }}
            options={tiposPermitidos.map(s => ({ value: s, label: EXPENSE_SCOPE_LABEL[s] }))}
            placeholder="Seleccionar tipo"
            hint={form.scope ? EFECTO[form.scope] : 'Decide qué efectivo reduce el gasto, no quién lo registra.'} />
          {(form.scope === 'ruta' || form.scope === 'trabajador') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value, collectorId: '' }))}
                options={officeRoutes
                  // v16: gasto de ruta (lo paga su caja) o cargado a un trabajador:
                  // solo en rutas donde el actor tiene autoridad sobre la caja.
                  .filter(r => canRegisterExpenseScope(user, form.scope as ExpenseScope, r.id, { route: r, users }))
                  .map(r => ({ value: r.id, label: r.nombre }))}
                placeholder="Seleccionar ruta" required
                hint={form.scope === 'ruta' ? 'Solo las rutas de las que eres responsable de capital: el gasto sale de su caja.' : undefined} />
              {form.scope === 'trabajador' && (
                <Select label="Trabajador que pagó" value={form.collectorId} onChange={e => setForm(f => ({ ...f, collectorId: e.target.value }))}
                  options={trabajadores.map(u => ({ value: u.id, label: formatPersonName(u.nombre) }))}
                  placeholder={form.routeId ? (trabajadores.length ? 'Seleccionar trabajador' : 'La ruta no tiene trabajadores') : 'Elige primero la ruta'} required />
              )}
            </div>
          )}
          <Select label="Categoría" value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
            options={categories.filter(c => c.activa).map(c => ({ value: c.id, label: c.nombre }))} placeholder="Seleccionar categoría" required />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Gasto administrativo (empresa): bolsa explícita, disponible, confirmación. */}
      <AdminExpenseModal open={adminModal} onClose={() => setAdminModal(false)} onSaved={() => { void load() }}
        users={users} categories={categories} />

      {/* ANULACIÓN de un gasto de bolsa: motivo obligatorio; el servicio enlaza la reversión. */}
      <ReverseMovementModal currency={currency} onCancel={() => setAnulando(null)} onConfirm={anular}
        target={anulando && { tipo: 'Gasto administrativo', valor: anulando.valor, fecha: anulando.fecha, detalle: `${getCatName(anulando.categoryId)} · ${bolsaDe(anulando) ?? ''}` }} />

      {/* REINTEGRO: dinero devuelto por el proveedor; con tope en lo no reintegrado. */}
      <Modal open={!!reintegrando} onClose={() => { if (!guardandoReintegro) setReintegrando(null) }} title="Registrar reintegro" size="sm"
        footer={<><Button variant="secondary" onClick={() => setReintegrando(null)} disabled={guardandoReintegro}>Cancelar</Button>
          <Button onClick={guardarReintegro} loading={guardandoReintegro} disabled={reintegro.valor <= 0 || reintegro.motivo.trim().length < 3}>Registrar reintegro</Button></>}>
        {reintegrando && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">{getCatName(reintegrando.categoryId)} · {formatCurrency(reintegrando.valor, currency)} · {bolsaDe(reintegrando)}</p>
            <p className="text-xs text-gray-500">Pendiente por reintegrar: <b>{formatCurrency(reintegrando.valor - refundedAmountOf(reintegrando.id, expenses), currency)}</b>. El valor vuelve a la misma bolsa.</p>
            <MoneyInput label="Valor reintegrado" currency={currency} value={reintegro.valor} onValueChange={v => setReintegro(r => ({ ...r, valor: v }))} required />
            <Input label="Motivo" value={reintegro.motivo} placeholder="Ej.: el proveedor devolvió un casco" onChange={e => setReintegro(r => ({ ...r, motivo: e.target.value }))} />
          </div>
        )}
      </Modal>
    </div>
  )
}
