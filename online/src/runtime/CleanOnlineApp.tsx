// Rutas de ADEX Online sobre el frontend de CLEAN.
//
// Las rutas del panel de empresa son LAS MISMAS de `src/app/App.tsx` (CLEAN), con las
// mismas pantallas y el mismo layout. Diferencias:
//   · `/login` es la LoginPage original; si la persona tiene varias membresías, pasa por
//     `/contexto` (DS-05) antes de entrar.
//   · El portal Owner no vive aquí: es otra página y otro servicio (DS-17).
//   · Cobrador y Supervisor: la CAPA OPERATIVA de CLEAN (`operationalRoutes`, mismas
//     pantallas y mismo layout bajo `/collector` y `/supervisor`).
//   · Socio y Secretario: sus layouts y pantallas originales, con las mismas rutas.
//   · Ronda 50: las pantallas de Administración, Socio y Secretario se cargan BAJO DEMANDA
//     (`lazy`): el Cobrador no descarga dashboards ni gráficas (recharts) que no usa. Las
//     del Cobrador y el Supervisor siguen en el paquete inicial (uso de campo, sin esperas).

import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from '@/components/ui/Toast';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { CollectorLayout } from '@/components/layout/CollectorLayout';
import { SupervisorLayout } from '@/components/layout/SupervisorLayout';
import { SocioLayout } from '@/components/layout/SocioLayout';
import { SecretarioLayout } from '@/components/layout/SecretarioLayout';
const SocioDashboardPage = lazy(() => import('@/pages/socio/SocioDashboardPage'));
const SocioClientsPage = lazy(() => import('@/pages/socio/SocioClientsPage'));
const SocioReportsPage = lazy(() => import('@/pages/socio/SocioReportsPage'));
const SocioPartnerCashPage = lazy(() => import('@/pages/socio/SocioPartnerCashPage'));
const SocioAccountPage = lazy(() => import('@/pages/socio/SocioAccountPage'));
const SecretarioClientsPage = lazy(() => import('@/pages/secretario/SecretarioClientsPage'));
const SecretarioAuthorizationsPage = lazy(() => import('@/pages/secretario/SecretarioAuthorizationsPage'));
const SecretarioPaymentCorrectionPage = lazy(() => import('@/pages/secretario/SecretarioPaymentCorrectionPage'));
const SecretarioAccountPage = lazy(() => import('@/pages/secretario/SecretarioAccountPage'));
const PaymentAdjustmentsPage = lazy(() => import('@/pages/admin/PaymentAdjustmentsPage'));
const PartnerCashPage = lazy(() => import('@/pages/admin/PartnerCashPage'));
const ReportsPage = lazy(() => import('@/pages/admin/ReportsPage'));
import CollectorHomePage from '@/pages/collector/CollectorHomePage';
import CollectorRoutePage from '@/pages/collector/CollectorRoutePage';
import PaymentPage from '@/pages/collector/PaymentPage';
import NoPaymentPage from '@/pages/collector/NoPaymentPage';
import CollectorExpensesPage from '@/pages/collector/CollectorExpensesPage';
import CollectorSyncPage from '@/pages/collector/CollectorSyncPage';
import ClientDetailPage from '@/pages/collector/ClientDetailPage';
import CollectorNewClientPage from '@/pages/collector/CollectorNewClientPage';
import CollectorNewSalePage from '@/pages/collector/CollectorNewSalePage';
import CollectorDisbursementsPage from '@/pages/collector/CollectorDisbursementsPage';
import CollectorDailyReportPage from '@/pages/collector/CollectorDailyReportPage';
import CollectorCashClosePage from '@/pages/collector/CollectorCashClosePage';
import CollectorWorkerSettlementsPage from '@/pages/collector/CollectorWorkerSettlementsPage';
import CollectorAuthorizationsPage from '@/pages/collector/CollectorAuthorizationsPage';
import CollectorPaymentHistoryPage from '@/pages/collector/CollectorPaymentHistoryPage';
import CollectorSelectRoutePage from '@/pages/collector/CollectorSelectRoutePage';
import OperationalAccountPage from '@/pages/collector/OperationalAccountPage';
import { RequireAuth } from '@/components/auth/guards';
import { useAuth } from '@/hooks/useAuth';
import LoginPage from '@/pages/auth/LoginPage';
const DashboardPage = lazy(() => import('@/pages/admin/DashboardPage'));
const OfficesPage = lazy(() => import('@/pages/admin/OfficesPage'));
const OfficeDetailPage = lazy(() => import('@/pages/admin/OfficeDetailPage'));
const UnassignedRoutesPage = lazy(() => import('@/pages/admin/UnassignedRoutesPage'));
const RoutesPage = lazy(() => import('@/pages/admin/RoutesPage'));
const ClientsPage = lazy(() => import('@/pages/admin/ClientsPage'));
const ActiveSalesPage = lazy(() => import('@/pages/admin/ActiveSalesPage'));
const ExpensesPage = lazy(() => import('@/pages/admin/ExpensesPage'));
const CapitalPage = lazy(() => import('@/pages/admin/CapitalPage'));
const TransfersPage = lazy(() => import('@/pages/admin/TransfersPage'));
const MovementHistoryPage = lazy(() => import('@/pages/admin/MovementHistoryPage'));
const CashboxPage = lazy(() => import('@/pages/admin/CashboxPage'));
const WeeklySettlementPage = lazy(() => import('@/pages/admin/WeeklySettlementPage'));
const MovementReceiptPage = lazy(() => import('@/pages/admin/MovementReceiptPage'));
const WithdrawalsPage = lazy(() => import('@/pages/admin/WithdrawalsPage'));
const ExpenseCategoriesPage = lazy(() => import('@/pages/admin/ExpenseCategoriesPage'));
const SaleAuthorizationsPage = lazy(() => import('@/pages/admin/SaleAuthorizationsPage'));
const UsersPage = lazy(() => import('@/pages/admin/UsersPage'));
const SettingsPage = lazy(() => import('@/pages/admin/SettingsPage'));
import { boot, useRuntime } from './session.ts';
import { markNavigation } from './projection.ts';
import { ContextSelectPage } from './ContextSelectPage.tsx';
import { ActivatePage } from './ActivatePage.tsx';

