# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
