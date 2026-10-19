// Sesión y contexto de ADEX Online para el frontend de CLEAN.
//
// La sesión es la del cliente de modo servidor (`lib/client.ts`): tokens del proveedor
// de identidad y la membresía elegida, nada más. El contexto (empresa, rol, rutas y
// capacidades) lo DEVUELVE el servidor y se revalida al arrancar (DS-05): nunca se
// confía en lo guardado ni se suman permisos entre membresías.

import { create } from 'zustand';
import { ApiFailure, CONTEXT_LOST, type ActiveContextView, type OnlineClient, type SelectorDecision } from '../lib/client.ts';
import { errorText } from '../lib/format.ts';

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
  /** Una petición tarda: el servidor puede estar despertando (Render Free). */
  waking: boolean;
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
function publish(ctx: ActiveContextView | null) {
  useRuntime.setState({ ctx, signedIn: api().signedIn });
  for (const l of listeners) l(ctx);
  if (ctx) {
    api().memberships()
      .then((list) => useRuntime.setState({ membershipCount: list.filter((m) => m.status === 'activo').length }))
      .catch(() => { /* solo decide si se ofrece el cambio de membresía */ });
  }
}

/** Conecta los eventos del cliente con el estado visible (conexión, sesión, contexto). */
export function wireClient(c: OnlineClient): void {
  setClient(c);
  c.on((event, detail) => {
    if (event === 'network') useRuntime.setState({ online: detail === true });
    if (event === 'waking') useRuntime.setState({ waking: detail === true });
    if (event === 'context') { useRuntime.setState({ notice: errorText({ code: String(detail) }) }); publish(null); }
    if (event === 'session') publish(null);
  });
  window.addEventListener('offline', () => useRuntime.setState({ online: false }));
  window.addEventListener('online', () => useRuntime.setState({ online: true }));
}

/** Restaura la sesión guardada (solo tokens) y re-valida el contexto en el servidor. */
export async function boot(): Promise<void> {
  const c = api();
  try {
    if (await c.restore() && c.activeMembershipId) publish(await c.context());
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
  publish(ctx);
  return ctx;
}

/** Vuelve al selector conservando la sesión (cambiar de empresa o de rol). */
export async function leaveContext(): Promise<void> {
  await api().clearContext();
  publish(null);
}

export async function signOut(scope: 'local' | 'global' = 'local'): Promise<void> {
  await api().logout(scope);
  publish(null);
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
