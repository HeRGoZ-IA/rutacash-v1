import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, PencilLine, Receipt } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { ApprovalInstallments } from '@/components/ui/ApprovalInstallments'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { calculateTotalWithInterest } from '@/services/installmentEngine'
import { checkSaleRectification, rectifyDisbursedSale, recordRectificationCase, type RectificationCheck } from '@/services/saleRequestService'
import type { PaymentFrequency, Sale, User } from '@/models/types'

const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

/** D73-03: por qué la corrección normal no se puede hacer (texto para el Administrador). */
const BLOCKER_TEXT: Record<string, string> = {
  CREDIT_HAS_COLLECTIONS: 'La venta ya tiene cobros registrados (regla anterior a esta versión).',
  OVERPAYMENT: 'El total corregido quedaría por debajo de lo ya pagado: no hay política aprobada de sobrepagos ni devoluciones.',
  PAYMENT_ADJUSTMENT_PENDING: 'Hay una solicitud de ajuste de pago pendiente en esta venta: resuélvala primero.',
  LEGACY_PAYMENTS: 'La venta tiene pagos importados sin asiento en el libro: no se puede recalcular su imputación.',
  LEDGER_INCONSISTENT: 'Los pagos y su imputación no concilian con la venta: revísela antes de corregirla.',
  DISBURSEMENT_SETTLED: 'El desembolso ya entró en un cuadre del trabajador: corregirlo alteraría un cuadre cerrado.',
  PERIOD_CLOSED: 'El periodo de la ruta está cerrado: no se registran movimientos en un periodo cerrado.',
  CUSTODIAN_CHANGED: 'El trabajador que entregó el dinero ya no tiene caja en esta ruta: no hay a quién cargar o devolver la diferencia.',
  POOL_OF_ANOTHER_ADMIN: 'El desembolso salió de la cuenta de otro Administrador (su bolsa o los fondos de una ruta a su cargo): solo ese Administrador puede corregirlo.',
  INSUFFICIENT_FUNDS: 'La cuenta que pagó el desembolso no tiene saldo suficiente para el capital adicional.',
  OFFLINE_PENDING: 'Hay cobros guardados sin conexión que todavía no llegaron al servidor: el estado de la venta no es seguro.',
  CREDIT_NOT_ACTIVE: 'La venta no está activa.',
  CREDIT_NOT_LEDGERED: 'La venta no tiene desembolso registrado en el libro.',
}
/** Motivos que se pueden registrar como caso excepcional (los demás no son casos de corrección). */
const CASEABLE = new Set(['CREDIT_HAS_COLLECTIONS', 'DISBURSEMENT_SETTLED', 'PERIOD_CLOSED', 'CUSTODIAN_CHANGED', 'POOL_OF_ANOTHER_ADMIN', 'INSUFFICIENT_FUNDS', 'OFFLINE_PENDING',
  'OVERPAYMENT', 'PAYMENT_ADJUSTMENT_PENDING', 'LEGACY_PAYMENTS', 'LEDGER_INCONSISTENT'])

/**
 * Bloque A post-R73 (0032): también con pagos registrados. Los pagos se conservan (importe, fecha y
 * evidencia); las parcelas se recalculan con el pagado neto y la diferencia de imputación
 * capital/interés es una reclasificación sin efectivo. Si cambia el capital entregado rigen además
 * los controles de abajo (desembolso fuera de cuadre, custodio vigente, saldo).
 *
 * Ronda 73 · SOC-09: el Administrador corrige una venta DESEMBOLSADA sin cobros ni cuadre
 * (p. ej. el trabajador entregó R$ 1.500 y registró R$ 1.400). El servidor conserva el
 * desembolso original y su fecha, registra la diferencia de capital como un asiento nuevo
 * contra la cuenta que pagó y rehace las parcelas; todo queda en el historial con motivo y
 * evidencia. Las reglas (sin cobros, sin cuadre, sin periodo cerrado, fondos) las decide el
 * servidor: aquí solo se explican.
 */
