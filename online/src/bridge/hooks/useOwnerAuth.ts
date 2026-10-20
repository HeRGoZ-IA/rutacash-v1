// PUENTE de `src/hooks/useOwnerAuth.ts` (CLEAN) para la Plataforma Owner de ADEX Online.
//
// Misma forma (`owner`, `isAuthenticated`, `login`, `logout`, `revalidate`, `refresh`,
// `changePassword`) para que el login, el guard y el marco originales funcionen sin cambios.
// Lo que cambia es la fuente, y es lo que exige el plano de control del servidor:
//   · la contraseña solo viaja al proveedor de identidad (Supabase Auth); ADEX no la ve y
//     aquí no se guarda (el `password` del modelo de CLEAN queda vacío);
//   · ser Owner lo decide el SERVIDOR (`/control/v1/me`): una cuenta de empresa, aunque sea
//     Super Admin, recibe OPERATOR_REQUIRED y no queda sesión;
//   · la sesión (tokens) vive en el almacén propio del cliente Owner (`adex-owner-mode`),
//     separado de la sesión de empresa; si el servidor la revoca, se cierra aquí.

import { create } from 'zustand';
import type { PlatformUser } from '@clean/platform/types';
import { OWNER_SELF_ID } from '@/platform/controlPlane';

export interface OwnerProfileView { displayName: string; role: string; since: string }

/** Lo que el store necesita del cliente del servicio Owner (lo conecta `owner/main.tsx`). */
export interface OwnerSession {
  login(email: string, password: string): Promise<OwnerProfileView>;
  restore(): Promise<OwnerProfileView | null>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  email(): string | null;
  /** Avisa cuando el servidor revoca la sesión (o caduca). */
  onLost(listener: () => void): void;
}

let session: OwnerSession | null = null;

function ownerFrom(p: OwnerProfileView, email: string | null): PlatformUser {
  return { id: OWNER_SELF_ID, nombre: p.displayName, email: email ?? '', password: '', rol: 'owner', status: 'activo', createdAt: p.since, updatedAt: p.since };
}

const LOGIN_ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Credenciales incorrectas',
  OPERATOR_REQUIRED: 'Esta cuenta no es Owner de la plataforma.',
  IDENTITY_DISABLED: 'Cuenta inactiva.',
  NETWORK: 'Sin conexión con el servicio Owner. Intente de nuevo.',
  AUTH_UNAVAILABLE: 'El proveedor de identidad no respondió. Intente de nuevo.',
};
const loginError = (e: unknown) => LOGIN_ERRORS[(e as { code?: string })?.code ?? ''] ?? 'Error interno. Intenta de nuevo.';

interface OwnerAuthState {
  owner: PlatformUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  revalidate: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

export const useOwnerAuth = create<OwnerAuthState>()((set) => ({
  owner: null,
  isAuthenticated: false,
  isLoading: false,

  login: async (email, password) => {
    if (!session) return { success: false, error: 'El servicio Owner no está conectado.' };
    set({ isLoading: true });
    try {
      const p = await session.login(email, password);
      set({ owner: ownerFrom(p, session.email()), isAuthenticated: true, isLoading: false });
      return { success: true };
    } catch (e) {
      set({ isLoading: false });
      return { success: false, error: loginError(e) };
    }
  },

  logout: () => {
    set({ owner: null, isAuthenticated: false });
    void session?.logout();
  },

  revalidate: async () => {
    if (!session) return;
    try {
      const p = await session.restore();
      if (p) set({ owner: ownerFrom(p, session.email()), isAuthenticated: true });
      else set({ owner: null, isAuthenticated: false });
    } catch (e) {
      // Igual que CLEAN: solo se cierra si la cuenta fue REVOCADA; un fallo transitorio
      // (red, servicio despertando) conserva la sesión.
      const code = (e as { code?: string })?.code ?? '';
      if (code !== 'NETWORK' && !/^HTTP_5/.test(code)) set({ owner: null, isAuthenticated: false });
    }
  },

  refresh: async () => {
    await useOwnerAuth.getState().revalidate();
  },

  changePassword: async (current, next) => {
    if (!session) return { success: false, error: 'Sesión no válida' };
    if (!next || next.length < 12) return { success: false, error: 'La nueva contraseña debe tener al menos 12 caracteres' };
    try {
      await session.changePassword(current, next);
      return { success: true };
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      return { success: false, error: code === 'INVALID_CREDENTIALS' ? 'La contraseña actual no es correcta' : 'Error al actualizar la contraseña' };
    }
  },
}));

/** Lo llama SOLO el bundle Owner al arrancar. */
export function connectOwnerSession(s: OwnerSession): void {
  session = s;
  s.onLost(() => useOwnerAuth.setState({ owner: null, isAuthenticated: false }));
}
