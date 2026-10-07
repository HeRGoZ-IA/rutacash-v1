import { useState, useEffect } from 'react'
import { Plus, Wallet, ChevronRight, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { DateRangeFilter } from '@/components/ui/DateRangeFilter'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteBase } from '@/services/cashboxEngine'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useDataRevision } from '@/hooks/useDataRevision'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import { filterAccessibleRoutes, filterByAccessibleRoute, canAccessRoute } from '@/lib/permissions'
import { useOfficeRouteFilter } from '@/hooks/useOfficeRouteFilter'
import { OfficeRouteFilterBar } from '@/components/ui/OfficeRouteFilterBar'
import type { Withdrawal, Route, User } from '@/models/types'
import { registerWithdrawal, getRouteAvailableFunds, canManageRouteFunds } from '@/services/routeFundsService'
import { CapitalControllerBadge } from '@/components/ui/CapitalControllerBadge'
import { canReverseRouteFund, reverseWithdrawal } from '@/services/movementReversalService'
import { pairReversals, reversalStateOf } from '@/lib/movementReversal'
import { AnnulledBadge, ReversalDetail, ReverseButton, ReverseMovementModal, signedMoney } from '@/components/ui/MovementReversal'

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
  const { tenantId, currency } = useTenant()
  const officeFilter = useOfficeRouteFilter()
  const { user } = useAuth()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [users, setUsers] = useState<User[]>([])
  // Base de la ruta (getRouteBase) por ruta, recalculada en cada carga.
  const [baseByRoute, setBaseByRoute] = useState<Record<string, number>>({})
  // Retirable = caja NO asignada (lo que está en manos de trabajadores no se retira).
  const [disponibleByRoute, setDisponibleByRoute] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [form, setForm] = useState({ routeId: '', valor: 0, descripcion: '', fecha: today() })
  // Grupo de ruta seleccionado para ver el detalle de sus retiros.
  // Ruta cuyo detalle está abierto: el grupo se DERIVA de los datos recargados.
  const [detailRouteId, setDetailRouteId] = useState<string | null>(null)
  const [reversing, setReversing] = useState<Withdrawal | null>(null)

  // Reactiva: otra pestaña del mismo navegador registra y esta vista se entera sin F5.
  const revision = useDataRevision()
  useEffect(() => { load() }, [tenantId, user, revision])

  async function load() {
    setLoading(true)
    const [ws, rts, us] = await Promise.all([
      db.withdrawals.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: retiros y rutas limitados a los autorizados.
    const scopedRts = filterAccessibleRoutes(user, rts)
    setWithdrawals(filterByAccessibleRoute(user, ws).sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(scopedRts)
    setUsers(us)
    const base: Record<string, number> = {}
    const disp: Record<string, number> = {}
    for (const r of scopedRts) {
      base[r.id] = await getRouteBase(r.id)
      disp[r.id] = await getRouteAvailableFunds(tenantId, r.id)
    }
    setBaseByRoute(base)
    setDisponibleByRoute(disp)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.routeId || form.valor <= 0) { toast.error('Ruta y valor requeridos'); return }
    if (!canAccessRoute(user, form.routeId)) { toast.error('No tienes permiso sobre esa ruta.'); return }
    setSaving(true)
    try {
      // Fondos disponibles (caja NO asignada), permiso, Oficina y autoría: en el SERVICIO.
      await registerWithdrawal({ actor: user, tenantId, routeId: form.routeId, valor: form.valor, descripcion: form.descripcion, fecha: form.fecha })
      toast.success('Retiro registrado')
      setModalOpen(false)
      setForm({ routeId: '', valor: 0, descripcion: '', fecha: today() })
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error') } finally { setSaving(false) }
  }

  const getUserName = (id?: string) => users.find(u => u.id === id)?.nombre
  // v16: solo se retira de las rutas cuyo capital controla el actor; el retiro
  // vuelve a SU bolsa. El SuperAdmin no retira de rutas: recoge capital del Admin.
  const rutasControladas = routes.filter(r => canManageRouteFunds(user, r, tenantId, users))

  // Retiros dentro del rango de fecha (los totales agrupados lo respetan;
  // la Base de la ruta es un saldo a la fecha y no depende del filtro).
  const withdrawalsEnAlcance = officeFilter.filterRows(withdrawals)
  const visibleWithdrawals = withdrawalsEnAlcance.filter(w =>
    (!desde || w.fecha >= desde) && (!hasta || w.fecha <= hasta)
  )

  // ---- Agrupación por ruta (solo presentación; no recalcula saldos contables) ----
  const groups: WithdrawalGroup[] = (() => {
    const buildGroup = (routeId: string, nombre: string, codigo: string, baseActual: number): WithdrawalGroup => {
      const ws = visibleWithdrawals.filter(w => w.routeId === routeId) // ya vienen ordenados desc por fecha
      return {
        routeId, nombre, codigo, baseActual,
        // Efecto vigente: un retiro anulado y su reversión suman 0.
        totalRetirado: ws.reduce((s, w) => s + w.valor, 0),
        cantidad: pairReversals(ws).length,
        ultimoRetiro: ws[0]?.fecha,
        withdrawals: ws,
      }
    }

    const list = routes.map(r => buildGroup(r.id, r.nombre, r.codigo, baseByRoute[r.id] ?? 0))

    // Retiros cuya ruta ya no existe (o sin routeId) → grupo "Sin ruta".
    const knownRouteIds = new Set(routes.map(r => r.id))
    const orphan = visibleWithdrawals.filter(w => !w.routeId || !knownRouteIds.has(w.routeId))
    if (orphan.length > 0) {
      list.push({
        routeId: '__none__', nombre: 'Sin ruta', codigo: '—', baseActual: 0,
        totalRetirado: orphan.reduce((s, w) => s + w.valor, 0),
        cantidad: orphan.length, ultimoRetiro: orphan[0]?.fecha, withdrawals: orphan,
      })
    }
    return list
  })()

  const detailGroup = detailRouteId ? groups.find(g => g.routeId === detailRouteId) ?? null : null

  async function handleReverse(reason: string) {
    if (!reversing) return
    // Permiso, ruta y estado vigente: en el servicio, atómico.
    await reverseWithdrawal({ actor: user, tenantId, movementId: reversing.id, reason })
    toast.success('Retiro anulado')
    setReversing(null)
    await load()
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Retiros</h1>
          <p className="text-sm text-gray-500 mt-0.5">{withdrawals.length} retiro(s) · {routes.length} ruta(s)</p>
        </div>
        {rutasControladas.length > 0 && (
          <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Nuevo retiro</Button>
        )}
      </div>
      {!loading && rutasControladas.length === 0 && (
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2" data-testid="withdrawals-readonly">
          {user?.rol === 'superadmin'
            ? 'Los retiros de una ruta los registra su Administrador responsable de capital y vuelven a su bolsa. Para recoger capital de un Administrador usa Capital.'
            : 'No eres responsable de capital de ninguna ruta: consulta los retiros, pero solo el responsable de cada ruta puede registrarlos.'}
        </p>
      )}

      {/* Filtro por fecha (compacto) */}
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
        onClear={() => { setDesde(''); setHasta('') }} />

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
                    {g.routeId !== '__none__' && <CapitalControllerBadge route={routes.find(r => r.id === g.routeId)} users={users} currentUserId={user?.id} />}
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
                  <p className="text-xs text-gray-400">Base de la ruta</p>
                  <p className="text-sm font-bold text-primary-700">{g.routeId === '__none__' ? '—' : formatCurrency(g.baseActual, currency)}</p>
                </div>
              </div>

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">
                  {g.ultimoRetiro ? `Último: ${formatDate(g.ultimoRetiro)}` : 'Sin retiros'}
                </p>
                <Button variant="secondary" size="sm" disabled={g.cantidad === 0} onClick={() => setDetailRouteId(g.routeId)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
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
            options={rutasControladas.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          <p className="text-xs text-gray-500">El retiro vuelve a tu bolsa de capital (Capital → Disponible).</p>
          {form.routeId && disponibleByRoute[form.routeId] !== undefined && (
            <p className={`text-xs ${form.valor > disponibleByRoute[form.routeId] ? 'text-red-600' : 'text-gray-500'}`}>
              Disponible para retiro (caja no asignada): <b>{formatCurrency(disponibleByRoute[form.routeId], currency)}</b>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
            <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de retiros de una ruta */}
      <Modal open={!!detailGroup} onClose={() => setDetailRouteId(null)} title={detailGroup ? `Retiros · ${detailGroup.nombre}` : 'Retiros'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailRouteId(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Total retirado</p><p className="font-bold text-amber-600">{formatCurrency(detailGroup.totalRetirado, currency)}</p></div>
              <div className="bg-primary-50 rounded-xl p-3"><p className="text-xs text-gray-400">Base de la ruta</p><p className="font-bold text-primary-700">{detailGroup.routeId === '__none__' ? '—' : formatCurrency(detailGroup.baseActual, currency)}</p></div>
            </div>
            {detailGroup.withdrawals.length === 0 ? (
              <div className="flex justify-center py-8 text-gray-400 text-sm">Esta ruta no tiene retiros</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                {pairReversals(detailGroup.withdrawals).map(({ movement: w, reversal }) => {
                  const estado = reversalStateOf(w)
                  return (
                    <div key={w.id}>
                      <div className="flex items-center justify-between gap-2 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 bg-amber-50 rounded-xl flex items-center justify-center flex-shrink-0">
                            <Wallet className="w-4 h-4 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                              {estado === 'reversion' ? 'Reversión de retiro' : w.descripcion || 'Retiro'}
                              {estado === 'anulado' && <AnnulledBadge />}
                            </p>
                            <p className="text-xs text-gray-400">{formatDate(w.fecha)}{getUserName(w.userId) ? ` · ${getUserName(w.userId)}` : ''}{estado === 'reversion' && w.reversalReason ? ` · Motivo: ${w.reversalReason}` : ''}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {canReverseRouteFund(user, w, routes, users) && <ReverseButton onClick={() => setReversing(w)} />}
                          <span className={`text-sm font-bold ${estado === 'anulado' ? 'text-gray-400 line-through' : w.valor >= 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{signedMoney(-w.valor, currency)}</span>
                        </div>
                      </div>
                      {estado === 'anulado' && <ReversalDetail original={w} reversal={reversal} currency={currency} signo={-1} userName={getUserName} />}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ReverseMovementModal currency={currency} onCancel={() => setReversing(null)} onConfirm={handleReverse}
        target={reversing && { tipo: 'Retiro', valor: reversing.valor, fecha: reversing.fecha, detalle: [routes.find(r => r.id === reversing.routeId)?.nombre, reversing.descripcion].filter(Boolean).join(' · ') }} />
    </div>
  )
}
