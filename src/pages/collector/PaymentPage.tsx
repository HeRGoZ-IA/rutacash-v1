import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CheckCircle, MapPin, MessageSquare } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { generateId } from '@/lib/utils'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol, today, nowISO } from '@/lib/formatters'
import { applyPaymentToInstallments, calculateSaleBalance } from '@/services/installmentEngine'
import { buildWhatsAppMessage } from '@/lib/utils'
import type { Sale, Client, Installment } from '@/models/types'

export default function PaymentPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { currency } = useTenant()
  const [sale, setSale] = useState<Sale | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [valor, setValor] = useState(0)
  const [observacion, setObservacion] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => { load() }, [saleId])

  async function load() {
    if (!saleId) return
    const s = await db.sales.get(saleId)
    if (!s) return
    const c = await db.clients.get(s.clientId)
    const insts = await db.installments.where('saleId').equals(saleId).toArray()
    setSale(s)
    setClient(c ?? null)
    setInstallments(insts)
    setValor(s.valorCuota)
  }

  async function handlePay() {
    const v = valor
    if (!v || v <= 0) { toast.error('Ingresa un valor válido'); return }
    if (!sale || !user) return
    if (sale.disbursementStatus === 'pendiente') { toast.error('Esta venta aún no está desembolsada'); return }
    setSaving(true)

    try {
      let lat: number | undefined, lng: number | undefined
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000 }))
        lat = pos.coords.latitude
        lng = pos.coords.longitude
      } catch {}

      const payment = {
        id: generateId(), tenantId: user.tenantId, saleId: sale.id, clientId: sale.clientId,
        routeId: sale.routeId, collectorId: user.id, valor: v, fecha: today(),
        tipo: 'efectivo' as const, observacion, lat, lng,
        syncStatus: navigator.onLine ? 'synced' as const : 'pending' as const,
        createdAt: nowISO(),
      }
      await db.payments.add(payment)

      // Update installments
      const { updatedInstallments } = applyPaymentToInstallments(installments, v)
      for (const inst of updatedInstallments) {
        await db.installments.update(inst.id, { pagado: inst.pagado, saldo: inst.saldo, status: inst.status })
      }

      // Update sale balance
      const newSaldo = calculateSaleBalance(updatedInstallments)
      const newStatus = newSaldo <= 0 ? 'finalizada' : 'activa'
      await db.sales.update(sale.id, { saldo: newSaldo, status: newStatus, updatedAt: nowISO() })

      setSuccess(true)
      setSale(prev => prev ? { ...prev, saldo: newSaldo, status: newStatus } : null)
      setInstallments(updatedInstallments)
    } catch { toast.error('Error al registrar pago') } finally { setSaving(false) }
  }

  function openWhatsApp() {
    if (!client?.telefonoPrincipal || !sale) return
    const insts = installments.filter(i => i.status !== 'pagada')
    const current = insts[0]
    const msg = buildWhatsAppMessage({
      clientName: client.nombre,
      valor,
      saldo: sale.saldo,
      cuotaActual: current?.numero ?? 0,
      totalCuotas: sale.numeroCuotas,
      currency,
    })
    const phone = client.telefonoPrincipal.replace(/\D/g, '')
    window.open(`https://wa.me/57${phone}?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale || !client) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>

  const currentInst = installments.find(i => i.status !== 'pagada')

  return (
    <div className="p-4 space-y-4">
      {/* Client info */}
      <div className="bg-primary-50 rounded-2xl p-4">
        <p className="font-bold text-primary-900">{client.nombre}</p>
        <p className="text-sm text-primary-600">{client.negocio}</p>
        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="text-center"><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600">{formatCurrency(sale.saldo, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700">{formatCurrency(sale.valorCuota, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">N° parcela</p><p className="font-bold text-gray-700">{currentInst?.numero ?? '-'}/{sale.numeroCuotas}</p></div>
        </div>
      </div>

      {sale.disbursementStatus === 'pendiente' ? (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-2">
          <p className="text-sm font-semibold text-amber-700">Venta pendiente de desembolso</p>
          <p className="text-xs text-amber-600">No puedes registrar abonos hasta confirmar el desembolso en la sección Desembolsos.</p>
          <button onClick={() => navigate('/collector/disbursements')} className="text-primary-600 text-sm font-medium">Ir a Desembolsos</button>
        </div>
      ) : success ? (
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-600" />
          </div>
          <p className="text-lg font-bold text-gray-900">¡Abono registrado!</p>
          <p className="text-sm text-gray-500">Nuevo saldo: {formatCurrency(sale.saldo, currency)}</p>
          <button onClick={openWhatsApp} className="flex items-center gap-2 bg-green-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium">
            <MessageSquare className="w-4 h-4" /> Enviar recibo por WhatsApp
          </button>
          <button onClick={() => navigate('/collector/route')} className="text-primary-600 text-sm font-medium">Volver a la ruta</button>
        </div>
      ) : (
        <>
          {/* Amount input */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
            <label className="block text-sm font-semibold text-gray-700">Valor del abono</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-gray-400">{getCurrencySymbol(currency)}</span>
              <input
                type="text"
                inputMode="numeric"
                value={formatCurrencyInput(valor, currency)}
                onChange={e => setValor(parseCurrencyInput(e.target.value))}
                placeholder="0"
                className="w-full h-14 text-2xl font-bold text-center rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:outline-none"
              />
            </div>

            {/* Quick amounts */}
            <div className="grid grid-cols-3 gap-2">
              <button onClick={() => setValor(sale.valorCuota)} className="py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium">Parcela completa<br />{formatCurrency(sale.valorCuota, currency)}</button>
              <button onClick={() => setValor(Math.floor(sale.valorCuota / 2))} className="py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium">Mitad<br />{formatCurrency(Math.floor(sale.valorCuota / 2), currency)}</button>
              <button onClick={() => setValor(sale.saldo)} className="py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium">Total<br />{formatCurrency(sale.saldo, currency)}</button>
            </div>
          </div>

          {/* Observation */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Observación (opcional)</label>
            <textarea value={observacion} onChange={e => setObservacion(e.target.value)} rows={2}
              className="w-full rounded-xl border border-gray-200 p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>

          {/* Location note */}
          {navigator.geolocation && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <MapPin className="w-3.5 h-3.5" />
              Se registrará tu ubicación al guardar
            </div>
          )}

          <button
            onClick={handlePay}
            disabled={saving || !valor || valor <= 0}
            className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2"
          >
            {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckCircle className="w-5 h-5" />}
            {saving ? 'Guardando...' : 'Registrar abono'}
          </button>

          <button onClick={() => navigate(-1)} className="w-full text-gray-400 text-sm py-2">Cancelar</button>
        </>
      )}
    </div>
  )
}
