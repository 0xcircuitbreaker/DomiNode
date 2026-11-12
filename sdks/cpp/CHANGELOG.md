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
- `byte_count(const json&)` reads byte counts sent as a JSON number or a numeric string.
- `TeamKeyCreateResponse::prefix` added; `key_prefix` is a deprecated alias.
### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

## [2.0.0] - 2026-11-06

### Breaking
- Rewritten for the v2 relay-network surface (`sdks/SDK_SURFACE.md`, reference `sdks/node` 2.0.0).
- Removed: plans, slots/waitlist, admin, Stripe/PayPal top-ups, email/password login and
  registration, human MFA flows, `connect_with_credentials`/`complete_mfa`, agent-secret
  headers, `proxy.get_status`, legacy `dc-`/`residential-`/`auto-` username prefixes,
  state/city/ASN targeting and all hardcoded prices.
- Resources are public members (`dn.credits.balance()`); results are `nlohmann::json`
  except credential-bearing ones (`Secret`) and `sessions.get_active()`.

### Added
- Relay resources: `network`, `nodes` (attestation + PoW registration), `credits`
  (µUSD convert/withdraw), `payout_wallet`, `payouts`, `sessions.report`.
- `Signer` callbacks; node attestation, payout-wallet and withdrawal messages rebuilt
  byte-for-byte and refused (signer never called) on mismatch.
- `Secret` wrapper (redacted in `operator<<`/JSON, zeroized on destruction).
- `proxy.fetch` GET/HEAD helper with URL rules, private-address table and DNS-rebinding check;
  `build_username`/`build_url` with `country-`, `class-`, `session-`, `wallet-`, `allowhttp-1` (OFAC refused).
- Injectable transport; error `code()`/`details()`; credential scrubbing incl. `dn_node_`/`dn_proxy_`.
- ctest suite covering every method, validation, errors, 429/401, size cap, redirects,
  signer flows (Node-generated fixtures), redaction and a local fake proxy gateway.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for C++.
- Requires C++17. Built with CMake (minimum 3.14).
- Dependencies: libcurl for HTTP and nlohmann-json (3.11+) for JSON parsing.
- Pimpl idiom for stable ABI and compilation firewall.
- Secure credential zeroization using `explicit_bzero` (Linux/macOS) or `SecureZeroMemory` (Windows) with volatile fallback.
- Explicit TLS certificate verification re-enabled after every `curl_easy_reset()` call.
- `DominusNodeClient` as the main entry point with resource accessor methods.
- Authentication via API key (`connect_with_key`), email/password with MFA support (`connect_with_credentials`, `complete_mfa`), and pre-authenticated JWT tokens (`connect_with_tokens`).
- `AuthResource` for registration, login, MFA setup/verification, password reset, email verification, and account profile management.
- `WalletResource` for balance retrieval, transaction history, Stripe checkout session creation, and crypto invoice creation supporting 11 currencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK).
- `UsageResource` for usage summaries, daily breakdown, top hosts, and CSV export.
- `KeysResource` for creating, listing, and revoking API keys.
- `PlansResource` for listing available plans, retrieving the current plan, and changing plans.
- `ProxyResource` for building proxy URLs with geo-targeting (country, state, city, ASN, session ID) and proxy health/status monitoring, with URL-encoding of special characters in proxy URL parameters.
- `SessionsResource` for listing active proxy sessions.
- `AgenticWalletResource` for creating, funding, listing, querying transactions, freezing, unfreezing, and deleting agentic sub-wallets.
- `TeamsResource` with 18 methods for team CRUD, shared wallet management, member management (add, remove, update role), invite management (create, list, cancel, accept), team API key creation and revocation, and team usage and transaction queries.
- `SlotsResource` for checking alpha slot availability, joining the waitlist, and checking waitlist position.
- `AdminResource` for admin-only operations including user management, system stats, revenue reporting, and provider statistics.
- `TokenManager` with automatic JWT access token refresh using rotating refresh tokens (15-minute access / 7-day refresh).
- Rate limit handling with exponential backoff, jitter (plus/minus 10%), 10-second max wait cap, and 100ms minimum wait.
- Typed error hierarchy: `DominusNodeException`, `AuthenticationException`, `AuthorizationException`, `ValidationException`, `NotFoundException`, `ConflictException`, `RateLimitException`, `InsufficientBalanceException`, `ProxyException`, `NetworkException`, `ServerException`.
- Credential safety: automatic zeroization in `ClientConfig` destructor and on `disconnect()`, disabled auto-redirects, 10MB response size limit.
- `HttpClient` with configurable base URL, automatic `Authorization` header injection, and `PATCH` HTTP method support.
- `ClientConfig` struct with sensible defaults for base URL, proxy host, and proxy ports.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-cpp/releases/tag/v1.0.0
