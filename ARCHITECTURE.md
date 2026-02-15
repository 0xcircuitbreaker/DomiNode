# Dominus Node Architecture

## System Overview

Dominus Node is a rotating residential proxy-as-a-service (PaaS) platform. It resells upstream proxy bandwidth from PacketStream at $5/GB (cost: $1/GB from PacketStream, yielding 80% gross margin). Users authenticate with API keys, connect through Dominus Node's proxy gateway, and their traffic is routed through PacketStream's residential proxy network to target sites. Usage is metered by bytes transferred and debited from a prepaid wallet.

The platform exposes three network-facing services:

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| HTTP Proxy Gateway | 8080 | HTTP/HTTPS CONNECT | Proxy server for client traffic |
| SOCKS5 Proxy Gateway | 1080 | SOCKS5 | Alternative proxy protocol |
| REST API (Dashboard) | 3000 | HTTP/JSON | Account management, billing, admin |

During development, the React frontend runs on port 5173 via Vite dev server and proxies `/api` requests to the dashboard backend on port 3000.

---

## Architecture Diagram

```
                              Dominus Node Platform
                    ┌──────────────────────────────────────┐
                    │                                      │
 ┌──────────────┐   │  ┌──────────────────────────────┐    │   ┌──────────────────┐
 │ User App /   │───┼─▶│  HTTP Proxy Gateway  :8080   │────┼──▶│                  │
 │ Browser Ext  │   │  │  (HTTP fwd + HTTPS CONNECT)  │    │   │  PacketStream    │
 │ (API key     │   │  └──────────────────────────────┘    │   │  Gateway         │
 │  auth)       │   │                                      │   │                  │
 │              │───┼─▶┌──────────────────────────────┐    │   │  gw.packetstream │──▶ Target Site
 │              │   │  │  SOCKS5 Proxy Gateway :1080  │────┼──▶│  .io:31112       │
 │              │   │  │  (SOCKS5 username/pass auth) │    │   │                  │
 └──────────────┘   │  └──────────────────────────────┘    │   └──────────────────┘
                    │         │                            │
                    │         │ Session tracking,          │
                    │         │ byte counting,             │
                    │         │ wallet debiting             │
                    │         ▼                            │
 ┌──────────────┐   │  ┌──────────────────────────────┐    │
 │ Frontend SPA │   │  │  REST API Server     :3000   │    │
 │ React 18     │───┼─▶│  (Express.js)                │    │
 │ Vite :5173   │   │  │                              │    │
 │              │   │  │  Auth, Keys, Wallet, Usage,  │    │
 │ Browser Ext  │───┼─▶│  Plans, Admin, Webhooks      │    │
 │ (MV3)        │   │  └──────────────┬───────────────┘    │
 └──────────────┘   │                 │                    │
                    │                 ▼                    │
                    │  ┌──────────────────────────────┐    │
                    │  │  PostgreSQL 16       :5432   │    │
                    │  │                              │    │
                    │  │  users, api_keys, wallets,   │    │
                    │  │  wallet_transactions,         │    │
                    │  │  sessions, usage_records,     │    │
                    │  │  payment_invoices, plans,     │    │
                    │  │  refresh_tokens, mfa_configs, │    │
                    │  │  mfa_backup_codes             │    │
                    │  └──────────────────────────────┘    │
                    └──────────────────────────────────────┘
```

### Proxy Chaining Flow

```
HTTP Request:
  Client ──▶ Dominus Node HTTP Proxy (:8080) ──▶ PacketStream (31112) ──▶ Target
         Proxy-Authorization: Basic          Proxy-Authorization: Basic
         (API key)                           (PacketStream creds + geo)

HTTPS CONNECT (double-CONNECT tunnel):
  Client CONNECT ──▶ Dominus Node ──CONNECT──▶ PacketStream ──CONNECT──▶ Target
  (opaque TLS tunnel through both proxies — Dominus Node cannot see encrypted content)

SOCKS5:
  Client ──SOCKS5──▶ Dominus Node (:1080) ──CONNECT──▶ PacketStream (31112) ──▶ Target
  (SOCKS5 auth with API key, then HTTP CONNECT to upstream)
```

---

## Monorepo Structure

The project uses npm workspaces with TypeScript project references for build orchestration. All TypeScript code runs in strict mode.

