import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { isCompanyBlocked, companyBlockMessage } from '@/lib/company'
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
  /**
   * Sale del contexto de una empresa (Super Admin): limpia el tenant y la ruta
   * activa asociada, CONSERVANDO usuario y sesión. La navegación a /platform la
   * realiza el componente que la invoca.
   */
  exitTenantContext: () => void
  /** Revalida la sesión persistida contra la base (usuario/empresa/rol/rutas). */
  revalidateSession: () => Promise<void>
  /** Cambia la contraseña del usuario en sesión. Disponible para TODOS los perfiles. */
  changeOwnPassword: (current: string, next: string) => Promise<{ success: boolean; error?: string }>
  /** Refresca el usuario en sesión desde la base (tras editar permisos/rutas). */
  refreshUser: () => Promise<void>
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
            // Bloqueo por estado EFECTIVO: suspendida (manual) o vencida (por fecha).
            if (tenant && isCompanyBlocked(tenant)) {
              set({ isLoading: false })
              return { success: false, error: companyBlockMessage(tenant) ?? 'Empresa no disponible.' }
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

      // Volver a Empresas: solo limpia el tenant/ruta seleccionados; mantiene la
      // sesión de Super Admin intacta (usuario, isAuthenticated).
      exitTenantContext: () => set({ tenant: null, route: null }),

      // ------------------------------------------------------------
      // Revalidación de sesión (SESIONES, BLOQUEOS Y CONTRASEÑAS).
      // Al iniciar/restaurar la app se comprueba que el usuario siga activo, la
      // empresa siga activa, el rol y las rutas sigan siendo los de la base.
      // Si el usuario fue bloqueado o la empresa suspendida → se cierra sesión.
      // ------------------------------------------------------------
      revalidateSession: async () => {
        const { user, isAuthenticated } = get()
        if (!isAuthenticated || !user) return
        try {
          const fresh = await db.users.get(user.id)
          if (!fresh || fresh.status !== 'activo') {
            set({ user: null, tenant: null, route: null, isAuthenticated: false })
            return
          }
          let tenant: Tenant | null = null
          if (fresh.rol !== 'superadmin') {
            tenant = await db.tenants.get(fresh.tenantId) ?? null
            // Revalidación: cierra sesión si la empresa está suspendida o VENCIDA.
            if (!tenant || isCompanyBlocked(tenant)) {
              set({ user: null, tenant: null, route: null, isAuthenticated: false })
              return
            }
          } else {
            // Super Admin: preservar la empresa que haya seleccionado para operar
            // (si sigue existiendo y activa); no la borra al revalidar.
            const current = get().tenant
            if (current) tenant = (await db.tenants.get(current.id)) ?? null
          }
          // Ruta activa legacy: si la ruta ya no existe, se limpia.
          let route = get().route
          if (route && !(await db.routes.get(route.id))) route = null
          set({ user: fresh, tenant, route })
        } catch {
          /* ante error de lectura, mantener sesión actual (no expulsar por fallo transitorio) */
        }
      },

      refreshUser: async () => {
        const { user } = get()
        if (!user) return
        const fresh = await db.users.get(user.id)
        if (fresh) set({ user: fresh })
      },

      changeOwnPassword: async (current: string, next: string) => {
        const { user } = get()
        if (!user) return { success: false, error: 'Sesión no válida' }
        if (user.password !== current) return { success: false, error: 'La contraseña actual no es correcta' }
        if (!next || next.length < 4) return { success: false, error: 'La nueva contraseña debe tener al menos 4 caracteres' }
        try {
          await db.users.update(user.id, { password: next, updatedAt: nowISO() })
          await logAction({
            tenantId: user.tenantId, userId: user.id, userRole: user.rol,
            action: 'CHANGE_PASSWORD', entityType: 'User', entityId: user.id,
            descripcion: 'El usuario cambió su propia contraseña',
          })
          set({ user: { ...user, password: next } })
          return { success: true }
        } catch {
          return { success: false, error: 'Error al actualizar la contraseña' }
        }
      },
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
