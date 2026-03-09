import { useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { useApi } from "../hooks/useApi";
import { get, post, put, del } from "../api/client";
import ResponsiveTable from "../components/ResponsiveTable";

// ─── Types ──────────────────────────────────────────────────────────

type AdminRole = "none" | "admin" | "cybersecurity_admin" | "root_admin";

interface AdminUser {
  id: string;
  email: string;
  status: string;
  planId: string;
  balanceCents: number;
  createdAt: string;
  isAdmin: boolean;
  adminRole: AdminRole;
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

type Tab = "users" | "revenue" | "system" | "waitlist" | "bounties" | "credits" | "roles";

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

  // Validate user ID format before using in URL paths
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const { data: detailData } = useApi<UserDetailResponse | null>(
    // Validate UUID before detail fetch to prevent path injection
    () => selectedUserId && UUID_RE.test(selectedUserId) ? get(`/api/admin/users/${selectedUserId}`) : Promise.resolve(null),
    [selectedUserId],
  );

  const [actionError, setActionError] = useState<string | null>(null);

  const validateUuid = (id: string): string => {
    if (!UUID_RE.test(id)) throw new Error("Invalid user ID format");
    return id;
  };

  const handleSuspend = useCallback(async (userId: string) => {
    if (!window.confirm("Suspend this user? They will lose proxy access.")) return;
    setActionError(null);
    try {
      await put(`/api/admin/users/${validateUuid(userId)}/suspend`, {});
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to suspend user");
    }
  }, [refetch]);

  const handleActivate = useCallback(async (userId: string) => {
    setActionError(null);
    try {
      await put(`/api/admin/users/${validateUuid(userId)}/activate`, {});
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to activate user");
    }
  }, [refetch]);

  const handleDelete = useCallback(async (userId: string) => {
    if (!window.confirm("Are you sure you want to delete this user? This is a soft-delete.")) return;
    setActionError(null);
    try {
      await del(`/api/admin/users/${validateUuid(userId)}`);
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
        {loading ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</p>
        ) : (
          <ResponsiveTable<AdminUser>
            columns={[
              { key: "email", header: "Email", primary: true, render: (u) => (
                <div className="flex items-center gap-2">
                  <span className="truncate">{u.email}</span>
                  {u.adminRole === "root_admin" && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/10 text-red-400 border border-red-500/20 flex-shrink-0">
                      root
                    </span>
                  )}
                  {u.adminRole === "cybersecurity_admin" && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 flex-shrink-0">
                      cybersec
                    </span>
                  )}
                  {u.adminRole === "admin" && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex-shrink-0">
                      admin
                    </span>
                  )}
                </div>
              )},
              { key: "status", header: "Status", render: (u) => <StatusBadge status={u.status} /> },
              { key: "plan", header: "Plan", render: (u) => <span className="text-gray-400">{u.planId}</span> },
              { key: "balance", header: "Balance", render: (u) => <span className="text-gray-400">${(u.balanceCents / 100).toFixed(2)}</span> },
              { key: "created", header: "Created", hideOnMobile: true, render: (u) => <span className="text-gray-400">{new Date(u.createdAt).toLocaleDateString()}</span> },
              { key: "actions", header: "Actions", align: "right", render: (u) => (
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
              )},
            ]}
            data={data?.users ?? []}
            keyExtractor={(u) => u.id}
            emptyMessage="No users found."
          />
        )}

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
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
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

// Validate date format before URL interpolation
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function RevenueTab() {
  const [since] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [until] = useState(() => new Date().toISOString().split("T")[0]);

  const safeSince = DATE_RE.test(since) ? since : new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const safeUntil = DATE_RE.test(until) ? until : new Date().toISOString().split("T")[0];

  const revenueParams = new URLSearchParams({ since: `${safeSince}T00:00:00Z`, until: `${safeUntil}T23:59:59Z` });
  const dailyParams = new URLSearchParams({ since: `${safeSince}T00:00:00Z`, until: `${safeUntil}T23:59:59Z` });

  const { data: revenue } = useApi<RevenueResponse>(
    () => get(`/api/admin/revenue?${revenueParams.toString()}`),
    [safeSince, safeUntil],
  );

  const { data: daily } = useApi<DailyRevenueResponse>(
    () => get(`/api/admin/revenue/daily?${dailyParams.toString()}`),
    [safeSince, safeUntil],
  );

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Total Revenue</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-green-400 mt-1">
            ${revenue?.totalRevenueUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">Last 30 days</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Transactions</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            {revenue?.totalTransactions ?? 0}
          </p>
          <p className="text-xs text-gray-500 mt-1">Top-ups processed</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Avg Transaction</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            ${revenue?.avgTransactionUsd.toFixed(2) ?? "0.00"}
          </p>
          <p className="text-xs text-gray-500 mt-1">Per top-up</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Unique Payers</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-indigo-400 mt-1">
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">{card.label}</p>
          <p className={`text-xl sm:text-2xl lg:text-3xl font-bold mt-1 ${card.color}`}>
            {card.value.toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Waitlist Tab ────────────────────────────────────────────────────

interface WaitlistEntryItem {
  id: string;
  email: string;
  status: string;
  notified_at: string | null;
  created_at: string;
}

interface WaitlistResponse {
  entries: WaitlistEntryItem[];
  pendingCount: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function WaitlistStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    notified: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    registered: "bg-green-500/10 text-green-400 border-green-500/20",
    cancelled: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[status] ?? "bg-gray-500/10 text-gray-400 border-gray-500/20"}`}>
      {status}
    </span>
  );
}

function WaitlistTab() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [bulkCount, setBulkCount] = useState("10");
  const [actionError, setActionError] = useState<string | null>(null);
  const pageSize = 20;

  const filterParam = statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : "";
  const { data, loading, refetch } = useApi<WaitlistResponse>(
    () => get(`/api/admin/waitlist?page=${page}&limit=${pageSize}${filterParam}`),
    [page, statusFilter],
  );

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const handleApprove = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    setActionError(null);
    try {
      await post(`/api/admin/waitlist/${id}/approve`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    }
  }, [refetch]);

  const handleCancel = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    if (!window.confirm("Cancel this waitlist entry?")) return;
    setActionError(null);
    try {
      await del(`/api/admin/waitlist/${id}`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }, [refetch]);

  const handleBulkApprove = useCallback(async () => {
    const count = parseInt(bulkCount, 10);
    if (isNaN(count) || count < 1) return;
    if (!window.confirm(`Approve and notify the ${count} oldest pending entries?`)) return;
    setActionError(null);
    try {
      await post("/api/admin/waitlist/bulk-approve", { count });
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to bulk approve");
    }
  }, [bulkCount, refetch]);

  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <div className="space-y-4">
      {/* Summary + Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          Pending: <span className="text-yellow-400 font-semibold">{data?.pendingCount ?? 0}</span>
          {" | "}Total: <span className="font-semibold">{data?.pagination.total ?? 0}</span>
        </p>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-1.5 border border-gray-700"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="notified">Notified</option>
            <option value="registered">Registered</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input
            type="number"
            value={bulkCount}
            onChange={(e) => setBulkCount(e.target.value)}
            min={1}
            max={100}
            className="bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-1.5 border border-gray-700 w-20"
          />
          <button
            onClick={handleBulkApprove}
            className="px-3 py-1.5 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500"
          >
            Bulk Approve
          </button>
        </div>
      </div>

      {actionError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-300 ml-3">Dismiss</button>
        </div>
      )}

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</p>
        ) : (
          <ResponsiveTable<WaitlistEntryItem>
            columns={[
              { key: "email", header: "Email", primary: true, render: (e) => <span className="truncate">{e.email}</span> },
              { key: "status", header: "Status", render: (e) => <WaitlistStatusBadge status={e.status} /> },
              { key: "created", header: "Joined", render: (e) => <span className="text-gray-400">{new Date(e.created_at).toLocaleDateString()}</span> },
              { key: "notified", header: "Notified", hideOnMobile: true, render: (e) => (
                <span className="text-gray-400">
                  {e.notified_at ? new Date(e.notified_at).toLocaleDateString() : "—"}
                </span>
              )},
              { key: "actions", header: "Actions", align: "right", render: (e) => (
                <div className="flex gap-2">
                  {e.status === "pending" && (
                    <button onClick={() => handleApprove(e.id)} className="text-xs text-green-400 hover:text-green-300">
                      Approve
                    </button>
                  )}
                  {(e.status === "pending" || e.status === "notified") && (
                    <button onClick={() => handleCancel(e.id)} className="text-xs text-red-400 hover:text-red-300">
                      Cancel
                    </button>
                  )}
                </div>
              )},
            ]}
            data={data?.entries ?? []}
            keyExtractor={(e) => e.id}
            emptyMessage="No waitlist entries."
          />
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
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

// ─── Bug Bounty Tab (cybersecurity_admin+) ─────────────────────────

interface BugReport {
  id: string;
  user_id: string;
  category: string;
  priority: string;
  title: string;
  integration: string | null;
  status: string;
  credit_amount_cents: number;
  created_at: string;
  reviewed_at: string | null;
}

interface BugReportsResponse {
  reports: BugReport[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

function BugBountyStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    approved: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    credited: "bg-green-500/10 text-green-400 border-green-500/20",
    rejected: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[status] ?? "bg-gray-500/10 text-gray-400 border-gray-500/20"}`}>
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    p1: "bg-red-500/10 text-red-400 border-red-500/20",
    p2: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    p3: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${colors[priority] ?? "bg-gray-500/10 text-gray-400 border-gray-500/20"}`}>
      {priority.toUpperCase()}
    </span>
  );
}

function BountyTab() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState<Record<string, string>>({});
  const pageSize = 20;

  const filterParam = statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : "";
  const { data, loading, refetch } = useApi<BugReportsResponse>(
    () => get(`/api/admin/bug-reports?page=${page}&limit=${pageSize}${filterParam}`),
    [page, statusFilter],
  );

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const handleApprove = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    const cents = parseInt(creditAmount[id] ?? "0", 10);
    if (cents > 0 && !window.confirm(`Award $${(cents / 100).toFixed(2)} credit for this bug report?`)) return;
    setActionError(null);
    try {
      await post(`/api/admin/bug-reports/${id}/approve`, { creditAmountCents: cents > 0 ? cents : undefined });
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    }
  }, [creditAmount, refetch]);

  const handleReject = useCallback(async (id: string) => {
    if (!UUID_RE.test(id)) return;
    if (!window.confirm("Reject this bug report?")) return;
    setActionError(null);
    try {
      await post(`/api/admin/bug-reports/${id}/reject`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    }
  }, [refetch]);

  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          Total Reports: <span className="font-semibold">{data?.pagination.total ?? 0}</span>
        </p>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-1.5 border border-gray-700"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="credited">Credited</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {actionError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-300 ml-3">Dismiss</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</p>
        ) : (
          <ResponsiveTable<BugReport>
            columns={[
              { key: "title", header: "Title", primary: true, render: (r) => (
                <div className="max-w-xs">
                  <p className="truncate font-medium text-sm">{r.title}</p>
                  <p className="text-xs text-gray-500">{r.category} {r.integration ? `| ${r.integration}` : ""}</p>
                </div>
              )},
              { key: "priority", header: "Priority", render: (r) => <PriorityBadge priority={r.priority} /> },
              { key: "status", header: "Status", render: (r) => <BugBountyStatusBadge status={r.status} /> },
              { key: "credit", header: "Credit", render: (r) => r.credit_amount_cents > 0 ? (
                <span className="text-green-400 text-sm">${(r.credit_amount_cents / 100).toFixed(2)}</span>
              ) : <span className="text-gray-500 text-sm">-</span> },
              { key: "date", header: "Date", hideOnMobile: true, render: (r) => (
                <span className="text-gray-400 text-sm">{new Date(r.created_at).toLocaleDateString()}</span>
              )},
              { key: "actions", header: "Actions", align: "right", render: (r) => r.status === "pending" ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    placeholder="cents"
                    min={0}
                    max={50000}
                    value={creditAmount[r.id] ?? ""}
                    onChange={(e) => setCreditAmount((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    className="bg-gray-800 text-gray-300 text-xs rounded px-2 py-1 border border-gray-700 w-20"
                  />
                  <button onClick={() => handleApprove(r.id)} className="text-xs text-green-400 hover:text-green-300">Approve</button>
                  <button onClick={() => handleReject(r.id)} className="text-xs text-red-400 hover:text-red-300">Reject</button>
                </div>
              ) : null },
            ]}
            data={data?.reports ?? []}
            keyExtractor={(r) => r.id}
            emptyMessage="No bug reports."
          />
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50">Previous</button>
              <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Credits Tab (cybersecurity_admin+) ─────────────────────────────

function CreditsTab() {
  const [targetUserId, setTargetUserId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [amountCents, setAmountCents] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const handleCredit = useCallback(async () => {
    setError(null);
    setSuccess(null);

    const hasUser = targetUserId.trim().length > 0;
    const hasTeam = teamId.trim().length > 0;
    if (!hasUser && !hasTeam) { setError("Specify a user ID or team ID"); return; }
    if (hasUser && hasTeam) { setError("Specify either user or team, not both"); return; }
    if (hasUser && !UUID_RE.test(targetUserId.trim())) { setError("Invalid user ID format"); return; }
    if (hasTeam && !UUID_RE.test(teamId.trim())) { setError("Invalid team ID format"); return; }

    const cents = parseInt(amountCents, 10);
    if (!Number.isFinite(cents) || cents <= 0) { setError("Amount must be a positive number"); return; }
    if (cents > 50000) { setError("Maximum $500.00 per operation"); return; }

    if (!window.confirm(`Credit $${(cents / 100).toFixed(2)} to ${hasUser ? "user" : "team"}?`)) return;

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { amountCents: cents, reason: reason.trim() || "Admin credit" };
      if (hasUser) body.targetUserId = targetUserId.trim();
      if (hasTeam) body.teamId = teamId.trim();
      await post("/api/admin/credit-wallet", body);
      setSuccess(`Credited $${(cents / 100).toFixed(2)} successfully`);
      setAmountCents("");
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to credit wallet");
    } finally {
      setSubmitting(false);
    }
  }, [targetUserId, teamId, amountCents, reason]);

  return (
    <div className="max-w-lg space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h2 className="font-semibold text-lg">Grant Account Credits</h2>
        <p className="text-sm text-gray-400">Credit a user or team wallet. Maximum $500 per operation.</p>

        <div>
          <label className="block text-xs text-gray-500 mb-1">User ID (leave empty for team credit)</label>
          <input type="text" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}
            placeholder="UUID" className="w-full bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Team ID (leave empty for user credit)</label>
          <input type="text" value={teamId} onChange={(e) => setTeamId(e.target.value)}
            placeholder="UUID" className="w-full bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Amount (cents)</label>
          <input type="number" value={amountCents} onChange={(e) => setAmountCents(e.target.value)}
            min={1} max={50000} placeholder="e.g. 500 = $5.00"
            className="w-full bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Reason</label>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Bug bounty, promo, etc." maxLength={200}
            className="w-full bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700" />
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">{error}</div>
        )}
        {success && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3 text-sm text-green-400">{success}</div>
        )}

        <button onClick={handleCredit} disabled={submitting}
          className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50">
          {submitting ? "Processing..." : "Grant Credit"}
        </button>
      </div>
    </div>
  );
}

// ─── Role Management Tab (root_admin only) ──────────────────────────

interface AdminRoleEntry {
  id: string;
  email: string;
  adminRole: string;
  status: string;
  createdAt: string;
}

interface RolesResponse {
  admins: AdminRoleEntry[];
}

function RolesTab() {
  const { data, loading, refetch } = useApi<RolesResponse>(
    () => get("/api/admin/roles"),
  );
  const [assignUserId, setAssignUserId] = useState("");
  const [assignRole, setAssignRole] = useState<string>("admin");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const handleSetRole = useCallback(async (userId: string, role: string) => {
    if (!UUID_RE.test(userId)) { setActionError("Invalid user ID format"); return; }
    const roleLabel = role === "none" ? "remove admin access from" : `set ${role} role for`;
    if (!window.confirm(`${roleLabel} this user?`)) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await put(`/api/admin/roles/${userId}`, { role });
      setActionSuccess(`Role updated to ${role}`);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update role");
    }
  }, [refetch]);

  const handleAssignNew = useCallback(async () => {
    if (!assignUserId.trim()) { setActionError("Enter a user ID"); return; }
    await handleSetRole(assignUserId.trim(), assignRole);
    if (assignUserId.trim()) setAssignUserId("");
  }, [assignUserId, assignRole, handleSetRole]);

  const roleLabel = (role: string) => {
    switch (role) {
      case "root_admin": return "Root Admin";
      case "cybersecurity_admin": return "Cybersecurity Admin";
      case "admin": return "Admin";
      default: return role;
    }
  };

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case "root_admin": return "bg-red-500/10 text-red-400 border-red-500/20";
      case "cybersecurity_admin": return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      case "admin": return "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
      default: return "bg-gray-500/10 text-gray-400 border-gray-500/20";
    }
  };

  return (
    <div className="space-y-6">
      {/* Assign New Admin */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
        <h2 className="font-semibold text-lg">Assign Admin Role</h2>
        <p className="text-sm text-gray-400">Only the root admin can grant or revoke admin roles. Root admin role cannot be assigned via the UI.</p>

        <div className="flex flex-wrap gap-3">
          <input type="text" value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)}
            placeholder="User ID (UUID)" className="flex-1 min-w-[200px] bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700" />
          <select value={assignRole} onChange={(e) => setAssignRole(e.target.value)}
            className="bg-gray-800 text-gray-300 text-sm rounded-lg px-3 py-2 border border-gray-700">
            <option value="admin">Admin</option>
            <option value="cybersecurity_admin">Cybersecurity Admin</option>
            <option value="none">Remove Admin</option>
          </select>
          <button onClick={handleAssignNew}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500">
            Assign
          </button>
        </div>

        {actionError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">{actionError}</div>
        )}
        {actionSuccess && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3 text-sm text-green-400">{actionSuccess}</div>
        )}
      </div>

      {/* Current Admins */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="font-semibold">Current Admins</h3>
        </div>
        {loading ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</p>
        ) : (
          <ResponsiveTable<AdminRoleEntry>
            columns={[
              { key: "email", header: "Email", primary: true, render: (a) => <span className="truncate">{a.email}</span> },
              { key: "role", header: "Role", render: (a) => (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${roleBadgeColor(a.adminRole)}`}>
                  {roleLabel(a.adminRole)}
                </span>
              )},
              { key: "status", header: "Status", render: (a) => <StatusBadge status={a.status} /> },
              { key: "actions", header: "Actions", align: "right", render: (a) => a.adminRole !== "root_admin" ? (
                <div className="flex gap-2">
                  {a.adminRole !== "cybersecurity_admin" && (
                    <button onClick={() => handleSetRole(a.id, "cybersecurity_admin")}
                      className="text-xs text-amber-400 hover:text-amber-300">Promote Cybersec</button>
                  )}
                  {a.adminRole !== "admin" && (
                    <button onClick={() => handleSetRole(a.id, "admin")}
                      className="text-xs text-indigo-400 hover:text-indigo-300">Set Admin</button>
                  )}
                  <button onClick={() => handleSetRole(a.id, "none")}
                    className="text-xs text-red-400 hover:text-red-300">Revoke</button>
                </div>
              ) : (
                <span className="text-xs text-gray-500">Protected</span>
              )},
            ]}
            data={data?.admins ?? []}
            keyExtractor={(a) => a.id}
            emptyMessage="No admins configured."
          />
        )}
      </div>
    </div>
  );
}

