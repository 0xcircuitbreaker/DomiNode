# @dominusnode/sdk -- Official Dominus Node Node.js SDK

The official Node.js/TypeScript SDK for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Manage proxy connections, API keys, wallet balances, usage tracking, and more -- all from a single, strongly-typed client.

- **Zero dependencies** -- uses the Node.js 18+ built-in `fetch` API
- **Dual CJS + ESM output** -- works with `require()` and `import` out of the box
- **Full TypeScript support** -- every request and response is fully typed
- **Auto token refresh** -- JWT expiry is handled transparently via base64 decode (no crypto dependency)
- **Rate limit auto-retry** -- 429 responses are automatically retried after the server-specified delay
- **Typed error hierarchy** -- catch specific error classes instead of parsing status codes

## Installation

```bash
npm install @dominusnode/sdk
```

```bash
yarn add @dominusnode/sdk
```

```bash
pnpm add @dominusnode/sdk
```

**Requirements:** Node.js 18.0.0 or later (uses built-in `fetch`).

## Quick Start

```typescript
import { DominusNodeClient } from '@dominusnode/sdk';

// Connect with API key
const client = new DominusNodeClient({ baseUrl: 'https://api.dominusnode.com' });
await client.connectWithKey('dn_live_your_api_key');

// Check balance
const balance = await client.wallet.getBalance();
console.log(`Balance: $${balance.balanceUsd}`);

// Build proxy URL
const proxyUrl = client.proxy.buildUrl('dn_live_your_key', {
  protocol: 'http',
  country: 'US',
  state: 'california',
  city: 'losangeles',
});
console.log(proxyUrl);
// => http://user-country-US-state-california-city-losangeles:dn_live_your_key@proxy.dominusnode.com:8080
```

## Authentication

The SDK supports three authentication modes. All authenticated requests automatically include a Bearer token, and expired tokens are refreshed transparently.

### API Key

Best for server-side scripts and backend integrations. The key is exchanged for a JWT token pair on the first call.

```typescript
const client = new DominusNodeClient({ baseUrl: 'https://api.dominusnode.com' });
await client.connectWithKey('dn_live_your_api_key');
```

### Email + Password

Best for interactive applications where the user logs in with credentials. Supports MFA (TOTP or backup codes).

```typescript
const client = new DominusNodeClient({ baseUrl: 'https://api.dominusnode.com' });
const result = await client.connectWithCredentials('user@example.com', 'SecurePass123!');

if (result.mfaRequired) {
  // User has 2FA enabled -- need TOTP code
  await client.completeMfa('123456');
}
```

### Pre-authenticated

Use when you already have valid JWT tokens (e.g., stored from a previous session).

```typescript
const client = new DominusNodeClient({
  baseUrl: 'https://api.dominusnode.com',
  accessToken: 'existing_jwt',
  refreshToken: 'existing_refresh_token',
});
```

### Disconnecting

Clear all stored tokens locally. Call `client.auth.logout()` first if you also want to revoke refresh tokens server-side.

```typescript
await client.auth.logout();  // Revoke server-side refresh tokens
client.disconnect();          // Clear local token state
```

## Configuration

```typescript
interface DominusNodeConfig {
  baseUrl?: string;           // Default: 'https://api.dominusnode.com'
  accessToken?: string;       // Pre-existing access token
  refreshToken?: string;      // Pre-existing refresh token
  proxyHost?: string;         // Default: 'proxy.dominusnode.com'
  httpProxyPort?: number;     // Default: 8080
  socks5ProxyPort?: number;   // Default: 1080
}
```

All fields are optional. The defaults point to the Dominus Node production endpoints.

## Resources

The `DominusNodeClient` exposes eight resource modules, each grouping related API operations.

### Auth

Registration, login, MFA management, password changes, and session introspection.

