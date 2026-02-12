# dominode -- Official DomiNode Rust SDK

The official Rust SDK for the [DomiNode](https://dominode.io) rotating proxy-as-a-service platform. Manage proxy connections, API keys, wallet balances, usage tracking, and more from Rust applications.

- **Async by default** -- powered by Tokio and reqwest
- **Strongly typed** -- every request and response has a dedicated type
- **Auto token refresh** -- JWT expiry handled transparently with async mutex
- **Rate limit auto-retry** -- 429 responses automatically retried with backoff
- **Typed error hierarchy** -- pattern-match on specific error variants
- **URL-safe** -- all proxy URL components are percent-encoded (RFC 3986)

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
dominode = "1.0"
tokio = { version = "1", features = ["full"] }
```

### Feature Flags

| Feature | Default | Description |
|---------|---------|-------------|
| `async` | Yes | Async API using Tokio |
| `blocking` | No | Marker for future sync wrapper |

## Quick Start

```rust
use dominode::{DomiNodeClient, Config};

#[tokio::main]
async fn main() -> dominode::Result<()> {
    // Create client with default config
    let client = DomiNodeClient::new(Config {
        base_url: "https://api.dominode.io".into(),
        ..Config::default()
    })?;

    // Authenticate with API key
    client.connect_with_key("dn_live_your_api_key").await?;

    // Check wallet balance
    let balance = client.wallet.get_balance().await?;
    println!("Balance: {} cents", balance.balance_cents);

    // Build a proxy URL
    let proxy_url = client.proxy.build_url("dn_live_your_api_key", None);
    println!("Proxy URL: {}", proxy_url);
    // => http://user:dn_live_your_api_key@proxy.dominode.io:8080

    Ok(())
}
```

## Authentication

### API Key (Recommended for Proxy Usage)

```rust
let client = DomiNodeClient::new(Config::default())?;
client.connect_with_key("dn_live_your_api_key").await?;
```

Or provide in the config:

```rust
let client = DomiNodeClient::new(Config {
    base_url: "https://api.dominode.io".into(),
    api_key: Some("dn_live_your_api_key".into()),
    ..Config::default()
})?;
// Note: API key auth happens lazily on first authenticated request
```

### Email/Password

```rust
let client = DomiNodeClient::new(Config::default())?;
let result = client.connect_with_credentials("user@example.com", "SecurePass123!").await?;

if result.mfa_required {
    // MFA enabled -- complete with TOTP code
    client.complete_mfa("123456", None, false).await?;
}
```

### Pre-existing Tokens

```rust
let client = DomiNodeClient::new(Config {
    access_token: Some("eyJhbGci...".into()),
    refresh_token: Some("eyJhbGci...".into()),
    ..Config::default()
})?;
```

## Resources

All API operations are accessed through public resource fields on the client.

### Auth

```rust
// Register
let result = client.auth.register("user@example.com", "SecurePass123!").await?;

// Login
let result = client.auth.login("user@example.com", "SecurePass123!").await?;

// Change password
client.auth.change_password("OldPass123!", "NewPass456!").await?;

// Logout (revokes all refresh tokens)
client.auth.logout().await?;

// Get current user
let user = client.auth.me().await?;
println!("User: {}, Admin: {}", user.email, user.is_admin);
```

### MFA

```rust
// Setup MFA
let setup = client.auth.mfa_setup().await?;
println!("Secret: {}", setup.secret);
println!("OTPAuth URI: {}", setup.otpauth_uri);
println!("Backup codes: {:?}", setup.backup_codes); // Save these!

// Enable MFA
client.auth.mfa_enable("123456").await?;

// Check status
let status = client.auth.mfa_status().await?;
println!("Enabled: {}, Backup codes: {}", status.enabled, status.backup_codes_remaining);

// Disable MFA
client.auth.mfa_disable("password", "123456").await?;
```

### API Keys

```rust
// Create key (raw key only shown once)
let created = client.keys.create("my-scraper").await?;
println!("Key: {}", created.key); // dn_live_xxxx -- save this!

// List keys
let keys = client.keys.list().await?;
for key in &keys {
    println!("  {} - {}", key.prefix, key.label);
}

// Revoke
client.keys.revoke("key-uuid").await?;
```

### Wallet

```rust
// Balance
let balance = client.wallet.get_balance().await?;
println!("Balance: {} cents (${:.2})", balance.balance_cents, balance.balance_cents as f64 / 100.0);

// Transactions
let txs = client.wallet.get_transactions(Some(20), Some(0)).await?;
for tx in &txs {
    println!("  {}: {} cents - {}", tx.tx_type, tx.amount_cents, tx.description);
}

// Stripe top-up
let checkout = client.wallet.topup_stripe(5000).await?;
println!("Checkout URL: {}", checkout.url);

// Crypto top-up
let invoice = client.wallet.topup_crypto(5000, "btc").await?;
```

### Usage

```rust
// Usage records
let usage = client.usage.get(Some("2026-01-01"), Some("2026-02-01"), Some(50), Some(0)).await?;

// Daily breakdown
let daily = client.usage.get_daily(Some("2026-01-01"), Some("2026-02-01")).await?;
for day in &daily {
    println!("  {}: {} bytes", day.date, day.bytes_total);
}

// Top hosts
let hosts = client.usage.get_top_hosts(Some(10)).await?;
for host in &hosts {
    println!("  {}: {} bytes", host.host, host.bytes_total);
}

// CSV export
let csv = client.usage.export_csv(Some("2026-01-01"), Some("2026-02-01")).await?;
```

### Plans

```rust
// List plans
let plans = client.plans.list().await?;
for plan in &plans {
    println!("  {}: {} - {} cents/GB", plan.id, plan.name, plan.price_per_gb_cents);
}

// Current plan
let current = client.plans.get_user_plan().await?;

// Change plan
client.plans.change("vol100").await?;
```

### Sessions

```rust
let sessions = client.sessions.get_active().await?;
for session in &sessions {
    println!("  Session {}: {} bytes", session.id, session.bytes_total);
}
```

### Proxy

```rust
use dominode::types::ProxyUrlOptions;

// Default proxy URL
let url = client.proxy.build_url("dn_live_key", None);

// With geo-targeting
let opts = ProxyUrlOptions {
    protocol: Some("http".into()),
    country: Some("US".into()),
    state: Some("california".into()),
    city: Some("losangeles".into()),
    ..Default::default()
};
let geo_url = client.proxy.build_url("dn_live_key", Some(&opts));

// SOCKS5
let socks_opts = ProxyUrlOptions {
    protocol: Some("socks5".into()),
    country: Some("DE".into()),
    ..Default::default()
};
let socks_url = client.proxy.build_url("dn_live_key", Some(&socks_opts));

// Sticky session
let sticky_opts = ProxyUrlOptions {
    country: Some("US".into()),
    session_id: Some("my-session-123".into()),
    ..Default::default()
};
let sticky_url = client.proxy.build_url("dn_live_key", Some(&sticky_opts));

// Health check (no auth)
let health = client.proxy.get_health().await?;
println!("Status: {}, Sessions: {}", health.status, health.active_sessions);

// Detailed status
let status = client.proxy.get_status().await?;

// Configuration
let config = client.proxy.get_config().await?;
```

### Admin

```rust
// List users
let users = client.admin.list_users(Some(50), Some(0)).await?;

// User detail
let detail = client.admin.get_user("user-uuid").await?;

// Suspend/activate
client.admin.suspend_user("user-uuid").await?;
client.admin.activate_user("user-uuid").await?;

// Revenue
let revenue = client.admin.get_revenue(None, None).await?;
println!("Total: {} cents", revenue.total_revenue_cents);

// System stats
let stats = client.admin.get_stats().await?;
println!("Users: {}, Active sessions: {}", stats.total_users, stats.active_sessions);
```

## Using Proxy URLs with reqwest

```rust
use dominode::{DomiNodeClient, Config};
use dominode::types::ProxyUrlOptions;
use reqwest::Proxy;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = DomiNodeClient::new(Config::default())?;
    client.connect_with_key("dn_live_your_key").await?;

    // Build proxy URL with geo-targeting
    let opts = ProxyUrlOptions {
        country: Some("US".into()),
        ..Default::default()
    };
    let proxy_url = client.proxy.build_url("dn_live_your_key", Some(&opts));

    // Use with reqwest
    let http_client = reqwest::Client::builder()
        .proxy(Proxy::all(&proxy_url)?)
        .build()?;

    let resp = http_client.get("https://httpbin.org/ip").send().await?;
    println!("{}", resp.text().await?);

    Ok(())
}
```

## Error Handling

All errors are variants of `DomiNodeError`, implementing `std::error::Error` via `thiserror`:

```rust
use dominode::DomiNodeError;

