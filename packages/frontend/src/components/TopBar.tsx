import { useAuth } from "../context/AuthContext";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";
import { Link } from "react-router-dom";
import ThemeToggle from "./ThemeToggle";

interface WalletResponse {
  balanceUsd: number;
}

export default function TopBar() {
  const { user, logout } = useAuth();
  const { data: wallet } = useApi<WalletResponse>(() => get("/api/wallet"));
  const { data: slotsData } = useApi<{ total: number; used: number; remaining: number; unlimited: boolean }>(
    () => get("/api/slots", { redirectOnUnauthorized: false })
  );

  return (
    <header className="app-topbar h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4 sm:px-6">
      <div className="app-topbar-left flex items-center gap-3 sm:gap-4">
        <span className="app-pill">
          <span className="app-pill-dot" />
          Network Live
        </span>
        {import.meta.env.VITE_ALPHA_MODE !== "false" && (
          <span className="app-pill app-pill-alpha">
            <span className="app-pill-dot app-pill-dot-alpha" />
            ALPHA
            {slotsData && !slotsData.unlimited && (
              <span style={{ marginLeft: "0.35rem", fontWeight: 400, opacity: 0.85 }}>
                {slotsData.remaining}/{slotsData.total}
              </span>
            )}
          </span>
        )}
        <div className="app-hide-compact">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Client Dashboard</p>
          <p className="text-sm text-gray-400">Operational telemetry, billing, and access control</p>
        </div>
      </div>

      <div className="app-topbar-right flex items-center gap-2 sm:gap-4 md:gap-6">
        <div className="app-balance text-sm">
          <span className="text-gray-400">Balance: </span>
          <span className="text-green-400 font-semibold">
            ${wallet?.balanceUsd.toFixed(2) ?? "-.--"}
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle className="app-theme-toggle" />
          <Link to="/" className="app-link text-sm app-hide-compact">
            Website
          </Link>
          <span className="app-user-email text-sm text-gray-400">{user?.email}</span>
          <button
            onClick={logout}
            className="app-logout-btn text-sm text-gray-500 hover:text-gray-300 transition-colors bg-gray-800 px-3 py-1.5 rounded-lg min-h-[44px]"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
