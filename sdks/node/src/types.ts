export interface DominusNodeConfig {
  baseUrl?: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  proxyHost?: string;
  httpProxyPort?: number;
  socks5ProxyPort?: number;
  agentSecret?: string;
}

export interface User {
  id: string;
  email: string;
  is_admin: boolean;
  created_at?: string;
}

export interface ApiKey {
  id: string;
  key_prefix: string;
  label: string;
  created_at: string;
  raw?: string; // Only returned on creation
}

export interface Wallet {
  balance_cents: number;
  currency: string;
}

export interface WalletTransaction {
  id: string;
  type: "topup" | "debit" | "refund";
  amount_cents: number;
  description: string;
  created_at: string;
}

export interface UsageRecord {
  date: string;
  bytes_in: number;
  bytes_out: number;
  total_bytes: number;
  cost_cents: number;
  request_count: number;
}

export interface TopHost {
  target_host: string;
  total_bytes: number;
  request_count: number;
}

export interface Plan {
  id: string;
  name: string;
  price_per_gb_cents: number;
  monthly_bandwidth_bytes: number;
  is_default: boolean;
}

export interface ActiveSession {
  id: string;
  started_at: string;
  status: string;
}

export interface ProxyUrlOptions {
  protocol?: "http" | "socks5";
  country?: string;
  state?: string;
  city?: string;
  asn?: number;
  sessionId?: string;
}

export interface ProxyHealth {
  status: string;
  providers?: unknown;
}

export interface ProxyConfig {
  httpProxy: { host: string; port: number };
  socks5Proxy: { host: string; port: number };
  supportedCountries: string[];
  blockedCountries: string[];
  geoTargeting?: {
    stateSupport: boolean;
    citySupport: boolean;
    asnSupport: boolean;
  };
}

export interface StripeCheckout {
  url: string;
  sessionId: string;
}

export interface CryptoInvoice {
  invoiceId: string;
  paymentUrl: string;
  amount: number;
  currency: string;
}

export interface PaypalOrder {
  orderId: string;
  approvalUrl: string;
  amountCents: number;
}

export interface AdminUser {
  id: string;
  email: string;
  status: string;
  is_admin: boolean;
  created_at: string;
  balance_cents: number;
}

export interface RevenueStats {
  total_revenue_cents: number;
  total_topups_cents: number;
  total_usage_cents: number;
  user_count: number;
}

export interface DailyRevenue {
  date: string;
  revenue_cents: number;
}

export interface SystemStats {
  active_sessions: number;
  total_users: number;
  total_bandwidth_bytes: number;
}

export interface MfaStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export interface MfaSetup {
  secret: string;
  otpauthUri: string;
  backupCodes: string[];
}

export interface LoginResult {
  user?: User;
  mfaRequired?: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface SlotsInfo {
  total: number;
  used: number;
  remaining: number;
  unlimited: boolean;
}

export interface WaitlistJoinResult {
  message: string;
}

export interface WaitlistCount {
  pending: number;
}
