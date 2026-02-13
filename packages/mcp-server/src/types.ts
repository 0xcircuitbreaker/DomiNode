export interface WalletBalance {
  balance_cents: number;
  balance_usd: string;
  currency: string;
}

export interface WalletForecast {
  daily_average_cents: number;
  days_remaining: number | null;
  estimated_depletion_date: string | null;
}

export interface Transaction {
  id: string;
  type: string;
  amount_cents: number;
  description: string;
  created_at: string;
}

export interface TransactionList {
  transactions: Transaction[];
  total: number;
  page: number;
  limit: number;
}

export interface UsageSummary {
  total_bytes: number;
  total_cost_cents: number;
  total_requests: number;
  period_start: string;
  period_end: string;
}

export interface UsageRecord {
  id: string;
  bytes_in: number;
  bytes_out: number;
  cost_cents: number;
  target_host: string;
  created_at: string;
}

export interface DailyUsage {
  date: string;
  bytes: number;
  cost_cents: number;
  requests: number;
}

export interface TopHost {
  host: string;
  bytes: number;
  requests: number;
}

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyCreated {
  id: string;
  key: string;
  prefix: string;
  label: string;
}

export interface ProxyConfig {
  http_endpoint: string;
  socks5_endpoint: string;
  supported_countries: string[];
  username_format: string;
}

export interface ProxyStatus {
  status: string;
  latency_ms: number;
  providers: string[];
  active_sessions: number;
}

export interface Plan {
  id: string;
  name: string;
  price_cents: number;
  bandwidth_bytes: number;
  max_connections: number;
  features: string[];
}

export interface UserPlan {
  plan: Plan;
  usage_bytes: number;
  usage_percent: number;
}

export interface ActiveSession {
  id: string;
  started_at: string;
  bytes_in: number;
  bytes_out: number;
  target_host: string;
  country: string | null;
}

export interface AccountInfo {
  id: string;
  email: string;
  status: string;
  created_at: string;
  mfa_enabled: boolean;
}

export interface AuthVerifyKeyResponse {
  accessToken: string;
  refreshToken: string;
}

export interface AuthRefreshResponse {
  accessToken: string;
  refreshToken?: string;
}
