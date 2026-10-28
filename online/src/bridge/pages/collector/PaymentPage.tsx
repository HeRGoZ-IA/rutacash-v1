// ADEX Online: COPIA de PaymentPage (CLEAN). Cambios marcados «ADEX Online (Ronda 62)»: MODO SIN
// CONEXIÓN del Cobrador. Sin servidor, el abono se GUARDA en el dispositivo (cifrado, con su id de
// operación, la hora y la ubicación tomadas ahora) y se muestra como «guardado, no confirmado»; nunca
// como «¡Abono registrado!». Sin conexión no se admite más que el saldo conocido (el servidor tampoco
// lo topará: lo devolverá para revisión). Un abono en línea sin respuesta pasa a esa misma cola.
// Con internet, el flujo, los textos y las reglas son los originales.
import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { AlertTriangle, CheckCircle, MapPin, MessageSquare, Smartphone } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { db } from '@/lib/db'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatCurrencyInput, parseCurrencyInput, getCurrencySymbol } from '@/lib/formatters'
import { formatBusinessName, formatClientName } from '@/lib/displayName'
import { calculateCurrentInstallment } from '@/services/installmentEngine'
import {
  registerPayment, quickAmounts, amountForInstallments, pendingInstallments, getUnconfirmedPayment, checkUnconfirmedPayment,
  type RegisterPaymentSuccess, type UnconfirmedPayment,
} from '@/services/paymentService'
import { CollectorPicker } from '@/components/ui/CollectorPicker'
import { buildWhatsAppMessage } from '@/lib/utils'
import { resolveWhatsAppRecipient, whatsAppLink } from '@/lib/whatsapp'
import {
  captureLocation, geolocationSupport, GEO_STATUS_LABEL, type GeoCapture, type GeoRecordStatus,
} from '@/lib/geolocation'
import type { Sale, Client, Installment } from '@/models/types'
// ADEX Online (Ronda 62): modo sin conexión.
import { formatDateTime, formatDate } from '@/lib/formatters'
import { captureOfflinePayment } from '@/services/paymentService'
import { isOpen, shouldCaptureOffline, useOffline } from '../../../offline/state.ts'
import { OpStatusBadge, useReachable } from '../../../offline/ui.tsx'
import { toMajor } from '../../../runtime/mappers.ts'

