import { useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { post } from "../api/client";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

function EmailVerificationBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  // Don't show for wallet users or verified users
  if (!user || user.email_verified || user.wallet_address || dismissed) return null;

  async function handleResend() {
    setResending(true);
    try {
      await post("/api/auth/resend-verification", {});
      setResent(true);
    } catch {
      // Silently fail — user can try again
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="bg-yellow-900/30 border-b border-yellow-800/50 px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 text-yellow-200">
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <span>
          {resent
            ? "Verification email sent! Check your inbox."
            : "Please verify your email address to secure your account."}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {!resent && (
          <button
            onClick={handleResend}
            disabled={resending}
            className="text-yellow-300 hover:text-yellow-100 font-medium text-xs px-2 py-1 rounded hover:bg-yellow-800/30 transition-colors"
          >
            {resending ? "Sending..." : "Resend"}
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="text-yellow-400/60 hover:text-yellow-300 text-xs px-1"
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const { user, loading } = useAuth();
  const { theme } = useTheme();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="premium-app" data-theme={theme}>
      <div className="app-layout-root flex min-h-screen">
        <Sidebar />
        <div className="app-main flex-1 flex flex-col">
          <TopBar />
          <EmailVerificationBanner />
          <main className="flex-1 p-4 sm:p-6 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
