import type { HttpClient } from "../http.js";
import { qs } from "../validation.js";

export interface DateRange {
  /** ISO 8601 start (server param `since`). */
  from?: string;
  /** ISO 8601 end (server param `until`). */
  to?: string;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  costCents: number;
  proxyType: string;
  targetHost: string;
  createdAt: string;
}

export interface UsageResponse {
  summary: { totalBytes: number; totalCostCents: number; requestCount: number; totalGB: number; totalCostUsd: number };
  records: UsageRecord[];
  pagination: { limit: number; offset: number; total: number };
  period: { since: string; until: string };
}

export interface DailyUsageResponse {
  days: Array<{ date: string; totalBytes: number; totalGB: number; totalCostCents: number; totalCostUsd: number; requestCount: number }>;
  period: { since: string; until: string };
}

export interface TopHostsResponse {
  hosts: Array<{ targetHost: string; totalBytes: number; totalGB: number; requestCount: number }>;
  period: { since: string; until: string };
}

export class UsageResource {
  constructor(private http: HttpClient) {}

  /** GET /api/usage */
  async get(opts: DateRange & { limit?: number; offset?: number } = {}): Promise<UsageResponse> {
    return this.http.get(`/api/usage${qs({ since: opts.from, until: opts.to, limit: opts.limit, offset: opts.offset })}`);
  }

  /** GET /api/usage/daily */
  async getDaily(opts: DateRange = {}): Promise<DailyUsageResponse> {
    return this.http.get(`/api/usage/daily${qs({ since: opts.from, until: opts.to })}`);
  }

  /** GET /api/usage/top-hosts */
  async getTopHosts(opts: DateRange & { limit?: number } = {}): Promise<TopHostsResponse> {
    return this.http.get(`/api/usage/top-hosts${qs({ since: opts.from, until: opts.to, limit: opts.limit })}`);
  }

  /** GET /api/usage/export — CSV text. */
  async exportCsv(opts: DateRange = {}): Promise<string> {
    return this.http.request<string>({ method: "GET", path: `/api/usage/export${qs({ since: opts.from, until: opts.to })}`, raw: true });
  }
}
