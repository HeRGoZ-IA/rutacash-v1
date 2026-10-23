// Cliente de ADEX ONLINE: SOLO EN LÍNEA. El navegador no guarda ni calcula dinero:
// cada dato financiero se lee de la API y cada operación la confirma PostgreSQL.
//
//   · Sesión: tokens del proveedor (Supabase Auth) y la membresía elegida, en la base
//     propia `adex-server-mode` (nunca contraseñas; nunca `RutaCashDB` de CLEAN).
//   · Cada petición lleva `X-Adex-Membership` (contexto explícito, DS-05).
//   · Comandos de dinero y altas: `X-Adex-Operation-Id` nuevo por intención. Si la
//     respuesta se pierde, se CONSULTA el resultado por ese id antes de repetir nada.

import { AuthError, createSupabaseAuthClient, type AuthClient } from '../../../saas/src/client/serverSession.ts';
import { decideContext, type SelectableMembership, type SelectorDecision } from '../../../saas/src/client/contextSelector.ts';
import { IndexedDbSessionStore, MemorySessionStore, type SessionStore, type StoredSession } from '../../../saas/src/client/sessionStore.ts';

export type { SelectableMembership, SelectorDecision };

export interface OnlineConfig {
  apiBase: string;
  supabaseUrl: string;
  publishableKey: string;
}

/** Error de negocio o de autorización devuelto por la API (respuesta recibida). */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Sin respuesta (red caída, servidor inaccesible). El resultado es DESCONOCIDO. */
export class NetworkFailure extends Error {}

/** Un comando cuya confirmación no se pudo obtener ni recuperar todavía. */
export class UncertainOperation extends Error {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** Membresía con la que se envió: solo con ella se consulta o repite (Ronda 48.1). */
  readonly membershipId: string | null;
  constructor(operationId: string, method: string, path: string, body: unknown, membershipId: string | null = null) {
    super('UNCERTAIN_OPERATION');
    this.operationId = operationId;
    this.method = method;
    this.path = path;
    this.body = body;
    this.membershipId = membershipId;
  }
}

/**
 * ¿Pudo el servidor confirmar el comando sin que lo sepamos? Sin respuesta (red caída,
 * servidor reiniciándose o despertando) o 5xx (p. ej. la conexión con PostgreSQL se
 * cortó durante el COMMIT): el resultado es DESCONOCIDO y se consulta por id antes de
 * repetir. Un 4xx es una respuesta definitiva (la transacción no se confirmó).
 */
export function isUnconfirmed(err: unknown): boolean {
  return err instanceof NetworkFailure || (err instanceof ApiFailure && err.status >= 500);
}

/** Rechazos de la API ANTERIORES a la operación: no dicen nada de un intento previo con ese id. */
const BEFORE_OPERATION = new Set(['INVALID_TOKEN', 'MISSING_TOKEN', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'NOT_SIGNED_IN', 'IDENTITY_DISABLED',
  'IDENTITY_NOT_PROVISIONED', 'MEMBERSHIP_REQUIRED', 'INVALID_MEMBERSHIP_ID', 'MEMBERSHIP_NOT_FOUND', 'MEMBERSHIP_INACTIVE', 'COMPANY_BLOCKED',
  'CONTEXT_INVALID', 'RATE_LIMITED']);

/**
 * ¿El rechazo ocurrió antes de que el servidor llegara a la operación (sesión, contexto,
 * límite de peticiones)? Al REPETIR un comando incierto, un rechazo así no prueba que el
 * primer intento no se confirmara: el resultado sigue siendo desconocido (Ronda 48.1).
 */
export function isBeforeOperation(err: unknown): boolean {
  return err instanceof ApiFailure && (err.status === 401 || err.status === 408 || err.status === 429 || BEFORE_OPERATION.has(err.code));
}

/**
 * Al REPETIR un comando con su mismo id, ¿la respuesta NO es definitiva sobre esa operación?
 * Rechazos previos a la operación, el id ya usado (la operación EXISTE), y respuestas que no
 * vienen de la API de empresa (ruta no encontrada durante un despliegue, origen, proxy sin cuerpo).
 */
