// ADEX Online: COPIA de src/pages/collector/CollectorDisbursementsPage.tsx (CLEAN). Pantalla y textos originales.
// Ronda 65, marcado con «ADEX Online (Ronda 65)»: el Cobrador entrega el dinero de una venta aprobada
// también SIN CONEXIÓN, con el efectivo que tiene en custodia (cifra del servidor menos lo que ya
// entregó o gastó después). Solo lo aprobado que el dispositivo conoce desde su última sincronización. Lo entregado sin conexión se muestra «Guardado solo en este
// dispositivo» hasta que el servidor lo confirme, y no se puede volver a confirmar.
import { useState, useEffect } from 'react'
import { Banknote, CheckCircle, Smartphone } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { formatClientName } from '@/lib/displayName'
import { confirmDisbursement, SaleRuleError } from '@/services/saleRequestService'
import type { Sale, Client } from '@/models/types'
// ADEX Online (Ronda 65): entrega sin conexión con el efectivo en custodia.
import { disburseAsCollector, disbursementState } from '../../../offline/sales.ts'
import { availableCash, type Availability } from '../../../offline/custody.ts'
import { useOffline } from '../../../offline/state.ts'
import { OpStatusBadge, useReachable } from '../../../offline/ui.tsx'
import { formatDateTime } from '@/lib/formatters'
import { toMajor } from '../../../runtime/mappers.ts'

