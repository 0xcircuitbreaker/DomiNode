# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
- `WalletResource` for balance retrieval, transaction history, Stripe checkout session creation, and crypto invoice creation supporting 10 currencies (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB).
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