```typescript
// Register a new account
const { user } = await client.auth.register('user@example.com', 'SecurePass123!');

// Login (returns token + user, or mfaRequired flag)
const result = await client.auth.login('user@example.com', 'SecurePass123!');

// MFA verify with TOTP code
await client.auth.verifyMfa('123456');

// MFA verify with backup code
await client.auth.verifyMfa('12345678', { isBackupCode: true });

// MFA setup -- returns secret, otpauthUri, and backup codes
const setup = await client.auth.mfaSetup();
// setup.secret, setup.otpauthUri, setup.backupCodes

// MFA enable (confirm with a valid TOTP code)
await client.auth.mfaEnable('123456');

// MFA disable (requires current password + TOTP code)
await client.auth.mfaDisable('password', '123456');

// MFA status
const status = await client.auth.mfaStatus();
// status.enabled, status.backupCodesRemaining

// Change password
await client.auth.changePassword('oldpass', 'newpass');

// Logout (revokes refresh tokens server-side)
await client.auth.logout();

// Session info (get current user from the JWT)
const me = await client.auth.me();
// me.user.id, me.user.email, me.user.is_admin
```

### Keys

Create, list, and revoke API keys. API keys use the `dn_live_` prefix and are authenticated via SHA-256 hash for fast O(1) lookup.

```typescript
// Create a new API key
const key = await client.keys.create('my-scraper');
// key.key is the full API key (dn_live_xxx) -- shown only once, save it!
// key.id, key.prefix, key.label, key.created_at

// List all API keys (raw key is never returned after creation)
const keys = await client.keys.list();
// keys.keys[0].id, .prefix, .label, .created_at, .revoked_at

// Revoke an API key by ID
await client.keys.revoke('key-id');
```

### Wallet

Check balances, view transaction history, top up via Stripe or cryptocurrency, and get spending forecasts.

```typescript
// Get current balance
const balance = await client.wallet.getBalance();
// balance.balanceCents  -- integer cents (e.g., 1050)
// balance.balanceUsd    -- decimal USD (e.g., 10.50)
// balance.currency      -- "USD"
// balance.lastToppedUp  -- ISO timestamp or null

// Transaction history (paginated)
const txs = await client.wallet.getTransactions({ limit: 50, offset: 0 });
// txs.transactions[0].type        -- "topup" | "debit" | "refund"
// txs.transactions[0].amountCents -- integer cents
// txs.transactions[0].amountUsd   -- decimal USD
// txs.transactions[0].description
// txs.transactions[0].createdAt

// Top up with Stripe (amount in cents)
const checkout = await client.wallet.topUpStripe(1000); // $10.00
// checkout.url       -- redirect user to this Stripe Checkout URL
// checkout.sessionId -- Stripe session ID

// Top up with crypto (amount in cents, currency code)
const invoice = await client.wallet.topUpCrypto(1000, 'btc');
// invoice.invoiceId   -- NOWPayments invoice ID
// invoice.invoiceUrl  -- redirect user to pay
// invoice.payCurrency -- e.g., "btc"
// invoice.priceAmount -- amount in USD

// Spending forecast
const forecast = await client.wallet.getForecast();
// forecast.dailyAvgCents  -- average daily spend
// forecast.daysRemaining  -- estimated days until balance runs out (null if no usage)
// forecast.trend          -- "up" | "down" | "stable"
// forecast.trendPct       -- percentage change
```

### Usage

Query usage records, daily breakdowns, top hosts, and export data as CSV.

```typescript
// Usage records with summary (paginated, filterable by date)
const usage = await client.usage.get({ from: '2024-01-01', to: '2024-01-31', limit: 100 });
// usage.summary.totalBytes, .totalCostCents, .requestCount, .totalGB, .totalCostUsd
// usage.records[0].bytesIn, .bytesOut, .totalBytes, .costCents, .targetHost, .createdAt
// usage.pagination.limit, .offset, .total
// usage.period.since, .until

// Daily breakdown (for charts)
const daily = await client.usage.getDaily({ from: '2024-01-01', to: '2024-01-31' });
// daily.days[0].date, .totalBytes, .totalGB, .totalCostCents, .totalCostUsd, .requestCount

// Top target hosts by bandwidth
const hosts = await client.usage.getTopHosts({ limit: 10 });
// hosts.hosts[0].targetHost, .totalBytes, .totalGB, .requestCount

// CSV export
const csv = await client.usage.exportCsv({ from: '2024-01-01', to: '2024-01-31' });
// csv is a raw CSV string
```

