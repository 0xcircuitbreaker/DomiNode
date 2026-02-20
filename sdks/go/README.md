# dominusnode-go -- Official Dominus Node Go SDK

The official Go SDK for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Manage proxy connections, API keys, wallet balances, usage tracking, teams, agentic wallets, and more -- all from a single, idiomatic Go client.

- **Zero dependencies** -- uses only the Go standard library
- **Context-aware** -- every method accepts `context.Context` for cancellation and deadlines
- **Auto token refresh** -- JWT expiry is handled transparently before each request
- **Rate limit auto-retry** -- 429 responses are automatically retried with jitter
- **Typed error hierarchy** -- use `errors.As` to match specific error types instead of parsing status codes
- **Credential safety** -- tokens and keys are redacted in `fmt.Stringer` output to prevent log leakage

## Installation

```bash
go get github.com/dominusnode/dominusnode-go
```

**Requirements:** Go 1.22 or later.

## Quick Start

### API Key Authentication

Best for server-side scripts and backend integrations. The key is exchanged for a JWT token pair on the first call.

```go
package main

import (
    "context"
    "fmt"
    "log"

    dominusnode "github.com/dominusnode/dominusnode-go"
)

func main() {
    client := dominusnode.NewClient(dominusnode.Config{
        BaseURL: "https://api.dominusnode.com",
    })
    defer client.Disconnect()

    ctx := context.Background()

    // Authenticate with API key
    if err := client.ConnectWithKey(ctx, "dn_live_your_api_key"); err != nil {
        log.Fatal(err)
    }

    // Check balance
    balance, err := client.Wallet.GetBalance(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Balance: $%.2f\n", balance.BalanceUSD)

    // Build a proxy URL
    proxyURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
        Country: "US",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(proxyURL)
    // => http://user-country_US:dn_live_your_api_key@proxy.dominusnode.com:8080
}
```

### Email + Password Authentication

Best for interactive applications where users log in with credentials. Supports MFA (TOTP or backup codes).

```go
client := dominusnode.NewClient(dominusnode.Config{
    BaseURL: "https://api.dominusnode.com",
})
defer client.Disconnect()

ctx := context.Background()

result, err := client.ConnectWithCredentials(ctx, "user@example.com", "SecurePass123!")
if err != nil {
    log.Fatal(err)
}

if result.MFARequired {
    // User has 2FA enabled -- provide TOTP code
    if err := client.CompleteMFA(ctx, "123456"); err != nil {
        log.Fatal(err)
    }
}

// Client is now authenticated
balance, _ := client.Wallet.GetBalance(ctx)
fmt.Printf("Balance: $%.2f\n", balance.BalanceUSD)
```

### MFA with Backup Code

```go
if result.MFARequired {
    err := client.CompleteMFA(ctx, "12345678",
        dominusnode.WithBackupCode(true),
        dominusnode.WithMFAChallengeToken(result.MFAChallengeToken),
    )
    if err != nil {
        log.Fatal(err)
    }
}
```

### Pre-authenticated

Use when you already have valid JWT tokens (e.g., stored from a previous session).

```go
client := dominusnode.NewClient(dominusnode.Config{
    BaseURL:      "https://api.dominusnode.com",
    AccessToken:  "existing_jwt",
    RefreshToken: "existing_refresh_token",
})
```

### Disconnecting

`Disconnect` revokes refresh tokens server-side (best effort) and clears all local credentials.

```go
client.Disconnect()
```

## Configuration

```go
type Config struct {
    BaseURL         string         // Default: "https://api.dominusnode.com"
    APIKey          string         // API key for immediate authentication
    Email           string         // Email for credential-based auth
    Password        string         // Password for credential-based auth
    AccessToken     string         // Pre-existing JWT access token
    RefreshToken    string         // Pre-existing JWT refresh token
    ProxyHost       string         // Default: "proxy.dominusnode.com"
    HTTPProxyPort   int            // Default: 8080
    SOCKS5ProxyPort int            // Default: 1080
    Timeout         time.Duration  // Default: 30s
    HTTPClient      *http.Client   // Optional custom HTTP client
}
```

