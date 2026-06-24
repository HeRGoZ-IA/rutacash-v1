import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, MessageSquare, CreditCard } from 'lucide-react'
import { InstallmentStatusBadge } from '@/components/ui/Badge'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { calculateCurrentInstallment } from '@/services/installmentEngine'
import type { Client, Sale, Installment } from '@/models/types'

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [client, setClient] = useState<Client | null>(null)
  const [sales, setSales] = useState<Sale[]>([])
  const [installmentsBySale, setInstallmentsBySale] = useState<Record<string, Installment[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [id])

  async function load() {
    if (!id) return
    const c = await db.clients.get(id)
    if (!c) { setLoading(false); return }
    setClient(c)
    const ss = await db.sales.where('clientId').equals(id).toArray()
    setSales(ss.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    const ibys: Record<string, Installment[]> = {}
    for (const s of ss) {
      const insts = await db.installments.where('saleId').equals(s.id).toArray()
      ibys[s.id] = insts
    }
    setInstallmentsBySale(ibys)
    setLoading(false)
  }

  function openWhatsApp() {
    if (!client) return
    const phone = client.telefonoPrincipal.replace(/\D/g, '')
    window.open(`https://wa.me/57${phone}`, '_blank')
  }

  if (loading) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  if (!client) return <div className="p-4 text-center text-gray-500">Cliente no encontrado</div>

  const activeSale = sales.find(s => s.status === 'activa')
  const currentInst = activeSale ? calculateCurrentInstallment(installmentsBySale[activeSale.id] ?? []) : null

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
        {/* Current sale summary */}
        {activeSale && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Venta activa</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-amber-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-400">Saldo</p>
                <p className="text-sm font-bold text-amber-600">{formatCurrency(activeSale.saldo)}</p>
              </div>
              <div className="bg-primary-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-400">Parcela</p>
                <p className="text-sm font-bold text-primary-600">{formatCurrency(activeSale.valorCuota)}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5 text-center">
                <p className="text-xs text-gray-400">Progreso</p>
                <p className="text-sm font-bold text-gray-700">{currentInst?.numero ?? 0}/{activeSale.numeroCuotas}</p>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={() => navigate(`/collector/payment/${activeSale.id}`)}
                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                <CreditCard className="w-4 h-4" /> Registrar abono
              </button>
              <button onClick={openWhatsApp}
                className="flex-1 py-2.5 bg-green-500 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2">
                <MessageSquare className="w-4 h-4" /> WhatsApp
              </button>
            </div>
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

        {/* Recent installments */}
        {activeSale && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Parcelas recientes</p>
            <div className="space-y-1.5">
              {(installmentsBySale[activeSale.id] ?? []).slice(0, 10).map(inst => (
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
