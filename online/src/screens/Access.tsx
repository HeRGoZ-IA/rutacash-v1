// Inicio de sesión (Supabase Auth: la contraseña solo viaja al proveedor) y selección
// EXPLÍCITA de empresa, membresía y rol (DS-05).

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, useAction, useResource } from '../lib/app.tsx';
import { decideContextOptions } from '../lib/selector.ts';
import { errorText, ROLE } from '../lib/format.ts';
import type { SelectableMembership } from '../lib/client.ts';
import { ActionMessage, Badge } from '../ui.tsx';

export function Login() {
  const { client, setCtx } = useApp();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'recover') {
      await action.run(() => client.recover(email), () => 'Si el correo tiene acceso, recibirá un enlace para fijar su contraseña.');
      return;
    }
    const decision = await action.run(() => client.login(email, password));
    setPassword('');
    if (!decision) return;
    if (decision.kind === 'auto') {
      const ctx = await action.run(() => client.select(decision.membershipId));
      if (ctx) { setCtx(ctx); nav('/app'); }
      return;
    }
    nav('/contexto');
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1 className="brand">ADEX <span>Online</span></h1>
        <p className="muted">Acceso privado. Solo usuarios invitados.</p>
        <label className="field"><span>Correo</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'login' ? (
          <label className="field"><span>Contraseña</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        ) : null}
        <button className="primary" disabled={action.busy}>{mode === 'login' ? (action.busy ? 'Entrando…' : 'Entrar') : 'Enviar enlace'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'recover' : 'login'); action.setMessage(null); }}>
          {mode === 'login' ? 'Olvidé mi contraseña / primer acceso' : 'Volver a iniciar sesión'}
        </button>
        <ActionMessage action={action} />
      </form>
    </main>
  );
}

export function ContextSelector() {
  const { client, setCtx, notice, setNotice } = useApp();
  const nav = useNavigate();
  const [list, setList] = useState<SelectableMembership[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const action = useAction();
  const demoOperator = useResource(async () => { try { await client.demo('GET', '/slots/principal'); return true; } catch { return false; } }, [], 0);

  useEffect(() => {
    client.memberships().then(setList, setError);
  }, [client]);

  async function choose(id: string) {
    setNotice(null);
    const ctx = await action.run(() => client.select(id));
    if (ctx) { setCtx(ctx); nav('/app'); }
  }

  const options = list ? decideContextOptions(list) : [];
  return (
    <main className="center">
      <div className="card narrow">
        <h1>Elegir empresa y rol</h1>
        <p className="muted">Cada operación se hace con UNA membresía. Los permisos no se suman entre roles.</p>
        {notice ? <p className="msg warn">{notice}</p> : null}
        {error ? <p className="msg error">{errorText(error)}</p> : null}
        {list === null && !error ? <p className="muted">Cargando…</p> : null}
        {list && options.length === 0 ? <p className="msg warn">No tiene membresías activas.</p> : null}
        <ul className="choices">
          {options.map((o) => (
            <li key={o.membershipId}>
              <button className="choice" disabled={!o.selectable || action.busy} onClick={() => void choose(o.membershipId)}>
                <strong>{o.companyName}</strong>
                <span>{ROLE[o.role] ?? o.role} · {o.countryCode}</span>
                {o.isDemo ? <Badge tone="info">Empresa Demo · datos ficticios</Badge> : null}
                {o.notice ? <small className="muted">{o.notice}</small> : null}
              </button>
            </li>
          ))}
        </ul>
        <ActionMessage action={action} />
        {demoOperator.data ? <Link to="/demo-admin">Administrar Empresa Demo</Link> : null}
        <button className="link" onClick={() => void client.logout().then(() => nav('/login'))}>Cerrar sesión</button>
      </div>
    </main>
  );
}
