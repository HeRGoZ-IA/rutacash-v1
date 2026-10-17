import type { ReactNode } from 'react';
import { useApp, useAction, useCtx, type Resource } from './lib/app.tsx';
import { errorText, money } from './lib/format.ts';

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Money({ minor }: { minor: number | null | undefined }) {
  const { company } = useCtx();
  return <span className="num">{money(minor, company.currencyCode, company.minorUnits)}</span>;
}

/** Estado de una lectura: cargando, error (con reintento) o contenido, y hora de la última actualización. */
export function Loaded<T>({ r, children, empty }: { r: Resource<T>; children: (data: T) => ReactNode; empty?: (data: T) => boolean }) {
  if (r.data === null && r.loading) return <p className="muted">Cargando…</p>;
  if (r.data === null && r.error) return <p className="msg error">{errorText(r.error)} <button className="link" onClick={() => void r.reload()}>Reintentar</button></p>;
  if (r.data === null) return null;
  return (
    <>
      {r.error ? <p className="msg error">{errorText(r.error)} · mostrando la última lectura del servidor</p> : null}
      {empty?.(r.data) ? <p className="muted">Sin registros.</p> : children(r.data)}
    </>
  );
}

export function Refresh({ r }: { r: Resource<unknown> }) {
  return (
    <button className="ghost" onClick={() => void r.reload()} disabled={r.loading} title="Volver a leer del servidor">
      {r.loading ? 'Actualizando…' : 'Actualizar'}
      {r.updatedAt ? <span className="muted small"> · {r.updatedAt.toLocaleTimeString('es-CO')}</span> : null}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="muted">{hint}</small> : null}
    </label>
  );
}

/** Resultado de una acción. Una operación incierta ofrece COMPROBAR (nunca «repetir» a ciegas). */
export function ActionMessage({ action, onResolved }: { action: ReturnType<typeof useAction>; onResolved?: () => void }) {
  const { client } = useApp();
  const m = action.message;
  if (!m) return null;
  if (m.kind === 'uncertain' && m.pending) {
    const pending = m.pending;
    return (
      <div className="msg warn" role="status">
        {m.text}
        <div className="row">
          <button disabled={action.busy} onClick={() => void action.run(() => client.resolveUncertain(pending), () => 'Operación confirmada por el servidor.').then((v) => { if (v) onResolved?.(); })}>
            Comprobar en el servidor
          </button>
          <span className="muted small">Identificador: {pending.operationId}</span>
        </div>
      </div>
    );
  }
  return <p className={`msg ${m.kind === 'ok' ? 'ok' : 'error'}`} role="status">{m.text}</p>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
