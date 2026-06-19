import { useState, useEffect } from 'react'
import { Plus, CreditCard, Search, Eye, XCircle, CheckCircle, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { SaleStatusBadge, InstallmentStatusBadge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useTenant } from '@/hooks/useTenant'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatDate, today, nowISO } from '@/lib/formatters'
import {
  generateInstallments, calculateTotalWithInterest,
  estimateFinalDate, calculateInstallmentValue,
  applyPaymentToInstallments, calculateSaleBalance,
} from '@/services/installmentEngine'
import type { Sale, Client, Route, Installment } from '@/models/types'

export default function ActiveSalesPage() {
  const { tenantId, officeId } = useTenant()
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
  const [paymentValor, setPaymentValor] = useState('')
  const [payingQuick, setPayingQuick] = useState(false)

  const [form, setForm] = useState({
    clientId: '', routeId: '', valorVenta: 0, tasaInteres: 20,
    numeroCuotas: 30, frecuenciaPago: 'diaria' as const, fechaInicio: today(),
  })

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
    const fechaFinal = estimateFinalDate({ fechaInicio: form.fechaInicio, numeroCuotas: form.numeroCuotas, frecuencia: form.frecuenciaPago })
    return { valorInteres, valorTotal, valorCuota, fechaFinal }
  })()

  async function handleCreateSale() {
    if (!form.clientId || !form.routeId || form.valorVenta <= 0) {
      toast.error('Cliente, ruta y valor son obligatorios')
      return
    }
    setSaving(true)
    try {
      const saleId = generateId()
      const { valorInteres, valorTotal } = calculateTotalWithInterest({ valorVenta: form.valorVenta, tasaInteres: form.tasaInteres })
      const valorCuota = calculateInstallmentValue({ valorTotal, numeroCuotas: form.numeroCuotas })
      const fechaFinalEstimada = estimateFinalDate({ fechaInicio: form.fechaInicio, numeroCuotas: form.numeroCuotas, frecuencia: form.frecuenciaPago })
      const installments = generateInstallments({ saleId, valorTotal, numeroCuotas: form.numeroCuotas, valorCuota, frecuencia: form.frecuenciaPago, fechaInicio: form.fechaInicio })
      const route = routeMap.get(form.routeId)
      const sale: Sale = {
        id: saleId, tenantId, officeId: route?.officeId ?? officeId,
        routeId: form.routeId, clientId: form.clientId,
        createdByUserId: user?.id ?? '', valorVenta: form.valorVenta,
        tasaInteres: form.tasaInteres, valorInteres, valorTotal, saldo: valorTotal,
        numeroCuotas: form.numeroCuotas, valorCuota, frecuenciaPago: form.frecuenciaPago,
        fechaInicio: form.fechaInicio, fechaFinalEstimada, status: 'activa',
        createdAt: nowISO(), updatedAt: nowISO(),
      }
      await db.transaction('rw', [db.sales, db.installments], async () => {
        await db.sales.add(sale)
        await db.installments.bulkAdd(installments)
      })
      toast.success('Venta creada con cuotas generadas')
      setCreateOpen(false)
      setForm({ clientId: '', routeId: '', valorVenta: 0, tasaInteres: 20, numeroCuotas: 30, frecuenciaPago: 'diaria', fechaInicio: today() })
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
    const v = Number(paymentValor)
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
      setPaymentValor('')
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
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(s => {
                  const client = clientMap.get(s.clientId)
                  const route = routeMap.get(s.routeId)
                  return (
                    <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{client?.nombre ?? 'N/A'}</p>
                        <p className="text-xs text-gray-400">{formatDate(s.fechaInicio)}</p>
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
                      <td className="px-4 py-3">
                        <Button variant="ghost" size="sm" onClick={() => openDetail(s)} icon={<Eye className="w-3.5 h-3.5" />} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Sale Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Nueva venta / crédito" size="lg"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button><Button onClick={handleCreateSale} loading={saving}>Crear venta</Button></>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="Cliente" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
              options={clients.map(c => ({ value: c.id, label: `${c.nombre} - ${c.documento}` }))} placeholder="Seleccionar cliente" required />
            <Select label="Ruta" value={form.routeId} onChange={e => {
              const route = routeMap.get(e.target.value)
              setForm(f => ({ ...f, routeId: e.target.value, tasaInteres: route?.tasaInteres ?? f.tasaInteres }))
            }} options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Valor del préstamo" type="number" value={form.valorVenta || ''} onChange={e => setForm(f => ({ ...f, valorVenta: Number(e.target.value) }))} required />
            <Input label="Tasa interés (%)" type="number" value={form.tasaInteres} onChange={e => setForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} />
            <Input label="N° cuotas" type="number" value={form.numeroCuotas} onChange={e => setForm(f => ({ ...f, numeroCuotas: Number(e.target.value) }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Frecuencia de pago" value={form.frecuenciaPago} onChange={e => setForm(f => ({ ...f, frecuenciaPago: e.target.value as any }))} options={freqOptions} />
            <Input label="Fecha inicio" type="date" value={form.fechaInicio} onChange={e => setForm(f => ({ ...f, fechaInicio: e.target.value }))} />
          </div>
          {calculated && (
            <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
              <div><p className="text-xs text-gray-500">Interés total</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorInteres)}</p></div>
              <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorTotal)}</p></div>
              <div><p className="text-xs text-gray-500">Valor cuota</p><p className="font-bold text-primary-700">{formatCurrency(calculated.valorCuota)}</p></div>
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
                <Button onClick={() => { setPaymentSale(detailSale); setPaymentValor(String(detailSale.valorCuota)) }} icon={<DollarSign className="w-4 h-4" />}>Registrar pago</Button>
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
              <div><p className="text-xs text-gray-500">Cuota</p><p className="font-bold text-primary-700">{formatCurrency(paymentSale.valorCuota)}</p></div>
              <div><p className="text-xs text-gray-500">Saldo pendiente</p><p className="font-bold text-amber-600">{formatCurrency(paymentSale.saldo)}</p></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => setPaymentValor(String(paymentSale.valorCuota))} className="py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium hover:bg-primary-100">Cuota completa<br />{formatCurrency(paymentSale.valorCuota)}</button>
              <button onClick={() => setPaymentValor(String(Math.floor(paymentSale.valorCuota / 2)))} className="py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-100">Mitad<br />{formatCurrency(Math.floor(paymentSale.valorCuota / 2))}</button>
              <button onClick={() => setPaymentValor(String(paymentSale.saldo))} className="py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium hover:bg-emerald-100">Total saldo<br />{formatCurrency(paymentSale.saldo)}</button>
            </div>
            <Input label="Valor del pago" type="number" value={paymentValor} onChange={e => setPaymentValor(e.target.value)} required />
          </div>
        )}
      </Modal>
    </div>
  )
}
