// ─── Proxy Types ─────────────────────────────────────────────────────

export type ProxyIPType = "residential" | "datacenter" | "mobile" | "isp";
export type ProxyIPStatus = "available" | "assigned" | "cooldown" | "burned" | "offline";

export interface ProxyIP {
  id: string;
  address: string;
  port: number;
  type: ProxyIPType;
  status: ProxyIPStatus;
  healthScore: number;
  assignedTo: string | null;
  lastChecked: Date;
  burnedAt: Date | null;
}

// ─── User ────────────────────────────────────────────────────────────

export type UserStatus = "active" | "suspended" | "deleted";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  status: UserStatus;
  password_changed_at: Date | null;
  is_admin: boolean;
}

// ─── API Key ─────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
}

// ─── Wallet ──────────────────────────────────────────────────────────

export interface Wallet {
  id: string;
  user_id: string;
  balance_cents: number;
  currency: "USD";
  last_topped_up: Date | null;
}

// ─── Wallet Transaction ──────────────────────────────────────────────

export type WalletTransactionType = "topup" | "debit" | "refund";

export interface WalletTransaction {
  id: string;
  wallet_id: string;
  type: WalletTransactionType;
  amount_cents: number;
  description: string;
  payment_provider: string | null;
  payment_id: string | null;
  created_at: Date;
}

// ─── Session ─────────────────────────────────────────────────────────

export type SessionStatus = "active" | "completed" | "error";

export interface Session {
  id: string;
  user_id: string;
  proxy_ip: string;
  started_at: Date;
  ended_at: Date | null;
  bytes_total: number;
  status: SessionStatus;
}

// ─── Usage Record ────────────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  user_id: string;
  session_id: string;
  bytes_in: number;
  bytes_out: number;
  cost_cents: number;
  proxy_type: string;
  target_host: string;
  created_at: Date;
}

// ─── Payment Invoice ────────────────────────────────────────────

export type PaymentProvider = "stripe" | "nowpayments";
export type PaymentInvoiceStatus = "pending" | "completed" | "failed";

export interface PaymentInvoice {
  id: string;
  user_id: string;
  provider: PaymentProvider;
  external_id: string;
  amount_cents: number;
  status: PaymentInvoiceStatus;
  created_at: Date;
}

// ─── Plan ───────────────────────────────────────────────────────────

export interface Plan {
  id: string;
  name: string;
  pricePerGbCents: number;
  monthlyBandwidthBytes: number;
  isDefault: boolean;
}

// ─── Admin Views ────────────────────────────────────────────────────

export interface AdminUserView {
  id: string;
  email: string;
  status: string;
  planId: string;
  balanceCents: number;
  createdAt: Date;
  isAdmin: boolean;
}

export interface AdminUserDetail extends AdminUserView {
  apiKeyCount: number;
  totalUsageBytes: number;
  totalSpentCents: number;
  lastActive: Date | null;
}

export interface RevenueStats {
  totalRevenueCents: number;
  totalTransactions: number;
  avgTransactionCents: number;
  topUpCount: number;
  uniquePayingUsers: number;
}

export interface DailyRevenue {
  date: string;
  revenueCents: number;
  transactionCount: number;
}

export interface SystemStats {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  totalApiKeys: number;
  activeApiKeys: number;
  totalSessions: number;
  activeSessions: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Sell price: $5.00 per GB */
export const PRICE_PER_GB_CENTS = 500;

/** Our cost from PacketStream: $1.00 per GB */
export const COST_PER_GB_CENTS = 100;

/** 1 GB in bytes (1024^3) */
export const BYTES_PER_GB = 1_073_741_824;

/** Supported crypto currencies for top-up */
export const SUPPORTED_CRYPTO = ["btc", "eth", "xmr", "sol", "zec"] as const;
export type SupportedCrypto = (typeof SUPPORTED_CRYPTO)[number];
