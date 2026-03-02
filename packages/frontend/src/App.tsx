import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import MarketingPage from "./pages/MarketingPage";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import DashboardPage from "./pages/DashboardPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import WalletPage from "./pages/WalletPage";
import UsagePage from "./pages/UsagePage";
import PlansPage from "./pages/PlansPage";
import SecurityPage from "./pages/SecurityPage";
import TeamsPage from "./pages/TeamsPage";
import ReferralsPage from "./pages/ReferralsPage";
import InviteAcceptPage from "./pages/InviteAcceptPage";
import PrivacyPage from "./pages/PrivacyPage";
import TermsPage from "./pages/TermsPage";
import AUPPage from "./pages/AUPPage";
import ErrorCodesPage from "./pages/ErrorCodesPage";
import DocsPage from "./pages/DocsPage";
import { useAuth } from "./context/AuthContext";

// Lazy-load admin page so admin-only code isn't shipped to regular users
const AdminPage = lazy(() => import("./pages/AdminPage"));

function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<MarketingPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/aup" element={<AUPPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/docs/error-codes" element={<ErrorCodesPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/dashboard" element={<Navigate to="/app" replace />} />
      <Route path="/keys" element={<Navigate to="/app/keys" replace />} />
      <Route path="/wallet" element={<Navigate to="/app/wallet" replace />} />
      <Route path="/usage" element={<Navigate to="/app/usage" replace />} />
      <Route path="/plans" element={<Navigate to="/app/plans" replace />} />
      <Route path="/security" element={<Navigate to="/app/security" replace />} />
      <Route path="/admin" element={<Navigate to="/app/admin" replace />} />
      <Route path="/app" element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="keys" element={<ApiKeysPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="referrals" element={<ReferralsPage />} />
        <Route path="admin" element={
          <AdminGuard>
            <Suspense fallback={<div className="p-8 text-center text-gray-400">Loading...</div>}>
              <AdminPage />
            </Suspense>
          </AdminGuard>
        } />
      </Route>
      <Route path="/teams/invite" element={<InviteAcceptPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
