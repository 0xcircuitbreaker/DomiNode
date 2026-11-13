# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.1.0] - 2026-11-13

Additive release.

### Changed
- TLS to the gateway is now the default: proxy traffic goes to the HTTPS proxy listener on port 8443 and the proxy URL builder returns `https://...:8443`. Production gateways refuse credentials on plaintext 8080/1080, so the old default failed on first use. Self-hosted coordinators publish the TLS proxy on 8444 by default; set the gateway TLS port to match. `gateway_tls: None` selects plaintext 8080 for local development.

### Added
- A refused CONNECT now carries the gateway's `X-DominusNode-Error` code (`DominusNodeError::code()`) and `Retry-After` seconds (`details()["retryAfter"]`), and the code is appended to the error message, so callers can tell INSUFFICIENT_BALANCE from NO_NODES_AVAILABLE or QUOTE_CLASS_MISMATCH.

## [3.0.0] - 2026-11-12

Same wire surface as the other SDKs' 2.1.0 (SDK_SURFACE v2, additive on the server side). The crate is a major
bump because adding an enum variant and public struct fields is a breaking change under Rust semver.

### Breaking
- `IpClass` gains a `Masked` variant and is now `#[non_exhaustive]`: an exhaustive `match` needs a `_` arm.
- `RegisterNodeOptions` gains `declared_class` and is now `#[non_exhaustive]`: build it with `RegisterNodeOptions::new(signer)` and set the public fields.
- Response models (`NodeInfo`, `NodeList`, `PayoutList`, tier response, ...) gain fields and are now `#[non_exhaustive]`: they can no longer be built with struct literals outside the crate (use `Default::default()` and set fields). Future additive server fields will no longer need a major bump.

### Added
- Exit class `masked` (VPN/WARP/Tor egress, cheapest, opt-in): accepted by the IP-class validator and the proxy username builder (`class-masked`).
- Node fields `verifiedClass`, `declaredClass`, `classVerifiedAt`, `tierWeight` on node listings; `tierWeights` on the node tier response.
- `nodes.register` accepts an optional `declaredClass` (residential, mobile, dc or masked; informational).
- `NodeList`/`PayoutList` carry `next_cursor`; new `nodes.list_after` / `payouts.list_after` fetch the page after a cursor, and `iter()` follows it (offset fallback on older servers).

## [2.0.2] - 2026-11-12

### Changed
- Default API base URL is now `https://api.dominusnode.com` and the default proxy host `proxy.dominusnode.com` (primary domain). The old `*.dominusnode.daedalusdevelopmentgroup.com` hosts stay served as aliases; set the base URL / proxy host option to keep using them.

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
- Byte-count fields in usage results and network stats decode from a JSON number or a numeric string.
- `TeamKey`/`TeamKeyCreated`: `key_prefix` is read from the server's `prefix` field (legacy `keyPrefix`
  accepted); a `prefix()` accessor is added.

### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

### Deprecated
- `TeamInvite::token`: never sent by the server; always empty.
- `ProxyHealth::active_sessions` and `ProxyHealth::uptime_seconds`: never sent by the server; always 0.

## [2.0.0] - 2026-11-06

### Changed (breaking)
- Rewritten to the v2 relay-network contract (`sdks/SDK_SURFACE.md`): 15 resources, 71 methods.
- New error enum with `Validation`, `Authentication`, `InsufficientBalance`, `Authorization`,
  `NotFound`, `Conflict`, `RateLimit`, `Server`, `Network`, `Protocol`, `Proxy`, `Api`;
  `code()`, `status_code()`, `details()` accessors.
- Proxy username flags are `country-XX`, `class-…`, `session-…`, `wallet-<uuid>`, `allowhttp-1`.
- `tokio` is a required dependency; the `async`/`blocking` features are gone.

### Added
- `network`, `nodes`, `credits`, `payout_wallet`, `payouts` resources; `sessions.report`.
- `Signer` trait and `FnSigner`; signed messages are rebuilt locally and compared before signing.
- `Secret` wrapper for one-time credentials; `proxy.fetch` GET/HEAD helper with SSRF and DNS-rebinding checks.
- Injectable `Transport` and DNS `Resolver` for tests.

### Removed
- Plans, slots/waitlist, admin, Stripe and PayPal top-ups, email/password and MFA flows,
  agent-secret headers, `proxy.get_status`, legacy `dc-`/`residential-`/`auto-` prefixes,
  state/city/ASN targeting and hardcoded prices.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for Rust.
- Async client by default using `tokio` and `reqwest`, with an optional `blocking` feature flag for synchronous usage.
- Zero-copy deserialization where possible using `serde`.
- Credential zeroization via the `zeroize` crate for secure memory cleanup.
- Requires Rust 2021 edition.
- `DominusNodeClient` as the main entry point with resource-based API surface.
- Authentication via API key (`connect_with_key`), email/password with MFA support (`connect_with_credentials`, `complete_mfa`), and pre-authenticated JWT tokens (`connect_with_tokens`).
- `AuthResource` for registration, login, MFA setup/verification, password reset, email verification, and account profile management.
- `WalletResource` for balance retrieval, transaction history, Stripe checkout session creation, and crypto invoice creation supporting 11 currencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK).
- `UsageResource` for usage summaries, daily breakdown, top hosts, and CSV export.
- `KeysResource` for creating, listing, and revoking API keys.
- `PlansResource` for listing available plans, retrieving the current plan, and changing plans.
- `ProxyResource` for building proxy URLs with geo-targeting (country, state, city, ASN, session ID) and proxy health/status monitoring.
- `SessionsResource` for listing active proxy sessions.
- `AgenticWalletResource` for creating, funding, listing, querying transactions, freezing, unfreezing, and deleting agentic sub-wallets.
- `TeamsResource` with 18 methods for team CRUD, shared wallet management, member management (add, remove, update role), invite management (create, list, cancel, accept), team API key creation and revocation, and team usage and transaction queries.
- `SlotsResource` for checking alpha slot availability, joining the waitlist, and checking waitlist position.
- `AdminResource` for admin-only operations including user management, system stats, revenue reporting, and provider statistics.
- `TokenManager` with automatic JWT access token refresh using rotating refresh tokens (15-minute access / 7-day refresh).
- Rate limit handling with exponential backoff, jitter (plus/minus 10%), 10-second max wait cap, and 100ms minimum wait.
- Typed error hierarchy using `thiserror`: `DominusNodeError`, `AuthenticationError`, `AuthorizationError`, `ValidationError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InsufficientBalanceError`, `ProxyError`, `NetworkError`, `ServerError`.
- Credential safety: automatic zeroization on `disconnect()` via `zeroize`, disabled auto-redirects, 10MB response size limit, `Debug` impl redacts secrets.
- `HttpClient` with configurable base URL, automatic `Authorization` header injection, and URL-safe path parameter encoding.
- Full `serde::Serialize` / `serde::Deserialize` implementations for all API request and response types.
- `Config` struct with builder-style initialization, sensible defaults, and redacted `Debug` output for credentials.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-rust/releases/tag/v1.0.0
