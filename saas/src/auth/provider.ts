// Proveedor de identidad (DS-03: Supabase Auth). Las contraseñas las guarda y
// verifica el proveedor; ADEX nunca las recibe en la API ni las almacena.
//
// Lo que la API necesita del proveedor es poco y está aislado aquí (cambiar de
// proveedor afectaría solo a este archivo y a `jwt.ts`):
//   · ensureIdentity: aprovisionar a una persona invitada SIN contraseña conocida
//     por nadie; la persona la fija con el flujo de recuperación del proveedor.
//   · signOut: revocar la sesión en el proveedor (el refresco deja de funcionar).
//     ADEX revoca ANTES en su propio registro, que es el que manda (0005).
//
// La clave secreta (`sb_secret_…`) solo la usa este módulo para la administración
// de usuarios y nunca toca PostgreSQL: ignora RLS solo en la Data API, que ADEX no usa.

import { ApiError } from '../errors.ts';

export interface IdentityProvider {
  /** Devuelve el `sub` de la persona con ese correo, creándola si no existe. */
  ensureIdentity(email: string): Promise<{ identityId: string; created: boolean }>;
  /** Revoca en el proveedor la sesión del token (`local`) o todas (`global`). */
  signOut(accessToken: string, scope: 'local' | 'global'): Promise<void>;
}

export interface SupabaseProviderConfig {
  /** https://<ref>.supabase.co */
  url: string;
  publishableKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSupabaseProvider(cfg: SupabaseProviderConfig): IdentityProvider {
  const f = cfg.fetchImpl ?? fetch;
  const base = cfg.url.replace(/\/$/, '');
  const admin = { apikey: cfg.secretKey, authorization: `Bearer ${cfg.secretKey}`, 'content-type': 'application/json' };

  async function userIdFrom(res: Response): Promise<string> {
    const body = (await res.json()) as { id?: unknown; user?: { id?: unknown } };
    const id = body.user?.id ?? body.id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ApiError(502, 'IDENTITY_PROVIDER_ERROR');
    return id.toLowerCase();
  }

  return {
    async ensureIdentity(email) {
      const normalized = email.trim().toLowerCase();
      // Alta sin contraseña y sin correo confirmado: nadie conoce una credencial.
      const created = await f(`${base}/auth/v1/admin/users`, {
        method: 'POST', headers: admin, body: JSON.stringify({ email: normalized, email_confirm: false }),
      });
      if (created.ok) return { identityId: await userIdFrom(created), created: true };
      if (created.status !== 422) throw new ApiError(502, 'IDENTITY_PROVIDER_ERROR');
      // Ya existe: el enlace de recuperación devuelve su id (no envía correo).
      const link = await f(`${base}/auth/v1/admin/generate_link`, {
        method: 'POST', headers: admin, body: JSON.stringify({ type: 'recovery', email: normalized }),
      });
      if (!link.ok) throw new ApiError(502, 'IDENTITY_PROVIDER_ERROR');
      return { identityId: await userIdFrom(link), created: false };
    },
    async signOut(accessToken, scope) {
      const res = await f(`${base}/auth/v1/logout?scope=${scope}`, {
        method: 'POST', headers: { apikey: cfg.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      // 401/403/404: la sesión ya no existe en el proveedor. ADEX ya la revocó.
      if (!res.ok && ![401, 403, 404].includes(res.status)) throw new ApiError(502, 'IDENTITY_PROVIDER_ERROR');
    },
  };
}