export function isNotAboutOperation(err: unknown): boolean {
  return isBeforeOperation(err) || (err instanceof ApiFailure
    && (err.code === 'OPERATION_ID_REUSED' || err.code === 'NOT_FOUND' || err.code === 'ORIGIN_NOT_ALLOWED' || err.code.startsWith('HTTP_')));
}

/** Una petición que tarda más que esto suele ser el servidor despertando (Render Free). */
const WAKING_AFTER_MS = 4_000;
/** Espera máxima de la sonda `/healthz` para decidir si el servicio está arrancando. */
const HEALTH_PROBE_MS = 4_000;

/** Errores que significan «el contexto elegido ya no vale»: volver al selector. */
export const CONTEXT_LOST = new Set(['COMPANY_BLOCKED', 'MEMBERSHIP_INACTIVE', 'MEMBERSHIP_NOT_FOUND', 'CONTEXT_INVALID']);
/** Errores que significan «la sesión terminó»: volver a iniciar sesión. */
/** `session_id` de un token (sin verificar: solo para comparar sesiones entre pestañas). */
function sessionIdOf(token: string | undefined): string | null {
  try {
    const part = token?.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: unknown };
    return typeof json.session_id === 'string' ? json.session_id : null;
  } catch { return null; }
}

export const SESSION_LOST = new Set(['SESSION_REVOKED', 'IDENTITY_DISABLED', 'NOT_SIGNED_IN', 'SESSION_EXPIRED', 'MISSING_TOKEN']);

export interface ActiveContextView {
  identityId: string;
  membershipId: string;
  role: string;
  /** Nombre de la persona en ESTA membresía (servidor). */
  displayName?: string;
  routeIds: string[];
  company: { id: string; name: string; countryCode: string; currencyCode: string; minorUnits: number; timezone: string; isDemo: boolean };
  capabilities: string[];
}

type ClientEvent = 'session' | 'context' | 'network' | 'waking';
type Listener = (event: ClientEvent, detail?: unknown) => void;

function store(): SessionStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbSessionStore();
  } catch { /* navegador sin IndexedDB: sesión solo en memoria */ }
  return new MemorySessionStore();
}

export class OnlineClient {
  private session: StoredSession | null = null;
  private readonly auth: AuthClient;
  private readonly store: SessionStore = store();
  private listeners = new Set<Listener>();
  private refreshing: Promise<void> | null = null;
  readonly cfg: OnlineConfig;