### Plans

List available pricing plans, view the current user's plan, and change plans.

```typescript
// List all available plans (no auth required)
const plans = await client.plans.list();
// plans.plans[0].id, .name, .pricePerGbCents, .pricePerGbUsd,
//   .monthlyBandwidthBytes, .monthlyBandwidthGB, .isDefault

// Get the current user's plan and monthly usage
const plan = await client.plans.getUserPlan();
// plan.plan         -- the PlanEntry object
// plan.usage.monthlyUsageBytes, .monthlyUsageGB, .limitBytes, .limitGB, .percentUsed

// Change plan
const result = await client.plans.changePlan('vol100');
// result.message, result.plan
```

### Sessions

View active proxy sessions for the authenticated user.

```typescript
// Get all active proxy sessions
const sessions = await client.sessions.getActive();
// sessions.sessions[0].id, .startedAt, .status
```

### Proxy

Build proxy URLs for direct use with HTTP clients, and query proxy health/status/config.

```typescript
// Build a basic HTTP proxy URL (no network call -- pure string construction)
const httpUrl = client.proxy.buildUrl('dn_live_key');
// => http://user:dn_live_key@proxy.dominusnode.com:8080

// Build a SOCKS5 proxy URL
const socksUrl = client.proxy.buildUrl('dn_live_key', { protocol: 'socks5' });
// => socks5://user:dn_live_key@proxy.dominusnode.com:1080

// Geo-targeted with sticky session
const geoUrl = client.proxy.buildUrl('dn_live_key', {
  country: 'US',
  state: 'california',
  city: 'losangeles',
  sessionId: 'sticky123',
});
// => http://user-country-US-state-california-city-losangeles-session-sticky123:dn_live_key@proxy.dominusnode.com:8080

// ASN targeting
const asnUrl = client.proxy.buildUrl('dn_live_key', { asn: 7922 });
// => http://user-asn-7922:dn_live_key@proxy.dominusnode.com:8080

// Proxy health (no auth required)
const health = await client.proxy.getHealth();
// health.status, .activeSessions, .uptimeSeconds

// Proxy status (auth required -- includes provider info)
const status = await client.proxy.getStatus();
// status.providers[0].name, .state, .consecutiveFailures, .avgLatencyMs
// status.endpoints.http, .endpoints.socks5
// status.supportedCountries

// Proxy config (auth required)
const config = await client.proxy.getConfig();
// config.httpProxy, .socks5Proxy, .supportedCountries, .blockedCountries, .geoTargeting
```

### Admin (requires admin privileges)

User management, revenue analytics, and system statistics. All endpoints require the authenticated user to have `is_admin: true`.

```typescript
// List users (paginated)
const users = await client.admin.listUsers({ page: 1, limit: 25 });
// users.users[0].id, .email, .status, .is_admin, .created_at, .balance_cents
// users.pagination.page, .limit, .total, .totalPages

// Get a specific user
const user = await client.admin.getUser('user-id');
// user.user.id, .email, .status, ...

// Suspend a user account
await client.admin.suspendUser('user-id');

// Reactivate a suspended user
await client.admin.activateUser('user-id');

// Soft-delete a user account
await client.admin.deleteUser('user-id');

// Revenue statistics (filterable by date range)
const revenue = await client.admin.getRevenue({ since: '2024-01-01', until: '2024-01-31' });
// revenue.totalRevenueCents, .totalRevenueUsd, .avgTransactionCents, .transactionCount

// Daily revenue breakdown
const daily = await client.admin.getDailyRevenue({ since: '2024-01-01', until: '2024-01-31' });
// daily.days[0].date, .revenueCents, .revenueUsd

// System-wide statistics
const stats = await client.admin.getStats();
// stats.active_sessions, .total_users, .total_bandwidth_bytes
```

