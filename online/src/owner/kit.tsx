// Piezas del panel Owner: contexto, lecturas, acciones, formato y componentes mínimos.
// No importa nada del cliente de empresas (sesiones y bundles separados).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OwnerClient, OwnerProfile } from './client.ts';

export interface OwnerState {
  client: OwnerClient;
  profile: OwnerProfile | null;
  setProfile: (p: OwnerProfile | null) => void;
  /** Aviso para la pantalla de entrada (p. ej. tras fijar la contraseña por enlace). */
  notice: string | null;
  setNotice: (n: string | null) => void;
}
export const OwnerCtx = createContext<OwnerState | null>(null);
export function useOwner(): OwnerState {
  const v = useContext(OwnerCtx);
  if (!v) throw new Error('OwnerCtx missing');
  return v;
}

export interface Resource<T> { data: T | null; error: unknown; loading: boolean; reload: () => Promise<void> }

export function useResource<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 60_000): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await loadRef.current();
      if (mine === seq.current) { setData(v); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    const id = intervalMs > 0 ? window.setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, intervalMs) : 0;
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: (v: T) => string): Promise<T | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const v = await fn();
      if (ok) setMessage({ ok: true, text: ok(v) });
      return v;
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, message, setMessage, run };
}

const ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  AUTH_UNAVAILABLE: 'El servicio de identidad no responde. Inténtelo de nuevo.',
  OPERATOR_REQUIRED: 'Esta cuenta no es Owner de ADEX Soluciones. El panel Owner es solo para el propietario; las empresas entran por ADEX Online.',
  SESSION_REVOKED: 'La sesión se cerró. Vuelva a iniciar sesión.',
  SESSION_EXPIRED: 'La sesión caducó. Vuelva a iniciar sesión.',
  NOT_SIGNED_IN: 'Inicie sesión.',
  INVALID_TOKEN: 'La sesión no es válida. Vuelva a iniciar sesión.',
  NETWORK: 'Sin conexión con el servicio Owner. Compruebe la conexión; si el servicio estaba en reposo puede tardar hasta un minuto en despertar.',
  NOT_FOUND: 'No existe.',
  WEAK_PASSWORD: 'La contraseña es demasiado débil para el proveedor de identidad. Use al menos 12 caracteres combinando letras, números y símbolos.',
  LINK_EXPIRED: 'El enlace caducó o ya se usó. Pida otro con «Primer acceso / olvidé mi contraseña».',
  PASSWORD_MISMATCH: 'Las dos contraseñas no coinciden.',
  PASSWORD_SHORT: 'Use al menos 12 caracteres.',
  INVALID_NAME: 'Indique el nombre.',
  INVALID_EMAIL: 'Correo no válido.',
  INVALID_COUNTRYCODE: 'País no válido.',
  INVALID_CURRENCYCODE: 'Moneda no válida.',
  INVALID_BILLINGRATE: 'Tarifa no válida (número con hasta 2 decimales).',
  INVALID_BILLINGMODE: 'Modo de facturación no válido.',
  INVALID_NEXTBILLINGDATE: 'Fecha de próximo cobro no válida.',
  INVALID_PERIOD: 'Periodo no válido (AAAA-MM).',
  INVALID_AMOUNT: 'Importe no válido (mayor que cero, hasta 2 decimales).',
  INVALID_EXPECTEDDATE: 'Indique la fecha esperada del cobro.',
  INVALID_PAIDDATE: 'Un cobro «Pagado» necesita fecha de pago (y solo él).',
  INVALID_DISPLAYNAME: 'Indique el nombre visible.',
  PERMISSION_DENIED: 'Operación no permitida.',
  IDENTITY_PROVIDER_ERROR: 'El proveedor de identidad no pudo crear la invitación.',
  RATE_LIMITED: 'Demasiadas peticiones seguidas. Espere un minuto.',
  INTERNAL: 'Error interno del servicio Owner.',
};
export function errorText(e: unknown): string {
  const code = (e as { code?: string })?.code ?? (e as Error)?.message ?? 'ERROR';
  if (code === 'FORBIDDEN' || code === '42501') return 'Operación no permitida para el Owner.';
  return ERRORS[code] ?? `No se pudo completar (${code}).`;
}

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  trial: { label: 'En prueba', tone: 'warn' }, active: { label: 'Activa', tone: 'ok' }, suspended: { label: 'Suspendida', tone: 'bad' },
};
export const PAY: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente', tone: 'warn' }, paid: { label: 'Pagado', tone: 'ok' }, overdue: { label: 'Vencido', tone: 'bad' },
};
export const BILLING: Record<string, string> = { per_route: 'Por ruta facturable', fixed: 'Tarifa fija' };
export const EVENT: Record<string, string> = {
  COMPANY_CREATED: 'Empresa creada', COMPANY_ACTIVATED: 'Activada', COMPANY_SUSPENDED: 'Suspendida', FIRST_LOGIN: 'Primer acceso',
  LOGIN: 'Acceso', ROUTE_CREATED: 'Ruta creada', ROUTE_DEACTIVATED: 'Ruta desactivada', ROUTE_DELETED: 'Ruta eliminada',
  BILLING_UPDATED: 'Facturación actualizada', PAYMENT_REGISTERED: 'Cobro registrado',
};

