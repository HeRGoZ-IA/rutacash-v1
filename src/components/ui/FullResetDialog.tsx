import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { resetLocalAppData } from '@/lib/resetApp'

/**
 * RESTABLECIMIENTO TOTAL — «volver a Usuario 0».
 *
 * ÚNICO diálogo destructivo de la instalación CLEAN. Se comparte entre Configuración
 * y la pantalla de recuperación para que exista UN SOLO mecanismo de borrado y UNA
 * SOLA experiencia de confirmación.
 *
 * No implementa borrado propio: delega en `resetLocalAppData()`, que ya borra la base
 * completa, las claves locales `rutacash-*`, la Cache Storage y los Service Workers.
 * Tras recargar, el arranque CLEAN no siembra nada y `getInstallationState()` vuelve
 * a `empty`, de modo que aparece «Configurar RutaCash».
 */

/** Frase que la persona debe escribir para habilitar el borrado. */
export const RESET_CONFIRM_PHRASE = 'BORRAR TODO'

/**
 * ¿Lo escrito habilita el borrado? Se ignoran mayúsculas y los espacios sobrantes
 * (escribir bien la frase ya es la barrera; pelear con el teclado no aporta
 * seguridad), pero NUNCA basta con un clic: hay que teclearla.
 */
export function matchesResetPhrase(input: string): boolean {
  return input.trim().replace(/\s+/g, ' ').toUpperCase() === RESET_CONFIRM_PHRASE
}

export function FullResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [frase, setFrase] = useState('')
  const [borrando, setBorrando] = useState(false)

  const habilitado = matchesResetPhrase(frase) && !borrando

  function cerrar() {
    if (borrando) return       // no se puede cancelar a mitad del borrado
    setFrase('')
    onClose()
  }

  async function ejecutar() {
    if (!habilitado) return
    setBorrando(true)          // impide el doble clic
    try {
      await resetLocalAppData()
      // Redirección dura: el documento se recarga y la app arranca desde cero.
      location.replace('/login')
    } catch {
      toast.error('No se pudieron eliminar los datos. Inténtalo de nuevo.')
      setBorrando(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title="Restablecer RutaCash desde cero"
      footer={
        <>
          <Button variant="secondary" onClick={cerrar} disabled={borrando}>Cancelar</Button>
          <Button
            variant="danger"
            onClick={ejecutar}
            disabled={!habilitado}
            icon={borrando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          >
            {borrando ? 'Eliminando datos...' : 'Eliminar todo y empezar de cero'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3.5 bg-red-50 rounded-xl border border-red-200">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
          <div className="space-y-2 text-sm text-red-700">
            <p>
              Se eliminarán permanentemente todos los datos de RutaCash almacenados en este
              dispositivo, incluyendo usuarios, empresas, rutas, clientes, ventas, parcelas,
              pagos, gastos y configuración.
            </p>
            <p>
              RutaCash volverá al estado inicial y tendrás que crear nuevamente el primer
              Super Admin.
            </p>
            <p className="font-semibold">Esta acción no se puede deshacer.</p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Para confirmar, escribe <span className="font-mono font-semibold">{RESET_CONFIRM_PHRASE}</span>
          </label>
          <input
            type="text"
            value={frase}
            onChange={e => setFrase(e.target.value)}
            disabled={borrando}
            placeholder={RESET_CONFIRM_PHRASE}
            autoComplete="off"
            className="w-full h-11 rounded-xl border border-gray-300 px-4 text-sm font-mono tracking-wide focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-gray-50"
          />
          <p className="text-xs text-gray-400 mt-1.5">
            Solo afecta a este dispositivo. No se borran datos de otros equipos.
          </p>
        </div>
      </div>
    </Modal>
  )
}