```
Dominus Node/
├── packages/
│   ├── shared/              # Core library: types, DB, auth, TOTP, validation, repositories
│   │   └── src/
│   │       ├── types.ts             # User, ApiKey, Wallet, Session, UsageRecord, Plan, etc.
│   │       ├── db.ts                # pg.Pool singleton, query() helper
│   │       ├── auth.ts              # API key gen (SHA-256), bcrypt passwords, JWT, refresh tokens
│   │       ├── totp.ts              # RFC 6238 TOTP: AES-256-GCM secrets, HMAC-SHA256 backup codes
│   │       ├── schema.sql           # Full PostgreSQL DDL (11 tables)
│   │       ├── migrate.ts           # Schema migration script
│   │       ├── logger.ts            # JSON structured logger
│   │       ├── validation.ts        # Email, password, amount, geo field validators
│   │       ├── sanctions.ts         # OFAC blocked countries (Cuba, Iran, NK, Russia, Syria)
│   │       ├── geo-data.ts          # US states + major US cities for sub-country targeting
│   │       ├── index.ts             # Public API re-exports
│   │       └── repositories/
│   │           ├── user-repo.ts         # User CRUD, API key management
│   │           ├── wallet-repo.ts       # Wallet CRUD, credit/debit with SELECT FOR UPDATE
│   │           ├── usage-repo.ts        # Usage recording, aggregation, top hosts
│   │           ├── invoice-repo.ts      # Payment invoice tracking
│   │           ├── plan-repo.ts         # Plan management
│   │           ├── admin-repo.ts        # Admin views, revenue stats
│   │           ├── refresh-token-repo.ts # Token storage, family rotation, purging
│   │           └── mfa-repo.ts          # MFA config, backup code storage/consumption
│   │
│   ├── pool-manager/            # Upstream proxy provider management
│   │   └── src/
│   │       ├── packetstream.ts          # PacketStream gateway auth builder, geo suffixes
│   │       ├── packetstream-provider.ts # PacketStreamProvider (ProxyProvider impl)
│   │       ├── direct-provider.ts       # DirectProvider for self-hosted VPS proxies
│   │       ├── provider.ts             # ProxyProvider interface, circuit breaker per provider
│   │       ├── provider-selector.ts    # Multi-provider failover (primary + fallbacks)
│   │       └── index.ts                # Re-exports, createProviderSelector factory
│   │
│   ├── proxy-gateway/           # HTTP + SOCKS5 proxy servers
│   │   └── src/
│   │       ├── server.ts               # HTTP proxy: request forwarding + HTTPS CONNECT tunneling
│   │       ├── socks5.ts               # SOCKS5 proxy: full protocol with username/password auth
│   │       ├── main.ts                 # Entrypoint: starts both servers, graceful shutdown
│   │       ├── auth.ts                 # Proxy-Authorization header parsing, API key lookup
│   │       ├── balance-check.ts        # Wallet balance verification with 5s TTL cache
│   │       ├── session-manager.ts      # In-memory session tracking, reservation, settlement
│   │       ├── counting-stream.ts      # CountingStream: byte counters for billing
│   │       ├── circuit-breaker.ts      # Per-provider circuit breaker (5 failures, 30s cooldown)
│   │       ├── target-validator.ts     # SSRF protection, DNS rebinding double-resolve
│   │       ├── geo-check.ts            # GeoIP sanctioned country check
│   │       ├── connection-tracker.ts   # Per-user connection limits
│   │       ├── auth-rate-limit.ts      # Failed auth attempt tracking
│   │       ├── retry.ts               # Configurable retries with exponential backoff
│   │       └── stats.ts               # Request/error/latency metrics
│   │
│   ├── metering/                # Cost calculation and usage billing
│   │   └── src/
│   │       └── index.ts                # computeCostCents ($5/GB), recordUsage, debitForUsage
│   │
│   ├── billing/                 # Payment processing
│   │   └── src/
│   │       ├── stripe.ts               # Stripe Checkout session creation, webhook handler
│   │       ├── nowpayments.ts          # NOWPayments crypto invoices, IPN verification
│   │       └── index.ts                # Re-exports
│   │
│   ├── dashboard/               # Express REST API server (backend)
│   │   └── src/
│   │       ├── server.ts               # Express app: helmet, CORS, rate limiting, CSRF
│   │       ├── main.ts                 # Entrypoint with graceful shutdown
│   │       ├── middleware/
│   │       │   └── auth.ts             # JWT verification: httpOnly cookie + Bearer dual-path
│   │       ├── helpers/
│   │       │   └── cookies.ts          # httpOnly cookie helpers (set, clear, names)
│   │       └── routes/
│   │           ├── auth.ts             # Register, login, refresh, logout, MFA, verify-key
│   │           ├── keys.ts             # API key CRUD
│   │           ├── usage.ts            # Usage stats, daily aggregation, top hosts, CSV export
│   │           ├── wallet.ts           # Balance, transactions, Stripe/crypto top-up
│   │           ├── plans.ts            # Plan listing, user plan, plan changes
│   │           ├── sessions.ts         # Active session listing
│   │           ├── admin.ts            # User management, revenue stats, system stats
│   │           ├── proxy-config.ts     # Proxy server configuration for extension
│   │           ├── proxy-health.ts     # Public proxy health status
│   │           └── webhooks.ts         # Stripe + NOWPayments webhook handlers
│   │
│   ├── frontend/                # React SPA (client-side UI)
│   │   └── src/
│   │       ├── App.tsx                 # Route definitions, admin guard, lazy loading
│   │       ├── api/client.ts           # Fetch wrapper with refresh deduplication
│   │       ├── context/AuthContext.tsx  # Auth state, session restore via GET /me
│   │       ├── hooks/useApi.ts         # Data fetching hook with error sanitization
│   │       ├── components/             # Layout, TopHosts, CsvExportButton
│   │       └── pages/
│   │           ├── LoginPage.tsx        # Login form with MFA step
│   │           ├── DashboardPage.tsx    # Overview dashboard
│   │           ├── ApiKeysPage.tsx      # API key management
│   │           ├── WalletPage.tsx       # Balance, transactions, top-up
│   │           ├── UsagePage.tsx        # Usage history with date filtering
│   │           ├── PlansPage.tsx        # Plan selection and upgrade
│   │           ├── SecurityPage.tsx     # MFA setup and management
│   │           └── AdminPage.tsx        # Admin panel (lazy-loaded)
│   │
│   └── extension/               # Browser extension (Manifest V3)
│       ├── build.mjs                   # esbuild bundler
│       ├── manifests/                  # Per-browser manifest.json (Chrome, Firefox, Opera, Edge)
│       └── src/
│           ├── background/             # Service worker: auth manager, proxy control, alarms
│           ├── popup/                  # Login UI, proxy toggle, geo selection
│           ├── content/               # WebRTC leak prevention (relay-only ICE)
│           ├── options/               # Extension options page
│           ├── shared/                # Shared utilities
│           ├── adapters/              # Browser abstraction layer
│           ├── assets/                # Icon assets
│           └── ui/                    # Shared UI components
│
├── sdks/
│   ├── node/                    # Node.js/TypeScript SDK (@dominusnode/sdk)
│   │   ├── src/                        # Zero deps, dual CJS+ESM, Node 18+
│   │   └── tests/
│   ├── python/                  # Python SDK (dominusnode)
│   │   ├── dominusnode/                   # httpx, sync + async clients, Python 3.9+
│   │   └── tests/
│   ├── cpp/                     # C++ SDK (dominusnode-cpp)
│   │   ├── include/                    # libcurl + nlohmann/json, CMake, C++17, Pimpl
│   │   ├── src/
│   │   └── tests/
│   └── rust/                    # Rust SDK (dominusnode crate)
│       ├── src/                        # reqwest + tokio, async default + blocking feature
│       └── tests/
│
├── docker-compose.yml           # PostgreSQL 16 for local development
├── .env.example                 # All environment variables (documented)
├── tsconfig.json                # Root TypeScript config with project references
├── vitest.config.ts             # Test runner configuration
├── package.json                 # Root workspace config (npm workspaces)
├── CLAUDE.md                    # Project instructions and context
└── ARCHITECTURE.md              # This file
```

### Package Dependency Graph

```
shared ◀── pool-manager ◀── proxy-gateway
shared ◀── metering
shared ◀── billing
shared ◀── dashboard (imports pool-manager, metering, billing)
frontend (standalone React SPA — communicates with dashboard via fetch)
extension (standalone — communicates with dashboard via fetch)
```

All inter-package dependencies flow through `@dominusnode/shared` as the foundation. The proxy gateway depends on `pool-manager` for upstream proxy selection. The dashboard API depends on `pool-manager`, `metering`, and `billing` for business operations. The frontend and extension are fully decoupled client applications that only communicate via HTTP to the dashboard REST API.

---

## Dashboard vs Frontend

These names can be confusing, so to be explicit:

- **`packages/dashboard/`** is the **backend REST API server**. Despite the name "dashboard", it is an Express.js application that serves JSON endpoints under `/api/*`. It runs on port 3000 and contains all server-side route handlers, middleware, authentication logic, and business operations. It is the only backend service that directly queries PostgreSQL for account management.

- **`packages/frontend/`** is the **client-side React SPA** that provides the visual user interface. It is built with React 18 + Vite + Tailwind CSS (dark theme). During development it runs on port 5173 with Vite's dev server proxying `/api` requests to the dashboard backend. It has 8 pages: Login, Dashboard, API Keys, Wallet, Usage, Plans, Security (MFA), and Admin.

---

## Core Components

### 1. Shared Library (`@dominusnode/shared`)

The foundation package that all other backend packages depend on.