// ─── Main Admin Page ────────────────────────────────────────────────

export default function AdminPage() {
  const { isAdmin, adminRole } = useAuth();
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

  const isCybersec = adminRole === "cybersecurity_admin" || adminRole === "root_admin";
  const isRoot = adminRole === "root_admin";

  // Build tabs based on role
  const tabs: { key: Tab; label: string }[] = [
    { key: "users", label: "Users" },
    { key: "waitlist", label: "Waitlist" },
    { key: "revenue", label: "Revenue" },
    { key: "system", label: "System" },
  ];
  if (isCybersec) {
    tabs.push({ key: "bounties", label: "Bug Bounties" });
    tabs.push({ key: "credits", label: "Credits" });
  }
  if (isRoot) {
    tabs.push({ key: "roles", label: "Roles" });
  }

  // Reset tab if no longer visible for current role
  const validTabKeys = tabs.map((t) => t.key);
  if (!validTabKeys.includes(activeTab)) {
    setActiveTab("users");
  }

  const roleLabel = adminRole === "root_admin" ? "Root Admin"
    : adminRole === "cybersecurity_admin" ? "Cybersecurity Admin"
    : "Admin";
  const roleBadgeColor = adminRole === "root_admin" ? "bg-red-500/10 text-red-400 border border-red-500/20"
    : adminRole === "cybersecurity_admin" ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
    : "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <span className={`px-2 py-1 rounded text-xs ${roleBadgeColor}`}>
          {roleLabel}
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
      {activeTab === "waitlist" && <WaitlistTab />}
      {activeTab === "revenue" && <RevenueTab />}
      {activeTab === "system" && <SystemTab />}
      {activeTab === "bounties" && isCybersec && <BountyTab />}
      {activeTab === "credits" && isCybersec && <CreditsTab />}
      {activeTab === "roles" && isRoot && <RolesTab />}
    </div>
  );
}
