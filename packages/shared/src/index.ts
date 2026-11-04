// Types
export type {
  ProxyIP,
  ProxyIPType,
  ProxyIPStatus,
  User,
  UserStatus,
  AdminRole,
  ApiKey,
  Wallet,
  WalletTransaction,
  WalletTransactionType,
  Session,
  SessionStatus,
  UsageRecord,
  SupportedCrypto,
  PaymentInvoice,
  PaymentProvider,
  PaymentInvoiceStatus,
  Plan,
  AdminUserView,
  AdminUserDetail,
  RevenueStats,
  DailyRevenue,
  SystemStats,
} from "./types.js";

export {
  PRICE_PER_GB_CENTS,
  PRICE_PER_GB_CENTS_DC,
  COST_PER_GB_CENTS,
  BYTES_PER_GB,
  SUPPORTED_CRYPTO,
  hasMinRole,
} from "./types.js";

// Database
export { getPool, query, closePool, connectWithRetry } from "./db.js";

// Auth
export {
  generateApiKey,
  hashApiKey,
  hashPassword,
  verifyPassword,
  signJwt,
  signRefreshToken,
  createTokenPair,
  verifyJwt,
  verifyRefreshToken,
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  createProxySessionToken,
  verifyProxySessionToken,
} from "./auth.js";
export type { GeneratedApiKey, JwtPayload, TokenPair, MfaChallengePayload, ProxySessionPayload } from "./auth.js";

// Logger
export { createLogger } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";

// Validation
export {
  isValidEmail,
  isDisposableEmail,
  validatePassword,
  validateTopupAmount,
  isValidCryptoCurrency,
  sanitizeString,
  validateState,
  validateCity,
  validateAsn,
} from "./validation.js";

// Sanctions
export {
  SANCTIONED_COUNTRIES,
  SANCTIONED_REGIONS,
  BLOCKED_COUNTRY_CODES,
  isBlockedCountry,
} from "./sanctions.js";
export type { SanctionedCountry } from "./sanctions.js";

// Repositories
export * as userRepo from "./repositories/user-repo.js";
export * as walletRepo from "./repositories/wallet-repo.js";
export * as usageRepo from "./repositories/usage-repo.js";
export * as invoiceRepo from "./repositories/invoice-repo.js";
export * as planRepo from "./repositories/plan-repo.js";
export * as adminRepo from "./repositories/admin-repo.js";
export * as refreshTokenRepo from "./repositories/refresh-token-repo.js";
export * as mfaRepo from "./repositories/mfa-repo.js";
export * as walletChallengeRepo from "./repositories/wallet-challenge-repo.js";
export * as retentionRepo from "./repositories/retention-repo.js";
export * as waitlistRepo from "./repositories/waitlist-repo.js";
export type { WaitlistEntry } from "./repositories/waitlist-repo.js";
export * as agenticWalletRepo from "./repositories/agentic-wallet-repo.js";
export type {
  AgenticWallet,
  AgenticWalletTransaction,
  AgenticWalletStatus,
  AgenticWalletTxType,
} from "./repositories/agentic-wallet-repo.js";

export * as teamRepo from "./repositories/team-repo.js";
export type {
  Team,
  TeamMember,
  TeamInvite,
  TeamWallet,
  TeamWalletTransaction,
  TeamRole,
  TeamStatus,
} from "./types.js";

export * as powChallengeRepo from "./repositories/pow-challenge-repo.js";
export type { PowChallenge } from "./repositories/pow-challenge-repo.js";

export * as agentSecretRepo from "./repositories/agent-secret-repo.js";
export type { AgentSecret, GeneratedAgentSecret } from "./repositories/agent-secret-repo.js";

export * as referralRepo from "./repositories/referral-repo.js";
export type {
  ReferralCode,
  ReferralRedemption,
  AffiliateLink,
  AffiliateCommission,
  AffiliateStats,
  PromoCode,
  PromoRedemption,
  LoyaltyTier,
  LoyaltyReward,
  LoyaltyStatus,
} from "./types.js";

// TOTP
export {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
  generateTotpCode,
  buildTotpUri,
  generateBackupCodes,
  hashBackupCode,
} from "./totp.js";

// Wallet Auth
export {
  isValidEvmAddress,
  generateWalletNonce,
  buildSignMessage,
  walletToSyntheticEmail,
  isWalletEmail,
  WALLET_CHALLENGE_TTL_MS,
} from "./wallet-auth.js";

// Email
export { sendVerificationEmail, sendPasswordResetEmail, sendWaitlistApprovalEmail, sendTeamInviteEmail, isEmailEnabled } from "./email.js";

// Geo Data
export { US_STATES, MAJOR_US_CITIES } from "./geo-data.js";
export type { USState, USCity } from "./geo-data.js";

// Net guard (SSRF floor)
export {
  isValidHostname,
  isValidPort,
  isBlockedIp,
  isBlockedIPv4,
  isBlockedIPv6,
  expandIPv6,
  isBlockedTarget,
  isBlockedPort,
  isPublicAddress,
  resolveAndCheck,
} from "./net-guard.js";
export type { ResolveCheckResult } from "./net-guard.js";