export const amount = (n: number | null | undefined) => (n === null || n === undefined ? '—'
  : new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n));
export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleString('es-CO', iso.length === 10 ? { dateStyle: 'medium' } : { dateStyle: 'short', timeStyle: 'short' });
}

export interface Company {
  companyId: string; name: string; taxId: string | null; contactName: string | null; contactEmail: string | null; createdAt: string;
  firstLoginAt: string | null; lastLoginAt: string | null; status: string; routeCount: number; billableRouteCount: number;
  billingMode: string; billingRate: number; nextBillingDate: string | null; paymentStatus: string; updatedAt: string;
}
export interface Payment { id: string; period: string; amount: number; expectedDate: string; paidDate: string | null; status: string; note: string | null; companyId?: string; companyName?: string }
/** Cobro esperado del periodo según las condiciones de la empresa. */
export const expected = (c: Company) => (c.billingMode === 'fixed' ? c.billingRate : c.billingRate * c.billableRouteCount);

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head"><h2>{title}</h2>{actions ? <div className="card-actions">{actions}</div> : null}</header>
      {children}
    </section>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small className="muted">{hint}</small> : null}</label>;
}
export function Message({ action }: { action: ReturnType<typeof useAction> }) {
  const m = action.message;
  return m ? <p className={`msg ${m.ok ? 'ok' : 'error'}`} role="status">{m.text}</p> : null;
}
export function Loaded<T>({ r, children }: { r: Resource<T>; children: (data: T) => ReactNode }) {
  if (r.data === null && r.loading) return <p className="muted">Cargando…</p>;
  if (r.data === null && r.error) return <p className="msg error">{errorText(r.error)} <button className="link" onClick={() => void r.reload()}>Reintentar</button></p>;
  if (r.data === null) return null;
  return <>{r.error ? <p className="msg error">{errorText(r.error)} · mostrando la última lectura</p> : null}{children(r.data)}</>;
}
export function Refresh({ r }: { r: Resource<unknown> }) {
  return <button className="ghost" onClick={() => void r.reload()} disabled={r.loading}>{r.loading ? 'Actualizando…' : 'Actualizar'}</button>;
}
export function Confirm({ label, question, onConfirm, disabled, danger = true }: { label: string; question: ReactNode; onConfirm: () => unknown; disabled?: boolean; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="confirm" role="alertdialog">
      <p>{question}</p>
      <div className="row">
        <button type="button" className={danger ? 'danger' : 'primary'} disabled={disabled} onClick={() => { setOpen(false); void onConfirm(); }}>Confirmar</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancelar</button>
      </div>
    </div>
  );
}