**Types** (`types.ts`): Defines all domain types including `User`, `ApiKey`, `Wallet`, `WalletTransaction`, `Session`, `UsageRecord`, `Plan`, `PaymentInvoice`, `AdminUserView`, `AdminUserDetail`, `RevenueStats`, `DailyRevenue`, `SystemStats`. Constants: `PRICE_PER_GB_CENTS` (500), `COST_PER_GB_CENTS` (100), `BYTES_PER_GB` (1073741824).

**Database** (`db.ts`): PostgreSQL connection via `pg.Pool` singleton. Provides `query()` helper for parameterized queries. SSL is enforced for all non-dev/test environments.

**Auth** (`auth.ts`):
- API key generation: Cryptographically random 32-byte keys with `dn_live_` prefix, hashed with SHA-256 for O(1) database lookup (same approach as GitHub and Stripe -- bcrypt would be too slow for per-proxy-request auth).
- Passwords: bcrypt hashing and verification.
- JWT access tokens: 15-minute expiry, signed with HMAC-SHA256.
- Refresh tokens: 7-day expiry, family-based rotation with reuse detection. If a revoked token is reused, the entire token family is revoked (catches stolen tokens).
- MFA challenge tokens: 5-minute short-lived JWT for the login-to-MFA-verification handoff.

**TOTP 2FA** (`totp.ts`): Full RFC 6238 implementation.
- Secrets encrypted at rest with AES-256-GCM (key from `MFA_ENCRYPTION_KEY` env var).
- Backup codes hashed with HMAC-SHA256 for one-time use.
- TOTP replay prevention via `lastUsedCounter`.
- OTPAuth URI generation for QR code scanning.

**Validation** (`validation.ts`): Input validators for email (RFC-compliant regex), password (minimum 8 characters, 2+ character classes, blocks top 20 common passwords), top-up amounts (positive integer cents), and geo-targeting fields (state, city, ASN).

**Sanctions** (`sanctions.ts`): OFAC compliance -- blocks traffic from Cuba, Iran, North Korea, Russia, and Syria.

**Geo Data** (`geo-data.ts`): US states and major US cities for sub-country geo-targeting in proxy requests.

**Repositories**: Data access layer with parameterized queries.

| Repository | Key Operations |
|------------|----------------|
| `user-repo` | Create user, find by email/ID/API-key-hash, update password, suspend/activate/delete |
| `wallet-repo` | Create wallet, credit/debit (with `SELECT FOR UPDATE` + 5s `lock_timeout`), get balance, transaction history |
| `usage-repo` | Create usage record, daily aggregation, top hosts, date-range queries, CSV export |
| `invoice-repo` | Create/update payment invoices, find by external ID |
| `plan-repo` | List plans, get user plan, change plan |
| `admin-repo` | Admin user list with details, revenue statistics, daily revenue, system stats |
| `refresh-token-repo` | Store/revoke tokens, family rotation, reuse detection, expired token purging |
| `mfa-repo` | MFA config CRUD, backup code storage, atomic backup code consumption |

### 2. Pool Manager (`@dominusnode/pool-manager`)

Manages upstream proxy providers with failover support.

**PacketStream Provider** (`packetstream-provider.ts`): The primary proxy provider. Builds upstream proxy credentials with geo-targeting suffixes appended to the PacketStream password:
- Country: `_country-US`
- State: `_state-california`
- City: `_city-losangeles`
- Sticky session: `_session-abc123`

Username format from the client encodes targeting options: `country-US-state-california-city-losangeles-session-abc123`

**Direct Provider** (`direct-provider.ts`): For self-hosted VPS or datacenter proxies configured via `FALLBACK_PROXY_*` environment variables. Supports up to 10 fallback providers with non-contiguous numbering (gaps are allowed).

**Provider Selector** (`provider-selector.ts`): Multi-provider failover logic.
1. Try primary providers first (PacketStream), sorted by priority.
2. If all primaries are circuit-broken, try fallback providers in priority order.
3. If all providers are down, throw "All proxy providers are unavailable".

Each provider has its own circuit breaker instance (from `provider.ts`) with configurable failure threshold and cooldown period.

**ProxyProvider Interface** (`provider.ts`): Abstract interface that all providers implement:
- `name`: Provider identifier
- `priority`: Lower = preferred
- `fallbackOnly`: Whether to skip this provider when primaries are available
- `isAvailable()`: Circuit breaker state check
- `getProxy(options?)`: Returns `UpstreamProxy` (host, port, proxyAuth base64)
- `recordSuccess(latencyMs?)`: Reset circuit breaker
- `recordFailure()`: Increment circuit breaker failures

### 3. Proxy Gateway (`@dominusnode/proxy-gateway`)

The core revenue-generating service. Two TCP servers sharing common infrastructure.

#### HTTP Proxy Server (`:8080`)

Handles two types of requests:

**HTTP Forwarding**: Client sends a normal HTTP request with an absolute URL. Dominus Node forwards it through PacketStream as a standard proxy request with `Proxy-Authorization` header.

**HTTPS CONNECT Tunneling**: Client sends `CONNECT host:port HTTP/1.1`. Dominus Node establishes a TCP connection to PacketStream and sends its own `CONNECT` request (double-CONNECT). Once both CONNECTs succeed, data is piped bidirectionally -- Dominus Node sees only encrypted bytes.

Also exposes an internal stats endpoint at `/internal/stats` (localhost-only, optional Bearer secret auth).

#### SOCKS5 Proxy Server (`:1080`)

Full SOCKS5 protocol implementation (RFC 1928 + RFC 1929):
1. **Greeting**: Client offers authentication methods; server requires username/password (0x02).
2. **Authentication**: Username encodes geo-targeting options; password is the API key.
3. **Request**: Only CONNECT command is supported. Supports IPv4, IPv6, and domain address types.
4. **Relay**: After successful upstream CONNECT through PacketStream, data is piped bidirectionally.

#### Shared Infrastructure

Both proxy servers use these shared modules:

**Auth** (`auth.ts`): Parses `Proxy-Authorization: Basic` headers. Extracts the API key (password field), computes SHA-256 hash, performs O(1) database lookup to find the user. Parses the username field for geo-targeting options (country, state, city, ASN, sticky session ID).

**Balance Check** (`balance-check.ts`): Queries the user's wallet balance before allowing a connection. Results are cached in-memory with a 5-second TTL to avoid per-request database queries under high throughput.

**Session Manager** (`session-manager.ts`): In-memory `Map` tracking active proxy sessions.
- **Start session**: Reserves a minimum balance (10 cents) from the wallet via `SELECT FOR UPDATE`. If the user has insufficient balance, the session is rejected with HTTP 402.
- **End session**: Settles the session by computing actual cost from bytes transferred, recording usage, debiting the wallet, and releasing the reservation.
- **Rate limiting**: Enforces per-user session creation rate limit (configurable via `MAX_SESSIONS_PER_MINUTE`, default 30).
- **Stale cleanup**: Periodic timer evicts sessions that exceed the max age (default 1 hour).

**Byte Counting** (`counting-stream.ts`): `attachByteCounters()` wraps client and upstream sockets to track `bytesIn` and `bytesOut` in real time. The counter object is shared with the session manager for billing calculation at session end.