/** Hora del envío de un abono sin confirmar (hora local del dispositivo). */
const sentAt = (iso: string) => new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

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
  // Petición del socio (3.15): «Cuotas a pagar» llena el valor; escribir el valor o usar un botón rápido lo vacía.
  const [cuotas, setCuotas] = useState('')
  const setValorManual = (v: number) => { setCuotas(''); setValor(v) }
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
  // Ronda 48.1: abono ENVIADO cuya confirmación no llegó (solo ADEX Online). Mientras exista,
  // no se registra otro en este crédito: se comprueba ese mismo (nunca crea un segundo pago).
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedPayment | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState('')
  const [recovered, setRecovered] = useState(false)
  const currentSaleRef = useRef(saleId)
  currentSaleRef.current = saleId
  // ADEX Online (Ronda 62): abono guardado en el dispositivo (id de la operación) y pendientes del crédito.
  const [queued, setQueued] = useState<string | null>(null)
  const offlineOps = useOffline((st) => st.ops)
  const offlineEnabled = useOffline((st) => st.enabled)
  const savedAt = useOffline((st) => st.dataSavedAt)
  const reachable = useReachable()
  const queuedOp = useMemo(() => (queued ? offlineOps.find((o) => o.id === queued) ?? null : null), [queued, offlineOps])
  const pendingHere = useMemo(() => offlineOps.filter((o) => o.ref.saleId === saleId && isOpen(o)), [offlineOps, saleId])
  const pendingPayMinor = pendingHere.filter((o) => o.kind === 'payment').reduce((t, o) => t + (o.ref.amountMinor ?? 0), 0)
  const offlineNow = offlineEnabled && (!reachable || shouldCaptureOffline())

  useEffect(() => { load() }, [saleId])
  // Tras una recarga o al volver a la pantalla, se comprueba solo lo que quedó sin confirmar.
  useEffect(() => {
    if (!saleId) return
    const u = getUnconfirmedPayment(saleId)
    setUnconfirmed(u)
    if (u) void runCheck()
  }, [saleId])  // eslint-disable-line react-hooks/exhaustive-deps
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
    setCuotas('')
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
    setConfirmLiquidar(false)
    const previo = getUnconfirmedPayment(sale.id)
    if (previo) { setUnconfirmed(previo); return }
    // ADEX Online (Ronda 62): sin servidor (o con otro abono de este crédito aún en la cola del
    // dispositivo, para respetar el orden) el abono se guarda en el dispositivo.
    if (shouldCaptureOffline() || (offlineEnabled && pendingHere.some((o) => o.kind === 'payment'))) { await handleOfflinePay(); return }
    busyRef.current = true
    setSaving(true)
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
      if (!result.ok) {
        // ADEX Online (Ronda 62): sin respuesta, el abono pasó a la cola del dispositivo (mismo id).
        const queuedId = (result as { queuedId?: string }).queuedId
        if (queuedId) { setGeoResult({ status: geo.status, accuracyM: geo.status === 'captured' ? geo.accuracyM : undefined }); setQueued(queuedId); return }
        // Sin confirmación: NO es un error ni un éxito. Se muestra el abono pendiente de comprobar.
        if (result.code === 'PAYMENT_UNCONFIRMED' && result.unconfirmed) { setCheckNote(''); setUnconfirmed(result.unconfirmed); return }
        if (result.code === 'PREVIOUS_PAYMENT_CONFIRMED') { toast.warning(result.message); await load(); return }
        toast.error(result.message)
        return
      }
      await showConfirmed(result, geo)
    } finally {
      busyRef.current = false
      setSaving(false)
      setPhase('idle')
    }
  }

  /**
   * ADEX Online (Ronda 62): ABONO SIN CONEXIÓN. Se guarda en el dispositivo con la hora y la
   * ubicación de AHORA (sin ubicación, la causa; nunca bloquea). No cambia saldos ni se presenta
   * como confirmado: lo confirmará el servidor al sincronizar.
   */
  async function handleOfflinePay() {
    if (!sale || !client || busyRef.current) return
    const limite = Math.max(0, qa.total - toMajor(pendingPayMinor))
    if (valor > limite) {
      toast.error(`Sin conexión no se puede registrar más que el saldo conocido (${formatCurrency(limite, currency)}).`)
      return
    }
    busyRef.current = true
    setSaving(true)
    try {
      const capturedAt = new Date().toISOString()
      setPhase('locating')
      const geo: GeoCapture = await captureLocation()
      setPhase('saving')
      const op = await captureOfflinePayment({
        saleId: sale.id, routeId: sale.routeId, clientId: client.id, clientName: client.nombre, amount: valor,
        knownBalance: sale.saldo, observacion, location: geo, capturedAt,
      })
      setGeoResult({ status: geo.status, accuracyM: geo.status === 'captured' ? geo.accuracyM : undefined })
      setQueued(op.id)
    } catch {
      toast.error('No se pudo guardar el abono en este dispositivo. No se registró nada: inténtelo de nuevo.')
    } finally {
      busyRef.current = false
      setSaving(false)
      setPhase('idle')
    }
  }

  /** Pantalla de éxito SOLO con la confirmación del servidor (o de la base local en CLEAN). */
  async function showConfirmed(result: RegisterPaymentSuccess, geo?: GeoCapture) {
    if (result.capped) {
      toast.warning(`Recaudo limitado al saldo pendiente: ${formatCurrency(result.appliedAmount, currency)}. La deuda queda en ${formatCurrency(0, currency)}.`)
    }
    setPaidNumber(result.paidInstallmentNumber)
    setAppliedAmount(result.appliedAmount)
    // El estado de ubicación es el CONFIRMADO por el servidor cuando existe (Online);
    // en local, el de la lectura. Nunca se confunde con el resultado del pago.
    const status = result.locationStatus ?? geo?.status
    setGeoResult(status ? { status, accuracyM: geo?.status === 'captured' ? geo.accuracyM : undefined } : null)
    setRecovered(result.recovered === true)
    setUnconfirmed(null)
    setSuccess(true)
    // Refresco desde la base (fuente única), nunca desde un cálculo local.
    await refreshFromDb()
  }

  /** «Comprobar ahora»: consulta ese MISMO abono; si el servidor no lo tiene, lo repite con el mismo id. */
  async function runCheck() {
    if (!saleId || busyRef.current) return
    const forSale = saleId
    busyRef.current = true
    setChecking(true)
    try {
      const r = await checkUnconfirmedPayment(forSale)
      // La pantalla cambió de crédito mientras se comprobaba: este resultado no es de ella.
      if (currentSaleRef.current !== forSale) return
      if (r.status === 'confirmed') await showConfirmed(r.result)
      else if (r.status === 'unconfirmed') { setUnconfirmed(r.payment); setCheckNote(r.message) }
      else {
        setUnconfirmed(null)
        if (r.status === 'not_registered') { toast.warning(r.message); await load() }
      }
    } finally {
      busyRef.current = false
      setChecking(false)
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
  const pendientes = pendingInstallments(installments).length
  // Vista previa SOLO de presentación (Ronda 48): el servicio aplica, topa y calcula
  // el saldo real; esta cifra solo anticipa el resultado para evitar errores de digitación.
  const aRegistrar = Math.min(valor, qa.total)
  const saldoPrevisto = Math.max(0, qa.total - aRegistrar)
  const liquida = valor > 0 && valor >= qa.total
  // ADEX Online (Ronda 62): sin conexión, el máximo es el saldo conocido menos lo pendiente en el dispositivo.
  const limiteSinConexion = Math.max(0, qa.total - toMajor(pendingPayMinor))
  const chip = (activo: boolean, base: string) =>
    `${base} ${activo ? 'ring-2 ring-primary-500 ring-offset-1' : ''}`
  const geoTone = geoResult?.status === 'captured' ? 'text-emerald-700' : 'text-gray-500'

  return (
    <div className="p-4 space-y-4">
      {/* Client info */}
      <div className="bg-primary-50 rounded-2xl p-4">
        <p className="font-bold text-primary-900">{formatClientName(client.nombre)}</p>
        <p className="text-sm text-primary-600">{formatBusinessName(client.negocio)}</p>
        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="text-center"><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600 tabular-nums">{formatCurrency(sale.saldo, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700 tabular-nums">{formatCurrency(qa.parcela, currency)}</p></div>
          <div className="text-center"><p className="text-xs text-gray-500">N° parcela</p><p className="font-bold text-gray-700"><span className="text-primary-700">{parcelaNumero ?? '-'}</span>/{sale.numeroCuotas}</p></div>
        </div>
        {/* Petición del socio (3.16): día en que se entregó el dinero. */}
        {sale.fechaDesembolso && <p className="mt-2 text-center text-xs text-primary-700" data-testid="payment-disbursed-date">Desembolsada el {formatDate(sale.fechaDesembolso)}</p>}
      </div>

      {sale.disbursementStatus === 'pendiente' ? (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-2">
          <p className="text-sm font-semibold text-amber-700">Venta pendiente de desembolso</p>
          <p className="text-xs text-amber-600">No puedes registrar abonos hasta confirmar el desembolso en la sección Desembolsos.</p>
          <button onClick={() => navigate(`${base}/disbursements`)} className="text-primary-600 text-sm font-medium">Ir a Desembolsos</button>
        </div>
      ) : queuedOp ? (
        // ADEX Online (Ronda 62): guardado en el dispositivo. Nunca «¡Abono registrado!» hasta que el servidor lo confirme.
        queuedOp.status === 'confirmed' ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-3" data-testid="offline-payment-confirmed">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center"><CheckCircle className="w-8 h-8 text-emerald-600" /></div>
            <p className="text-lg font-bold text-gray-900">Recaudo confirmado por el servidor</p>
            <p className="text-sm text-gray-500">Abono {formatCurrency(toMajor(queuedOp.result?.appliedMinor ?? queuedOp.ref.amountMinor ?? 0), currency)}
              {queuedOp.result?.newBalanceMinor != null ? <> · Nuevo saldo: {formatCurrency(toMajor(queuedOp.result.newBalanceMinor), currency)}</> : null}</p>
            <button onClick={() => navigate(`${base}/route`)} className="text-primary-600 text-sm font-medium">Volver a la ruta</button>
          </div>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3" data-testid="offline-payment-saved" role="status" aria-live="polite">
            <div className="flex items-start gap-3">
              <Smartphone className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-1.5 text-sm text-amber-900">
                <p className="font-semibold">Recaudo guardado en este dispositivo</p>
                <p>
                  <span className="font-semibold tabular-nums">{formatCurrency(toMajor(queuedOp.ref.amountMinor ?? 0), currency)}</span> de {formatClientName(client.nombre)}, capturado el {formatDateTime(queuedOp.capturedAt)}.
                </p>
                <p>Todavía <span className="font-semibold">no está confirmado por el servidor</span>: se enviará solo cuando haya internet. No lo vuelva a registrar.</p>
              </div>
            </div>
            <OpStatusBadge status={queuedOp.status} />
            {queuedOp.error && queuedOp.status !== 'sending' && <p className="text-xs text-orange-700">{queuedOp.error.message}</p>}
            {geoResult && (
              <p className={`flex items-center gap-1.5 text-xs ${geoTone}`} data-testid="payment-location-status">
                <MapPin className="w-3.5 h-3.5" />
                {GEO_STATUS_LABEL[geoResult.status]}
                {geoResult.status === 'captured' && geoResult.accuracyM != null ? ` (±${geoResult.accuracyM} m)` : ''}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="primary" fullWidth onClick={() => navigate(`${base}/route`)}>Volver a la ruta</Button>
              <Button variant="secondary" fullWidth onClick={() => navigate(`${base}/sync`)}>Ver pendientes</Button>
            </div>
          </div>
        )
      ) : success ? (
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-600" />
          </div>
          <p className="text-lg font-bold text-gray-900">¡Recaudo registrado!</p>
          {recovered && (
            <p className="max-w-xs text-center text-xs text-gray-500" data-testid="payment-recovered">
              Confirmado por el servidor al comprobar el envío anterior. Es el mismo abono: no se registró otro.
            </p>
          )}
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
      ) : unconfirmed ? (
        // Ronda 48.1: resultado DESCONOCIDO. Ni éxito ni error; nunca invita a cobrar otra vez.
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3" data-testid="payment-unconfirmed" role="status" aria-live="polite">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="space-y-1.5 text-sm text-amber-900">
              <p className="font-semibold">Recaudo sin confirmar</p>
              <p>
                A las {sentAt(unconfirmed.startedAt)} se envió un abono de <span className="font-semibold tabular-nums">{formatCurrency(unconfirmed.requestedAmount, currency)}</span>,
                pero el servidor no alcanzó a confirmarlo. Puede que ya esté registrado.
              </p>
              <p className="font-semibold">No le vuelva a cobrar al cliente.</p>
            </div>
          </div>
          {checkNote && !checking && <p className="text-xs text-amber-700" data-testid="payment-unconfirmed-note">{checkNote}</p>}
          <Button variant="primary" size="xl" fullWidth onClick={() => void runCheck()} loading={checking} data-testid="payment-check">
            {checking ? 'Comprobando…' : 'Comprobar ahora'}
          </Button>
          <p className="text-xs text-amber-700">
            Comprobar nunca crea otro recaudo. Hasta confirmarlo no se puede registrar otro en esta venta. Si sigue sin respuesta, revise la conexión o avise a su administrador.
          </p>
          <button onClick={() => navigate(`${base}/route`)} disabled={checking} className="w-full text-gray-500 text-sm py-2">Volver a la ruta</button>
        </div>
      ) : (
        <>
          {/* ADEX Online (Ronda 62): sin conexión y pendientes de este crédito en el dispositivo. */}
          {offlineNow && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900" data-testid="payment-offline-note">
              Sin conexión: el abono quedará guardado en este dispositivo y se enviará al volver internet.
              {savedAt ? <> Saldo según los datos del {formatDateTime(savedAt)}.</> : null}
            </div>
          )}
          {pendingHere.length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-700" data-testid="payment-pending-here">
              En este dispositivo hay {pendingHere.length} operación{pendingHere.length === 1 ? '' : 'es'} de esta venta sin confirmar
              {pendingPayMinor > 0 ? <> (abonos por {formatCurrency(toMajor(pendingPayMinor), currency)})</> : null}. El saldo mostrado no las descuenta.
            </div>
          )}

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
            <label htmlFor="payment-amount" className="block text-sm font-semibold text-gray-700">Valor del recaudo</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold text-gray-400">{getCurrencySymbol(currency)}</span>
              <input
                id="payment-amount"
                type="text"
                inputMode="numeric"
                value={formatCurrencyInput(valor, currency)}
                onChange={e => setValorManual(parseCurrencyInput(e.target.value))}
                placeholder="0"
                className="w-full h-14 text-2xl font-bold text-center rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:outline-none tabular-nums"
              />
            </div>

            {/* Quick amounts — sobre el saldo REAL de la parcela actual. El elegido queda marcado. */}
            <div className="grid grid-cols-3 gap-2">
              <button type="button" aria-pressed={valor === qa.parcela} onClick={() => setValorManual(qa.parcela)}
                className={chip(valor === qa.parcela, 'py-2 bg-primary-50 text-primary-700 rounded-xl text-xs font-medium')}>Completar parcela<br />{formatCurrency(qa.parcela, currency)}</button>
              <button type="button" aria-pressed={valor === qa.mitad} onClick={() => setValorManual(qa.mitad)}
                className={chip(valor === qa.mitad, 'py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-medium')}>Mitad<br />{formatCurrency(qa.mitad, currency)}</button>
              <button type="button" aria-pressed={valor === qa.total} onClick={() => setValorManual(qa.total)}
                className={chip(valor === qa.total, 'py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-medium')}>Total deuda<br />{formatCurrency(qa.total, currency)}</button>
            </div>
            {/* Petición del socio (3.15): pagar por número de cuotas. Solo propone el valor; el servicio lo aplica como siempre. */}
            <div className="flex items-center gap-3">
              <label htmlFor="payment-installments" className="text-sm text-gray-600 whitespace-nowrap">Cuotas a pagar</label>
              <input
                id="payment-installments"
                data-testid="payment-installments"
                type="text"
                inputMode="numeric"
                value={cuotas}
                onChange={e => {
                  const t = e.target.value.replace(/\D/g, '').slice(0, 3)
                  setCuotas(t)
                  const n = Number(t)
                  if (n > 0) setValor(amountForInstallments(sale, installments, n))
                }}
                placeholder="0"
                className="w-20 h-10 text-center text-lg font-bold rounded-xl border-2 border-gray-200 focus:border-primary-500 focus:outline-none tabular-nums"
              />
              <span className="text-xs text-gray-500">de {pendientes} pendiente{pendientes === 1 ? '' : 's'}</span>
            </div>
            {Number(cuotas) > pendientes && pendientes > 0 && (
              <p className="text-xs text-amber-600">Solo quedan {pendientes} cuota{pendientes === 1 ? '' : 's'}: se propone el total de la deuda.</p>
            )}
            {offlineNow && valor > limiteSinConexion ? (
              <p className="text-xs text-red-600">Sin conexión no se puede registrar más que el saldo conocido ({formatCurrency(limiteSinConexion, currency)}).</p>
            ) : valor > qa.total && (
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
              className="w-full rounded-xl border border-gray-200 p-3 text-base sm:text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>

          {/* Resumen antes de confirmar (Ronda 48 · H-05): qué se registra y cómo queda. */}
          {valor > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm" data-testid="payment-preview">
              <div className="flex items-center justify-between gap-3">
                <span className="text-gray-500">Cliente</span>
                <span className="font-medium text-gray-900 text-right truncate">{formatClientName(client.nombre)}</span>
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
              : offlineNow ? (valor > 0 ? `Guardar ${formatCurrency(valor, currency)} sin conexión` : 'Guardar abono sin conexión')
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
            <p>Vas a registrar <span className="font-semibold text-gray-900">{formatCurrency(aRegistrar, currency)}</span> de <span className="font-semibold text-gray-900">{formatClientName(client.nombre)}</span>.</p>
            <p>Es el <span className="font-medium">total de la deuda</span>: el saldo quedará en {formatCurrency(0, currency)} y la venta se dará por terminada.</p>
            {valor > qa.total && <p className="text-xs text-amber-700">Escribiste {formatCurrency(valor, currency)}; solo se registra el saldo pendiente.</p>}
          </div>
        </div>
      </Modal>
    </div>
  )
}
