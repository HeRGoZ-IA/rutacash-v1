// ADEX Online: COPIA de CollectorRoutePage (CLEAN). Únicos cambios, marcados «ADEX Online»:
// en CLEAN los datos son locales y la carga es instantánea; aquí vienen del servidor y tardan,
// así que (1) los contadores muestran «—» mientras no hay datos (nunca un 0 provisional),
// (2) un fallo de consulta se dice y se puede reintentar (antes quedaba cargando sin aviso) y
// (3) una respuesta de una carga anterior no pisa a la más reciente. Lista y reglas, originales.
// Ronda 62: (4) las visitas sin pago del día (del servidor) se ven en la tarjeta («Visitado hoy»):
// antes se registraban pero ninguna pantalla las mostraba; (5) MODO SIN CONEXIÓN: los clientes con
// abonos o visitas guardados en el dispositivo llevan «Pendiente de sincronizar»; los saldos NO se
// alteran (son los últimos del servidor) y esas operaciones no cuentan como «Abonados».
import { useState, useEffect, useRef, useMemo } from 'react'
import { Search, CheckCircle, XCircle, Eye } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useOpBase } from '@/hooks/useOpBase'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { PaymentDaysBadges } from '@/components/ui/PaymentDaysBadges'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useDataRevision } from '@/hooks/useDataRevision'
import { effectivePayments } from '@/lib/paymentState'
import { compareByCreation } from '@/lib/eventOrder'
import { formatCurrency, formatDate, today } from '@/lib/formatters'
import { formatClientName } from '@/lib/displayName'
import {
  calculateCurrentInstallment, getLastPaidInstallmentNumber, isSaleDueToday, isSaleDisbursed,
  getCollectionStatus, countOverdueInstallments, getMaxOverdueDays,
  type CollectionStatus,
} from '@/services/installmentEngine'
import type { Sale, Client, Installment } from '@/models/types'
// ADEX Online (Ronda 62).
import { isOpen, useOffline, type PendingOp } from '../../../offline/state.ts'
import { toMajor } from '../../../runtime/mappers.ts'

interface RouteItem {
  sale: Sale
  client: Client
  currentInstallment: Installment | null
  /** Número de la última parcela pagada (avance para el listado). */
  lastPaidNumber: number
  paidToday: boolean
  /** ADEX Online (Ronda 62): visita sin pago registrada hoy en el servidor. */
  visitedToday: boolean
  dueToday: boolean
  estado: CollectionStatus
  atrasadas: number
  diasAtraso: number
  ultimoAbono?: string
}

// Estilos por estado de cobro (verde/amarillo/rojo)
const ESTADO_STYLE: Record<CollectionStatus, { border: string; dot: string; label: string; badge: 'success' | 'warning' | 'danger' }> = {
  verde: { border: 'border-emerald-200', dot: 'bg-emerald-500', label: 'Al día', badge: 'success' },
  amarillo: { border: 'border-amber-200', dot: 'bg-amber-500', label: 'Atraso leve', badge: 'warning' },
  rojo: { border: 'border-red-200', dot: 'bg-red-500', label: 'Atraso fuerte', badge: 'danger' },
}

