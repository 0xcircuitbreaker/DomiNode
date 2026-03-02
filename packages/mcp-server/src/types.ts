export interface WalletBalance {
  balanceCents: number;
  balanceUsd: number;
  currency: string;
  lastToppedUp: string | null;
}

export interface WalletForecast {
  dailyAvgCents: number;
  daysRemaining: number | null;
  trend: "up" | "down" | "stable";
  trendPct: number;
}

export interface Transaction {
  id: string;
  type: string;
  amountCents: number;
  amountUsd: number;
  description: string;
  paymentProvider: string | null;
  createdAt: string;
}

export interface TransactionList {
  transactions: Transaction[];
}

export interface UsageSummary {
  totalBytes: number;
  totalCostCents: number;
  requestCount: number;
  totalGB: number;
  totalCostUsd: number;
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

export interface DailyUsage {
  date: string;
  totalBytes: number;
  totalGB: number;
  totalCostCents: number;
  totalCostUsd: number;
  requestCount: number;
}

export interface TopHost {
  targetHost: string;
  totalBytes: number;
  totalGB: number;
  requestCount: number;
}

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyCreated {
  id: string;
  key: string;
  prefix: string;
  label: string;
}

export interface ProxyConfig {
  httpProxy: { host: string; port: number };
  socks5Proxy: { host: string; port: number };
  supportedCountries: string[];
  blockedCountries: string[];
  geoTargeting: { stateSupport: boolean; citySupport: boolean; asnSupport: boolean };
}

export interface ProxyStatus {
  status: string;
  avgLatencyMs: number;
  activeSessions: number;
  uptimeSeconds: number;
  endpoints: { http: string; socks5: string };
  supportedCountries: string[];
}

export interface AccountInfo {
  user: {
    id: string;
    email: string;
    is_admin: boolean;
    email_verified: boolean;
    wallet_address: string | null;
    log_target_hosts: boolean;
  };
}

export interface Plan {
  id: string;
  name: string;
  pricePerGbCents: number;
  pricePerGbUsd: number;
  monthlyBandwidthBytes: number;
  monthlyBandwidthGB: number | null;
  isDefault: boolean;
  maxConnections: number;
  allowedProxyTypes: string | null;
}

export interface UserPlan {
  plan: Plan;
  usage: {
    monthlyUsageBytes: number;
    monthlyUsageGB: number;
    limitBytes: number;
    limitGB: number | null;
    percentUsed: number | null;
  };
}

export interface ActiveSession {
  id: string;
  startedAt: string;
  status: string;
}

export interface AuthVerifyKeyResponse {
  accessToken: string;
  refreshToken: string;
}

export interface AuthRefreshResponse {
  accessToken: string;
  refreshToken?: string;
}
