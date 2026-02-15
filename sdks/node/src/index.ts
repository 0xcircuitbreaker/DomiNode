// Main client
export { DominusNodeClient } from "./client.js";

// Resource modules
export { AuthResource } from "./auth.js";
export { KeysResource } from "./keys.js";
export type { CreateKeyResponse, ListKeysResponse } from "./keys.js";
export { WalletResource } from "./wallet.js";
export type {
  WalletBalanceResponse,
  TransactionsResponse,
  StripeCheckoutResponse,
  CryptoInvoiceResponse,
  ForecastResponse,
} from "./wallet.js";
export { UsageResource } from "./usage.js";
export type {
  DateRangeOptions as UsageDateRangeOptions,
  UsageSummary,
  UsageResponse,
  DailyUsageDay,
  DailyUsageResponse,
  TopHostEntry,
  TopHostsResponse,
} from "./usage.js";
export { PlansResource } from "./plans.js";
export type {
  PlanEntry,
  ListPlansResponse,
  UserPlanResponse,
  ChangePlanResponse,
} from "./plans.js";
export { SessionsResource } from "./sessions.js";
export type { ActiveSessionEntry, ActiveSessionsResponse } from "./sessions.js";
export { ProxyResource } from "./proxy.js";
export type { ProxyHealthResponse, ProxyStatusResponse } from "./proxy.js";
export { AdminResource } from "./admin.js";
export type {
  DateRangeOptions as AdminDateRangeOptions,
  ListUsersResponse,
  GetUserResponse,
  RevenueResponse,
  DailyRevenueEntry,
  DailyRevenueResponse,
} from "./admin.js";

// Infrastructure (HttpClient for advanced custom integrations)
export { HttpClient } from "./http.js";
export type { HttpOptions } from "./http.js";
// TokenManager is internal — not exported to prevent misuse of token lifecycle

// Errors
export {
  DominusNodeError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  InsufficientBalanceError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ServerError,
  NetworkError,
  ProxyError,
} from "./errors.js";

// Types
export type {
  Dominus NodeConfig,
  User,
  ApiKey,
  Wallet,
  WalletTransaction,
  UsageRecord,
  TopHost,
  Plan,
  ActiveSession,
  ProxyUrlOptions,
  ProxyHealth,
  ProxyConfig,
  StripeCheckout,
  CryptoInvoice,
  AdminUser,
  RevenueStats,
  DailyRevenue,
  SystemStats,
  MfaStatus,
  MfaSetup,
  LoginResult,
  TokenPair,
} from "./types.js";

// Constants
export {
  SDK_VERSION,
  USER_AGENT,
  DEFAULT_BASE_URL,
  DEFAULT_PROXY_HOST,
  DEFAULT_HTTP_PROXY_PORT,
  DEFAULT_SOCKS5_PROXY_PORT,
} from "./constants.js";
