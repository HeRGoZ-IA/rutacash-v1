// ADEX Online: COPIA de ClientDetailPage (CLEAN). Cambio marcado «ADEX Online (Ronda 62)»: el
// detalle muestra las VISITAS SIN PAGO del crédito (del servidor) y las guardadas en este dispositivo
// sin sincronizar. Antes se registraban, pero ninguna pantalla las mostraba. Nada más cambia.
// «ADEX Online (Ronda 67)»: bloque «Ubicación del cliente» (referencia, fijada con el GPS estando en el lugar).
import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { ChevronLeft, MessageSquare, CreditCard } from 'lucide-react'
import { InstallmentStatusBadge } from '@/components/ui/Badge'
import { db } from '@/lib/db'
import { useDataRevision } from '@/hooks/useDataRevision'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { calculateCurrentInstallment, getLastPaidInstallmentNumber } from '@/services/installmentEngine'
import { buildWhatsAppMessage } from '@/lib/utils'
import { resolveWhatsAppRecipient, whatsAppLink } from '@/lib/whatsapp'
import type { Client, Sale, Installment, NoPaymentVisit } from '@/models/types'
// ADEX Online (Ronda 62).
import { isOpen, useOffline } from '../../../offline/state.ts'
import { reasonLabel } from '../../../offline/captures.ts'
import { OpStatusBadge } from '../../../offline/ui.tsx'
import { formatDateTime } from '@/lib/formatters'
// ADEX Online (Ronda 67).
import { can } from '@/lib/permissions'
import { ClientReferenceLocation } from '../../../runtime/ClientReferenceLocation.tsx'

/**
 * Orden de "Parcelas recientes" (Ajustes post-Revisión 2):
 *  1) Pendientes vencidas (saldo > 0 y vencimiento < hoy) — ascendente por fecha.
 *  2) Pendientes próximas (saldo > 0 y vencimiento >= hoy) — ascendente por fecha.
 *  3) Pagadas — descendente por fecha (las más recientes primero).
 * Nunca en orden aleatorio de inserción.
 */
