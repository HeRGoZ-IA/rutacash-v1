import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { OnlineClient } from './lib/client.ts';
import './styles.css';

// OPERACIONES DE TRANSICIÓN (`/operaciones`): las pantallas de ADEX Online anteriores a
// la conversión de CLEAN, intactas y bajo su propio bundle y su propia hoja de estilos.
// Siguen disponibles para las operaciones que aún no se integraron en la pantalla
// original de CLEAN. Comparten la sesión de empresa (mismo almacén de sesión).
const env = import.meta.env as Record<string, string | undefined>;
const apiBase = (env['VITE_ADEX_API_URL'] ?? '').replace(/\/$/, '');
const supabaseUrl = (env['VITE_SUPABASE_URL'] ?? '').replace(/\/$/, '');
const publishableKey = env['VITE_SUPABASE_PUBLISHABLE_KEY'] ?? '';

const root = createRoot(document.getElementById('root')!);
if (!apiBase || !supabaseUrl || !publishableKey) {
  root.render(<main className="center"><p className="msg error">Configuración incompleta: falta VITE_ADEX_API_URL, VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY.</p></main>);
} else {
  root.render(<StrictMode><App basename="/operaciones" client={new OnlineClient({ apiBase, supabaseUrl, publishableKey })} /></StrictMode>);
}
