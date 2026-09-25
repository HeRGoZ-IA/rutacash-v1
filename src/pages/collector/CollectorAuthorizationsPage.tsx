import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronLeft, ChevronRight, CheckCircle, XCircle, Phone, ShieldAlert, ClipboardCheck } from 'lucide-react'
import { Select } from '@/components/ui/Input'
import { ClientCreditHistory } from '@/components/ui/ClientCreditHistory'
import { toast } from '@/components/ui/Toast'
import { db } from '@/lib/db'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { useOpBase } from '@/hooks/useOpBase'
import { useCollectorRoute } from '@/hooks/useCollectorRoute'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters'
import {
  approveSaleRequest, rejectSaleRequest, listPendingSaleRequestsForRoute, logApprovalAudit,
  computeSaleFinancials, ALLOWED_INTEREST_RATES,
} from '@/services/saleRequestService'
import { logAction } from '@/services/auditService'
import type { Client, PaymentFrequency, SaleRequest, User } from '@/models/types'

const FREQ_LABEL: Record<string, string> = {
  diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual', personalizada: 'Personalizada',
}
const FREQ_OPTIONS = ['diaria', 'semanal', 'quincenal', 'mensual'].map(v => ({ value: v, label: FREQ_LABEL[v] }))
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

/**
 * AUTORIZACIONES — capa operativa (Supervisor en recorrido, desde el teléfono).
 *
 * Solicitudes PENDIENTES de la RUTA ACTIVA que el usuario puede resolver
 * (`listPendingSaleRequestsForRoute`: acceso por ruta, sin las propias). Es la MISMA
 * lista que cuenta el globo de Inicio. Reactiva: una solicitud que un Cobrador envía
 * en otra pestaña aparece sin recargar, y desaparece al resolverla.
 *
 * Todas las acciones las revalida el servicio (permiso por ruta, estado 'pending'
 * releído dentro de la transacción, no autoaprobación). Nada de esto sale de la
 * capa operativa. Quien no tiene `authorization.access` (Cobrador) no ve nada.
 */
