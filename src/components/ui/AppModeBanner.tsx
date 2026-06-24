import { IS_DEMO, IS_CLEAN } from '@/lib/appMode'
import { resetLocalAppData } from '@/lib/resetApp'

async function wipeAndRestart() {
  await resetLocalAppData()
  // Recarga dura: reinicia la semilla del modo actual (DEMO o CLEAN).
  location.replace('/login')
}

export function AppModeBanner() {
  function handleResetDemo() {
    if (!window.confirm('Esto borrará todos los datos locales y restaurará los datos demo. ¿Continuar?')) return
    void wipeAndRestart()
  }

  function handleResetClean() {
    if (!window.confirm('Esto eliminará todos los datos locales de RutaCash en este navegador y dejará la app limpia desde cero. Esta acción no se puede deshacer. ¿Continuar?')) return
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
      <div className="bg-primary-900 text-primary-300 text-xs text-center py-1.5 font-medium tracking-wide flex items-center justify-center gap-3">
        <span>MODO LIMPIO — Datos nuevos</span>
        <button
          onClick={handleResetClean}
          className="underline hover:no-underline opacity-70 hover:opacity-100 transition-opacity"
        >
          Restablecer app limpia
        </button>
      </div>
    )
  }

  return null
}
