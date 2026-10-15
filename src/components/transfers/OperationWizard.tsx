import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Modal } from '@/components/ui/Modal'
import { useAuth } from '@/hooks/useAuth'
import { useTenant } from '@/hooks/useTenant'
import { can } from '@/lib/permissions'
import { formatCurrency, formatDateTime } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import {
  availableOperations, confirmationSentence, operationDef, previewTransferOperation, routesForOperation, transferCategories,
  type RouteBalances, type TransferMode, type TransferOperationKind,
} from '@/lib/transferOperations'
import { assignBaseToWorker, custodianBlockedReason, returnBaseFromWorker } from '@/services/cashCustodyService'
import { deliverCapitalToWorker, returnCapitalFromWorker } from '@/services/centralCapitalService'
import { db } from '@/lib/db'
import { registerCapital, registerTransfer, registerWithdrawal } from '@/services/routeFundsService'
import { getRouteCashReconciliation } from '@/services/routeCashReconciliation'
import { getAdminAvailableCapital } from '@/services/capitalControlService'
import type { Route, SaleRequest, User } from '@/models/types'

type Paso = 'tipo' | 'datos' | 'confirmar' | 'resultado'

interface Resultado {
  id: string
  createdAt: string
  tipo: string
  origen: string
  destino: string
  importe: number
  concepto: string
  responsable: string
  origenAhora: number | null
  destinoAhora: number | null
}

/** Saldos de la ruta desde la conciliación (con permiso `cashbox.viewRoute`). `null` = no disponibles. */
async function saldosDe(actor: User | null | undefined, tenantId: string, routeId: string): Promise<RouteBalances | null> {
  try {
    const r = await getRouteCashReconciliation({ actor, tenantId, routeId })
    return { disponible: r.disponible, sinAsignar: r.noAsignado, posiciones: Object.fromEntries(r.personas.map(p => [p.userId, p.posicion])) }
  } catch { return null }
}

/**
 * ASISTENTE DE OPERACIONES (Ronda 4/6): tipo → datos con vista previa →
 * confirmación consciente → resultado confirmado por el servicio. Cada operación
 * se registra con SU servicio existente; un id de operación por asistente abierto
 * (un doble clic o un reintento devuelven el mismo registro).
 */