match client.connect_with_key("dn_live_invalid").await {
    Ok(_) => println!("Connected!"),
    Err(DomiNodeError::Authentication(msg)) => {
        eprintln!("Invalid API key: {}", msg);
    }
    Err(DomiNodeError::RateLimit { retry_after_secs, .. }) => {
        eprintln!("Rate limited, retry after {}s", retry_after_secs);
    }
    Err(DomiNodeError::InsufficientBalance(msg)) => {
        eprintln!("Low balance: {}", msg);
    }
    Err(e) => eprintln!("Error: {}", e),
}
```

| Variant | HTTP Status | When |
|---------|-------------|------|
| `Authentication` | 401 | Invalid credentials |
| `Authorization` | 403 | Insufficient permissions |
| `InsufficientBalance` | 402 | Low wallet balance |
| `RateLimit` | 429 | Rate limit exceeded |
| `Validation` | 400 | Invalid input |
| `NotFound` | 404 | Resource not found |
| `Conflict` | 409 | Duplicate resource |
| `Server` | 500+ | Server error |
| `Network` | -- | Connection/timeout failure |
| `Proxy` | -- | Proxy URL building error |

## Configuration

```rust
use dominode::Config;

let config = Config {
    base_url: "https://api.dominode.io".into(),
    api_key: None,
    access_token: None,
    refresh_token: None,
    proxy_host: "proxy.dominode.io".into(),
    http_proxy_port: 8080,
    socks5_proxy_port: 1080,
};
```

All fields have sensible defaults via `Config::default()`.

## Security Notes

- **Token storage**: Tokens are stored in memory only (never written to disk)
- **Token refresh**: Uses `tokio::sync::Mutex` to prevent concurrent refresh races
- **URL encoding**: API keys and geo-targeting values are percent-encoded (RFC 3986)
- **TLS**: reqwest verifies TLS certificates by default
- **Force refresh**: On 401, the SDK forces a token refresh (bypasses expiry check) to handle stale-but-not-expired tokens

## License

MIT
