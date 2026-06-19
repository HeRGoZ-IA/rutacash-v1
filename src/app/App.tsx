import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from '@/components/ui/Toast'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { CollectorLayout } from '@/components/layout/CollectorLayout'
import { useAuth } from '@/hooks/useAuth'
import { seedDatabase, seedCleanDatabase } from '@/data/seed'
import { IS_CLEAN } from '@/lib/appMode'

// Auth
import LoginPage from '@/pages/auth/LoginPage'

// Platform
import PlatformPage from '@/pages/platform/PlatformPage'

// Admin
import DashboardPage from '@/pages/admin/DashboardPage'
import OfficesPage from '@/pages/admin/OfficesPage'
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

// Collector
import CollectorHomePage from '@/pages/collector/CollectorHomePage'
import CollectorRoutePage from '@/pages/collector/CollectorRoutePage'
import PaymentPage from '@/pages/collector/PaymentPage'
import NoPaymentPage from '@/pages/collector/NoPaymentPage'
import CollectorExpensesPage from '@/pages/collector/CollectorExpensesPage'
import CollectorSyncPage from '@/pages/collector/CollectorSyncPage'
import ClientDetailPage from '@/pages/collector/ClientDetailPage'

function RequireAuth({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { isAuthenticated, user } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (roles && user && !roles.includes(user.rol)) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  useEffect(() => {
    const seed = IS_CLEAN ? seedCleanDatabase : seedDatabase
    seed().catch(console.error)
  }, [])

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

        {/* Admin panel */}
        <Route path="/admin" element={
          <RequireAuth roles={['admin', 'supervisor']}>
            <AdminLayout />
          </RequireAuth>
        }>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="offices" element={<OfficesPage />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="active-sales" element={<ActiveSalesPage />} />
          <Route path="capital" element={<CapitalPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="withdrawals" element={<WithdrawalsPage />} />
          <Route path="cashbox" element={<CashboxPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="weekly-settlement" element={<WeeklySettlementPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* Collector mobile */}
        <Route path="/collector" element={
          <RequireAuth roles={['cobrador']}>
            <CollectorLayout />
          </RequireAuth>
        }>
          <Route index element={<Navigate to="/collector/home" replace />} />
          <Route path="home" element={<CollectorHomePage />} />
          <Route path="route" element={<CollectorRoutePage />} />
          <Route path="payment/:saleId" element={<PaymentPage />} />
          <Route path="no-payment/:saleId" element={<NoPaymentPage />} />
          <Route path="client/:id" element={<ClientDetailPage />} />
          <Route path="expenses" element={<CollectorExpensesPage />} />
          <Route path="sync" element={<CollectorSyncPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  )
}
