import { useState } from 'react'
import { AlertTriangle, PlayCircle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import type { CompanyCommercialStatus } from '@/platform/types'

/**
 * CONFIRMACIÓN DE SUSPENDER / REACTIVAR una empresa (Owner, Ronda 48 · H-01).
 *
 * Antes, un clic en el enlace de la fila cambiaba el estado comercial al instante.
 * Suspender deja a TODA la empresa sin operar (sus usuarios no pueden entrar ni
 * registrar cobros), así que el cambio pasa siempre por aquí: empresa nombrada,
 * acción exacta, efecto y una confirmación explícita.
 *
 * No decide nada comercial: solo pide confirmación y llama a `onConfirm`, que ejecuta
 * el comando de siempre. El botón queda ocupado mientras el servidor responde (sin
 * doble envío) y el modal solo se cierra cuando `onConfirm` termina bien.
 */
export interface CompanyStatusTarget {
  nombre: string
  status: CompanyCommercialStatus
}

export function CompanyStatusConfirmModal({ target, onClose, onConfirm }: {
  target: CompanyStatusTarget | null
  onClose: () => void
  /** Ejecuta el cambio. Devuelve true si el servidor lo confirmó. */
  onConfirm: () => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  if (!target) return null
  const suspender = target.status !== 'suspended'

  async function confirmar() {
    if (busy) return
    setBusy(true)
    try {
      if (await onConfirm()) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} size="sm"
      title={suspender ? 'Suspender servicio' : 'Reactivar servicio'}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy} autoFocus>Cancelar</Button>
        <Button variant={suspender ? 'danger' : 'success'} onClick={confirmar} loading={busy} data-testid="company-status-confirm">
          {suspender ? 'Suspender servicio' : 'Reactivar servicio'}
        </Button>
      </>}>
      <div className="flex items-start gap-3" data-testid="company-status-dialog">
        {suspender
          ? <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
          : <PlayCircle className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />}
        <div className="space-y-2 text-sm text-gray-700">
          <p>
            {suspender ? 'Vas a suspender el servicio de ' : 'Vas a reactivar el servicio de '}
            <span className="font-semibold text-gray-900">{target.nombre}</span>.
          </p>
          {suspender ? (
            <p>
              Mientras esté suspendida, <span className="font-medium">ninguno de sus usuarios podrá entrar ni registrar
              operaciones</span> (cobros, ventas, caja), también los cobradores que estén en ruta. Sus datos se
              conservan y puedes reactivarla cuando quieras.
            </p>
          ) : (
            <p>La empresa pasa a <span className="font-medium">Activa</span> y sus usuarios podrán volver a entrar y operar.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
