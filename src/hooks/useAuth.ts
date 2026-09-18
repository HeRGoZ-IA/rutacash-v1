import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { db } from '@/lib/db'
import { nowISO } from '@/lib/formatters'
import { logAction } from '@/services/auditService'
import { isCompanyBlocked } from '@/lib/company'
import { authenticateUser } from '@/services/authService'
import { recordTenantLogin } from '@/platform/companyControlService'
import { rememberLoginEmail } from '@/lib/lastLoginEmail'
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
   * Limpia la empresa y la ruta activas conservando la sesión. Se conserva por
   * compatibilidad de la API del store; ya no existe ningún flujo de "volver a
   * Empresas": desde la separación Plataforma/Empresa, un usuario de `users`
   * pertenece a UNA empresa y nunca sale de ella.
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

      // La comprobación de credenciales vive en `authService.authenticateUser`
      // (dominio testeable). Aquí solo se persiste el resultado en el store.
      login: async (email: string, password: string) => {
        set({ isLoading: true })
        const result = await authenticateUser(email, password)
        if (!result.ok) {
          set({ isLoading: false })
          return { success: false, error: result.error }
        }
        // Solo el correo, y solo tras un acceso correcto. Cerrar sesión no lo borra.
        rememberLoginEmail(result.user.email)
        // TELEMETRÍA COMERCIAL (plano de control): primer y último ingreso de la
        // EMPRESA. Es lo único que el Owner llega a saber de la actividad de un
        // cliente: dos fechas, sin historial de quién entra ni cuándo. Es fail-safe:
        // si falla, el usuario entra igual (ver `recordTenantLogin`).
        await recordTenantLogin(result.user.tenantId)
        set({
          user: result.user,
          tenant: result.tenant,
          route: result.route,
          isAuthenticated: true,
          isLoading: false,
        })
        return { success: true }
      },

      logout: () => {
        set({ user: null, tenant: null, route: null, isAuthenticated: false })
      },

      selectTenant: (tenant) => set({ tenant }),
      selectRoute: (route) => set({ route }),

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
          // TODOS los usuarios de `users` pertenecen a una empresa, el Super Admin
          // incluido: ya no existe el usuario "de plataforma" con tenant centinela.
          // Por eso la comprobación de empresa es universal y sin excepciones.
          const tenant = await db.tenants.get(fresh.tenantId) ?? null
          // Revalidación: cierra sesión si la empresa está suspendida o VENCIDA.
          if (!tenant || isCompanyBlocked(tenant)) {
            set({ user: null, tenant: null, route: null, isAuthenticated: false })
            return
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
          // `mustChangePassword` se escribe en false por higiene del dato: el flag es
          // legado y ya no tiene efecto en ningún guard (el cambio obligatorio se
          // eliminó). Cambiar la contraseña propia es voluntario y no lo pide nadie.
          await db.users.update(user.id, { password: next, mustChangePassword: false, updatedAt: nowISO() })
          await logAction({
            tenantId: user.tenantId, userId: user.id, userRole: user.rol,
            action: 'CHANGE_PASSWORD', entityType: 'User', entityId: user.id,
            descripcion: 'El usuario cambió su propia contraseña',
          })
          // El store se refresca en el acto: la pantalla de bloqueo desaparece sin
          // recargar, sin cerrar sesión y sin tocar IndexedDB manualmente.
          set({ user: { ...user, password: next, mustChangePassword: false } })
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
