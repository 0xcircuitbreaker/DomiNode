import { useAuth } from "../context/AuthContext";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";

interface WalletResponse {
  balanceUsd: number;
}

export default function TopBar() {
  const { user, logout } = useAuth();
  const { data: wallet } = useApi<WalletResponse>(() => get("/api/wallet"));

  return (
    <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6">
      <div />

      <div className="flex items-center gap-6">
        <div className="text-sm">
          <span className="text-gray-400">Balance: </span>
          <span className="text-green-400 font-semibold">
            ${wallet?.balanceUsd.toFixed(2) ?? "-.--"}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{user?.email}</span>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
