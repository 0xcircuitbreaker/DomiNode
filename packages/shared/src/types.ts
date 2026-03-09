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

/** Admin role hierarchy: root_admin > cybersecurity_admin > admin > none */
export type AdminRole = "none" | "admin" | "cybersecurity_admin" | "root_admin";

/** Ordered hierarchy for comparison — higher index = more privilege */
const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  none: 0,
  admin: 1,
  cybersecurity_admin: 2,
  root_admin: 3,
};

/** Check if a role meets a minimum required level */
export function hasMinRole(userRole: AdminRole, requiredRole: AdminRole): boolean {
  return ADMIN_ROLE_RANK[userRole] >= ADMIN_ROLE_RANK[requiredRole];
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  status: UserStatus;
  password_changed_at: Date | null;
  is_admin: boolean;
  admin_role: AdminRole;
  wallet_address: string | null;
  log_target_hosts: boolean;
  email_verified: boolean;
}

// ─── API Key ─────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  user_id: string;
  team_id: string | null;
  key_hash: string;
  key_prefix: string;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
}

// ─── Team Types ───────────────────────────────────────────────────────

export type TeamRole = "owner" | "admin" | "member";
export type TeamStatus = "active" | "suspended" | "deleted";

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  plan_id: string;
  max_members: number;
  status: TeamStatus;
  created_at: Date;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: Date;
  email?: string;
}

export interface TeamInvite {
  id: string;
  team_id: string;
  email: string;
  role: TeamRole;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

export interface TeamWallet {
  id: string;
  team_id: string;
  balance_cents: number;
  currency: string;
  last_topped_up: Date | null;
}

export interface TeamWalletTransaction {
  id: string;
  wallet_id: string;
  type: "fund" | "debit" | "refund";
  amount_cents: number;
  description: string;
  created_at: Date;
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

export type PaymentProvider = "stripe" | "nowpayments" | "paypal" | "x402";
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
  maxConnections: number;
  maxSessionsPerMinute: number;
  allowedProxyTypes: string | null; // 'dc', 'residential', or null for all
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
  adminRole: AdminRole;
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

// ─── Referral / Affiliate / Promo / Loyalty ─────────────────────────

export interface ReferralCode {
  id: string;
  user_id: string;
  code_hash: string;
  code_prefix: string;
  max_uses: number;
  uses: number;
  credit_cents: number;
  active: boolean;
  expires_at: Date | null;
  created_at: Date;
}

export interface ReferralRedemption {
  id: string;
  referral_code_id: string;
  referrer_id: string;
  referee_id: string;
  credit_cents: number;
  created_at: Date;
}

export interface AffiliateLink {
  id: string;
  referrer_id: string;
  referee_id: string;
  active: boolean;
  created_at: Date;
}

export interface AffiliateCommission {
  id: string;
  referrer_id: string;
  referee_id: string;
  payment_id: string;
  topup_cents: number;
  commission_cents: number;
  commission_rate: number;
  status: "pending" | "credited" | "cancelled";
  credited_at: Date | null;
  created_at: Date;
}

export interface AffiliateStats {
  totalReferrals: number;
  activeReferrals: number;
  totalCommissionCents: number;
  pendingCommissionCents: number;
  creditedCommissionCents: number;
}

export interface PromoCode {
  id: string;
  admin_user_id: string;
  code_hash: string;
  code_prefix: string;
  credit_cents: number;
  max_uses: number;
  uses: number;
  active: boolean;
  expires_at: Date | null;
  created_at: Date;
}

export interface PromoRedemption {
  id: string;
  promo_code_id: string;
  user_id: string;
  credit_cents: number;
  created_at: Date;
}

export interface LoyaltyTier {
  id: string;
  name: string;
  min_spend_bytes: number;
  cashback_basis_pts: number;
  sort_order: number;
}

export interface LoyaltyReward {
  id: string;
  user_id: string;
  tier_id: string;
  period_start: string;
  period_end: string;
  spend_cents: number;
  reward_cents: number;
  status: "pending" | "credited";
  credited_at: Date | null;
  created_at: Date;
}

export interface LoyaltyStatus {
  currentTier: LoyaltyTier;
  currentMonthSpendBytes: number;
  nextTier: LoyaltyTier | null;
  bytesToNextTier: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Sell price: $5.00 per GB (residential) */
export const PRICE_PER_GB_CENTS = 500;

/** Sell price: $3.00 per GB (datacenter) */
export const PRICE_PER_GB_CENTS_DC = 300;

/** Our cost from Webshare DC (250 IPs, 1TB bandwidth, 250 replacements) */
export const COST_PER_GB_CENTS = 1;

/** Our cost from Webshare residential: $4.00 per GB (10GB for $40) */
export const COST_PER_GB_CENTS_RESIDENTIAL = 400;

/** 1 GB in bytes (1024^3) */
export const BYTES_PER_GB = 1_073_741_824;

/** Supported crypto currencies for top-up */
export const SUPPORTED_CRYPTO = ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"] as const;
export type SupportedCrypto = (typeof SUPPORTED_CRYPTO)[number];
