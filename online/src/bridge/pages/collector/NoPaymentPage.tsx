// ADEX Online: COPIA de NoPaymentPage (CLEAN). Cambios marcados «ADEX Online (Ronda 62)»:
//   1. Un id de operación por INTENCIÓN (no por toque): reintentar la misma visita tras un fallo de red
//      nunca registra dos visitas; cambiar el motivo o la nota es otra intención (id nuevo).
//   2. El error real del servidor se muestra (CLEAN decía siempre «Error al guardar»).
//   3. MODO SIN CONEXIÓN del Cobrador: sin servidor, la visita se guarda en el dispositivo y se envía
//      al volver internet; una visita enviada sin respuesta pasa a esa misma cola con su mismo id.
//   Una visita sin pago no mueve dinero, no cambia saldos ni crea abonos (lo garantiza el servidor).
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { XCircle } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import type { Sale, Client } from '@/models/types'
// ADEX Online (Ronda 62).
import { money } from '../../../runtime/commands.ts'
import { shouldCaptureOffline, useOffline } from '../../../offline/state.ts'
import { adoptUncertainVisit, captureOfflineVisit, visitBody, type VisitInput } from '../../../offline/captures.ts'
import { useReachable } from '../../../offline/ui.tsx'
import { formatClientName } from '@/lib/displayName'

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
  const base = useOpBase()
  const { user } = useAuth()
  const [sale, setSale] = useState<Sale | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [motivo, setMotivo] = useState('no_estaba')
  const [fechaPromesa, setFechaPromesa] = useState('')
  const [observacion, setObservacion] = useState('')
  const [saving, setSaving] = useState(false)
  // ADEX Online (Ronda 62): id de operación de la intención en curso y su cuerpo.
  const intent = useRef<{ id: string; key: string } | null>(null)
  const offlineEnabled = useOffline((st) => st.enabled)
  const reachable = useReachable()

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
    if (!sale || !user || !client || saving) return
    setSaving(true)
    const input: VisitInput = {
      saleId: sale.id, routeId: sale.routeId, clientId: sale.clientId, clientName: client.nombre,
      reason: motivo, promisedPaymentDate: motivo === 'promesa_pago' && fechaPromesa ? fechaPromesa : undefined, note: observacion,
    }
    try {
      if (shouldCaptureOffline()) {
        await captureOfflineVisit(input)
        toast.success('Visita guardada en este dispositivo. Se enviará al volver internet.')
        navigate(`${base}/route`)
        return
      }
      const body = visitBody(input)
      const key = JSON.stringify(body)
      if (!intent.current || intent.current.key !== key) intent.current = { id: crypto.randomUUID(), key }
      const id = intent.current.id
      try {
        await money('POST', '/v1/no-payment-visits', body, id)
      } catch (e) {
        // Sin respuesta del servidor: la MISMA visita pasa a la cola del dispositivo (mismo id y cuerpo).
        if (offlineEnabled && (e as { code?: string })?.code === 'UNCERTAIN_OPERATION') {
          await adoptUncertainVisit(id, input, body, new Date().toISOString())
          toast.warning('Sin respuesta del servidor: la visita quedó guardada en este dispositivo y se confirmará al volver la conexión.')
          navigate(`${base}/route`)
          return
        }
        throw e
      }
      intent.current = null
      toast.success('Visita sin pago registrada')
      navigate(`${base}/route`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error al guardar') } finally { setSaving(false) }
  }

  if (!sale || !client) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>

  const sinConexion = offlineEnabled && !reachable

  return (
    <div className="p-4 space-y-4">
      <div className="bg-red-50 rounded-2xl p-4">
        <p className="font-bold text-red-900">{formatClientName(client.nombre)}</p>
        <p className="text-sm text-red-500">Registrar visita sin pago</p>
      </div>

      {sinConexion && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900" data-testid="visit-offline-note">
          Sin conexión: la visita quedará guardada en este dispositivo y se enviará al volver internet.
        </div>
      )}

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

      <button onClick={handleSave} disabled={saving} data-testid="visit-submit"
        className="w-full h-14 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2">
        {saving ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <XCircle className="w-5 h-5" />}
        {sinConexion ? 'Guardar no pago sin conexión' : 'Registrar no pago'}
      </button>
      <button onClick={() => navigate(-1)} className="w-full text-gray-400 text-sm py-2">Cancelar</button>
    </div>
  )
}
