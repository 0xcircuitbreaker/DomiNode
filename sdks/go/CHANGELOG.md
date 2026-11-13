# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-11-13

Additive release.

### Changed
- TLS to the gateway is now the default: proxy traffic goes to the HTTPS proxy listener on port 8443 and the proxy URL builder returns `https://...:8443`. Production gateways refuse credentials on plaintext 8080/1080, so the old default failed on first use. Self-hosted coordinators publish the TLS proxy on 8444 by default; set the gateway TLS port to match. `&GatewayTLS{Disabled: true}` (new field) selects plaintext 8080 for local development.

### Added
- A refused CONNECT now carries the gateway's `X-DominusNode-Error` code (`ProxyError.Code`) and `Retry-After` seconds (`ProxyError.Details["retryAfter"]`), and the code is appended to the error message, so callers can tell INSUFFICIENT_BALANCE from NO_NODES_AVAILABLE or QUOTE_CLASS_MISMATCH.

## [2.1.0] - 2026-11-12

Additive release; no breaking changes to the v2 surface.

### Added
- Exit class `masked` (VPN/WARP/Tor egress, cheapest, opt-in): accepted by the IP-class validator and the proxy username builder (`class-masked`).
- Node fields `verifiedClass`, `declaredClass`, `classVerifiedAt`, `tierWeight` on node listings; `tierWeights` on the node tier response.
- `nodes.register` accepts an optional `declaredClass` (residential, mobile, dc or masked; informational).
- `NodeList`/`PayoutList` carry `NextCursor`; `Nodes.Each` and `Payouts.Each` follow it and fall back to offset paging on older servers (`List` signatures unchanged). `IPClasses` lists the accepted exit classes.

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
- Byte counts in usage results and network stats stay `int64` and decode from a JSON number or a numeric string.
- `TeamKey.KeyPrefix` and `TeamKeyCreated.KeyPrefix` are read from the server's `prefix` field (legacy
  `keyPrefix` accepted); a `Prefix` field with the same value is added.

### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

### Deprecated
- `TeamInvite.Token`: never sent by the server; always "".
- `ProxyHealth.ActiveSessions` and `ProxyHealth.UptimeSeconds`: never sent by the server; always 0.

## [2.0.0] - 2026-11-06

### Changed (breaking)
- Module path is now `github.com/0xcircuitbreaker/DomiNode/sdks/go/v2`.
- Rebuilt against the v2 relay-network contract (`sdks/SDK_SURFACE.md`): 15 resources,
  71 methods, `ConnectWithKey` / `Disconnect` / `IsConnected`. All methods take `context.Context` first.
- `NewClient(Config)` returns an error for invalid configuration.
- Proxy usernames use `country-XX`, `class-…`, `session-…`, `wallet-<uuid>`, `allowhttp-1`; no flags yields `relay`.

### Added
- `Network`, `Nodes`, `Credits`, `PayoutWallet`, `Payouts` resources and `Sessions.Report`.
- `Signer` interface / `SignerFunc`; signed messages are rebuilt locally and mismatches refused.
- `Secret` wrapper for one-time credentials (API key, team key, node key).
- `Proxy.Fetch` (GET/HEAD) with SSRF and DNS-rebinding checks; `ScrubCredentials`, `IsPrivateIP`.
- `ProtocolError`; error `Code` and `Details` fields.

### Removed
- Plans, slots/waitlist, admin, Stripe and PayPal top-ups, email/password register/login,
  password reset/change, human MFA, `ConnectWithCredentials`, `CompleteMfa`, agent-secret headers,
  `Proxy.GetStatus`, legacy `dc-`/`residential-`/`auto-` prefixes, state/city/ASN targeting,
  and every hardcoded price.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for Go.
- Context-aware API throughout -- all methods accept `context.Context` for cancellation and timeout support.
- Requires Go 1.22+. Zero external dependencies -- uses only the Go standard library.
- `Client` as the main entry point with public resource fields for accessing all API surfaces.
- Authentication via API key (`ConnectWithKey`), email/password with MFA support (`ConnectWithCredentials`, `CompleteMfa`), and pre-authenticated JWT tokens (`ConnectWithTokens`).
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
- Typed error hierarchy: `DominusNodeError`, `AuthenticationError`, `AuthorizationError`, `ValidationError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InsufficientBalanceError`, `ProxyError`, `NetworkError`, `ServerError`.
- Credential safety: automatic zeroization on `Disconnect()`, disabled auto-redirects, 10MB response size limit.
- `HttpClient` with configurable base URL, automatic `Authorization` header injection, and URL path parameter encoding via `url.PathEscape`.
- Full struct types for all API request and response shapes with JSON struct tags.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-go/releases/tag/v1.0.0
