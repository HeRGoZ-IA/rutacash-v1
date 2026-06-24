import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Filtro/contexto de oficina del Administrador (NO modifica user.officeId).
 * Es una preferencia local: '' = "Todas las oficinas"; un id = filtrar por esa oficina.
 * El Administrador tiene acceso a TODAS las oficinas de su empresa; este selector
 * solo cambia qué se muestra, no los permisos.
 */
interface OfficeFilterState {
  officeId: string
  setOfficeId: (id: string) => void
}

export const useOfficeFilter = create<OfficeFilterState>()(
  persist(
    (set) => ({
      officeId: '',
      setOfficeId: (id) => set({ officeId: id }),
    }),
    { name: 'rutacash-office-filter' }
  )
)