function sortInstallmentsForDetail(insts: Installment[], todayStr: string): Installment[] {
  const rank = (i: Installment): number => {
    if (i.status === 'pagada' || i.saldo <= 0) return 2
    return i.fechaVencimiento < todayStr ? 0 : 1
  }
  return [...insts].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    // Pagadas: más recientes primero; pendientes: más antiguas primero.
    return ra === 2
      ? b.fechaVencimiento.localeCompare(a.fechaVencimiento)
      : a.fechaVencimiento.localeCompare(b.fechaVencimiento)
  })
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const base = useOpBase()
  const { user } = useAuth()
  const { tenant, currency } = useTenant()
  const [client, setClient] = useState<Client | null>(null)
  const [sales, setSales] = useState<Sale[]>([])
  const [installmentsBySale, setInstallmentsBySale] = useState<Record<string, Installment[]>>({})
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // ADEX Online (Ronda 62): visitas sin pago del cliente (servidor) y pendientes del dispositivo.
  const [visits, setVisits] = useState<NoPaymentVisit[]>([])
  const offlineOps = useOffline((st) => st.ops)

  // Un pago registrado o anulado en otra pestaña cambia saldo y parcelas: se relee.
  const revision = useDataRevision()
  useEffect(() => { load() }, [id, revision])

  async function load() {
    if (!id) return
    const c = await db.clients.get(id)
    if (!c) { setLoading(false); return }
    setClient(c)
    const ss = await db.sales.where('clientId').equals(id).toArray()
    const sorted = ss.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    setSales(sorted)
    const ibys: Record<string, Installment[]> = {}
    for (const s of sorted) {
      const insts = await db.installments.where('saleId').equals(s.id).toArray()
      ibys[s.id] = insts
    }
    setInstallmentsBySale(ibys)
    // ADEX Online (Ronda 62): visitas sin pago registradas (sin permiso de historial: ninguna).
    const vs = await db.noPaymentVisits.where('clientId').equals(id).toArray().catch(() => [] as NoPaymentVisit[])
    setVisits(vs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

    // Venta a mostrar: la indicada por saleId en la URL (venta específica) si existe;
    // si no, la primera venta activa; si no, la más reciente.
    const requested = params.get('saleId')
    const requestedSale = requested ? sorted.find(s => s.id === requested) : undefined
    const firstActive = sorted.find(s => s.status === 'activa')
    setSelectedSaleId((requestedSale ?? firstActive ?? sorted[0])?.id ?? null)
    setLoading(false)
  }

  // ADEX Online (Ronda 62): hooks antes de cualquier retorno anticipado.
  const pendingVisits = useMemo(() => offlineOps.filter(o => o.kind === 'visit' && o.ref.clientId === id && isOpen(o)), [offlineOps, id])

  if (loading) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  if (!client) return <div className="p-4 text-center text-gray-500">Cliente no encontrado</div>

  // Venta seleccionada (por id específico). NO se asume "la más reciente".
  const selectedSale = sales.find(s => s.id === selectedSaleId) ?? null
  const selectedInsts = selectedSale ? (installmentsBySale[selectedSale.id] ?? []) : []
  const currentInst = selectedSale ? calculateCurrentInstallment(selectedInsts) : null
  // Avance (progreso): última parcela pagada / total, no la próxima pendiente.
  const lastPaidNumber = getLastPaidInstallmentNumber(selectedInsts)
  // Ventas activas del cliente (para el conmutador cuando hay más de una).
  const activeSales = sales.filter(s => s.status === 'activa')

  // Ronda 48 (H-02): destinatario deducido del país de la EMPRESA; si es ambiguo, no hay enlace.
  const whatsapp = resolveWhatsAppRecipient(client?.telefonoPrincipal, tenant?.pais)

  function openWhatsApp() {
    if (!client || !selectedSale || !whatsapp.ok) return
    // WhatsApp usa los datos de la venta seleccionada, no de otra venta.
    const msg = buildWhatsAppMessage({
      clientName: client.nombre,
      valor: selectedSale.valorCuota,
      saldo: selectedSale.saldo,
      cuotaActual: currentInst?.numero ?? 0,
      totalCuotas: selectedSale.numeroCuotas,
      currency,
    })
    window.open(whatsAppLink(whatsapp, msg), '_blank', 'noopener')
  }

  const recentInstallments = sortInstallmentsForDetail(selectedInsts, today()).slice(0, 10)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-primary-700 px-4 py-4">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-primary-200 text-sm mb-3">
          <ChevronLeft className="w-4 h-4" /> Volver
        </button>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-primary-500 rounded-full flex items-center justify-center text-white font-bold text-lg">
            {client.nombre.charAt(0)}
          </div>
          <div>
            <h1 className="text-white font-bold">{client.nombre}</h1>
            <p className="text-primary-200 text-sm">{client.negocio}</p>
          </div>
        </div>
      </div>

      <div className="px-4 space-y-4">
        {/* Conmutador de ventas activas (solo si hay más de una) */}
        {activeSales.length > 1 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Ventas activas del cliente</p>
            <div className="flex flex-wrap gap-2">
              {activeSales.map((s, i) => (
                <button key={s.id} onClick={() => setSelectedSaleId(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${selectedSaleId === s.id ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                  Venta {i + 1} · {formatCurrency(s.valorVenta, currency)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Resumen de la venta seleccionada */}
        {selectedSale && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {selectedSale.status === 'activa' ? 'Venta activa' : 'Venta'} · {formatCurrency(selectedSale.valorVenta, currency)}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-amber-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-500">Saldo</p>
                <p className="text-sm font-bold text-amber-600">{formatCurrency(selectedSale.saldo, currency)}</p>
              </div>
              <div className="bg-primary-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-500">Parcela</p>
                <p className="text-sm font-bold text-primary-600">{formatCurrency(selectedSale.valorCuota, currency)}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-500">Parcelas</p>
                <p className="text-sm font-bold text-gray-700">{lastPaidNumber}/{selectedSale.numeroCuotas}</p>
              </div>
            </div>

            {selectedSale.status === 'activa' && (
              <div className="flex gap-2">
                <button onClick={() => navigate(`${base}/payment/${selectedSale.id}`)}
                  className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                  <CreditCard className="w-4 h-4" /> Registrar abono
                </button>
                <button onClick={openWhatsApp} disabled={!whatsapp.ok}
                  title={whatsapp.ok ? `Enviar a ${whatsapp.display}` : whatsapp.reason}
                  aria-label={whatsapp.ok ? `Enviar recibo por WhatsApp a ${whatsapp.display}` : `WhatsApp no disponible: ${whatsapp.reason}`}
                  className="flex-1 py-2.5 bg-green-500 disabled:bg-gray-300 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                  <MessageSquare className="w-4 h-4" /> WhatsApp
                </button>
              </div>
            )}
            {selectedSale.status === 'activa' && (
              <p className="text-xs text-gray-500" data-testid="whatsapp-recipient">
                {whatsapp.ok ? `Recibo por WhatsApp a ${whatsapp.display}` : `WhatsApp no disponible: ${whatsapp.reason}`}
              </p>
            )}
          </div>
        )}

        {/* Contact info */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Contacto</p>
          <p className="text-sm"><span className="text-gray-400">Tel:</span> {client.telefonoPrincipal}</p>
          {client.telefonoSecundario && <p className="text-sm"><span className="text-gray-400">Tel 2:</span> {client.telefonoSecundario}</p>}
          <p className="text-sm"><span className="text-gray-400">Dir:</span> {client.direccionPrincipal}</p>
          <p className="text-sm"><span className="text-gray-400">Doc:</span> {client.documento}</p>
        </div>

        {/* ADEX Online (Ronda 67): ubicación de referencia del cliente. */}
        <ClientReferenceLocation clientId={client.id} canSet={can(user, 'client.setLocation', { routeId: client.routeId })} />

        {/* ADEX Online (Ronda 62): visitas sin pago (servidor) y las guardadas en el dispositivo. */}
        {(visits.length > 0 || pendingVisits.length > 0) && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4" data-testid="client-visits">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Visitas sin pago</p>
            <div className="space-y-2">
              {pendingVisits.map(o => (
                <div key={o.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-gray-600">{formatDateTime(o.capturedAt)} · {o.ref.label ?? reasonLabel(o.ref.reason)}</span>
                  <OpStatusBadge status={o.status} />
                </div>
              ))}
              {visits.slice(0, 10).map(v => (
                <div key={v.id} className="flex items-center justify-between gap-2 text-sm" data-testid="client-visit">
                  <span className="text-gray-600">{formatDate(v.fecha)} · {reasonLabel(v.motivo)}{v.observacion ? ` · ${v.observacion}` : ''}</span>
                  {v.fechaPromesaPago && <span className="text-xs text-gray-500">Promete {formatDate(v.fechaPromesaPago)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Parcelas recientes (de la venta seleccionada, ordenadas) */}
        {selectedSale && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Parcelas recientes</p>
            <div className="space-y-1.5">
              {recentInstallments.map(inst => (
                <div key={inst.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">#{inst.numero} - {formatDate(inst.fechaVencimiento)}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{formatCurrency(inst.valor)}</span>
                    <InstallmentStatusBadge status={inst.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
