import { useState, useEffect } from 'react'
import { ClipboardCheck, CheckCircle, XCircle, Eye, AlertTriangle, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select, Textarea } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { PaymentDaysBadges } from '@/components/ui/PaymentDaysBadges'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { approveSaleRequest, rejectSaleRequest } from '@/services/saleRequestService'
import { logAction } from '@/services/auditService'
import type { SaleRequest, Client, Route, User, Sale, SaleRequestStatus } from '@/models/types'

const STATUS_META: Record<SaleRequestStatus, { label: string; variant: 'warning' | 'success' | 'danger' | 'info' | 'gray' }> = {
  pending: { label: 'Pendiente', variant: 'warning' },
  approved: { label: 'Aprobada', variant: 'info' },
  disbursed: { label: 'Desembolsada', variant: 'success' },
  rejected: { label: 'Rechazada', variant: 'danger' },
  cancelled: { label: 'Cancelada', variant: 'gray' },
}

const SALE_STATUS_LABEL: Record<string, string> = {
  activa: 'Activa', finalizada: 'Cerrada', perdida: 'Perdida', refinanciada: 'Refinanciada',
}

export default function SaleAuthorizationsPage() {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const [requests, setRequests] = useState<SaleRequest[]>([])
  const [clientMap, setClientMap] = useState<Map<string, Client>>(new Map())
  const [routeMap, setRouteMap] = useState<Map<string, Route>>(new Map())
  const [userMap, setUserMap] = useState<Map<string, User>>(new Map())
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<SaleRequestStatus | ''>('pending')

  const [detail, setDetail] = useState<SaleRequest | null>(null)
  const [clientSales, setClientSales] = useState<Sale[]>([])
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [working, setWorking] = useState(false)
  // Anti doble-clic para las acciones rápidas por fila.
  const [rowWorkingId, setRowWorkingId] = useState<string | null>(null)
  // Tooltip "Ver historial" (posición fija que sigue al cursor; evita el recorte
  // del contenedor con overflow de la tabla). Se oculta sobre Aprobar/Rechazar.
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => { load() }, [tenantId])

  async function load() {
    setLoading(true)
    const [reqs, clients, routes, users] = await Promise.all([
      db.saleRequests.where('tenantId').equals(tenantId).toArray(),
      db.clients.where('tenantId').equals(tenantId).toArray(),
      db.routes.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
    ])
    reqs.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    setRequests(reqs)
    setClientMap(new Map(clients.map(c => [c.id, c])))
    setRouteMap(new Map(routes.map(r => [r.id, r])))
    setUserMap(new Map(users.map(u => [u.id, u])))
    setLoading(false)
  }

  async function openDetail(req: SaleRequest, startRejecting = false) {
    setDetail(req)
    setRejecting(startRejecting)
    setRejectReason('')
    const sales = await db.sales.where('clientId').equals(req.clientId).toArray()
    setClientSales(sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }

  // Aprobación rápida desde la fila (mismo flujo que el modal, con anti doble-clic).
  async function handleApproveRow(req: SaleRequest) {
    if (!user || rowWorkingId) return
    setRowWorkingId(req.id)
    try {
      await approveSaleRequest(req, user.id)
      await logAction({ tenantId, userId: user.id, action: 'CREATE_SALE', entityType: 'SaleRequest', entityId: req.id, descripcion: `Solicitud de venta aprobada (${formatCurrency(req.amount, currency)})` })
      toast.success('Solicitud aprobada. Venta creada, pendiente de desembolso por el cobrador.')
      await load()
    } catch { toast.error('Error al aprobar la solicitud') } finally { setRowWorkingId(null) }
  }

  // Rechazo rápido: abre el modal directamente en modo "rechazar" para pedir el motivo.
  async function openRejectRow(req: SaleRequest) {
    await openDetail(req, true)
  }

  async function handleApprove() {
    if (!detail || !user) return
    setWorking(true)
    try {
      await approveSaleRequest(detail, user.id)
      await logAction({ tenantId, userId: user.id, action: 'CREATE_SALE', entityType: 'SaleRequest', entityId: detail.id, descripcion: `Solicitud de venta aprobada (${formatCurrency(detail.amount, currency)})` })
      toast.success('Solicitud aprobada. Venta creada, pendiente de desembolso por el cobrador.')
      setDetail(null)
      await load()
    } catch { toast.error('Error al aprobar la solicitud') } finally { setWorking(false) }
  }

  async function handleReject() {
    if (!detail || !user) return
    if (!rejectReason.trim()) { toast.error('Indica el motivo del rechazo'); return }
    setWorking(true)
    try {
      await rejectSaleRequest(detail, user.id, rejectReason.trim())
      await logAction({ tenantId, userId: user.id, action: 'UPDATE_SALE', entityType: 'SaleRequest', entityId: detail.id, descripcion: `Solicitud de venta rechazada: ${rejectReason.trim()}` })
      toast.success('Solicitud rechazada')
      setDetail(null)
      await load()
    } catch { toast.error('Error al rechazar la solicitud') } finally { setWorking(false) }
  }

  const filtered = filter ? requests.filter(r => r.status === filter) : requests
  const detailClient = detail ? clientMap.get(detail.clientId) : null

  // Resumen de historial de ventas del cliente (en el detalle) + indicadores
  // comparativos y advertencia de solicitud fuera de lo normal (Revisión 2).
  const history = (() => {
    const activas = clientSales.filter(s => s.status === 'activa')
    const cerradas = clientSales.filter(s => s.status === 'finalizada')
    const perdidas = clientSales.filter(s => s.status === 'perdida')

    // Historial previo: ventas del cliente distintas de la creada por ESTA solicitud.
    const prev = clientSales.filter(s => s.id !== detail?.saleId)
    const count = prev.length
    const promedio = count > 0 ? Math.round(prev.reduce((s, x) => s + x.valorVenta, 0) / count) : 0
    const mayor = count > 0 ? Math.max(...prev.map(s => s.valorVenta)) : 0
    const actual = detail?.amount ?? 0
    const difVsPromedio = actual - promedio
    const difVsMayor = actual - mayor

    // Nivel de advertencia (reglas simples, sin scoring).
    let warning: { level: 'info' | 'moderada' | 'fuerte'; message: string } | null = null
    if (count === 0) {
      warning = { level: 'info', message: 'Cliente sin historial previo.' }
    } else if (promedio > 0 && actual > promedio * 2) {
      warning = { level: 'fuerte', message: `La solicitud supera en más del 100% el promedio histórico (${formatCurrency(promedio, currency)}).` }
    } else if (promedio > 0 && actual > promedio * 1.5) {
      warning = { level: 'moderada', message: `La solicitud supera en más del 50% el promedio histórico (${formatCurrency(promedio, currency)}).` }
    }
    const superaMayor = count > 0 && actual > mayor

    return { activas, cerradas, perdidas, count, promedio, mayor, actual, difVsPromedio, difVsMayor, warning, superaMayor }
  })()

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Autorizaciones de ventas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Solicitudes de venta enviadas por los cobradores</p>
        </div>
        <Select value={filter} onChange={e => setFilter(e.target.value as SaleRequestStatus | '')}
          options={[
            { value: 'pending', label: 'Pendientes' },
            { value: 'approved', label: 'Aprobadas' },
            { value: 'disbursed', label: 'Desembolsadas' },
            { value: 'rejected', label: 'Rechazadas' },
          ]} placeholder="Todas" className="w-44" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ClipboardCheck className="w-8 h-8" />} title="No hay solicitudes" description="Cuando un cobrador envíe una solicitud de venta, aparecerá aquí." />
      ) : (
        <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Cliente</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Documento</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Ruta</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Cobrador</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Valor</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3 hidden sm:table-cell">Parcelas</th>
                  <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Estado</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Fecha</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(r => {
                  const c = clientMap.get(r.clientId)
                  const meta = STATUS_META[r.status]
                  return (
                    <tr key={r.id} onClick={() => openDetail(r)}
                      onMouseMove={e => setTipPos({ x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setTipPos(null)}
                      className="hover:bg-primary-50/40 cursor-pointer transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{c?.nombre ?? 'Cliente'}</p>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-sm text-gray-600">{c?.documento ?? '—'}</td>
                      <td className="px-4 py-3 hidden md:table-cell text-sm text-gray-600">{routeMap.get(r.routeId)?.nombre ?? '—'}</td>
                      <td className="px-4 py-3 hidden lg:table-cell text-sm text-gray-600">{userMap.get(r.collectorId)?.nombre ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(r.amount, currency)}</td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell text-sm text-gray-600">{r.installmentsCount}</td>
                      <td className="px-4 py-3 text-center"><Badge variant={meta.variant} size="sm">{meta.label}</Badge></td>
                      <td className="px-4 py-3 text-sm text-gray-500">{formatDate(r.requestedAt)}</td>
                      <td className="px-4 py-3" onMouseMove={e => { e.stopPropagation(); setTipPos(null) }}>
                        {r.status === 'pending' ? (
                          <div className="flex justify-end gap-1.5">
                            <Button variant="success" size="sm" loading={rowWorkingId === r.id} disabled={!!rowWorkingId}
                              onClick={(e) => { e.stopPropagation(); handleApproveRow(r) }} icon={<CheckCircle className="w-3.5 h-3.5" />}>Aprobar</Button>
                            <Button variant="danger" size="sm" disabled={!!rowWorkingId}
                              onClick={(e) => { e.stopPropagation(); openRejectRow(r) }} icon={<XCircle className="w-3.5 h-3.5" />}>Rechazar</Button>
                          </div>
                        ) : (
                          <div className="flex justify-end">
                            <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); openDetail(r) }} icon={<Eye className="w-3.5 h-3.5" />}>Ver</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tooltip flotante "Ver historial" con estilo RutaCash. Posición fija que sigue
          al cursor: no lo recorta el overflow de la tabla. pointer-events-none: no bloquea clics. */}
      {tipPos && (
        <div
          style={{ position: 'fixed', left: tipPos.x + 14, top: tipPos.y + 16, zIndex: 60 }}
          className="pointer-events-none rounded-lg border border-primary-300 bg-white text-primary-700 text-sm font-medium px-3 py-1.5 shadow-lg"
        >
          Ver historial
        </div>
      )}

      {/* Detalle / revisión (modal ancho para organizar la información) */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Solicitud de venta" size="xl"
        footer={detail?.status === 'pending' ? (
          rejecting ? (
            <>
              <Button variant="secondary" onClick={() => setRejecting(false)} disabled={working}>Cancelar</Button>
              <Button variant="danger" onClick={handleReject} loading={working} icon={<XCircle className="w-4 h-4" />}>Confirmar rechazo</Button>
            </>
          ) : (
            <>
              <Button variant="danger" onClick={() => setRejecting(true)} icon={<XCircle className="w-4 h-4" />}>Rechazar</Button>
              <Button onClick={handleApprove} loading={working} icon={<CheckCircle className="w-4 h-4" />}>Aprobar</Button>
            </>
          )
        ) : (
          <Button variant="secondary" onClick={() => setDetail(null)}>Cerrar</Button>
        )}>
        {detail && (
          <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-5 lg:space-y-0 lg:items-start">
            {/* Columna izquierda: cliente, fotos y condiciones solicitadas */}
            <div className="space-y-4">
            {/* Cliente */}
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-primary-100 rounded-2xl flex items-center justify-center text-lg font-bold text-primary-600">
                {(detailClient?.nombre ?? '?').charAt(0)}
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">{detailClient?.nombre ?? 'Cliente'}</h3>
                <p className="text-sm text-gray-500">{detailClient?.documento}</p>
                <p className="text-xs text-gray-400">{routeMap.get(detail.routeId)?.nombre} · Cobrador: {userMap.get(detail.collectorId)?.nombre ?? '—'}</p>
              </div>
            </div>

            {/* Fotos del cliente si existen */}
            {(detailClient?.fotoDocumentoUrl || detailClient?.fotoNegocioUrl) && (
              <div className="grid grid-cols-2 gap-3">
                {detailClient?.fotoDocumentoUrl && (
                  <a href={detailClient.fotoDocumentoUrl} target="_blank" rel="noreferrer">
                    <p className="text-xs text-gray-500 mb-1">Documento</p>
                    <img src={detailClient.fotoDocumentoUrl} alt="Documento" className="w-full h-28 object-cover rounded-xl border border-gray-200" />
                  </a>
                )}
                {detailClient?.fotoNegocioUrl && (
                  <a href={detailClient.fotoNegocioUrl} target="_blank" rel="noreferrer">
                    <p className="text-xs text-gray-500 mb-1">Negocio</p>
                    <img src={detailClient.fotoNegocioUrl} alt="Negocio" className="w-full h-28 object-cover rounded-xl border border-gray-200" />
                  </a>
                )}
              </div>
            )}

            {/* Condiciones solicitadas */}
            <div className="bg-gray-50 rounded-xl p-4 grid grid-cols-2 gap-3">
              <div><p className="text-xs text-gray-500">Valor solicitado</p><p className="font-bold text-gray-900">{formatCurrency(detail.amount, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Total a pagar</p><p className="font-bold text-gray-900">{formatCurrency(detail.totalAmount, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Tasa</p><p className="font-bold text-gray-900">{detail.interestRate}%</p></div>
              <div><p className="text-xs text-gray-500">N° parcelas</p><p className="font-bold text-gray-900">{detail.installmentsCount}</p></div>
              <div><p className="text-xs text-gray-500">Valor parcela</p><p className="font-bold text-gray-900">{formatCurrency(detail.installmentValue, currency)}</p></div>
              <div><p className="text-xs text-gray-500">Forma de pago</p><p className="font-bold text-gray-900 capitalize">{detail.frequency}</p></div>
              <div><p className="text-xs text-gray-500">Fecha de inicio</p><p className="font-bold text-gray-900">{formatDate(detail.startDate)}</p></div>
              {/* Días de pago como badges/chips (no texto corrido) */}
              <div className="col-span-2">
                <p className="text-xs text-gray-500 mb-1.5">Días de pago</p>
                <PaymentDaysBadges days={detail.paymentDays} size="sm" />
              </div>
            </div>
            </div>
            {/* fin columna izquierda */}

            {/* Columna derecha: indicadores, advertencias e historial.
                Scroll vertical interno en desktop para que el modal no crezca sin control. */}
            <div className="space-y-4 lg:max-h-[62vh] lg:overflow-y-auto lg:pr-1">
            {/* Indicadores comparativos (Revisión 2) */}
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-primary-600" /> Indicadores comparativos
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Solicitud actual</p><p className="text-sm font-bold text-gray-900">{formatCurrency(history.actual, currency)}</p></div>
                <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Promedio histórico</p><p className="text-sm font-bold text-gray-900">{history.count > 0 ? formatCurrency(history.promedio, currency) : '—'}</p></div>
                <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Mayor venta anterior</p><p className="text-sm font-bold text-gray-900">{history.count > 0 ? formatCurrency(history.mayor, currency) : '—'}</p></div>
                {history.count > 0 && (
                  <>
                    <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Dif. vs promedio</p><p className={`text-sm font-bold ${history.difVsPromedio > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{history.difVsPromedio >= 0 ? '+' : ''}{formatCurrency(history.difVsPromedio, currency)}</p></div>
                    <div className="bg-gray-50 rounded-xl p-2.5"><p className="text-xs text-gray-400">Dif. vs mayor</p><p className={`text-sm font-bold ${history.difVsMayor > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{history.difVsMayor >= 0 ? '+' : ''}{formatCurrency(history.difVsMayor, currency)}</p></div>
                  </>
                )}
              </div>
              {/* Advertencias */}
              {history.warning && (
                <div className={`mt-2 flex items-start gap-2 p-3 rounded-xl border text-sm ${
                  history.warning.level === 'fuerte' ? 'bg-red-50 border-red-200 text-red-700'
                    : history.warning.level === 'moderada' ? 'bg-amber-50 border-amber-200 text-amber-700'
                    : 'bg-blue-50 border-blue-200 text-blue-700'
                }`}>
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{history.warning.message}</span>
                </div>
              )}
              {history.superaMayor && (
                <div className="mt-2 flex items-start gap-2 p-3 rounded-xl border bg-red-50 border-red-200 text-red-700 text-sm">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>Esta solicitud supera la mayor venta anterior del cliente.</span>
                </div>
              )}
            </div>

            {/* Historial de ventas del cliente */}
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">
                Historial de ventas del cliente ({clientSales.length}) · Activas: {history.activas.length} · Cerradas: {history.cerradas.length} · Perdidas: {history.perdidas.length}
              </p>
              {clientSales.length === 0 ? (
                <p className="text-xs text-gray-400">Este cliente no tiene ventas anteriores.</p>
              ) : (
                <div className="space-y-1.5">
                  {clientSales.map(s => {
                    const pagado = s.valorTotal - s.saldo
                    return (
                      <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-xs">
                        <div>
                          <p className="font-medium text-gray-800">{formatCurrency(s.valorVenta, currency)} · {SALE_STATUS_LABEL[s.status] ?? s.status}</p>
                          <p className="text-gray-400">Inicio {formatDate(s.fechaInicio)}{s.status !== 'activa' ? ` · Fin ${formatDate(s.fechaFinalEstimada)}` : ''}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-emerald-600 font-medium">Pagado {formatCurrency(pagado, currency)}</p>
                          <p className="text-amber-600">Saldo {formatCurrency(s.saldo, currency)}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            </div>
            {/* fin columna derecha */}

            {/* Estado / rechazo a ancho completo */}
            <div className="lg:col-span-2 space-y-4">
              {detail.status === 'rejected' && detail.rejectionReason && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-sm text-red-700">
                  <span className="font-semibold">Motivo del rechazo:</span> {detail.rejectionReason}
                </div>
              )}
              {detail.status === 'pending' && rejecting && (
                <Textarea label="Motivo del rechazo" value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3} required />
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
