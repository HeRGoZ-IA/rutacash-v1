import { useState, useEffect } from 'react'
import { RefreshCw, CheckCircle, Clock, Wifi, WifiOff } from 'lucide-react'
import { SyncStatusBadge } from '@/components/ui/Badge'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { syncPendingItems } from '@/services/syncService'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import type { Payment } from '@/models/types'

export default function CollectorSyncPage() {
  const { user } = useAuth()
  const isOnline = useOnlineStatus()
  const [pendingPayments, setPendingPayments] = useState<Payment[]>([])
  const [syncing, setSyncing] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadPending() }, [user])

  async function loadPending() {
    if (!user?.routeId) { setLoading(false); return }
    const pending = await db.payments.where('routeId').equals(user.routeId).toArray()
    setPendingPayments(pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    setLoading(false)
  }

  async function handleSync() {
    if (!isOnline) { toast.warning('Sin conexión, no se puede sincronizar'); return }
    setSyncing(true)
    const { synced, errors } = await syncPendingItems()
    toast.success(`${synced} item(s) sincronizados${errors > 0 ? `, ${errors} error(es)` : ''}`)
    await loadPending()
    setSyncing(false)
  }

  const pendingCount = pendingPayments.filter(p => p.syncStatus === 'pending').length
  const syncedCount = pendingPayments.filter(p => p.syncStatus === 'synced').length

  return (
    <div className="p-4 space-y-4">
      {/* Status card */}
      <div className={`rounded-2xl p-4 text-white ${isOnline ? 'bg-emerald-600' : 'bg-gray-600'}`}>
        <div className="flex items-center gap-2 mb-2">
          {isOnline ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5" />}
          <p className="font-bold">{isOnline ? 'Conectado' : 'Sin conexión'}</p>
        </div>
        <p className="text-sm opacity-80">{pendingCount} pago(s) pendiente(s) de sync</p>
      </div>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={syncing || !isOnline}
        className="w-full h-14 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2"
      >
        <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Sincronizando...' : 'Sincronizar ahora'}
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
          <p className="text-xs text-gray-500">Sincronizados</p>
        </div>
      </div>

      {/* Payments list */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historial de pagos</p>
        {loading ? (
          <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
        ) : pendingPayments.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">No hay pagos registrados</div>
        ) : (
          <div className="space-y-2">
            {pendingPayments.slice(0, 20).map(p => (
              <div key={p.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">{formatCurrency(p.valor)}</p>
                  <p className="text-xs text-gray-400">{formatDateTime(p.createdAt)}</p>
                </div>
                <SyncStatusBadge status={p.syncStatus} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
