// PLATAFORMA OWNER de ADEX Online (página propia `/owner`, bundle propio) — Ronda 40.
//
// Son las pantallas ORIGINALES de CLEAN (src/pages/owner/*: acceso, marco, Dashboard,
// Empresas, ficha, Cobros y Configuración) con las mismas rutas que `src/app/App.tsx`.
// Solo cambian la sesión y los datos: el puente (`src/bridge/hooks/useOwnerAuth.ts`,
// `src/bridge/platform/*`) habla con el SERVICIO OWNER (`VITE_ADEX_CONTROL_URL`,
// /control/v1/*), separado de la API de empresas. Este bundle no importa nada de la sesión
// ni de los datos de empresa: ser Owner no es entrar en una empresa.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
// Hoja de estilos ORIGINAL de CLEAN (Tailwind con su tema), igual que el bundle de empresas.
import '@clean/styles/globals.css';
import OwnerAuthEntry from '@/pages/owner/OwnerAuthEntry';
import { OwnerLayout } from '@/pages/owner/OwnerLayout';
import OwnerDashboardPage from '@/pages/owner/OwnerDashboardPage';
import OwnerCompaniesPage from '@/pages/owner/OwnerCompaniesPage';
import OwnerCompanyDetailPage from '@/pages/owner/OwnerCompanyDetailPage';
import OwnerBillingPage from '@/pages/owner/OwnerBillingPage';
import OwnerSettingsPage from '@/pages/owner/OwnerSettingsPage';
import { Toaster } from '@/components/ui/Toast';
import { connectOwnerApi } from '@/platform/controlPlane';
import { connectOwnerSession, useOwnerAuth } from '@/hooks/useOwnerAuth';
import { OwnerClient } from './client.ts';

/**
 * Guard del portal Owner: la MISMA regla que `RequireOwner` / `ownerGuardDecision` de CLEAN
 * (src/components/auth/guardRules.ts): sin sesión, cuenta inactiva o rol distinto de Owner →
 * `/owner/login`. No se importan `guards.tsx` ni `guardRules.ts` porque también contienen las
 * reglas de EMPRESA (permisos) y, con ellas, la sesión de empresa entraría en el bundle Owner.
 */
function RequireOwner({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, owner } = useOwnerAuth();
  if (!isAuthenticated || !owner || owner.status !== 'activo' || owner.rol !== 'owner') return <Navigate to="/owner/login" replace />;
  return <>{children}</>;
}

function OwnerApp() {
  // Igual que el arranque de CLEAN (`booting`): la sesión se revalida contra el servidor
  // antes de decidir si se muestra el portal o el acceso.
  const [booting, setBooting] = useState(true);
  useEffect(() => { void useOwnerAuth.getState().revalidate().finally(() => setBooting(false)); }, []);
  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="w-8 h-8 border-2 border-primary-300/30 border-t-primary-400 rounded-full animate-spin" />
      </div>
    );
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/owner/login" element={<OwnerAuthEntry />} />
        <Route path="/owner" element={<RequireOwner><OwnerLayout /></RequireOwner>}>
          <Route index element={<OwnerDashboardPage />} />
          <Route path="empresas" element={<OwnerCompaniesPage />} />
          <Route path="empresas/:companyId" element={<OwnerCompanyDetailPage />} />
          <Route path="cobros" element={<OwnerBillingPage />} />
          <Route path="configuracion" element={<OwnerSettingsPage />} />
          <Route path="*" element={<Navigate to="/owner" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/owner" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  );
}

// Configuración pública de compilación. `VITE_ADEX_CONTROL_URL` es el SERVICIO OWNER
// (separado de la API de empresas). Sin ella, el portal no se activa.
const env = import.meta.env as Record<string, string | undefined>;
const controlBase = (env['VITE_ADEX_CONTROL_URL'] ?? '').replace(/\/$/, '');
const supabaseUrl = (env['VITE_SUPABASE_URL'] ?? '').replace(/\/$/, '');
const publishableKey = env['VITE_SUPABASE_PUBLISHABLE_KEY'] ?? '';

const root = createRoot(document.getElementById('root')!);
if (!controlBase || !supabaseUrl || !publishableKey) {
  root.render(
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-[#0B1220] to-gray-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md">
        <h1 className="text-xl font-bold text-gray-900">Acceso Owner</h1>
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 mt-3">
          La Plataforma Owner no está activada en este despliegue (falta el servicio Owner).
        </p>
        <p className="text-sm text-gray-500 mt-3">Si eres cliente, entra por <a href="/login" className="text-primary-600 font-medium hover:underline">/login</a>.</p>
      </div>
    </div>,
  );
} else {
  const client = new OwnerClient({ controlBase, supabaseUrl, publishableKey });
  connectOwnerApi({ get: (p) => client.get(p), send: (m, p, b) => client.send(m, p, b) });
  connectOwnerSession({
    login: (email, password) => client.login(email, password),
    restore: async () => ((await client.restore()) ? client.profile() : null),
    logout: () => client.logout(),
    changePassword: (current, next) => client.changePassword(current, next),
    email: () => client.email(),
    onLost: (l) => { client.on((e) => { if (e === 'session') l(); }); },
  });
  root.render(<StrictMode><OwnerApp /></StrictMode>);
}
