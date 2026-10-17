import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { OnlineClient } from './lib/client.ts';
import './styles.css';

// Configuración pública de compilación (Vite). Ningún secreto: la clave PUBLICABLE de
// Supabase está pensada para el navegador; la secreta solo vive en el servidor.
const env = import.meta.env as Record<string, string | undefined>;
const apiBase = (env['VITE_ADEX_API_URL'] ?? '').replace(/\/$/, '');
const supabaseUrl = (env['VITE_SUPABASE_URL'] ?? '').replace(/\/$/, '');
const publishableKey = env['VITE_SUPABASE_PUBLISHABLE_KEY'] ?? '';

const root = createRoot(document.getElementById('root')!);
if (!apiBase || !supabaseUrl || !publishableKey) {
  root.render(<main className="center"><p className="msg error">Configuración incompleta: falta VITE_ADEX_API_URL, VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY.</p></main>);
} else {
  root.render(<StrictMode><App client={new OnlineClient({ apiBase, supabaseUrl, publishableKey })} /></StrictMode>);
}
