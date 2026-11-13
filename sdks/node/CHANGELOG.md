# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-11-13

Additive release.

### Changed
- TLS to the gateway is now the default: proxy traffic goes to the HTTPS proxy listener on port 8443 and the proxy URL builder returns `https://...:8443`. Production gateways refuse credentials on plaintext 8080/1080, so the old default failed on first use. Self-hosted coordinators publish the TLS proxy on 8444 by default; set the gateway TLS port to match. `gatewayTls: false` selects plaintext 8080 for local development.

### Added
- A refused CONNECT now carries the gateway's `X-DominusNode-Error` code (`ProxyError.code`) and `Retry-After` seconds (`ProxyError.retryAfter`), and the code is appended to the error message, so callers can tell INSUFFICIENT_BALANCE from NO_NODES_AVAILABLE or QUOTE_CLASS_MISMATCH.

## [2.1.0] - 2026-11-12

Additive release; no breaking changes to the v2 surface.

### Added
- Exit class `masked` (VPN/WARP/Tor egress, cheapest, opt-in): accepted by the IP-class validator and the proxy username builder (`class-masked`).
- Node fields `verifiedClass`, `declaredClass`, `classVerifiedAt`, `tierWeight` on node listings; `tierWeights` on the node tier response.
- `nodes.register` accepts an optional `declaredClass` (residential, mobile, dc or masked; informational).
- `nodes.list` and `payouts.list` accept a `cursor`; their iterators follow `nextCursor` and fall back to offset paging on older servers.

## [2.0.3] - 2026-11-12

Republish of 2.0.2, which npm did not finish publishing. No code changes.

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
- Response bodies are streamed with a byte counter and cancelled past 10 MB; chunked bodies are no longer buffered in full.

### Added
- `buyerDiscountBps` on credits balance and tier views, `buyerDiscounts` on pricing,
  `seed`/`community` blocks on network stats.
- Payout wallet `chain` accepts `base-sepolia` as an explicit opt-in (server decides).
- Pagination helpers for credit transactions, payouts, nodes, usage records and
  wallet transactions.
- README: PoW/client-IP note and a troubleshooting table.

### Deprecated
- `TeamKey.keyPrefix` and `TeamKeyCreateResponse.keyPrefix`: use `prefix` (same value).
- `TeamInvite.token` (now optional): never sent by the server.
- `ProxyHealth.activeSessions` and `ProxyHealth.uptimeSeconds` (now optional): never sent by the server.

## [2.0.0] - 2026-11-06

Reference SDK for the DominusNode AI-agent relay network. Breaking release;
the other five SDKs follow `sdks/SDK_SURFACE.md`.

### Removed
- `PlansResource`, `SlotsResource` (alpha slots/waitlist), `AdminResource`.
- Stripe and PayPal top-ups (`topUpStripe`, `topUpPaypal`); crypto top-up stays.
- Email/password and human MFA flows: `connectWithCredentials`, `completeMfa`,
  `auth.register/login/verifyMfa/changePassword/mfa*`. Humans use the admin panel.
- Legacy `dc-`/`residential-` username prefixes, state/city/asn targeting and hardcoded
  $3/$5 prices; `proxy.getStatus()` (exposed upstream providers).
- `agentSecret` config (MCP-only auto-verify headers are no longer sent by the SDK).

### Added
- `network`: `policy()`, `pricing()`, `stats()` (public).
- `nodes`: `registerChallenge()`, `register({ signer })` (SDK rebuilds the attestation
  message, refuses to sign if the server text differs, solves the PoW), `list()`,
  `revoke()`, `updateCaps()`, `tier()`. The `dn_node_` key is returned once in a `Secret`.
- `credits`: `balance()`, `transactions()`, `convert()` (Idempotency-Key), `withdraw({ signer })`.
- `payoutWallet`: `get()`, `set({ signer, oldWalletSigner? })`; `payouts.list()`.
- `sessions.report(sessionId, reason)` for burned exits.
- `proxy.buildUsername()`, `proxy.buildUrl()` with `country`, `ipClass`, `sessionId`,
  `allowHttp`, `agenticWalletId`; `proxy.fetch()` (GET/HEAD, CONNECT for https, no
  redirects, 10 MB cap, ports 80/443, SSRF + DNS-rebinding checks).
- `walletAuth.signIn(signer)`; `wallet.getCryptoStatus()`.
- `Secret` wrapper (redacted in `toString`/JSON/`inspect`), `ProtocolError`, error `code`
  and `details` from the server body, `scrubCredentials()` on every error message.
- µUSD amounts accepted as `bigint`, digit strings or safe integers.

### Changed
- `/v1` routes authenticate with the raw API key (`requireAgentPrincipal` rejects JWTs of
  non-wallet users); `/api` routes keep the JWT from `verify-key`.
- `connectWithKey()` returns `{ mfaRequired, userId }`; with MFA on, only key-auth routes work.
- `keys.create()` and `teams.createKey()` return the key as a `Secret` (call `reveal()`).
- `disconnect()` clears the API key and both tokens; logout is skipped when no JWT is held.
- `x402.getInfo()` types follow the server (facilitator map, server-reported pricing).
- Package `exports` lists `types` first.

## [1.0.0] - 2026-02-19

### Added
- Initial release of the Dominus Node SDK for Node.js/TypeScript.
- Zero external dependencies -- uses built-in Node 18+ `fetch` API exclusively.
- Dual CJS and ESM package output (`dist/cjs/` and `dist/esm/`) for broad compatibility.
- TypeScript strict mode with full type definitions exported.
- `DominusNodeClient` as the main entry point with resource-based API surface.
- Authentication via API key (`connectWithKey`), email/password with MFA support (`connectWithCredentials`, `completeMfa`), and pre-authenticated JWT tokens (`connectWithTokens`).
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
- Credential safety: automatic zeroization on `disconnect()`, disabled auto-redirects, 10MB response size limit.
- `HttpClient` with configurable base URL and automatic `Authorization` header injection.
- Comprehensive type definitions for all API request and response shapes.

[1.0.0]: https://github.com/Dominus-Node/dominusnode-node/releases/tag/v1.0.0
