import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { XCircle } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { generateId } from '@/lib/utils'
import { today, nowISO } from '@/lib/formatters'
import type { Sale, Client } from '@/models/types'

const MOTIVOS = [
  { value: 'no_estaba', label: 'No estaba' },
  { value: 'sin_dinero', label: 'Sin dinero' },
  { value: 'negocio_cerrado', label: 'Negocio cerrado' },
  { value: 'promesa_pago', label: 'Promesa de pago' },
  { value: 'otro', label: 'Otro' },
]

export default function NoPaymentPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [sale, setSale] = useState<Sale | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [motivo, setMotivo] = useState('no_estaba')
  const [fechaPromesa, setFechaPromesa] = useState('')
  const [observacion, setObservacion] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [saleId])

  async function load() {
    if (!saleId) return
    const s = await db.sales.get(saleId)
    if (!s) return
    const c = await db.clients.get(s.clientId)
    setSale(s)
    setClient(c ?? null)
  }

  async function handleSave() {
    if (!sale || !user) return
    setSaving(true)
    try {
      await db.noPaymentVisits.add({
        id: generateId(), tenantId: user.tenantId, saleId: sale.id, clientId: sale.clientId,
        routeId: sale.routeId, collectorId: user.id,
        motivo: motivo as any, fechaPromesaPago: fechaPromesa || undefined, observacion,
        fecha: today(), syncStatus: navigator.onLine ? 'synced' : 'pending', createdAt: nowISO(),
      })
      toast.success('Visita sin pago registrada')
      navigate('/collector/route')
    } catch { toast.error('Error al guardar') } finally { setSaving(false) }
  }

  if (!sale || !client) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>

  return (
    <div className="p-4 space-y-4">
      <div className="bg-red-50 rounded-2xl p-4">
        <p className="font-bold text-red-900">{client.nombre}</p>
        <p className="text-sm text-red-500">Registrar visita sin pago</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">Motivo</label>
          <div className="space-y-2">
            {MOTIVOS.map(m => (
              <button
                key={m.value}
                onClick={() => setMotivo(m.value)}
                className={`w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition-colors ${motivo === m.value ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {motivo === 'promesa_pago' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Fecha de promesa</label>
            <input type="date" value={fechaPromesa} onChange={e => setFechaPromesa(e.target.value)}
              className="w-full h-10 rounded-xl border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Observación</label>
          <textarea value={observacion} onChange={e => setObservacion(e.target.value)} rows={2}
            className="w-full rounded-xl border border-gray-200 p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      <button onClick={handleSave} disabled={saving}
        className="w-full h-14 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2">
        {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <XCircle className="w-5 h-5" />}
        Registrar no pago
      </button>
      <button onClick={() => navigate(-1)} className="w-full text-gray-400 text-sm py-2">Cancelar</button>
    </div>
  )
}
