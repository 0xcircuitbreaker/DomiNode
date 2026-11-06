// Client
export { DominusNodeClient } from "./client.js";

// Resources
export { AuthResource } from "./resources/auth.js";
export type { VerifyKeyResponse } from "./resources/auth.js";
export { WalletAuthResource } from "./resources/wallet-auth.js";
export type { WalletChallenge, WalletVerifyResult, WalletLinkResult } from "./resources/wallet-auth.js";
export { KeysResource } from "./resources/keys.js";
export type { ApiKeyInfo, CreatedApiKey } from "./resources/keys.js";
export { WalletResource, CRYPTO_CURRENCIES } from "./resources/wallet.js";
export type { WalletBalance, WalletTransaction, CryptoInvoice, CryptoInvoiceStatus, Forecast, CryptoCurrency } from "./resources/wallet.js";
export { AgenticWalletResource } from "./resources/agent-wallet.js";
export type {
  AgenticWallet, AgenticWalletTransaction, AgenticWalletListResponse, AgenticWalletFundResponse,
  AgenticWalletTransactionsResponse, AgenticWalletDeleteResponse,
} from "./resources/agent-wallet.js";
export { TeamsResource } from "./resources/teams.js";
export type {
  Team, TeamMember, TeamInvite, TeamKey, TeamListResponse, TeamMembersResponse, TeamInvitesResponse, TeamKeysResponse,
  TeamKeyCreateResponse, TeamDeleteResponse, TeamFundResponse, TeamTransaction, TeamTransactionsResponse,
} from "./resources/teams.js";
export { UsageResource } from "./resources/usage.js";
export type { DateRange, UsageRecord, UsageResponse, DailyUsageResponse, TopHostsResponse } from "./resources/usage.js";
export { SessionsResource, REPORT_REASONS } from "./resources/sessions.js";
export type { ActiveSession, ReportReason, ReportResult } from "./resources/sessions.js";
export { X402Resource } from "./resources/x402.js";
export type { X402Info, X402Facilitator } from "./resources/x402.js";
export { NetworkResource } from "./resources/network.js";
export type { NetworkPolicy, NetworkPricing, NetworkStats } from "./resources/network.js";
export { NodesResource } from "./resources/nodes.js";
export type {
  NodeChallenge, RegisterNodeOptions, RegisteredNode, NodeInfo, NodeCaps, UpdateCapsResult, NodeTier, TierView, TierRequirement,
} from "./resources/nodes.js";
export {
  CreditsResource, PayoutsResource, CREDIT_TX_TYPES, newIdempotencyKey,
  MIN_CONVERT_MUSD, MAX_CONVERT_MUSD, MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD,
} from "./resources/credits.js";
export type { CreditsBalance, CreditTransaction, CreditTxType, ConvertResult, Payout, PayoutStatus, WithdrawResult } from "./resources/credits.js";
export { PayoutWalletResource } from "./resources/payout-wallet.js";
export type { PayoutWalletInfo, PayoutWalletChallenge, SetPayoutWalletOptions, SetPayoutWalletResult } from "./resources/payout-wallet.js";
export { ProxyResource } from "./resources/proxy.js";
export type { ProxyUrlOptions, ProxyHealth } from "./resources/proxy.js";

// Proxy + safety helpers
export { buildProxyUsername } from "./proxy-fetch.js";
export type { IpClass, ProxyRoutingOptions, ProxyFetchOptions, ProxyFetchResponse } from "./proxy-fetch.js";
export { isPrivateIp, validateTargetUrl } from "./ssrf.js";
export { buildAttestationMessage, buildPayoutWalletMessage, buildWithdrawMessage } from "./messages.js";
export type { Signer } from "./signer.js";
export { Secret } from "./secret.js";
export type { MusdInput } from "./validation.js";

// Errors
export {
  DominusNodeError, AuthenticationError, AuthorizationError, RateLimitError, InsufficientBalanceError, ValidationError,
  NotFoundError, ConflictError, ServerError, NetworkError, ProtocolError, ProxyError, scrubCredentials,
} from "./errors.js";

// Types + constants
export type { DominusNodeConfig, Money, User, ConnectResult } from "./types.js";
export {
  SDK_VERSION, USER_AGENT, DEFAULT_BASE_URL, DEFAULT_PROXY_HOST, DEFAULT_HTTP_PROXY_PORT, DEFAULT_SOCKS5_PROXY_PORT,
  MAX_RESPONSE_BYTES, MAX_AMOUNT_CENTS,
} from "./constants.js";
// HttpClient and TokenManager are internal.
