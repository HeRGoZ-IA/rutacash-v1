import { useRef, useState } from 'react'
import { Ban, CornerDownRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@/lib/formatters'
import { normalizeReversalReason, REVERSAL_REASON_MAX } from '@/lib/movementReversal'
import type { MovementReversalFields } from '@/models/types'

// Anulación auditable de movimientos de fondos (ajustes del socio 2026-10-02, punto 3).
// Piezas compartidas por Capital, Retiros y Transferencias.

/** Botón de fila "Anular" (solo se renderiza cuando el movimiento es anulable y el usuario puede). */
export function ReverseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Anular movimiento" title="Anular movimiento"
      className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg px-2 py-1">
      <Ban className="w-3.5 h-3.5" /> Anular
    </button>
  )
}

export function AnnulledBadge() {
  return <Badge variant="danger" size="sm">Anulado</Badge>
}

/** Línea bajo un movimiento anulado: su reversión, quién, cuándo y por qué. */
export function ReversalDetail({ original, reversal, currency, signo, userName }: {
  original: MovementReversalFields
  reversal?: { valor?: number; fecha: string } & MovementReversalFields
  currency: string
  /** Signo con el que la vista muestra el original (+1 entra, −1 sale). */
  signo: 1 | -1
  userName: (id?: string) => string | undefined
}) {
  const valor = reversal?.valor
  const quien = userName(original.reversedByUserId)
  return (
    <div className="flex items-start gap-1.5 pl-12 pb-3 -mt-1 text-xs text-gray-500">
      <CornerDownRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" />
      <p>
        Reversión{valor !== undefined ? ` ${signedMoney(signo * valor, currency)}` : ''}
        {original.reversedAt ? ` · ${formatDate(original.reversedAt)}` : ''}{quien ? ` · ${quien}` : ''}
        {original.reversalReason ? <> · Motivo: <span className="text-gray-700">{original.reversalReason}</span></> : null}
      </p>
    </div>
  )
}

/** "+$ 1.000" / "−$ 1.000" según el signo del valor efectivo. */
export function signedMoney(v: number, currency: string): string {
  return `${v < 0 ? '−' : '+'}${formatCurrency(Math.abs(v), currency)}`
}

export interface ReversalTarget {
  tipo: string
  valor: number
  fecha: string
  detalle?: string
}

/**
 * Confirmación de anulación: identifica el movimiento, exige motivo y bloquea el
 * doble envío (estado + ref). `onConfirm` lanza si el servicio rechaza.
 */
export function ReverseMovementModal({ target, currency, onCancel, onConfirm }: {
  target: ReversalTarget | null
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
      setError(e instanceof Error ? e.message : 'No se pudo anular el movimiento.')
    } finally {
      enCurso.current = false
      setWorking(false)
    }
  }

  return (
    <Modal open={!!target} onClose={cerrar} title="Anular movimiento" size="sm"
      footer={<>
        <Button variant="secondary" onClick={cerrar} disabled={working}>Cancelar</Button>
        <Button variant="danger" onClick={confirmar} loading={working} disabled={!motivo || working} icon={<Ban className="w-4 h-4" />}>Anular</Button>
      </>}>
      {target && (
        <div className="space-y-3">
          <div className="rounded-xl bg-gray-50 p-3 text-sm">
            <p className="font-semibold text-gray-900">{target.tipo} · {formatCurrency(target.valor, currency)}</p>
            <p className="text-xs text-gray-500">{formatDate(target.fecha)}{target.detalle ? ` · ${target.detalle}` : ''}</p>
          </div>
          <p className="text-xs text-gray-500">
            El movimiento quedará registrado como anulado y se creará una reversión por el mismo valor que corrige el saldo.
          </p>
          <Textarea label="Motivo" required rows={2} maxLength={REVERSAL_REASON_MAX} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Ej: valor duplicado, error de digitación" />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  )
}
