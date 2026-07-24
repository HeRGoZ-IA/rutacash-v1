import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from '@/components/ui/Toast'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { CollectorLayout } from '@/components/layout/CollectorLayout'
import { SupervisorLayout } from '@/components/layout/SupervisorLayout'
import { SocioLayout } from '@/components/layout/SocioLayout'
import { SecretarioLayout } from '@/components/layout/SecretarioLayout'
import { RequireAuth } from '@/components/auth/guards'
import { useAuth } from '@/hooks/useAuth'
import { seedDatabase, seedCleanDatabase, ensureExpenseCategories } from '@/data/seed'
import { IS_CLEAN } from '@/lib/appMode'

// Auth
import LoginPage from '@/pages/auth/LoginPage'

// Platform
import PlatformPage from '@/pages/platform/PlatformPage'

// Admin
import DashboardPage from '@/pages/admin/DashboardPage'
import RoutesPage from '@/pages/admin/RoutesPage'
import ClientsPage from '@/pages/admin/ClientsPage'
import ActiveSalesPage from '@/pages/admin/ActiveSalesPage'
import CapitalPage from '@/pages/admin/CapitalPage'
import ExpensesPage from '@/pages/admin/ExpensesPage'
import TransfersPage from '@/pages/admin/TransfersPage'
import WithdrawalsPage from '@/pages/admin/WithdrawalsPage'
import CashboxPage from '@/pages/admin/CashboxPage'
import ReportsPage from '@/pages/admin/ReportsPage'
import WeeklySettlementPage from '@/pages/admin/WeeklySettlementPage'
import UsersPage from '@/pages/admin/UsersPage'
import SettingsPage from '@/pages/admin/SettingsPage'
import SaleAuthorizationsPage from '@/pages/admin/SaleAuthorizationsPage'
import PartnerCashPage from '@/pages/admin/PartnerCashPage'
import ExpenseCategoriesPage from '@/pages/admin/ExpenseCategoriesPage'
import PaymentAdjustmentsPage from '@/pages/admin/PaymentAdjustmentsPage'

// Collector
import CollectorHomePage from '@/pages/collector/CollectorHomePage'
import CollectorRoutePage from '@/pages/collector/CollectorRoutePage'
import PaymentPage from '@/pages/collector/PaymentPage'
import NoPaymentPage from '@/pages/collector/NoPaymentPage'
import CollectorExpensesPage from '@/pages/collector/CollectorExpensesPage'
import CollectorSyncPage from '@/pages/collector/CollectorSyncPage'
import ClientDetailPage from '@/pages/collector/ClientDetailPage'
import CollectorNewClientPage from '@/pages/collector/CollectorNewClientPage'
import CollectorNewSalePage from '@/pages/collector/CollectorNewSalePage'
import CollectorDisbursementsPage from '@/pages/collector/CollectorDisbursementsPage'
import CollectorDailyReportPage from '@/pages/collector/CollectorDailyReportPage'
import CollectorCashClosePage from '@/pages/collector/CollectorCashClosePage'
import CollectorPaymentHistoryPage from '@/pages/collector/CollectorPaymentHistoryPage'
import CollectorSelectRoutePage from '@/pages/collector/CollectorSelectRoutePage'
import OperationalAccountPage from '@/pages/collector/OperationalAccountPage'

// Socio
import SocioDashboardPage from '@/pages/socio/SocioDashboardPage'
import SocioClientsPage from '@/pages/socio/SocioClientsPage'
import SocioReportsPage from '@/pages/socio/SocioReportsPage'
import SocioPartnerCashPage from '@/pages/socio/SocioPartnerCashPage'
import SocioAccountPage from '@/pages/socio/SocioAccountPage'

// Secretario
import SecretarioClientsPage from '@/pages/secretario/SecretarioClientsPage'
import SecretarioAuthorizationsPage from '@/pages/secretario/SecretarioAuthorizationsPage'
import SecretarioPaymentCorrectionPage from '@/pages/secretario/SecretarioPaymentCorrectionPage'
import SecretarioAccountPage from '@/pages/secretario/SecretarioAccountPage'

/**
 * Rutas de la CAPA OPERATIVA (Cobrador y Supervisor). Se montan bajo `/collector`
 * y `/supervisor` con paths RELATIVOS, de modo que las mismas pantallas sirvan a
 * ambos roles (base-path vía `useOpBase`). No duplicar lógica de pantallas.
 */
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
      <Route path="payment-history" element={<CollectorPaymentHistoryPage />} />
      <Route path="payment-history/:saleId" element={<CollectorPaymentHistoryPage />} />
      <Route path="payment/:saleId" element={<PaymentPage />} />
      <Route path="no-payment/:saleId" element={<NoPaymentPage />} />
      <Route path="client/:id" element={<ClientDetailPage />} />
      <Route path="expenses" element={<CollectorExpensesPage />} />
      <Route path="sync" element={<CollectorSyncPage />} />
      <Route path="account" element={<OperationalAccountPage />} />
    </>
  )
}

export default function App() {
  const revalidateSession = useAuth((s) => s.revalidateSession)

  useEffect(() => {
    const seed = IS_CLEAN ? seedCleanDatabase : seedDatabase
    // Tras sembrar, garantizar categorías de gasto base y REVALIDAR la sesión
    // (usuario/empresa/rol/rutas) por si algo cambió mientras no había sesión activa.
    seed()
      .then(() => ensureExpenseCategories())
      .then(() => revalidateSession())
      .catch(console.error)
  }, [revalidateSession])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* Platform / Super Admin */}
        <Route path="/platform" element={
          <RequireAuth roles={['superadmin']}>
            <PlatformPage />
          </RequireAuth>
        } />

        {/* Socio (perfil de consulta / solo lectura) */}
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

        {/* Secretario (Clientes, Autorizaciones, Corrección de pagos) */}
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

        {/* Supervisor — CAPA OPERATIVA COMPARTIDA con el Cobrador (mismas pantallas,
            base-path `/supervisor`). El rol/auditoría siguen siendo Supervisor y los
            servicios validan capacidad + ruta (sin venta directa, sin corrección). */}
        <Route path="/supervisor" element={
          <RequireAuth roles={['supervisor']}>
            <SupervisorLayout />
          </RequireAuth>
        }>
          {operationalRoutes()}
        </Route>

        {/* Admin panel (Administrador y Super Admin operando dentro de una empresa) */}
        <Route path="/admin" element={
          <RequireAuth roles={['admin', 'superadmin']}>
            <AdminLayout />
          </RequireAuth>
        }>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="active-sales" element={<ActiveSalesPage />} />
          <Route path="sale-authorizations" element={<SaleAuthorizationsPage />} />
          <Route path="payment-adjustments" element={<PaymentAdjustmentsPage />} />
          <Route path="capital" element={<CapitalPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="expense-categories" element={<ExpenseCategoriesPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="partner-cash" element={<PartnerCashPage />} />
          <Route path="withdrawals" element={<WithdrawalsPage />} />
          <Route path="cashbox" element={<CashboxPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="weekly-settlement" element={<WeeklySettlementPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* Collector mobile (misma capa operativa, base-path `/collector`) */}
        <Route path="/collector" element={
          <RequireAuth roles={['cobrador']}>
            <CollectorLayout />
          </RequireAuth>
        }>
          {operationalRoutes()}
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  )
}
