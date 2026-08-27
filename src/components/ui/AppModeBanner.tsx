import { useState } from 'react'
import { IS_DEMO, IS_CLEAN } from '@/lib/appMode'
import { resetLocalAppData } from '@/lib/resetApp'
import { FullResetDialog } from '@/components/ui/FullResetDialog'

async function wipeAndRestart() {
  await resetLocalAppData()
  // Recarga dura: reinicia la semilla del modo actual (DEMO o CLEAN).
  location.replace('/login')
}

export function AppModeBanner() {
  // CLEAN comparte el diálogo destructivo con Configuración y con la pantalla de
  // recuperación: un solo mecanismo y una sola confirmación en toda la app.
  const [resetOpen, setResetOpen] = useState(false)

  function handleResetDemo() {
    if (!window.confirm('Esto borrará todos los datos locales y restaurará los datos demo. ¿Continuar?')) return
    void wipeAndRestart()
  }

  if (IS_DEMO) {
    return (
      <div className="bg-amber-100 text-amber-900 text-xs text-center py-1.5 font-semibold flex items-center justify-center gap-3 border-b border-amber-200">
        <span>MODO DEMO — Datos ficticios</span>
        <button
          onClick={handleResetDemo}
          className="underline hover:no-underline opacity-60 hover:opacity-100 transition-opacity"
        >
          Restaurar datos demo
        </button>
      </div>
    )
  }

  if (IS_CLEAN) {
    return (
      <>
        <div className="bg-primary-900 text-primary-300 text-xs text-center py-1.5 font-medium tracking-wide flex items-center justify-center gap-3">
          <span>MODO LIMPIO — Datos nuevos</span>
          <button
            onClick={() => setResetOpen(true)}
            className="underline hover:no-underline opacity-70 hover:opacity-100 transition-opacity"
          >
            Restablecer desde cero
          </button>
        </div>
        <FullResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />
      </>
    )
  }

  return null
}
