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
  RELAY_BYTES_PER_GB,
  BYTES_PER_GIB,
  SUPPORTED_CRYPTO,
  hasMinRole,
} from "./types.js";

// Database
export { getPool, query, closePool, connectWithRetry, queryOn } from "./db.js";
export type { DbTxClient } from "./db.js";

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
export { loadSdnFile, loadSdnText, parseSdnAddresses, parseSdnPayerAddresses, SdnUnavailableError, MAX_SDN_FILE_BYTES } from "./sdn.js";

// Repositories
export * as userRepo from "./repositories/user-repo.js";
export * as relayErasureRepo from "./repositories/relay-erasure-repo.js";
export * as walletRepo from "./repositories/wallet-repo.js";
export * as starterCreditRepo from "./repositories/starter-credit-repo.js";
export * as contributionRepo from "./repositories/contribution-repo.js";
export * as genesisRepo from "./repositories/genesis-repo.js";
export * as networkStatusRepo from "./repositories/network-status-repo.js";
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
  isDeletedUserEmail,
  WALLET_EMAIL_DOMAIN,
  LEGACY_WALLET_EMAIL_DOMAIN,
  DELETED_EMAIL_DOMAIN,
  LEGACY_DELETED_EMAIL_DOMAIN,
  WALLET_CHALLENGE_TTL_MS,
} from "./wallet-auth.js";

// Email
export { sendVerificationEmail, sendPasswordResetEmail, sendWaitlistApprovalEmail, sendTeamInviteEmail, isEmailEnabled } from "./email.js";

// Geo Data
export { US_STATES, MAJOR_US_CITIES } from "./geo-data.js";
export type { USState, USCity } from "./geo-data.js";

// Agent-network tunnel frame codec
export * from "./tunnel/frame.js";
export * from "./tunnel/auth-sig.js";

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

// Agent relay network
export { validatePolicy, policySha256, canonicalJson, isFloorKey, PolicyValidationError, DEFAULT_POLICY, PLAINTEXT_MODES, FLOOR_ALLOWED_PORTS, HARD_DENY_PORTS, MAX_POLICY_BYTES } from "./policy.js";
export type { NetworkPolicy, PlaintextMode, ValidatePolicyOptions } from "./policy.js";
// Exit (egress) classes — single source of truth
export {
  EXIT_CLASSES, NODE_IP_CLASSES, PRICING_CLASSES, DEFAULT_PRICE_PER_GB_MUSD, DEFAULT_TIER_WEIGHT_BPS,
  MAX_TIER_WEIGHT_BPS, CLASS_TRUST_RANK, isExitClass, isNodeIpClass, conservativeClass, isClassDowngrade,
  tierWeightBpsFor, weightedIpCount,
} from "./exit-classes.js";
export type { ExitClass } from "./exit-classes.js";
export * as policyRepo from "./repositories/policy-repo.js";
export type { ActivePolicy, PublishResult, PricingClass, SplitConfig, NodeTier } from "./repositories/policy-repo.js";
export * as nodeRepo from "./repositories/node-repo.js";
export type { NodeRecord, NodeStatus, NodeIpClass, TunnelAuthNode, NodeChallenge, RegisterNodeInput, RegisterNodeResult, HealthUpdate, ListAdminOpts } from "./repositories/node-repo.js";
export { hashNodeKey, generateNodeKey, NODE_KEY_PREFIX, NODE_CAP_BY_TIER } from "./repositories/node-repo.js";
export * as relayChargeRepo from "./repositories/relay-charge-repo.js";
export * as relaySettleRetryRepo from "./repositories/relay-settle-retry-repo.js";
export * as sessionRecoveryRepo from "./repositories/session-recovery-repo.js";
export * as nodeCreditRepo from "./repositories/node-credit-repo.js";
export * as tierRepo from "./repositories/tier-repo.js";
export * as reportReputationRepo from "./repositories/report-reputation-repo.js";
export * as collusionRepo from "./repositories/collusion-repo.js";
export * as payoutRepo from "./repositories/payout-repo.js";
export * as agentCreditsRepo from "./repositories/agent-credits-repo.js";
export * as relayLimitsRepo from "./repositories/relay-limits-repo.js";
export { buildAttestationMessage, sha256Hex, verifyPow, countLeadingZeroBits } from "./attestation.js";
export { getBaseTxCount, rpcUrlFromEnv, rpcTimeoutFromEnv, clearNonceCache } from "./starter-funding.js";

// Federation documents (coordinator identity, signed policy, fork branding)
export * from "./federation.js";
export { readActivePolicyForExport, PolicyExportError, type PolicyExportDeps } from "./federation-export.js";

// Gateway ports (one reader for listeners and advertised endpoints)
export {
  getProxyPorts,
  getPublicProxyPorts,
  getProxyInternalPort,
  assertDistinctProxyPorts,
  parsePortEnv,
  DEFAULT_PROXY_HTTP_PORT,
  DEFAULT_SOCKS5_PORT,
  DEFAULT_TUNNEL_PORT,
} from "./proxy-ports.js";
export type { ProxyPorts } from "./proxy-ports.js";

// Request ids (X-Request-Id), bound to logs via AsyncLocalStorage
export { resolveRequestId, runWithRequestId, currentRequestId, REQUEST_ID_HEADER } from "./request-id.js";

// Keyset pagination cursors
export { encodeCursor, decodeCursor } from "./cursor.js";
export type { KeysetCursor } from "./cursor.js";

// Post-quantum hybrid TLS (X25519MLKEM768) for every TLS endpoint we control
export * from "./tls-pq.js";

// API key hashing (HMAC-SHA256 pepper v2, SHA-256 v1 legacy)
export { apiKeyPepper, apiKeyLookup, hashApiKeyV1, hashApiKeyV2, hashApiKeyForStorage, hashEquals } from "./api-key-hash.js";
