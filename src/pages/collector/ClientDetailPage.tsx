import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, MessageSquare, CreditCard } from 'lucide-react'
import { InstallmentStatusBadge } from '@/components/ui/Badge'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { calculateCurrentInstallment, getLastPaidInstallmentNumber } from '@/services/installmentEngine'
import { buildWhatsAppMessage } from '@/lib/utils'
import type { Client, Sale, Installment } from '@/models/types'

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
  const { user } = useAuth()
  const { currency } = useTenant()
  const [client, setClient] = useState<Client | null>(null)
  const [sales, setSales] = useState<Sale[]>([])
  const [installmentsBySale, setInstallmentsBySale] = useState<Record<string, Installment[]>>({})
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [id])

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

    // Venta a mostrar: la indicada por saleId en la URL (venta específica) si existe;
    // si no, la primera venta activa; si no, la más reciente.
    const requested = params.get('saleId')
    const requestedSale = requested ? sorted.find(s => s.id === requested) : undefined
    const firstActive = sorted.find(s => s.status === 'activa')
    setSelectedSaleId((requestedSale ?? firstActive ?? sorted[0])?.id ?? null)
    setLoading(false)
  }

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

  function openWhatsApp() {
    if (!client || !selectedSale) return
    // WhatsApp usa los datos de la venta seleccionada, no de otra venta.
    const msg = buildWhatsAppMessage({
      clientName: client.nombre,
      valor: selectedSale.valorCuota,
      saldo: selectedSale.saldo,
      cuotaActual: currentInst?.numero ?? 0,
      totalCuotas: selectedSale.numeroCuotas,
      currency,
    })
    const phone = client.telefonoPrincipal.replace(/\D/g, '')
    window.open(`https://wa.me/57${phone}?text=${encodeURIComponent(msg)}`, '_blank')
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
                <p className="text-xs text-gray-400">Saldo</p>
                <p className="text-sm font-bold text-amber-600">{formatCurrency(selectedSale.saldo, currency)}</p>
              </div>
              <div className="bg-primary-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-400">Parcela</p>
                <p className="text-sm font-bold text-primary-600">{formatCurrency(selectedSale.valorCuota, currency)}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-400">Parcelas</p>
                <p className="text-sm font-bold text-gray-700">{lastPaidNumber}/{selectedSale.numeroCuotas}</p>
              </div>
            </div>

            {selectedSale.status === 'activa' && (
              <div className="flex gap-2">
                <button onClick={() => navigate(`/collector/payment/${selectedSale.id}`)}
                  className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                  <CreditCard className="w-4 h-4" /> Registrar abono
                </button>
                <button onClick={openWhatsApp}
                  className="flex-1 py-2.5 bg-green-500 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                  <MessageSquare className="w-4 h-4" /> WhatsApp
                </button>
              </div>
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
