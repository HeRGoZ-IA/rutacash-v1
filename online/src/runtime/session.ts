// Sesión y contexto de ADEX Online para el frontend de CLEAN.
//
// La sesión es la del cliente de modo servidor (`lib/client.ts`): tokens del proveedor
// de identidad y la membresía elegida, nada más. El contexto (empresa, rol, rutas y
// capacidades) lo DEVUELVE el servidor y se revalida al arrancar (DS-05): nunca se
// confía en lo guardado ni se suman permisos entre membresías.

import { create } from 'zustand';
import { ApiFailure, CONTEXT_LOST, type ActiveContextView, type OnlineClient, type SelectorDecision } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';
import { activate, cachedContext, confirmContext, deactivate, forgetMembershipData, forgetOnSignOut } from '../offline/state.ts';
import { isConnectivityError } from '../offline/cache.ts';
import { forgetOtherIdentities } from '../offline/vault.ts';

let client: OnlineClient | null = null;

export function setClient(c: OnlineClient): void { client = c; }

export function api(): OnlineClient {
  if (!client) throw new Error('ADEX Online: cliente no inicializado');
  return client;
}

export interface RuntimeState {
  /** Contexto activo validado por el servidor (null = sin empresa/rol elegido). */
  ctx: ActiveContextView | null;
  /** Hay sesión del proveedor de identidad (tokens), con o sin contexto. */
  signedIn: boolean;
  /** Arranque terminado (sesión restaurada y contexto revalidado). */
  booted: boolean;
  /** Última respuesta del servidor: true = hubo respuesta. */
  online: boolean;
  /**
   * Una petición tarda más de lo normal: 'starting' = el servicio no responde ni a /healthz
   * (está arrancando); 'slow' = el servidor está activo y la respuesta tarda; false = nada.
   */
  waking: 'starting' | 'slow' | false;
  /** Aviso pendiente para el selector (p. ej. la membresía dejó de valer). */
  notice: string | null;
  /** Membresías activas de la persona (para ofrecer «Cambiar empresa o rol» solo si hay más de una). */
  membershipCount: number;
}

export const useRuntime = create<RuntimeState>(() => ({
  ctx: null, signedIn: false, booted: false, online: true, waking: false, notice: null, membershipCount: 0,
}));