**Circuit Breaker** (`circuit-breaker.ts`): Per-provider circuit breaker pattern.
- **Closed** (normal): Requests pass through. Failures increment counter.
- **Open** (tripped): After 5 consecutive failures, all requests are rejected for 30 seconds.
- **Half-open**: After cooldown, one request is allowed through. Success resets; failure re-opens.
- Configurable via `CIRCUIT_BREAKER_FAILURE_THRESHOLD` and `CIRCUIT_BREAKER_COOLDOWN_MS`.

**Target Validator** (`target-validator.ts`): SSRF protection.
- Blocks connections to private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, etc.).
- DNS rebinding mitigation: double-resolve with 50ms delay. If the IP address changes between resolutions, the request is blocked.
- Hostname validation: blocks CRLF injection characters in hostnames.
- Port validation: only allows ports 1-65535.
- Note: SSRF protection is best-effort when using an upstream proxy, since PacketStream resolves DNS independently.

**Geo Check** (`geo-check.ts`): Checks the connecting client's IP against the OFAC sanctions list. Connections from sanctioned countries are immediately rejected.

**Connection Tracker** (`connection-tracker.ts`): Per-user concurrent connection limit (configurable via `PROXY_MAX_PER_USER`, default 100). Prevents a single user from monopolizing server capacity.

**Auth Rate Limiter** (`auth-rate-limit.ts`): Tracks failed authentication attempts per IP. After too many failures within a window, subsequent attempts are rejected with 429.

**Retry Logic** (`retry.ts`): Configurable retry with exponential backoff for upstream proxy requests. Default: 2 retries with 200ms base delay. Failed retries are transparent to the client (response headers indicate retry count).

**Stats** (`stats.ts`): In-memory counters for total requests, errors, and latency percentiles. Accessible via the `/internal/stats` endpoint.

### 4. Metering (`@dominusnode/metering`)

Handles cost calculation and wallet debiting for proxy usage.

- **`computeCostCents(totalBytes, pricePerGbCents)`**: Calculates cost in cents. Default rate is $5/GB (500 cents). Minimum charge is 1 cent if any bytes were transferred. Uses ceiling rounding to avoid undercharging.
- **`recordUsage(userId, sessionId, bytesIn, bytesOut, targetHost, ...)`**: Creates a usage record in the database with all metering fields including optional connect latency.
- **`debitForUsage(userId, costCents, sessionId)`**: Debits the user's wallet. Uses `walletRepo.debitWallet()` which internally does `SELECT FOR UPDATE` with a 5-second lock timeout to prevent race conditions and deadlocks under concurrent session settlement.

### 5. Billing (`@dominusnode/billing`)

Payment processing for wallet top-ups via two providers.

**Stripe** (`stripe.ts`):
- Creates Checkout Sessions for fiat wallet top-ups with configurable success/cancel URLs.
- Webhook handler verifies Stripe signatures (`stripe.webhooks.constructEvent()`).
- Processes `checkout.session.completed` events: credits the wallet, creates a wallet transaction, updates the payment invoice status.
- Idempotent: duplicate `payment_id` values are caught by the unique index on `wallet_transactions(payment_provider, payment_id)`.

**NOWPayments** (`nowpayments.ts`):
- Creates crypto invoices supporting BTC, ETH, XMR, SOL, and ZEC.
- IPN (Instant Payment Notification) webhook verifies signatures with HMAC-SHA512.
- Processes confirmed payments: credits the wallet based on the invoice amount.
- Same idempotency guarantee via the unique index.

### 6. Dashboard API (`@dominusnode/dashboard`)

Express.js REST API server providing all account management, billing, and admin functionality.

**Security Middleware Stack** (applied in order):
1. **Helmet**: HSTS (1 year, includeSubDomains, preload), plus standard security headers.
2. **Request ID**: UUID assigned to every request for tracing.
3. **Cache-Control**: `no-store, no-cache, must-revalidate` on all API responses.
4. **Cookie Parser**: Required for httpOnly cookie auth.
5. **CORS**: Restricted to configured origins (`CORS_ORIGINS`), credentials enabled for cookie auth.
6. **Global Rate Limit**: 100 requests/minute per IP.
7. **Webhook Routes**: Mounted before `express.json()` because Stripe requires raw request body for signature verification.
8. **CSRF Protection**: On state-changing requests (POST/PUT/DELETE), validates the `Origin` header against allowed origins -- but only when auth cookies are present (cookie-less requests from extension/SDK are not vulnerable to CSRF).
9. **JSON Body Parser**: 16KB size limit.
10. **Auth Rate Limit**: Stricter limit on `/api/auth` endpoints (10 requests per 15 minutes in production, relaxed in development).

**Authentication Middleware** (`middleware/auth.ts`): Dual-path authentication supporting two client types:
1. **Browser clients**: Read JWT from `dominusnode_access` httpOnly cookie. Tokens are never exposed to JavaScript (XSS-proof).
2. **Extension/SDK clients**: Read JWT from `Authorization: Bearer <token>` header. Tokens are stored in `chrome.storage.session` (ephemeral, cleared when browser closes).

**Token Lifecycle Management**: An hourly background job purges expired refresh tokens from the database to prevent unbounded table growth. The timer is `.unref()`'d so it does not prevent Node.js process exit.

### 7. Frontend (`@dominusnode/frontend`)

React 18 single-page application with Vite build tooling and Tailwind CSS dark theme.

**Pages**:
| Page | Route | Description |
|------|-------|-------------|
| LoginPage | `/login` | Login form with optional MFA verification step |
| DashboardPage | `/` | Overview: balance, recent usage, quick stats |
| ApiKeysPage | `/keys` | Create, list, revoke API keys |
| WalletPage | `/wallet` | Balance display, transaction history, Stripe/crypto top-up |
| UsagePage | `/usage` | Usage records with date range filtering, CSV export |
| PlansPage | `/plans` | View available plans, change plan |
| SecurityPage | `/security` | MFA setup (TOTP QR code), enable/disable, backup codes |
| AdminPage | `/admin` | User management, revenue stats (lazy-loaded, admin guard) |

**Auth Flow**: Uses `AuthContext` with `useAuth()` hook. On page load, attempts session restore via `GET /api/auth/me` (reads the httpOnly cookie automatically). No tokens are stored in localStorage or sessionStorage -- the browser manages cookies transparently.

**API Client** (`api/client.ts`): Fetch wrapper that automatically retries on 401 by calling `POST /api/auth/refresh`. Uses a deduplication lock to prevent multiple concurrent refresh requests when several API calls fail simultaneously.

**AdminPage**: Lazy-loaded with `React.lazy()` and wrapped in `AdminGuard` to prevent admin-only code from being shipped to regular users.

### 8. Browser Extension (`packages/extension/`)

Manifest V3 browser extension supporting Chrome, Firefox, Opera, and Edge.

