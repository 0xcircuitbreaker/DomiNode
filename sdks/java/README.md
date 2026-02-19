# Dominus Node Java SDK

Official Java SDK for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Provides a type-safe, fluent API for managing proxy connections, wallets, API keys, teams, agentic wallets, and usage analytics.

> **Alpha Release** -- This SDK is currently distributed via GitHub Packages. It is not yet published to Maven Central.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Resource API Reference](#resource-api-reference)
  - [Auth](#auth)
  - [Keys](#keys)
  - [Wallet](#wallet)
  - [Usage](#usage)
  - [Plans](#plans)
  - [Sessions](#sessions)
  - [Proxy](#proxy)
  - [Admin](#admin)
  - [Slots](#slots)
  - [Agentic Wallets](#agentic-wallets)
  - [Teams](#teams)
- [Proxy URL Building](#proxy-url-building)
- [Error Handling](#error-handling)
- [Teams and Shared Billing](#teams-and-shared-billing)
- [Agentic Wallets](#agentic-wallets-1)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- **Java 11** or later
- [Jackson Databind](https://github.com/FasterXML/jackson-databind) 2.17.0 (included as a transitive dependency)

## Installation

The SDK is published to GitHub Packages. You must configure authentication to the GitHub Packages Maven registry before adding the dependency.

### GitHub Packages Authentication

Add the following to your `~/.m2/settings.xml` (or create the file if it does not exist):

```xml
<settings>
  <servers>
    <server>
      <id>github-dominusnode</id>
      <username>YOUR_GITHUB_USERNAME</username>
      <password>YOUR_GITHUB_TOKEN</password>
    </server>
  </servers>
</settings>
```

Replace `YOUR_GITHUB_TOKEN` with a personal access token that has the `read:packages` scope.

### Maven

Add the repository and dependency to your `pom.xml`:

```xml
<repositories>
  <repository>
    <id>github-dominusnode</id>
    <url>https://maven.pkg.github.com/Dominus-Node/dominusnode-java</url>
  </repository>
</repositories>

<dependencies>
  <dependency>
    <groupId>io.dominusnode</groupId>
    <artifactId>dominusnode-sdk</artifactId>
    <version>1.0.0</version>
  </dependency>
</dependencies>
```

### Gradle (Kotlin DSL)

```kotlin
repositories {
    maven {
        url = uri("https://maven.pkg.github.com/Dominus-Node/dominusnode-java")
        credentials {
            username = project.findProperty("gpr.user") as String? ?: System.getenv("GITHUB_USERNAME")
            password = project.findProperty("gpr.token") as String? ?: System.getenv("GITHUB_TOKEN")
        }
    }
}

dependencies {
    implementation("io.dominusnode:dominusnode-sdk:1.0.0")
}
```

### Gradle (Groovy DSL)

```groovy
repositories {
    maven {
        url = uri("https://maven.pkg.github.com/Dominus-Node/dominusnode-java")
        credentials {
            username = project.findProperty("gpr.user") ?: System.getenv("GITHUB_USERNAME")
            password = project.findProperty("gpr.token") ?: System.getenv("GITHUB_TOKEN")
        }
    }
}

dependencies {
    implementation 'io.dominusnode:dominusnode-sdk:1.0.0'
}
```

## Quick Start

### API Key Authentication

```java
import io.dominusnode.sdk.Config;
import io.dominusnode.sdk.DominusNodeClient;
import io.dominusnode.sdk.types.Wallet;

try (DominusNodeClient client = new DominusNodeClient(
        Config.builder()
            .baseUrl("http://localhost:3000")
            .build())) {

    client.connectWithKey("dn_live_abc123");

    Wallet balance = client.wallet().getBalance();
    System.out.println("Balance: " + balance.getBalanceCents() + " cents");
}
```

### Auto-Connect with API Key

```java
// The client authenticates automatically when an API key is provided in the config.
try (DominusNodeClient client = new DominusNodeClient(
        Config.builder()
            .baseUrl("http://localhost:3000")
            .apiKey("dn_live_abc123")
            .build())) {

    // Already authenticated -- ready to use
    Wallet balance = client.wallet().getBalance();
    System.out.println("Balance: $" + balance.getBalanceUsd());
}
```

### Login with Email/Password and MFA

```java
import io.dominusnode.sdk.types.LoginResult;

try (DominusNodeClient client = new DominusNodeClient(
        Config.builder()
            .baseUrl("http://localhost:3000")
            .build())) {

    LoginResult result = client.connectWithCredentials("user@example.com", "password123");

    if (result.isMfaRequired()) {
        // Prompt the user for their TOTP code
        client.completeMfa("123456");
    }

    // Fully authenticated
    System.out.println("Logged in as: " + result.getUser().getEmail());
}
```

## Configuration

All configuration is provided through the `Config.builder()` pattern:

```java
Config config = Config.builder()
    .baseUrl("http://localhost:3000")       // API server URL (default: https://api.dominusnode.com)
    .apiKey("dn_live_abc123")               // Auto-connect with API key
    .proxyHost("proxy.dominusnode.com")     // Proxy server hostname (default: proxy.dominusnode.com)
    .httpProxyPort(8080)                    // HTTP proxy port (default: 8080)
    .socks5ProxyPort(1080)                 // SOCKS5 proxy port (default: 1080)
    .timeout(Duration.ofSeconds(30))        // HTTP request timeout (default: 30s)
    .build();
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `String` | `https://api.dominusnode.com` | REST API base URL |
| `apiKey` | `String` | `null` | API key for auto-authentication on client creation |
| `email` | `String` | `null` | Email for credential-based auto-authentication |
| `password` | `String` | `null` | Password for credential-based auto-authentication |
| `accessToken` | `String` | `null` | Pre-existing JWT access token |
| `refreshToken` | `String` | `null` | Pre-existing JWT refresh token |
| `proxyHost` | `String` | `proxy.dominusnode.com` | Proxy server hostname for URL building |
| `httpProxyPort` | `int` | `8080` | HTTP proxy port |
| `socks5ProxyPort` | `int` | `1080` | SOCKS5 proxy port |
| `timeout` | `Duration` | `30s` | HTTP request timeout |

The client implements `AutoCloseable` and should be used with try-with-resources, or explicitly closed via `close()` / `disconnect()` when no longer needed.

## Authentication

The SDK supports three authentication methods:

### 1. API Key

```java
client.connectWithKey("dn_live_abc123");
```

Verifies the key against the server and stores resulting JWT tokens for subsequent requests.

### 2. Email and Password

```java
LoginResult result = client.connectWithCredentials("user@example.com", "password123");
if (result.isMfaRequired()) {
    // TOTP code from authenticator app
    client.completeMfa("123456");

    // Or use a backup code
    client.completeMfa("BACKUP-CODE-HERE", result.getMfaChallengeToken(), true);
}
```

### 3. Pre-existing Tokens

```java
Config config = Config.builder()
    .baseUrl("http://localhost:3000")
    .accessToken("eyJhbGciOiJIUzI1NiI...")
    .refreshToken("rt_abc123...")
    .build();
DominusNodeClient client = new DominusNodeClient(config);
```

### Disconnecting

```java
client.disconnect();  // Attempts server-side logout, then clears all local tokens
client.close();       // Alias for disconnect() -- called automatically by try-with-resources
```

## Resource API Reference

The client exposes resources through accessor methods. Each resource groups related API operations.

### Auth

Access via `client.auth()`.

```java
// Register a new account
LoginResult result = client.auth().register("user@example.com", "securePassword123");

// Login
LoginResult result = client.auth().login("user@example.com", "password123");

// Get current user profile
User me = client.auth().me();

// Change password
client.auth().changePassword("oldPassword", "newPassword");

// MFA setup
MfaSetup setup = client.auth().mfaSetup();
System.out.println("Secret: " + setup.getSecret());
System.out.println("QR URI: " + setup.getOtpauthUri());

// Enable MFA (after scanning QR code)
client.auth().mfaEnable("123456");

// Check MFA status
MfaStatus status = client.auth().mfaStatus();
System.out.println("MFA enabled: " + status.isEnabled());

// Disable MFA
client.auth().mfaDisable("password123", "123456");

// Logout
client.auth().logout();
```

### Keys

Access via `client.keys()`.

```java
// Create a new API key (raw key value is only returned once)
CreatedApiKey key = client.keys().create("Production Key");
System.out.println("Key: " + key.getKey());  // Store this securely!
System.out.println("ID: " + key.getId());

// List all API keys
List<ApiKey> keys = client.keys().list();
for (ApiKey k : keys) {
    System.out.println(k.getLabel() + " - " + k.getPrefix() + "...");
}

// Revoke a key
client.keys().revoke(key.getId());
```

### Wallet

Access via `client.wallet()`.

```java
// Get current balance
Wallet balance = client.wallet().getBalance();
System.out.println("Balance: " + balance.getBalanceCents() + " cents ($" + balance.getBalanceUsd() + ")");

// Get transaction history
List<WalletTransaction> transactions = client.wallet().getTransactions();

// With pagination
List<WalletTransaction> page = client.wallet().getTransactions(20, 0);

// Top up with Stripe (returns a checkout URL to redirect the user to)
StripeCheckout checkout = client.wallet().topupStripe(1000); // $10.00

// Top up with cryptocurrency
CryptoInvoice invoice = client.wallet().topupCrypto(10.00, "btc");
// Supported currencies: btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb

// Get spending forecast
WalletForecast forecast = client.wallet().getForecast();
```

### Usage

Access via `client.usage()`.

```java
// Get usage records (default date range)
UsageResponse usage = client.usage().get();
System.out.println("Total bytes: " + usage.getSummary());

// With date range
UsageResponse ranged = client.usage().get("2026-01-01", "2026-01-31");

// With date range and pagination
UsageResponse paged = client.usage().get("2026-01-01", "2026-01-31", 50, 0);

// Get daily usage aggregation
DailyUsageResponse daily = client.usage().getDaily();
DailyUsageResponse dailyRange = client.usage().getDaily("2026-01-01", "2026-01-31");

// Get top target hosts by bandwidth
TopHostsResponse topHosts = client.usage().getTopHosts();
TopHostsResponse topHostsRange = client.usage().getTopHosts("2026-01-01", "2026-01-31", 10);

// Export usage data as CSV
String csv = client.usage().exportCsv();
String csvRange = client.usage().exportCsv("2026-01-01", "2026-01-31");
```

### Plans

Access via `client.plans()`.

```java
// List all available plans (no auth required)
List<Plan> plans = client.plans().list();
for (Plan plan : plans) {
    System.out.println(plan.getName() + " - " + plan.getId());
}

// Get your current plan and usage
UserPlanInfo userPlan = client.plans().getUserPlan();

// Change plan
ChangePlanResult result = client.plans().changePlan("plan_pro");
```

### Sessions

Access via `client.sessions()`.

```java
// List active proxy sessions
List<ActiveSession> sessions = client.sessions().getActive();
for (ActiveSession session : sessions) {
    System.out.println("Session: " + session);
}
```

### Proxy

Access via `client.proxy()`.

```java
// Get public proxy health (no auth required)
ProxyHealth health = client.proxy().getHealth();

// Get proxy status (requires auth)
ProxyStatus status = client.proxy().getStatus();

// Get proxy configuration (requires auth)
ProxyConfig config = client.proxy().getConfig();

// Build a proxy URL (see "Proxy URL Building" section below)
String url = client.proxy().buildUrl();
```

### Admin

Access via `client.admin()`. All methods require admin privileges.

```java
// List all users
AdminUsersResponse users = client.admin().listUsers();
AdminUsersResponse page = client.admin().listUsers(1, 25);

// Get user details
AdminUserDetail user = client.admin().getUser("user-uuid");

// Suspend / activate / delete a user
client.admin().suspendUser("user-uuid");
client.admin().activateUser("user-uuid");
client.admin().deleteUser("user-uuid");

// Revenue statistics
RevenueStats revenue = client.admin().getRevenue();
RevenueStats rangedRevenue = client.admin().getRevenue("2026-01-01", "2026-01-31");

// Daily revenue breakdown
DailyRevenueResponse dailyRevenue = client.admin().getDailyRevenue();

// System-wide statistics
SystemStats stats = client.admin().getStats();
```

### Slots

Access via `client.slots()`. All methods are public (no authentication required).

```java
// Check available registration slots
SlotsInfo slots = client.slots().getSlots();

// Join the waitlist when slots are full
WaitlistJoinResult joinResult = client.slots().joinWaitlist("user@example.com");

// Get current waitlist count
WaitlistCount count = client.slots().getWaitlistCount();
```

### Agentic Wallets

Access via `client.agenticWallets()`.

```java
// Create a sub-wallet with a spending limit
AgenticWallet wallet = client.agenticWallets().create("AI Agent Budget", 5000); // $50 limit per tx

// List all agentic wallets
AgenticWalletListResponse wallets = client.agenticWallets().list();

// Get a specific wallet
AgenticWallet w = client.agenticWallets().get("wallet-uuid");

// Fund from main wallet
AgenticWalletFundResponse funded = client.agenticWallets().fund("wallet-uuid", 10000); // $100

// Get transaction history
AgenticWalletTransactionsResponse txns = client.agenticWallets().transactions("wallet-uuid", 20, 0);

// Freeze / unfreeze
AgenticWallet frozen = client.agenticWallets().freeze("wallet-uuid");
AgenticWallet unfrozen = client.agenticWallets().unfreeze("wallet-uuid");

// Delete (refunds remaining balance to main wallet)
AgenticWalletDeleteResponse deleted = client.agenticWallets().delete("wallet-uuid");
```

### Teams

Access via `client.teams()`.

```java
// Create a team
Team team = client.teams().create("Engineering Team", 10);
Team teamDefault = client.teams().create("Marketing Team");

// List teams you belong to
List<Team> teams = client.teams().list();

// Get team details
Team details = client.teams().get("team-uuid");

// Update team settings
Team updated = client.teams().update("team-uuid", Map.of("name", "Renamed Team"));

// Delete team (refunds wallet balance)
TeamDeleteResponse deleteResult = client.teams().delete("team-uuid");

// Fund team wallet
TeamFundResponse funded = client.teams().fundWallet("team-uuid", 50000); // $500

// Get team wallet transactions
TeamTransactionsResponse txns = client.teams().getTransactions("team-uuid", 20, 0);

// Member management
TeamMembersResponse members = client.teams().listMembers("team-uuid");
TeamMember added = client.teams().addMember("team-uuid", "new@example.com", "admin");
TeamMember roleUpdated = client.teams().updateMemberRole("team-uuid", "user-uuid", "member");
client.teams().removeMember("team-uuid", "user-uuid");

// Invitations
TeamInvite invite = client.teams().createInvite("team-uuid", "invite@example.com", "member");
TeamInvitesResponse invites = client.teams().listInvites("team-uuid");
client.teams().cancelInvite("team-uuid", "invite-uuid");
TeamMember acceptedMember = client.teams().acceptInvite("invite-token");

// Team API keys
TeamKeyCreateResponse key = client.teams().createKey("team-uuid", "CI/CD Key");
TeamKeysResponse keys = client.teams().listKeys("team-uuid");
client.teams().revokeKey("team-uuid", "key-uuid");
```

## Proxy URL Building

The `ProxyResource` builds properly formatted proxy URLs with geo-targeting and session support. These URLs are used to configure HTTP clients or system proxy settings.

### Basic URL

```java
client.connectWithKey("dn_live_abc123");
String proxyUrl = client.proxy().buildUrl();
// Result: http://user:dn_live_abc123@proxy.dominusnode.com:8080
```

### With Geo-Targeting

```java
import io.dominusnode.sdk.types.ProxyUrlOptions;

String proxyUrl = client.proxy().buildUrl(ProxyUrlOptions.builder()
    .country("US")
    .state("CA")
    .city("Los Angeles")
    .build());
// Result: http://user-country_US-state_CA-city_Los+Angeles:dn_live_abc123@proxy.dominusnode.com:8080
```

### SOCKS5 Protocol

```java
String socks5Url = client.proxy().buildUrl(ProxyUrlOptions.builder()
    .protocol("socks5")
    .country("DE")
    .build());
// Result: socks5://user-country_DE:dn_live_abc123@proxy.dominusnode.com:1080
```

### Sticky Sessions

```java
String stickyUrl = client.proxy().buildUrl(ProxyUrlOptions.builder()
    .country("US")
    .sessionId("my-session-001")
    .build());
// Result: http://user-country_US-session_my-session-001:dn_live_abc123@proxy.dominusnode.com:8080
```

### With an Explicit API Key

```java
String url = client.proxy().buildUrl("dn_live_otherkey", ProxyUrlOptions.builder()
    .country("JP")
    .build());
```

### Using the Proxy URL with HttpURLConnection

```java
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.net.HttpURLConnection;

Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("proxy.dominusnode.com", 8080));
HttpURLConnection conn = (HttpURLConnection) new URL("https://httpbin.org/ip").openConnection(proxy);
conn.setRequestProperty("Proxy-Authorization",
    "Basic " + java.util.Base64.getEncoder().encodeToString(
        ("user:" + "dn_live_abc123").getBytes()));
```

## Error Handling

All SDK methods throw `DominusNodeException` (a checked exception) or one of its subclasses. Each subclass maps to a specific HTTP error category.

### Exception Hierarchy

| Exception | HTTP Status | Description |
|-----------|-------------|-------------|
| `DominusNodeException` | -- | Base class for all SDK errors |
| `AuthenticationException` | 401 | Invalid credentials, expired token, or missing auth |
| `AuthorizationException` | 403 | Insufficient permissions (e.g., non-admin accessing admin endpoint) |
| `RateLimitException` | 429 | Too many requests; check `getRetryAfterSeconds()` |
| `NotFoundException` | 404 | Requested resource does not exist |
| `InsufficientBalanceException` | 402 | Wallet balance too low for the operation |
| `ValidationException` | 400 | Invalid request parameters |
| `ConflictException` | 409 | Resource conflict (e.g., duplicate email) |
| `ProxyException` | 502/503 | Upstream proxy error |
| `ServerException` | 500 | Internal server error |
| `NetworkException` | 0 | Network connectivity issue (timeout, DNS failure, etc.) |

### Example: Granular Error Handling

```java
import io.dominusnode.sdk.errors.*;

try {
    client.wallet().topupStripe(500);
} catch (RateLimitException e) {
    System.err.println("Rate limited. Retry after " + e.getRetryAfterSeconds() + "s");
    Thread.sleep(e.getRetryAfterSeconds() * 1000L);
} catch (AuthenticationException e) {
    System.err.println("Session expired, re-authenticating...");
    client.connectWithKey("dn_live_abc123");
} catch (InsufficientBalanceException e) {
    System.err.println("Insufficient balance: " + e.getMessage());
} catch (ValidationException e) {
    System.err.println("Invalid input: " + e.getMessage());
} catch (DominusNodeException e) {
    System.err.println("API error (HTTP " + e.getStatusCode() + "): " + e.getMessage());
}
```

### Unchecked Wrapper

For situations where checked exceptions are inconvenient (e.g., lambda expressions), the SDK provides `UncheckedDominusNodeException` which wraps a `DominusNodeException` as a `RuntimeException`:

```java
import io.dominusnode.sdk.errors.UncheckedDominusNodeException;

try {
    // SDK internal code may throw this in callbacks
} catch (UncheckedDominusNodeException e) {
    DominusNodeException cause = e.getCause(); // Access the original typed exception
}
```

## Teams and Shared Billing

Teams allow multiple users to share a single billing wallet. Team API keys bill usage to the team wallet rather than any individual user's wallet.

### Team Roles

| Role | Permissions |
|------|-------------|
| `owner` | Full control: manage members, wallet, keys, settings, delete team |
| `admin` | Manage members, invites, keys; fund wallet |
| `member` | View team info; use team API keys |

### Workflow

```java
// 1. Create a team
Team team = client.teams().create("Backend Team", 25);

// 2. Fund the team wallet
client.teams().fundWallet(team.getId(), 100_00); // $100

// 3. Invite members
TeamInvite invite = client.teams().createInvite(team.getId(), "dev@example.com", "member");

// 4. Create team API keys (usage billed to team wallet)
TeamKeyCreateResponse teamKey = client.teams().createKey(team.getId(), "Scraping Bot");
System.out.println("Team API Key: " + teamKey.getKey());

// 5. Use the team key for proxy requests
// curl -x http://user:TEAM_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip
```

## Agentic Wallets

Agentic wallets are server-side custodial sub-wallets designed for AI agents and automated systems. Each agentic wallet has its own balance and per-transaction spending limit, allowing fine-grained budget control.

### Workflow

```java
// 1. Create a sub-wallet with a $50/transaction spending limit
AgenticWallet agentWallet = client.agenticWallets().create("GPT Agent", 50_00);

// 2. Fund it from your main wallet
client.agenticWallets().fund(agentWallet.getId(), 200_00); // $200

// 3. The agent uses this wallet's balance for proxy usage

// 4. Monitor transactions
AgenticWalletTransactionsResponse txns =
    client.agenticWallets().transactions(agentWallet.getId(), 50, 0);

// 5. Freeze if the agent misbehaves
client.agenticWallets().freeze(agentWallet.getId());

// 6. Unfreeze when ready
client.agenticWallets().unfreeze(agentWallet.getId());

// 7. Delete and reclaim remaining funds
AgenticWalletDeleteResponse result = client.agenticWallets().delete(agentWallet.getId());
System.out.println("Refunded: " + result.getRefundedCents() + " cents");
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and ensure tests pass: `mvn test`
4. Commit with a descriptive message
5. Open a pull request against `master`

### Building from Source

```bash
cd sdks/java
mvn clean compile
```

### Running Tests

```bash
mvn test
```

### Code Style

- Java 11 language level (no `var`, no records, no sealed classes)
- All public API methods must declare `throws DominusNodeException` where applicable
- Immutable types with `final` fields and `@JsonCreator` constructors
- Builder pattern for configuration and options classes
- URL-encode all path parameters to prevent injection

## License

This project is licensed under the [MIT License](../../LICENSE).
