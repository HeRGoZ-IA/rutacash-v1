// Rutas y protección: sin sesión → /login; sin contexto activo → /contexto. El
// contexto se re-valida con el servidor al cargar (nunca se confía en lo guardado).

import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { AppProvider, useApp, useResource } from './lib/app.tsx';
import { ApiFailure, CONTEXT_LOST, type OnlineClient } from './lib/client.ts';
import { errorText, ROLE } from './lib/format.ts';
import { navFor } from './nav.ts';
import { ContextSelector, Login } from './screens/Access.tsx';
import { Clients } from './screens/Clients.tsx';
import { Capital, MyCash } from './screens/Capital.tsx';
import { Authorizations, Disbursements, Requests } from './screens/Credits.tsx';
import { Home, Upcoming } from './screens/Home.tsx';
import { DemoAdmin } from './screens/DemoAdmin.tsx';

export function App({ client }: { client: OnlineClient }) {
  return (
    <AppProvider client={client}>
      <BrowserRouter>
        <Boot>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireSession />}>
              <Route path="/contexto" element={<ContextSelector />} />
              <Route path="/demo-admin" element={<Plain><DemoAdmin /></Plain>} />
              <Route path="/app" element={<RequireContext />}>
                <Route index element={<Home />} />
                <Route path="clientes" element={<Clients />} />
                <Route path="capital" element={<Capital />} />
                <Route path="mi-efectivo" element={<MyCash />} />
                <Route path="solicitudes" element={<Requests />} />
                <Route path="autorizaciones" element={<Authorizations />} />
                <Route path="desembolsos" element={<Disbursements />} />
                <Route path="proximamente" element={<Upcoming />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </Boot>
      </BrowserRouter>
    </AppProvider>
  );
}

/** Restaura la sesión guardada (solo tokens) y re-valida el contexto en el servidor. */
function Boot({ children }: { children: ReactNode }) {
  const { client, setCtx } = useApp();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        if (await client.restore() && client.activeMembershipId) setCtx(await client.context());
      } catch (e) {
        if (e instanceof ApiFailure && CONTEXT_LOST.has(e.code)) await client.clearContext();
      } finally {
        setReady(true);
      }
    })();
  }, [client, setCtx]);
  return ready ? <>{children}</> : <main className="center"><p className="muted">Conectando…</p></main>;
}

function RequireSession() {
  const { client } = useApp();
  return client.signedIn ? <Outlet /> : <Navigate to="/login" replace />;
}

function RequireContext() {
  const { client, ctx } = useApp();
  if (!client.signedIn) return <Navigate to="/login" replace />;
  if (!ctx) return <Navigate to="/contexto" replace />;
  return <Shell><Outlet /></Shell>;
}

function ConnectionBanner() {
  const { online } = useApp();
  return online ? null : <div className="banner bad" role="alert">Conexión perdida con el servidor. Nada se guarda en este dispositivo: reintente cuando vuelva la conexión.</div>;
}

function Plain({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <ConnectionBanner />
      <header className="top"><Link to="/contexto" className="brand small">ADEX <span>Online</span></Link><Link to="/contexto">Volver</Link></header>
      <main className="content">{children}</main>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { client, ctx, setCtx } = useApp();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const demoOperator = useResource(async () => { try { await client.demo('GET', '/slots/principal'); return true; } catch { return false; } }, [], 0);
  if (!ctx) return null;
  return (
    <div className="shell">
      <ConnectionBanner />
      {ctx.company.isDemo ? <div className="banner info">Empresa Demo · todos los clientes y movimientos son ficticios</div> : null}
      <header className="top">
        <Link to="/app" className="brand small">ADEX <span>Online</span></Link>
        <div className="who">
          <strong>{ctx.company.name}</strong>
          <span className="muted small">{ROLE[ctx.role] ?? ctx.role}</span>
        </div>
        <button className="ghost menu-toggle" onClick={() => setMenu(!menu)} aria-expanded={menu}>Menú</button>
      </header>
      <div className="body">
        <nav className={`side ${menu ? 'open' : ''}`} onClick={() => setMenu(false)}>
          {navFor(ctx).map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/app'}>{n.label}</NavLink>)}
          <hr />
          {demoOperator.data ? <NavLink to="/demo-admin">Administrar Empresa Demo</NavLink> : null}
          <button className="link" onClick={() => void client.clearContext().then(() => { setCtx(null); nav('/contexto'); })}>Cambiar empresa o rol</button>
          <button className="link" onClick={() => void client.logout().then(() => nav('/login'))}>Cerrar sesión</button>
          <button className="link" onClick={() => void client.logout('global').then(() => nav('/login'))}>Cerrar sesión en todos los dispositivos</button>
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function ErrorScreen({ error }: { error: unknown }) {
  return <main className="center"><p className="msg error">{errorText(error)}</p></main>;
}
