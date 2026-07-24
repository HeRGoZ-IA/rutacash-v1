import { useState, useEffect } from 'react'
import { Receipt, CheckCircle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { approvePaymentAdjustment, rejectPaymentAdjustment } from '@/services/paymentCorrectionService'
import { filterByAccessibleRoute } from '@/lib/permissions'
import type { PaymentAdjustmentRequest, Client, Route, PaymentAdjustmentStatus } from '@/models/types'

const META: Record<PaymentAdjustmentStatus, { label: string; variant: 'warning' | 'success' | 'danger' }> = {
  pending: { label: 'Pendiente', variant: 'warning' },
  approved: { label: 'Aprobada', variant: 'success' },
  rejected: { label: 'Rechazada', variant: 'danger' },
}

/**
 * Solicitudes de AJUSTE DE PAGO (periodos cerrados) que aprueba/rechaza el
 * Administrador autorizado o el Super Admin. Al aprobar se ejecuta la reversión +
 * reemplazo (el pago original nunca se elimina).
 */
export default function PaymentAdjustmentsPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [reqs, setReqs] = useState<PaymentAdjustmentRequest[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [routeMap, setRouteMap] = useState<Map<string, Route>>(new Map())
  const [loading, setLoading] = useState(true)
  const [rejectTarget, setRejectTarget] = useState<PaymentAdjustmentRequest | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [working, setWorking] = useState<string | null>(null)

  useEffect(() => { load() }, [tenantId, user])

  async function load() {
    setLoading(true)
    const [rs, clients, routes] = await Promise.all([
      db.paymentAdjustmentRequests.where('tenantId').equals(tenantId).toArray(),
      db.clients.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
    ])
    // RESTRICCIÓN POR RUTAS: solo ajustes de rutas autorizadas (aprobación scopeada).
    const scoped = filterByAccessibleRoute(user, rs)
    scoped.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    setReqs(scoped)
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setRouteMap(new Map(routes.map(r => [r.id, r])))
    setLoading(false)
  }

  async function handleApprove(req: PaymentAdjustmentRequest) {
    if (!user) return
    setWorking(req.id)
    const res = await approvePaymentAdjustment(user, req.id)
    setWorking(null)
    if (res.success) { toast.success('Ajuste aprobado y aplicado'); await load() }
    else toast.error(res.error ?? 'No se pudo aprobar')
  }

  async function handleReject() {
    if (!user || !rejectTarget) return
    if (!rejectReason.trim()) { toast.error('Indica el motivo'); return }
    setWorking(rejectTarget.id)
    const res = await rejectPaymentAdjustment(user, rejectTarget.id, rejectReason.trim())
    setWorking(null)
    if (res.success) { toast.success('Ajuste rechazado'); setRejectTarget(null); setRejectReason(''); await load() }
    else toast.error(res.error ?? 'No se pudo rechazar')
  }

  const clientName = (id: string) => clientMap.get(id)?.nombre ?? 'Cliente'
  const pending = reqs.filter(r => r.status === 'pending')

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Ajustes de pago</h1>
        <p className="text-sm text-gray-500 mt-0.5">Solicitudes de corrección de pagos en periodos cerrados · {pending.length} pendiente(s)</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : reqs.length === 0 ? (
        <EmptyState icon={<Receipt className="w-8 h-8" />} title="Sin solicitudes de ajuste" description="Aquí aparecerán las correcciones de pagos en periodos cerrados que requieren tu aprobación." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 divide-y divide-gray-50">
          {reqs.map(r => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{clientName(r.clientId)}</p>
                <p className="text-xs text-gray-400 truncate">{routeMap.get(r.routeId)?.nombre} · {formatDate(r.requestedAt)}</p>
                <p className="text-xs text-gray-500 mt-0.5">Motivo: {r.reason}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">De {formatCurrency(r.originalValor, currency)}</p>
                <p className="text-sm font-semibold text-primary-700">A {formatCurrency(r.newValor, currency)}</p>
              </div>
              {r.status === 'pending' ? (
                <div className="flex gap-1.5">
                  <Button variant="success" size="sm" loading={working === r.id} onClick={() => handleApprove(r)} icon={<CheckCircle className="w-3.5 h-3.5" />}>Aprobar</Button>
                  <Button variant="danger" size="sm" disabled={working === r.id} onClick={() => { setRejectTarget(r); setRejectReason('') }} icon={<XCircle className="w-3.5 h-3.5" />}>Rechazar</Button>
                </div>
              ) : (
                <Badge variant={META[r.status].variant} size="sm">{META[r.status].label}</Badge>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!rejectTarget} onClose={() => setRejectTarget(null)} title="Rechazar ajuste"
        footer={<><Button variant="secondary" onClick={() => setRejectTarget(null)}>Cancelar</Button><Button variant="danger" onClick={handleReject} loading={!!working}>Confirmar rechazo</Button></>}>
        <Textarea label="Motivo del rechazo" rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)} required />
      </Modal>
    </div>
  )
}
