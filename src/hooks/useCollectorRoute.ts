import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * App Cobrador — ruta actualmente seleccionada para trabajar.
 * Un cobrador puede tener una o varias rutas autorizadas; esta store guarda
 * cuál está activa. Si solo tiene una, se selecciona esa automáticamente.
 */
interface CollectorRouteState {
  activeRouteId: string | null
  setActiveRouteId: (id: string | null) => void
}

export const useCollectorRoute = create<CollectorRouteState>()(
  persist(
    (set) => ({
      activeRouteId: null,
      setActiveRouteId: (id) => set({ activeRouteId: id }),
    }),
    { name: 'rutacash-collector-route' }
  )
)