## Error Handling

The SDK throws typed error classes instead of generic errors. Every error extends `DominusNodeError`, which itself extends the built-in `Error` class.

```typescript
import {
  DominusNodeClient,
  AuthenticationError,
  InsufficientBalanceError,
  RateLimitError,
  ValidationError,
  NotFoundError,
} from '@dominusnode/sdk';

try {
  await client.wallet.getBalance();
} catch (err) {
  if (err instanceof AuthenticationError) {
    // 401 -- not authenticated or token refresh failed
    console.error('Not authenticated -- login or provide API key');
  } else if (err instanceof InsufficientBalanceError) {
    // 402 -- wallet balance too low
    console.error('Wallet balance too low -- top up first');
  } else if (err instanceof RateLimitError) {
    // 429 -- rate limited (SDK already retried once automatically)
    console.error(`Rate limited -- retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof ValidationError) {
    // 400 -- invalid request parameters
    console.error(`Invalid input: ${err.message}`);
  } else if (err instanceof NotFoundError) {
    // 404 -- resource not found
    console.error(`Not found: ${err.message}`);
  }
}
```

### Error Hierarchy

All errors include a `statusCode` property (when applicable) and a descriptive `message`.

| Error Class | HTTP Status | Description |
|---|---|---|
| `DominusNodeError` | (varies) | Base class for all SDK errors |
| `AuthenticationError` | 401 | Invalid credentials or expired/revoked tokens |
| `AuthorizationError` | 403 | Insufficient permissions (e.g., non-admin accessing admin routes) |
| `InsufficientBalanceError` | 402 | Wallet balance too low for the operation |
| `RateLimitError` | 429 | Too many requests -- has `retryAfterSeconds` property |
| `ValidationError` | 400 | Invalid request parameters |
| `NotFoundError` | 404 | Requested resource does not exist |
| `ConflictError` | 409 | Resource conflict (e.g., duplicate email registration) |
| `ServerError` | 500+ | Server-side error |
| `NetworkError` | -- | Connection failure, DNS resolution error, or timeout |
| `ProxyError` | -- | Proxy-specific error -- has optional `proxyErrorCode` property |

## Using the Proxy URL

The `proxy.buildUrl()` method returns a standard proxy URL string that works with any HTTP client that supports proxy configuration.

### With undici (ProxyAgent)

```typescript
import { DominusNodeClient } from '@dominusnode/sdk';
import { ProxyAgent } from 'undici';

const client = new DominusNodeClient({ baseUrl: 'https://api.dominusnode.com' });
await client.connectWithKey('dn_live_key');

const proxyUrl = client.proxy.buildUrl('dn_live_key', { country: 'US' });
const agent = new ProxyAgent(proxyUrl);

const response = await fetch('http://httpbin.org/ip', { dispatcher: agent });
const data = await response.json();
console.log(data.origin); // US IP address
```

### With curl (command line)

```bash
curl -x http://user:dn_live_your_key@proxy.dominusnode.com:8080 http://httpbin.org/ip
curl -x http://user:dn_live_your_key@proxy.dominusnode.com:8080 https://httpbin.org/ip
```

### With axios

```typescript
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = client.proxy.buildUrl('dn_live_key', { country: 'DE' });
const agent = new HttpsProxyAgent(proxyUrl);

