import { useState, useEffect } from 'react'
import { Plus, CreditCard, Search, XCircle, CheckCircle, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { SaleStatusBadge, InstallmentStatusBadge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { useRouteCapital } from '@/hooks/useRouteCapital'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO, formatPaymentDays } from '@/lib/formatters'
import {
  generateInstallments, calculateTotalWithInterest,
  estimateFinalDate, calculateInstallmentValue,
  applyPaymentToInstallments, calculateSaleBalance,
} from '@/services/installmentEngine'
import type { Sale, Client, Route, Installment } from '@/models/types'

// Días de pago (1=lunes ... 6=sábado, 0=domingo)
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
]

// Tasa de interés fija seleccionable (Paquete 1: solo 10% o 20%, sin tasa libre)
const TASA_OPTIONS = [
  { value: '10', label: '10%' },
  { value: '20', label: '20%' },
]

export default function ActiveSalesPage() {
  const { tenantId, officeId, currency } = useTenant()
  const { user } = useAuth()
  const [sales, setSales] = useState<Sale[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [search, setSearch] = useState('')
  const [filterRoute, setFilterRoute] = useState('')
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [detailSale, setDetailSale] = useState<Sale | null>(null)
  const [detailInstallments, setDetailInstallments] = useState<Installment[]>([])
  const [lostOpen, setLostOpen] = useState(false)
  const [lostSale, setLostSale] = useState<Sale | null>(null)
  const [motivoPerdida, setMotivoPerdida] = useState('')
  const [saving, setSaving] = useState(false)
  const [paymentSale, setPaymentSale] = useState<Sale | null>(null)
  const [paymentValor, setPaymentValor] = useState(0)
  const [payingQuick, setPayingQuick] = useState(false)

  const [form, setForm] = useState({
    clientId: '', routeId: '', valorVenta: 0, tasaInteres: 20,
    numeroCuotas: 30, frecuenciaPago: 'diaria' as const, fechaInicio: today(),
    paymentDays: [1, 2, 3, 4, 5, 6] as number[], // Lun-Sáb por defecto
  })

  // Capital disponible de la ruta seleccionada (no se permite vender por encima).
  const { available: capDisponible } = useRouteCapital(form.routeId)
  const capExcedido = capDisponible != null && form.valorVenta > capDisponible

  function togglePaymentDay(day: number) {
    setForm(f => ({
      ...f,
      paymentDays: f.paymentDays.includes(day)
        ? f.paymentDays.filter(d => d !== day)
        : [...f.paymentDays, day].sort((a, b) => a - b),
    }))
  }

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [allSales, allClients, allRoutes] = await Promise.all([
      db.sales.where('tenantId').equals(tenantId).toArray(),
      db.clients.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    setSales(allSales)
    setClients(allClients)
    setRoutes(allRoutes)
    setLoading(false)
  }

  const clientMap = new Map(clients.map(c => [c.id, c]))
  const routeMap = new Map(routes.map(r => [r.id, r]))

  const filtered = sales.filter(s => {
    const client = clientMap.get(s.clientId)
    const matchSearch = !search || client?.nombre.toLowerCase().includes(search.toLowerCase()) || client?.documento.includes(search)
    const matchRoute = !filterRoute || s.routeId === filterRoute
    return matchSearch && matchRoute
  })

  const calculated = (() => {
    if (form.valorVenta <= 0) return null
    const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: form.valorVenta, tasaInteres: form.tasaInteres })
    const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: form.numeroCuotas })
    const fechaFinal = estimateFinalDate({ fechaInicio: form.fechaInicio, numeroCuotas: form.numeroCuotas, frecuencia: form.frecuenciaPago, paymentDays: form.paymentDays })
    return { valorInteres, valorTotal, valorCuota, fechaFinal }
  })()

  async function handleCreateSale() {
    if (!form.clientId) { toast.error('Debes seleccionar un cliente'); return }
    if (!form.routeId) { toast.error('Debes seleccionar una ruta'); return }
    if (form.valorVenta <= 0) { toast.error('El valor del préstamo debe ser mayor a 0'); return }
    if (capDisponible != null && form.valorVenta > capDisponible) { toast.error(`La venta supera el capital disponible de la ruta (${formatCurrency(capDisponible, currency)})`); return }
    if (form.numeroCuotas <= 0) { toast.error('El número de cuotas debe ser mayor a 0'); return }
    if (![10, 20].includes(form.tasaInteres)) { toast.error('La tasa de interés debe ser 10% o 20%'); return }
    if (form.fechaInicio < today()) { toast.error('La fecha de inicio de cobro no puede ser anterior a hoy'); return }
    if (form.paymentDays.length === 0) { toast.error('Selecciona al menos un día de pago'); return }
    setSaving(true)
    try {
      const saleId = generateId()
      const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: form.valorVenta, tasaInteres: form.tasaInteres })
      const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: form.numeroCuotas })
      const fechaFinalEstimada = estimateFinalDate({ fechaInicio: form.fechaInicio, numeroCuotas: form.numeroCuotas, frecuencia: form.frecuenciaPago, paymentDays: form.paymentDays })
      const installments = generateInstallments({ saleId, valorTotal, numeroCuotas: form.numeroCuotas, valorCuota, frecuencia: form.frecuenciaPago, fechaInicio: form.fechaInicio, paymentDays: form.paymentDays })
      const route = routeMap.get(form.routeId)
      const sale: Sale = {
        id: saleId, tenantId, officeId: route?.officeId ?? officeId,
        routeId: form.routeId, clientId: form.clientId,
        createdByUserId: user?.id ?? '', valorVenta: form.valorVenta,
        tasaInteres: form.tasaInteres, valorInteres, valorTotal, saldo: valorTotal,
        numeroCuotas: form.numeroCuotas, valorCuota, frecuenciaPago: form.frecuenciaPago,
        paymentDays: form.paymentDays,
        fechaInicio: form.fechaInicio, fechaFinalEstimada, status: 'activa',
        createdAt: nowISO(), updatedAt: nowISO(),
      }
      await db.transaction('rw', [db.sales, db.installments], async () => {
        await db.sales.add(sale)
        await db.installments.bulkAdd(installments)
      })
      toast.success('Venta creada con cuotas generadas')
      setCreateOpen(false)
      setForm({ clientId: '', routeId: '', valorVenta: 0, tasaInteres: 20, numeroCuotas: 30, frecuenciaPago: 'diaria', fechaInicio: today(), paymentDays: [1, 2, 3, 4, 5, 6] })
      await load()
    } catch {
      toast.error('Error al crear la venta')
    } finally {
      setSaving(false)
    }
  }

  async function openDetail(sale: Sale) {
    setDetailSale(sale)
    const insts = await db.installments.where('saleId').equals(sale.id).toArray()
    setDetailInstallments(insts.sort((a, b) => a.numero - b.numero))
  }

  async function handleQuickPayment() {
    const v = paymentValor
    if (!v || v <= 0) { toast.error('Ingresa un valor válido'); return }
    if (!paymentSale || !user) return
    setPayingQuick(true)
    try {
      const insts = await db.installments.where('saleId').equals(paymentSale.id).toArray()
      const payment = {
        id: generateId(), tenantId, saleId: paymentSale.id,
        clientId: paymentSale.clientId, routeId: paymentSale.routeId,
        collectorId: user.id, valor: v, fecha: today(),
        tipo: 'efectivo' as const, observacion: '',
        syncStatus: 'synced' as const, createdAt: nowISO(),
      }
      await db.payments.add(payment)
      const { updatedInstallments } = applyPaymentToInstallments(insts, v)
      for (const inst of updatedInstallments) {
        await db.installments.update(inst.id, { pagado: inst.pagado, saldo: inst.saldo, status: inst.status })
      }
      const newSaldo = calculateSaleBalance(updatedInstallments)
      const newStatus = newSaldo <= 0 ? 'finalizada' : 'activa'
      await db.sales.update(paymentSale.id, { saldo: newSaldo, status: newStatus, updatedAt: nowISO() })
      toast.success('Pago registrado correctamente')
      setPaymentSale(null)
      setPaymentValor(0)
      setDetailSale(null)
      await load()
    } catch { toast.error('Error al registrar pago') } finally { setPayingQuick(false) }
  }

  async function markLost() {
    if (!lostSale || !motivoPerdida) { toast.error('Ingresa el motivo'); return }
    await db.sales.update(lostSale.id, { status: 'perdida', motivoPerdida, updatedAt: nowISO() })
    toast.success('Venta marcada como perdida')
    setLostOpen(false)
    setDetailSale(null)
    await load()
  }

  const freqOptions = [
    { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
    { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Ventas / Créditos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{filtered.length} registro(s)</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva venta</Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-48">
          <Input placeholder="Buscar cliente..." value={search} onChange={e => setSearch(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
        </div>
        <Select value={filterRoute} onChange={e => setFilterRoute(e.target.value)}
          options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Todas las rutas" className="w-44" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<CreditCard className="w-8 h-8" />} title="No hay ventas" action={<Button onClick={() => setCreateOpen(true)} icon={<Plus className="w-4 h-4" />}>Nueva venta</Button>} />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Cliente</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Venta</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Saldo</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Cuota</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Estado</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Ruta</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Fecha</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(s => {
                  const client = clientMap.get(s.clientId)
                  const route = routeMap.get(s.routeId)
                  return (
                    <tr key={s.id} onClick={() => openDetail(s)} className="hover:bg-primary-50/40 cursor-pointer transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{client?.nombre ?? 'N/A'}</p>
                        <p className="text-xs text-gray-400">{client?.documento ?? ''}</p>
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        <p className="text-sm font-medium text-gray-900">{formatCurrency(s.valorTotal)}</p>
                        <p className="text-xs text-gray-400">{s.tasaInteres}% interés</p>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-bold ${s.saldo > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{formatCurrency(s.saldo)}</span>
                      </td>
                      <td className="px-4 py-3 text-right hidden md:table-cell">
                        <p className="text-sm text-gray-700">{formatCurrency(s.valorCuota)}</p>
                        <p className="text-xs text-gray-400">{s.numeroCuotas} cuotas</p>
                      </td>
                      <td className="px-4 py-3 text-center"><SaleStatusBadge status={s.status} /></td>
                      <td className="px-4 py-3 hidden lg:table-cell"><span className="text-sm text-gray-600">{route?.nombre}</span></td>
                      <td className="px-4 py-3"><span className="text-sm text-gray-500">{formatDate(s.fechaInicio)}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Sale Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nueva venta / crédito" size="mdPlus"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button><Button onClick={handleCreateSale} loading={saving} disabled={capExcedido}>Crear venta</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Cliente" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
              options={clients.map(c => ({ value: c.id, label: `${c.nombre} - ${c.documento}` }))} placeholder="Seleccionar cliente" required />
            <Select label="Ruta" value={form.routeId} onChange={e => {
              const route = routeMap.get(e.target.value)
              // La tasa solo puede ser 10% o 20%: si la ruta trae otra, se usa 20% por defecto
              setForm(f => ({ ...f, routeId: e.target.value, tasaInteres: route?.tasaInteres === 10 ? 10 : 20 }))
            }} options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <MoneyInput label="Valor del préstamo" currency={currency} value={form.valorVenta} onValueChange={v => setForm(f => ({ ...f, valorVenta: v }))} required />
            <Select label="Tasa interés" value={String(form.tasaInteres)} onChange={e => setForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} options={TASA_OPTIONS} />
            <Input label="N° cuotas" type="number" min={1} value={form.numeroCuotas} onChange={e => setForm(f => ({ ...f, numeroCuotas: Number(e.target.value) }))} />
          </div>
          {form.routeId && capDisponible != null && (
            <div className={`rounded-xl p-3 text-sm border ${capExcedido ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-100 text-gray-600'}`}>
              Capital disponible de la ruta: <span className="font-bold">{formatCurrency(capDisponible, currency)}</span>
              {capExcedido && <p className="text-xs mt-1 font-medium">El valor supera el capital disponible. Reduce el monto o inyecta capital a la ruta.</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Select label="Frecuencia de pago" value={form.frecuenciaPago} onChange={e => setForm(f => ({ ...f, frecuenciaPago: e.target.value as any }))} options={freqOptions} />
            <Input label="Fecha inicio de cobro" type="date" min={today()} value={form.fechaInicio} onChange={e => setForm(f => ({ ...f, fechaInicio: e.target.value }))} hint="No puede ser anterior a hoy" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</label>
            <div className="flex flex-wrap gap-2">
              {WEEK_DAYS.map(d => {
                const active = form.paymentDays.includes(d.value)
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => togglePaymentDay(d.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-primary-600 text-white border-primary-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-gray-400">Selecciona los días en que se cobrará. Para frecuencia semanal puedes dejar un solo día.</p>
          </div>
          {calculated && (
            <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
              <div><p className="text-xs text-gray-500">Interés total</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorInteres, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorTotal, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Valor cuota</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorCuota, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Fecha estimada fin</p><p className="font-bold text-primary-700">{formatDate(calculated.fechaFinal)}</p></div>
            </div>
          )}
        </div>
      </Modal>

      {/* Detail Modal */}
      {detailSale && (
        <Modal open={!!detailSale} onClose={() => setDetailSale(null)} title="Detalle de venta" size="lg"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDetailSale(null)}>Cerrar</Button>
              {detailSale.status === 'activa' && (
                <Button onClick={() => { setPaymentSale(detailSale); setPaymentValor(detailSale.valorCuota) }} icon={<DollarSign className="w-4 h-4" />}>Registrar pago</Button>
              )}
              {detailSale.status === 'activa' && (
                <Button variant="danger" onClick={() => { setLostSale(detailSale); setLostOpen(true) }} icon={<XCircle className="w-4 h-4" />}>Marcar perdida</Button>
              )}
            </>
          }>
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Venta</p><p className="font-bold text-gray-900">{formatCurrency(detailSale.valorVenta)}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Total+interés</p><p className="font-bold text-gray-900">{formatCurrency(detailSale.valorTotal)}</p></div>
              <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-400">Saldo</p><p className="font-bold text-amber-600">{formatCurrency(detailSale.saldo)}</p></div>
              <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-400">Cuota</p><p className="font-bold text-gray-900">{formatCurrency(detailSale.valorCuota)}</p></div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <p className="text-gray-500">Frecuencia: <span className="font-medium text-gray-800 capitalize">{detailSale.frecuenciaPago}</span></p>
              <p className="text-gray-500">Días de pago: <span className="font-medium text-gray-800">{formatPaymentDays(detailSale.paymentDays)}</span></p>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Cuotas ({detailInstallments.length})</p>
              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {detailInstallments.map(inst => (
                  <div key={inst.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 border border-gray-100">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono text-gray-500 w-6">#{inst.numero}</span>
                      <span className="text-xs text-gray-500">{formatDate(inst.fechaVencimiento)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-gray-700">{formatCurrency(inst.valor)}</span>
                      <span className="text-xs text-emerald-600">Pag: {formatCurrency(inst.pagado)}</span>
                      <InstallmentStatusBadge status={inst.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Lost modal */}
      <Modal open={lostOpen} onClose={() => setLostOpen(false)} title="Marcar venta como perdida"
        footer={<><Button variant="secondary" onClick={() => setLostOpen(false)}>Cancelar</Button><Button variant="danger" onClick={markLost}>Confirmar</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Esta acción marcará la venta como perdida. Por favor explica el motivo:</p>
          <Textarea label="Motivo de pérdida" value={motivoPerdida} onChange={e => setMotivoPerdida(e.target.value)} rows={3} required />
        </div>
      </Modal>

      {/* Quick payment modal */}
      <Modal open={!!paymentSale} onClose={() => setPaymentSale(null)} title="Registrar pago"
        footer={<><Button variant="secondary" onClick={() => setPaymentSale(null)}>Cancelar</Button><Button onClick={handleQuickPayment} loading={payingQuick} icon={<DollarSign className="w-4 h-4" />}>Confirmar pago</Button></>}>
        {paymentSale && (
          <div className="space-y-4">
            <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
              <div><p className="text-xs text-gray-500">Cuota</p><p className="font-bold text-primary-700">{formatCurrency(paymentSale.valorCuota, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Saldo pendiente</p><p className="font-bold text-amber-600">{formatCurrency(paymentSale.saldo, currency)}</p></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => setPaymentValor(paymentSale.valorCuota)} className="py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium hover:bg-primary-100">Cuota completa<br />{formatCurrency(paymentSale.valorCuota, currency)}</button>
              <button onClick={() => setPaymentValor(Math.floor(paymentSale.valorCuota / 2))} className="py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-100">Mitad<br />{formatCurrency(Math.floor(paymentSale.valorCuota / 2), currency)}</button>
              <button onClick={() => setPaymentValor(paymentSale.saldo)} className="py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium hover:bg-emerald-100">Total saldo<br />{formatCurrency(paymentSale.saldo, currency)}</button>
            </div>
            <MoneyInput label="Valor del pago" currency={currency} value={paymentValor} onValueChange={setPaymentValor} required />
          </div>
        )}
      </Modal>
    </div>
  )
}
