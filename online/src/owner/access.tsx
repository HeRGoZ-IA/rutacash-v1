// Entrada al panel Owner: inicio de sesión, «primer acceso / olvidé mi contraseña» y la
// pantalla a la que vuelve el enlace del proveedor para FIJAR la contraseña. La
// contraseña solo viaja a Supabase Auth; ni ADEX ni este panel la guardan.

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field, Message, useAction, useOwner } from './kit.tsx';

export function OwnerLogin() {
  const { client, setProfile, notice, setNotice } = useOwner();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (mode === 'recover') {
      await action.run(() => client.recover(email), () => 'Si el correo es de un Owner, recibirá un enlace para fijar su contraseña. Ábralo en este mismo navegador.');
      return;
    }
    const p = await action.run(() => client.login(email, password));
    setPassword('');
    if (p) { setProfile(p); nav('/'); }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1 className="brand">ADEX <span>Owner</span></h1>
        <p className="muted">Panel del propietario de ADEX Soluciones. No da acceso a los datos financieros de las empresas.</p>
        {notice ? <p className="msg ok" role="status">{notice}</p> : null}
        <Field label="Correo"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {mode === 'login' ? (
          <Field label="Contraseña"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        ) : null}
        <button className="primary" disabled={action.busy}>{mode === 'login' ? (action.busy ? 'Entrando…' : 'Entrar') : 'Enviar enlace'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'recover' : 'login'); action.setMessage(null); }}>
          {mode === 'login' ? 'Primer acceso / olvidé mi contraseña' : 'Volver a iniciar sesión'}
        </button>
        <Message action={action} />
        <p className="muted small">¿Es una empresa? Entre por <a href="/login">ADEX Online</a>.</p>
      </form>
    </main>
  );
}

/** Lee el fragmento `#access_token=…&type=recovery|invite` que deja el enlace del proveedor. */
export function linkFromHash(hash: string): { token: string; type: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const token = p.get('access_token');
  const type = p.get('type') ?? '';
  return token && ['recovery', 'invite', 'signup', 'magiclink'].includes(type) ? { token, type } : null;
}

export function SetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const { client } = useOwner();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const action = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await action.run(async () => {
      if (a.length < 12) throw Object.assign(new Error('PASSWORD_SHORT'), { code: 'PASSWORD_SHORT' });
      if (a !== b) throw Object.assign(new Error('PASSWORD_MISMATCH'), { code: 'PASSWORD_MISMATCH' });
      await client.setPasswordFromLink(token, a);
      return true;
    });
    setA(''); setB('');
    if (ok) { window.history.replaceState(null, '', window.location.pathname); onDone(); }
  }
  return (
    <main className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1 className="brand">ADEX <span>Owner</span></h1>
        <h2>Fijar contraseña</h2>
        <p className="muted small">Elija una contraseña privada (12 caracteres o más). Se guarda solo en el proveedor de identidad; nadie de ADEX la conoce.</p>
        <Field label="Nueva contraseña"><input type="password" autoComplete="new-password" required value={a} onChange={(e) => setA(e.target.value)} /></Field>
        <Field label="Repítala"><input type="password" autoComplete="new-password" required value={b} onChange={(e) => setB(e.target.value)} /></Field>
        <button className="primary" disabled={action.busy}>Guardar contraseña</button>
        <Message action={action} />
      </form>
    </main>
  );
}