All fields are optional. Defaults point to the Dominus Node production endpoints. Credential fields (`APIKey`, `Email`, `Password`, `AccessToken`, `RefreshToken`) are tagged with `json:"-"` to prevent accidental serialization.

The `Config` type implements `fmt.Stringer` and `fmt.GoStringer` with redacted credential values, so it is safe to pass to log statements.

## Resources

The `Client` exposes eleven resource modules as public fields, each grouping related API operations.

### Auth

Registration, login, MFA management, password changes, and session introspection.

```go
// Register a new account (auto-authenticates on success)
result, err := client.Auth.Register(ctx, "user@example.com", "SecurePass123!")

// Login with credentials
result, err := client.Auth.Login(ctx, "user@example.com", "SecurePass123!")

// Verify MFA with TOTP code
loginResult, err := client.Auth.VerifyMFA(ctx, "123456")

// Verify MFA with backup code
loginResult, err := client.Auth.VerifyMFA(ctx, "12345678",
    dominusnode.WithBackupCode(true),
)

// Verify API key (exchanges for JWT tokens)
verifyResult, err := client.Auth.VerifyKey(ctx, "dn_live_your_key")

// Refresh tokens (typically called automatically)
tokenPair, err := client.Auth.Refresh(ctx, refreshToken)

// Get current user info
user, err := client.Auth.Me(ctx)
// user.ID, user.Email, user.IsAdmin

// MFA setup -- returns secret, otpauth URI, and backup codes
setup, err := client.Auth.MFASetup(ctx)
// setup.Secret, setup.OTPAuthURI, setup.BackupCodes

// Enable MFA (confirm with a valid TOTP code)
err = client.Auth.MFAEnable(ctx, "123456")

// Disable MFA (requires password + TOTP code)
err = client.Auth.MFADisable(ctx, "password", "123456")

// Check MFA status
status, err := client.Auth.MFAStatus(ctx)
// status.Enabled, status.BackupCodesRemaining

// Change password
err = client.Auth.ChangePassword(ctx, "oldpass", "newpass")

// Logout (revokes refresh tokens server-side)
err = client.Auth.Logout(ctx)
```

### Keys

Create, list, and revoke API keys. Keys use the `dn_live_` prefix and are authenticated via SHA-256 hash for fast O(1) lookup.

```go
// Create a new API key (raw key shown only once)
key, err := client.Keys.Create(ctx, "my-scraper")
// key.Key   -- the full API key (dn_live_xxx), save it!
// key.ID, key.Prefix, key.Label, key.CreatedAt

// List all API keys (raw key is never returned after creation)
keys, err := client.Keys.List(ctx)
// keys[0].ID, .Prefix, .Label, .CreatedAt, .RevokedAt

// Revoke an API key by ID
err = client.Keys.Revoke(ctx, "key-id")
```

### Wallet

Check balances, view transaction history, top up via Stripe or cryptocurrency, and get spending forecasts.

```go
// Get current balance
balance, err := client.Wallet.GetBalance(ctx)
// balance.BalanceCents  -- integer cents (e.g., 1050)
// balance.BalanceUSD    -- float64 USD (e.g., 10.50)
// balance.Currency      -- "USD"
// balance.LastToppedUp  -- *string, ISO timestamp or nil

// Transaction history (paginated)
limit := 50
offset := 0
txs, err := client.Wallet.GetTransactions(ctx, &dominusnode.TransactionOptions{
    Limit:  &limit,
    Offset: &offset,
})
// txs[0].Type, .AmountCents, .AmountUSD, .Description, .CreatedAt

// Top up with Stripe (amount in cents)
checkout, err := client.Wallet.TopupStripe(ctx, 1000) // $10.00
// checkout.URL       -- redirect user to this Stripe Checkout URL
// checkout.SessionID -- Stripe session ID

// Top up with crypto (amount in USD, currency code)
invoice, err := client.Wallet.TopupCrypto(ctx, 10.00, "btc")
// invoice.InvoiceID, .InvoiceURL, .PayCurrency, .PriceAmount

// Spending forecast
forecast, err := client.Wallet.GetForecast(ctx)
// forecast.DailyAvgCents, .DaysRemaining, .Trend, .TrendPct
```