const { data } = await axios.get('https://httpbin.org/ip', { httpsAgent: agent });
console.log(data.origin); // German IP address
```

### Geo-Targeting Options

The proxy URL username field encodes geo-targeting and session parameters using the format `user-param_value-param_value`:

| Option | Type | Description | Example |
|---|---|---|---|
| `protocol` | `"http"` or `"socks5"` | Proxy protocol (default: `"http"`) | `{ protocol: 'socks5' }` |
| `country` | `string` | ISO 3166-1 alpha-2 country code | `{ country: 'US' }` |
| `state` | `string` | State or region name | `{ state: 'california' }` |
| `city` | `string` | City name (no spaces) | `{ city: 'losangeles' }` |
| `asn` | `number` | Autonomous System Number | `{ asn: 7922 }` |
| `sessionId` | `string` | Sticky session identifier | `{ sessionId: 'abc123' }` |

## Auto Token Refresh

The SDK automatically manages JWT token lifecycle. You do not need to handle token refresh manually.

The token refresh flow works as follows:

1. Before each request, the SDK checks the access token's `exp` claim (decoded from base64, no crypto library needed).
2. If the token expires within 60 seconds, the SDK proactively refreshes it using the stored refresh token.
3. If a request returns 401, the SDK force-refreshes the token and retries the request once.
4. Concurrent requests that trigger refresh are deduplicated -- only one refresh call is made.
5. If the refresh token itself is expired or revoked, an `AuthenticationError` is thrown and all stored tokens are cleared.

## TypeScript Support

All types are exported from the package. Use `import type` for type-only imports:

```typescript
import type {
  // Core types
  User,
  ApiKey,
  Wallet,
  WalletTransaction,
  UsageRecord,
  TopHost,
  Plan,
  ActiveSession,
  ProxyUrlOptions,
  ProxyHealth,
  ProxyConfig,
  StripeCheckout,
  CryptoInvoice,
  AdminUser,
  RevenueStats,
  DailyRevenue,
  SystemStats,
  MfaStatus,
  MfaSetup,
  LoginResult,
  TokenPair,

  // Config
  DominusNodeConfig,

  // Response types
  WalletBalanceResponse,
  TransactionsResponse,
  StripeCheckoutResponse,
  CryptoInvoiceResponse,
  ForecastResponse,
  UsageSummary,
  UsageResponse,
  DailyUsageDay,
  DailyUsageResponse,
  TopHostEntry,
  TopHostsResponse,
  PlanEntry,
  ListPlansResponse,
  UserPlanResponse,
  ChangePlanResponse,
  ActiveSessionEntry,
  ActiveSessionsResponse,
  CreateKeyResponse,
  ListKeysResponse,
  ProxyHealthResponse,
  ProxyStatusResponse,
  ListUsersResponse,
  GetUserResponse,
  RevenueResponse,
  DailyRevenueEntry,
  DailyRevenueResponse,
} from '@dominusnode/sdk';
```

## CommonJS Usage

The SDK ships dual CJS + ESM builds. CommonJS usage works with `require()`:

```javascript
const { DominusNodeClient } = require('@dominusnode/sdk');

async function main() {
  const client = new DominusNodeClient({ baseUrl: 'https://api.dominusnode.com' });
  await client.connectWithKey('dn_live_your_key');

  const balance = await client.wallet.getBalance();
  console.log(`Balance: $${balance.balanceUsd}`);
}

main().catch(console.error);
```

## Complete Example

```typescript
import { DominusNodeClient, AuthenticationError, InsufficientBalanceError } from '@dominusnode/sdk';

async function main() {
  // Initialize client
  const client = new DominusNodeClient({
    baseUrl: 'https://api.dominusnode.com',
    proxyHost: 'proxy.dominusnode.com',
    httpProxyPort: 8080,
    socks5ProxyPort: 1080,
  });

  try {
    // Authenticate
    await client.connectWithKey('dn_live_your_api_key');

    // Check who we are
    const { user } = await client.auth.me();
    console.log(`Logged in as: ${user.email}`);

    // Check balance
    const balance = await client.wallet.getBalance();
    console.log(`Balance: $${balance.balanceUsd} (${balance.balanceCents} cents)`);

    // If balance is low, create a Stripe checkout
    if (balance.balanceCents < 500) {
      const checkout = await client.wallet.topUpStripe(2000); // $20.00
      console.log(`Top up here: ${checkout.url}`);
    }

    // List API keys
    const { keys } = await client.keys.list();
    console.log(`You have ${keys.length} API key(s)`);

    // Check current plan
    const plan = await client.plans.getUserPlan();
    console.log(`Plan: ${plan.plan.name} ($${plan.plan.pricePerGbUsd}/GB)`);
    if (plan.usage.percentUsed !== null) {
      console.log(`Monthly usage: ${plan.usage.percentUsed.toFixed(1)}%`);
    }

    // Get usage stats for this month
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const usage = await client.usage.get({ from: firstOfMonth });
    console.log(`This month: ${usage.summary.totalGB.toFixed(2)} GB, $${usage.summary.totalCostUsd}`);

    // Build a geo-targeted proxy URL
    const proxyUrl = client.proxy.buildUrl('dn_live_your_api_key', {
      country: 'US',
      state: 'california',
    });
    console.log(`Proxy URL: ${proxyUrl}`);

    // Check active sessions
    const sessions = await client.sessions.getActive();
    console.log(`Active sessions: ${sessions.sessions.length}`);

  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error('Authentication failed:', err.message);
    } else if (err instanceof InsufficientBalanceError) {
      console.error('Insufficient balance:', err.message);
    } else {
      throw err;
    }
  } finally {
    client.disconnect();
  }
}

