# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
