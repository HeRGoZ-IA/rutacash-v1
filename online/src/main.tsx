import React from 'react';
import ReactDOM from 'react-dom/client';
// Hoja de estilos ORIGINAL de CLEAN (Tailwind con su tema).
import '@clean/styles/globals.css';
import { OnlineClient } from './lib/client.ts';
import { wireClient } from './runtime/session.ts';
// Lista blanca de escrituras de las pantallas de CLEAN traducidas a comandos de la API.
import './runtime/writeAdapters.ts';
import { startPolling } from './runtime/projection.ts';
import { startOfflineSync } from './offline/sync.ts';
import { CleanOnlineApp } from './runtime/CleanOnlineApp.tsx';

// ADEX Online: el frontend de CLEAN conectado a la API SaaS. Configuración pública de
// compilación (Vite); ningún secreto: la clave PUBLICABLE de Supabase es para el navegador.
// 3.10: cada variable se lee por su nombre. Leer `import.meta.env` entero incrusta en el código
// público TODAS las VITE_* (Vercel añade el mensaje y el autor del commit, el repositorio…).
const apiBase = ((import.meta.env.VITE_ADEX_API_URL as string | undefined) ?? '').replace(/\/$/, '');
const supabaseUrl = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').replace(/\/$/, '');
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '';
// Solo el commit queda a la vista: `npm run verify:deploy` lo lee para saber qué versión se sirve.
document.documentElement.dataset.adexCommit = (import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA as string | undefined) ?? 'local';

const root = ReactDOM.createRoot(document.getElementById('root')!);
if (!apiBase || !supabaseUrl || !publishableKey) {
  root.render(
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
        Configuración incompleta: falta VITE_ADEX_API_URL, VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY.
      </div>
    </div>,
  );
} else {
  wireClient(new OnlineClient({ apiBase, supabaseUrl, publishableKey }));
  startPolling();
  // Ronda 62: sincronización de lo capturado sin conexión (Cobrador) y app disponible sin internet.
  startOfflineSync();
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* sin modo sin conexión de la app */ }); });
  }
  root.render(
    <React.StrictMode>
      <CleanOnlineApp />
    </React.StrictMode>,
  );
}
