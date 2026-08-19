import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { CheckCircle, MapPin, MessageSquare } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol } from '@/lib/formatters'
import { calculateCurrentInstallment } from '@/services/installmentEngine'
import { registerPayment, quickAmounts } from '@/services/paymentService'
import { buildWhatsAppMessage } from '@/lib/utils'
import type { Sale, Client, Installment } from '@/models/types'

export default function PaymentPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const navigate = useNavigate()
  const base = useOpBase()
  const { user } = useAuth()
  const { currency } = useTenant()
  const [sale, setSale] = useState<Sale | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [valor, setValor] = useState(0)
  const [observacion, setObservacion] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  // Número de parcela que se está pagando (lo informa el servicio) para que la
  // pantalla de confirmación muestre la MISMA parcela, no la siguiente.
  const [paidNumber, setPaidNumber] = useState<number | null>(null)
  // Importe realmente aplicado (puede ser menor al escrito si se topó al saldo).
  const [appliedAmount, setAppliedAmount] = useState(0)

  useEffect(() => { load() }, [saleId])

  /** Relee venta y parcelas de Dexie. El estado React es SOLO presentación. */
  async function refreshFromDb(): Promise<{ sale: Sale; insts: Installment[] } | null> {
    if (!saleId) return null
    const s = await db.sales.get(saleId)
    if (!s) return null
    const insts = await db.installments.where('saleId').equals(saleId).toArray()
    setSale(s)
    setInstallments(insts)
    return { sale: s, insts }
  }

  async function load() {
    const fresh = await refreshFromDb()
    if (!fresh) return
    const c = await db.clients.get(fresh.sale.clientId)
    setClient(c ?? null)
    setValor(quickAmounts(fresh.sale, fresh.insts).parcela)
  }

  // Registro de abono: TODA la lógica financiera vive en `paymentService`.
  // El estado React NO se pasa como fuente de verdad: el servicio relee la venta
  // y las parcelas desde Dexie dentro de su propia transacción.
  async function handlePay() {
    if (!sale) return
    setSaving(true)
    try {
      let lat: number | undefined, lng: number | undefined
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000 }))
        lat = pos.coords.latitude
        lng = pos.coords.longitude
      } catch {}

      const result = await registerPayment({
        saleId: sale.id,
        requestedAmount: valor,
        actor: user,
        observacion,
        lat,
        lng,
        syncStatus: navigator.onLine ? 'synced' : 'pending',
      })
      if (!result.ok) { toast.error(result.message); return }

      if (result.capped) {
        toast.warning(`Abono limitado al saldo pendiente: ${formatCurrency(result.appliedAmount, currency)}. La deuda queda en ${formatCurrency(0, currency)}.`)
      }
      setPaidNumber(result.paidInstallmentNumber)
      setAppliedAmount(result.appliedAmount)
      setSuccess(true)
      // Refresco desde la base (fuente única), nunca desde un cálculo local.
      await refreshFromDb()
    } finally { setSaving(false) }
  }

  function openWhatsApp() {
    if (!client?.telefonoPrincipal || !sale) return
    // Recibo: usa la parcela recién pagada (o la actual pendiente), en orden correcto.
    const cuotaActual = paidNumber ?? calculateCurrentInstallment(installments)?.numero ?? 0
    const msg = buildWhatsAppMessage({
      clientName: client.nombre,
      valor: appliedAmount || valor,
      saldo: sale.saldo,
      cuotaActual,
      totalCuotas: sale.numeroCuotas,
      currency,
    })
    const phone = client.telefonoPrincipal.replace(/\D/g, '')
    window.open(`https://wa.me/57${phone}?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale || !client) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>

  // Parcela actual a pagar: primera NO pagada en orden (misma lógica que la ruta
  // y el detalle del cliente). Corrige el número aleatorio anterior (find sin orden).
  const currentInst = calculateCurrentInstallment(installments)
  // En la confirmación se mantiene la parcela recién pagada; antes de guardar se
  // muestra la parcela actual a pagar.
  const parcelaNumero = success ? (paidNumber ?? currentInst?.numero) : currentInst?.numero
  // Montos rápidos: fuente única `quickAmounts` (saldo REAL de la parcela actual,
  // no el nominal `valorCuota`). Idéntico criterio que en el panel Admin.
  const qa = quickAmounts(sale, installments)

  return (
    <div className="p-4 space-y-4">
      {/* Client info */}
      <div className="bg-primary-50 rounded-2xl p-4">
        <p className="font-bold text-primary-900">{client.nombre}</p>
        <p className="text-sm text-primary-600">{client.negocio}</p>
        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="text-center"><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600">{formatCurrency(sale.saldo, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700">{formatCurrency(qa.parcela, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">N° parcela</p><p className="font-bold text-gray-700"><span className="text-primary-700">{parcelaNumero ?? '-'}</span>/{sale.numeroCuotas}</p></div>
        </div>
      </div>

      {sale.disbursementStatus === 'pendiente' ? (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-2">
          <p className="text-sm font-semibold text-amber-700">Venta pendiente de desembolso</p>
          <p className="text-xs text-amber-600">No puedes registrar abonos hasta confirmar el desembolso en la sección Desembolsos.</p>
          <button onClick={() => navigate(`${base}/disbursements`)} className="text-primary-600 text-sm font-medium">Ir a Desembolsos</button>
        </div>
      ) : success ? (
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-600" />
          </div>
          <p className="text-lg font-bold text-gray-900">¡Abono registrado!</p>
          {paidNumber != null && (
            <span className="inline-flex items-center gap-1.5 bg-primary-50 text-primary-700 border border-primary-200 rounded-full px-3 py-1 text-sm font-semibold">
              Parcela <span className="font-bold">{paidNumber}</span> de {sale.numeroCuotas} registrada
            </span>
          )}
          <p className="text-sm text-gray-500">Nuevo saldo: {formatCurrency(sale.saldo, currency)}</p>
          <button onClick={openWhatsApp} className="flex items-center gap-2 bg-green-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium">
            <MessageSquare className="w-4 h-4" /> Enviar recibo por WhatsApp
          </button>
          <button onClick={() => navigate(`${base}/route`)} className="text-primary-600 text-sm font-medium">Volver a la ruta</button>
        </div>
      ) : (
        <>
          {/* Parcela que se está pagando ahora (destacada) */}
          {parcelaNumero != null && (
            <div className="flex items-center justify-center">
              <span className="inline-flex items-center gap-1.5 bg-primary-50 text-primary-700 border border-primary-200 rounded-full px-3 py-1.5 text-sm font-semibold">
                Pagando parcela <span className="font-bold">{parcelaNumero}</span> de {sale.numeroCuotas}
              </span>
            </div>
          )}

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

            {/* Quick amounts — sobre el saldo REAL de la parcela actual */}
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => setValor(qa.parcela)} className="py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium">Completar parcela<br />{formatCurrency(qa.parcela, currency)}</button>
              <button type="button" onClick={() => setValor(qa.mitad)} className="py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium">Mitad<br />{formatCurrency(qa.mitad, currency)}</button>
              <button type="button" onClick={() => setValor(qa.total)} className="py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium">Total<br />{formatCurrency(qa.total, currency)}</button>
            </div>
            {valor > qa.total && (
              <p className="text-xs text-amber-600">Supera el saldo: se registrará {formatCurrency(qa.total, currency)} y la deuda quedará en {formatCurrency(0, currency)}.</p>
            )}
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
