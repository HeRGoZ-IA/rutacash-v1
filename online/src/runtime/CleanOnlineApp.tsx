// Rutas de ADEX Online sobre el frontend de CLEAN.
//
// Las rutas del panel de empresa son LAS MISMAS de `src/app/App.tsx` (CLEAN), con las
// mismas pantallas y el mismo layout. Diferencias:
//   · `/login` es la LoginPage original; si la persona tiene varias membresías, pasa por
//     `/contexto` (DS-05) antes de entrar.
//   · El portal Owner no vive aquí: es otra página y otro servicio (DS-17).
//   · Las pantallas aún no conectadas al servidor muestran `PendingModule` (ver
//     `pending.ts`) en vez de cifras vacías o locales.
//   · Roles cuya conversión no se ha hecho todavía (Cobrador, Supervisor, Socio,
//     Secretario) ven un aviso y el acceso a las pantallas Online de transición.

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/ui/Toast';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { RequireAuth } from '@/components/auth/guards';
import { useAuth } from '@/hooks/useAuth';
import LoginPage from '@/pages/auth/LoginPage';
import DashboardPage from '@/pages/admin/DashboardPage';
import OfficesPage from '@/pages/admin/OfficesPage';
import OfficeDetailPage from '@/pages/admin/OfficeDetailPage';
import UnassignedRoutesPage from '@/pages/admin/UnassignedRoutesPage';
import RoutesPage from '@/pages/admin/RoutesPage';
import ClientsPage from '@/pages/admin/ClientsPage';
import ActiveSalesPage from '@/pages/admin/ActiveSalesPage';
import ExpensesPage from '@/pages/admin/ExpensesPage';
import CapitalPage from '@/pages/admin/CapitalPage';
import TransfersPage from '@/pages/admin/TransfersPage';
import MovementHistoryPage from '@/pages/admin/MovementHistoryPage';
import MovementReceiptPage from '@/pages/admin/MovementReceiptPage';
import WithdrawalsPage from '@/pages/admin/WithdrawalsPage';
import ExpenseCategoriesPage from '@/pages/admin/ExpenseCategoriesPage';
import SaleAuthorizationsPage from '@/pages/admin/SaleAuthorizationsPage';
import UsersPage from '@/pages/admin/UsersPage';
import SettingsPage from '@/pages/admin/SettingsPage';
import { boot, useRuntime } from './session.ts';
import { ContextSelectPage } from './ContextSelectPage.tsx';
import { PendingModule } from './PendingModule.tsx';
import { PENDING, RoleConversionPending } from './pending.tsx';

function Boot({ children }: { children: ReactNode }) {
  const booted = useRuntime((s) => s.booted);
  const ctx = useRuntime((s) => s.ctx);
  const { isAuthenticated, isLoading } = useAuth();
  useEffect(() => { void boot(); }, []);
  // Hasta revalidar el contexto con el servidor no se decide qué pantalla mostrar.
  if (!booted || (ctx && !isAuthenticated && isLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="w-8 h-8 border-2 border-primary-300/30 border-t-primary-400 rounded-full animate-spin" />
      </div>
    );
  }
  return <>{children}</>;
}

/** LoginPage original; con sesión pero sin contexto elegido → selector de empresa y rol. */
function LoginGate() {
  const signedIn = useRuntime((s) => s.signedIn);
  const ctx = useRuntime((s) => s.ctx);
  if (signedIn && !ctx) return <Navigate to="/contexto" replace />;
  return <LoginPage />;
}

const pending = (key: keyof typeof PENDING) => <PendingModule info={PENDING[key]} />;

export function CleanOnlineApp() {
  return (
    <BrowserRouter>
      <Boot>
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route path="/contexto" element={<ContextSelectPage />} />
          <Route path="/" element={<Navigate to="/login" replace />} />

          {/* Comprobante imprimible (CLEAN), con los registros del libro central. */}
          <Route path="/comprobante/:fuente/:id" element={
            <RequireAuth roles={['admin', 'superadmin']}>
              <MovementReceiptPage />
            </RequireAuth>
          } />

          <Route path="/admin" element={
            <RequireAuth roles={['admin', 'superadmin']}>
              <AdminLayout />
            </RequireAuth>
          }>
            <Route index element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="offices" element={<OfficesPage />} />
            <Route path="offices/sin-oficina" element={<UnassignedRoutesPage />} />
            <Route path="offices/:officeId" element={<OfficeDetailPage />} />
            <Route path="routes" element={<RoutesPage />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="active-sales" element={<ActiveSalesPage />} />
            <Route path="sale-authorizations" element={<SaleAuthorizationsPage />} />
            <Route path="payment-adjustments" element={pending('paymentAdjustments')} />
            <Route path="capital" element={<CapitalPage />} />
            {/* En el SaaS el capital centralizado rige desde el alta: no hay transición. */}
            <Route path="capital/transicion" element={<Navigate to="/admin/capital" replace />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="expense-categories" element={<ExpenseCategoriesPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="movements" element={<MovementHistoryPage />} />
            <Route path="partner-cash" element={pending('partnerCash')} />
            <Route path="withdrawals" element={<WithdrawalsPage />} />
            <Route path="cashbox" element={pending('cashbox')} />
            <Route path="reports" element={pending('reports')} />
            <Route path="weekly-settlement" element={pending('weeklySettlement')} />
            <Route path="users" element={<UsersPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          {['socio', 'secretario', 'supervisor', 'collector'].map((base) => (
            <Route key={base} path={`/${base}/*`} element={
              <RequireAuth roles={[base === 'collector' ? 'cobrador' : base] as never}>
                <RoleConversionPending />
              </RequireAuth>
            } />
          ))}

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <Toaster />
      </Boot>
    </BrowserRouter>
  );
}