### Usage

Query usage records, daily breakdowns, top hosts, and export data as CSV.

```go
// Usage records with summary (paginated, filterable by date)
limit := 100
usage, err := client.Usage.Get(ctx, &dominusnode.UsageOptions{
    From:  "2024-01-01",
    To:    "2024-01-31",
    Limit: &limit,
})
// usage.Summary.TotalBytes, .TotalCostCents, .RequestCount, .TotalGB, .TotalCostUSD
// usage.Records[0].BytesIn, .BytesOut, .TotalBytes, .CostCents, .TargetHost, .CreatedAt
// usage.Pagination.Limit, .Offset, .Total
// usage.Period.Since, .Until

// Daily breakdown (for charts)
daily, err := client.Usage.GetDaily(ctx, &dominusnode.DateRangeOptions{
    From: "2024-01-01",
    To:   "2024-01-31",
})
// daily.Days[0].Date, .TotalBytes, .TotalGB, .TotalCostCents, .TotalCostUSD, .RequestCount

// Top target hosts by bandwidth
topLimit := 10
hosts, err := client.Usage.GetTopHosts(ctx, &dominusnode.TopHostsOptions{
    Limit: &topLimit,
})
// hosts.Hosts[0].TargetHost, .TotalBytes, .TotalGB, .RequestCount

// CSV export
csv, err := client.Usage.ExportCSV(ctx, &dominusnode.DateRangeOptions{
    From: "2024-01-01",
    To:   "2024-01-31",
})
// csv is a raw CSV string
```

### Plans

List available pricing plans, view the current user's plan, and change plans.

```go
// List all available plans (no auth required)
plans, err := client.Plans.List(ctx)
// plans[0].ID, .Name, .PricePerGBCents, .PricePerGBUSD,
//   .MonthlyBandwidthBytes, .MonthlyBandwidthGB, .IsDefault

// Get the current user's plan and monthly usage
info, err := client.Plans.GetUserPlan(ctx)
// info.Plan         -- the Plan object
// info.Usage.MonthlyUsageBytes, .MonthlyUsageGB, .LimitBytes, .LimitGB, .PercentUsed

// Change plan
result, err := client.Plans.ChangePlan(ctx, "vol100")
// result.Message, result.Plan
```

### Sessions

View active proxy sessions for the authenticated user.

```go
sessions, err := client.Sessions.GetActive(ctx)
// sessions[0].ID, .StartedAt, .Status
```

### Proxy

Build proxy URLs for direct use with HTTP clients, and query proxy health/status/config.

```go
// Build a basic HTTP proxy URL (no network call -- pure string construction)
httpURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{})
// => "http://user:dn_live_key@proxy.dominusnode.com:8080"

// Build a SOCKS5 proxy URL
socksURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
    Protocol: "socks5",
})
// => "socks5://user:dn_live_key@proxy.dominusnode.com:1080"

// Geo-targeted with sticky session
geoURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
    Country:   "US",
    State:     "california",
    City:      "losangeles",
    SessionID: "sticky123",
})
// => "http://user-country_US-state_california-city_losangeles-session_sticky123:dn_live_key@proxy.dominusnode.com:8080"

// ASN targeting
asnURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{ASN: 7922})
// => "http://user-asn_7922:dn_live_key@proxy.dominusnode.com:8080"

// Proxy health (no auth required)
health, err := client.Proxy.GetHealth(ctx)
// health.Status, .ActiveSessions, .UptimeSeconds

// Proxy status (auth required -- includes provider info)
status, err := client.Proxy.GetStatus(ctx)
// status.Providers[0].Name, .State, .ConsecutiveFailures, .AvgLatencyMs
// status.Endpoints.HTTP, .Endpoints.SOCKS5
// status.SupportedCountries

// Proxy config (auth required)
config, err := client.Proxy.GetConfig(ctx)
// config.HTTPProxy, .SOCKS5Proxy, .SupportedCountries, .BlockedCountries, .GeoTargeting
```

