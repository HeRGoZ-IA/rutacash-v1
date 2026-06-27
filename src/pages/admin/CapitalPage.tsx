import { useState, useEffect } from 'react'
import { Plus, DollarSign, ChevronRight, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { getRouteFinancialSummary } from '@/services/cashboxEngine'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import type { CapitalMovement, Route, Withdrawal, RouteFinancialSummary } from '@/models/types'

// Paquete 3 — Resumen de capital agrupado por ruta.
interface CapitalGroup {
  routeId: string
  nombre: string
  codigo: string
  capitalInicial: number
  totalInyectado: number
  totalRetirado: number
  capitalActual: number   // Base actual (saldo de caja)
  carteraEnCalle: number  // Pendiente por cobrar en la calle
  totalControlado: number // Base actual + cartera en calle
  cantidad: number
  ultimoMovimiento?: string
  movements: CapitalMovement[]
}

export default function CapitalPage() {
  const { tenantId, officeId, currency } = useTenant()
  const { user } = useAuth()
  const [movements, setMovements] = useState<CapitalMovement[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  // Resumen financiero REAL por ruta (Base actual + Cartera en calle), recalculado en cada carga.
  const [summaryByRoute, setSummaryByRoute] = useState<Record<string, RouteFinancialSummary>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ routeId: '', valor: 0, descripcion: '', fecha: today(), tipo: 'ingresoCapital' as const })
  // Grupo de ruta seleccionado para ver su detalle de movimientos.
  const [detailGroup, setDetailGroup] = useState<CapitalGroup | null>(null)

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [movs, rts, wds] = await Promise.all([
      db.capitalMovements.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.withdrawals.where('tenantId').equals(tenantId).toArray(),
    ])
    setMovements(movs.sort((a, b) => b.fecha.localeCompare(a.fecha)))
    setRoutes(rts)
    setWithdrawals(wds)
    // Resumen financiero real por ruta: Base actual (saldo de caja) y Cartera en calle.
    const sum: Record<string, RouteFinancialSummary> = {}
    for (const r of rts) sum[r.id] = await getRouteFinancialSummary(r.id)
    setSummaryByRoute(sum)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.routeId || form.valor <= 0) { toast.error('Selecciona ruta y valor'); return }
    setSaving(true)
    try {
      const mov: CapitalMovement = {
        id: generateId(), tenantId, officeId: routes.find(r => r.id === form.routeId)?.officeId ?? officeId,
        routeId: form.routeId, tipo: form.tipo, valor: form.valor,
        descripcion: form.descripcion, fecha: form.fecha, userId: user?.id ?? '', createdAt: nowISO(),
      }
      await db.capitalMovements.add(mov)
      toast.success('Capital registrado')
      setModalOpen(false)
      setForm({ routeId: '', valor: 0, descripcion: '', fecha: today(), tipo: 'ingresoCapital' })
      await load()
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  // ---- Agrupación por ruta (solo presentación; no recalcula saldos contables) ----
  const groups: CapitalGroup[] = (() => {
    const routesView = routes
    const movementsView = movements
    const wdByRoute = new Map<string, number>()
    for (const w of withdrawals) wdByRoute.set(w.routeId, (wdByRoute.get(w.routeId) ?? 0) + w.valor)

    const buildGroup = (routeId: string, nombre: string, codigo: string, capitalInicial: number, summary?: RouteFinancialSummary): CapitalGroup => {
      const movs = movementsView.filter(m => m.routeId === routeId)
      const capitalActual = summary?.baseActual ?? 0
      const carteraEnCalle = summary?.carteraEnCalle ?? 0
      return {
        routeId, nombre, codigo, capitalInicial, capitalActual, carteraEnCalle,
        totalControlado: summary?.totalControlado ?? capitalActual,
        totalInyectado: movs.reduce((s, m) => s + m.valor, 0),
        totalRetirado: wdByRoute.get(routeId) ?? 0,
        cantidad: movs.length,
        ultimoMovimiento: movs[0]?.fecha, // movements vienen ordenados desc por fecha
        movements: movs,
      }
    }

    const list = routesView.map(r => buildGroup(r.id, r.nombre, r.codigo, r.capitalInicial, summaryByRoute[r.id]))

    // Movimientos cuya ruta ya no existe (o sin routeId) → grupo "Sin ruta".
    const knownRouteIds = new Set(routesView.map(r => r.id))
    const orphan = movementsView.filter(m => !m.routeId || !knownRouteIds.has(m.routeId))
    if (orphan.length > 0) {
      list.push({
        routeId: '__none__', nombre: 'Sin ruta', codigo: '—',
        capitalInicial: 0, capitalActual: 0, carteraEnCalle: 0, totalControlado: 0,
        totalInyectado: orphan.reduce((s, m) => s + m.valor, 0),
        totalRetirado: 0, cantidad: orphan.length,
        ultimoMovimiento: orphan[0]?.fecha, movements: orphan,
      })
    }
    return list
  })()

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-bold text-gray-900">Capital / Base</h1><p className="text-sm text-gray-500 mt-0.5">{movements.length} movimiento(s) · {routes.length} ruta(s)</p></div>
        <Button onClick={() => setModalOpen(true)} icon={<Plus className="w-4 h-4" />}>Inyectar capital</Button>
      </div>

      {/* Historial agrupado por ruta: una tarjeta por ruta */}
      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : groups.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 flex justify-center py-12 text-gray-400 text-sm">No hay rutas ni movimientos</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groups.map(g => (
            <div key={g.routeId} className="bg-white rounded-2xl shadow-card border border-gray-100 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                    <MapPin className="w-4 h-4 text-primary-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{g.nombre}</p>
                    <p className="text-xs text-gray-400">{g.codigo}</p>
                  </div>
                </div>
                <span className="text-xs text-gray-400">{g.cantidad} mov.</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <div className="bg-primary-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Base actual</p>
                  <p className="text-sm font-bold text-primary-700">{g.routeId === '__none__' ? '—' : formatCurrency(g.capitalActual, currency)}</p>
                </div>
                <div className="bg-indigo-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Cartera en calle</p>
                  <p className="text-sm font-bold text-indigo-600">{g.routeId === '__none__' ? '—' : formatCurrency(g.carteraEnCalle, currency)}</p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Total inyectado</p>
                  <p className="text-sm font-bold text-emerald-600">{formatCurrency(g.totalInyectado, currency)}</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-2.5">
                  <p className="text-xs text-gray-400">Total retirado</p>
                  <p className="text-sm font-bold text-amber-600">{formatCurrency(g.totalRetirado, currency)}</p>
                </div>
              </div>
              {g.routeId !== '__none__' && (
                <div className="mt-2 bg-gray-50 rounded-xl p-2.5 flex items-center justify-between">
                  <p className="text-xs text-gray-400">Total controlado (base + cartera)</p>
                  <p className="text-sm font-bold text-gray-800">{formatCurrency(g.totalControlado, currency)}</p>
                </div>
              )}

              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-gray-400">
                  {g.ultimoMovimiento ? `Último: ${formatDate(g.ultimoMovimiento)}` : 'Sin movimientos'}
                </p>
                <Button variant="secondary" size="sm" onClick={() => setDetailGroup(g)} icon={<ChevronRight className="w-3.5 h-3.5" />}>
                  Ver movimientos
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inyectar capital (sin cambios de lógica contable) */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Inyectar capital"
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button><Button onClick={handleSave} loading={saving}>Registrar</Button></>}>
        <div className="space-y-4">
          <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
            options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          <MoneyInput label="Valor" currency={currency} value={form.valor} onValueChange={v => setForm(f => ({ ...f, valor: v }))} required />
          <Input label="Fecha" type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          <Textarea label="Descripción" value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} rows={2} />
        </div>
      </Modal>

      {/* Detalle de movimientos de una ruta */}
      <Modal open={!!detailGroup} onClose={() => setDetailGroup(null)} title={detailGroup ? `Movimientos · ${detailGroup.nombre}` : 'Movimientos'} size="lg"
        footer={<Button variant="secondary" onClick={() => setDetailGroup(null)}>Cerrar</Button>}>
        {detailGroup && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-emerald-50 rounded-xl p-3"><p className="text-xs text-gray-400">Total inyectado</p><p className="font-bold text-emerald-600">{formatCurrency(detailGroup.totalInyectado, currency)}</p></div>
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Total retirado</p><p className="font-bold text-amber-600">{formatCurrency(detailGroup.totalRetirado, currency)}</p></div>
            </div>
            {detailGroup.movements.length === 0 ? (
              <div className="flex justify-center py-8 text-gray-400 text-sm">Esta ruta no tiene inyecciones de capital</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                {detailGroup.movements.map(m => (
                  <div key={m.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
                        <DollarSign className="w-4 h-4 text-primary-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{m.descripcion || (m.tipo === 'ingresoCapital' ? 'Inyección de capital' : 'Ajuste de capital')}</p>
                        <p className="text-xs text-gray-400">{formatDate(m.fecha)}</p>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-emerald-600">+{formatCurrency(m.valor, currency)}</span>
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
