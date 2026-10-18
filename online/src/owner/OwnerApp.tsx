// PANEL OWNER de ADEX Soluciones (página propia `/owner`, bundle propio). Rutas:
//   /owner/login · /owner (panel general) · /owner/empresas · /owner/empresas/:id
//   /owner/facturacion · /owner/configuracion
// Si la URL trae el enlace del proveedor (#access_token…&type=recovery), primero se
// fija la contraseña.

import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import type { OwnerClient, OwnerProfile } from './client.ts';
import { linkFromHash, OwnerLogin, SetPassword } from './access.tsx';
import { OwnerCtx, useOwner } from './kit.tsx';
import { Billing, Companies, CompanyDetail, Dashboard, Settings } from './screens.tsx';

export function OwnerApp({ client }: { client: OwnerClient }) {
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [ready, setReady] = useState(false);
  const [link, setLink] = useState(() => linkFromHash(window.location.hash));
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => client.on((e) => { if (e === 'session') setProfile(null); }), [client]);
  useEffect(() => {
    void (async () => {
      try { if (await client.restore()) setProfile(await client.profile()); } catch { /* sin sesión válida: al login */ } finally { setReady(true); }
    })();
  }, [client]);
  const value = { client, profile, setProfile, notice, setNotice };
  if (link) return <OwnerCtx.Provider value={value}><SetPassword token={link.token} onDone={() => { setNotice('Contraseña fijada. Ya puede iniciar sesión.'); setLink(null); }} /></OwnerCtx.Provider>;
  if (!ready) return <main className="center"><p className="muted">Conectando con el servicio Owner…</p></main>;
  return (
    <OwnerCtx.Provider value={value}>
      <BrowserRouter basename="/owner">
        <Routes>
          <Route path="/login" element={<OwnerLogin />} />
          <Route element={<RequireOwner />}>
            <Route index element={<Dashboard />} />
            <Route path="empresas" element={<Companies />} />
            <Route path="empresas/:id" element={<CompanyDetail />} />
            <Route path="facturacion" element={<Billing />} />
            <Route path="configuracion" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </OwnerCtx.Provider>
  );
}

function RequireOwner() {
  const { client, profile } = useOwner();
  if (!client.signedIn || !profile) return <Navigate to="/login" replace />;
  return <Shell><Outlet /></Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { client, profile } = useOwner();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [waking, setWaking] = useState(false);
  useEffect(() => client.on((e, on) => { if (e === 'waking') setWaking(Boolean(on)); }), [client]);
  return (
    <div className="shell">
      {waking ? <div className="banner info" role="status">Activando el servicio Owner: la primera conexión tras un rato sin uso puede tardar hasta un minuto.</div> : null}
      <div className="banner info">Panel Owner · datos comerciales y estructurales. Sin acceso a clientes, préstamos, capital, recaudos ni gastos de las empresas.</div>
      <header className="top">
        <Link to="/" className="brand small">ADEX <span>Owner</span></Link>
        <div className="who"><strong>{profile?.displayName}</strong><span className="muted small">Owner · ADEX Soluciones</span></div>
        <button className="ghost menu-toggle" onClick={() => setMenu(!menu)} aria-expanded={menu}>Menú</button>
      </header>
      <div className="body">
        <nav className={`side ${menu ? 'open' : ''}`} onClick={() => setMenu(false)}>
          <NavLink to="/" end>Panel general</NavLink>
          <NavLink to="/empresas">Empresas</NavLink>
          <NavLink to="/facturacion">Facturación</NavLink>
          <NavLink to="/configuracion">Configuración</NavLink>
          <hr />
          <button className="link" onClick={() => void client.logout().then(() => nav('/login'))}>Cerrar sesión</button>
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
