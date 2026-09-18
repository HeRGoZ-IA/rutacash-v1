import { useCallback, useEffect, useState } from 'react'
import OwnerLoginPage from '@/pages/owner/OwnerLoginPage'
import { OwnerSetupPage } from '@/pages/owner/OwnerSetupPage'
import { getInstallationState, type InstallationState } from '@/services/platformBootstrapService'

/**
 * PUERTA DE ENTRADA DE LA PLATAFORMA (`/owner/login`).
 *
 * Decide qué se muestra según el estado REAL de la instalación, leído de la base:
 *
 *   sin ningún Owner  →  Configuración inicial / Recuperación (NO el login)
 *   con Owner         →  Login del portal Owner
 *
 * Aquí es donde arranca una instalación limpia: la primera acción del sistema es que
 * una persona cree su propio Owner. Después, desde el portal, dará de alta la primera
 * empresa con su primer Super Admin.
 */
export default function OwnerAuthEntry() {
  const [state, setState] = useState<InstallationState | null>(null)

  const refresh = useCallback(() => {
    getInstallationState()
      .then(setState)
      .catch(() => setState(null))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="w-8 h-8 border-2 border-primary-300/30 border-t-primary-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!state.initialized) return <OwnerSetupPage state={state} onDone={refresh} />
  return <OwnerLoginPage />
}
