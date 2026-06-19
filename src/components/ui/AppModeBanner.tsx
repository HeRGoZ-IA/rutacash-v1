import { IS_DEMO, IS_CLEAN } from '@/lib/appMode'
import { resetToDemo } from '@/data/seed'

export function AppModeBanner() {
  function handleResetDemo() {
    if (!window.confirm('Esto borrará todos los datos actuales y restaurará los datos demo. ¿Continuar?')) return
    resetToDemo()
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
      <div className="bg-primary-900 text-primary-300 text-xs text-center py-1.5 font-medium tracking-wide">
        MODO LIMPIO — Datos nuevos
      </div>
    )
  }

  return null
}
