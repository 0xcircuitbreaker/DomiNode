# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.1] - 2026-11-12

### Fixed
- Team keys read the server's `prefix` field (falls back to `keyPrefix`); key lists
  expose `userId`, `teamId` and `revokedAt`.
- Proxy health returns `{ status }` only, matching the server.
- Team invites carry `invitedBy`; the never-returned `token` field is gone.
- Credits cursor validation matches the server (`^[1-9][0-9]{0,18}$`).
- 409 responses (e.g. `REPORT_LIMIT`) are never retried and surface with their `code`;
  429 is retried at most once.
- A malformed `Content-Length` response header raises `ServerError` instead of being ignored.
### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

## [2.0.0] - 2026-11-06

Breaking: rewritten for the v2 relay-network contract (`sdks/SDK_SURFACE.md`, reference `sdks/node` 2.0.0).

### Added
- 15 resources and 71 methods, the same in `DominusNodeClient` and `AsyncDominusNodeClient`: `network`, `nodes` (with PoW and attestation registration), `credits` (µUSD convert and withdraw), `payout_wallet`, `payouts`, `sessions.report` and `wallet_auth.sign_in`.
- EIP-191 signer callbacks. The SDK rebuilds the node-attestation, payout-wallet and withdrawal messages itself and refuses to sign a server message that differs (`ProtocolError`).
- `proxy.build_username`/`build_url` with `country-XX` (OFAC refused), `class-…`, `session-…`, `wallet-<uuid>` and `allowhttp-1`.
- `proxy.fetch` for GET/HEAD through the gateway, with an SSRF guard (private IPs in every spelling, local names) and a DNS-rebinding check.
- `Secret` wrapper for one-time credentials, `ProtocolError` and `ProxyError`, error `code` and `details`.
- Credential scrubbing now also covers `dn_node_`/`dn_proxy_` keys and JWTs.

### Changed
- Redirects are refused and API responses are capped at 10 MB, by Content-Length and by the bytes actually read.
- 429 is retried once, waiting min(Retry-After, 10 s) ±10 % with a 100 ms floor. 401 triggers one JWT refresh, shared by concurrent callers.
- `/v1` agent routes send the raw API key.
- `disconnect()` clears the API key and both tokens. The token manager keeps its refresh callback.
- Amounts must be integers. Floats, NaN, Infinity and bools are rejected.

### Removed
- Plans, slots and waitlist, admin, Stripe and PayPal top-ups, email/password login and registration, human MFA, `connect_with_credentials`, `complete_mfa`, `proxy.get_status`, the legacy `dc-`/`residential-`/`auto-` username prefixes, `state-`/`city-`/`asn-` targeting, and all hardcoded prices.
- The `respx` dev dependency. Tests use `httpx.MockTransport`.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for Python.
- Async client (`AsyncDominusNodeClient`) built on `httpx` for asyncio-based usage.
- Sync client (`DominusNodeClient`) for synchronous usage with identical API surface.
- Both clients support context manager protocol (`with` / `async with`) for automatic cleanup.
- Requires Python 3.9+.
- Authentication via API key (`connect_with_key`), email/password with MFA support (`connect_with_credentials`, `complete_mfa`), and pre-authenticated JWT tokens (`connect_with_tokens`).
- `AuthResource` / `AsyncAuthResource` for registration, login, MFA setup/verification, password reset, email verification, and account profile management.
- `WalletResource` / `AsyncWalletResource` for balance retrieval, transaction history, Stripe checkout session creation, and crypto invoice creation supporting 11 currencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK).
- `UsageResource` / `AsyncUsageResource` for usage summaries, daily breakdown, top hosts, and CSV export.
- `KeysResource` / `AsyncKeysResource` for creating, listing, and revoking API keys.
- `PlansResource` / `AsyncPlansResource` for listing available plans, retrieving the current plan, and changing plans.
- `ProxyResource` / `AsyncProxyResource` for building proxy URLs with geo-targeting (country, state, city, ASN, session ID) and proxy health/status monitoring.
- `SessionsResource` / `AsyncSessionsResource` for listing active proxy sessions.
- `AgenticWalletResource` / `AsyncAgenticWalletResource` for creating, funding, listing, querying transactions, freezing, unfreezing, and deleting agentic sub-wallets.
- `TeamsResource` / `AsyncTeamsResource` with 18 methods for team CRUD, shared wallet management, member management (add, remove, update role), invite management (create, list, cancel, accept), team API key creation and revocation, and team usage and transaction queries.
- `SlotsResource` / `AsyncSlotsResource` for checking alpha slot availability, joining the waitlist, and checking waitlist position.
- `AdminResource` / `AsyncAdminResource` for admin-only operations including user management, system stats, revenue reporting, and provider statistics.
- `TokenManager` / `AsyncTokenManager` with automatic JWT access token refresh using rotating refresh tokens (15-minute access / 7-day refresh).
- Rate limit handling with exponential backoff, jitter (plus/minus 10%), 10-second max wait cap, and 100ms minimum wait.
- Typed error hierarchy: `DominusNodeError`, `AuthenticationError`, `AuthorizationError`, `ValidationError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InsufficientBalanceError`, `ProxyError`, `NetworkError`, `ServerError`.
- Credential safety: automatic zeroization on `disconnect()`, disabled auto-redirects, 10MB response size limit.
- `SyncHttpClient` / `AsyncHttpClient` with configurable base URL and automatic `Authorization` header injection.
- Full type annotations throughout using Python typing module.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-python/releases/tag/v1.0.0
