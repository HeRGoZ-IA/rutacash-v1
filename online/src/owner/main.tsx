import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OwnerApp } from './OwnerApp.tsx';
import { OwnerClient } from './client.ts';
import '../styles.css';

// Configuración pública de compilación. `VITE_ADEX_CONTROL_URL` es el SERVICIO OWNER
// (separado de la API de empresas). Sin ella, el panel no se activa.
const env = import.meta.env as Record<string, string | undefined>;
const controlBase = (env['VITE_ADEX_CONTROL_URL'] ?? '').replace(/\/$/, '');
const supabaseUrl = (env['VITE_SUPABASE_URL'] ?? '').replace(/\/$/, '');
const publishableKey = env['VITE_SUPABASE_PUBLISHABLE_KEY'] ?? '';

const root = createRoot(document.getElementById('root')!);
if (!controlBase || !supabaseUrl || !publishableKey) {
  root.render(
    <main className="center"><div className="card narrow"><h1 className="brand">ADEX <span>Owner</span></h1>
      <p className="msg warn">El panel Owner no está activado en este despliegue (falta el servicio Owner).</p>
      <p className="muted small">Las empresas entran por <a href="/login">ADEX Online</a>.</p></div></main>,
  );
} else {
  root.render(<StrictMode><OwnerApp client={new OwnerClient({ controlBase, supabaseUrl, publishableKey })} /></StrictMode>);
}
