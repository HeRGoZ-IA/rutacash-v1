import { useCallback, useEffect, useState } from 'react'
import LoginPage from '@/pages/auth/LoginPage'
import { SetupPage } from '@/pages/auth/SetupPage'
import { getInstallationState, type InstallationState } from '@/services/platformBootstrapService'

/**
 * PUERTA DE ENTRADA. Decide qué se muestra en `/login` según el estado real de la
 * instalación, leído de la base:
 *
 *   sin ningún Super Admin  →  Configuración inicial / Recuperación (NO el login)
 *   con Super Admin         →  Login normal
 *
 * Se consulta después de que App haya terminado su arranque, para que en DEMO —donde
 * el seed crea un Super Admin— nunca aparezca la pantalla de configuración.
 */
export default function AuthEntry() {
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

  if (!state.initialized) return <SetupPage state={state} onDone={refresh} />
  return <LoginPage />
}
