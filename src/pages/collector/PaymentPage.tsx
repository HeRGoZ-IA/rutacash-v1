import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { AlertTriangle, CheckCircle, MapPin, MessageSquare } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { db } from '@/lib/db'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol } from '@/lib/formatters'
import { calculateCurrentInstallment } from '@/services/installmentEngine'
import { registerPayment, quickAmounts } from '@/services/paymentService'
import { CollectorPicker } from '@/components/ui/CollectorPicker'
import { buildWhatsAppMessage } from '@/lib/utils'
import { resolveWhatsAppRecipient, whatsAppLink } from '@/lib/whatsapp'
import {
  captureLocation, geolocationSupport, GEO_STATUS_LABEL, type GeoCapture, type GeoRecordStatus,
} from '@/lib/geolocation'
import type { Sale, Client, Installment } from '@/models/types'

export default function PaymentPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const navigate = useNavigate()
  const base = useOpBase()
  const { user } = useAuth()
  const { tenant, currency } = useTenant()
  const [sale, setSale] = useState<Sale | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [installments, setInstallments] = useState<Installment[]>([])
  const [valor, setValor] = useState(0)
  const [observacion, setObservacion] = useState('')
  /** Cobrador RESPONSABLE del recaudo. El propio cobrador no lo elige: es él. */
  const [collectorId, setCollectorId] = useState('')
  const [saving, setSaving] = useState(false)
  // Ronda 48: fase visible del registro (la ubicación nunca bloquea el abono).
  const [phase, setPhase] = useState<'idle' | 'locating' | 'saving'>('idle')
  // Ronda 48 (H-05): un abono que LIQUIDA toda la deuda pide una confirmación extra.
  const [confirmLiquidar, setConfirmLiquidar] = useState(false)
  const busyRef = useRef(false)
  const [success, setSuccess] = useState(false)
  // Número de parcela que se está pagando (lo informa el servicio) para que la
  // pantalla de confirmación muestre la MISMA parcela, no la siguiente.
  const [paidNumber, setPaidNumber] = useState<number | null>(null)
  // Importe realmente aplicado (puede ser menor al escrito si se topó al saldo).
  const [appliedAmount, setAppliedAmount] = useState(0)
  // Estado de ubicación del abono registrado (el del servidor cuando lo hay).
  const [geoResult, setGeoResult] = useState<{ status: GeoRecordStatus; accuracyM?: number } | null>(null)
  const geoSupport = geolocationSupport()

  useEffect(() => { load() }, [saleId])
  // Un pago anulado en otra pestaña cambia saldo y parcela: se relee la venta sin
  // tocar el importe que se está digitando (el servicio revalida igualmente).
  const revision = useDataRevision()
  useEffect(() => { if (revision > 0) refreshFromDb() }, [revision])  // eslint-disable-line react-hooks/exhaustive-deps

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

  /** Paso previo: si el abono liquida toda la deuda, primero se confirma. */
  function requestPay() {
    if (!sale || busyRef.current || !valor || valor <= 0) return
    if (valor >= quickAmounts(sale, installments).total) { setConfirmLiquidar(true); return }
    void handlePay()
  }

  // Registro de abono: TODA la lógica financiera vive en `paymentService`.
  // El estado React NO se pasa como fuente de verdad: el servicio relee la venta
  // y las parcelas desde Dexie dentro de su propia transacción.
  async function handlePay() {
    if (!sale || busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setConfirmLiquidar(false)
    try {
      // Ubicación (D-UX48-02/03): una lectura al registrar. Siempre resuelve; si no hay
      // posición se conserva la causa y el abono continúa igual.
      setPhase('locating')
      const geo: GeoCapture = await captureLocation()
      setPhase('saving')

      const result = await registerPayment({
        saleId: sale.id,
        requestedAmount: valor,
        actor: user,
        // Solo lo envía un actor administrativo: Cobrador y Supervisor responden
        // siempre por lo que registran y no ven el selector.
        collectorId: collectorId || undefined,
        observacion,
        lat: geo.status === 'captured' ? geo.lat : undefined,
        lng: geo.status === 'captured' ? geo.lng : undefined,
        location: geo,
        syncStatus: navigator.onLine ? 'synced' : 'pending',
      })
      if (!result.ok) { toast.error(result.message); return }

      if (result.capped) {
        toast.warning(`Abono limitado al saldo pendiente: ${formatCurrency(result.appliedAmount, currency)}. La deuda queda en ${formatCurrency(0, currency)}.`)
      }
      setPaidNumber(result.paidInstallmentNumber)
      setAppliedAmount(result.appliedAmount)
      // El estado de ubicación es el CONFIRMADO por el servidor cuando existe (Online);
      // en local, el de la lectura. Nunca se confunde con el resultado del pago.
      setGeoResult({ status: result.locationStatus ?? geo.status, accuracyM: geo.status === 'captured' ? geo.accuracyM : undefined })
      setSuccess(true)
      // Refresco desde la base (fuente única), nunca desde un cálculo local.
      await refreshFromDb()
    } finally {
      busyRef.current = false
      setSaving(false)
      setPhase('idle')
    }
  }

  const whatsapp = resolveWhatsAppRecipient(client?.telefonoPrincipal, tenant?.pais)

  function openWhatsApp() {
    if (!client || !sale || !whatsapp.ok) return
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
    window.open(whatsAppLink(whatsapp, msg), '_blank', 'noopener')
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
  // Vista previa SOLO de presentación (Ronda 48): el servicio aplica, topa y calcula
  // el saldo real; esta cifra solo anticipa el resultado para evitar errores de digitación.
  const aRegistrar = Math.min(valor, qa.total)
  const saldoPrevisto = Math.max(0, qa.total - aRegistrar)
  const liquida = valor > 0 && valor >= qa.total
  const chip = (activo: boolean, base: string) =>
    `${base} ${activo ? 'ring-2 ring-primary-500 ring-offset-1' : ''}`
  const geoTone = geoResult?.status === 'captured' ? 'text-emerald-700' : 'text-gray-500'

  return (
    <div className="p-4 space-y-4">
      {/* Client info */}
      <div className="bg-primary-50 rounded-2xl p-4">
        <p className="font-bold text-primary-900">{client.nombre}</p>
        <p className="text-sm text-primary-600">{client.negocio}</p>
        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="text-center"><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600 tabular-nums">{formatCurrency(sale.saldo, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700 tabular-nums">{formatCurrency(qa.parcela, currency)}</p></div>
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
          <p className="text-sm text-gray-500">Abono {formatCurrency(appliedAmount, currency)} · Nuevo saldo: {formatCurrency(sale.saldo, currency)}</p>
          {/* Ubicación: dato aparte del resultado financiero (nunca lo condiciona). */}
          {geoResult && (
            <p className={`flex items-center gap-1.5 text-xs ${geoTone}`} data-testid="payment-location-status">
              <MapPin className="w-3.5 h-3.5" />
              {GEO_STATUS_LABEL[geoResult.status]}
              {geoResult.status === 'captured' && geoResult.accuracyM != null ? ` (±${geoResult.accuracyM} m)` : ''}
            </p>
          )}
          {whatsapp.ok ? (
            <button onClick={openWhatsApp} className="flex items-center gap-2 bg-green-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium" data-testid="whatsapp-receipt">
              <MessageSquare className="w-4 h-4" /> Enviar recibo a {whatsapp.display}
            </button>
          ) : (
            <p className="max-w-xs text-center text-xs text-gray-500" data-testid="whatsapp-blocked">
              Recibo por WhatsApp no disponible: {whatsapp.reason}
            </p>
          )}
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
            <label htmlFor="payment-amount" className="block text-sm font-semibold text-gray-700">Valor del abono</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-gray-400">{getCurrencySymbol(currency)}</span>
              <input
                id="payment-amount"
                type="text"
                inputMode="numeric"
                value={formatCurrencyInput(valor, currency)}
                onChange={e => setValor(parseCurrencyInput(e.target.value))}
                placeholder="0"
                className="w-full h-14 text-2xl font-bold text-center rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:outline-none tabular-nums"
              />
            </div>

            {/* Quick amounts — sobre el saldo REAL de la parcela actual. El elegido queda marcado. */}
            <div className="grid grid-cols-3 gap-2">
              <button type="button" aria-pressed={valor === qa.parcela} onClick={() => setValor(qa.parcela)}
                className={chip(valor === qa.parcela, 'py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium')}>Completar parcela<br />{formatCurrency(qa.parcela, currency)}</button>
              <button type="button" aria-pressed={valor === qa.mitad} onClick={() => setValor(qa.mitad)}
                className={chip(valor === qa.mitad, 'py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium')}>Mitad<br />{formatCurrency(qa.mitad, currency)}</button>
              <button type="button" aria-pressed={valor === qa.total} onClick={() => setValor(qa.total)}
                className={chip(valor === qa.total, 'py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium')}>Total deuda<br />{formatCurrency(qa.total, currency)}</button>
            </div>
            {valor > qa.total && (
              <p className="text-xs text-amber-600">Supera el saldo: se registrará {formatCurrency(qa.total, currency)} y la deuda quedará en {formatCurrency(0, currency)}.</p>
            )}
          </div>

          {/* ¿Quién recibió el dinero? En la capa operativa nunca se pregunta:
              Cobrador y Supervisor responden por lo que registran, así que el
              componente no renderiza nada. Solo existe para actores administrativos. */}
          {sale && <CollectorPicker routeId={sale.routeId} value={collectorId} onChange={setCollectorId} />}

          {/* Observation */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4">
            <label htmlFor="payment-note" className="block text-sm font-medium text-gray-700 mb-2">Observación (opcional)</label>
            <textarea id="payment-note" value={observacion} onChange={e => setObservacion(e.target.value)} rows={2}
              className="w-full rounded-xl border border-gray-200 p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>

          {/* Resumen antes de confirmar (Ronda 48 · H-05): qué se registra y cómo queda. */}
          {valor > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm" data-testid="payment-preview">
              <div className="flex items-center justify-between gap-3">
                <span className="text-gray-500">Cliente</span>
                <span className="font-medium text-gray-900 text-right truncate">{client.nombre}</span>
              </div>
              <div className="flex items-center justify-between gap-3 mt-1">
                <span className="text-gray-500">A registrar</span>
                <span className="font-bold text-gray-900 tabular-nums">{formatCurrency(aRegistrar, currency)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 mt-1">
                <span className="text-gray-500">Saldo previsto</span>
                <span className={`font-semibold tabular-nums ${liquida ? 'text-emerald-700' : 'text-amber-600'}`}>
                  {formatCurrency(saldoPrevisto, currency)}{liquida ? ' · deuda liquidada' : ''}
                </span>
              </div>
            </div>
          )}

          {/* Ubicación: finalidad informada, sin promesas falsas (Ronda 48 · B6). */}
          <div className="flex items-start gap-2 text-xs text-gray-500">
            <MapPin className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {geoSupport.supported
              ? <span>Al registrar se pedirá tu ubicación como evidencia complementaria del cobro. Si no está disponible, el abono se registra igual.</span>
              : <span>No se puede registrar la ubicación en este dispositivo o sitio: {geoSupport.reason} El abono se registra igual.</span>}
          </div>

          <button
            onClick={requestPay}
            disabled={saving || !valor || valor <= 0}
            data-testid="payment-submit"
            className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2"
          >
            {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckCircle className="w-5 h-5" />}
            {phase === 'locating' ? 'Obteniendo ubicación…'
              : phase === 'saving' ? 'Guardando…'
              : valor > 0 ? `Registrar ${formatCurrency(aRegistrar, currency)}` : 'Registrar abono'}
          </button>

          <button onClick={() => navigate(-1)} disabled={saving} className="w-full text-gray-500 text-sm py-2">Cancelar</button>
        </>
      )}

      {/* Confirmación extra SOLO cuando el abono liquida toda la deuda (Ronda 48 · H-05). */}
      <Modal open={confirmLiquidar} onClose={() => { if (!saving) setConfirmLiquidar(false) }} title="Liquidar la deuda completa" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmLiquidar(false)} disabled={saving} autoFocus>Revisar importe</Button>
          <Button variant="success" onClick={() => void handlePay()} loading={saving} data-testid="payment-liquidate-confirm">
            Registrar {formatCurrency(aRegistrar, currency)}
          </Button>
        </>}>
        <div className="flex items-start gap-3 text-sm text-gray-700">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="space-y-1.5">
            <p>Vas a registrar <span className="font-semibold text-gray-900">{formatCurrency(aRegistrar, currency)}</span> de <span className="font-semibold text-gray-900">{client.nombre}</span>.</p>
            <p>Es el <span className="font-medium">total de la deuda</span>: el saldo quedará en {formatCurrency(0, currency)} y la venta se dará por terminada.</p>
            {valor > qa.total && <p className="text-xs text-amber-700">Escribiste {formatCurrency(valor, currency)}; solo se registra el saldo pendiente.</p>}
          </div>
        </div>
      </Modal>
    </div>
  )
}
