import type { HttpClient } from "./http.js";
import type { UsageRecord, TopHost } from "./types.js";

export interface DateRangeOptions {
  from?: string;
  to?: string;
}

export interface UsageSummary {
  totalBytes: number;
  totalCostCents: number;
  requestCount: number;
  totalGB: number;
  totalCostUsd: number;
}

export interface UsageResponse {
  summary: UsageSummary;
  records: Array<{
    id: string;
    sessionId: string;
    bytesIn: number;
    bytesOut: number;
    totalBytes: number;
    costCents: number;
    proxyType: string;
    targetHost: string;
    createdAt: string;
  }>;
  pagination: { limit: number; offset: number; total: number };
  period: { since: string; until: string };
}

export interface DailyUsageDay {
  date: string;
  totalBytes: number;
  totalGB: number;
  totalCostCents: number;
  totalCostUsd: number;
  requestCount: number;
}

export interface DailyUsageResponse {
  days: DailyUsageDay[];
  period: { since: string; until: string };
}

export interface TopHostEntry {
  targetHost: string;
  totalBytes: number;
  totalGB: number;
  requestCount: number;
}

export interface TopHostsResponse {
  hosts: TopHostEntry[];
  period: { since: string; until: string };
}

export class UsageResource {
  constructor(private http: HttpClient) {}

  /** Get detailed usage records with summary. */
  async get(opts?: DateRangeOptions & { limit?: number; offset?: number }): Promise<UsageResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("since", opts.from);
    if (opts?.to) params.set("until", opts.to);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.http.get(`/api/usage${qs ? `?${qs}` : ""}`);
  }

  /** Get daily usage aggregation for charts. */
  async getDaily(opts?: DateRangeOptions): Promise<DailyUsageResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("since", opts.from);
    if (opts?.to) params.set("until", opts.to);
    const qs = params.toString();
    return this.http.get(`/api/usage/daily${qs ? `?${qs}` : ""}`);
  }

  /** Get top target hosts by bandwidth. */
  async getTopHosts(opts?: DateRangeOptions & { limit?: number }): Promise<TopHostsResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("since", opts.from);
    if (opts?.to) params.set("until", opts.to);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.http.get(`/api/usage/top-hosts${qs ? `?${qs}` : ""}`);
  }

  /** Export usage records as CSV string. */
  async exportCsv(opts?: DateRangeOptions): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("since", opts.from);
    if (opts?.to) params.set("until", opts.to);
    const qs = params.toString();
    return this.http.get(`/api/usage/export${qs ? `?${qs}` : ""}`);
  }
}
