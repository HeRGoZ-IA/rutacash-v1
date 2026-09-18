import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toast'
import { factoryResetAndRestart } from '@/lib/factoryReset'

/**
 * CONFIRMACIÓN DEL RESTABLECIMIENTO DE FÁBRICA.
 *
 * Vive en `components/owner/` y no en `components/ui/` a propósito: es una pieza del
 * portal de plataforma, no un componente de uso general. Ningún archivo del portal de
 * empresa lo importa, y hay una prueba que lo verifica.
 *
 * La barrera es escribir la palabra, no marcar una casilla: un clic accidental no
 * puede borrar una instalación entera. No se vuelve a pedir la contraseña — el Owner
 * ya está autenticado y encadenar otro formulario de credenciales sería exactamente
 * el tipo de fricción que esta entrega elimina.
 */

/** Palabra que la persona debe escribir para habilitar el borrado. */
export const FACTORY_RESET_PHRASE = 'RESTABLECER'

/**
 * ¿Lo escrito habilita el borrado? Se ignoran mayúsculas y espacios sobrantes
 * (escribir la palabra ya es la barrera; pelear con el teclado no añade seguridad),
 * pero NUNCA basta con un clic: hay que teclearla.
 */
export function matchesFactoryResetPhrase(input: string): boolean {
  return input.trim().replace(/\s+/g, ' ').toUpperCase() === FACTORY_RESET_PHRASE
}

export function FactoryResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [frase, setFrase] = useState('')
  const [borrando, setBorrando] = useState(false)

  const habilitado = matchesFactoryResetPhrase(frase) && !borrando

  function cerrar() {
    if (borrando) return       // no se puede cancelar a mitad del borrado
    setFrase('')
    onClose()
  }

  async function ejecutar() {
    if (!habilitado) return
    setBorrando(true)          // impide el doble clic
    try {
      // Borra la base, ambas sesiones, cachés y service workers, y recarga en
      // /owner/login. No vuelve de aquí si todo va bien.
      const hecho = await factoryResetAndRestart()
      if (!hecho) {
        toast.error('El restablecimiento está desactivado en esta instalación.')
        setBorrando(false)
      }
    } catch {
      toast.error('No se pudieron eliminar los datos. Inténtalo de nuevo.')
      setBorrando(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title="Restablecer RutaCash a cero"
      footer={
        <>
          <Button variant="secondary" onClick={cerrar} disabled={borrando}>Cancelar</Button>
          <Button
            variant="danger"
            onClick={ejecutar}
            disabled={!habilitado}
            icon={borrando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          >
            {borrando ? 'Eliminando datos...' : 'Eliminar todo'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3.5 bg-red-50 rounded-xl border border-red-200">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
          <div className="space-y-2 text-sm text-red-700">
            <p>
              Se eliminarán todos los datos locales de RutaCash, incluidos Owners,
              empresas y operaciones. Esta acción no se puede deshacer.
            </p>
            <p className="font-semibold">
              Tu propia cuenta de Owner también se borra: al terminar tendrás que crear
              el primer Owner de nuevo.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Para confirmar, escribe <span className="font-mono font-semibold">{FACTORY_RESET_PHRASE}</span>
          </label>
          <input
            type="text"
            value={frase}
            onChange={e => setFrase(e.target.value)}
            disabled={borrando}
            placeholder={FACTORY_RESET_PHRASE}
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
