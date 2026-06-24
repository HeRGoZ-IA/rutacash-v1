import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { db } from '@/lib/db'
import type { User, Tenant, Route } from '@/models/types'

interface AuthState {
  user: User | null
  tenant: Tenant | null
  route: Route | null
  isAuthenticated: boolean
  isLoading: boolean

  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => void
  selectTenant: (tenant: Tenant) => void
  selectRoute: (route: Route) => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      tenant: null,
      route: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true })
        try {
          const user = await db.users
            .where('email').equals(email.toLowerCase().trim())
            .first()

          if (!user || user.password !== password) {
            set({ isLoading: false })
            return { success: false, error: 'Credenciales incorrectas' }
          }

          if (user.status !== 'activo') {
            set({ isLoading: false })
            return { success: false, error: 'Usuario inactivo. Contacta al administrador.' }
          }

          let tenant: Tenant | null = null
          let route: Route | null = null

          if (user.rol !== 'superadmin') {
            tenant = await db.tenants.get(user.tenantId) ?? null
            if (tenant?.status === 'suspendida') {
              set({ isLoading: false })
              return { success: false, error: 'Tu empresa está suspendida. Contacta al soporte.' }
            }
          }

          if (user.routeId) {
            route = await db.routes.get(user.routeId) ?? null
          }

          set({ user, tenant, route, isAuthenticated: true, isLoading: false })
          return { success: true }
        } catch (err) {
          set({ isLoading: false })
          return { success: false, error: 'Error interno. Intenta de nuevo.' }
        }
      },

      logout: () => {
        set({ user: null, tenant: null, route: null, isAuthenticated: false })
      },

      selectTenant: (tenant) => set({ tenant }),
      selectRoute: (route) => set({ route }),
    }),
    {
      name: 'rutacash-auth',
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        route: state.route,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
