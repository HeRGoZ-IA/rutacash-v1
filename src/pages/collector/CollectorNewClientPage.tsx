import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, AlertTriangle, Save } from 'lucide-react'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { PhotoInput } from '@/components/ui/PhotoInput'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { getAuthorizedRouteIds } from '@/lib/roles'
import { generateId } from '@/lib/utils'
import { nowISO, normalizeDoc, formatCurrency, formatDate, today } from '@/lib/formatters'
import { computeSaleFinancials, buildSaleWithInstallments, buildSaleRequest, type SaleInputs } from '@/services/saleRequestService'
import { useRouteCapital } from '@/hooks/useRouteCapital'
import type { Client, Route, Sale } from '@/models/types'

const TASA_OPTIONS = [{ value: '10', label: '10%' }, { value: '20', label: '20%' }]
const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

export default function CollectorNewClientPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [routes, setRoutes] = useState<Route[]>([])
  const [dup, setDup] = useState<Client | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    documento: '', nombre: '', direccionPrincipal: '', direccionSecundaria: '',
    telefonoPrincipal: '', telefonoSecundario: '', negocio: '', notas: '',
    routeId: '', fotoDocumentoUrl: undefined as string | undefined, fotoNegocioUrl: undefined as string | undefined,
  })
  // Crear venta en el mismo flujo
  const [addSale, setAddSale] = useState(false)
  const [saleForm, setSaleForm] = useState({
    valorVenta: 0, tasaInteres: 20, numeroCuotas: 30,
    frecuenciaPago: 'diaria' as Sale['frecuenciaPago'], fechaInicio: today(),
    paymentDays: [1, 2, 3, 4, 5, 6] as number[],
  })

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) return
    const authorizedIds = getAuthorizedRouteIds(user)
    const all = await db.routes.where('tenantId').equals(user.tenantId).toArray()
    const mine = all.filter(r => authorizedIds.includes(r.id))
    setRoutes(mine)
    const defaultRoute = (activeRouteId && mine.some(r => r.id === activeRouteId)) ? activeRouteId : (mine[0]?.id ?? '')
    setForm(f => ({ ...f, routeId: defaultRoute }))
  }

  function toggleSaleDay(day: number) {
    setSaleForm(f => ({
      ...f,
      paymentDays: f.paymentDays.includes(day) ? f.paymentDays.filter(d => d !== day) : [...f.paymentDays, day].sort((a, b) => a - b),
    }))
  }

  // Reglas de venta directa del cobrador
  const canDirect = !!user?.canCreateDirectSales
  const maxAmount = user?.maxDirectSaleAmount && user.maxDirectSaleAmount > 0 ? user.maxDirectSaleAmount : null
  const withinLimit = !maxAmount || saleForm.valorVenta <= maxAmount
  const allowDirect = canDirect && withinLimit

  // Capital disponible de la ruta seleccionada (bloquea venta directa si se supera).
  const { available: capDisponible } = useRouteCapital(addSale ? form.routeId : null)
  const capExcedido = addSale && capDisponible != null && saleForm.valorVenta > capDisponible

  const saleCalc = addSale && saleForm.valorVenta > 0 && saleForm.numeroCuotas > 0
    ? computeSaleFinancials({ valorVenta: saleForm.valorVenta, tasaInteres: saleForm.tasaInteres, numeroCuotas: saleForm.numeroCuotas, frecuenciaPago: saleForm.frecuenciaPago, fechaInicio: saleForm.fechaInicio, paymentDays: saleForm.paymentDays })
    : null

  // Validación global de documento duplicado (mismo tenant, sin importar ruta/oficina).
  async function checkDuplicate(doc: string) {
    const norm = normalizeDoc(doc)
    if (!norm || !user) { setDup(null); return }
    const all = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    setDup(all.find(c => normalizeDoc(c.documento) === norm) ?? null)
  }

  async function handleSave() {
    if (!user) return
    if (!form.documento.trim()) { toast.error('El documento es obligatorio'); return }
    if (!form.nombre.trim()) { toast.error('El nombre es obligatorio'); return }
    if (!form.direccionPrincipal.trim()) { toast.error('La dirección de residencia es obligatoria'); return }
    if (!form.direccionSecundaria.trim()) { toast.error('La dirección de cobro / negocio es obligatoria'); return }
    if (!form.telefonoPrincipal.trim()) { toast.error('El teléfono es obligatorio'); return }
    if (!form.routeId) { toast.error('Selecciona una ruta'); return }

    if (addSale) {
      if (saleForm.valorVenta <= 0) { toast.error('El valor de la venta debe ser mayor a 0'); return }
      if (saleForm.numeroCuotas <= 0) { toast.error('El número de parcelas debe ser mayor a 0'); return }
      if (![10, 20].includes(saleForm.tasaInteres)) { toast.error('La tasa debe ser 10% o 20%'); return }
      if (saleForm.fechaInicio < today()) { toast.error('La fecha de inicio no puede ser anterior a hoy'); return }
      if (saleForm.paymentDays.length === 0) { toast.error('Selecciona al menos un día de pago'); return }
      // Venta directa no puede superar el capital disponible (la solicitud sí puede enviarse).
      if (allowDirect && capDisponible != null && saleForm.valorVenta > capDisponible) {
        toast.error(`La venta supera el capital disponible de la ruta (${formatCurrency(capDisponible, currency)})`); return
      }
    }

    // Re-chequeo autoritativo de duplicado
    const norm = normalizeDoc(form.documento)
    const all = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const existing = all.find(c => normalizeDoc(c.documento) === norm)
    if (existing) { setDup(existing); toast.error('Este documento ya está registrado como cliente.'); return }

    setSaving(true)
    try {
      const route = routes.find(r => r.id === form.routeId)
      const client: Client = {
        id: generateId(), tenantId: user.tenantId, officeId: route?.officeId ?? user.officeId ?? '',
        routeId: form.routeId, nombre: form.nombre.trim(), documento: form.documento.trim(),
        telefonoPrincipal: form.telefonoPrincipal.trim(), telefonoSecundario: form.telefonoSecundario.trim() || undefined,
        direccionPrincipal: form.direccionPrincipal.trim(), direccionSecundaria: form.direccionSecundaria.trim(),
        negocio: form.negocio.trim() || undefined, notas: form.notas.trim() || undefined,
        fotoDocumentoUrl: form.fotoDocumentoUrl, fotoNegocioUrl: form.fotoNegocioUrl,
        status: 'activo', createdAt: nowISO(), updatedAt: nowISO(),
      }

      if (!addSale) {
        await db.clients.add(client)
        toast.success('Cliente registrado')
        if (params.get('returnTo') === 'new-sale') navigate(`/collector/new-sale?clientId=${client.id}`)
        else navigate('/collector/home')
        return
      }

      // Cliente + venta/solicitud asociada a la ruta activa y al cobrador actual
      const input: SaleInputs = {
        tenantId: user.tenantId, officeId: client.officeId, routeId: client.routeId,
        clientId: client.id, createdByUserId: user.id,
        valorVenta: saleForm.valorVenta, tasaInteres: saleForm.tasaInteres, numeroCuotas: saleForm.numeroCuotas,
        frecuenciaPago: saleForm.frecuenciaPago, fechaInicio: saleForm.fechaInicio, paymentDays: saleForm.paymentDays,
      }

      if (allowDirect) {
        // Cliente + venta directa (desembolsada) + parcelas, atómico
        const { sale, installments } = buildSaleWithInstallments(input, 'desembolsado')
        await db.transaction('rw', [db.clients, db.sales, db.installments], async () => {
          await db.clients.add(client)
          await db.sales.add(sale)
          await db.installments.bulkAdd(installments)
        })
        toast.success('Cliente y venta creados')
      } else {
        // Cliente + solicitud de venta (pendiente de autorización), atómico
        const request = buildSaleRequest(input)
        await db.transaction('rw', [db.clients, db.saleRequests], async () => {
          await db.clients.add(client)
          await db.saleRequests.add(request)
        })
        toast.success('Cliente creado y solicitud de venta enviada al administrador')
      }
      navigate('/collector/home')
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  const dupRouteName = dup ? (routes.find(r => r.id === dup.routeId)?.nombre ?? 'otra ruta') : ''
  const saveLabel = addSale ? (allowDirect ? 'Guardar cliente y crear venta' : 'Guardar cliente y enviar solicitud') : 'Guardar cliente'

  return (
    <div className="pb-6">
      <div className="bg-primary-700 px-4 py-4">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-primary-200 text-sm mb-2">
          <ChevronLeft className="w-4 h-4" /> Volver
        </button>
        <h1 className="text-white font-bold text-lg">Nuevo cliente</h1>
      </div>

      <div className="p-4 space-y-4">
        {/* Documento primero, con validación de duplicado */}
        <Input
          label="Número de documento"
          value={form.documento}
          onChange={e => { setForm(f => ({ ...f, documento: e.target.value })); if (dup) setDup(null) }}
          onBlur={e => checkDuplicate(e.target.value)}
          error={dup ? 'Este documento ya está registrado como cliente.' : undefined}
          required autoFocus
        />
        {dup && (
          <div className="flex items-start gap-2 p-3 bg-red-50 rounded-xl border border-red-100">
            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-700">
              Ya existe: <span className="font-semibold">{dup.nombre}</span> · Ruta: {dupRouteName}
            </p>
          </div>
        )}

        <Input label="Nombre completo" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
        <Input label="Dirección de residencia" value={form.direccionPrincipal} onChange={e => setForm(f => ({ ...f, direccionPrincipal: e.target.value }))} required placeholder="Ej: Cll 45 #23-12" />
        <Input label="Dirección de cobro / negocio" value={form.direccionSecundaria} onChange={e => setForm(f => ({ ...f, direccionSecundaria: e.target.value }))} required placeholder="Ej: Cra 8 #12-30, Local 2" />
        <Input label="Negocio" value={form.negocio} onChange={e => setForm(f => ({ ...f, negocio: e.target.value }))} placeholder="Nombre del negocio (opcional)" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Teléfono" value={form.telefonoPrincipal} onChange={e => setForm(f => ({ ...f, telefonoPrincipal: e.target.value }))} required />
          <Input label="Teléfono adicional" value={form.telefonoSecundario} onChange={e => setForm(f => ({ ...f, telefonoSecundario: e.target.value }))} />
        </div>
        <Select label="Ruta" value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
          options={routes.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" required />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PhotoInput label="Foto del documento" value={form.fotoDocumentoUrl} onChange={url => setForm(f => ({ ...f, fotoDocumentoUrl: url }))} />
          <PhotoInput label="Foto del negocio / lugar de cobro" value={form.fotoNegocioUrl} onChange={url => setForm(f => ({ ...f, fotoNegocioUrl: url }))} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Observación</label>
          <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} rows={2}
            className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder="Opcional" />
        </div>

        {/* Crear venta ahora */}
        <div className="rounded-xl border border-gray-200 p-3">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={addSale} onChange={e => setAddSale(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
            <span className="text-sm font-medium text-gray-800">Crear venta ahora</span>
            <span className="text-xs text-gray-400">Registra la venta junto al cliente</span>
          </label>

          {addSale && (
            <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
              <MoneyInput label="Valor de la venta" currency={currency} value={saleForm.valorVenta} onValueChange={v => setSaleForm(f => ({ ...f, valorVenta: v }))} required />
              <div className="grid grid-cols-2 gap-3">
                <Select label="Tasa interés" value={String(saleForm.tasaInteres)} onChange={e => setSaleForm(f => ({ ...f, tasaInteres: Number(e.target.value) }))} options={TASA_OPTIONS} />
                <Select label="Forma de pago" value={saleForm.frecuenciaPago} onChange={e => setSaleForm(f => ({ ...f, frecuenciaPago: e.target.value as Sale['frecuenciaPago'] }))} options={FREQ_OPTIONS} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="N° de parcelas" type="number" min={1} value={saleForm.numeroCuotas} onChange={e => setSaleForm(f => ({ ...f, numeroCuotas: Number(e.target.value) }))} />
                <Input label="Fecha de inicio" type="date" min={today()} value={saleForm.fechaInicio} onChange={e => setSaleForm(f => ({ ...f, fechaInicio: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</label>
                <div className="flex flex-wrap gap-2">
                  {WEEK_DAYS.map(d => {
                    const active = saleForm.paymentDays.includes(d.value)
                    return (
                      <button key={d.value} type="button" onClick={() => toggleSaleDay(d.value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                        {d.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {capDisponible != null && (
                <div className={`rounded-xl p-3 text-sm border ${capExcedido ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-100 text-gray-600'}`}>
                  Capital disponible de la ruta: <span className="font-bold">{formatCurrency(capDisponible, currency)}</span>
                  {capExcedido && <p className="text-xs mt-1 font-medium">Supera el capital disponible. {allowDirect ? 'Reduce el monto o inyecta capital.' : 'Se enviará como solicitud al administrador.'}</p>}
                </div>
              )}
              {saleCalc && (
                <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-2 gap-3">
                  <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorTotal, currency)}</p></div>
                  <div><p className="text-xs text-gray-500">Valor parcela</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorCuota, currency)}</p></div>
                  <div><p className="text-xs text-gray-500">Interés</p><p className="font-bold text-primary-700">{formatCurrency(saleCalc.valorInteres, currency)}</p></div>
                  <div><p className="text-xs text-gray-500">Fecha estimada fin</p><p className="font-bold text-primary-700">{formatDate(saleCalc.fechaFinalEstimada)}</p></div>
                </div>
              )}
              {!allowDirect && (
                <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-xl border border-amber-100">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-amber-700">
                    {canDirect && !withinLimit
                      ? `El valor supera tu límite de venta directa (${formatCurrency(maxAmount ?? 0, currency)}). Se enviará una solicitud al administrador.`
                      : 'Esta venta requiere autorización del administrador. Se enviará una solicitud.'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !!dup || (allowDirect && capExcedido)}
          className="w-full h-12 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2"
        >
          {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-5 h-5" />}
          {saving ? 'Guardando...' : saveLabel}
        </button>
      </div>
    </div>
  )
}
