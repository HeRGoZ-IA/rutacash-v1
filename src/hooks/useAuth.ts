import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { db } from '@/lib/db'
import type { User, Tenant, Office, Route } from '@/models/types'

interface AuthState {
  user: User | null
  tenant: Tenant | null
  office: Office | null
  route: Route | null
  isAuthenticated: boolean
  isLoading: boolean

  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  logout: () => void
  selectTenant: (tenant: Tenant) => void
  selectOffice: (office: Office) => void
  selectRoute: (route: Route) => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      tenant: null,
      office: null,
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
          let office: Office | null = null
          let route: Route | null = null

          if (user.rol !== 'superadmin') {
            tenant = await db.tenants.get(user.tenantId) ?? null
            if (tenant?.status === 'suspendida') {
              set({ isLoading: false })
              return { success: false, error: 'Tu empresa está suspendida. Contacta al soporte.' }
            }
          }

          if (user.officeId) {
            office = await db.offices.get(user.officeId) ?? null
          }
          if (user.routeId) {
            route = await db.routes.get(user.routeId) ?? null
          }

          set({ user, tenant, office, route, isAuthenticated: true, isLoading: false })
          return { success: true }
        } catch (err) {
          set({ isLoading: false })
          return { success: false, error: 'Error interno. Intenta de nuevo.' }
        }
      },

      logout: () => {
        set({ user: null, tenant: null, office: null, route: null, isAuthenticated: false })
      },

      selectTenant: (tenant) => set({ tenant }),
      selectOffice: (office) => set({ office }),
      selectRoute: (route) => set({ route }),
    }),
    {
      name: 'rutacash-auth',
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        office: state.office,
        route: state.route,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
