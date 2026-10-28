// ADEX Online: COPIA de CollectorExpensesPage (CLEAN). Cambios marcados «ADEX Online (Ronda 62)»:
// MODO SIN CONEXIÓN del Cobrador. Sin servidor, su gasto PROPIO (lo paga su efectivo; puede dejarlo
// negativo, regla vigente 73209ce) se guarda en el dispositivo y se envía al volver internet. Los
// gastos guardados se listan aparte como «pendientes» y no se suman al total confirmado. Con
// internet, el flujo y las reglas son los originales.
import { useState, useEffect, useRef, useMemo } from 'react'
import { Plus, DollarSign, Image as ImageIcon } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { PhotoInput } from '@/components/ui/PhotoInput'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { hasPersonalCashbox } from '@/lib/collectorAttribution'
import { expenseAttribution, isExpenseOf } from '@/lib/expenseAttribution'
import { can } from '@/lib/permissions'
import { generateId } from '@/lib/utils'
import { formatPersonName } from '@/lib/displayName'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol, formatDate, today } from '@/lib/formatters'
import type { Expense, ExpenseCategory, Route, User } from '@/models/types'
import { custodianBlockedReason } from '@/services/cashCustodyService'
import { canRegisterExpenseScope, createExpense } from '@/services/expenseService'
// ADEX Online (Ronda 62).
import { isOpen, shouldCaptureOffline, useOffline } from '../../../offline/state.ts'
import { captureOfflineExpense } from '../../../offline/captures.ts'
import { OpStatusBadge, useReachable } from '../../../offline/ui.tsx'
import { toMajor } from '../../../runtime/mappers.ts'
// ADEX Online (3.18): fechas de los cierres de ruta (sin cifras) para separar los gastos ya cerrados.
import { serverView } from '../../../runtime/projection.ts'

