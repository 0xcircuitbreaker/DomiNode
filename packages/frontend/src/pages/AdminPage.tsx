import { useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { useApi } from "../hooks/useApi";
import { get, put, del } from "../api/client";

// ─── Types ──────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  status: string;
  planId: string;
  balanceCents: number;
  createdAt: string;
  isAdmin: boolean;
}

interface UsersResponse {
  users: AdminUser[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface AdminUserDetail extends AdminUser {
  apiKeyCount: number;
  totalUsageBytes: number;
  totalSpentCents: number;
  lastActive: string | null;
}

interface UserDetailResponse {
  user: AdminUserDetail;
}

interface RevenueResponse {
  totalRevenueCents: number;
  totalRevenueUsd: number;
  totalTransactions: number;
  avgTransactionCents: number;
  avgTransactionUsd: number;
  topUpCount: number;
  uniquePayingUsers: number;
  period: { since: string; until: string };
}

interface DailyRevenueDay {
  date: string;
  revenueCents: number;
  revenueUsd: number;
  transactionCount: number;
}

interface DailyRevenueResponse {
  days: DailyRevenueDay[];
  period: { since: string; until: string };
}

interface SystemStatsResponse {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  totalApiKeys: number;
  activeApiKeys: number;
  totalSessions: number;
  activeSessions: number;
}

type Tab = "users" | "revenue" | "system";

// ─── Helpers ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(3)} GB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-500/10 text-green-400 border-green-500/20",
    suspended: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    deleted: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[status] ?? "bg-gray-500/10 text-gray-400 border-gray-500/20"}`}>
      {status}
    </span>
  );
}

// ─── Revenue Chart ──────────────────────────────────────────────────

function RevenueChart({ days }: { days: DailyRevenueDay[] }) {
  if (days.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        No revenue data for this period.
      </div>
    );
  }

  const values = days.map((d) => d.revenueUsd);
  const maxValue = Math.max(...values, 0.01);

  return (
    <div>
      <p className="text-sm text-gray-400 mb-3">Daily Revenue ($)</p>
      <div className="flex items-end gap-px h-32">
        {days.map((day) => {
          const height = (day.revenueUsd / maxValue) * 100;
          return (
            <div
              key={day.date}
              className="flex-1 group relative"
              style={{ minWidth: "4px" }}
            >
              <div
                className="bg-green-500 hover:bg-green-400 rounded-t transition-colors w-full"
                style={{ height: `${Math.max(height, 1)}%` }}
              />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                <div className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs whitespace-nowrap">
                  <p className="text-gray-300">{formatDate(day.date)}</p>
                  <p className="text-green-400 font-medium">${day.revenueUsd.toFixed(2)}</p>
                  <p className="text-gray-500">{day.transactionCount} txns</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1 text-xs text-gray-500">
        <span>{days.length > 0 ? formatDate(days[0].date) : ""}</span>
        {days.length > 2 && (
          <span>{formatDate(days[Math.floor(days.length / 2)].date)}</span>
        )}
        <span>{days.length > 1 ? formatDate(days[days.length - 1].date) : ""}</span>
      </div>
      <div className="text-right text-xs text-gray-500 -mt-1">
        max: ${maxValue.toFixed(2)}
      </div>
    </div>
  );
}

// ─── Users Tab ──────────────────────────────────────────────────────

function UsersTab() {
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const pageSize = 20;

  const { data, loading, refetch } = useApi<UsersResponse>(
    () => get(`/api/admin/users?page=${page}&limit=${pageSize}`),
    [page],
  );

  const { data: detailData } = useApi<UserDetailResponse | null>(
    () => selectedUserId ? get(`/api/admin/users/${selectedUserId}`) : Promise.resolve(null),
    [selectedUserId],
  );

  const [actionError, setActionError] = useState<string | null>(null);

  const handleSuspend = useCallback(async (userId: string) => {
    if (!window.confirm("Suspend this user? They will lose proxy access.")) return;
    setActionError(null);
    try {
      await put(`/api/admin/users/${userId}/suspend`, {});
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to suspend user");
    }
  }, [refetch]);

  const handleActivate = useCallback(async (userId: string) => {
    setActionError(null);
    try {
      await put(`/api/admin/users/${userId}/activate`, {});
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to activate user");
    }
  }, [refetch]);

  const handleDelete = useCallback(async (userId: string) => {
    if (!window.confirm("Are you sure you want to delete this user? This is a soft-delete.")) return;
    setActionError(null);
    try {
      await del(`/api/admin/users/${userId}`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete user");
    }
  }, [refetch]);

  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <div className="space-y-4">
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-300 ml-3">Dismiss</button>
        </div>
      )}
      {/* User Detail Modal */}
      {selectedUserId && detailData?.user && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">User Details</h3>
            <button
              onClick={() => setSelectedUserId(null)}
              className="text-gray-400 hover:text-gray-200 text-sm"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500">Email</p>
              <p className="text-sm font-medium">{detailData.user.email}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Status</p>
              <StatusBadge status={detailData.user.status} />
            </div>
            <div>
              <p className="text-xs text-gray-500">Plan</p>
              <p className="text-sm">{detailData.user.planId}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Balance</p>
              <p className="text-sm">${(detailData.user.balanceCents / 100).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">API Keys (active)</p>
              <p className="text-sm">{detailData.user.apiKeyCount}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Usage</p>
              <p className="text-sm">{formatBytes(detailData.user.totalUsageBytes)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Spent</p>
              <p className="text-sm">${(detailData.user.totalSpentCents / 100).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Last Active</p>
              <p className="text-sm">
                {detailData.user.lastActive
                  ? new Date(detailData.user.lastActive).toLocaleDateString()
                  : "Never"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Plan</th>
                <th className="text-left px-4 py-3 font-medium">Balance</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="text-left px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : !data?.users.length ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    No users found.
                  </td>
                </tr>
              ) : (
                data.users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-800/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span>{u.email}</span>
                        {u.isAdmin && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            admin
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-400">{u.planId}</td>
                    <td className="px-4 py-3 text-gray-400">
                      ${(u.balanceCents / 100).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => setSelectedUserId(u.id)}
                          className="text-xs text-indigo-400 hover:text-indigo-300"
                        >
                          Details
                        </button>
                        {u.status === "active" ? (
                          <button
                            onClick={() => handleSuspend(u.id)}
                            className="text-xs text-yellow-400 hover:text-yellow-300"
                          >
                            Suspend
                          </button>
                        ) : u.status === "suspended" ? (
                          <button
                            onClick={() => handleActivate(u.id)}
                            className="text-xs text-green-400 hover:text-green-300"
                          >
                            Activate
                          </button>
                        ) : null}
                        {u.status !== "deleted" && (
                          <button
                            onClick={() => handleDelete(u.id)}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              Page {page} of {totalPages} ({data?.pagination.total} users)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1 rounded text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Revenue Tab ────────────────────────────────────────────────────

function RevenueTab() {
  const [since] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [until] = useState(() => new Date().toISOString().split("T")[0]);

  const { data: revenue } = useApi<RevenueResponse>(
    () => get(`/api/admin/revenue?since=${since}T00:00:00Z&until=${until}T23:59:59Z`),
    [since, until],
  );

  const { data: daily } = useApi<DailyRevenueResponse>(
    () => get(`/api/admin/revenue/daily?since=${since}T00:00:00Z&until=${until}T23:59:59Z`),
    [since, until],
  );

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Total Revenue</p>
          <p className="text-3xl font-bold text-green-400 mt-1">
            ${revenue?.totalRevenueUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">Last 30 days</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Transactions</p>
          <p className="text-3xl font-bold mt-1">
            {revenue?.totalTransactions ?? 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">Top-ups processed</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Avg Transaction</p>
          <p className="text-3xl font-bold mt-1">
            ${revenue?.avgTransactionUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">Per top-up</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Unique Payers</p>
          <p className="text-3xl font-bold text-indigo-400 mt-1">
            {revenue?.uniquePayingUsers ?? 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">Paying users</p>
        </div>
      </div>

      {/* Revenue Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold mb-4">Daily Revenue (Last 30 Days)</h2>
        <RevenueChart days={daily?.days ?? []} />
      </div>
    </div>
  );
}

// ─── System Tab ─────────────────────────────────────────────────────

function SystemTab() {
  const { data: stats } = useApi<SystemStatsResponse>(
    () => get("/api/admin/stats"),
  );

  const cards = [
    { label: "Total Users", value: stats?.totalUsers ?? 0, color: "text-indigo-400" },
    { label: "Active Users", value: stats?.activeUsers ?? 0, color: "text-green-400" },
    { label: "Suspended Users", value: stats?.suspendedUsers ?? 0, color: "text-yellow-400" },
    { label: "Total API Keys", value: stats?.totalApiKeys ?? 0, color: "text-gray-100" },
    { label: "Active API Keys", value: stats?.activeApiKeys ?? 0, color: "text-green-400" },
    { label: "Total Sessions", value: stats?.totalSessions ?? 0, color: "text-gray-100" },
    { label: "Active Sessions", value: stats?.activeSessions ?? 0, color: "text-green-400" },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">{card.label}</p>
          <p className={`text-3xl font-bold mt-1 ${card.color}`}>
            {card.value.toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Main Admin Page ────────────────────────────────────────────────

export default function AdminPage() {
  const { isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("users");

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-red-400 text-lg font-semibold">Access Denied</p>
          <p className="text-gray-400 text-sm mt-2">You do not have admin privileges.</p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "users", label: "Users" },
    { key: "revenue", label: "Revenue" },
    { key: "system", label: "System" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <span className="px-2 py-1 rounded text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
          Admin
        </span>
      </div>

      {/* Tab Navigation */}
      <div className="max-w-full overflow-x-auto">
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit min-w-max">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-indigo-600 text-white"
                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "revenue" && <RevenueTab />}
      {activeTab === "system" && <SystemTab />}
    </div>
  );
}
