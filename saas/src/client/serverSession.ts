// Sesión del cliente en MODO SERVIDOR (Fase 1). No sustituye ni modifica CLEAN.
//
//   · La contraseña solo viaja al PROVEEDOR de identidad (HTTPS) dentro de `login` y
//     no se asigna a ningún campo, estado, caché ni almacenamiento.
//   · Se guardan tokens y el contexto elegido; nada más.
//   · Cada petición lleva `X-Adex-Membership`: el contexto es explícito (DS-05). El
//     cliente nunca envía empresa, rol ni rutas: los decide el servidor.
//   · Cambiar de contexto vacía la caché del contexto anterior.
//   · Cerrar sesión revoca primero en ADEX (el registro que manda) y luego borra lo local.
//   · Recuperar el acceso lo gestiona el proveedor (DS-03): misma respuesta exista o
//     no el correo.

import { decideContext, type SelectableMembership, type SelectorDecision } from './contextSelector.ts';
import type { SessionStore, StoredSession } from './sessionStore.ts';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identityId: string;
}

export interface AuthClient {
  signInWithPassword(email: string, password: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  recover(email: string, redirectTo?: string): Promise<void>;
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Supabase Auth con la clave PUBLICABLE (nunca la secreta en el cliente). */
export function createSupabaseAuthClient(cfg: { url: string; publishableKey: string; fetchImpl?: typeof fetch }): AuthClient {
  const f = cfg.fetchImpl ?? fetch;
  const base = cfg.url.replace(/\/$/, '');
  const headers = { apikey: cfg.publishableKey, 'content-type': 'application/json' };
  const tokens = async (res: Response): Promise<TokenSet> => {
    if (!res.ok) throw new AuthError(res.status === 400 ? 'INVALID_CREDENTIALS' : 'AUTH_UNAVAILABLE');
    const b = (await res.json()) as { access_token: string; refresh_token: string; expires_at: number; user: { id: string } };
    return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: b.expires_at, identityId: b.user.id };
  };
  return {
    async signInWithPassword(email, password) {
      return tokens(await f(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers, body: JSON.stringify({ email, password }) }));
    },
    async refresh(refreshToken) {
      return tokens(await f(`${base}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers, body: JSON.stringify({ refresh_token: refreshToken }) }));
    },
    async recover(email, redirectTo) {
      const res = await f(`${base}/auth/v1/recover`, { method: 'POST', headers, body: JSON.stringify(redirectTo ? { email, redirect_to: redirectTo } : { email }) });
      // Igual respuesta exista o no el correo (sin enumeración); solo un fallo del servicio es error.
      if (res.status >= 500) throw new AuthError('AUTH_UNAVAILABLE');
    },
  };
}

export interface ServerSessionOptions {
  auth: AuthClient;
  store: SessionStore;
  /** Base de la API de empresa, p. ej. https://api.staging.adex.example */
  apiBase: string;
  fetchImpl?: typeof fetch;
}

export class AdexServerSession {
  private session: StoredSession | null = null;
  private cache = new Map<string, unknown>();
  private readonly f: typeof fetch;
  private readonly opts: ServerSessionOptions;

  constructor(opts: ServerSessionOptions) {
    this.opts = opts;
    this.f = opts.fetchImpl ?? fetch;
  }

  get activeMembershipId(): string | null {
    return this.session?.activeMembershipId ?? null;
  }

  async restore(): Promise<boolean> {
    this.session = await this.opts.store.load();
    return this.session !== null;
  }

  async login(email: string, password: string): Promise<SelectorDecision> {
    const t = await this.opts.auth.signInWithPassword(email.trim().toLowerCase(), password);
    this.session = { ...t, activeMembershipId: null };
    await this.opts.store.save(this.session);
    const decision = decideContext(await this.memberships());
    if (decision.kind === 'auto') await this.select(decision.membershipId);
    return decision;
  }

  async recover(email: string, redirectTo?: string): Promise<void> {
    await this.opts.auth.recover(email.trim().toLowerCase(), redirectTo);
  }

  async memberships(): Promise<SelectableMembership[]> {
    const body = await this.call('GET', '/v1/me/memberships', { withContext: false });
    return body['memberships'] as SelectableMembership[];
  }

  /** Elige el contexto. Vacía la caché del anterior antes de usar el nuevo. */
  async select(membershipId: string): Promise<Record<string, unknown>> {
    const s = this.requireSession();
    this.cache.clear();
    s.activeMembershipId = null;
    await this.opts.store.save(s);
    const ctx = await this.call('POST', '/v1/context/select', { membership: membershipId, body: {} });
    s.activeMembershipId = membershipId;
    await this.opts.store.save(s);
    return ctx;
  }

  /** Lectura con caché acotada al contexto activo. */
  async get(path: string): Promise<Record<string, unknown>> {
    const key = `${this.activeMembershipId}:${path}`;
    if (this.cache.has(key)) return this.cache.get(key) as Record<string, unknown>;
    const body = await this.call('GET', path, {});
    this.cache.set(key, body);
    return body;
  }

  cachedKeys(): string[] {
    return [...this.cache.keys()];
  }

  async call(method: string, path: string, o: { membership?: string; body?: unknown; withContext?: boolean } = {}): Promise<Record<string, unknown>> {
    const s = this.requireSession();
    const headers: Record<string, string> = { authorization: `Bearer ${s.accessToken}` };
    const membership = o.membership ?? (o.withContext === false ? null : s.activeMembershipId);
    if (membership) headers['x-adex-membership'] = membership;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.f(`${this.opts.apiBase}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new AuthError(String(body['error'] ?? res.status));
    return body;
  }

  async logout(scope: 'local' | 'global' = 'local'): Promise<void> {
    try {
      if (this.session) await this.call('POST', '/v1/session/logout', { body: { scope }, withContext: false });
    } finally {
      this.session = null;
      this.cache.clear();
      await this.opts.store.clear();
    }
  }

  private requireSession(): StoredSession {
    if (!this.session) throw new AuthError('NOT_SIGNED_IN');
    return this.session;
  }
}