### Slots

Check registration slot availability and join the waitlist. All methods are public (no authentication required).

```go
// Check slot availability
slots, err := client.Slots.GetSlots(ctx)
// slots.Total, .Used, .Remaining, .Unlimited

// Join the waitlist
result, err := client.Slots.JoinWaitlist(ctx, "user@example.com")
// result.Message

// Get waitlist count
count, err := client.Slots.GetWaitlistCount(ctx)
// count.Pending
```

### Admin (requires admin privileges)

User management, revenue analytics, and system statistics. All methods require the authenticated user to have admin privileges.

```go
// List users (paginated)
page := 1
limit := 25
users, err := client.Admin.ListUsers(ctx, &dominusnode.AdminListOptions{
    Page:  &page,
    Limit: &limit,
})
// users.Users[0].ID, .Email, .Status, .IsAdmin, .CreatedAt, .BalanceCents
// users.Pagination.Page, .Limit, .Total, .TotalPages

// Get a specific user
user, err := client.Admin.GetUser(ctx, "user-id")
// user.User.ID, .Email, .Status

// Suspend a user account
err = client.Admin.SuspendUser(ctx, "user-id")

// Reactivate a suspended user
err = client.Admin.ActivateUser(ctx, "user-id")

// Soft-delete a user account
err = client.Admin.DeleteUser(ctx, "user-id")

// Revenue statistics (filterable by date range)
revenue, err := client.Admin.GetRevenue(ctx, &dominusnode.AdminDateRangeOptions{
    Since: "2024-01-01",
    Until: "2024-01-31",
})
// revenue.TotalRevenueCents, .TotalRevenueUSD, .AvgTransactionCents, .TransactionCount

// Daily revenue breakdown
daily, err := client.Admin.GetDailyRevenue(ctx, &dominusnode.AdminDateRangeOptions{
    Since: "2024-01-01",
    Until: "2024-01-31",
})
// daily.Days[0].Date, .RevenueCents, .RevenueUSD

// System-wide statistics
stats, err := client.Admin.GetStats(ctx)
// stats.ActiveSessions, .TotalUsers, .TotalBandwidthBytes
```

## Agentic Wallets

Agentic wallets are server-side custodial sub-wallets with per-transaction spending limits. They allow AI agents or automated systems to spend from a controlled budget without direct access to the main wallet.

```go
// Create an agentic wallet with a $5.00 spending limit per transaction
wallet, err := client.AgenticWallets.Create(ctx, "scraper-agent", 500)
// wallet.ID, .Label, .BalanceCents, .SpendingLimitCents, .Status, .CreatedAt

// List all agentic wallets
list, err := client.AgenticWallets.List(ctx)
// list.Wallets[0].ID, .Label, .BalanceCents, .Status

// Get a single agentic wallet
wallet, err = client.AgenticWallets.Get(ctx, "wallet-id")

// Fund from main wallet (amount in cents)
fundResult, err := client.AgenticWallets.Fund(ctx, "wallet-id", 1000) // $10.00
// fundResult.Transaction.ID, .AmountCents, .Description

// Get transaction history
txs, err := client.AgenticWallets.Transactions(ctx, "wallet-id", 50, 0)
// txs.Transactions[0].ID, .Type, .AmountCents, .Description, .CreatedAt

// Freeze a wallet (prevents spending)
wallet, err = client.AgenticWallets.Freeze(ctx, "wallet-id")

// Unfreeze a wallet (allows spending again)
wallet, err = client.AgenticWallets.Unfreeze(ctx, "wallet-id")

// Delete a wallet (refunds remaining balance to main wallet)
deleteResult, err := client.AgenticWallets.Delete(ctx, "wallet-id")
// deleteResult.Deleted, .RefundedCents
```