export default function CollectorDisbursementsPage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [sales, setSales] = useState<Sale[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [loading, setLoading] = useState(true)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // ADEX Online (Ronda 65): modo sin conexión del Cobrador y su efectivo disponible.
  const offlineMode = useOffline((st) => st.enabled) && user?.rol === 'cobrador'
  const ops = useOffline((st) => st.ops)
  const reachable = useReachable()
  const custodyAt = useOffline((st) => st.custodyAt)
  const [cash, setCash] = useState<Availability | null>(null)
  useEffect(() => {
    let alive = true
    if (!offlineMode || !activeRouteId) { setCash(null); return }
    availableCash(activeRouteId).then(c => { if (alive) setCash(c) }).catch(() => {})
    return () => { alive = false }
  }, [offlineMode, activeRouteId, ops, reachable, custodyAt])

  useEffect(() => { load() }, [user, activeRouteId])

  async function load() {
    if (!user || !activeRouteId) { setSales([]); setLoading(false); return }
    setLoading(true)
    // Ventas aprobadas pendientes por desembolsar de la RUTA ACTIVA (coincide con el badge)
    const all = await db.sales.where('routeId').equals(activeRouteId).toArray()
    const pending = all.filter(s => s.status === 'activa' && s.disbursementStatus === 'pendiente')
    pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setSales(pending)
    setLoading(false)
  }

  async function handleConfirm(sale: Sale) {
    if (!user) return
    setConfirmingId(sale.id)
    try {
      // ADEX Online (Ronda 65): el Cobrador entrega con su efectivo (en línea o sin conexión).
      if (offlineMode) {
        const r = await disburseAsCollector(sale.id)
        if (r.kind === 'confirmed') toast.success('Desembolso confirmado. La venta ya está activa para recaudo.')
        else if (r.kind === 'saved') toast.success('Sin conexión: el desembolso quedó guardado en este dispositivo y se enviará al recuperar internet. Aún no está confirmado.')
        else toast.warning('No hubo respuesta del servidor: el desembolso quedó guardado en este dispositivo y se comprobará sin duplicarse. No entregue el dinero otra vez.')
        await load()
        return
      }
      await confirmDisbursement(sale.id, user)
      toast.success('Desembolso confirmado. La venta ya está activa para recaudo.')
      await load()
    } catch (e) {
      // Ya desembolsada (otra pestaña u otro trabajador) o en un estado que no lo
      // admite: el servicio no escribió nada; se muestra su motivo y se recarga.
      // ADEX Online (Ronda 65): + los motivos del modo sin conexión (efectivo, ya guardado…).
      toast.error(e instanceof SaleRuleError || (e as Error)?.name === 'OfflineRuleError' ? (e as Error).message : 'Error al confirmar el desembolso')
      await load()
    } finally { setConfirmingId(null) }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Desembolsos</h1>
        <p className="text-xs text-gray-500">Ventas aprobadas pendientes por desembolsar</p>
      </div>

      {/* ADEX Online (Ronda 65-C1): sin conexión solo se ve lo aprobado que el dispositivo ya conocía. */}
      {offlineMode && !reachable && (
        <p className="text-xs text-gray-600 rounded-xl bg-gray-50 border border-gray-200 px-3 py-2" data-testid="offline-approvals-note">
          Sin conexión solo aparecen las ventas aprobadas que este dispositivo conocía en su última sincronización. Si la oficina aprobó otra mientras estabas sin internet, conéctate para actualizarla.
        </p>
      )}
      {/* ADEX Online (Ronda 65): efectivo con el que puede entregar, según el dispositivo. */}
      {offlineMode && cash && (
        <div className="rounded-2xl border border-gray-200 bg-white p-3" data-testid="offline-cash">
          {cash.availableMinor === null
            ? <p className="text-xs text-amber-700">Para entregar dinero sin conexión, conéctate a internet una vez para conocer tu efectivo.</p>
            : <>
                <p className="text-xs text-gray-500">Efectivo disponible para entregar</p>
                <p className="text-lg font-bold text-gray-900 tabular-nums" data-testid="offline-cash-amount">{formatCurrency(toMajor(Math.max(0, cash.availableMinor)), currency)}</p>
                <p className="text-[11px] text-gray-500">
                  Según el servidor el {formatDateTime(cash.savedAt!)}
                  {cash.pendingOutMinor > 0 ? ` · − ${formatCurrency(toMajor(cash.pendingOutMinor), currency)} entregado o gastado después` : ''}
                  {cash.pendingInMinor > 0 ? ` · + ${formatCurrency(toMajor(cash.pendingInMinor), currency)} cobrado sin sincronizar` : ''}
                </p>
              </>}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : sales.length === 0 ? (
        <EmptyState icon={<Banknote className="w-8 h-8" />} title="No hay desembolsos pendientes" description="Cuando el administrador apruebe una solicitud, aparecerá aquí." />
      ) : (
        <div className="space-y-2.5">
          {sales.map(s => {
            const client = clientMap.get(s.clientId)
            // ADEX Online (Ronda 65): desembolso ya registrado en este dispositivo (no se repite).
            const local = offlineMode ? disbursementState(s.id) : null
            return (
              <div key={s.id} className="bg-white rounded-2xl border border-amber-200 shadow-card p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{formatClientName(client?.nombre) || 'Cliente'}</p>
                    <p className="text-xs text-gray-500">{client?.documento} · Inicio {formatDate(s.fechaInicio)}</p>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Por desembolsar</span>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-500">Valor</p>
                    <p className="text-sm font-bold text-gray-800">{formatCurrency(s.valorVenta, currency)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-500">Parcela</p>
                    <p className="text-sm font-bold text-primary-600">{formatCurrency(s.valorCuota, currency)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-2 text-center">
                    <p className="text-xs text-gray-500">Parcelas</p>
                    <p className="text-sm font-bold text-gray-700">{s.numeroCuotas}</p>
                  </div>
                </div>
                {local && (
                  <div className="mb-3 flex items-center justify-between gap-2 flex-wrap" data-testid="disbursement-local">
                    <span className="inline-flex items-center gap-1 text-xs text-gray-600"><Smartphone className="w-3.5 h-3.5" /> Dinero entregado {formatDateTime(local.capturedAt)}</span>
                    <OpStatusBadge status={local.status} />
                    {local.error && local.status !== 'confirmed' && <p className="w-full text-xs text-orange-700">{local.error.message}</p>}
                  </div>
                )}
                {!local && <button
                  onClick={() => handleConfirm(s)}
                  disabled={confirmingId === s.id}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium flex items-center justify-center gap-2"
                >
                  {confirmingId === s.id ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  Confirmar desembolso
                </button>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