**Architecture**:
- **Background Service Worker**: Manages authentication state, controls proxy settings via `chrome.proxy.settings`, sets up alarm-based token refresh.
- **Popup UI**: Login interface (supports API key auth and email/password with MFA), proxy on/off toggle, country/state/city geo-targeting selection.
- **Content Script**: Injects WebRTC leak prevention by setting ICE transport policy to relay-only, preventing IP address leakage through WebRTC.
- **Options Page**: Extension configuration.

**Security**:
- Auth tokens stored in `chrome.storage.session` (ephemeral -- cleared when browser closes, never persisted to disk).
- `onAuthRequired` listener validates request initiator before providing proxy credentials.
- Server-side logout: calls `POST /api/auth/logout` to revoke all refresh tokens.
- Logout clears state before canceling alarms to prevent race conditions.

**Build System**: esbuild bundler (`build.mjs`) produces separate builds for each browser from shared source code. Four `manifest.json` files in `manifests/` directory handle browser-specific API differences.

**Proxy Host Configuration**: The proxy host is derived from the API base URL (configurable), with proxy port information fetched from `GET /api/proxy/config`.

---

## Database Schema

PostgreSQL 16 with 11 tables. The `pgcrypto` extension provides `gen_random_uuid()` for primary keys.

### Table Definitions

```
users
├── id                  UUID PRIMARY KEY (auto-generated)
├── email               TEXT UNIQUE NOT NULL
├── password_hash       TEXT NOT NULL
├── created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
├── status              TEXT NOT NULL DEFAULT 'active'  CHECK (active|suspended|deleted)
├── plan_id             TEXT NOT NULL DEFAULT 'payg'  REFERENCES plans(id)
├── is_admin            BOOLEAN NOT NULL DEFAULT false
└── password_changed_at TIMESTAMPTZ

api_keys
├── id          UUID PRIMARY KEY
├── user_id     UUID NOT NULL  REFERENCES users(id)
├── key_hash    TEXT NOT NULL   (SHA-256 hash)
├── key_prefix  TEXT NOT NULL   (first 12 chars for display: dn_live_xxxx)
├── label       TEXT NOT NULL DEFAULT ''
├── created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
└── revoked_at  TIMESTAMPTZ
    INDEX idx_api_keys_hash ON key_hash WHERE revoked_at IS NULL  (O(1) lookup)
    INDEX idx_api_keys_user ON user_id

wallets
├── id             UUID PRIMARY KEY
├── user_id        UUID UNIQUE NOT NULL  REFERENCES users(id)
├── balance_cents  INTEGER NOT NULL DEFAULT 0  CHECK (>= 0)
├── currency       TEXT NOT NULL DEFAULT 'USD'
└── last_topped_up TIMESTAMPTZ

wallet_transactions
├── id               UUID PRIMARY KEY
├── wallet_id        UUID NOT NULL  REFERENCES wallets(id)
├── type             TEXT NOT NULL  CHECK (topup|debit|refund)
├── amount_cents     INTEGER NOT NULL  CHECK (> 0)
├── description      TEXT NOT NULL DEFAULT ''
├── payment_provider TEXT
├── payment_id       TEXT
└── created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    UNIQUE INDEX ON (payment_provider, payment_id) WHERE both NOT NULL
    (prevents duplicate webhook credits)

sessions
├── id          UUID PRIMARY KEY
├── user_id     UUID NOT NULL  REFERENCES users(id)
├── proxy_ip    TEXT NOT NULL DEFAULT ''
├── started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
├── ended_at    TIMESTAMPTZ
├── bytes_total BIGINT NOT NULL DEFAULT 0
└── status      TEXT NOT NULL DEFAULT 'active'  CHECK (active|completed|error)

usage_records
├── id                 UUID PRIMARY KEY
├── user_id            UUID NOT NULL  REFERENCES users(id)
├── session_id         UUID NOT NULL  REFERENCES sessions(id)
├── bytes_in           BIGINT NOT NULL DEFAULT 0
├── bytes_out          BIGINT NOT NULL DEFAULT 0
├── cost_cents         INTEGER NOT NULL DEFAULT 0
├── proxy_type         TEXT NOT NULL DEFAULT 'residential'
├── target_host        TEXT NOT NULL DEFAULT ''
├── connect_latency_ms INTEGER
└── created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    INDEX ON (user_id, created_at)

payment_invoices
├── id           UUID PRIMARY KEY
├── user_id      UUID NOT NULL  REFERENCES users(id)
├── provider     TEXT NOT NULL  CHECK (stripe|nowpayments)
├── external_id  TEXT NOT NULL
├── amount_cents INTEGER NOT NULL  CHECK (> 0)
├── status       TEXT NOT NULL DEFAULT 'pending'  CHECK (pending|completed|failed)
└── created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    UNIQUE INDEX ON (provider, external_id)

plans
├── id                      TEXT PRIMARY KEY
├── name                    TEXT NOT NULL
├── price_per_gb_cents      INTEGER NOT NULL
├── monthly_bandwidth_bytes BIGINT NOT NULL DEFAULT 0
└── is_default              BOOLEAN NOT NULL DEFAULT false

refresh_tokens
├── id         UUID PRIMARY KEY
├── user_id    UUID NOT NULL  REFERENCES users(id)
├── token_hash TEXT NOT NULL   (SHA-256 hash)
├── family_id  UUID NOT NULL   (rotation tracking -- all tokens in a family are related)
├── revoked    BOOLEAN NOT NULL DEFAULT false
├── expires_at TIMESTAMPTZ NOT NULL
└── created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    INDEX ON token_hash WHERE NOT revoked
    INDEX ON family_id
    INDEX ON user_id

mfa_configs
├── id              UUID PRIMARY KEY
├── user_id         UUID UNIQUE NOT NULL  REFERENCES users(id)
├── totp_secret_enc TEXT NOT NULL   (AES-256-GCM encrypted)
├── totp_secret_iv  TEXT NOT NULL   (initialization vector)
├── enabled         BOOLEAN NOT NULL DEFAULT false
├── created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
└── enabled_at      TIMESTAMPTZ

mfa_backup_codes
├── id         UUID PRIMARY KEY
├── user_id    UUID NOT NULL  REFERENCES users(id)
├── code_hash  TEXT NOT NULL   (HMAC-SHA256 hashed)
├── used_at    TIMESTAMPTZ
└── created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    INDEX ON user_id WHERE used_at IS NULL
```

### Seeded Plans

