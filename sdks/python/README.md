# dominusnode -- Official Dominus Node Python SDK

The official Python SDK for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Manage proxy connections, API keys, wallet balances, usage tracking, and more.

- **Sync + Async clients** -- `DominusNodeClient` and `AsyncDominusNodeClient`
- **Single dependency** -- only requires [httpx](https://www.python-httpx.org/)
- **Full type hints** -- PEP 561 compliant, works with mypy and pyright
- **Auto token refresh** -- JWT expiry is handled transparently
- **Rate limit auto-retry** -- 429 responses are automatically retried
- **Typed error hierarchy** -- catch specific exception classes
- **Python 3.9+** compatible

## Installation

```bash
pip install dominusnode
```

```bash
poetry add dominusnode
```

**Requirements:** Python 3.9+ and httpx >= 0.24.0.

## Quick Start

### Synchronous

```python
from dominusnode import DominusNodeClient

with DominusNodeClient(base_url="https://api.dominusnode.com") as client:
    # Authenticate with API key
    client.connect_with_key("dn_live_your_api_key")

    # Check balance
    balance = client.wallet.get_balance()
    print(f"Balance: ${balance.balance_usd}")

    # Build a proxy URL
    from dominusnode import ProxyUrlOptions
    proxy_url = client.proxy.build_url(ProxyUrlOptions(
        protocol="http",
        country="US",
        state="california",
    ))
    print(proxy_url)
    # => http://country-US-state-california:dn_live_your_api_key@proxy.dominusnode.com:8080
```

### Asynchronous

```python
import asyncio
from dominusnode import AsyncDominusNodeClient

async def main():
    async with AsyncDominusNodeClient(base_url="https://api.dominusnode.com") as client:
        await client.connect_with_key("dn_live_your_api_key")

        balance = await client.wallet.get_balance()
        print(f"Balance: ${balance.balance_usd}")

        keys = await client.keys.list()
        for key in keys:
            print(f"  {key.prefix} - {key.label}")

asyncio.run(main())
```

## Authentication

Three ways to authenticate:

### 1. API Key (Recommended for Proxy Usage)

```python
with DominusNodeClient(base_url="https://api.dominusnode.com") as client:
    client.connect_with_key("dn_live_your_api_key")
```

Or pass it in the constructor for auto-connect:

```python
with DominusNodeClient(
    base_url="https://api.dominusnode.com",
    api_key="dn_live_your_api_key",
) as client:
    # Already authenticated
    balance = client.wallet.get_balance()
```

### 2. Email/Password

```python
with DominusNodeClient(base_url="https://api.dominusnode.com") as client:
    result = client.connect_with_credentials("user@example.com", "SecurePass123!")

    if result.mfa_required:
        # MFA is enabled -- complete with TOTP code
        code = input("Enter MFA code: ")
        client.complete_mfa(code)
```

### 3. Pre-existing Tokens

```python
client = DominusNodeClient(
    base_url="https://api.dominusnode.com",
    access_token="eyJhbGci...",
    refresh_token="eyJhbGci...",
)
```

## Resources

All API operations are organized into resource objects:

### Auth

```python
# Register a new account
result = client.auth.register("user@example.com", "SecurePass123!")

# Login
result = client.auth.login("user@example.com", "SecurePass123!")

# Change password
client.auth.change_password("OldPass123!", "NewPass456!")

# Logout (revokes all refresh tokens)
client.auth.logout()

# Get current user info
user = client.auth.me()
print(f"User: {user.email}, Admin: {user.is_admin}")
```

### MFA (Two-Factor Authentication)

```python
# Setup MFA
setup = client.auth.mfa_setup()
print(f"Secret: {setup.secret}")
print(f"OTPAuth URI: {setup.otpauth_uri}")
print(f"Backup codes: {setup.backup_codes}")  # Save these!

# Enable MFA (verify with a code from your authenticator app)
client.auth.mfa_enable("123456")

# Check MFA status
status = client.auth.mfa_status()
print(f"MFA enabled: {status.enabled}, Backup codes remaining: {status.backup_codes_remaining}")

# Disable MFA
client.auth.mfa_disable("SecurePass123!", "123456")
```

### API Keys

```python
# Create a new API key (the raw key is only shown once)
created = client.keys.create("my-scraper")
print(f"Key: {created.key}")  # dn_live_xxxx -- save this!
print(f"ID: {created.id}")

# List all keys
keys = client.keys.list()
for key in keys:
    print(f"  {key.prefix} ({key.label}) - created {key.created_at}")

# Revoke a key
client.keys.revoke("key-uuid-here")
```

### Wallet

```python
# Get balance
balance = client.wallet.get_balance()
print(f"Balance: ${balance.balance_usd} ({balance.balance_cents} cents)")

# Get transaction history
transactions = client.wallet.get_transactions(limit=20, offset=0)
for tx in transactions:
    print(f"  {tx.type}: {tx.amount_cents} cents - {tx.description}")

# Top up with Stripe
checkout = client.wallet.topup_stripe(amount_cents=5000)
print(f"Checkout URL: {checkout.url}")

# Top up with crypto
invoice = client.wallet.topup_crypto(amount_cents=5000, currency="btc")
print(f"Payment URL: {invoice.payment_url}")

# Get usage forecast
forecast = client.wallet.get_forecast()
```

### Usage

```python
# Get usage records
usage = client.usage.get(from_date="2026-01-01", to_date="2026-02-01", limit=50)
print(f"Total bytes: {usage.summary.total_bytes}")
print(f"Total cost: {usage.summary.total_cost_cents} cents")

# Daily breakdown
daily = client.usage.get_daily(from_date="2026-01-01", to_date="2026-02-01")
for day in daily:
    print(f"  {day.date}: {day.bytes_total} bytes, ${day.cost_cents/100:.2f}")

# Top target hosts
top_hosts = client.usage.get_top_hosts(limit=10)
for host in top_hosts:
    print(f"  {host.host}: {host.request_count} requests, {host.bytes_total} bytes")

# Export as CSV
csv_data = client.usage.export_csv(from_date="2026-01-01", to_date="2026-02-01")
with open("usage.csv", "w") as f:
    f.write(csv_data)
```

### Plans

```python
# List available plans
plans = client.plans.list()
for plan in plans:
    print(f"  {plan.id}: {plan.name} - ${plan.price_per_gb_cents/100:.2f}/GB")

# Get current plan
current = client.plans.get_user_plan()
print(f"Current plan: {current.plan_id}")

# Change plan
client.plans.change("vol100")
```

### Sessions

```python
# List active proxy sessions
sessions = client.sessions.get_active()
for session in sessions:
    print(f"  Session {session.id}: {session.bytes_total} bytes, started {session.started_at}")
```

### Proxy

```python
from dominusnode import ProxyUrlOptions

# Build an HTTP proxy URL
proxy_url = client.proxy.build_url()
print(proxy_url)
# => http://user:dn_live_xxxx@proxy.dominusnode.com:8080

# With geo-targeting
proxy_url = client.proxy.build_url(ProxyUrlOptions(
    protocol="http",
    country="US",
    state="california",
    city="losangeles",
))

# SOCKS5 proxy URL
socks_url = client.proxy.build_url(ProxyUrlOptions(
    protocol="socks5",
    country="DE",
))

# With sticky session
sticky_url = client.proxy.build_url(ProxyUrlOptions(
    country="US",
    session_id="my-session-123",
))

# Get proxy health (no auth required)
health = client.proxy.get_health()
print(f"Status: {health.status}, Active sessions: {health.active_sessions}")

# Get detailed proxy status
status = client.proxy.get_status()
for provider in status.providers:
    print(f"  {provider.name}: {provider.state}, latency: {provider.avg_latency_ms}ms")

# Get proxy configuration
config = client.proxy.get_config()
print(f"Geo-targeting: state={config.geo_targeting.state_support}, city={config.geo_targeting.city_support}")
```

### Admin (Requires Admin Privileges)

```python
# List all users
users = client.admin.list_users(limit=50, offset=0)
for user in users.users:
    print(f"  {user.email}: {user.status}, balance: {user.balance_cents} cents")

# Get user details
user_detail = client.admin.get_user("user-uuid")
print(f"Total usage: {user_detail.total_usage_bytes} bytes")

# Suspend/activate user
client.admin.suspend_user("user-uuid")
client.admin.activate_user("user-uuid")

# Get revenue stats
revenue = client.admin.get_revenue()
print(f"Total revenue: ${revenue.total_revenue_cents/100:.2f}")

# Get system stats
stats = client.admin.get_stats()
print(f"Total users: {stats.total_users}, Active sessions: {stats.active_sessions}")
```

## Using with requests/httpx

Build proxy URLs and use them with any HTTP client:

### With requests

```python
import requests
from dominusnode import DominusNodeClient, ProxyUrlOptions

with DominusNodeClient(base_url="https://api.dominusnode.com", api_key="dn_live_KEY") as client:
    proxy_url = client.proxy.build_url(ProxyUrlOptions(country="US"))

    proxies = {"http": proxy_url, "https": proxy_url}
    response = requests.get("https://httpbin.org/ip", proxies=proxies)
    print(response.json())
```

### With httpx

```python
import httpx
from dominusnode import DominusNodeClient, ProxyUrlOptions

with DominusNodeClient(base_url="https://api.dominusnode.com", api_key="dn_live_KEY") as client:
    proxy_url = client.proxy.build_url(ProxyUrlOptions(country="US"))

    with httpx.Client(proxy=proxy_url) as http:
        response = http.get("https://httpbin.org/ip")
        print(response.json())
```

### With aiohttp

```python
import aiohttp
from dominusnode import AsyncDominusNodeClient, ProxyUrlOptions

async with AsyncDominusNodeClient(base_url="https://api.dominusnode.com", api_key="dn_live_KEY") as client:
    proxy_url = client.proxy.build_url(ProxyUrlOptions(country="US"))

    async with aiohttp.ClientSession() as session:
        async with session.get("https://httpbin.org/ip", proxy=proxy_url) as resp:
            print(await resp.json())
```

## Error Handling

All SDK errors inherit from `DominusNodeError`:

```python
from dominusnode import (
    DominusNodeClient,
    DominusNodeError,
    AuthenticationError,
    AuthorizationError,
    InsufficientBalanceError,
    RateLimitError,
    ValidationError,
    NotFoundError,
    ConflictError,
    ServerError,
    NetworkError,
    ProxyError,
)

with DominusNodeClient(base_url="https://api.dominusnode.com") as client:
    try:
        client.connect_with_key("dn_live_invalid")
    except AuthenticationError:
        print("Invalid API key")
    except RateLimitError as e:
        print(f"Rate limited. Retry after {e.retry_after_seconds}s")
    except InsufficientBalanceError:
        print("Not enough balance -- top up your wallet")
    except DominusNodeError as e:
        print(f"API error: {e}")
```

| Error Class | HTTP Status | When |
|-------------|-------------|------|
| `AuthenticationError` | 401 | Invalid credentials, expired token |
| `AuthorizationError` | 403 | Insufficient permissions (e.g., non-admin) |
| `InsufficientBalanceError` | 402 | Wallet balance too low |
| `RateLimitError` | 429 | Too many requests |
| `ValidationError` | 400 | Invalid input |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Duplicate resource |
| `ServerError` | 500+ | Server-side error |
| `NetworkError` | -- | Connection failure, timeout |
| `ProxyError` | -- | Proxy URL building error |

## Configuration

```python
client = DominusNodeClient(
    base_url="https://api.dominusnode.com",  # API server URL
    proxy_host="proxy.dominusnode.com",       # Proxy gateway hostname
    http_proxy_port=8080,                 # HTTP proxy port
    socks5_proxy_port=1080,               # SOCKS5 proxy port
    timeout=30.0,                         # HTTP request timeout (seconds)
)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run tests with async support
pytest --asyncio-mode=auto

# Type checking
mypy dominusnode/
```

## License

MIT
