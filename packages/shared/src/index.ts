// Types
export type {
  ProxyIP,
  ProxyIPType,
  ProxyIPStatus,
  User,
  UserStatus,
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
  COST_PER_GB_CENTS,
  BYTES_PER_GB,
  SUPPORTED_CRYPTO,
} from "./types.js";

// Database
export { getPool, query, closePool } from "./db.js";

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
} from "./auth.js";
export type { GeneratedApiKey, JwtPayload, TokenPair, MfaChallengePayload } from "./auth.js";

// Logger
export { createLogger } from "./logger.js";
export type { Logger, LogLevel } from "./logger.js";

// Validation
export {
  isValidEmail,
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

// Geo Data
export { US_STATES, MAJOR_US_CITIES } from "./geo-data.js";
export type { USState, USCity } from "./geo-data.js";
