# dominusnode-cpp -- Official Dominus Node C++ SDK

The official C++ SDK for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Manage proxy connections, API keys, wallet balances, usage tracking, and more from C++ applications.

- **C++17** standard
- **Pimpl pattern** for ABI stability
- **Thread-safe** -- mutex-protected CURL handle and token refresh
- **Secure memory** -- `explicit_bzero` on token memory before deallocation
- **HTTPS by default** -- HTTP only allowed for localhost development
- **Auto token refresh** -- JWT expiry handled transparently
- **Typed error hierarchy** -- catch specific exception types

## Dependencies

- [libcurl](https://curl.se/libcurl/) -- HTTP client
- [nlohmann/json](https://github.com/nlohmann/json) (>= 3.11) -- JSON parsing
- CMake >= 3.14

## Building

### With CMake

```bash
mkdir build && cd build
cmake ..
cmake --build .
```

### With vcpkg

```bash
# Install dependencies
vcpkg install curl nlohmann-json

# Build with vcpkg toolchain
mkdir build && cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=/path/to/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build .
```

### Running Tests

```bash
cd build
ctest --output-on-failure
```

## Quick Start

```cpp
#include <dominusnode/dominusnode.hpp>
#include <iostream>

int main() {
    // Configure the client
    dominusnode::ClientConfig config;
    config.base_url = "https://api.dominusnode.com";

    // Create the client
    dominusnode::DominusNodeClient client(config);

    // Authenticate with API key
    client.connect_with_key("dn_live_your_api_key");

    // Check balance
    auto balance = client.wallet().get_balance();
    std::cout << "Balance: " << balance.balance_cents << " cents" << std::endl;

    // Build a proxy URL
    dominusnode::ProxyUrlOptions opts;
    opts.protocol = "http";
    opts.country = "US";
    opts.state = "california";

    std::string proxy_url = client.proxy().build_url("dn_live_your_api_key", opts);
    std::cout << "Proxy URL: " << proxy_url << std::endl;
    // => http://user-country_US-state_california:dn_live_your_api_key@proxy.dominusnode.com:8080

    return 0;
}
```

## Authentication

### API Key

```cpp
dominusnode::DominusNodeClient client(config);
client.connect_with_key("dn_live_your_api_key");
```

Or provide in the config for auto-connect:

```cpp
dominusnode::ClientConfig config;
config.base_url = "https://api.dominusnode.com";
config.api_key = "dn_live_your_api_key";

dominusnode::DominusNodeClient client(config);
// Already authenticated
```

### Email/Password

```cpp
dominusnode::DominusNodeClient client(config);
client.connect_with_credentials("user@example.com", "SecurePass123!");
```

### Pre-existing Tokens

```cpp
dominusnode::ClientConfig config;
config.access_token = "eyJhbGci...";
config.refresh_token = "eyJhbGci...";

dominusnode::DominusNodeClient client(config);
```

## Resources

All API operations are accessed through resource accessor methods on the client.

### Auth

```cpp
// Register
auto result = client.auth().register_user("user@example.com", "SecurePass123!");

// Login
auto result = client.auth().login("user@example.com", "SecurePass123!");

// Change password
client.auth().change_password("OldPass123!", "NewPass456!");

// Logout
client.auth().logout();

// Get current user
auto user = client.auth().me();
std::cout << "Email: " << user.email << std::endl;
```

### MFA

```cpp
// Setup MFA
auto setup = client.auth().mfa_setup();
std::cout << "Secret: " << setup.secret << std::endl;
std::cout << "URI: " << setup.otpauth_uri << std::endl;

// Enable MFA with TOTP code
client.auth().mfa_enable("123456");

// Check status
auto status = client.auth().mfa_status();
std::cout << "Enabled: " << status.enabled << std::endl;

// Disable MFA
client.auth().mfa_disable("password", "123456");
```

### API Keys

```cpp
// Create key
auto created = client.keys().create("my-scraper");
std::cout << "Key: " << created.key << std::endl;  // Save this!

// List keys
auto keys = client.keys().list();
for (const auto& key : keys) {
    std::cout << key.prefix << " - " << key.label << std::endl;
}

// Revoke key
client.keys().revoke("key-uuid");
```

### Wallet

```cpp
// Get balance
auto balance = client.wallet().get_balance();
std::cout << "Balance: $" << (balance.balance_cents / 100.0) << std::endl;

// Get transactions
auto txs = client.wallet().get_transactions(20, 0);
for (const auto& tx : txs) {
    std::cout << tx.type << ": " << tx.amount_cents << " cents" << std::endl;
}

// Top up with Stripe
auto checkout = client.wallet().topup_stripe(5000);
std::cout << "Checkout URL: " << checkout.url << std::endl;

// Top up with crypto
auto invoice = client.wallet().topup_crypto(5000, "btc");
```

### Usage

```cpp
// Get usage records
auto usage = client.usage().get("2026-01-01", "2026-02-01", 50, 0);

// Daily breakdown
auto daily = client.usage().get_daily("2026-01-01", "2026-02-01");

// Top hosts
auto hosts = client.usage().get_top_hosts(10);
for (const auto& host : hosts) {
    std::cout << host.host << ": " << host.bytes_total << " bytes" << std::endl;
}

// CSV export
auto csv = client.usage().export_csv("2026-01-01", "2026-02-01");
```

### Plans

```cpp
// List plans
auto plans = client.plans().list();
for (const auto& plan : plans) {
    std::cout << plan.id << ": " << plan.name << " - "
              << plan.price_per_gb_cents << " cents/GB" << std::endl;
}

// Get current plan
auto current = client.plans().get_user_plan();

// Change plan
client.plans().change("vol100");
```

### Sessions

```cpp
auto sessions = client.sessions().get_active();
for (const auto& session : sessions) {
    std::cout << "Session " << session.id << ": "
              << session.bytes_total << " bytes" << std::endl;
}
```

### Proxy

```cpp
// Build proxy URL (default settings)
auto url = client.proxy().build_url("dn_live_your_key");

// With geo-targeting
dominusnode::ProxyUrlOptions opts;
opts.protocol = "http";
opts.country = "US";
opts.state = "california";
opts.city = "losangeles";
auto geo_url = client.proxy().build_url("dn_live_your_key", opts);

// SOCKS5
dominusnode::ProxyUrlOptions socks_opts;
socks_opts.protocol = "socks5";
socks_opts.country = "DE";
auto socks_url = client.proxy().build_url("dn_live_your_key", socks_opts);

// Sticky session
dominusnode::ProxyUrlOptions sticky_opts;
sticky_opts.country = "US";
sticky_opts.session_id = "my-session-123";
auto sticky_url = client.proxy().build_url("dn_live_your_key", sticky_opts);

// Health check
auto health = client.proxy().get_health();
std::cout << "Status: " << health.status << std::endl;

// Detailed status
auto status = client.proxy().get_status();
for (const auto& p : status.providers) {
    std::cout << p.name << ": " << p.state << std::endl;
}

// Configuration
auto config = client.proxy().get_config();
```

### Admin

```cpp
// List users
auto users = client.admin().list_users(50, 0);

// Get user detail
auto detail = client.admin().get_user("user-uuid");

// Suspend/activate
client.admin().suspend_user("user-uuid");
client.admin().activate_user("user-uuid");

// Revenue
auto revenue = client.admin().get_revenue();
std::cout << "Total: " << revenue.total_revenue_cents << " cents" << std::endl;

// System stats
auto stats = client.admin().get_stats();
std::cout << "Users: " << stats.total_users << std::endl;
```

## Using Proxy URLs with libcurl

```cpp
#include <dominusnode/dominusnode.hpp>
#include <curl/curl.h>
#include <iostream>
#include <string>

size_t write_callback(void* ptr, size_t size, size_t nmemb, std::string* data) {
    data->append(static_cast<char*>(ptr), size * nmemb);
    return size * nmemb;
}

int main() {
    dominusnode::ClientConfig config;
    config.base_url = "https://api.dominusnode.com";
    dominusnode::DominusNodeClient client(config);
    client.connect_with_key("dn_live_your_key");

    // Build proxy URL
    dominusnode::ProxyUrlOptions opts;
    opts.country = "US";
    std::string proxy_url = client.proxy().build_url("dn_live_your_key", opts);

    // Use with libcurl
    CURL* curl = curl_easy_init();
    std::string response;

    curl_easy_setopt(curl, CURLOPT_URL, "https://httpbin.org/ip");
    curl_easy_setopt(curl, CURLOPT_PROXY, proxy_url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);

    CURLcode res = curl_easy_perform(curl);
    if (res == CURLE_OK) {
        std::cout << response << std::endl;
    }

    curl_easy_cleanup(curl);
    return 0;
}
```

## Error Handling

All errors throw exceptions derived from `dominusnode::DominusNodeError`:

```cpp
#include <dominusnode/dominusnode.hpp>
#include <dominusnode/errors.hpp>

try {
    client.connect_with_key("dn_live_invalid");
} catch (const dominusnode::AuthenticationError& e) {
    std::cerr << "Invalid API key: " << e.what() << std::endl;
} catch (const dominusnode::RateLimitError& e) {
    std::cerr << "Rate limited. Retry after: " << e.retry_after_seconds << "s" << std::endl;
} catch (const dominusnode::InsufficientBalanceError& e) {
    std::cerr << "Insufficient balance" << std::endl;
} catch (const dominusnode::DominusNodeError& e) {
    std::cerr << "API error: " << e.what() << std::endl;
}
```

| Exception | HTTP Status | When |
|-----------|-------------|------|
| `AuthenticationError` | 401 | Invalid credentials |
| `AuthorizationError` | 403 | Insufficient permissions |
| `InsufficientBalanceError` | 402 | Low wallet balance |
| `RateLimitError` | 429 | Rate limit exceeded |
| `ValidationError` | 400 | Invalid input |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Duplicate resource |
| `ServerError` | 500+ | Server error |
| `NetworkError` | -- | Connection/timeout failure |

## Configuration

```cpp
dominusnode::ClientConfig config;
config.base_url = "https://api.dominusnode.com";     // API server URL
config.proxy_host = "proxy.dominusnode.com";          // Proxy gateway hostname
config.http_proxy_port = 8080;                    // HTTP proxy port
config.socks5_proxy_port = 1080;                  // SOCKS5 proxy port

dominusnode::DominusNodeClient client(config);
```

## Security Notes

- **Token memory**: All token strings are securely zeroed with `explicit_bzero` on destruction
- **Thread safety**: The CURL handle is protected by a mutex; safe to use from multiple threads
- **TLS verification**: Enabled by default (CURLOPT_SSL_VERIFYPEER + CURLOPT_SSL_VERIFYHOST); re-set after every `curl_easy_reset()`
- **HTTPS only**: HTTP is only allowed for `localhost` and `127.0.0.1`; all other hosts require HTTPS
- **URL encoding**: API keys and geo-targeting values are URL-encoded in proxy URLs
- **Non-copyable**: `DominusNodeClient` is move-only to prevent accidental token duplication

## License

MIT