export function OperationWizard({ open, onClose, onDone, routes, users, inicial, modo }: {
  open: boolean
  onClose: () => void
  /** Tras una operación confirmada (para recargar la página). */
  onDone?: () => void
  routes: Route[]
  users: User[]
  inicial?: { kind?: TransferOperationKind; routeId?: string; trabajadorId?: string }
  /** Capital centralizado (C2): solo las operaciones válidas en ese modelo. Sin él, v16. */
  modo?: TransferMode
}) {
  const { user } = useAuth()
  const { tenantId, currency } = useTenant()
  const money = (n: number) => formatCurrency(n, currency)
  const [paso, setPaso] = useState<Paso>('tipo')
  const [kind, setKind] = useState<TransferOperationKind | null>(null)
  const [routeId, setRouteId] = useState('')
  const [destinoId, setDestinoId] = useState('')
  const [trabajadorId, setTrabajadorId] = useState('')
  const [importe, setImporte] = useState(0)
  const [concepto, setConcepto] = useState('')
  const [confirmado, setConfirmado] = useState(false)
  const [operationId, setOperationId] = useState('')
  const [ruta, setRuta] = useState<RouteBalances | null | undefined>(undefined)
  const [rutaDestino, setRutaDestino] = useState<RouteBalances | null | undefined>(undefined)
  const [bolsa, setBolsa] = useState<number | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  /** Entrega de capital: solicitud de venta para la que se anticipa (opcional; no crea venta). */
  const [solicitudId, setSolicitudId] = useState('')
  const [solicitudes, setSolicitudes] = useState<SaleRequest[]>([])

  const disponibles = availableOperations(user, routes, users, tenantId, modo)
  const rutas = kind ? routesForOperation(kind, user, routes, users, tenantId, modo) : []
  const def = (k: TransferOperationKind) => operationDef(k, modo)
  const entregaKinds: TransferOperationKind[] = ['entregar-base', 'entregar-capital']
  const devolucionKinds: TransferOperationKind[] = ['devolver-base', 'devolver-capital']
  const destinos = kind === 'ruta-ruta' ? rutas.filter(r => r.id !== routeId) : []
  const nombre = (id: string) => users.find(u => u.id === id)?.nombre ?? id
  const rutaNombre = (id: string) => routes.find(r => r.id === id)?.nombre ?? id
  const rol = (u: User) => (u.rol === 'supervisor' ? 'Supervisor' : 'Cobrador')

  // Personas elegibles según la operación (mismas reglas que el servicio).
  const trabajadores: User[] = !kind || !routeId ? [] : entregaKinds.includes(kind)
    ? users.filter(u => !custodianBlockedReason(u, routeId, tenantId))
    : devolucionKinds.includes(kind)
      ? users.filter(u => u.id !== user?.id && (ruta?.posiciones[u.id] ?? 0) > 0)
      : []
  const receptoresDestino = kind === 'ruta-ruta' && destinoId && can(user, 'cashCustody.manage', { routeId: destinoId, tenantId })
    ? users.filter(u => !custodianBlockedReason(u, destinoId, tenantId)) : []

  // Apertura: operación nueva (id nuevo); preselección solo si está autorizada.
  useEffect(() => {
    if (!open) return
    const k = inicial?.kind && disponibles.includes(inicial.kind) ? inicial.kind : null
    setKind(k)
    setPaso(k ? 'datos' : 'tipo')
    const rs = k ? routesForOperation(k, user, routes, users, tenantId, modo) : []
    setRouteId(inicial?.routeId && rs.some(r => r.id === inicial.routeId) ? inicial.routeId : rs.length === 1 ? rs[0].id : '')
    setTrabajadorId(inicial?.trabajadorId ?? '')
    setDestinoId(''); setImporte(0); setConcepto(''); setConfirmado(false); setError(null); setResultado(null); setSolicitudId('')
    setOperationId(generateId())
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  // Saldos del origen y del destino (servicio). Se releen al cambiar de ruta.
  useEffect(() => {
    let alive = true
    setRuta(undefined)
    if (!open || !routeId) return
    saldosDe(user, tenantId, routeId).then(b => { if (alive) setRuta(b) })
    return () => { alive = false }
  }, [open, routeId, user, tenantId])
  useEffect(() => {
    let alive = true
    setRutaDestino(undefined)
    if (!open || !destinoId) return
    saldosDe(user, tenantId, destinoId).then(b => { if (alive) setRutaDestino(b) })
    return () => { alive = false }
  }, [open, destinoId, user, tenantId])
  useEffect(() => {
    let alive = true
    setBolsa(undefined)
    // La bolsa solo se consulta para el propio Administrador (nunca para otros roles).
    if (!open || !user || user.rol !== 'admin' || !kind || !['colocar', 'retirar', 'entregar-capital', 'devolver-capital'].includes(kind)) return
    getAdminAvailableCapital(tenantId, user.id).then(v => { if (alive) setBolsa(v) }, () => { if (alive) setBolsa(null) })
    return () => { alive = false }
  }, [open, kind, user, tenantId])

  // Solicitudes de venta del trabajador en la ruta (referencia opcional de la entrega).
  useEffect(() => {
    let alive = true
    setSolicitudes([]); setSolicitudId('')
    if (!open || kind !== 'entregar-capital' || !routeId || !trabajadorId) return
    db.saleRequests.where('routeId').equals(routeId).toArray().then(list => {
      if (alive) setSolicitudes(list.filter(r => r.tenantId === tenantId && r.collectorId === trabajadorId && (r.status === 'pending' || r.status === 'approved')))
    })
    return () => { alive = false }
  }, [open, kind, routeId, trabajadorId, tenantId])

  const necesitaTrabajador = !!kind && (entregaKinds.includes(kind) || devolucionKinds.includes(kind))
  const nombres = {
    ruta: rutaNombre(routeId), rutaDestino: destinoId ? rutaNombre(destinoId) : '',
    trabajador: trabajadorId ? nombre(trabajadorId) : '',
    bolsa: user?.rol === 'admin' ? 'Mi bolsa (Caja principal)' : 'Bolsa del Administrador responsable',
  }
  const preview = kind ? previewTransferOperation({
    kind, importe, ruta: ruta ?? null, rutaDestino: rutaDestino ?? null,
    trabajadorId: necesitaTrabajador || (kind === 'ruta-ruta' && trabajadorId) ? trabajadorId || undefined : undefined,
    bolsa: bolsa ?? null, nombres,
  }) : null
  const completo = !!kind && !!routeId && importe > 0 && concepto.trim().length >= 3
    && (!necesitaTrabajador || !!trabajadorId) && (kind !== 'ruta-ruta' || !!destinoId)
  const puedeContinuar = completo && !!preview && !preview.excede

  function elegir(k: TransferOperationKind) {
    setKind(k)
    const rs = routesForOperation(k, user, routes, users, tenantId, modo)
    setRouteId(rs.length === 1 ? rs[0].id : '')
    setDestinoId(''); setTrabajadorId(''); setImporte(0); setConcepto(''); setConfirmado(false); setError(null); setSolicitudId('')
    setOperationId(generateId())
    setPaso('datos')
  }

  async function registrar() {
    if (!kind || !preview || !confirmado || saving) return
    setSaving(true); setError(null)
    try {
      let id = ''
      let createdAt = ''
      if (kind === 'entregar-capital') {
        const d = await deliverCapitalToWorker({ actor: user, tenantId, routeId, recipientUserId: trabajadorId, amount: importe, motivo: concepto, operationId, saleRequestId: solicitudId || undefined })
        id = d.capital.id; createdAt = d.capital.createdAt
      } else if (kind === 'devolver-capital') {
        const d = await returnCapitalFromWorker({ actor: user, tenantId, routeId, fromUserId: trabajadorId, amount: importe, motivo: concepto, operationId })
        id = d.withdrawal.id; createdAt = d.withdrawal.createdAt
      } else if (kind === 'entregar-base') {
        const m = await assignBaseToWorker({ actor: user, tenantId, routeId, recipientUserId: trabajadorId, amount: importe, motivo: concepto, operationId })
        id = m.id; createdAt = m.createdAt
      } else if (kind === 'devolver-base') {
        const m = await returnBaseFromWorker({ actor: user, tenantId, routeId, fromUserId: trabajadorId, amount: importe, motivo: concepto, operationId })
        id = m.id; createdAt = m.createdAt
      } else if (kind === 'ruta-ruta') {
        const r = await registerTransfer({
          actor: user, tenantId, origen: { type: 'route', id: routeId }, destino: { type: 'route', id: destinoId },
          valor: importe, descripcion: concepto, entregarA: trabajadorId ? { userId: trabajadorId, motivo: concepto } : undefined, operationId,
        })
        id = r.transfer.id; createdAt = r.transfer.createdAt
      } else if (kind === 'colocar') {
        const m = await registerCapital({ actor: user, tenantId, routeId, valor: importe, descripcion: concepto, operationId })
        id = m.id; createdAt = m.createdAt
      } else {
        const w = await registerWithdrawal({ actor: user, tenantId, routeId, valor: importe, descripcion: concepto, operationId })
        id = w.id; createdAt = w.createdAt
      }
      // Saldos RELEÍDOS tras la operación (mismas fuentes que la vista previa).
      const [o, d, b] = await Promise.all([
        saldosDe(user, tenantId, routeId),
        destinoId ? saldosDe(user, tenantId, destinoId) : Promise.resolve(null),
        user?.rol === 'admin' && ['colocar', 'retirar', 'entregar-capital', 'devolver-capital'].includes(kind) ? getAdminAvailableCapital(tenantId, user!.id) : Promise.resolve(null),
      ])
      const ahora = previewTransferOperation({
        kind, importe: 0, ruta: o, rutaDestino: d, bolsa: b,
        trabajadorId: necesitaTrabajador || (kind === 'ruta-ruta' && trabajadorId) ? trabajadorId || undefined : undefined, nombres,
      })
      setResultado({
        id, createdAt, tipo: def(kind).titulo, origen: preview.origen.cuenta, destino: preview.destino.cuenta,
        importe, concepto: concepto.trim(), responsable: user?.nombre ?? '', origenAhora: ahora.origen.antes, destinoAhora: ahora.destino.antes,
      })
      setPaso('resultado')
      onDone?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la operación.')
      setPaso('datos')
      setConfirmado(false)
    } finally { setSaving(false) }
  }

  const cifra = (n: number | null) => (n == null ? 'Se calcula al registrar' : money(n))
  const titulo = paso === 'tipo' ? 'Nueva operación' : paso === 'resultado' ? 'Operación registrada' : kind ? def(kind).titulo : ''

  const footer = paso === 'tipo'
    ? <Button variant="secondary" onClick={onClose}>Cerrar</Button>
    : paso === 'datos'
      ? <><Button variant="secondary" onClick={() => setPaso('tipo')}>Volver</Button><Button onClick={() => { setConfirmado(false); setPaso('confirmar') }} disabled={!puedeContinuar} icon={<ArrowRight className="w-4 h-4" />}>Revisar</Button></>
      : paso === 'confirmar'
        ? <><Button variant="secondary" onClick={() => setPaso('datos')} disabled={saving}>Volver</Button><Button onClick={registrar} loading={saving} disabled={!confirmado}>Confirmar y registrar</Button></>
        : <Button onClick={onClose}>Cerrar</Button>

  return (
    <Modal open={open} onClose={() => { if (!saving) onClose() }} title={titulo} size="lg" footer={footer}>
      {paso === 'tipo' && (
        <div className="space-y-4" data-testid="op-selector">
          {disponibles.length === 0 ? (
            <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
              No tienes operaciones de caja disponibles: solo el Administrador responsable de capital de una ruta mueve su efectivo.
            </p>
          ) : transferCategories(modo).filter(c => c.kinds.some(k => disponibles.includes(k))).map(c => (
            <div key={c.categoria} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{c.titulo}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {c.kinds.filter(k => disponibles.includes(k)).map(k => (
                  <button key={k} type="button" onClick={() => elegir(k)} data-testid={`op-${k}`}
                    className="text-left rounded-xl border border-gray-200 bg-white px-3 py-2.5 hover:border-primary-400 hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <span className="block text-sm font-semibold text-gray-900">{def(k).titulo}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{def(k).ayuda}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {paso === 'datos' && kind && (
        <div className="space-y-4" data-testid="op-form">
          <p className="text-xs text-gray-500">{def(kind).ayuda}</p>
          {error && <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2" role="alert">{error}</p>}
          <div className="grid grid-cols-1 gap-3">
            <Select label={kind === 'ruta-ruta' ? 'Ruta origen' : 'Ruta'} value={routeId} required
              onChange={e => { setRouteId(e.target.value); setTrabajadorId(''); setDestinoId('') }}
              options={rutas.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta" />
            {kind === 'ruta-ruta' && (
              <Select label="Ruta destino" value={destinoId} required onChange={e => { setDestinoId(e.target.value); setTrabajadorId('') }}
                options={destinos.map(r => ({ value: r.id, label: r.nombre }))} placeholder="Seleccionar ruta destino"
                hint="Solo rutas de las que también eres responsable de capital: el capital no cambia de bolsa." />
            )}
            {necesitaTrabajador && (
              <Select label={entregaKinds.includes(kind) ? 'Trabajador que recibe' : 'Trabajador que devuelve'} value={trabajadorId} required
                onChange={e => setTrabajadorId(e.target.value)} disabled={!routeId}
                options={trabajadores.map(u => ({ value: u.id, label: `${u.nombre} · ${rol(u)}` }))}
                placeholder={!routeId ? 'Primero elige la ruta' : trabajadores.length ? 'Seleccionar trabajador' : devolucionKinds.includes(kind) ? 'Nadie tiene efectivo a cargo en esta ruta' : 'Sin trabajadores activos en la ruta'} />
            )}
            {kind === 'entregar-capital' && solicitudes.length > 0 && (
              <Select label="¿Para qué solicitud de venta? (opcional)" value={solicitudId} onChange={e => setSolicitudId(e.target.value)}
                options={solicitudes.map(r => ({ value: r.id, label: `${money(r.amount)} · ${r.status === 'approved' ? 'aprobada' : 'pendiente'} · ${r.startDate}` }))}
                placeholder="Sin referencia" hint="Solo deja constancia: la entrega no crea la venta ni una deuda del cliente." />
            )}
            {kind === 'ruta-ruta' && receptoresDestino.length > 0 && (
              <Select label="¿Quién recibe el efectivo en la ruta destino? (opcional)" value={trabajadorId}
                onChange={e => setTrabajadorId(e.target.value)}
                options={receptoresDestino.map(u => ({ value: u.id, label: `${u.nombre} · ${rol(u)}` }))}
                placeholder="Nadie: entra a la caja sin asignar" />
            )}
            <MoneyInput label="Importe" currency={currency} value={importe} onValueChange={setImporte} required />
            <Input label="Concepto" value={concepto} onChange={e => setConcepto(e.target.value)} placeholder="Ej.: Base del día" required />
          </div>

          {preview && routeId && (
            <div className="rounded-xl border border-gray-100 divide-y divide-gray-50 text-sm" data-testid="op-preview">
              {[['Sale de', preview.origen, -1], ['Llega a', preview.destino, 1]].map(([rotulo, c, signo]) => {
                const cuenta = c as typeof preview.origen
                return (
                  <div key={rotulo as string} className="px-3 py-2 space-y-1">
                    <p className="text-xs font-semibold text-gray-700">{rotulo as string} · {cuenta.cuenta}</p>
                    <div className="flex justify-between gap-2"><span className="text-gray-500">Antes</span><span data-testid={`${signo === -1 ? 'origin' : 'dest'}-before`}>{cifra(cuenta.antes)}</span></div>
                    <div className="flex justify-between gap-2"><span className="text-gray-500">Importe</span><span>{(signo as number) < 0 ? '−' : '+'} {money(importe)}</span></div>
                    <div className="flex justify-between gap-2"><span className="text-gray-500">Después</span>
                      <b data-testid={`${signo === -1 ? 'origin' : 'dest'}-after`} className={signo === -1 && preview.excede ? 'text-red-600' : 'text-gray-900'}>{signo === -1 && preview.excede ? 'Insuficiente' : cifra(cuenta.despues)}</b>
                    </div>
                  </div>
                )
              })}
              <p className="px-3 py-2 text-xs text-gray-500" data-testid="op-limit">
                {preview.limite == null ? 'El máximo se comprueba al registrar.' : `Máximo para esta operación: ${money(preview.limite)}.`}
                {preview.excede && <span className="block text-red-600">El importe supera lo disponible. El efectivo en manos de otros trabajadores o colocado en préstamos no se puede mover desde aquí.</span>}
              </p>
            </div>
          )}
          {kind === 'entregar-base' && !modo?.central && (
            <p className="text-[11px] text-gray-400">
              También puedes entregar Base desde Liquidación → Cuadre por trabajador (botón «Entregar Base»). Es la misma operación y no exige cerrar ningún cuadre.
              {routeId && trabajadorId && <> <Link className="text-primary-700 hover:underline" to={`/admin/weekly-settlement?vista=trabajadores&routeId=${encodeURIComponent(routeId)}&userId=${encodeURIComponent(trabajadorId)}&accion=entregar-base`}>Ver su cuadre</Link></>}
            </p>
          )}
        </div>
      )}

      {paso === 'confirmar' && kind && preview && (
        <div className="space-y-3 text-sm" data-testid="op-confirm">
          <p className="text-base font-semibold text-gray-900" data-testid="op-sentence">
            {confirmationSentence(kind, money(importe), preview.origen.cuenta, preview.destino.cuenta)}
          </p>
          <div className="rounded-xl border border-gray-100 divide-y divide-gray-50">
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">{preview.origen.cuenta}</span><span>{cifra(preview.origen.antes)} → <b>{cifra(preview.origen.despues)}</b></span></div>
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">{preview.destino.cuenta}</span><span>{cifra(preview.destino.antes)} → <b>{cifra(preview.destino.despues)}</b></span></div>
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Concepto</span><span className="text-right break-words">{concepto.trim()}</span></div>
            <div className="flex justify-between gap-2 px-3 py-2"><span className="text-gray-500">Registra</span><span>{user?.nombre}</span></div>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-1" checked={confirmado} onChange={e => setConfirmado(e.target.checked)} data-testid="op-check" />
            <span>Revisé el origen, el destino y el importe. El sistema volverá a comprobar el disponible al registrar.</span>
          </label>
        </div>
      )}

      {paso === 'resultado' && resultado && (
        <div className="space-y-3 text-sm" data-testid="op-result">
          <p className="flex items-center gap-2 text-emerald-700 font-semibold"><CheckCircle2 className="w-5 h-5" />Registrada por el sistema</p>
          <div className="rounded-xl border border-gray-100 divide-y divide-gray-50">
            {[
              ['Operación', resultado.tipo], ['Origen', resultado.origen], ['Destino', resultado.destino],
              ['Importe', money(resultado.importe)], ['Concepto', resultado.concepto], ['Fecha y hora', formatDateTime(resultado.createdAt)],
              ['Registró', resultado.responsable], ['Referencia', resultado.id],
              ['Origen ahora', cifra(resultado.origenAhora)], ['Destino ahora', cifra(resultado.destinoAhora)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 px-3 py-2"><span className="text-gray-500">{k}</span><span className="text-right break-all" data-testid={`result-${k}`}>{v}</span></div>
            ))}
          </div>
          <p className="text-xs text-gray-500">Los saldos «ahora» se releyeron del sistema después de registrar.</p>
        </div>
      )}
    </Modal>
  )
}
