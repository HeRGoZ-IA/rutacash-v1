import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { AlertTriangle } from 'lucide-react'

/**
 * Confirmación reutilizable de "cambios sin guardar" (X / Cancelar con draft sucio).
 * "Seguir editando" mantiene el editor abierto; "Descartar cambios" cierra sin guardar.
 * `note` permite aclarar casos como asignaciones que ya se guardaron por separado.
 */
export function ConfirmDiscardModal({
  open, onKeepEditing, onDiscard, note,
}: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
  note?: string
}) {
  return (
    <Modal open={open} onClose={onKeepEditing} title="Cambios sin guardar" size="sm"
      footer={<>
        <Button variant="secondary" onClick={onKeepEditing}>Seguir editando</Button>
        <Button variant="danger" onClick={onDiscard}>Descartar cambios</Button>
      </>}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
        <div className="space-y-2">
          <p className="text-sm text-gray-700">Hay cambios sin guardar. ¿Deseas descartarlos?</p>
          {note && <p className="text-xs text-gray-400">{note}</p>}
        </div>
      </div>
    </Modal>
  )
}