export function RectifySaleModal({ sale, user, currency, open, onClose, onDone }: {
  sale: Sale
  user: User
  currency: string
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [valor, setValor] = useState(sale.valorVenta)
  const [tasa, setTasa] = useState(sale.tasaInteres)
  const [cuotas, setCuotas] = useState(sale.numeroCuotas)
  const [freq, setFreq] = useState<PaymentFrequency>(sale.frecuenciaPago)
  const [inicio, setInicio] = useState(sale.fechaInicio)
  const [dias, setDias] = useState<number[]>(sale.paymentDays ?? [1, 2, 3, 4, 5, 6])
  const [motivo, setMotivo] = useState('')
  const [evidencia, setEvidencia] = useState('')
  const [sinPendientes, setSinPendientes] = useState(false)
  const [saving, setSaving] = useState(false)
  // Un id por intención (por apertura del formulario): un reintento nunca corrige dos veces.
  const operationId = useMemo(() => generateId(), [sale.id, open])
  const caseOperationId = useMemo(() => generateId(), [sale.id, open])
  // D73-03: comprobación del servidor (sin efectos) y cobros sin conexión declarados.
  const [check, setCheck] = useState<RectificationCheck | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [offlinePending, setOfflinePending] = useState(false)
  const [caseSaved, setCaseSaved] = useState(false)
  const loadCheck = () => { setCheckFailed(false); void checkSaleRectification(sale.id).then(setCheck, () => setCheckFailed(true)) }
  useEffect(() => { if (open) loadCheck() }, [sale.id, open])

  const delta = Math.round((valor - sale.valorVenta) * 100) / 100
  const cambia = delta !== 0 || tasa !== sale.tasaInteres || cuotas !== sale.numeroCuotas || freq !== sale.frecuenciaPago
    || inicio !== sale.fechaInicio || JSON.stringify(dias) !== JSON.stringify(sale.paymentDays ?? [])
  // Total corregido (mismo motor que el servidor) frente a lo ya pagado.
  const nuevoTotal = calculateTotalWithInterest({ valorVenta: valor, tasaInteres: tasa }).valorTotal
  const bloqueos = [
    ...(check?.blockers ?? []),
    // Solo si cambia el capital entregado (mueve efectivo de la cuenta que pagó).
    ...(check && delta !== 0 ? (check.capitalBlockers ?? []) : []),
    ...(check && delta > 0 && (check.capitalBlockers ?? []).length === 0 && delta > check.maxIncrease ? ['INSUFFICIENT_FUNDS'] : []),
    ...(check && nuevoTotal < (check.minTotal ?? 0) ? ['OVERPAYMENT'] : []),
    ...(offlinePending ? ['OFFLINE_PENDING'] : []),
  ]
  const pagos = check?.payments
  const listo = cambia && valor > 0 && Number.isInteger(cuotas) && cuotas >= 1 && cuotas <= 1000 && dias.length > 0
    && motivo.trim().length >= 10 && evidencia.trim().length >= 10 && sinPendientes && check !== null && bloqueos.length === 0
  const caso = bloqueos.find(b => CASEABLE.has(b))

  async function registrarCaso() {
    if (!caso || motivo.trim().length < 10 || saving) return
    setSaving(true)
    try {
      await recordRectificationCase(sale.id, { blocker: caso, motivo, evidencia, operationId: caseOperationId,
        proposed: { valorVenta: valor, tasaInteres: tasa, numeroCuotas: cuotas, frecuenciaPago: freq, fechaInicio: inicio, paymentDays: dias } })
      setCaseSaved(true)
      toast.success('Caso registrado para revisión. La venta y el dinero no se modificaron.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo registrar el caso')
    } finally { setSaving(false) }
  }

  async function guardar() {
    if (!listo || saving) return
    setSaving(true)
    try {
      await rectifyDisbursedSale(sale.id, user, {
        valorVenta: valor, tasaInteres: tasa, numeroCuotas: cuotas, frecuenciaPago: freq, fechaInicio: inicio, paymentDays: dias,
        motivo, evidencia, sinCapturasPendientes: sinPendientes, rectificacionesVistas: sale.rectificationCount ?? 0, operationId,
      })
      toast.success('Venta corregida. El desembolso original y la corrección quedan en el historial.')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo corregir la venta')
      loadCheck()
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Corregir venta desembolsada" size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        {caso
          ? <Button variant="secondary" onClick={registrarCaso} loading={saving} disabled={caseSaved || motivo.trim().length < 10}>{caseSaved ? 'Caso registrado' : 'Registrar caso para revisión'}</Button>
          : <Button onClick={guardar} loading={saving} disabled={!listo} icon={<PencilLine className="w-4 h-4" />}>Registrar corrección</Button>}
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800 flex gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>No se borra nada. El desembolso original ({formatCurrency(sale.valorVenta, currency)}{sale.fechaDesembolso ? `, ${formatDate(sale.fechaDesembolso)}` : ''}) y
            cada pago se conservan con su fecha. Si cambia el valor entregado, la diferencia es un movimiento nuevo de la cuenta que pagó (custodia del
            trabajador, fondos de la ruta o bolsa del Administrador). No se puede corregir en un periodo cerrado.</p>
        </div>
        {pagos && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 space-y-1.5" data-testid="rectify-payments">
            <p className="font-semibold flex items-center gap-1.5"><Receipt className="w-4 h-4 text-gray-500" aria-hidden />Pagos de esta venta</p>
            {pagos.active === 0 && pagos.reversed === 0
              ? <p>No tiene pagos registrados.</p>
              : <>
                <p>{pagos.active} vigente{pagos.active === 1 ? '' : 's'} · {pagos.reversed} anulado{pagos.reversed === 1 ? '' : 's'}
                  {pagos.reapplied > 0 ? ` · ${pagos.reapplied} reaplicado${pagos.reapplied === 1 ? '' : 's'}` : ''} ·
                  pagado neto <span className="font-semibold">{formatCurrency(pagos.netPaid, currency)}</span>
                  {pagos.lastPaymentDate ? ` (último ${formatDate(pagos.lastPaymentDate)})` : ''}</p>
                <p className="text-xs text-gray-600">Los pagos no cambian. Las parcelas se recalculan con el pagado neto y, si cambia la tasa o el capital,
                  la parte de lo ya cobrado que corresponde a capital e interés se reclasifica hoy, sin mover efectivo. El total corregido no puede quedar
                  por debajo de {formatCurrency(check?.minTotal ?? 0, currency)}.</p>
                {pagos.reversed > 0 && <p className="text-xs text-gray-600">Los pagos anulados que fueron reales pueden reaplicarse después desde el detalle
                  de la venta (botón «Reaplicar»), con su fecha original si su semana sigue abierta.</p>}
              </>}
            {delta !== 0 && (check?.capitalBlockers ?? []).length === 0 && <p className="text-xs text-gray-600">Cambio de capital: se aplican los controles del desembolso.</p>}
          </div>
        )}
        {checkFailed && <p className="text-sm text-red-600">No se pudo comprobar la venta con el servidor. Cierre y vuelva a intentarlo.</p>}
        {!check && !checkFailed && <p className="text-sm text-gray-500">Comprobando la venta con el servidor…</p>}
        {bloqueos.length > 0 && (
          <div className="rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-800 space-y-1" data-testid="rectify-blockers">
            <p className="font-semibold">Esta venta no se puede corregir ahora:</p>
            <ul className="list-disc pl-5 space-y-0.5">{bloqueos.map(b => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}</ul>
            {caso && <p className="text-xs">Puede registrar el caso para revisión (con motivo y evidencia). No modifica la venta ni el dinero.</p>}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Valor realmente entregado" type="number" inputMode="decimal" min={0} step="0.01" value={String(valor)}
            onChange={e => setValor(Number(e.target.value))} required />
          <Select label="Tasa" value={String(tasa)} onChange={e => setTasa(Number(e.target.value))}
            options={[{ value: '10', label: '10%' }, { value: '20', label: '20%' }]} />
          <Select label="Frecuencia" value={freq} onChange={e => setFreq(e.target.value as PaymentFrequency)} options={FREQ_OPTIONS} />
          <Input label="Fecha de inicio" type="date" value={inicio} min={sale.fechaDesembolso} onChange={e => setInicio(e.target.value)} required />
        </div>
        {delta !== 0 && (
          <p className="text-sm text-gray-700">
            {delta > 0
              ? <>Saldrán <span className="font-semibold">{formatCurrency(delta, currency)}</span> más de la cuenta que pagó el desembolso (debe tenerlos).</>
              : <>Vuelven <span className="font-semibold">{formatCurrency(-delta, currency)}</span> a la cuenta que pagó el desembolso (no se entregaron).</>}
          </p>
        )}
        <ApprovalInstallments amount={valor} rate={tasa} count={cuotas} onCount={setCuotas} currency={currency} requested={sale.numeroCuotas} />
        {cuotas < sale.numeroCuotas && (
          <p className="text-xs text-gray-600">Las parcelas que sobran quedan como «sustituidas» en el historial: no se cobran ni cuentan como deuda.</p>
        )}
        <div>
          <p className="block text-sm font-medium text-gray-700 mb-1.5">Días de pago</p>
          <div className="flex flex-wrap gap-2">
            {WEEK_DAYS.map(d => {
              const on = dias.includes(d.value)
              return (
                <button key={d.value} type="button" aria-pressed={on}
                  onClick={() => setDias(p => on ? p.filter(x => x !== d.value) : [...p, d.value].sort((a, b) => a - b))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${on ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>
        <Textarea label="Motivo de la corrección" rows={2} value={motivo} onChange={e => setMotivo(e.target.value)} required
          hint="Mínimo 10 caracteres. Ej.: el trabajador entregó R$ 1.500 y registró R$ 1.400." />
        <Textarea label="Evidencia" rows={2} value={evidencia} onChange={e => setEvidencia(e.target.value)} required
          hint="Mínimo 10 caracteres. Ej.: confirmado por teléfono con el cliente el 22/10 a las 15:10." />
        <label className="flex items-start gap-2.5 cursor-pointer select-none text-sm text-gray-800">
          <input type="checkbox" checked={sinPendientes} onChange={e => { setSinPendientes(e.target.checked); if (e.target.checked) setOfflinePending(false) }} className="w-4 h-4 mt-0.5 rounded border-gray-300 text-primary-600" />
          Confirmé con el trabajador que no tiene cobros de esta venta guardados sin conexión pendientes de enviar.
        </label>
        <label className="flex items-start gap-2.5 cursor-pointer select-none text-sm text-gray-800">
          <input type="checkbox" checked={offlinePending} onChange={e => { setOfflinePending(e.target.checked); if (e.target.checked) setSinPendientes(false) }} className="w-4 h-4 mt-0.5 rounded border-gray-300 text-primary-600" />
          El trabajador tiene cobros sin conexión pendientes (no se puede corregir todavía).
        </label>
      </div>
    </Modal>
  )
}