| Plan ID | Name | Price/GB | Monthly Bandwidth |
|---------|------|----------|-------------------|
| `free` | Free Trial | $5.00 (500 cents) | 100 MB |
| `payg` | Pay As You Go | $5.00 (500 cents) | Unlimited (0 = no cap) |
| `vol100` | Volume 100GB | $4.00 (400 cents) | 100 GB |
| `vol1tb` | Volume 1TB | $3.00 (300 cents) | 1 TB |

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Create account (auto-creates wallet, issues tokens) |
| POST | `/api/auth/login` | None | Login (returns MFA challenge if 2FA enabled) |
| POST | `/api/auth/refresh` | Refresh token (cookie or body) | Rotate refresh token, issue new token pair |
| POST | `/api/auth/change-password` | JWT | Change password (revokes all refresh tokens, issues new pair) |
| POST | `/api/auth/logout` | JWT | Revoke all refresh tokens, clear cookies |
| GET | `/api/auth/me` | JWT | Get current user info (session restore for frontend) |
| POST | `/api/auth/verify-key` | None | Verify API key, issue JWT tokens (extension/SDK auth) |
| POST | `/api/auth/mfa/verify` | Challenge token (cookie or body) | Complete MFA with TOTP code or backup code |
| POST | `/api/auth/mfa/setup` | JWT | Generate TOTP secret + QR URI + backup codes (shown once) |
| POST | `/api/auth/mfa/enable` | JWT | Verify initial TOTP code, activate MFA |
| POST | `/api/auth/mfa/disable` | JWT | Disable MFA (requires password + TOTP/backup code) |
| GET | `/api/auth/mfa/status` | JWT | Check MFA status and remaining backup codes |

### API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/keys` | JWT | Create API key (plaintext shown once, only hash stored) |
| GET | `/api/keys` | JWT | List user's API keys (prefix + label only) |
| DELETE | `/api/keys/:id` | JWT | Revoke API key (soft delete via `revoked_at`) |

### Wallet

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/wallet` | JWT | Get current balance |
| GET | `/api/wallet/transactions` | JWT | Transaction history with pagination |
| POST | `/api/wallet/topup/stripe` | JWT | Create Stripe Checkout session |
| POST | `/api/wallet/topup/crypto` | JWT | Create NOWPayments crypto invoice (BTC/ETH/XMR/SOL/ZEC) |
| GET | `/api/wallet/forecast` | JWT | Usage forecast based on recent activity |

### Usage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/usage` | JWT | Usage records with pagination and date filtering |
| GET | `/api/usage/daily` | JWT | Daily usage aggregation |
| GET | `/api/usage/top-hosts` | JWT | Top target hosts by bandwidth |
| GET | `/api/usage/export/csv` | JWT | Export usage records as CSV |

### Plans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/plans` | None | List all available plans |
| GET | `/api/plans/user` | JWT | Get user's current plan |
| POST | `/api/plans/change` | JWT | Change to a different plan |

### Sessions and Proxy

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/sessions/active` | JWT | List user's active proxy sessions |
| GET | `/api/proxy/config` | JWT | Proxy server host/port configuration |
| GET | `/api/proxy/health` | None | Public proxy health status |
| GET | `/api/proxy/status` | JWT | Detailed proxy status with provider info |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | JWT (admin) | List all users with plan and balance info |
| GET | `/api/admin/users/:id` | JWT (admin) | Get detailed user info |
| POST | `/api/admin/users/:id/suspend` | JWT (admin) | Suspend user (revokes API keys + refresh tokens) |
| POST | `/api/admin/users/:id/activate` | JWT (admin) | Reactivate suspended user |
| DELETE | `/api/admin/users/:id` | JWT (admin) | Delete user account |
| GET | `/api/admin/revenue` | JWT (admin) | Revenue statistics (total, period) |
| GET | `/api/admin/revenue/daily` | JWT (admin) | Daily revenue breakdown |
| GET | `/api/admin/stats` | JWT (admin) | System statistics (users, sessions, bandwidth) |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/webhooks/stripe` | Stripe signature | Handle `checkout.session.completed` events |
| POST | `/api/webhooks/nowpayments` | HMAC-SHA512 signature | Handle IPN payment confirmation callbacks |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | None | Health check (verifies DB connectivity) |

---

## Authentication Flow

### Browser (Frontend) Authentication

```
1. Registration / Login:
   POST /api/auth/register  or  POST /api/auth/login
   ├── Server validates credentials
   ├── If MFA enabled: returns { mfaRequired: true } + challenge cookie
   │   └── POST /api/auth/mfa/verify with TOTP code
   │       └── Server issues real tokens
   ├── Server issues JWT access token (15min) + refresh token (7d)
   ├── Sets httpOnly cookies: dominusnode_access, dominusnode_refresh
   └── Response body: { user: { id, email, is_admin } }
       (NO tokens in body for browser clients -- XSS safe)

2. Session Restore (page reload):
   GET /api/auth/me
   ├── Browser auto-sends httpOnly cookies
   ├── Middleware reads JWT from dominusnode_access cookie
   └── Returns { user: { id, email, is_admin } }

3. Token Refresh (automatic on 401):
   POST /api/auth/refresh
   ├── Browser auto-sends dominusnode_refresh cookie
   ├── Server verifies refresh token against DB
   ├── Checks for token reuse (stolen token detection)
   ├── Revokes old token, issues new pair (same family)
   └── Sets new httpOnly cookies
```

### Extension / SDK Authentication

```
1. API Key Auth:
   POST /api/auth/verify-key { apiKey: "dn_live_..." }
   ├── Server SHA-256 hashes the key, looks up in DB
   ├── Issues JWT + refresh token
   └── Returns tokens in response body (extension stores in chrome.storage.session)

2. Credential Auth:
   POST /api/auth/login { email, password }
   ├── Same flow as browser but tokens returned in body
   └── If MFA: challenge token in body, then POST /mfa/verify with body token

3. Token Refresh:
   POST /api/auth/refresh { refreshToken: "..." }
   └── Tokens returned in response body
```

### Proxy Authentication

```
Client connects to proxy (HTTP or SOCKS5):
├── Proxy-Authorization: Basic base64(username:apiKey)
│   └── username encodes geo-targeting: country-US-state-california-city-losangeles-session-abc123
│   └── password is the API key: dn_live_xxxxx
├── Server extracts API key from password field
├── SHA-256 hash → O(1) database lookup
├── Verify: key exists, not revoked, user active, sufficient balance
├── Reserve 10 cents from wallet (SELECT FOR UPDATE)
├── Route traffic through PacketStream
├── Count bytes transferred
└── On connection close: settle session (compute cost, debit wallet, record usage)
```

### Refresh Token Family Rotation

```
Login → issues token T1 (family F1)
        │
T1 used for refresh → T1 revoked, T2 issued (family F1)
        │
T2 used for refresh → T2 revoked, T3 issued (family F1)
        │
If T1 is reused (stolen):
├── T1 is already revoked → REUSE DETECTED
├── Server revokes ALL tokens in family F1 (T2, T3, etc.)
└── Attacker and legitimate user both lose access
    (legitimate user must re-login, but attacker is blocked)
```

---

## Security Features

The platform has undergone 10 comprehensive security audits addressing findings across all severity levels.

### Critical Mitigations

| Finding | Mitigation |
|---------|------------|
| Token theft via XSS | httpOnly cookies for browser auth (JS cannot access tokens) |
| Refresh token replay | Family-based rotation with reuse detection; entire family revoked on reuse |
| Webhook forgery | Stripe signature verification + NOWPayments HMAC-SHA512 verification |
| DNS rebinding (SSRF) | Double-resolve with 50ms delay; block on address change between resolutions |
| Extension token persistence | `chrome.storage.session` (ephemeral; cleared when browser closes) |
| Token leakage in response body | Browser clients receive NO tokens in JSON body; tokens only via httpOnly cookies |