## Teams

Teams enable shared wallet billing with role-based access (owner, admin, member). Team API keys bill usage to the team wallet instead of individual user wallets.

```go
// Create a team
team, err := client.Teams.Create(ctx, "Engineering Team", 10)
// team.ID, .Name, .OwnerID, .MaxMembers, .BalanceCents, .CreatedAt

// List teams the current user belongs to
teams, err := client.Teams.List(ctx)
// teams[0].ID, .Name, .OwnerID

// Get team details
team, err = client.Teams.Get(ctx, "team-id")

// Update team settings
team, err = client.Teams.Update(ctx, "team-id", map[string]interface{}{
    "name":       "Updated Team Name",
    "maxMembers": 20,
})

// Fund team wallet from your main wallet (amount in cents)
fundResult, err := client.Teams.FundWallet(ctx, "team-id", 5000) // $50.00
// fundResult.Transaction.ID, .AmountCents

// Get team wallet transactions
txs, err := client.Teams.GetTransactions(ctx, "team-id", 50, 0)
// txs.Transactions[0].ID, .Type, .AmountCents, .Description

// List team members
members, err := client.Teams.ListMembers(ctx, "team-id")
// members.Members[0].UserID, .Email, .Role, .JoinedAt

// Add a member
member, err := client.Teams.AddMember(ctx, "team-id", "new@example.com", "member")

// Update a member's role
member, err = client.Teams.UpdateMemberRole(ctx, "team-id", "user-id", "admin")

// Remove a member
err = client.Teams.RemoveMember(ctx, "team-id", "user-id")

// Create a team invite
invite, err := client.Teams.CreateInvite(ctx, "team-id", "invited@example.com", "member")
// invite.ID, .Token, .ExpiresAt

// List pending invites
invites, err := client.Teams.ListInvites(ctx, "team-id")

// Cancel an invite
err = client.Teams.CancelInvite(ctx, "team-id", "invite-id")

// Accept an invite (using the invite token)
member, err = client.Teams.AcceptInvite(ctx, "invite-token")

// Create a team API key (bills to team wallet)
teamKey, err := client.Teams.CreateKey(ctx, "team-id", "team-scraper")
// teamKey.ID, .Key, .KeyPrefix, .Label

// List team API keys
keys, err := client.Teams.ListKeys(ctx, "team-id")
// keys.Keys[0].ID, .KeyPrefix, .Label

// Revoke a team API key
err = client.Teams.RevokeKey(ctx, "team-id", "key-id")

// Delete a team (refunds remaining wallet balance)
deleteResult, err := client.Teams.Delete(ctx, "team-id")
// deleteResult.RefundedCents
```

## Proxy URL Building

The `Proxy.BuildURL` method returns a standard proxy URL string that works with any HTTP client supporting proxy configuration. It does not make any network calls.

### Geo-Targeting Options

The proxy URL username field encodes geo-targeting and session parameters using the format `user-param_value-param_value`:

| Option | Type | Description | Example |
|---|---|---|---|
| `Protocol` | `string` | Proxy protocol: `"http"` or `"socks5"` (default: `"http"`) | `ProxyURLOptions{Protocol: "socks5"}` |
| `Country` | `string` | ISO 3166-1 alpha-2 country code | `ProxyURLOptions{Country: "US"}` |
| `State` | `string` | State or region name | `ProxyURLOptions{State: "california"}` |
| `City` | `string` | City name (no spaces) | `ProxyURLOptions{City: "losangeles"}` |
| `ASN` | `int` | Autonomous System Number | `ProxyURLOptions{ASN: 7922}` |
| `SessionID` | `string` | Sticky session identifier | `ProxyURLOptions{SessionID: "abc123"}` |

### Using with net/http

```go
import (
    "net/http"
    "net/url"
)

proxyStr, _ := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{Country: "US"})
proxyURL, _ := url.Parse(proxyStr)

httpClient := &http.Client{
    Transport: &http.Transport{
        Proxy: http.ProxyURL(proxyURL),
    },
}

resp, err := httpClient.Get("http://httpbin.org/ip")
```