/** Mientras llega una pantalla cargada bajo demanda (mismo indicador del arranque, sobre fondo claro). */
function PageLoading() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center" role="status" aria-label="Cargando">
      <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
    </div>
  );
}

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


/** Rutas de la CAPA OPERATIVA: copia literal de `operationalRoutes()` de CLEAN (src/app/App.tsx). */
function operationalRoutes() {
  return (
    <>
      <Route index element={<Navigate to="home" replace />} />
      <Route path="select-route" element={<CollectorSelectRoutePage />} />
      <Route path="home" element={<CollectorHomePage />} />
      <Route path="route" element={<CollectorRoutePage />} />
      <Route path="clients/new" element={<CollectorNewClientPage />} />
      <Route path="new-sale" element={<CollectorNewSalePage />} />
      <Route path="disbursements" element={<CollectorDisbursementsPage />} />
      <Route path="daily-report" element={<CollectorDailyReportPage />} />
      <Route path="cashclose" element={<CollectorCashClosePage />} />
      <Route path="worker-settlements" element={<CollectorWorkerSettlementsPage />} />
      <Route path="authorizations" element={<CollectorAuthorizationsPage />} />
      <Route path="payment-history" element={<CollectorPaymentHistoryPage />} />
      <Route path="payment-history/:saleId" element={<CollectorPaymentHistoryPage />} />
      <Route path="payment/:saleId" element={<PaymentPage />} />
      <Route path="no-payment/:saleId" element={<NoPaymentPage />} />
      <Route path="client/:id" element={<ClientDetailPage />} />
      <Route path="expenses" element={<CollectorExpensesPage />} />
      <Route path="sync" element={<CollectorSyncPage />} />
      <Route path="account" element={<OperationalAccountPage />} />
    </>
  );
}

/** Marca el cambio de pantalla: el refresco periódico relee solo lo que la pantalla actual usa. */
function NavigationMark() {
  const { pathname } = useLocation();
  useEffect(() => { markNavigation(); }, [pathname]);
  return null;
}

export function CleanOnlineApp() {
  return (
    <BrowserRouter>
      <NavigationMark />
      <Boot>
        <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route path="/contexto" element={<ContextSelectPage />} />
          {/* Ronda 40: primer acceso y recuperación (la persona fija su propia contraseña). */}
          <Route path="/activar" element={<ActivatePage />} />
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
            <Route path="payment-adjustments" element={<PaymentAdjustmentsPage />} />
            <Route path="capital" element={<CapitalPage />} />
            {/* En el SaaS el capital centralizado rige desde el alta: no hay transición. */}
            <Route path="capital/transicion" element={<Navigate to="/admin/capital" replace />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="expense-categories" element={<ExpenseCategoriesPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="movements" element={<MovementHistoryPage />} />
            <Route path="partner-cash" element={<PartnerCashPage />} />
            <Route path="withdrawals" element={<WithdrawalsPage />} />
            <Route path="cashbox" element={<CashboxPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="weekly-settlement" element={<WeeklySettlementPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route path="/supervisor" element={
            <RequireAuth roles={['supervisor']}>
              <SupervisorLayout />
            </RequireAuth>
          }>
            {operationalRoutes()}
          </Route>
          <Route path="/collector" element={
            <RequireAuth roles={['cobrador']}>
              <CollectorLayout />
            </RequireAuth>
          }>
            {operationalRoutes()}
          </Route>

          {/* Socio (perfil de consulta / solo lectura): rutas de CLEAN (src/app/App.tsx). */}
          <Route path="/socio" element={
            <RequireAuth roles={['socio']}>
              <SocioLayout />
            </RequireAuth>
          }>
            <Route index element={<Navigate to="/socio/resumen" replace />} />
            <Route path="resumen" element={<SocioDashboardPage />} />
            <Route path="clientes" element={<SocioClientsPage />} />
            <Route path="reportes" element={<SocioReportsPage />} />
            <Route path="caja" element={<SocioPartnerCashPage />} />
            <Route path="cuenta" element={<SocioAccountPage />} />
          </Route>
          {/* Secretario (Clientes, Autorizaciones, Corrección de pagos): rutas de CLEAN. */}
          <Route path="/secretario" element={
            <RequireAuth roles={['secretario']}>
              <SecretarioLayout />
            </RequireAuth>
          }>
            <Route index element={<Navigate to="/secretario/clientes" replace />} />
            <Route path="clientes" element={<SecretarioClientsPage />} />
            <Route path="autorizaciones" element={<SecretarioAuthorizationsPage />} />
            <Route path="correccion-pagos" element={<SecretarioPaymentCorrectionPage />} />
            <Route path="cuenta" element={<SecretarioAccountPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        </Suspense>
        <Toaster />
      </Boot>
    </BrowserRouter>
  );
}