export default function CollectorRoutePage() {
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const navigate = useNavigate()
  const base = useOpBase()
  const [items, setItems] = useState<RouteItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  // ADEX Online: error de consulta y orden de cargas (solo se aplica la última).
  const [failed, setFailed] = useState(false)
  const loadSeq = useRef(0)
  // ADEX Online (Ronda 62): operaciones guardadas en el dispositivo, por crédito.
  const offlineOps = useOffline((st) => st.ops)
  const pendingBySale = useMemo(() => {
    const m = new Map<string, PendingOp[]>()
    for (const o of offlineOps) if (o.ref.saleId && isOpen(o)) m.set(o.ref.saleId, [...(m.get(o.ref.saleId) ?? []), o])
    return m
  }, [offlineOps])

  const routeId = activeRouteId ?? user?.routeId ?? null

  // Un pago registrado o ANULADO en otra pestaña cambia saldo, parcela y "pagó hoy".
  const revision = useDataRevision()
  useEffect(() => { load() }, [user, routeId, revision])

  async function load() {
    if (!routeId || !user) { setLoading(false); return }
    const seq = ++loadSeq.current
    setLoading(true)
    setFailed(false)
    try {
    // Solo ventas activas Y desembolsadas (las no desembolsadas no se cobran)
    const allSales = await db.sales.where('routeId').equals(routeId).and(s => s.status === 'activa').toArray()
    const sales = allSales.filter(isSaleDisbursed)
    const clients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    const clientMap = new Map(clients.map(c => [c.id, c]))
    // Solo pagos VIGENTES: un pago anulado (y su asiento de reversión, que lleva la
    // misma fecha) no puede marcar la venta como "pagó hoy" ni como último abono.
    const routePayments = effectivePayments(await db.payments.where('routeId').equals(routeId).toArray())
    const todayStr = today()
    const paidToday = new Set(routePayments.filter(p => p.fecha === todayStr).map(p => p.saleId))
    // ADEX Online (Ronda 62): visitas sin pago de hoy (servidor). Sin permiso de historial, ninguna.
    const visitedToday = new Set((await db.noPaymentVisits.where('routeId').equals(routeId).toArray().catch(() => []))
      .filter(v => v.fecha === todayStr).map(v => v.saleId))
    // Último abono VIGENTE por venta (orden createdAt + id; antes se comparaba el
    // createdAt de un pago con la `fecha` guardada del anterior).
    const lastPaymentBySale = new Map<string, string>()
    for (const p of [...routePayments].sort(compareByCreation)) lastPaymentBySale.set(p.saleId, p.fecha)

    const now = new Date()
    const result: RouteItem[] = []
    for (const sale of sales) {
      const client = clientMap.get(sale.clientId)
      if (!client) continue
      const insts = await db.installments.where('saleId').equals(sale.id).toArray()
      result.push({
        sale, client,
        currentInstallment: calculateCurrentInstallment(insts),
        lastPaidNumber: getLastPaidInstallmentNumber(insts),
        paidToday: paidToday.has(sale.id),
        visitedToday: visitedToday.has(sale.id),
        dueToday: isSaleDueToday(sale.paymentDays, insts, now, todayStr),
        estado: getCollectionStatus(insts, now),
        atrasadas: countOverdueInstallments(insts, todayStr),
        diasAtraso: getMaxOverdueDays(insts, now),
        ultimoAbono: lastPaymentBySale.get(sale.id),
      })
    }
    result.sort((a, b) => rank(a) - rank(b))
    if (seq !== loadSeq.current) return
    setItems(result)
    setLoading(false)
    } catch {
      // ADEX Online: sin datos del servidor no se muestra ninguna cifra.
      if (seq !== loadSeq.current) return
      setFailed(true)
      setLoading(false)
    }
  }

  function rank(i: RouteItem): number {
    if (i.paidToday) return 2
    return i.dueToday ? 0 : 1
  }

  const filtered = items.filter(item => {
    const q = search.toLowerCase()
    return !q || item.client.nombre.toLowerCase().includes(q) || item.client.documento.includes(q)
  })

  // ADEX Online: «—» mientras no hay datos confirmados del servidor.
  const sinDatos = loading || failed
  const pendientes = filtered.filter(i => !i.paidToday && i.dueToday).length
  const cobrados = filtered.filter(i => i.paidToday).length
  const noProgramados = filtered.filter(i => !i.paidToday && !i.dueToday).length
  // ADEX Online (Ronda 62): clientes con operaciones aún sin confirmar en este dispositivo.
  const enDispositivo = filtered.filter(i => pendingBySale.has(i.sale.id)).length

  if (!routeId) {
    return <div className="p-4"><EmptyState title="Selecciona una ruta" description="Vuelve al inicio y elige una ruta para trabajar." /></div>
  }

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="bg-primary-700 px-4 py-3 flex gap-4">
        <div className="text-center">
          <p className="text-white font-bold text-lg">{sinDatos ? '—' : pendientes}</p>
          <p className="text-primary-200 text-xs">Pendientes</p>
        </div>
        <div className="w-px bg-primary-600" />
        <div className="text-center">
          <p className="text-emerald-300 font-bold text-lg">{sinDatos ? '—' : cobrados}</p>
          <p className="text-primary-200 text-xs">Abonados</p>
        </div>
        {!sinDatos && enDispositivo > 0 && (
          <>
            <div className="w-px bg-primary-600" />
            <div className="text-center" data-testid="route-pending-count">
              <p className="text-amber-300 font-bold text-lg">{enDispositivo}</p>
              <p className="text-primary-200 text-xs">Sin sincronizar</p>
            </div>
          </>
        )}
        {!sinDatos && noProgramados > 0 && (
          <>
            <div className="w-px bg-primary-600" />
            <div className="text-center">
              <p className="text-primary-100 font-bold text-lg">{noProgramados}</p>
              <p className="text-primary-200 text-xs">No hoy</p>
            </div>
          </>
        )}
      </div>

      {/* Search */}
      <div className="px-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente..."
            className="w-full h-10 rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : failed ? (
        <EmptyState title="No se pudo consultar el servidor" description="Los datos de la ruta no se cargaron. Compruebe la conexión e inténtelo de nuevo."
          action={<button onClick={() => load()} className="h-10 px-4 rounded-xl bg-primary-600 text-white text-sm font-medium">Reintentar</button>} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No hay clientes para cobrar" description="No hay ventas activas desembolsadas en esta ruta." />
      ) : (
        <div className="px-4 space-y-2.5">
          {filtered.map(item => (
            <ClientCard key={item.sale.id} item={item} currency={currency} pending={pendingBySale.get(item.sale.id) ?? []}
              onPayment={() => navigate(`${base}/payment/${item.sale.id}`)}
              onNoPayment={() => navigate(`${base}/no-payment/${item.sale.id}`)}
              onView={() => navigate(`${base}/client/${item.client.id}?saleId=${item.sale.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ item, currency, pending, onPayment, onNoPayment, onView }: {
  item: RouteItem
  currency: string
  /** ADEX Online (Ronda 62): operaciones de este crédito guardadas en el dispositivo. */
  pending: PendingOp[]
  onPayment: () => void
  onNoPayment: () => void
  onView: () => void
}) {
  const { sale, client, currentInstallment, lastPaidNumber, paidToday, visitedToday, dueToday, estado, atrasadas, diasAtraso, ultimoAbono } = item
  const pendingPay = pending.filter(o => o.kind === 'payment').reduce((t, o) => t + (o.ref.amountMinor ?? 0), 0)
  const pendingVisit = pending.some(o => o.kind === 'visit')
  const notScheduled = !paidToday && !dueToday
  const st = ESTADO_STYLE[estado]

  return (
    <div className={`bg-white rounded-2xl border shadow-card overflow-hidden ${paidToday ? 'opacity-60 border-gray-100' : notScheduled ? 'opacity-80 border-gray-100' : st.border}`}>
      <div className="px-4 py-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.dot}`} />
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">{formatClientName(client.nombre)}</p>
              <p className="text-xs text-gray-500">{client.documento}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {paidToday ? <Badge variant="success" size="sm">Abonado</Badge> : <Badge variant={st.badge} size="sm">{st.label}</Badge>}
            {notScheduled && !paidToday && <span className="text-[10px] text-gray-400">Hoy no programado</span>}
            {/* ADEX Online (Ronda 62) */}
            {visitedToday && !paidToday && <span className="text-[10px] font-medium text-red-500" data-testid="visited-today">Visitado hoy · no pagó</span>}
            {pending.length > 0 && (
              <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5" data-testid="pending-sync">
                {pendingPay > 0 ? `Abono ${formatCurrency(toMajor(pendingPay), currency)} sin sincronizar` : pendingVisit ? 'Visita sin sincronizar' : 'Sin sincronizar'}
              </span>
            )}
          </div>
        </div>

        {notScheduled && atrasadas === 0 && (
          <div className="flex items-center flex-wrap gap-1.5 text-xs text-gray-500 mb-2">
            <span>Días de cobro:</span> <PaymentDaysBadges days={sale.paymentDays} size="sm" />
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 mb-2">
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-500">Saldo</p>
            <p className="text-sm font-bold text-amber-600">{formatCurrency(sale.saldo, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-500">Parcela</p>
            <p className="text-sm font-bold text-primary-600">{formatCurrency(currentInstallment?.valor ?? sale.valorCuota, currency)}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-2 text-center">
            <p className="text-xs text-gray-500">Parcelas</p>
            <p className="text-sm font-bold text-gray-700">{lastPaidNumber}/{sale.numeroCuotas}</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
          <span>Último abono: {ultimoAbono ? formatDate(ultimoAbono) : '—'}</span>
          {atrasadas > 0 && <span className="text-red-500 font-medium">{atrasadas} parcela(s) atrasada(s) · {diasAtraso}d</span>}
        </div>

        {!paidToday ? (
          <div className="flex gap-2">
            <button onClick={onPayment} className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-sm font-medium">
              <CheckCircle className="w-4 h-4" /> Abonar
            </button>
            <button onClick={onNoPayment} className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl py-2.5 text-sm font-medium border border-red-100">
              <XCircle className="w-4 h-4" /> No pagó
            </button>
            <button onClick={onView} className="w-10 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-xl text-gray-500">
              <Eye className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button onClick={onView} className="w-full flex items-center justify-center gap-2 bg-gray-100 text-gray-500 rounded-xl py-2.5 text-sm">
            <Eye className="w-4 h-4" /> Ver detalle
          </button>
        )}
      </div>
    </div>
  )
}