### With curl (command line)

```bash
curl -x http://user:dn_live_your_key@proxy.dominusnode.com:8080 http://httpbin.org/ip
curl -x socks5://user:dn_live_your_key@proxy.dominusnode.com:1080 http://httpbin.org/ip
```

## Error Handling

The SDK returns typed error structs instead of generic errors. All error types embed `DominusNodeError`, which implements the standard `error` interface and supports `errors.As` / `errors.Is` unwrapping.

```go
import (
    "errors"
    "fmt"

    dominusnode "github.com/dominusnode/dominusnode-go"
)

balance, err := client.Wallet.GetBalance(ctx)
if err != nil {
    var authErr *dominusnode.AuthenticationError
    var balanceErr *dominusnode.InsufficientBalanceError
    var rateLimitErr *dominusnode.RateLimitError
    var validationErr *dominusnode.ValidationError
    var notFoundErr *dominusnode.NotFoundError

    switch {
    case errors.As(err, &authErr):
        // 401 -- not authenticated or token refresh failed
        fmt.Println("Not authenticated:", authErr.Message)
    case errors.As(err, &balanceErr):
        // 402 -- wallet balance too low
        fmt.Println("Insufficient balance:", balanceErr.Message)
    case errors.As(err, &rateLimitErr):
        // 429 -- rate limited (SDK already retried once)
        fmt.Printf("Rate limited, retry after %v\n", rateLimitErr.RetryAfter)
    case errors.As(err, &validationErr):
        // 400 -- invalid request parameters
        fmt.Println("Validation error:", validationErr.Message)
    case errors.As(err, &notFoundErr):
        // 404 -- resource not found
        fmt.Println("Not found:", notFoundErr.Message)
    default:
        fmt.Println("Error:", err)
    }
    return
}
```

### Error Type Reference

All errors include a `StatusCode` field (HTTP status code, or 0 if not applicable) and a `Message` field.

| Error Type | HTTP Status | Description |
|---|---|---|
| `*DominusNodeError` | (varies) | Base type for all SDK errors |
| `*AuthenticationError` | 401 | Invalid credentials or expired/revoked tokens |
| `*AuthorizationError` | 403 | Insufficient permissions (e.g., non-admin accessing admin routes) |
| `*InsufficientBalanceError` | 402 | Wallet balance too low for the operation |
| `*RateLimitError` | 429 | Too many requests; has `RetryAfter` (`time.Duration`) field |
| `*ValidationError` | 400 | Invalid request parameters |
| `*NotFoundError` | 404 | Requested resource does not exist |
| `*ConflictError` | 409 | Resource conflict (e.g., duplicate email registration) |
| `*ServerError` | 500+ | Server-side error |
| `*NetworkError` | -- | Connection failure, DNS resolution error, or timeout |
| `*ProxyError` | -- | Proxy-specific error (e.g., no API key set when building URL) |

## Auto Token Refresh

The SDK automatically manages JWT token lifecycle. You do not need to handle token refresh manually.

1. Before each authenticated request, the SDK checks the access token's `exp` claim.
2. If the token expires within 60 seconds, the SDK proactively refreshes it using the stored refresh token.
3. If a request returns 401, the SDK force-refreshes the token and retries the request once.
4. Concurrent requests that trigger refresh are deduplicated -- only one refresh call is made.
5. If the refresh token itself is expired or revoked, an `AuthenticationError` is returned and all stored tokens are cleared.

## Complete Example

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"

    dominusnode "github.com/dominusnode/dominusnode-go"
)

