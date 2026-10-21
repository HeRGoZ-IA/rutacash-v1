// ADEX Online: COPIA de CollectorSyncPage (CLEAN). Cambios, marcados:
//   · el aviso de límite decía que los datos se guardan en este dispositivo; para el Supervisor,
//     cada registro se confirma en el servidor al hacerlo, y así se dice;
//   · Ronda 62: para el COBRADOR esta pantalla es «Pendientes» del modo sin conexión: qué está
//     guardado solo en este dispositivo, qué se está enviando, qué confirmó el servidor y qué
//     necesita revisión (con su motivo), con «Sincronizar ahora», «Reintentar» y «Ya lo revisé».
//     Nada se borra desde aquí: lo revisado deja de avisar, pero queda en el dispositivo.
import { useState, useEffect, useMemo } from 'react'
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
// ADEX Online (Ronda 62).
import { markReviewed, retry, summary, useOffline } from '../../../offline/state.ts'
import { syncNow } from '../../../offline/sync.ts'
import { PendingOpRow, useReachable } from '../../../offline/ui.tsx'

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
  // ADEX Online (Ronda 62): el Cobrador ve sus operaciones del modo sin conexión.
  return user?.rol === 'cobrador' ? <OfflinePendingPage /> : <SupervisorSyncPage />
}

/** ADEX Online (Ronda 62): «Pendientes» del Cobrador. */
function OfflinePendingPage() {
  const reachable = useReachable()
  const enabled = useOffline((st) => st.enabled)
  const unavailable = useOffline((st) => st.unavailable)
  const ops = useOffline((st) => st.ops)
  const unreadable = useOffline((st) => st.unreadable)
  const syncing = useOffline((st) => st.syncing)
  const lastSyncAt = useOffline((st) => st.lastSyncAt)
  const savedAt = useOffline((st) => st.dataSavedAt)
  const { pending, attention } = summary(ops)
  const [showReviewed, setShowReviewed] = useState(false)
  // Nombres de cliente con la copia de consulta (los abonos enviados en línea sin respuesta no lo traen).
  const [names, setNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let alive = true
    db.clients.toArray().then(cs => { if (alive) setNames(new Map(cs.map(c => [c.id, c.nombre]))) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const groups = useMemo(() => {
    const byNewest = [...ops].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    return {
      attention: byNewest.filter(o => (o.status === 'review' || o.status === 'rejected') && !o.reviewedAt),
      pending: byNewest.filter(o => o.status === 'local' || o.status === 'sending'),
      confirmed: byNewest.filter(o => o.status === 'confirmed').slice(0, 30),
      reviewed: byNewest.filter(o => o.reviewedAt && o.status !== 'confirmed'),
    }
  }, [ops])
  const nameOf = (o: (typeof ops)[number]) => o.ref.clientName ?? (o.ref.clientId ? names.get(o.ref.clientId) : undefined)

  async function handleSync() {
    if (!reachable) { toast.warning('Sin conexión: se enviará solo cuando vuelva internet.'); return }
    await syncNow()
    const after = summary(useOffline.getState().ops)
    if (after.pending > 0) toast.warning('No se pudo enviar todo todavía. Se seguirá intentando.')
    else if (after.attention > 0) toast.warning('Hay operaciones que requieren revisión.')
    else toast.success('Todo está confirmado por el servidor.')
  }

  return (
    <div className="p-4 space-y-4" data-testid="offline-pending-page">
      <div className={`rounded-2xl p-4 text-white ${reachable ? 'bg-emerald-600' : 'bg-gray-600'}`}>
        <div className="flex items-center gap-2 mb-2">
          {reachable ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5" />}
          <p className="font-bold">{reachable ? 'En línea' : 'Sin conexión'}</p>
        </div>
        <p className="text-sm opacity-90" data-testid="offline-pending-summary">
          {pending === 0 && attention === 0 ? 'No hay operaciones pendientes en este dispositivo.'
            : `${pending} por sincronizar${attention > 0 ? ` · ${attention} requiere${attention === 1 ? '' : 'n'} revisión` : ''}`}
        </p>
        {lastSyncAt && <p className="text-xs opacity-75 mt-1">Última sincronización: {formatDateTime(lastSyncAt)}</p>}
        {savedAt && <p className="text-xs opacity-75">Datos de la ruta guardados el {formatDateTime(savedAt)}</p>}
      </div>

      {!enabled && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2">
          <Info className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800">{unavailable ?? 'El modo sin conexión no está disponible en este dispositivo.'}</p>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-xl bg-primary-50 border border-primary-100 px-3 py-2">
        <Info className="w-3.5 h-3.5 text-primary-600 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-primary-900">
          Lo guardado sin conexión está solo en este dispositivo hasta que el servidor lo confirme. Si se borran los datos de la aplicación o el
          dispositivo falla antes de sincronizar, puede perderse. Con internet se envía solo.
        </p>
      </div>

      {unreadable > 0 && (
        <p className="text-xs text-red-700">Hay {unreadable} registro(s) que este dispositivo no puede leer. Se conservan; avise a la oficina.</p>
      )}

      <button onClick={() => void handleSync()} disabled={syncing || !enabled} data-testid="offline-sync-now"
        className="w-full h-14 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white rounded-2xl text-base font-bold flex items-center justify-center gap-2">
        <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
      </button>

      {groups.attention.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide">Requieren revisión</p>
          {groups.attention.map(o => (
            <PendingOpRow key={o.id} op={o} name={nameOf(o)}
              onRetry={o.status === 'review' ? () => { void retry(o.id).then(() => syncNow()) } : undefined}
              onReviewed={() => { void markReviewed(o.id).then(() => syncNow()) }} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Por sincronizar</p>
        {groups.pending.length === 0
          ? <p className="text-sm text-gray-400 text-center py-4">Nada pendiente.</p>
          : groups.pending.map(o => <PendingOpRow key={o.id} op={o} name={nameOf(o)} />)}
      </section>

      {groups.confirmed.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Confirmadas por el servidor</p>
          {groups.confirmed.map(o => <PendingOpRow key={o.id} op={o} name={nameOf(o)} />)}
        </section>
      )}

      {groups.reviewed.length > 0 && (
        <section className="space-y-2">
          <button type="button" onClick={() => setShowReviewed(v => !v)} className="text-xs font-medium text-gray-500 underline">
            {showReviewed ? 'Ocultar' : 'Ver'} revisadas ({groups.reviewed.length})
          </button>
          {showReviewed && groups.reviewed.map(o => <PendingOpRow key={o.id} op={o} name={nameOf(o)} />)}
        </section>
      )}
    </div>
  )
}

/** Vista original (Supervisor): historial de abonos de la ruta activa. */
function SupervisorSyncPage() {
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
          {/* ADEX Online: los registros se confirman en el servidor (CLEAN: «se guardan en este dispositivo»). */}
          Cada abono, gasto o visita <span className="font-semibold">se confirma en el servidor al registrarlo</span> y
          se ve en todos los equipos. Nada queda pendiente en este dispositivo.
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
                    <p className="text-xs text-gray-500">{formatDateTime(r.payment.createdAt)}</p>
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
