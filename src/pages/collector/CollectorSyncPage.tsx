import { useState, useEffect } from 'react'
import { RefreshCw, CheckCircle, Clock, Wifi, WifiOff, Info } from 'lucide-react'
import { SyncStatusBadge } from '@/components/ui/Badge'
import { PaymentStateBadge } from '@/components/ui/PaymentAnnulment'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useDataRevision } from '@/hooks/useDataRevision'
import { paymentDisplayStateOf, paymentHistoryRows, pendingPaymentSyncCount } from '@/lib/paymentState'
import { syncPendingItems } from '@/services/syncService'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import type { Payment, SyncStatus } from '@/models/types'

/**
 * Estado de sincronización de la RUTA ACTIVA.
 *
 * ALCANCE (corregido en Fase 0): usaba `user.routeId`, el campo LEGACY de ruta
 * única. Un cobrador con varias rutas veía los pendientes de la ruta equivocada
 * —la primera que se le asignó—, no la que está trabajando.
 *
 * NOTA SOBRE "SINCRONIZAR": hoy NO existe backend. `syncPendingItems` solo marca
 * los registros locales como enviados dentro de la MISMA base del navegador. Los
 * datos NO viajan a otro dispositivo. Ver §24 de la auditoría.
 *
 * ANULACIONES (punto 8, 2026-10-02): una fila por pago, nunca el asiento técnico de
 * reversión. Un pago anulado se muestra "Anulado" (no como cobro pendiente) y la
 * lista se relee sola cuando otra pestaña anula o confirma (`useDataRevision`).
 */
export default function CollectorSyncPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const isOnline = useOnlineStatus()
  const revision = useDataRevision(['payments'])
  const [payments, setPayments] = useState<Payment[]>([])
  const [syncing, setSyncing] = useState(false)
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null

  useEffect(() => {
    let vigente = true
    ;(async () => {
      if (!routeId || !tenantId) { setPayments([]); setLoading(false); return }
      const ps = (await db.payments.where('routeId').equals(routeId).toArray()).filter(p => p.tenantId === tenantId)
      if (!vigente) return
      setPayments(ps.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)))
      setLoading(false)
    })()
    return () => { vigente = false }
  }, [tenantId, routeId, revision])

  async function handleSync() {
    if (!isOnline) { toast.warning('Sin conexión, no se puede sincronizar'); return }
    if (!routeId || !tenantId) return
    setSyncing(true)
    try {
      const { synced, errors } = await syncPendingItems({ tenantId, routeIds: [routeId] })
      if (errors > 0) toast.warning(`${synced} registro(s) confirmado(s); ${errors} con error, revísalo con la oficina`)
      else toast.success(`${synced} registro(s) confirmado(s) en este dispositivo`)
    } finally { setSyncing(false) }
  }

  const filas = paymentHistoryRows(payments)
  const pendingCount = pendingPaymentSyncCount(payments)
  // El estado de una fila combina el del pago y el de su anulación: un pago anulado
  // cuya anulación aún no se confirmó sigue "Pendiente".
  const syncDeFila = (r: { payment: Payment; reversal?: Payment }): SyncStatus => {
    const s = [r.payment.syncStatus, r.reversal?.syncStatus]
    return s.includes('error') ? 'error' : s.includes('pending') ? 'pending' : 'synced'
  }
  const syncedCount = filas.filter(r => syncDeFila(r) === 'synced').length

  return (
    <div className="p-4 space-y-4">
      {/* Estado de CONECTIVIDAD. Deliberadamente NO dice "sincronizado": `navigator.onLine`
          solo informa de que hay red, no de que los datos hayan viajado a ningún sitio. */}
      <div className={`rounded-2xl p-4 text-white ${isOnline ? 'bg-emerald-600' : 'bg-gray-600'}`}>
        <div className="flex items-center gap-2 mb-2">
          {isOnline ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5" />}
          <p className="font-bold">{isOnline ? 'En línea' : 'Sin conexión'}</p>
        </div>
        <p className="text-sm opacity-80">{pendingCount} pago(s) pendiente(s) de registrar</p>
      </div>

      {/* Límite REAL de la versión actual, dicho en pantalla y no solo en un comentario. */}
      <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2">
        <Info className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-amber-800">
          Estar <span className="font-semibold">en línea no significa sincronizado</span>. Esta versión guarda los
          datos en este dispositivo: no se comparten con otros equipos.
        </p>
      </div>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={syncing || !isOnline}
        className="w-full h-14 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2"
      >
        <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Guardando...' : 'Confirmar pendientes'}
      </button>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-amber-50 rounded-2xl p-4 text-center border border-amber-100">
          <Clock className="w-5 h-5 text-amber-600 mx-auto mb-1" />
          <p className="text-2xl font-bold text-amber-600">{pendingCount}</p>
          <p className="text-xs text-gray-500">Pendientes</p>
        </div>
        <div className="bg-emerald-50 rounded-2xl p-4 text-center border border-emerald-100">
          <CheckCircle className="w-5 h-5 text-emerald-600 mx-auto mb-1" />
          <p className="text-2xl font-bold text-emerald-600">{syncedCount}</p>
          <p className="text-xs text-gray-500">Registrados</p>
        </div>
      </div>

      {/* Payments list */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historial de pagos</p>
        {loading ? (
          <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : filas.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">No hay pagos registrados</div>
        ) : (
          <div className="space-y-2">
            {filas.slice(0, 20).map(r => {
              const estado = paymentDisplayStateOf(r.payment)
              const fuera = estado !== 'vigente'
              return (
                <div key={r.payment.id} data-payment-row={estado} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${fuera ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                      Pago {formatCurrency(r.payment.valor, currency)}
                    </p>
                    <p className="text-xs text-gray-400">{formatDateTime(r.payment.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <PaymentStateBadge state={estado} />
                    <SyncStatusBadge status={syncDeFila(r)} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