### High-Priority Mitigations

| Finding | Mitigation |
|---------|------------|
| Session flooding | Per-user session rate limiting (30 new sessions/minute, configurable) |
| CSRF attacks | Origin header validation on state-changing requests when auth cookies are present |
| WebRTC IP leaks | Content script sets ICE transport policy to relay-only |
| Proxy without balance | Balance pre-check + 10-cent reservation before session starts |
| Admin code in user bundle | AdminPage lazy-loaded with `React.lazy()` behind admin guard |
| Brute-force login | Account lockout after 5 failed attempts (15-minute lockout, keyed on IP+email) |
| Brute-force MFA | MFA lockout after 5 failed attempts per 5-minute window |

### Medium-Priority Mitigations

| Finding | Mitigation |
|---------|------------|
| DB connection security | SSL enforced for all non-dev/test PostgreSQL connections |
| Credential exposure in logs | PacketStream creds non-enumerable; upstream errors sanitized before logging |
| User privacy | Target hostnames redacted in proxy logs (shows TLD+1 only) |
| Error information leakage | Frontend `useApi` hook sanitizes error messages; server returns generic errors |
| Rate limit feedback | 429 responses include `Retry-After` header with remaining lockout time |
| Server-side session invalidation | `POST /api/auth/logout` revokes all refresh tokens |
| Timing attacks | `crypto.timingSafeEqual()` for secret comparison (stats endpoint auth) |
| Memory exhaustion | In-memory Maps have size caps (50k lockout entries, 10k MFA entries) |

### Low-Priority Mitigations

| Finding | Mitigation |
|---------|------------|
| Transport security | HSTS with preload directive via helmet |
| Response caching | `Cache-Control: no-store` on all API responses |
| Request tracing | UUID request ID assigned to every request |
| Token table growth | Hourly expired refresh token purge job |
| OFAC compliance | Sanctioned country blocking (Cuba, Iran, North Korea, Russia, Syria) |

---

## Geo-Targeting

Proxy requests support geographic targeting through the username field. The username is parsed for targeting directives and translated into PacketStream password suffixes.

### Username Format

```
country-US-state-california-city-losangeles-session-abc123
```

Each segment is optional. The parser extracts:
- `country`: ISO 3166-1 alpha-2 code (e.g., `US`, `GB`, `DE`)
- `state`: State/province name (e.g., `california`, `newyork`)
- `city`: City name (e.g., `losangeles`, `chicago`)
- `asn`: Autonomous System Number (e.g., `15169` for Google)
- `session`: Sticky session identifier (maintains the same exit IP across requests)

### PacketStream Translation

The targeting options are appended as suffixes to the PacketStream password:

```
PacketStream password: <base_password>_country-US_state-california_city-losangeles
```

Sticky sessions use a separate suffix that instructs PacketStream to maintain IP affinity for the session duration.

---

## Pricing Model

| Plan | Price/GB | Monthly Bandwidth | Target User |
|------|----------|-------------------|-------------|
| Free Trial | $5.00 | 100 MB | Testing/evaluation |
| Pay As You Go | $5.00 | Unlimited | Default, small-scale users |
| Volume 100GB | $4.00 | 100 GB/month | Medium-scale scrapers |
| Volume 1TB | $3.00 | 1 TB/month | Enterprise/high-volume |

**Economics**: Our cost is $1.00/GB from PacketStream. At the default $5.00/GB rate, gross margin is 80%. At the Volume 1TB rate of $3.00/GB, gross margin is 67%.

**Billing Model**: Prepaid wallet system.
1. User tops up their wallet via Stripe (fiat) or NOWPayments (crypto: BTC, ETH, XMR, SOL, ZEC).
2. Wallet balance is stored in cents (integer) with a PostgreSQL `CHECK (balance_cents >= 0)` constraint preventing negative balances at the database level.
3. Each proxy session reserves a minimum of 10 cents at start.
4. On session close, actual cost is computed from bytes transferred, the reservation is settled, and the wallet is debited.
5. Wallet debits use `SELECT FOR UPDATE` with a 5-second `lock_timeout` to prevent race conditions from concurrent session settlements and to avoid deadlocks.

---

## SDKs

Four official SDKs with consistent API surfaces across all languages.

| SDK | Package | Language | Dependencies | Requirements |
|-----|---------|----------|--------------|--------------|
| Node.js | `@dominusnode/sdk` | TypeScript | Zero external deps | Node.js 18+ |
| Python | `dominusnode` | Python | httpx | Python 3.9+ |
| C++ | `dominusnode-cpp` | C++17 | libcurl, nlohmann/json | CMake, C++17 compiler |
| Rust | `dominusnode` | Rust | reqwest, tokio | Rust stable |

**Common Features** (all SDKs):
- Automatic JWT token refresh on 401 responses
- Typed error hierarchy (AuthError, BalanceError, RateLimitError, etc.)
- Proxy URL builder with geo-targeting (country, state, city, ASN, sticky session)
- Rate limit retry with exponential backoff
- MFA support (TOTP code submission)

**SDK-Specific Notes**:
- Node.js: Dual CJS + ESM output, zero dependencies, uses native `fetch()`.
- Python: Both synchronous (`DominusNodeClient`) and asynchronous (`AsyncDominusNodeClient`) clients.
- C++: Pimpl pattern for ABI stability, thread-safe, CMake + vcpkg integration.
- Rust: Async by default with `tokio`, optional `blocking` feature flag for synchronous usage.

---

## Testing

- **1,152 total tests** across **5 test suites** via Vitest and pytest
- All 8 packages compile cleanly with TypeScript strict mode
- Extension builds successfully for all 4 target browsers
- End-to-end verified proxy flows: HTTP, HTTPS CONNECT, SOCKS5 HTTP, SOCKS5 HTTPS through PacketStream

