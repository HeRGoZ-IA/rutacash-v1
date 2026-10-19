// PUENTE de `src/hooks/useAuth.ts` (CLEAN) para ADEX Online.
//
// Mismo store y misma forma (`user`, `tenant`, `route`, `isAuthenticated`, `login`,
// `logout`…) para que LoginPage, los layouts y las pantallas originales funcionen sin
// cambios. Lo que cambia es la fuente:
//   · `login` autentica con el proveedor de identidad (la contraseña no se guarda) y
//     elige el contexto con el servidor (DS-05). Con varias membresías, el usuario elige
//     empresa y rol antes de entrar; los permisos NUNCA se suman entre membresías.
//   · `user` es la MEMBRESÍA activa (id = membershipId) con el rol y las rutas que
//     devuelve el servidor; `tenant` es la empresa del contexto.
//   · Nada se persiste aquí: la sesión vive en el cliente de modo servidor (tokens y
//     membresía elegida) y el contexto se revalida en cada arranque.

import { create } from 'zustand';
import type { Route, Tenant, User } from '@clean/models/types';
import { errorText } from '../../lib/format.ts';
import { ApiFailure, type ActiveContextView } from '../../lib/client.ts';
import { api, onContextChange, sessionEmail, signIn, signOut, useRuntime } from '../../runtime/session.ts';
import { prefetch, reset } from '../../runtime/projection.ts';
import { companyFromContext, tenantFrom, userFrom, type CompanyView } from '../../runtime/mappers.ts';

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
  exitTenantContext: () => void
  revalidateSession: () => Promise<void>
  changeOwnPassword: (current: string, next: string) => Promise<{ success: boolean; error?: string }>
  refreshUser: () => Promise<void>
}

/** Usuario y empresa de CLEAN a partir del contexto validado por el servidor. */
async function identityOf(ctx: ActiveContextView): Promise<{ user: User; tenant: Tenant }> {
  const c = api();
  const [company, members] = await Promise.all([
    // Sin `settings.access` (roles de campo) el servidor no da los datos de contacto: la empresa del contexto.
    ctx.capabilities.includes('settings.access')
      ? c.get<CompanyView>('/v1/company').catch((e) => { if (e instanceof ApiFailure && e.status === 403) return companyFromContext(); throw e; })
      : Promise.resolve(companyFromContext()),
    ctx.capabilities.includes('user.viewAll')
      ? c.get<{ members: Record<string, unknown>[] }>('/v1/members').then((b) => b.members).catch(() => [])
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const self = members.find((m) => m['membershipId'] === ctx.membershipId);
  const email = sessionEmail();
  const user = userFrom({
    membershipId: ctx.membershipId, role: ctx.role, status: 'activo', routeIds: ctx.routeIds,
    displayName: (self?.['displayName'] as string | undefined) ?? ctx.displayName ?? email, email: (self?.['email'] as string | undefined) ?? email,
    phone: self?.['phone'] ?? null,
  });
  return { user, tenant: tenantFrom(company) };
}

export const useAuth = create<AuthState>()((set, get) => ({
  user: null,
  tenant: null,
  route: null,
  isAuthenticated: false,
  isLoading: false,

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      await signIn(email, password);
      set({ isLoading: false });
      return { success: true };
    } catch (e) {
      set({ isLoading: false });
      return { success: false, error: errorText(e) };
    }
  },

  logout: () => {
    set({ user: null, tenant: null, route: null, isAuthenticated: false });
    void signOut();
  },

  selectTenant: (tenant) => set({ tenant }),
  selectRoute: (route) => set({ route }),
  exitTenantContext: () => set({ tenant: null, route: null }),

  // El contexto ya se revalidó con el servidor al arrancar (runtime/session.boot).
  revalidateSession: async () => {
    const ctx = useRuntime.getState().ctx;
    if (!ctx) return;
    try {
      set({ ...(await identityOf(ctx)), isAuthenticated: true });
    } catch { /* fallo transitorio: se conserva la sesión actual */ }
  },

  refreshUser: async () => { await get().revalidateSession(); },

  // La contraseña la gestiona el proveedor de identidad (enlace de recuperación por
  // correo). ADEX Online no la conoce ni la guarda.
  changeOwnPassword: async () => ({
    success: false,
    error: 'En ADEX Online la contraseña se cambia con el enlace de acceso enviado al correo (proveedor de identidad).',
  }),
}));

// Cada cambio de contexto reconstruye usuario y empresa, y vacía la proyección para que
// nada de otra empresa o de otro rol quede en memoria.
onContextChange((ctx) => {
  reset();
  if (!ctx) {
    useAuth.setState({ user: null, tenant: null, route: null, isAuthenticated: false });
    return;
  }
  useAuth.setState({ isLoading: true });
  prefetch();
  identityOf(ctx)
    .then(({ user, tenant }) => useAuth.setState({ user, tenant, route: null, isAuthenticated: true, isLoading: false }))
    .catch(() => useAuth.setState({ isLoading: false }));
});