const listeners = new Set<(ctx: ActiveContextView | null) => void>();
/** Avisa cuando cambia el contexto (el puente de autenticación reconstruye usuario y empresa). */
export function onContextChange(fn: (ctx: ActiveContextView | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/**
 * Publica el contexto. Ronda 62: para el Cobrador, el modo sin conexión (llave, copia y pendientes)
 * se prepara ANTES de avisar a las pantallas, para que sus primeras lecturas ya puedan guardarse o,
 * sin conexión, responderse con la copia. `fromCache`: contexto de la copia del dispositivo (aún
 * sin revalidar); el servidor lo revalida en cuanto responde (`refreshContextFromServer`).
 */
async function publish(ctx: ActiveContextView | null, opts: { fromCache?: boolean } = {}) {
  if (ctx) await activate(ctx, opts).catch(() => undefined);
  else deactivate();
  useRuntime.setState({ ctx, signedIn: api().signedIn });
  for (const l of listeners) l(ctx);
  if (ctx && !opts.fromCache) {
    api().memberships()
      .then((list) => useRuntime.setState({ membershipCount: list.filter((m) => m.status === 'activo').length }))
      .catch(() => { /* solo decide si se ofrece el cambio de membresía */ });
  }
}

/** Huella de lo que decide permisos y alcance: si cambia, se publica el contexto nuevo. */
const fingerprint = (c: ActiveContextView) => JSON.stringify([c.membershipId, c.role, [...c.routeIds].sort(), [...c.capabilities].sort(), c.company.id, c.company.timezone]);

/**
 * Ronda 62: revalida el contexto con el SERVIDOR (disponibilidad efectiva + permisos vigentes).
 * Lanza si no hay respuesta; si la membresía ya no vale, el cliente vuelve al selector.
 */
export async function refreshContextFromServer(): Promise<ActiveContextView> {
  const fresh = await api().context();
  const cur = useRuntime.getState().ctx;
  if (!cur || fingerprint(cur) !== fingerprint(fresh)) await publish(fresh);
  else await confirmContext(fresh);
  return fresh;
}

/** Conecta los eventos del cliente con el estado visible (conexión, sesión, contexto). */
export function wireClient(c: OnlineClient): void {
  setClient(c);
  c.on((event, detail) => {
    if (event === 'network') useRuntime.setState({ online: detail === true });
    if (event === 'waking') useRuntime.setState({ waking: detail === 'starting' || detail === 'slow' ? detail : false });
    if (event === 'context') {
      // La membresía ya no vale (bloqueo, empresa suspendida…): fuera su copia de consulta; sus
      // pendientes quedan guardados (cifrados) por si la oficina la reactiva.
      const m = useRuntime.getState().ctx?.membershipId;
      if (m) void forgetMembershipData(m);
      useRuntime.setState({ notice: errorText({ code: String(detail) }) });
      void publish(null);
    }
    if (event === 'session') void publish(null);
  });
  window.addEventListener('offline', () => useRuntime.setState({ online: false }));
  window.addEventListener('online', () => useRuntime.setState({ online: true }));
}

/** Restaura la sesión guardada (solo tokens) y re-valida el contexto en el servidor. */
export async function boot(): Promise<void> {
  const c = api();
  try {
    if (await c.restore() && c.activeMembershipId) {
      try {
        await publish(await c.context());
      } catch (e) {
        // Ronda 62: SIN CONEXIÓN, el Cobrador abre su ruta con el contexto guardado (cifrado) de esta
        // misma identidad y membresía. Nada se autoriza con él: el servidor revalida al sincronizar.
        const snap = isConnectivityError(e) && c.identityId ? await cachedContext(c.identityId, c.activeMembershipId) : null;
        if (!snap) throw e;
        await publish(snap, { fromCache: true });
      }
    }
  } catch (e) {
    if (e instanceof ApiFailure && CONTEXT_LOST.has(e.code)) await c.clearContext();
  } finally {
    useRuntime.setState({ booted: true, signedIn: c.signedIn });
  }
}

/** Inicia sesión; si hay una sola membresía operable, entra directamente (DS-05). */
export async function signIn(email: string, password: string): Promise<SelectorDecision> {
  const c = api();
  const decision = await c.login(email, password);
  // Ronda 62: otra identidad en este dispositivo → fuera llaves y copias de las demás (sus pendientes quedan cifrados).
  if (c.identityId) await forgetOtherIdentities(c.identityId).catch(() => undefined);
  // Con una sola membresía se entra directamente: la sesión se marca como iniciada cuando
  // el contexto YA está elegido (si no, la puerta de acceso mostraría el selector un instante).
  if (decision.kind === 'auto') {
    try {
      await selectMembership(decision.membershipId);
    } finally {
      useRuntime.setState({ signedIn: c.signedIn, notice: null });
    }
    return decision;
  }
  useRuntime.setState({ signedIn: true, notice: null });
  return decision;
}

export async function selectMembership(membershipId: string): Promise<ActiveContextView> {
  const ctx = await api().select(membershipId);
  useRuntime.setState({ notice: null });
  await publish(ctx);
  return ctx;
}

/** Vuelve al selector conservando la sesión (cambiar de empresa o de rol). */
export async function leaveContext(): Promise<void> {
  await api().clearContext();
  await publish(null);
}

/**
 * Cierre de sesión. Ronda 62: se borran del dispositivo la llave y la copia de consulta de esta
 * identidad (otra persona no podrá verlas); las operaciones pendientes QUEDAN cifradas y se
 * enviarán cuando esta misma persona vuelva a entrar con internet.
 */
export async function signOut(scope: 'local' | 'global' = 'local'): Promise<void> {
  const identityId = api().identityId;
  await forgetOnSignOut(identityId);
  await api().logout(scope);
  await publish(null);
  useRuntime.setState({ signedIn: false });
}

/** Correo de la identidad en sesión (claim del token de acceso; solo para mostrar). */
export function sessionEmail(): string {
  try {
    const raw = (api() as unknown as { session: { accessToken: string } | null }).session?.accessToken ?? '';
    const payload = JSON.parse(atob(raw.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: string };
    return payload.email ?? '';
  } catch {
    return '';
  }
}