  constructor(cfg: OnlineConfig) {
    this.cfg = cfg;
    this.auth = createSupabaseAuthClient({ url: cfg.supabaseUrl, publishableKey: cfg.publishableKey });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(event: ClientEvent, detail?: unknown) {
    for (const l of this.listeners) l(event, detail);
  }

  get signedIn(): boolean { return this.session !== null; }
  get identityId(): string | null { return this.session?.identityId ?? null; }
  get activeMembershipId(): string | null { return this.session?.activeMembershipId ?? null; }

  async restore(): Promise<boolean> {
    this.session = await this.store.load();
    return this.session !== null;
  }

  async login(email: string, password: string): Promise<SelectorDecision> {
    // La contraseña va SOLO al proveedor y no se guarda en ningún sitio.
    const t = await this.auth.signInWithPassword(email.trim().toLowerCase(), password);
    this.session = { ...t, activeMembershipId: null };
    await this.store.save(this.session);
    // Ronda 73 · SOC-01: inicio de sesión EXPLÍCITO → esta es la única sesión vigente de la persona;
    // la de cualquier otro dispositivo queda revocada en el servidor. Una API anterior (404) lo ignora.
    await this.request('POST', '/v1/session/claim', { body: {}, context: false })
      .catch((e) => { if (!(e instanceof ApiFailure && e.status === 404)) throw e; });
    return decideContext(await this.memberships());
  }

  /** «¿Olvidaste tu contraseña?»: el proveedor envía al correo un enlace que vuelve a /activar. */
  async recover(email: string): Promise<void> {
    await this.auth.recover(email.trim().toLowerCase(), `${window.location.origin}/activar`);
  }

  // ---------- Primer acceso (Ronda 40) ----------
  // La persona fija SU contraseña con un enlace de un solo uso. Todo ocurre entre el
  // navegador y el proveedor de identidad: ADEX nunca ve la contraseña. Esta sesión
  // temporal no se guarda: se cierra en cuanto la contraseña queda fijada.

  /** Canjea el token de un enlace de primer acceso (un solo uso) por una sesión temporal. */
  async redeemAccessLink(tokenHash: string): Promise<string> {
    const res = await this.authFetch('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'recovery', token_hash: tokenHash }) });
    if (res.status === 403 || res.status === 401 || res.status === 400) throw new ApiFailure(res.status, 'LINK_EXPIRED');
    if (!res.ok) throw new ApiFailure(res.status, 'AUTH_UNAVAILABLE');
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string') throw new ApiFailure(502, 'AUTH_UNAVAILABLE');
    return body.access_token;
  }

  /** Fija la contraseña de la persona de esa sesión temporal y la cierra. */
  async setOwnPassword(accessToken: string, password: string): Promise<void> {
    const res = await this.authFetch('/auth/v1/user', { method: 'PUT', token: accessToken, body: JSON.stringify({ password }) });
    if (res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as { error_code?: string };
      throw new ApiFailure(422, body.error_code === 'same_password' ? 'SAME_PASSWORD' : 'WEAK_PASSWORD');
    }
    if (res.status === 401 || res.status === 403) throw new ApiFailure(res.status, 'LINK_EXPIRED');
    if (!res.ok) throw new ApiFailure(res.status, 'AUTH_UNAVAILABLE');
    await this.authFetch('/auth/v1/logout?scope=local', { method: 'POST', token: accessToken }).catch(() => undefined);
  }

  /** Enlace de primer acceso de un usuario de la empresa (lo emite el servidor; no se guarda). */
  async memberAccessLink(membershipId: string): Promise<{ status: 'issued'; url: string } | { status: 'already_active' }> {
    const body = await this.request('POST', `/v1/members/${encodeURIComponent(membershipId)}/access-link`, { body: {} });
    return body['status'] === 'issued'
      ? { status: 'issued', url: `${window.location.origin}/activar#t=${encodeURIComponent(String(body['tokenHash']))}` }
      : { status: 'already_active' };
  }

  private async authFetch(path: string, o: { method: string; body?: string; token?: string }): Promise<Response> {
    const headers: Record<string, string> = { apikey: this.cfg.publishableKey, 'content-type': 'application/json' };
    if (o.token) headers['authorization'] = `Bearer ${o.token}`;
    try {
      return await fetch(`${this.cfg.supabaseUrl}${path}`, { method: o.method, headers, body: o.body, cache: 'no-store' });
    } catch {
      throw new ApiFailure(0, 'NETWORK');
    }
  }

  async memberships(): Promise<SelectableMembership[]> {
    const body = await this.request('GET', '/v1/me/memberships', { context: false });
    return body['memberships'] as SelectableMembership[];
  }

  /** Elige el contexto: el servidor lo valida y devuelve rol, rutas y capacidades. */
  async select(membershipId: string): Promise<ActiveContextView> {
    const s = this.require();
    s.activeMembershipId = null;
    await this.store.save(s);
    const ctx = await this.request('POST', '/v1/context/select', { membership: membershipId, body: {} });
    s.activeMembershipId = membershipId;
    await this.store.save(s);
    return ctx as unknown as ActiveContextView;
  }

  async context(): Promise<ActiveContextView> {
    return (await this.request('GET', '/v1/context')) as unknown as ActiveContextView;
  }

  async clearContext(): Promise<void> {
    if (!this.session) return;
    this.session.activeMembershipId = null;
    await this.store.save(this.session);
  }

  async logout(scope: 'local' | 'global' = 'local'): Promise<void> {
    try {
      if (this.session) await this.request('POST', '/v1/session/logout', { context: false, body: { scope } });
    } catch { /* la sesión local se borra igualmente */ } finally {
      this.session = null;
      await this.store.clear();
      this.emit('session');
    }
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request('GET', path) as Promise<T>;
  }

  /** Comando sin idempotencia en el servidor (aprobar, rechazar…): ante una red caída, el llamador relee el estado. */
  send<T = Record<string, unknown>>(method: string, path: string, body: unknown = {}): Promise<T> {
    return this.request(method, path, { body }) as Promise<T>;
  }

  /**
   * Comando idempotente (dinero, altas). Un id por intención. Si no llega respuesta o
   * llega un 5xx (resultado desconocido, ver `isUnconfirmed`):
   *   1. se consulta `/v1/operations/:id`: si existe, ese ES el resultado (no se repite);
   *   2. si no existe (404), el comando no se confirmó y repetirlo con el MISMO id es seguro;
   *   3. si tampoco se puede consultar, `UncertainOperation`: la UI ofrece «Comprobar».
   * Nunca se repite con un id nuevo: eso sí podría duplicar el movimiento.
   */
  async command<T = Record<string, unknown>>(method: string, path: string, body: unknown, operationId: string = crypto.randomUUID(),
    opts: { membership?: string } = {}): Promise<T> {
    // R74: una captura sin conexión viaja con la membresía con la que se REGISTRÓ (`opts.membership`),
    // nunca con la que esté activa al sincronizar.
    const membership = opts.membership ?? this.activeMembershipId;
    try {
      return (await this.request(method, path, { body, operationId, membership: membership ?? undefined })) as T;
    } catch (err) {
      if (!isUnconfirmed(err)) throw err;
      return this.resolveUncertain<T>(new UncertainOperation(operationId, method, path, body, membership));
    }
  }

  /**
   * Resuelve un comando incierto SIN crear otro: consulta por su id y, si el servidor no lo
   * tiene, lo repite con el MISMO id y el MISMO cuerpo (el servidor serializa los intentos
   * sobre `operations` y devuelve el guardado). Lanza `ApiFailure` solo cuando la respuesta
   * es definitiva sobre ESA operación; en cualquier otro caso, la misma `UncertainOperation`.
   * Ronda 48.1: un fallo de la CONSULTA (sesión caducada, contexto perdido, límite de
   * peticiones…) nunca se toma como resultado de la operación.
   */
  async resolveUncertain<T = Record<string, unknown>>(u: UncertainOperation): Promise<T> {
    const membership = u.membershipId ?? undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let known: Record<string, unknown> | null = null;
      try {
        known = await this.request('GET', `/v1/operations/${u.operationId}`, { membership });
      } catch (err) {
        if (err instanceof ApiFailure && err.code === 'OPERATION_NOT_FOUND') {
          try {
            return (await this.request(u.method, u.path, { body: u.body, operationId: u.operationId, membership })) as T;
          } catch (again) {
            if (isNotAboutOperation(again)) throw u;
            if (!isUnconfirmed(again)) throw again;
          }
        } else if (!isUnconfirmed(err)) {
          throw u;
        }
      }
      if (known) {
        const httpStatus = Number(known['httpStatus'] ?? 0);
        const result = known['result'] as Record<string, unknown>;
        if (httpStatus >= 400) throw new ApiFailure(httpStatus, String(result?.['error'] ?? 'ERROR'));
        return result as T;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    throw u;
  }

  /**
   * Peticiones que tardan más de lo normal. Solo se afirma «el servidor se está activando»
   * con EVIDENCIA: si `/healthz` (sin base de datos) tampoco responde en unos segundos, el
   * servicio está arrancando (Render Free tras un rato sin uso). Si responde, el servidor está
   * activo y lo que tarda es la consulta. Nada se reintenta por esto.
   */
  private slowCount = 0;
  private slowStarted(): void {
    if (this.slowCount++ > 0) return;
    this.emit('waking', 'slow');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HEALTH_PROBE_MS);
    fetch(`${this.cfg.apiBase}/healthz`, { cache: 'no-store', signal: ctl.signal })
      .then((r) => r.ok, () => false)
      .then((up) => { if (this.slowCount > 0) this.emit('waking', up ? 'slow' : 'starting'); })
      .finally(() => clearTimeout(timer));
  }
  private slowEnded(): void {
    if (--this.slowCount === 0) this.emit('waking', false);
  }

  /**
   * Ronda 73 · SOC-01: termina la sesión de ESTA pestaña. El almacenamiento es compartido por las
   * pestañas del navegador: si otra ya inició una sesión nueva (otro `session_id`), se conserva.
   */
  private async dropSession(): Promise<void> {
    const mine = sessionIdOf(this.session?.accessToken);
    this.session = null;
    const stored = await this.store.load().catch(() => null);
    if (!stored || !mine || sessionIdOf(stored.accessToken) === mine) await this.store.clear();
    this.emit('session');
  }

  private require(): StoredSession {
    if (!this.session) throw new ApiFailure(401, 'NOT_SIGNED_IN');
    return this.session;
  }

  private async freshToken(): Promise<string> {
    const s = this.require();
    if (s.expiresAt - Date.now() / 1000 > 60) return s.accessToken;
    this.refreshing ??= (async () => {
      try {
        const t = await this.auth.refresh(s.refreshToken);
        this.session = { ...t, activeMembershipId: s.activeMembershipId };
        // Ronda 73: si otra pestaña ya guardó una sesión NUEVA, no se sobrescribe con esta.
        const stored = await this.store.load().catch(() => null);
        if (!stored || sessionIdOf(stored.accessToken) === sessionIdOf(s.accessToken)) await this.store.save(this.session);
      } catch (e) {
        // Ronda 62: SIN RED (o el proveedor caído) la sesión NO se borra: es «sin conexión», no
        // «sesión terminada». Antes, un Cobrador sin internet con el token caducado perdía la
        // sesión y no podía abrir su ruta guardada. Solo un rechazo del proveedor la termina.
        if (!(e instanceof AuthError) || e.code === 'AUTH_UNAVAILABLE') {
          this.emit('network', false);
          throw new NetworkFailure('NETWORK');
        }
        await this.dropSession();
        throw new ApiFailure(401, 'SESSION_EXPIRED');
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    return this.require().accessToken;
  }

  async request(method: string, path: string, o: { body?: unknown; membership?: string; context?: boolean; operationId?: string } = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.freshToken()}` };
    const membership = o.membership ?? (o.context === false ? null : this.session?.activeMembershipId ?? null);
    if (membership) headers['x-adex-membership'] = membership;
    if (o.operationId) headers['x-adex-operation-id'] = o.operationId;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    let slowNow = false;
    const slow = setTimeout(() => { slowNow = true; this.slowStarted(); }, WAKING_AFTER_MS);
    try {
      res = await fetch(`${this.cfg.apiBase}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), cache: 'no-store' });
    } catch {
      this.emit('network', false);
      throw new NetworkFailure('NETWORK');
    } finally {
      clearTimeout(slow);
      if (slowNow) this.slowEnded();
    }
    this.emit('network', true);
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const code = String(body['error'] ?? `HTTP_${res.status}`);
      if (SESSION_LOST.has(code) || code === 'INVALID_TOKEN') {
        await this.dropSession();
      } else if (CONTEXT_LOST.has(code) && membership && membership === this.activeMembershipId) {
        await this.clearContext();
        this.emit('context', code);
      }
      throw new ApiFailure(res.status, code, body['details'] as Record<string, unknown> | undefined);
    }
    return body;
  }

  /** Administración Demo (plano separado: sin membresía). */
  demo(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    return this.request(method, `/demo/v1${path}`, { body, context: false });
  }
}
