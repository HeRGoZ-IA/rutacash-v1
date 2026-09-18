import { useCallback, useEffect, useState } from 'react'
import LoginPage from '@/pages/auth/LoginPage'
import { EmptyInstallationNotice } from '@/pages/auth/EmptyInstallationNotice'
import { getInstallationState, type InstallationState } from '@/services/platformBootstrapService'

/**
 * PUERTA DE ENTRADA DE LAS EMPRESAS (`/login`).
 *
 * Aquí entran SuperAdmin, Admin, Supervisor, Secretario, Socio y Cobrador. Nada más.
 * El arranque de la instalación ya no ocurre en esta pantalla: crear la cuenta raíz
 * es asunto de la PLATAFORMA y vive en `/owner/login`.
 *
 * El único caso especial es la instalación completamente virgen: no hay ni una sola
 * empresa ni un solo usuario, así que ofrecer un formulario de acceso sería ofrecer
 * una puerta sin llave posible. En ese caso se explica en una línea dónde empieza
 * todo, con un enlace al portal Owner. Con cualquier usuario ya creado, se muestra el
 * login normal.
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

  // Instalación sin NINGÚN usuario de empresa: no hay cuenta con la que entrar.
  if (state.userCount === 0) return <EmptyInstallationNotice />
  return <LoginPage />
}
