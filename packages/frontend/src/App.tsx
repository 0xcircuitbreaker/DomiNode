import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import PrivacyPage from "./pages/PrivacyPage";
import TermsPage from "./pages/TermsPage";
import AUPPage from "./pages/AUPPage";
import AdminLayout from "./admin/AdminLayout";
import { Loading } from "./admin/components/ui";

// Admin pages are lazy so the login bundle stays small.
const OverviewPage = lazy(() => import("./admin/pages/OverviewPage"));
const RevenuePage = lazy(() => import("./admin/pages/RevenuePage"));
const NetworkPage = lazy(() => import("./admin/pages/NetworkPage"));
const NodesPage = lazy(() => import("./admin/pages/NodesPage"));
const AgentsPage = lazy(() => import("./admin/pages/AgentsPage"));
const CreditsPage = lazy(() => import("./admin/pages/CreditsPage"));
const DisputesPage = lazy(() => import("./admin/pages/DisputesPage"));
const AbuseLogPage = lazy(() => import("./admin/pages/AbuseLogPage"));
const PolicyPage = lazy(() => import("./admin/pages/PolicyPage"));
const PricingPage = lazy(() => import("./admin/pages/PricingPage"));
const HealthPage = lazy(() => import("./admin/pages/HealthPage"));
const AuditPage = lazy(() => import("./admin/pages/AuditPage"));
const LaunchPage = lazy(() => import("./admin/pages/LaunchPage"));

const page = (el: React.ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/aup" element={<AUPPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={page(<OverviewPage />)} />
        <Route path="revenue" element={page(<RevenuePage />)} />
        <Route path="network" element={page(<NetworkPage />)} />
        <Route path="nodes" element={page(<NodesPage />)} />
        <Route path="agents" element={page(<AgentsPage />)} />
        <Route path="credits" element={page(<CreditsPage />)} />
        <Route path="disputes" element={page(<DisputesPage />)} />
        <Route path="abuse" element={page(<AbuseLogPage />)} />
        <Route path="policy" element={page(<PolicyPage />)} />
        <Route path="pricing" element={page(<PricingPage />)} />
        <Route path="health" element={page(<HealthPage />)} />
        <Route path="audit" element={page(<AuditPage />)} />
        <Route path="launch" element={page(<LaunchPage />)} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
