import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { History } from 'lucide-react'
import { Select } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { useDataRevision } from '@/hooks/useDataRevision'
import { effectivePayments, paymentDisplayStateOf, paymentHistoryRows } from '@/lib/paymentState'
import { compareByCreation } from '@/lib/eventOrder'
import { PaymentAnnulmentDetail, PaymentStateBadge } from '@/components/ui/PaymentAnnulment'
import { formatCurrency, formatDate } from '@/lib/formatters'
import type { Client, Sale, Payment } from '@/models/types'

/**
 * Histórico de abonos por cliente/venta. Sirve para revisar diferencias cuando
 * un cliente dice que pagó y el sistema muestra algo distinto.
 * Nota: los abonos no guardan la parcela exacta afectada (el motor distribuye el
 * pago entre parcelas), por eso esa columna no se muestra en V1.
 *
 * ALCANCE — RUTA ACTIVA (corregido en Fase 0):
 * Esta pantalla usaba TODAS las rutas autorizadas del usuario, así que un cobrador
 * con Ruta A y Ruta B veía clientes de ambas mientras trabajaba solo en A. Era la
 * única pantalla operativa con acceso a datos que ignoraba `activeRouteId`.
 * Ahora clientes, ventas y abonos se recortan por la RUTA ACTIVA, igual que el
 * resto de la app operativa.
 *
 * SEMÁNTICA DE PAGOS: cuentan solo los abonos VIGENTES (`effectivePayments`). Un
 * pago corregido aparecía tres veces —original, reversión negativa y corrección—,
 * que es el detalle contable, no el histórico que el cobrador necesita para hablar
 * con el cliente. Un pago ANULADO por la administración (punto 7, 2026-10-03) sí se
 * lista, tachado y con su motivo, para que el cobrador sepa por qué ya no cuenta;
 * nunca suma al total. El asiento técnico de reversión no se muestra.
 */
export default function CollectorPaymentHistoryPage() {
  const { saleId: paramSaleId } = useParams<{ saleId?: string }>()
  const { user } = useAuth()
  const { currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const [clients, setClients] = useState<Client[]>([])
  const [sales, setSales] = useState<Sale[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [clientId, setClientId] = useState('')
  const [saleId, setSaleId] = useState('')
  const [loading, setLoading] = useState(true)

  const routeId = activeRouteId ?? user?.routeId ?? null

  useEffect(() => { init() }, [user, routeId])

  // Una anulación (o un pago) hecha en otra pestaña relee la venta abierta: saldo y
  // abonos no pueden quedarse con la foto tomada al seleccionarla.
  const revision = useDataRevision()
  useEffect(() => {
    if (revision === 0 || !clientId) return
    loadSalesOfClient(clientId).then(setSales)
    if (saleId) loadPayments(saleId)
  }, [revision])  // eslint-disable-line react-hooks/exhaustive-deps

  /** Ventas de un cliente DENTRO de la ruta activa, más recientes primero. */
  async function loadSalesOfClient(clientId: string): Promise<Sale[]> {
    if (!routeId) return []
    const cs = await db.sales.where('clientId').equals(clientId).toArray()
    return cs
      .filter(s => s.routeId === routeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async function init() {
    setClientId(''); setSaleId(''); setSales([]); setPayments([])
    if (!user || !routeId) { setClients([]); setLoading(false); return }
    setLoading(true)
    const allClients = await db.clients.where('tenantId').equals(user.tenantId).toArray()
    // Solo los clientes de la RUTA ACTIVA, no de todas las rutas autorizadas.
    setClients(allClients.filter(c => c.routeId === routeId))

    // Si viene un saleId en la URL, preselecciona cliente + venta — pero solo si
    // esa venta pertenece a la ruta activa: un enlace no amplía el alcance.
    if (paramSaleId) {
      const sale = await db.sales.get(paramSaleId)
      if (sale && sale.routeId === routeId) {
        setClientId(sale.clientId)
        setSales(await loadSalesOfClient(sale.clientId))
        setSaleId(sale.id)
        await loadPayments(sale.id)
      }
    }
    setLoading(false)
  }

  async function onSelectClient(id: string) {
    setClientId(id); setSaleId(''); setPayments([])
    if (!id) { setSales([]); return }
    setSales(await loadSalesOfClient(id))
  }

  async function onSelectSale(id: string) {
    setSaleId(id)
    if (id) await loadPayments(id); else setPayments([])
  }

  async function loadPayments(sid: string) {
    const ps = await db.payments.where('saleId').equals(sid).toArray()
    // Abonos VIGENTES (un pago corregido no aparece tres veces) + los ANULADOS con
    // su asiento de reversión, que `paymentHistoryRows` adjunta y nunca lista como fila.
    const anulados = ps.filter(p => { const e = paymentDisplayStateOf(p); return e === 'anulado' || e === 'reversion' })
    setPayments([...effectivePayments(ps), ...anulados].sort(compareByCreation))
  }

  const selectedSale = sales.find(s => s.id === saleId)
  const totalAbonado = effectivePayments(payments).reduce((s, p) => s + p.valor, 0)
  const filas = paymentHistoryRows(payments)

  const saleLabel = (s: Sale) => `${formatCurrency(s.valorVenta, currency)} · ${formatDate(s.fechaInicio)} · ${s.status}`

  if (loading) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Histórico de abonos</h1>
        <p className="text-xs text-gray-500">Abonos registrados por venta</p>
      </div>

      <Select label="Cliente" value={clientId} onChange={e => onSelectClient(e.target.value)}
        options={clients.map(c => ({ value: c.id, label: `${c.nombre} - ${c.documento}` }))} placeholder="Seleccionar cliente" />

      {clientId && (
        <Select label="Venta" value={saleId} onChange={e => onSelectSale(e.target.value)}
          options={sales.map(s => ({ value: s.id, label: saleLabel(s) }))} placeholder="Seleccionar venta" />
      )}

      {selectedSale && (
        <div className="bg-primary-50 rounded-xl p-4 grid grid-cols-3 gap-2">
          <div><p className="text-xs text-gray-500">Saldo</p><p className="font-bold text-amber-600">{formatCurrency(selectedSale.saldo, currency)}</p></div>
          <div><p className="text-xs text-gray-500">Parcela</p><p className="font-bold text-primary-700">{formatCurrency(selectedSale.valorCuota, currency)}</p></div>
          <div><p className="text-xs text-gray-500">Total abonado</p><p className="font-bold text-emerald-600">{formatCurrency(totalAbonado, currency)}</p></div>
        </div>
      )}

      {saleId && (
        filas.length === 0 ? (
          <EmptyState icon={<History className="w-8 h-8" />} title="Sin abonos registrados" />
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
            {filas.map(({ payment: p, reversal }) => {
              const anulado = paymentDisplayStateOf(p) === 'anulado'
              return (
                <div key={p.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-800">{formatDate(p.fecha)}</p>
                    <div className="flex items-center gap-2">
                      <PaymentStateBadge state={paymentDisplayStateOf(p)} />
                      <span className={`text-sm font-bold ${anulado ? 'text-gray-400 line-through' : 'text-emerald-600'}`}>+{formatCurrency(p.valor, currency)}</span>
                    </div>
                  </div>
                  {p.observacion && <p className="text-xs text-gray-400 mt-0.5">{p.observacion}</p>}
                  {anulado && <PaymentAnnulmentDetail original={p} reversal={reversal} currency={currency} />}
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
