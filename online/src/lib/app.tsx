// Estado compartido de la aplicación: cliente, contexto activo y conexión. Datos de
// negocio NO: cada pantalla los pide al servidor y los vuelve a pedir (sin caché local).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiFailure, NetworkFailure, OnlineClient, UncertainOperation, type ActiveContextView } from './client.ts';
import { errorText } from './format.ts';

interface AppState {
  client: OnlineClient;
  ctx: ActiveContextView | null;
  setCtx: (c: ActiveContextView | null) => void;
  online: boolean;
  notice: string | null;
  setNotice: (n: string | null) => void;
  can: (capability: string) => boolean;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ client, children }: { client: OnlineClient; children: ReactNode }) {
  const [ctx, setCtx] = useState<ActiveContextView | null>(null);
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => client.on((event, detail) => {
    if (event === 'network') setOnline(detail === true);
    if (event === 'context') { setCtx(null); setNotice(errorText({ code: String(detail) })); }
    if (event === 'session') setCtx(null);
  }), [client]);
  useEffect(() => {
    const off = () => setOnline(false);
    window.addEventListener('offline', off);
    return () => window.removeEventListener('offline', off);
  }, []);
  const can = useCallback((c: string) => ctx?.capabilities.includes(c) ?? false, [ctx]);
  return <AppContext.Provider value={{ client, ctx, setCtx, online, notice, setNotice, can }}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppProvider missing');
  return v;
}

/** Contexto activo garantizado (las pantallas protegidas solo se montan con él). */
export function useCtx(): ActiveContextView & { can: (c: string) => boolean } {
  const { ctx, can } = useApp();
  if (!ctx) throw new Error('no active context');
  return { ...ctx, can };
}

export interface Resource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  updatedAt: Date | null;
}

/**
 * Lectura del servidor con refresco controlado: al montar, cada `intervalMs` mientras
 * la pestaña está visible, al volver a la pestaña y a demanda. Sin WebSockets.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 15_000): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await loadRef.current();
      if (mine === seq.current) { setData(v); setError(null); setUpdatedAt(new Date()); }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    const tick = () => { if (document.visibilityState === 'visible') void reload(); };
    const id = intervalMs > 0 ? window.setInterval(tick, intervalMs) : 0;
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, updatedAt };
}

/** Ejecuta una acción y traduce el resultado a un mensaje; distingue la incertidumbre. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'uncertain'; text: string; pending?: UncertainOperation } | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: (v: T) => string): Promise<T | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await fn();
      if (ok) setMessage({ kind: 'ok', text: ok(v) });
      return v;
    } catch (e) {
      if (e instanceof UncertainOperation) setMessage({ kind: 'uncertain', text: errorText(e), pending: e });
      else if (e instanceof NetworkFailure) setMessage({ kind: 'error', text: `${errorText(e)} La operación no se confirmó: se recargará el estado.` });
      else if (e instanceof ApiFailure) setMessage({ kind: 'error', text: errorText(e) });
      else setMessage({ kind: 'error', text: errorText(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, message, setMessage, run };
}
