import { useRef, useState } from 'react'
import { Ban, CornerDownRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/formatters'
import { normalizeReversalReason, REVERSAL_REASON_MAX } from '@/lib/movementReversal'
import type { PaymentDisplayState } from '@/lib/paymentState'
import type { Payment } from '@/models/types'

// Anulación administrativa de pagos (ajustes del socio 2026-10-02, punto 7).
// Piezas compartidas por el detalle de venta (Admin), la ficha del cliente y el
// histórico de abonos del Cobrador.

export const PAYMENT_ANNULMENT_REASONS = [
  'Pago duplicado',
  'Valor digitado incorrectamente',
  'Pago asignado al cliente equivocado',
  'Registro accidental',
]

/** Botón de fila "Anular" (solo se renderiza cuando el pago es anulable y el usuario puede). */
export function AnnulPaymentButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Anular pago" title="Anular pago"
      className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg px-2 py-1">
      <Ban className="w-3.5 h-3.5" /> Anular
    </button>
  )
}

export function PaymentStateBadge({ state }: { state: PaymentDisplayState }) {
  if (state === 'anulado') return <Badge variant="danger" size="sm">Anulado</Badge>
  if (state === 'corregido') return <Badge variant="warning" size="sm">Corregido</Badge>
  return null
}

/** Línea bajo un pago anulado: reversión, cuándo, quién y por qué. */
export function PaymentAnnulmentDetail({ original, reversal, currency, userName }: {
  original: Pick<Payment, 'correctedAt' | 'correctedBy' | 'correctionReason'>
  reversal?: Pick<Payment, 'valor'>
  currency: string
  userName?: (id?: string) => string | undefined
}) {
  const quien = userName?.(original.correctedBy)
  return (
    <div className="flex items-start gap-1.5 pt-1 text-xs text-gray-500">
      <CornerDownRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" />
      <p>
        Reversión{reversal ? ` −${formatCurrency(Math.abs(reversal.valor), currency)}` : ''}
        {original.correctedAt ? ` · ${formatDateTime(original.correctedAt)}` : ''}{quien ? ` · ${quien}` : ''}
        {original.correctionReason ? <> · Motivo: <span className="text-gray-700">{original.correctionReason}</span></> : null}
      </p>
    </div>
  )
}

export interface AnnulPaymentTarget {
  cliente: string
  credito: string
  valor: number
  fecha: string
  cobrador?: string
  ruta?: string
  /** "Parcelas #3–#4", si se conoce. */
  parcelas?: string
}

/**
 * Confirmación de anulación de un pago: identifica el pago, exige motivo y
 * bloquea el doble envío (estado + ref). `onConfirm` lanza si el servicio rechaza.
 */
export function AnnulPaymentModal({ target, currency, onCancel, onConfirm }: {
  target: AnnulPaymentTarget | null
  currency: string
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enCurso = useRef(false)
  const motivo = normalizeReversalReason(reason)

  const cerrar = () => { if (enCurso.current) return; setReason(''); setError(null); onCancel() }

  async function confirmar() {
    if (!motivo || enCurso.current) return
    enCurso.current = true
    setWorking(true); setError(null)
    try {
      await onConfirm(motivo)
      setReason('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo anular el pago.')
    } finally {
      enCurso.current = false
      setWorking(false)
    }
  }

  return (
    <Modal open={!!target} onClose={cerrar} title="Anular pago" size="sm"
      footer={<>
        <Button variant="secondary" onClick={cerrar} disabled={working}>Cancelar</Button>
        <Button variant="danger" onClick={confirmar} loading={working} disabled={!motivo || working} icon={<Ban className="w-4 h-4" />}>Anular pago</Button>
      </>}>
      {target && (
        <div className="space-y-3">
          <div className="rounded-xl bg-gray-50 p-3 text-sm">
            <p className="font-semibold text-gray-900">{target.cliente} · {formatCurrency(target.valor, currency)}</p>
            <p className="text-xs text-gray-500">
              {formatDate(target.fecha)} · Crédito {target.credito}
              {target.parcelas ? ` · ${target.parcelas}` : ''}
            </p>
            {(target.cobrador || target.ruta) && (
              <p className="text-xs text-gray-500">{[target.cobrador && `Cobró: ${target.cobrador}`, target.ruta && `Ruta: ${target.ruta}`].filter(Boolean).join(' · ')}</p>
            )}
          </div>
          <p className="text-xs text-gray-500">
            El pago quedará en el historial como anulado. El saldo, las parcelas y el estado del crédito se recalculan, y la Base y el efectivo de quien cobró bajan por el mismo valor.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_ANNULMENT_REASONS.map(r => (
              <button key={r} type="button" onClick={() => setReason(r)}
                className={`text-xs rounded-full px-2.5 py-1 border ${reason === r ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {r}
              </button>
            ))}
          </div>
          <Textarea label="Motivo" required rows={2} maxLength={REVERSAL_REASON_MAX} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Ej: pago duplicado" />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