main();
```

## API Reference Summary

| Resource | Method | Description |
|---|---|---|
| `auth` | `register(email, password)` | Create a new account |
| `auth` | `login(email, password)` | Login with credentials |
| `auth` | `verifyMfa(code, opts?)` | Complete MFA verification |
| `auth` | `mfaSetup()` | Begin MFA setup (returns secret + backup codes) |
| `auth` | `mfaEnable(code)` | Confirm and enable MFA |
| `auth` | `mfaDisable(password, code)` | Disable MFA |
| `auth` | `mfaStatus()` | Check MFA status |
| `auth` | `changePassword(current, new)` | Change password |
| `auth` | `logout()` | Revoke refresh tokens server-side |
| `auth` | `me()` | Get current user info |
| `auth` | `verifyKey(apiKey)` | Exchange API key for JWT tokens |
| `auth` | `refresh(refreshToken)` | Refresh access token (used internally) |
| `keys` | `create(label?)` | Create a new API key |
| `keys` | `list()` | List all API keys |
| `keys` | `revoke(id)` | Revoke an API key |
| `wallet` | `getBalance()` | Get current balance |
| `wallet` | `getTransactions(opts?)` | Transaction history (paginated) |
| `wallet` | `topUpStripe(amountCents)` | Create Stripe checkout session |
| `wallet` | `topUpCrypto(amountCents, currency)` | Create crypto invoice |
| `wallet` | `getForecast()` | Spending forecast |
| `usage` | `get(opts?)` | Usage records with summary |
| `usage` | `getDaily(opts?)` | Daily usage aggregation |
| `usage` | `getTopHosts(opts?)` | Top target hosts by bandwidth |
| `usage` | `exportCsv(opts?)` | Export usage as CSV |
| `plans` | `list()` | List available plans |
| `plans` | `getUserPlan()` | Get current user's plan |
| `plans` | `changePlan(planId)` | Change plan |
| `sessions` | `getActive()` | Get active proxy sessions |
| `proxy` | `buildUrl(apiKey, opts?)` | Build proxy URL string (no network call) |
| `proxy` | `getHealth()` | Proxy health (no auth) |
| `proxy` | `getStatus()` | Proxy status with provider info |
| `proxy` | `getConfig()` | Proxy configuration |
| `admin` | `listUsers(opts?)` | List all users (paginated) |
| `admin` | `getUser(id)` | Get user details |
| `admin` | `suspendUser(id)` | Suspend a user |
| `admin` | `activateUser(id)` | Reactivate a user |
| `admin` | `deleteUser(id)` | Soft-delete a user |
| `admin` | `getRevenue(opts?)` | Revenue statistics |
| `admin` | `getDailyRevenue(opts?)` | Daily revenue breakdown |
| `admin` | `getStats()` | System-wide statistics |

## Requirements

- **Node.js 18+** (uses built-in `fetch` -- no polyfill needed)
- **No external dependencies** -- the SDK has zero production dependencies

## License

MIT
