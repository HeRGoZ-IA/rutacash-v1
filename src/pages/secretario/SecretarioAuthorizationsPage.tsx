import { useState, useEffect } from 'react'
import { ClipboardCheck, CheckCircle, XCircle, Phone } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select, Textarea } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useAccessibleRoutes } from '@/hooks/useAccessibleRoutes'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { approveSaleRequest, rejectSaleRequest } from '@/services/saleRequestService'
import { logAction } from '@/services/auditService'
import type { SaleRequest, Client, Route, PaymentFrequency, Sale } from '@/models/types'

const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]
const TASA_OPTIONS = [{ value: '10', label: '10%' }, { value: '20', label: '20%' }]
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

/**
 * Autorizaciones del SECRETARIO. Restringido a sus rutas autorizadas. Puede aprobar,
 * rechazar, modificar porcentaje/frecuencia/días ANTES de aprobar y registrar
 * confirmación telefónica. Las condiciones originales no se sobrescriben (trazabilidad).
 */
export default function SecretarioAuthorizationsPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { routes } = useAccessibleRoutes()
  const [requests, setRequests] = useState<SaleRequest[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [routeMap, setRouteMap] = useState<Map<string, Route>>(new Map())
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<SaleRequest | null>(null)
  const [clientSales, setClientSales] = useState<Sale[]>([])
  const [working, setWorking] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  // Overrides de condiciones + confirmación telefónica.
  const [tasa, setTasa] = useState(20)
  const [freq, setFreq] = useState<PaymentFrequency>('diaria')
  const [days, setDays] = useState<number[]>([])
  const [phoneConfirmed, setPhoneConfirmed] = useState(false)
  const [phoneNote, setPhoneNote] = useState('')

  useEffect(() => { load() }, [user, routes.length])

  async function load() {
    if (!user) return
    setLoading(true)
    const [reqs, clients, rts] = await Promise.all([
      db.saleRequests.where('tenantId').equals(user.tenantId).toArray(),
      db.clients.where('tenantId').equals(user.tenantId).toArray(),
      db.routes.where('tenantId').equals(user.tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: solo solicitudes de rutas autorizadas.
    const accessible = reqs.filter(r => can(user, 'authorization.access', { routeId: r.routeId }))
    accessible.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    setRequests(accessible)
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setRouteMap(new Map(rts.map(r => [r.id, r])))
    setLoading(false)
  }

  async function openDetail(req: SaleRequest) {
    setDetail(req)
    setRejecting(false); setRejectReason('')
    setTasa(req.interestRate); setFreq(req.frequency); setDays(req.paymentDays ?? [])
    setPhoneConfirmed(!!req.phoneConfirmed); setPhoneNote(req.phoneConfirmationNote ?? '')
    const sales = await db.sales.where('clientId').equals(req.clientId).toArray()
    setClientSales(sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }

  function toggleDay(d: number) {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b))
  }

  async function handleApprove() {
    if (!detail || !user) return
    if (!can(user, 'authorization.approve', { routeId: detail.routeId })) { toast.error('No autorizado para esta ruta'); return }
    if (days.length === 0) { toast.error('Selecciona al menos un día de pago'); return }
    setWorking(true)
    try {
      const changed = tasa !== detail.interestRate || freq !== detail.frequency || JSON.stringify(days) !== JSON.stringify(detail.paymentDays ?? [])
      await approveSaleRequest(detail, user, {
        interestRate: tasa, frequency: freq, paymentDays: days,
        phoneConfirmed, phoneConfirmationNote: phoneNote || undefined,
      })
      await logAction({
        tenantId: user.tenantId, userId: user.id, userRole: user.rol, routeId: detail.routeId,
        action: 'APPROVE_SALE_REQUEST', entityType: 'SaleRequest', entityId: detail.id,
        descripcion: `Solicitud aprobada (${formatCurrency(detail.amount, currency)})`,
        before: { interestRate: detail.interestRate, frequency: detail.frequency, paymentDays: detail.paymentDays },
        after: { interestRate: tasa, frequency: freq, paymentDays: days, phoneConfirmed },
      })
      if (changed) {
        await logAction({
          tenantId: user.tenantId, userId: user.id, userRole: user.rol, routeId: detail.routeId,
          action: 'CHANGE_SALE_CONDITIONS', entityType: 'SaleRequest', entityId: detail.id,
          descripcion: 'Modificación de condiciones en autorización',
          before: { interestRate: detail.interestRate, frequency: detail.frequency, paymentDays: detail.paymentDays },
          after: { interestRate: tasa, frequency: freq, paymentDays: days },
        })
      }
      if (phoneConfirmed) {
        await logAction({
          tenantId: user.tenantId, userId: user.id, userRole: user.rol, routeId: detail.routeId,
          action: 'PHONE_CONFIRMATION', entityType: 'SaleRequest', entityId: detail.id,
          descripcion: 'Confirmación telefónica con el cliente', motivo: phoneNote || undefined,
        })
      }
      toast.success('Solicitud aprobada. Venta creada, pendiente de desembolso.')
      setDetail(null); await load()
    } catch { toast.error('Error al aprobar') } finally { setWorking(false) }
  }

  async function handleReject() {
    if (!detail || !user) return
    if (!rejectReason.trim()) { toast.error('Indica el motivo del rechazo'); return }
    setWorking(true)
    try {
      await rejectSaleRequest(detail, user, rejectReason.trim())
      await logAction({
        tenantId: user.tenantId, userId: user.id, userRole: user.rol, routeId: detail.routeId,
        action: 'REJECT_SALE_REQUEST', entityType: 'SaleRequest', entityId: detail.id,
        descripcion: 'Solicitud rechazada', motivo: rejectReason.trim(),
      })
      toast.success('Solicitud rechazada')
      setDetail(null); await load()
    } catch { toast.error('Error al rechazar') } finally { setWorking(false) }
  }

  const pending = requests.filter(r => r.status === 'pending')
  const detailClient = detail ? clientMap.get(detail.clientId) : null

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Autorizaciones</h1>
        <p className="text-sm text-gray-500 mt-0.5">{pending.length} solicitud(es) pendiente(s) en tus rutas</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : pending.length === 0 ? (
        <EmptyState icon={<ClipboardCheck className="w-8 h-8" />} title="Sin solicitudes pendientes" description="Cuando lleguen solicitudes de venta de tus rutas, aparecerán aquí." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {pending.map(r => {
            const c = clientMap.get(r.clientId)
            return (
              <button key={r.id} onClick={() => openDetail(r)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-primary-50/40 transition-colors">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{c?.nombre ?? 'Cliente'}</p>
                  <p className="text-xs text-gray-400 truncate">{routeMap.get(r.routeId)?.nombre} · {formatDate(r.requestedAt)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-900">{formatCurrency(r.amount, currency)}</p>
                  <p className="text-xs text-gray-400">{r.installmentsCount} parcelas</p>
                </div>
                <Badge variant="warning" size="sm">Pendiente</Badge>
              </button>
            )
          })}
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Solicitud de venta" size="lg"
        footer={detail && (rejecting ? (
          <>
            <Button variant="secondary" onClick={() => setRejecting(false)} disabled={working}>Cancelar</Button>
            <Button variant="danger" onClick={handleReject} loading={working} icon={<XCircle className="w-4 h-4" />}>Confirmar rechazo</Button>
          </>
        ) : (
          <>
            <Button variant="danger" onClick={() => setRejecting(true)} icon={<XCircle className="w-4 h-4" />}>Rechazar</Button>
            <Button onClick={handleApprove} loading={working} icon={<CheckCircle className="w-4 h-4" />}>Aprobar</Button>
          </>
        ))}>
        {detail && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-gray-900">{detailClient?.nombre ?? 'Cliente'}</h3>
              <p className="text-sm text-gray-500">{detailClient?.documento} · {routeMap.get(detail.routeId)?.nombre}</p>
            </div>

            <div className="bg-gray-50 rounded-xl p-3 grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-gray-500">Valor solicitado</p><p className="font-bold text-gray-900">{formatCurrency(detail.amount, currency)}</p></div>
              <div><p className="text-xs text-gray-500">N° parcelas</p><p className="font-bold text-gray-900">{detail.installmentsCount}</p></div>
            </div>

            {!rejecting && (
              <>
                <p className="text-sm font-semibold text-gray-700">Condiciones (modificables antes de aprobar)</p>
                <div className="grid grid-cols-2 gap-3">
                  <Select label="Porcentaje" value={String(tasa)} onChange={e => setTasa(Number(e.target.value))} options={TASA_OPTIONS} />
                  <Select label="Frecuencia" value={freq} onChange={e => setFreq(e.target.value as PaymentFrequency)} options={FREQ_OPTIONS} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</label>
                  <div className="flex flex-wrap gap-2">
                    {WEEK_DAYS.map(d => (
                      <button key={d.value} type="button" onClick={() => toggleDay(d.value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${days.includes(d.value) ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 p-3 space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input type="checkbox" checked={phoneConfirmed} onChange={e => setPhoneConfirmed(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-primary-600" />
                    <span className="text-sm font-medium text-gray-800 flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> Confirmación telefónica con el cliente</span>
                  </label>
                  {phoneConfirmed && <Textarea placeholder="Nota de la confirmación (opcional)" rows={2} value={phoneNote} onChange={e => setPhoneNote(e.target.value)} />}
                </div>
              </>
            )}

            {rejecting && <Textarea label="Motivo del rechazo" rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)} required />}

            {clientSales.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-1.5">Historial del cliente ({clientSales.length})</p>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {clientSales.map(s => (
                    <div key={s.id} className="flex justify-between text-xs px-3 py-2 rounded-lg bg-gray-50">
                      <span className="text-gray-700">{formatCurrency(s.valorVenta, currency)} · {s.status}</span>
                      <span className="text-amber-600">Saldo {formatCurrency(s.saldo, currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