export default function CollectorAuthorizationsPage() {
  const navigate = useNavigate()
  const base = useOpBase()
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const { activeRouteId } = useCollectorRoute()
  const routeId = activeRouteId ?? ''
  const money = (n: number) => formatCurrency(n, currency)

  const [seleccion, setSeleccion] = useState<string | null>(null)
  const [tasa, setTasa] = useState(20)
  const [freq, setFreq] = useState<PaymentFrequency>('diaria')
  const [dias, setDias] = useState<number[]>([])
  const [telefono, setTelefono] = useState(false)
  const [notaTelefono, setNotaTelefono] = useState('')
  const [rechazando, setRechazando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [trabajando, setTrabajando] = useState(false)

  const puedeVer = Boolean(routeId) && can(user, 'authorization.access', { routeId, tenantId })
  const puedeModificar = can(user, 'authorization.modifyConditions', { routeId, tenantId })
  const puedeTelefono = can(user, 'authorization.phoneConfirm', { routeId, tenantId })

  // Lista viva: pendientes de la ruta activa + nombres para mostrarlas.
  const datos = useLiveQuery(async () => {
    if (!puedeVer) return { lista: [] as SaleRequest[], clientes: new Map<string, Client>(), usuarios: new Map<string, User>(), ruta: '' }
    const lista = await listPendingSaleRequestsForRoute(user, tenantId, routeId)
    const [clientes, usuarios, ruta] = await Promise.all([
      db.clients.where('routeId').equals(routeId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
      db.routes.get(routeId),
    ])
    return {
      lista,
      clientes: new Map(clientes.map(c => [c.id, c])),
      usuarios: new Map(usuarios.map(u => [u.id, u])),
      ruta: ruta?.nombre ?? '',
    }
  }, [user?.id, tenantId, routeId, puedeVer])

  if (!puedeVer) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center text-gray-500">
        <ShieldAlert className="w-8 h-8 mb-2 text-gray-400" />
        <p className="text-sm">No tienes acceso a autorizaciones en esta ruta.</p>
      </div>
    )
  }
  if (!datos) return <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" /></div>

  const { lista, clientes, usuarios, ruta } = datos
  const actual = lista.find(r => r.id === seleccion) ?? null
  const nombreCliente = (id: string) => clientes.get(id)?.nombre ?? 'Cliente'
  const solicitante = (r: SaleRequest) => usuarios.get(r.requestedBy ?? r.collectorId)?.nombre ?? '—'

  function abrir(r: SaleRequest) {
    setSeleccion(r.id)
    setTasa(r.interestRate); setFreq(r.frequency); setDias(r.paymentDays ?? [])
    setTelefono(!!r.phoneConfirmed); setNotaTelefono(r.phoneConfirmationNote ?? '')
    setRechazando(false); setMotivo('')
  }

  async function aprobar() {
    if (!actual || !user) return
    if (dias.length === 0) { toast.error('Selecciona al menos un día de pago'); return }
    setTrabajando(true)
    try {
      const overrides = puedeModificar
        ? { interestRate: tasa, frequency: freq, paymentDays: dias, phoneConfirmed: telefono, phoneConfirmationNote: notaTelefono || undefined }
        : { phoneConfirmed: telefono, phoneConfirmationNote: notaTelefono || undefined }
      await approveSaleRequest(actual.id, user, overrides)
      await logApprovalAudit(actual, user, overrides, money(actual.amount)).catch(() => undefined)
      toast.success('Solicitud aprobada. Venta creada, pendiente de desembolso.')
      setSeleccion(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo aprobar')
      setSeleccion(null)
    } finally { setTrabajando(false) }
  }

  async function rechazar() {
    if (!actual || !user) return
    if (!motivo.trim()) { toast.error('Indica el motivo del rechazo'); return }
    setTrabajando(true)
    try {
      await rejectSaleRequest(actual.id, user, motivo)
      await logAction({
        tenantId: actual.tenantId, userId: user.id, userRole: user.rol, routeId: actual.routeId,
        action: 'REJECT_SALE_REQUEST', entityType: 'SaleRequest', entityId: actual.id,
        descripcion: 'Solicitud rechazada', motivo: motivo.trim(),
      }).catch(() => undefined)
      toast.success('Solicitud rechazada')
      setSeleccion(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo rechazar')
      setSeleccion(null)
    } finally { setTrabajando(false) }
  }

  // ---------------- DETALLE ----------------
  if (actual) {
    const cliente = clientes.get(actual.clientId)
    const calc = computeSaleFinancials({
      valorVenta: actual.amount, tasaInteres: tasa, numeroCuotas: actual.installmentsCount,
      frecuenciaPago: freq, fechaInicio: actual.startDate, paymentDays: dias,
    })
    return (
      <div className="p-4 space-y-4 pb-8">
        <button onClick={() => setSeleccion(null)} className="flex items-center gap-1 text-sm text-primary-600">
          <ChevronLeft className="w-4 h-4" /> Solicitudes
        </button>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 space-y-1">
          <p className="font-bold text-gray-900">{cliente?.nombre ?? 'Cliente'}</p>
          <p className="text-xs text-gray-500">{cliente?.documento}{cliente?.telefonoPrincipal ? ` · ${cliente.telefonoPrincipal}` : ''}</p>
          <p className="text-xs text-gray-500">Ruta {ruta} · Solicitó {solicitante(actual)} · {formatDateTime(actual.requestedAt)}</p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-card divide-y divide-gray-50 text-sm">
          {[
            ['Valor solicitado', money(actual.amount)],
            ['Interés', `${tasa}% · ${money(calc.valorInteres)}`],
            ['Total a pagar', money(calc.valorTotal)],
            ['Parcelas', `${actual.installmentsCount} × ${money(calc.valorCuota)}`],
            ['Forma de pago', FREQ_LABEL[freq] ?? freq],
            ['Inicio', formatDate(actual.startDate)],
            ['Fin estimado', formatDate(calc.fechaFinalEstimada)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between px-4 py-2.5">
              <span className="text-gray-500">{k}</span><span className="font-semibold text-gray-800 text-right">{v}</span>
            </div>
          ))}
        </div>

        {/* Condiciones: solo con `authorization.modifyConditions`. Las solicitadas
            quedan congeladas en la solicitud; se registran las finales. */}
        {puedeModificar && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Condiciones</p>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Tasa" value={String(tasa)} onChange={e => setTasa(Number(e.target.value))}
                options={ALLOWED_INTEREST_RATES.map(t => ({ value: String(t), label: `${t}%` }))} />
              <Select label="Forma de pago" value={freq} onChange={e => setFreq(e.target.value as PaymentFrequency)} options={FREQ_OPTIONS} />
            </div>
            <div className="flex flex-wrap gap-2">
              {WEEK_DAYS.map(d => {
                const on = dias.includes(d.value)
                return (
                  <button key={d.value} type="button"
                    onClick={() => setDias(p => on ? p.filter(x => x !== d.value) : [...p, d.value].sort((a, b) => a - b))}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border ${on ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                    {d.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {puedeTelefono && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-4 space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={telefono} onChange={e => setTelefono(e.target.checked)} className="w-5 h-5" />
              <Phone className="w-4 h-4 text-gray-400" /> Confirmé por teléfono con el cliente
            </label>
            {telefono && (
              <input value={notaTelefono} onChange={e => setNotaTelefono(e.target.value)} placeholder="Nota de la llamada (opcional)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            )}
          </div>
        )}

        {cliente && <ClientCreditHistory client={cliente} />}

        {rechazando ? (
          <div className="space-y-2">
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={3} placeholder="Motivo del rechazo (obligatorio)"
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm" />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setRechazando(false)} className="h-12 rounded-xl border border-gray-200 text-sm text-gray-600">Cancelar</button>
              <button onClick={rechazar} disabled={trabajando || !motivo.trim()}
                className="h-12 rounded-xl bg-red-600 text-white text-sm font-semibold disabled:opacity-50">Confirmar rechazo</button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setRechazando(true)} disabled={trabajando}
              className="h-12 rounded-xl bg-red-50 text-red-600 border border-red-100 text-sm font-semibold flex items-center justify-center gap-1.5">
              <XCircle className="w-4 h-4" /> Rechazar
            </button>
            <button onClick={aprobar} disabled={trabajando}
              className="h-12 rounded-xl bg-emerald-600 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50">
              <CheckCircle className="w-4 h-4" /> Aprobar
            </button>
          </div>
        )}
      </div>
    )
  }

  // ---------------- LISTA ----------------
  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="font-bold text-gray-900">Autorizaciones</h1>
        <p className="text-xs text-gray-500">Solicitudes pendientes de la ruta {ruta}. Para ver otra ruta, cámbiala en la cabecera.</p>
      </div>
      {lista.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-gray-400">
          <ClipboardCheck className="w-8 h-8 mb-2" />
          <p className="text-sm">No hay solicitudes pendientes en esta ruta.</p>
          <button onClick={() => navigate(`${base}/home`)} className="mt-3 text-sm text-primary-600 font-medium">Volver al inicio</button>
        </div>
      ) : (
        <div className="space-y-2">
          {lista.map(r => (
            <button key={r.id} onClick={() => abrir(r)}
              className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-card px-4 py-3 active:bg-gray-50">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-gray-900 truncate">{nombreCliente(r.clientId)}</span>
                <span className="font-bold text-primary-700 whitespace-nowrap">{money(r.amount)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className="text-xs text-gray-500 truncate">
                  {FREQ_LABEL[r.frequency] ?? r.frequency} · {r.installmentsCount} parcelas · {formatDateTime(r.requestedAt)} · {solicitante(r)}
                </span>
                <span className="flex items-center gap-1 text-xs font-medium text-amber-600 whitespace-nowrap">
                  Pendiente <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
