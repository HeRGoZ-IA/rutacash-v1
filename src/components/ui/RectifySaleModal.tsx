import { useMemo, useState } from 'react'
import { AlertTriangle, PencilLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { ApprovalInstallments } from '@/components/ui/ApprovalInstallments'
import { toast } from '@/components/ui/Toast'
import { formatCurrency } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { rectifyDisbursedSale } from '@/services/saleRequestService'
import type { PaymentFrequency, Sale, User } from '@/models/types'

const FREQ_OPTIONS = [
  { value: 'diaria', label: 'Diaria' }, { value: 'semanal', label: 'Semanal' },
  { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' },
]
const WEEK_DAYS = [
  { value: 1, label: 'Lun' }, { value: 2, label: 'Mar' }, { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' }, { value: 5, label: 'Vie' }, { value: 6, label: 'Sáb' }, { value: 0, label: 'Dom' },
]

/**
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

  const delta = Math.round((valor - sale.valorVenta) * 100) / 100
  const cambia = delta !== 0 || tasa !== sale.tasaInteres || cuotas !== sale.numeroCuotas || freq !== sale.frecuenciaPago
    || inicio !== sale.fechaInicio || JSON.stringify(dias) !== JSON.stringify(sale.paymentDays ?? [])
  const listo = cambia && valor > 0 && Number.isInteger(cuotas) && cuotas >= sale.numeroCuotas && cuotas <= 1000 && dias.length > 0
    && motivo.trim().length >= 10 && evidencia.trim().length >= 10 && sinPendientes

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
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Corregir venta desembolsada" size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={guardar} loading={saving} disabled={!listo} icon={<PencilLine className="w-4 h-4" />}>Registrar corrección</Button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800 flex gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>Solo para ventas sin cobros cuyo desembolso no esté en un cuadre ni en un periodo cerrado. No se borra nada: el desembolso
            original ({formatCurrency(sale.valorVenta, currency)}{sale.fechaDesembolso ? `, ${sale.fechaDesembolso}` : ''}) se conserva y la diferencia
            se registra como un movimiento nuevo de la cuenta que pagó (custodia del trabajador o bolsa).</p>
        </div>
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
          <p className="text-xs text-red-600">No se puede reducir el número de parcelas de una venta desembolsada (decisión pendiente del propietario).</p>
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
          <input type="checkbox" checked={sinPendientes} onChange={e => setSinPendientes(e.target.checked)} className="w-4 h-4 mt-0.5 rounded border-gray-300 text-primary-600" />
          Confirmé con el trabajador que no tiene cobros de esta venta guardados sin conexión pendientes de enviar.
        </label>
      </div>
    </Modal>
  )
}
