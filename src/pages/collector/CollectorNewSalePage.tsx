import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, UserPlus, FileText, Send, AlertTriangle } from 'lucide-react'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { computeSaleFinancials, createDirectSale, createSaleRequest, type SaleInputs } from '@/services/saleRequestService'
import { useRouteCapital } from '@/hooks/useRouteCapital'
import type { Client, Sale } from '@/models/types'

const TASA_OPTIONS = [{ value: '10', label: '10%' }, { value: '20', label: '20%' }]
const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

export default function CollectorNewSalePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [clients, setClients] = useState<Client[]>([])
  const [routeIds, setRouteIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    clientId: params.get('clientId') ?? '',
    valorVenta: 0, tasaInteres: 20, numeroCuotas: 30,
    frecuenciaPago: 'diaria' as Sale['frecuenciaPago'], fechaInicio: today(),
    paymentDays: [1, 2, 3, 4, 5, 6] as number[],
  })

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) return
    const ids = getAuthorizedRouteIds(user)
    setRouteIds(ids)
    const all = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    // Solo clientes de las rutas del cobrador
    setClients(all.filter(c => ids.includes(c.routeId)))
  }

  function togglePaymentDay(day: number) {
    setForm(f => ({
      ...f,
      paymentDays: f.paymentDays.includes(day) ? f.paymentDays.filter(d => d !== day) : [...f.paymentDays, day].sort((a, b) => a - b),
    }))
  }

  // Reglas de venta directa del cobrador
  const canDirect = !!user?.canCreateDirectSales
  const maxAmount = user?.maxDirectSaleAmount && user.maxDirectSaleAmount > 0 ? user.maxDirectSaleAmount : null
  const withinLimit = !maxAmount || form.valorVenta <= maxAmount
  const allowDirect = canDirect && withinLimit

  // Capital disponible de la ruta del cliente seleccionado.
  const selectedClient = clients.find(c => c.id === form.clientId)
  const { available: capDisponible } = useRouteCapital(selectedClient?.routeId)
  const capExcedido = capDisponible != null && form.valorVenta > capDisponible

  const calc = form.valorVenta > 0 && form.numeroCuotas > 0
    ? computeSaleFinancials({ valorVenta: form.valorVenta, tasaInteres: form.tasaInteres, numeroCuotas: form.numeroCuotas, frecuenciaPago: form.frecuenciaPago, fechaInicio: form.fechaInicio, paymentDays: form.paymentDays })
    : null

  function validate(): boolean {
    if (!form.clientId) { toast.error('Selecciona un cliente'); return false }
    if (form.valorVenta <= 0) { toast.error('El valor debe ser mayor a 0'); return false }
    if (form.numeroCuotas <= 0) { toast.error('El número de parcelas debe ser mayor a 0'); return false }
    if (![10, 20].includes(form.tasaInteres)) { toast.error('La tasa debe ser 10% o 20%'); return false }
    if (form.fechaInicio < today()) { toast.error('La fecha de inicio no puede ser anterior a hoy'); return false }
    if (form.paymentDays.length === 0) { toast.error('Selecciona al menos un día de pago'); return false }
    return true
  }

  function buildInputs(): SaleInputs | null {
    const client = clients.find(c => c.id === form.clientId)
    if (!client || !user) return null
    return {
      tenantId: user.tenantId, officeId: client.officeId, routeId: client.routeId,
      clientId: client.id, createdByUserId: user.id,
      valorVenta: form.valorVenta, tasaInteres: form.tasaInteres, numeroCuotas: form.numeroCuotas,
      frecuenciaPago: form.frecuenciaPago, fechaInicio: form.fechaInicio, paymentDays: form.paymentDays,
    }
  }

  async function handleDirectSale() {
    if (!validate()) return
    if (capDisponible != null && form.valorVenta > capDisponible) { toast.error(`La venta supera el capital disponible de la ruta (${formatCurrency(capDisponible, currency)})`); return }
    const inputs = buildInputs(); if (!inputs) return
    setSaving(true)
    try {
      await createDirectSale(inputs)
      toast.success('Venta creada y activa para recaudo')
      navigate('/collector/route')
    } catch { toast.error('Error al crear la venta') } finally { setSaving(false) }
  }

  async function handleRequest() {
    if (!validate()) return
    const inputs = buildInputs(); if (!inputs) return
    setSaving(true)
    try {
      await createSaleRequest(inputs)
      toast.success('Solicitud de venta enviada al administrador')
      navigate('/collector/home')
    } catch { toast.error('Error al enviar la solicitud') } finally { setSaving(false) }
  }

  return (
    <div className="pb-6">
      <div className="bg-primary-700 px-4 py-4">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-primary-200 text-sm mb-2">
          <ChevronLeft className="w-4 h-4" /> Volver
        </button>
        <h1 className="text-white font-bold text-lg">Nueva venta</h1>
      </div>

      <div className="p-4 space-y-4">
        {/* Cliente */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm font-medium text-gray-700">Cliente</label>
            <button onClick={() => navigate('/collector/clients/new?returnTo=new-sale')} className="text-xs font-semibold text-primary-600 flex items-center gap-1">
              <UserPlus className="w-3.5 h-3.5" /> Nuevo cliente
            </button>
          </div>
          <Select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
            options={clients.map(c => ({ value: c.id, label: `${c.nombre} - ${c.documento}` }))} placeholder="Seleccionar cliente" required />
          {routeIds.length === 0 && <p className="mt-1 text-xs text-amber-600">No tienes rutas asignadas.</p>}
        </div>

        <MoneyInput label="Valor de la venta" currency={currency} value={form.valorVenta} onValueChange={v => setForm(f => ({ ...f, valorVenta: v }))} required />

        <div className="grid grid-cols-2 gap-3">
          <Select label="Tasa interés" value={String(form.tasaInteres)} onChange={e => setForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} options={TASA_OPTIONS} />
          <Select label="Forma de pago" value={form.frecuenciaPago} onChange={e => setForm(f => ({ ...f, frecuenciaPago: e.target.value as Sale['frecuenciaPago'] }))} options={FREQ_OPTIONS} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="N° de parcelas" type="number" min={1} value={form.numeroCuotas} onChange={e => setForm(f => ({ ...f, numeroCuotas: Number(e.target.value) }))} />
          <Input label="Fecha de inicio" type="date" min={today()} value={form.fechaInicio} onChange={e => setForm(f => ({ ...f, fechaInicio: e.target.value }))} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</label>
          <div className="flex flex-wrap gap-2">
            {WEEK_DAYS.map(d => {
              const active = form.paymentDays.includes(d.value)
              return (
                <button key={d.value} type="button" onClick={() => togglePaymentDay(d.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Preview */}
        {calc && (
          <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
            <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-primary-700">{formatCurrency(calc.valorTotal, currency)}</p></div>
            <div><p className="text-xs text-gray-500">Valor parcela</p><p className="font-bold text-primary-700">{formatCurrency(calc.valorCuota, currency)}</p></div>
            <div><p className="text-xs text-gray-500">Interés</p><p className="font-bold text-primary-700">{formatCurrency(calc.valorInteres, currency)}</p></div>
            <div><p className="text-xs text-gray-500">Fecha estimada fin</p><p className="font-bold text-primary-700">{formatDate(calc.fechaFinalEstimada)}</p></div>
          </div>
        )}

        {/* Capital disponible de la ruta */}
        {selectedClient && capDisponible != null && (
          <div className={`rounded-xl p-3 text-sm border ${capExcedido ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-100 text-gray-600'}`}>
            Capital disponible de la ruta: <span className="font-bold">{formatCurrency(capDisponible, currency)}</span>
            {capExcedido && <p className="text-xs mt-1 font-medium">El valor supera el capital disponible. Reduce el monto o inyecta capital a la ruta.</p>}
          </div>
        )}

        {/* Acción según autorización */}
        {allowDirect ? (
          <button onClick={handleDirectSale} disabled={saving || capExcedido}
            className="w-full h-12 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2">
            {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FileText className="w-5 h-5" />}
            Crear venta
          </button>
        ) : (
          <>
            <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-700">
                {canDirect && !withinLimit
                  ? `El valor supera tu límite de venta directa (${formatCurrency(maxAmount ?? 0, currency)}). Esta venta requiere autorización del administrador.`
                  : 'Esta venta requiere autorización del administrador.'}
              </p>
            </div>
            <button onClick={handleRequest} disabled={saving}
              className="w-full h-12 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2">
              {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="w-5 h-5" />}
              Enviar solicitud de venta
            </button>
          </>
        )}
      </div>
    </div>
  )
}
