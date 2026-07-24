import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuth } from './useAuth'

/**
 * RUTA ACTIVA — FUENTE ÚNICA DE VERDAD (modelo de roles y permisos).
 *
 * Reemplaza la duplicidad previa entre `useAuth.route` y `useCollectorRoute`.
 * La selección se persiste POR USUARIO (no global): dos usuarios en el mismo
 * navegador no comparten ruta activa. Aplica a los perfiles operativos que
 * pueden tener 0, 1 o varias rutas (cobrador, supervisor, secretario, socio).
 *
 * Comportamiento esperado (lo aplican los layouts):
 *  - 0 rutas: estado sin acceso operativo.
 *  - 1 ruta: autoselección.
 *  - varias: solicitar selección.
 */
interface ActiveRouteStore {
  /** Mapa userId → routeId activo. */
  byUser: Record<string, string>
  _set: (userId: string, id: string | null) => void
}

const useActiveRouteStore = create<ActiveRouteStore>()(
  persist(
    (set) => ({
      byUser: {},
      _set: (userId, id) =>
        set((s) => {
          const next = { ...s.byUser }
          if (id) next[userId] = id
          else delete next[userId]
          return { byUser: next }
        }),
    }),
    { name: 'rutacash-active-route' }
  )
)

/** Ruta activa del usuario en sesión + setter. Persistida por usuario. */
export function useActiveRoute() {
  const userId = useAuth((s) => s.user?.id) ?? ''
  const activeRouteId = useActiveRouteStore((s) => (userId ? s.byUser[userId] ?? null : null))
  const _set = useActiveRouteStore((s) => s._set)
  const setActiveRouteId = (id: string | null) => {
    if (userId) _set(userId, id)
  }
  return { activeRouteId, setActiveRouteId }
}