| Suite | Tests | Files | Runner |
|-------|-------|-------|--------|
| Backend (packages/*) | 870 | 43 | Vitest |
| Frontend (React) | 61 | 10 | Vitest (jsdom) |
| Extension (Chrome) | 57 | 5 | Vitest |
| Node.js SDK | 52 | 5 | Vitest |
| Python SDK | 112 | 9 | pytest |

Test files cover all critical paths:
- Repository CRUD operations (user, wallet, usage, invoice, refresh token, MFA)
- Authentication flows (API key, JWT, refresh rotation, MFA)
- Proxy gateway (server.ts full coverage, auth parsing, balance check, session management, circuit breaker, target validation, retry logic, SOCKS5 protocol, geo-check, connection tracking, auth rate limiting, stats)
- Dashboard routes (keys, wallet, usage, plans, admin, auth middleware, proxy health, webhooks)
- Billing webhooks (Stripe signature verification, NOWPayments IPN, idempotency)
- Input validation (email, password, amounts, geo fields)
- Admin operations (user management, revenue queries)
- Frontend pages (Login, Dashboard, API Keys, Wallet, Usage, Plans, Security, Admin)
- Extension background (auth manager, proxy controller, token refresher, API client, state)
- Node.js SDK (client, HTTP layer, token manager, proxy URL builder, error hierarchy)
- Python SDK (client, auth, keys, wallet, usage, admin, proxy, errors, token manager)

---

## Environment Variables

All configuration is managed via environment variables. See `.env.example` for the complete reference.

| Category | Variables | Description |
|----------|-----------|-------------|
| Database | `DATABASE_URL` | PostgreSQL connection string |
| Auth | `JWT_SECRET`, `MFA_ENCRYPTION_KEY` | JWT signing secret, AES-256 key for TOTP secrets |
| PacketStream | `PACKETSTREAM_GATEWAY_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD`, `_RESELLER_API_URL`, `_RESELLER_API_KEY` | Upstream proxy provider credentials |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | Fiat payment processing |
| NOWPayments | `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `NOWPAYMENTS_API_URL` | Crypto payment processing |
| Proxy Ports | `PROXY_LISTEN_PORT`, `SOCKS5_LISTEN_PORT`, `DASHBOARD_PORT` | Service listening ports |
| Proxy Tunables | `PROXY_CONNECT_TIMEOUT_MS`, `PROXY_SESSION_MAX_AGE_MS`, `PROXY_STALE_CLEANUP_INTERVAL_MS`, `BALANCE_CACHE_TTL_MS`, `PROXY_MAX_RETRIES`, `PROXY_RETRY_BASE_DELAY_MS`, `PROXY_MAX_CONNECTIONS`, `PROXY_PUBLIC_HOST`, `TUNNEL_IDLE_TIMEOUT_MS` | Timeout, retry, and capacity settings |
| Circuit Breaker | `CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `CIRCUIT_BREAKER_COOLDOWN_MS` | Failure threshold and cooldown period |
| Multi-Provider | `FALLBACK_PROXY_{1-10}_HOST`, `_PORT`, `_USER`, `_PASS` | Up to 10 fallback proxy providers |
| Proxy Config | `PROXY_HOST`, `PROXY_HTTP_PORT`, `PROXY_SOCKS5_PORT` | Proxy endpoint info for extension |
| Rate Limiting | `AUTH_FAIL_MAX`, `AUTH_FAIL_WINDOW_MS`, `PROXY_MAX_PER_USER`, `MAX_SESSIONS_PER_MINUTE` | Auth and session rate limits |
| Webhook Security | `STRIPE_WEBHOOK_IPS`, `NOWPAYMENTS_WEBHOOK_IPS` | IP allowlists for webhook endpoints |
| CORS | `CORS_ORIGINS` | Comma-separated allowed origins |
| Stats | `PROXY_STATS_SECRET` | Optional Bearer secret for `/internal/stats` endpoint |
| Logging | `LOG_LEVEL` | Log verbosity (debug, info, warn, error) |

---

## Development Commands

```bash
# Setup
npm install                   # Install all workspace dependencies
docker compose up -d          # Start PostgreSQL 16
npm run db:migrate            # Apply database schema

# Build
npm run build                 # Build all packages (tsc --build with project references)
npm run clean                 # Clean all build output (dist/ directories)

# Run
npm run start:proxy           # Start proxy gateway (HTTP :8080 + SOCKS5 :1080)
npm run start:api             # Start REST API server on :3000
npm run start:frontend        # Start React dev server on :5173

# Test
npm run test                  # Run all 870 backend tests via Vitest
npm run test:frontend         # Run 61 frontend tests (React + jsdom)
npm run test:coverage         # Run tests with V8 coverage

# Code Quality
npm run lint                  # Lint all packages with ESLint
npm run format                # Format with Prettier
```

### Quick Start

```bash
docker compose up -d                    # Start PostgreSQL
npm install && npm run build            # Install deps and compile
npm run db:migrate                      # Apply schema
cp .env.example .env                    # Configure environment
# Edit .env with PacketStream, Stripe, NOWPayments credentials
npm run start:api &                     # Start REST API on :3000
npm run start:proxy &                   # Start proxy on :8080 + :1080
npm run start:frontend                  # Start frontend on :5173
```

### Proxy Usage

```bash
# After creating an account and API key via the REST API or frontend:

# HTTP proxy
curl -x http://anything:dn_live_YOUR_KEY@localhost:8080 http://httpbin.org/ip

# HTTPS proxy (CONNECT tunnel)
curl -x http://anything:dn_live_YOUR_KEY@localhost:8080 https://httpbin.org/ip

# SOCKS5 proxy
curl --socks5 localhost:1080 --proxy-user "anything:dn_live_YOUR_KEY" http://httpbin.org/ip

# With geo-targeting (US, California, Los Angeles)
curl -x http://country-US-state-california-city-losangeles:dn_live_YOUR_KEY@localhost:8080 https://httpbin.org/ip

# With sticky session
curl -x http://country-US-session-mysession123:dn_live_YOUR_KEY@localhost:8080 https://httpbin.org/ip
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API key hashing | SHA-256 (not bcrypt) | Need O(1) lookup on every proxy request. 128-bit random key entropy is sufficient for fast hash. Same approach as GitHub/Stripe API keys. |
| Wallet model | Prepaid credits in cents (integer) | No floating-point rounding errors. PostgreSQL CHECK constraint prevents negative balance at database level. |
| Wallet debit | `SELECT FOR UPDATE` with `lock_timeout 5s` | Prevents race conditions from concurrent session settlements. Lock timeout prevents deadlocks from holding row locks too long. |
| Session tracking | In-memory Map | No Redis needed for MVP. Periodic cleanup timer evicts stale sessions. Map size is bounded by `PROXY_MAX_CONNECTIONS`. |
| HTTPS tunneling | Double-CONNECT through PacketStream | Client CONNECTs to Dominus Node, Dominus Node CONNECTs to PacketStream, PacketStream CONNECTs to target. Fully opaque tunnel -- Dominus Node never sees TLS plaintext. |
| Auth tokens | httpOnly cookies (browser) + Bearer (extension) | Cookies prevent XSS token theft. Bearer tokens for extension stored in ephemeral `chrome.storage.session`. |
| Refresh tokens | Family-based rotation | Catches stolen tokens: if a revoked token is reused, the entire family is revoked, blocking both the attacker and alerting the user. |
| TOTP secrets | AES-256-GCM at rest | Encrypted with a separate key (`MFA_ENCRYPTION_KEY`). Even if the database is compromised, TOTP secrets cannot be extracted without the encryption key. |
| Crypto payments | NOWPayments | Only hosted provider supporting all 5 target cryptocurrencies (BTC, ETH, XMR, SOL, ZEC) at 0.5% fee. |
| Pricing | $5/GB (was $7/GB) | Competitive vs. Bright Data ($8.40/GB PAYG). Our cost: $1/GB from PacketStream = 80% gross margin. |
| Upstream proxy | PacketStream reseller | $1/GB cost, reseller API available, residential IPs, minimal infrastructure investment. |
| SOCKS5 to PacketStream | HTTP CONNECT over TCP | PacketStream does not support SOCKS5 natively. Dominus Node accepts SOCKS5 from clients but connects to PacketStream via HTTP CONNECT. |