interface ClosedRange { routeId: string; from: string; to: string }

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
  // Id de la operación en curso: se reutiliza en cada reintento del MISMO gasto
  // (doble toque, error de red) para que el servicio no lo duplique.
  const operacion = useRef<string | null>(null)
  // ADEX Online (Ronda 62): gastos guardados en el dispositivo (sin confirmar).
  const offlineOps = useOffline((st) => st.ops)
  const offlineEnabled = useOffline((st) => st.enabled)
  const reachable = useReachable()

  // Gastos de la ruta activa (o la ruta principal del cobrador)
  const routeId = activeRouteId ?? user?.routeId ?? null

  // ATRIBUCIÓN (punto 9): quien tiene caja personal paga sus gastos con su propio
  // efectivo, sin selector (`hasPersonalCashbox(user.rol)`, el mismo predicado que
  // cobros y desembolsos). Solo quien administra la caja de la ruta (Supervisor)
  // puede indicar que pagó OTRO trabajador o la caja de la ruta.
  const pagaConSuEfectivo = !!user && hasPersonalCashbox(user.rol)
  // v16: cargar el gasto a OTRO trabajador es nivel de cuadre (Supervisor de la
  // ruta); que lo pague la CAJA de la ruta, solo su Administrador responsable.
  const [ruta, setRuta] = useState<Route | undefined>()
  const [usuarios, setUsuarios] = useState<User[]>([])
  const eligeQuienPaga = !!user && !!routeId && canRegisterExpenseScope(user, 'trabajador', routeId, { route: ruta, users: usuarios })
  const pagaCajaRuta = !!user && !!routeId && canRegisterExpenseScope(user, 'ruta', routeId, { route: ruta, users: usuarios })
  // Ver los gastos de la ruta (no solo los propios) es información de la caja de la
  // ruta: el Cobrador no la tiene (`cashbox.viewRoute`), el Supervisor sí.
  const veGastosDeRuta = !!user && !!routeId && can(user, 'cashbox.viewRoute', { routeId, tenantId: user.tenantId })

  // Un gasto registrado en otra pestaña (Admin, Supervisor) se refleja sin F5.
  const revision = useDataRevision(['expenses', 'users'])

  // ADEX Online (3.18, opción A del socio): arriba los gastos del periodo abierto; abajo, plegados, los que ya
  // entraron en un cierre de ruta. El corte es el ÚLTIMO cierre de ruta (Liquidación → Cierre de ruta), de
  // cualquier rango. Solo presentación: no se oculta ni se borra nada. Sin el dato (API anterior o sin
  // conexión) se muestran todos juntos, como antes.
  const [cierres, setCierres] = useState<ClosedRange[] | null>(null)
  useEffect(() => {
    if (!routeId) { setCierres(null); return }
    let alive = true
    serverView<{ ranges: ClosedRange[] }>(`/v1/periods/closed-ranges?routeId=${encodeURIComponent(routeId)}`)
      .then(r => { if (alive) setCierres(r.ranges.filter(x => x.routeId === routeId)) })
      .catch(() => { if (alive) setCierres(null) })
    return () => { alive = false }
  }, [routeId, revision])
  const ultimoCierre = cierres && cierres.length ? cierres.reduce((m, c) => (c.to > m ? c.to : m), '') : null
  const enCierre = (e: Expense) => ultimoCierre !== null && e.fecha.slice(0, 10) <= ultimoCierre
  const abiertos = expenses.filter(e => !enCierre(e))
  const cerrados = expenses.filter(enCierre)
  const notaCierre = (e: Expense) => {
    const c = cierres?.find(x => x.from <= e.fecha.slice(0, 10) && e.fecha.slice(0, 10) <= x.to)
    return c ? `Incluido en el cierre del ${formatDate(c.to, 'dd/MM')}` : 'Anterior al último cierre'
  }
  useEffect(() => { load() }, [user, routeId, revision])

  async function load() {
    if (!user || !routeId) return
    const [exps, cats, users, r] = await Promise.all([
      db.expenses.where('routeId').equals(routeId).toArray(),
      db.expenseCategories.where('tenantId').equals(user.tenantId).toArray(),
      db.users.where('tenantId').equals(user.tenantId).toArray(),
      db.routes.get(routeId),
    ])
    setRuta(r)
    setUsuarios(users)
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
    // ADEX Online (Ronda 62): sin servidor, el Cobrador guarda su propio gasto en el dispositivo.
    if (user.rol === 'cobrador' && shouldCaptureOffline()) {
      if (form.receiptPhotoDataUrl) { toast.error('Sin conexión no se pueden adjuntar fotos. Guarde el gasto sin foto.'); return }
      setSaving(true)
      try {
        await captureOfflineExpense({ routeId, workerId: user.id, categoryId: form.categoryId, categoryName: getCatName(form.categoryId), amount: form.valor, description: form.descripcion })
        toast.success('Gasto guardado en este dispositivo. Se enviará al volver internet.')
        setForm({ categoryId: '', valor: 0, descripcion: '', receiptPhotoDataUrl: undefined, pagadoPor: '' })
        setShowForm(false)
      } catch { toast.error('No se pudo guardar el gasto en este dispositivo. No se registró nada.') } finally { setSaving(false) }
      return
    }
    // Por defecto paga quien registra; el Supervisor puede indicar otra cosa.
    const pagadoPor = eligeQuienPaga && form.pagadoPor ? form.pagadoPor : (pagaConSuEfectivo ? user.id : CAJA_RUTA)
    setSaving(true)
    try {
      // `userId` = quién REGISTRÓ; la atribución (`scope` + `collectorId`) = a qué
      // efectivo se carga. El servicio valida permisos, ruta y Oficina activa; el
      // gasto de un trabajador puede dejar su efectivo en negativo (se concilia en
      // su cuadre). El instante se sella BAJO BLOQUEO: frontera exacta del cuadre.
      if (!operacion.current) operacion.current = generateId()
      await createExpense({
        actor: user, tenantId: user.tenantId, routeId,
        scope: pagadoPor === CAJA_RUTA ? 'ruta' : 'trabajador',
        collectorId: pagadoPor === CAJA_RUTA ? undefined : pagadoPor,
        categoryId: form.categoryId, valor: form.valor,
        descripcion: form.descripcion, receiptPhotoDataUrl: form.receiptPhotoDataUrl,
        syncStatus: navigator.onLine ? 'synced' : 'pending',
        operationId: operacion.current,
      })
      operacion.current = null
      toast.success('Gasto registrado')
      setForm({ categoryId: '', valor: 0, descripcion: '', receiptPhotoDataUrl: undefined, pagadoPor: '' })
      setShowForm(false)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  const mios = expenses.filter(e => user && isExpenseOf(e, user.id))
  // ADEX Online (Ronda 62): gastos de esta ruta guardados en el dispositivo, aún sin confirmar.
  const pendientes = useMemo(() => offlineOps.filter(o => o.kind === 'expense' && o.routeId === routeId && isOpen(o)), [offlineOps, routeId])
  const todayTotal = mios.filter(e => e.fecha === today()).reduce((s, e) => s + e.valor, 0)
  const getCatName = (id: string) => categories.find(c => c.id === id)?.nombre ?? id
  // 3.14 (0040): el Cobrador y el Supervisor solo usan los tipos activos marcados «Para Cobradores».
  const usables = categories.filter(c => c.activa && c.paraCobradores !== false)
  const nombreDe = (id?: string) => formatPersonName(team.find(u => u.id === id)?.nombre) || 'Trabajador'
  /** Para el Supervisor: a quién se cargó cada gasto. */
  const etiqueta = (e: Expense) => {
    const a = expenseAttribution(e)
    if (user && a.cashHolderId === user.id) return 'Mi efectivo'
    if (a.scope === 'trabajador') return `Base del trabajador · ${nombreDe(a.cashHolderId)}`
    return 'Base disponible'
  }

  const fila = (e: Expense, nota?: string) => (
    <div key={e.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center justify-between" data-testid={nota ? 'expense-closed-item' : 'expense-item'}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-red-50 rounded-xl flex items-center justify-center">
          <DollarSign className="w-4 h-4 text-red-500" />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700">{getCatName(e.categoryId)}</p>
          <p className="text-xs text-gray-500">{formatDate(e.fecha)}{e.descripcion ? ` · ${e.descripcion}` : ''}</p>
          {veGastosDeRuta && <p className="text-[11px] font-medium text-gray-500">{etiqueta(e)}</p>}
          {nota && <p className="text-[11px] font-medium text-gray-500" data-testid="expense-closed-note">{nota}</p>}
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
  )

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-gray-900">Gastos</h1>
          <p className="text-xs text-gray-500">{veGastosDeRuta ? 'Con mi efectivo hoy' : 'Hoy'}: {formatCurrency(todayTotal, currency)}</p>
        </div>
        <button onClick={() => { operacion.current = null; setShowForm(true) }} data-testid="expense-new" aria-label="Registrar gasto" className="w-10 h-10 bg-primary-600 text-white rounded-full flex items-center justify-center">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
          <p className="font-semibold text-sm text-gray-700">Registrar gasto</p>
          {usables.length === 0 ? (
            <p className="text-xs text-amber-600">No hay categorías de gasto para Cobradores. Pide al administrador que marque «Para Cobradores» en las categorías.</p>
          ) : (
            // Selector expandible (dropdown): escala bien aunque haya muchas categorías.
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Categoría</label>
              <select
                data-testid="expense-category"
                value={form.categoryId}
                onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full h-12 rounded-xl border border-gray-200 bg-white px-3 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="">Seleccionar categoría…</option>
                {usables.map(c => (
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
                  <option key={u.id} value={u.id}>Base del trabajador · {formatPersonName(u.nombre)}</option>
                ))}
                {pagaCajaRuta && <option value={CAJA_RUTA}>Base disponible de la ruta</option>}
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

      {/* ADEX Online (Ronda 62): pendientes del dispositivo, aparte y sin sumar al total. */}
      {offlineEnabled && !reachable && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900" data-testid="expense-offline-note">
          Sin conexión: tus gastos se guardan en este dispositivo y se envían al volver internet.
        </div>
      )}
      {pendientes.length > 0 && (
        <div className="space-y-2" data-testid="expense-pending">
          <p className="text-xs font-semibold text-gray-500">Guardados en este dispositivo (sin confirmar)</p>
          {pendientes.map(o => (
            <div key={o.id} className="bg-white rounded-xl border border-amber-200 px-4 py-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-700 truncate">{o.ref.label ?? 'Gasto'}</p>
                <OpStatusBadge status={o.status} />
              </div>
              <span className="text-sm font-bold text-gray-500 tabular-nums">-{formatCurrency(toMajor(o.ref.amountMinor ?? 0), currency)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2" data-testid="expense-open-list">
        {cerrados.length > 0 && <p className="text-xs font-semibold text-gray-500">Después del último cierre ({formatDate(ultimoCierre!, 'dd/MM')})</p>}
        {abiertos.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">{cerrados.length > 0 ? 'No hay gastos después del último cierre' : 'No hay gastos registrados'}</div>
        ) : abiertos.map(e => fila(e))}
      </div>

      {cerrados.length > 0 && (
        <details className="group rounded-2xl border border-gray-200 bg-gray-50" data-testid="expense-closed-block">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-gray-700 flex items-center justify-between">
            <span>Ya incluidos en cierres ({cerrados.length})</span>
            <span className="text-xs text-gray-500 group-open:hidden">Ver</span>
            <span className="text-xs text-gray-500 hidden group-open:inline">Ocultar</span>
          </summary>
          <div className="space-y-2 px-3 pb-3">
            {cerrados.map(e => fila(e, notaCierre(e)))}
          </div>
        </details>
      )}
    </div>
  )
}
