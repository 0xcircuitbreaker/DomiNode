import type { HttpClient } from "./http.js";
import type { AdminUser, RevenueStats, DailyRevenue, SystemStats } from "./types.js";

export interface DateRangeOptions {
  since?: string;
  until?: string;
}

export interface ListUsersResponse {
  users: AdminUser[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface GetUserResponse {
  user: AdminUser;
}

export interface RevenueResponse {
  totalRevenueCents: number;
  totalRevenueUsd: number;
  avgTransactionCents: number;
  avgTransactionUsd: number;
  transactionCount: number;
  topupCount: number;
  period: { since: string; until: string };
}

export interface DailyRevenueEntry {
  date: string;
  revenueCents: number;
  revenueUsd: number;
}

export interface DailyRevenueResponse {
  days: DailyRevenueEntry[];
  period: { since: string; until: string };
}

export class AdminResource {
  constructor(private http: HttpClient) {}

  /** List all users (paginated). Requires admin privileges. */
  async listUsers(opts?: { page?: number; limit?: number }): Promise<ListUsersResponse> {
    const params = new URLSearchParams();
    if (opts?.page !== undefined) params.set("page", String(opts.page));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.http.get(`/api/admin/users${qs ? `?${qs}` : ""}`);
  }

  /** Get detailed info for a specific user. Requires admin privileges. */
  async getUser(id: string): Promise<GetUserResponse> {
    return this.http.get(`/api/admin/users/${encodeURIComponent(id)}`);
  }

  /** Suspend a user account. Requires admin privileges. */
  async suspendUser(id: string): Promise<{ message: string }> {
    return this.http.put(`/api/admin/users/${encodeURIComponent(id)}/suspend`);
  }

  /** Reactivate a suspended user account. Requires admin privileges. */
  async activateUser(id: string): Promise<{ message: string }> {
    return this.http.put(`/api/admin/users/${encodeURIComponent(id)}/activate`);
  }

  /** Soft-delete a user account. Requires admin privileges. */
  async deleteUser(id: string): Promise<{ message: string }> {
    return this.http.delete(`/api/admin/users/${encodeURIComponent(id)}`);
  }

  /** Get revenue statistics for a date range. Requires admin privileges. */
  async getRevenue(opts?: DateRangeOptions): Promise<RevenueResponse> {
    const params = new URLSearchParams();
    if (opts?.since) params.set("since", opts.since);
    if (opts?.until) params.set("until", opts.until);
    const qs = params.toString();
    return this.http.get(`/api/admin/revenue${qs ? `?${qs}` : ""}`);
  }

  /** Get daily revenue breakdown. Requires admin privileges. */
  async getDailyRevenue(opts?: DateRangeOptions): Promise<DailyRevenueResponse> {
    const params = new URLSearchParams();
    if (opts?.since) params.set("since", opts.since);
    if (opts?.until) params.set("until", opts.until);
    const qs = params.toString();
    return this.http.get(`/api/admin/revenue/daily${qs ? `?${qs}` : ""}`);
  }

  /** Get system-wide statistics. Requires admin privileges. */
  async getStats(): Promise<SystemStats> {
    return this.http.get("/api/admin/stats");
  }
}
