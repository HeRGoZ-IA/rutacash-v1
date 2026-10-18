// Cliente del PANEL OWNER (ADEX Soluciones). Independiente del cliente de empresas:
//   · habla SOLO con el servicio Owner (`VITE_ADEX_CONTROL_URL`, /control/v1/*);
//   · su sesión vive en su PROPIA base del navegador (`adex-owner-mode`): nunca se mezcla
//     con la sesión de una empresa ni con `RutaCashDB` de CLEAN;
//   · la contraseña solo viaja al proveedor de identidad (Supabase Auth). ADEX nunca la ve.
//   · no existe ninguna cabecera de membresía: ser Owner no es entrar en una empresa.

import { AuthError, createSupabaseAuthClient, type AuthClient } from '../../../saas/src/client/serverSession.ts';
import { IndexedDbSessionStore, MemorySessionStore, type SessionStore, type StoredSession } from '../../../saas/src/client/sessionStore.ts';

export interface OwnerConfig { controlBase: string; supabaseUrl: string; publishableKey: string }

export class OwnerFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

const SESSION_LOST = new Set(['SESSION_REVOKED', 'IDENTITY_DISABLED', 'NOT_SIGNED_IN', 'SESSION_EXPIRED', 'MISSING_TOKEN', 'INVALID_TOKEN', 'OPERATOR_REQUIRED']);

export interface OwnerProfile { displayName: string; role: string; since: string }

export class OwnerClient {
  private readonly auth: AuthClient;
  private readonly store: SessionStore;
  private session: StoredSession | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<(event: 'session' | 'waking', on?: boolean) => void>();

  constructor(private readonly cfg: OwnerConfig) {
    this.auth = createSupabaseAuthClient({ url: cfg.supabaseUrl, publishableKey: cfg.publishableKey });
    let store: SessionStore;
    try { store = typeof indexedDB !== 'undefined' ? new IndexedDbSessionStore(indexedDB, 'adex-owner-mode') : new MemorySessionStore(); }
    catch { store = new MemorySessionStore(); }
    this.store = store;
  }

  on(l: (event: 'session' | 'waking', on?: boolean) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(event: 'session' | 'waking', on?: boolean) { for (const l of this.listeners) l(event, on); }

  get signedIn(): boolean { return this.session !== null; }

  async restore(): Promise<boolean> {
    this.session = await this.store.load();
    return this.session !== null;
  }

  /** Inicia sesión y exige que la identidad sea un Owner activo; si no, no queda sesión. */
  async login(email: string, password: string): Promise<OwnerProfile> {
    let t;
    try { t = await this.auth.signInWithPassword(email.trim().toLowerCase(), password); }
    catch (e) { throw new OwnerFailure(401, e instanceof AuthError ? e.code : 'AUTH_UNAVAILABLE'); }
    this.session = { ...t, activeMembershipId: null };
    await this.store.save(this.session);
    try {
      return await this.profile();
    } catch (e) {
      await this.forget();
      throw e;
    }
  }

  profile(): Promise<OwnerProfile> {
    return this.request('GET', '/control/v1/me') as unknown as Promise<OwnerProfile>;
  }

  /** «Primer acceso / olvidé mi contraseña»: el proveedor envía el enlace al correo real. */
  async recover(email: string): Promise<void> {
    await this.auth.recover(email.trim().toLowerCase(), `${window.location.origin}/owner/`);
  }

  /** Fija la contraseña con el token de un enlace de recuperación del proveedor. */
  async setPasswordFromLink(accessToken: string, password: string): Promise<void> {
    await this.updatePassword(accessToken, password);
  }

  /** Cambia la contraseña de la sesión actual (directamente en el proveedor). */
  async changePassword(password: string): Promise<void> {
    await this.updatePassword(await this.freshToken(), password);
  }

  private async updatePassword(token: string, password: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.supabaseUrl}/auth/v1/user`, { method: 'PUT',
        headers: { apikey: this.cfg.publishableKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    } catch { throw new OwnerFailure(0, 'NETWORK'); }
    if (res.status === 422) throw new OwnerFailure(422, 'WEAK_PASSWORD');
    if (res.status === 401 || res.status === 403) throw new OwnerFailure(res.status, 'LINK_EXPIRED');
    if (!res.ok) throw new OwnerFailure(res.status, 'AUTH_UNAVAILABLE');
  }

  async logout(scope: 'local' | 'global' = 'local'): Promise<void> {
    try { if (this.session) await this.request('POST', '/control/v1/session/logout', { scope }); }
    catch { /* la sesión local se borra igualmente */ }
    finally { await this.forget(); }
  }

  private async forget() {
    this.session = null;
    await this.store.clear();
    this.emit('session');
  }

  private async freshToken(): Promise<string> {
    const s = this.session;
    if (!s) throw new OwnerFailure(401, 'NOT_SIGNED_IN');
    if (s.expiresAt - Date.now() / 1000 > 60) return s.accessToken;
    this.refreshing ??= (async () => {
      try {
        const t = await this.auth.refresh(s.refreshToken);
        this.session = { ...t, activeMembershipId: null };
        await this.store.save(this.session);
      } catch {
        await this.forget();
        throw new OwnerFailure(401, 'SESSION_EXPIRED');
      } finally { this.refreshing = null; }
    })();
    await this.refreshing;
    return this.session!.accessToken;
  }

  async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.freshToken()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    const slow = setTimeout(() => this.emit('waking', true), 4_000);
    try {
      res = await fetch(`${this.cfg.controlBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new OwnerFailure(0, 'NETWORK');
    } finally {
      clearTimeout(slow);
      this.emit('waking', false);
    }
    let out: Record<string, unknown> = {};
    try { out = (await res.json()) as Record<string, unknown>; } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const code = String(out['error'] ?? `HTTP_${res.status}`);
      if (SESSION_LOST.has(code)) await this.forget();
      throw new OwnerFailure(res.status, code);
    }
    return out;
  }

  get<T>(path: string): Promise<T> { return this.request('GET', path) as Promise<T>; }
  send<T>(method: string, path: string, body: unknown = {}): Promise<T> { return this.request(method, path, body) as Promise<T>; }
}
