// ============================================================
// RUTACASH — SESIÓN DEL NIVEL PLATAFORMA (OWNER)
// ------------------------------------------------------------
// Store SEPARADO de `useAuth` (empresas), con su propia clave de persistencia.
// Esta separación no es organizativa, es el mecanismo de aislamiento:
//
//   · Un Owner autenticado NO existe en `useAuth` → `RequireAuth` lo rechaza y no
//     puede entrar a /admin, /collector ni ninguna otra zona de empresa.
//   · Un Super Admin autenticado NO existe en `useOwnerAuth` → `RequireOwner` lo
//     rechaza y no puede entrar a /owner.
//
// No hay un "modo cliente", ni impersonación, ni un botón para saltar de un lado al
// otro. Si el dueño de RutaCash quiere probar el producto como cliente, entra por
// `/login` con una cuenta NORMAL de empresa, igual que cualquier cliente.
// ============================================================
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  authenticateOwner, revalidateOwner, changeOwnerPassword,
} from '@/platform/platformAuthService'
import type { PlatformUser } from '@/platform/types'

interface OwnerAuthState {
  owner: PlatformUser | null
  isAuthenticated: boolean
  isLoading: boolean

  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => void
  /** Revalida la sesión persistida contra la base (cuenta viva y activa). */
  revalidate: () => Promise<void>
  /** Cambio de contraseña propio. Voluntario: nunca se fuerza ni se recuerda. */
  changePassword: (current: string, next: string) => Promise<{ success: boolean; error?: string }>
  /** Recarga el Owner en sesión desde la base. */
  refresh: () => Promise<void>
}

export const useOwnerAuth = create<OwnerAuthState>()(
  persist(
    (set, get) => ({
      owner: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email, password) => {
        set({ isLoading: true })
        const result = await authenticateOwner(email, password)
        if (!result.ok) {
          set({ isLoading: false })
          return { success: false, error: result.error }
        }
        set({ owner: result.owner, isAuthenticated: true, isLoading: false })
        return { success: true }
      },

      logout: () => set({ owner: null, isAuthenticated: false }),

      revalidate: async () => {
        const { owner, isAuthenticated } = get()
        if (!isAuthenticated || !owner) return
        const fresh = await revalidateOwner(owner.id)
        if (!fresh) { set({ owner: null, isAuthenticated: false }); return }
        set({ owner: fresh })
      },

      refresh: async () => {
        const { owner } = get()
        if (!owner) return
        const fresh = await revalidateOwner(owner.id)
        if (fresh) set({ owner: fresh })
      },

      changePassword: async (current, next) => {
        const { owner } = get()
        if (!owner) return { success: false, error: 'Sesión no válida' }
        const res = await changeOwnerPassword(owner, current, next)
        if (res.success) set({ owner: { ...owner, password: next } })
        return res
      },
    }),
    {
      // Clave DISTINTA de 'rutacash-auth': las dos sesiones no se pisan y cerrar una
      // no cierra la otra. Ambas caen bajo el prefijo 'rutacash-' que borra el reset.
      name: 'rutacash-owner-auth',
      partialize: (state) => ({
        owner: state.owner,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
)
