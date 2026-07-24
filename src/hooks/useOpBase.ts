import { useLocation } from 'react-router-dom'

/**
 * Base de la CAPA OPERATIVA compartida (App Cobrador / App Supervisor).
 * Devuelve `/supervisor` o `/collector` según la URL actual, de modo que las
 * mismas pantallas y el mismo layout sirvan a ambos roles sin duplicar lógica.
 * El rol y la auditoría siguen siendo los del usuario real (no se transforma el rol).
 */
export function useOpBase(): '/supervisor' | '/collector' {
  const { pathname } = useLocation()
  return pathname.startsWith('/supervisor') ? '/supervisor' : '/collector'
}
