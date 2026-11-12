# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-11-12

No breaking changes: every 2.0.0 public name and type still exists.

### Fixed
- Team keys read the server's `prefix` field (falls back to `keyPrefix`); key lists
  expose `userId`, `teamId` and `revokedAt`.
- Proxy health returns `{ status }` only, matching the server.
- Team invites carry `invitedBy`.
- Credits cursor validation matches the server (`^[1-9][0-9]{0,18}$`).
- 409 responses (e.g. `REPORT_LIMIT`) are never retried and surface with their `code`;
  429 is retried at most once.
- `UsageResource.byteCount(JsonNode)` reads byte counts sent as a JSON number or a numeric string.
- `CreatedTeamKey.prefix` added.

### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

### Deprecated
- `TeamsResource.CreatedTeamKey.keyPrefix`: use `prefix` (same value).

## [2.0.0] - 2026-11-06

### Breaking
- Rewritten to the v2 SDK contract (`sdks/SDK_SURFACE.md`): 15 resources, 71 methods.
- Removed plans, slots/waitlist, admin, Stripe and PayPal top-ups, email/password login and
  registration, human MFA flows, `connectWithCredentials`, legacy `dc-`/`residential-`/`auto-`
  username prefixes, state/city/ASN targeting and all hardcoded prices.
- Exceptions are now unchecked; results are Jackson `JsonNode` trees except security-sensitive
  typed results.

### Added
- Relay network resources: `network`, `nodes` (register with PoW and attestation), `credits`
  (µUSD, convert and withdraw), `payoutWallet`, `payouts`, `sessions.report`.
- `Signer`/`MessageSigner` callbacks; signed messages are rebuilt locally and mismatches refused.
- `Secret` wrapper for once-returned keys; credentials held as `char[]` and wiped on disconnect.
- `proxy.fetch` (GET/HEAD) with SSRF and DNS-rebinding checks, CONNECT tunnel, 10 MB cap.
- 429 retry with cap and jitter, 401 refresh, 10 MB response cap, redirects disabled.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for Java.
- Requires Java 11+. Uses `java.net.http.HttpClient` for HTTP communication.
- Jackson (`jackson-databind` 2.17) for JSON serialization/deserialization.
- Implements `AutoCloseable` for use with try-with-resources blocks.
- Builder pattern for client configuration via `Config.builder()`.
- `DominusNodeClient` as the main entry point with resource accessor methods.
- Authentication via API key (`connectWithKey`), email/password with MFA support (`connectWithCredentials`, `completeMfa`), and pre-authenticated JWT tokens (`connectWithTokens`).
- `AuthResource` for registration, login, MFA setup/verification, password reset, email verification, and account profile management.
- `WalletResource` for balance retrieval, transaction history, Stripe checkout session creation, and crypto invoice creation supporting 11 currencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK).
- `UsageResource` for usage summaries, daily breakdown, top hosts, and CSV export.
- `KeysResource` for creating, listing, and revoking API keys.
- `PlansResource` for listing available plans, retrieving the current plan, and changing plans.
- `ProxyResource` for building proxy URLs with geo-targeting (country, state, city, ASN, session ID) and proxy health/status monitoring, with `URLEncoder` for safe path parameter encoding.
- `SessionsResource` for listing active proxy sessions.
- `AgenticWalletResource` for creating, funding, listing, querying transactions, freezing, unfreezing, and deleting agentic sub-wallets.
- `TeamsResource` with 18 methods for team CRUD, shared wallet management, member management (add, remove, update role), invite management (create, list, cancel, accept), team API key creation and revocation, and team usage and transaction queries.
- `SlotsResource` for checking alpha slot availability, joining the waitlist, and checking waitlist position.
- `AdminResource` for admin-only operations including user management, system stats, revenue reporting, and provider statistics.
- `TokenManager` with automatic JWT access token refresh using rotating refresh tokens (15-minute access / 7-day refresh).
- Rate limit handling with exponential backoff, jitter (plus/minus 10%), 10-second max wait cap, and 100ms minimum wait.
- Typed exception hierarchy: `DominusNodeException` (checked), `UncheckedDominusNodeException` (unchecked wrapper), `AuthenticationException`, `AuthorizationException`, `ValidationException`, `NotFoundException`, `ConflictException`, `RateLimitException`, `InsufficientBalanceException`, `ProxyException`, `NetworkException`, `ServerException`.
- Credential safety: automatic zeroization on `close()` / `disconnect()`, disabled auto-redirects, 10MB response size limit.
- `HttpClient` with configurable base URL, automatic `Authorization` header injection, and `PATCH` HTTP method support.
- `Config` with builder pattern, sensible defaults for base URL, proxy host, and proxy ports.
- Comprehensive POJO types with Jackson annotations for all API request and response shapes.
- Maven Central-ready POM with GitHub Packages distribution management.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-java/releases/tag/v1.0.0
