import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { generateId } from '@/lib/utils'
import { checkPaymentReapply, reapplyAnnulledPayment, type PaymentReapplyCheck } from '@/services/paymentCorrectionService'
import type { Payment } from '@/models/types'

/** Por qué no se puede reaplicar (texto para el Administrador). */
const BLOCKER_TEXT: Record<string, string> = {
  NOT_REVERSED: 'Solo se reaplica un pago anulado.',
  CORRECTED: 'El pago fue corregido: su reemplazo ya existe.',
  ALREADY_REAPPLIED: 'Este pago ya se reaplicó.',
  PERIOD_CLOSED: 'El periodo de hoy de la ruta está cerrado.',
  CREDIT_NOT_ACTIVE: 'La venta no está activa.',
  OVERPAYMENT: 'Reaplicarlo superaría el saldo de la venta.',
  LEGACY_PAYMENTS: 'El pago no tiene asiento en el libro: no se sabe qué cuenta lo recibió.',
  CUSTODIAN_CHANGED: 'El trabajador que recibió el pago ya no tiene caja en esta ruta.',
  REVERSAL_SETTLED: 'La anulación ya entró en un cuadre del trabajador: ese efectivo pudo quedar como sobrante. Sin política de conciliación aprobada no se reaplica.',
  POOL_OF_ANOTHER_ADMIN: 'El pago entró a la cuenta de otro Administrador (su bolsa o los fondos de una ruta a su cargo): solo ese Administrador puede reaplicarlo.',
}

/**
 * Bloque A post-R73 (0032): reaplicar un pago ANULADO que sí ocurrió. El mismo efectivo vuelve a
 * la misma cuenta que lo recibió, con la fecha original si su semana sigue abierta, en una
 * operación nueva enlazada al pago anulado. No crea dinero: la anulación lo había retirado.
 * Uso típico: anular los abonos para corregir la tasa de la venta y luego reaplicarlos.
 */
export function ReapplyPaymentModal({ payment, cliente, currency, onCancel, onDone }: {
  payment: Payment | null
  cliente: string
  currency: string
  onCancel: () => void
  onDone: () => Promise<void> | void
}) {
  const [check, setCheck] = useState<PaymentReapplyCheck | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  // Un id por intención: un reintento nunca registra dos veces.
  const operationId = useMemo(() => generateId(), [payment?.id])

  useEffect(() => {
    setCheck(null); setFailed(null); setReason('')
    if (payment) void checkPaymentReapply(payment.id).then(setCheck, (e) => setFailed(e instanceof Error ? e.message : String(e)))
  }, [payment?.id])

  if (!payment) return null
  const blocked = (check?.blockers ?? []).length > 0
  const listo = check !== null && !blocked && reason.trim().length >= 10

  async function confirmar() {
    if (!payment || !listo || saving) return
    setSaving(true)
    try {
      await reapplyAnnulledPayment({ paymentId: payment.id, reason, operationId })
      toast.success('Pago reaplicado. La venta se recalculó.')
      await onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo reaplicar el pago')
    } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onCancel} title="Reaplicar pago anulado" size="md"
      footer={<>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancelar</Button>
        <Button onClick={confirmar} loading={saving} disabled={!listo} icon={<RotateCcw className="w-4 h-4" />}>Reaplicar pago</Button>
      </>}>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-500">Cliente</dt><dd className="text-gray-900 truncate" title={cliente}>{cliente}</dd>
          <dt className="text-gray-500">Valor</dt><dd className="text-gray-900 font-semibold">{formatCurrency(payment.valor, currency)}</dd>
          <dt className="text-gray-500">Fecha original</dt><dd className="text-gray-900">{formatDate(payment.fecha)}</dd>
          {check && <><dt className="text-gray-500">Fecha al reaplicar</dt><dd className="text-gray-900">{formatDate(check.reapplyDate)}</dd></>}
          {check?.receiverKind && <><dt className="text-gray-500">Vuelve a</dt>
            <dd className="text-gray-900">{check.receiverKind === 'custody' ? 'La caja del trabajador que lo cobró' : 'La bolsa que lo recibió'}</dd></>}
        </dl>
        <p className="text-sm text-gray-600">Úselo solo si el cliente sí pagó: el efectivo que la anulación retiró vuelve a la misma cuenta. El pago anulado y su
          anulación se conservan en el historial.</p>
        {failed && <p className="text-sm text-red-600">{failed}</p>}
        {!check && !failed && <p className="text-sm text-gray-500">Comprobando con el servidor…</p>}
        {blocked && (
          <div className="rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-800" role="alert">
            <p className="font-semibold">No se puede reaplicar:</p>
            <ul className="list-disc pl-5 space-y-0.5">{check!.blockers.map(b => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}</ul>
          </div>
        )}
        {!blocked && (
          <Textarea label="Motivo" rows={2} value={reason} onChange={e => setReason(e.target.value)} required
            hint="Mínimo 10 caracteres. Ej.: abono real anulado para corregir la tasa de la venta." />
        )}
      </div>
    </Modal>
  )
}