func main() {
    client := dominusnode.NewClient(dominusnode.Config{
        BaseURL:         "https://api.dominusnode.com",
        ProxyHost:       "proxy.dominusnode.com",
        HTTPProxyPort:   8080,
        SOCKS5ProxyPort: 1080,
    })
    defer client.Disconnect()

    ctx := context.Background()

    // Authenticate
    if err := client.ConnectWithKey(ctx, "dn_live_your_api_key"); err != nil {
        log.Fatal(err)
    }

    // Check who we are
    user, err := client.Auth.Me(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Logged in as: %s\n", user.Email)

    // Check balance
    balance, err := client.Wallet.GetBalance(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Balance: $%.2f (%d cents)\n", balance.BalanceUSD, balance.BalanceCents)

    // If balance is low, create a Stripe checkout
    if balance.BalanceCents < 500 {
        checkout, err := client.Wallet.TopupStripe(ctx, 2000) // $20.00
        if err != nil {
            log.Fatal(err)
        }
        fmt.Printf("Top up here: %s\n", checkout.URL)
    }

    // List API keys
    keys, err := client.Keys.List(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("You have %d API key(s)\n", len(keys))

    // Check current plan
    planInfo, err := client.Plans.GetUserPlan(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Plan: %s ($%.2f/GB)\n", planInfo.Plan.Name, planInfo.Plan.PricePerGBUSD)

    // Get usage stats
    usage, err := client.Usage.Get(ctx, &dominusnode.UsageOptions{
        From: "2024-01-01",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Usage: %.2f GB, $%.2f\n", usage.Summary.TotalGB, usage.Summary.TotalCostUSD)

    // Build a geo-targeted proxy URL
    proxyURL, err := client.Proxy.BuildURL(dominusnode.ProxyURLOptions{
        Country: "US",
        State:   "california",
    })
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Proxy URL: %s\n", proxyURL)

    // Check active sessions
    sessions, err := client.Sessions.GetActive(ctx)
    if err != nil {
        var authErr *dominusnode.AuthenticationError
        if errors.As(err, &authErr) {
            fmt.Println("Session check requires auth")
        }
    } else {
        fmt.Printf("Active sessions: %d\n", len(sessions))
    }
}
```

## API Reference Summary

| Resource | Method | Description |
|---|---|---|
| `Auth` | `Register(ctx, email, password)` | Create a new account |
| `Auth` | `Login(ctx, email, password)` | Login with credentials |
| `Auth` | `VerifyMFA(ctx, code, opts...)` | Complete MFA verification |
| `Auth` | `VerifyKey(ctx, apiKey)` | Exchange API key for JWT tokens |
| `Auth` | `Refresh(ctx, refreshToken)` | Refresh access token (used internally) |
| `Auth` | `Me(ctx)` | Get current user info |
| `Auth` | `MFASetup(ctx)` | Begin MFA setup (returns secret + backup codes) |
| `Auth` | `MFAEnable(ctx, code)` | Confirm and enable MFA |
| `Auth` | `MFADisable(ctx, password, code)` | Disable MFA |
| `Auth` | `MFAStatus(ctx)` | Check MFA status |
| `Auth` | `ChangePassword(ctx, current, new)` | Change password |
| `Auth` | `Logout(ctx)` | Revoke refresh tokens server-side |
| `Keys` | `Create(ctx, label)` | Create a new API key |
| `Keys` | `List(ctx)` | List all API keys |
| `Keys` | `Revoke(ctx, id)` | Revoke an API key |
| `Wallet` | `GetBalance(ctx)` | Get current balance |
| `Wallet` | `GetTransactions(ctx, opts)` | Transaction history (paginated) |
| `Wallet` | `TopupStripe(ctx, amountCents)` | Create Stripe checkout session |
| `Wallet` | `TopupCrypto(ctx, amountUSD, currency)` | Create crypto invoice |
| `Wallet` | `GetForecast(ctx)` | Spending forecast |
| `Usage` | `Get(ctx, opts)` | Usage records with summary |
| `Usage` | `GetDaily(ctx, opts)` | Daily usage aggregation |
| `Usage` | `GetTopHosts(ctx, opts)` | Top target hosts by bandwidth |
| `Usage` | `ExportCSV(ctx, opts)` | Export usage as CSV string |
| `Plans` | `List(ctx)` | List available plans |
| `Plans` | `GetUserPlan(ctx)` | Get current user's plan and usage |
| `Plans` | `ChangePlan(ctx, planID)` | Change plan |
| `Sessions` | `GetActive(ctx)` | Get active proxy sessions |
| `Proxy` | `BuildURL(opts)` | Build proxy URL string (no network call) |
| `Proxy` | `GetHealth(ctx)` | Proxy health (no auth) |
| `Proxy` | `GetStatus(ctx)` | Proxy status with provider info |
| `Proxy` | `GetConfig(ctx)` | Proxy configuration |
| `Slots` | `GetSlots(ctx)` | Check registration slot availability |
| `Slots` | `JoinWaitlist(ctx, email)` | Join the waitlist |
| `Slots` | `GetWaitlistCount(ctx)` | Get waitlist count |
| `AgenticWallets` | `Create(ctx, label, spendingLimitCents)` | Create an agentic wallet |
| `AgenticWallets` | `List(ctx)` | List all agentic wallets |
| `AgenticWallets` | `Get(ctx, walletID)` | Get a single agentic wallet |
| `AgenticWallets` | `Fund(ctx, walletID, amountCents)` | Fund from main wallet |
| `AgenticWallets` | `Transactions(ctx, walletID, limit, offset)` | Transaction history |
| `AgenticWallets` | `Freeze(ctx, walletID)` | Freeze wallet (stop spending) |
| `AgenticWallets` | `Unfreeze(ctx, walletID)` | Unfreeze wallet |
| `AgenticWallets` | `Delete(ctx, walletID)` | Delete wallet (refunds balance) |
| `Teams` | `Create(ctx, name, maxMembers)` | Create a team |
| `Teams` | `List(ctx)` | List user's teams |
| `Teams` | `Get(ctx, teamID)` | Get team details |
| `Teams` | `Update(ctx, teamID, updates)` | Update team settings |
| `Teams` | `Delete(ctx, teamID)` | Delete team (refunds balance) |
| `Teams` | `FundWallet(ctx, teamID, amountCents)` | Fund team wallet |
| `Teams` | `GetTransactions(ctx, teamID, limit, offset)` | Team wallet transactions |
| `Teams` | `ListMembers(ctx, teamID)` | List team members |
| `Teams` | `AddMember(ctx, teamID, email, role)` | Add a team member |
| `Teams` | `UpdateMemberRole(ctx, teamID, userID, role)` | Update member role |
| `Teams` | `RemoveMember(ctx, teamID, userID)` | Remove a team member |
| `Teams` | `CreateInvite(ctx, teamID, email, role)` | Create a team invite |
| `Teams` | `ListInvites(ctx, teamID)` | List pending invites |
| `Teams` | `CancelInvite(ctx, teamID, inviteID)` | Cancel a pending invite |
| `Teams` | `AcceptInvite(ctx, token)` | Accept an invite |
| `Teams` | `CreateKey(ctx, teamID, label)` | Create a team API key |
| `Teams` | `ListKeys(ctx, teamID)` | List team API keys |
| `Teams` | `RevokeKey(ctx, teamID, keyID)` | Revoke a team API key |
| `Admin` | `ListUsers(ctx, opts)` | List all users (paginated) |
| `Admin` | `GetUser(ctx, id)` | Get user details |
| `Admin` | `SuspendUser(ctx, id)` | Suspend a user |
| `Admin` | `ActivateUser(ctx, id)` | Reactivate a user |
| `Admin` | `DeleteUser(ctx, id)` | Soft-delete a user |
| `Admin` | `GetRevenue(ctx, opts)` | Revenue statistics |
| `Admin` | `GetDailyRevenue(ctx, opts)` | Daily revenue breakdown |
| `Admin` | `GetStats(ctx)` | System-wide statistics |

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-feature`).
3. Write tests for your changes.
4. Ensure all tests pass: `go test ./...`
5. Ensure code is formatted: `gofmt -s -w .`
6. Ensure linting passes: `go vet ./...`
7. Commit your changes and open a pull request.

## License

MIT
