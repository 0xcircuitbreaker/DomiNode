# Dominus Node OpenClaw Plugin

Route web requests through Dominus Node's rotating proxy network directly from your OpenClaw AI coding sessions. Supports datacenter and residential proxy pools with geo-targeting across 195+ countries, agentic wallets for autonomous agent billing, and team collaboration with shared wallets.

## What is Dominus Node?

Dominus Node is a rotating proxy-as-a-service (PaaS) platform. Users connect to Dominus Node, are automatically assigned a proxy IP from a managed pool, and their traffic is routed through it. Usage is metered by bandwidth and billed via a prepaid wallet system.

- **Datacenter proxies**: $3.00/GB (fastest, best for non-protected targets)
- **Residential proxies**: $5.00/GB (premium, harder to detect)
- **Prepaid wallet**: Top up via Stripe or crypto (BTC, ETH, XMR, SOL, ZEC, and more)

## Installation

### As an OpenClaw Skill

1. Copy `SKILL.md` and `plugin.ts` to your OpenClaw skills directory, or reference this integration directory directly.

2. Set the required environment variables:

```bash
export DOMINUSNODE_API_KEY="dn_live_YOUR_API_KEY_HERE"
export DOMINUSNODE_BASE_URL="https://api.dominusnode.com"  # optional, this is the default
```

3. The skill will be automatically discovered by OpenClaw when the environment variables are set.

### Manual Setup

```bash
# Clone the Dominus Node repo
git clone https://github.com/Dominus-Node/Dominus Node.git
cd Dominus Node/integrations/openclaw

# No npm install needed — the plugin uses only native fetch (Node 18+)
```

## Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `DOMINUSNODE_API_KEY` | Yes | -- | Your Dominus Node API key (starts with `dn_live_` or `dn_test_`) |
| `DOMINUSNODE_BASE_URL` | No | `https://api.dominusnode.com` | Base URL for the Dominus Node REST API |

### Getting an API Key

1. Register at [dominusnode.com](https://dominusnode.com)
2. Log in and navigate to API Keys
3. Create a new key -- it will start with `dn_live_`
4. Fund your wallet via Stripe or crypto

## Tools Reference

### Proxy Tools

#### `proxied_fetch`
Fetch a URL through the proxy network with optional geo-targeting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | The URL to fetch (http or https) |
| `method` | string | No | HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD). Default: GET |
| `country` | string | No | ISO 3166-1 alpha-2 country code (e.g., US, GB, DE) |
| `pool` | string | No | Proxy pool: `dc` (datacenter, $3/GB) or `residential` ($5/GB). Default: dc |
| `headers` | object | No | Additional HTTP headers as key-value pairs |
| `body` | string | No | Request body for POST/PUT/PATCH |

#### `get_proxy_config`
View available proxy pools, pricing, supported countries, and endpoint configuration. No parameters.

#### `list_sessions`
List all active proxy sessions with status, target hosts, and bandwidth usage. No parameters.

### Wallet Tools

#### `check_balance`
Check your wallet balance and estimated remaining bandwidth at current pricing. No parameters.

#### `check_usage`
View bandwidth usage statistics for a time period.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `days` | number | No | Number of days to look back (1-365). Default: 30 |

### Agentic Wallet Tools

Agentic wallets are server-side custodial sub-wallets designed for autonomous AI agents. They have per-transaction spending limits for safety and are funded from your main wallet.

#### `create_agentic_wallet`
Create a new agentic wallet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | Yes | Label for the wallet (1-100 chars) |
| `spending_limit_cents` | number | No | Max spend per transaction in cents. Default: 10000 ($100) |

#### `fund_agentic_wallet`
Transfer funds from your main wallet to an agentic wallet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `wallet_id` | string | Yes | Agentic wallet UUID |
| `amount_cents` | number | Yes | Amount in cents (100-1000000) |

#### `check_agentic_balance`
Check an agentic wallet's balance and status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `wallet_id` | string | Yes | Agentic wallet UUID |

#### `list_agentic_wallets`
List all your agentic wallets with balances and status. No parameters.

#### `agentic_transactions`
View transaction history for an agentic wallet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `wallet_id` | string | Yes | Agentic wallet UUID |
| `limit` | number | No | Number of transactions (1-100). Default: 20 |

### Team Tools

Teams enable shared wallet billing across multiple users. Owners and admins can manage members and create shared API keys.

#### `create_team`
Create a new team.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Team name (1-100 chars) |
| `max_members` | number | No | Maximum members (1-1000). Default: unlimited |

#### `list_teams`
List all teams you belong to. No parameters.

#### `team_details`
Get detailed info about a team.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `team_id` | string | Yes | Team UUID |

#### `team_fund`
Transfer funds from your personal wallet to a team wallet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `team_id` | string | Yes | Team UUID |
| `amount_cents` | number | Yes | Amount in cents (100-1000000) |

#### `team_create_key`
Create a shared API key billed to the team wallet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `team_id` | string | Yes | Team UUID |
| `label` | string | Yes | Key label (1-100 chars) |

#### `team_usage`
View team wallet transaction history.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `team_id` | string | Yes | Team UUID |
| `limit` | number | No | Number of transactions (1-100). Default: 20 |

## Usage Examples

### Fetch a page through a US proxy
```
Use proxied_fetch to get https://httpbin.org/ip through a US datacenter proxy
```

### Check your budget
```
Check my Dominus Node balance and tell me how much residential browsing I have left
```

### Set up a research team
```
Create a team called "Web Research" with max 5 members, then fund it with $25
```

### Create an agent wallet for automated scraping
```
Create an agentic wallet called "price-monitor" with a $5 spending limit, fund it with $10
```

### View usage breakdown
```
Show my Dominus Node usage for the last 7 days
```

### Fetch with residential proxy and geo-targeting
```
Use proxied_fetch to get https://example.co.uk through a GB residential proxy
```

## Security

The plugin implements comprehensive security measures:

- **SSRF Protection**: All target URLs are validated before proxying. Private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, etc.), localhost, `.local`/`.internal`/`.arpa` TLDs, and `.localhost` (RFC 6761) are blocked.
- **Non-standard IP Normalization**: Hex (0x7f000001), octal (0177.0.0.1), and decimal (2130706433) IP formats are normalized and blocked.
- **IPv6 Zone ID Stripping**: IPv6 zone IDs (e.g., `%25eth0`) are stripped before validation to prevent bypasses.
- **IPv4-mapped IPv6**: Addresses like `::ffff:127.0.0.1` are properly detected and blocked.
- **Embedded Credentials**: URLs containing `user:pass@host` are rejected.
- **CRLF Injection**: HTTP headers are validated for CR/LF/null bytes.
- **Credential Scrubbing**: API keys (`dn_live_*`, `dn_test_*`) are redacted from all error messages.
- **Response Truncation**: Response bodies are capped at 4000 characters to prevent LLM context overflow.
- **OFAC Compliance**: Cuba (CU), Iran (IR), North Korea (KP), Russia (RU), and Syria (SY) are blocked as geo-targeting destinations.
- **Prototype Pollution Prevention**: `__proto__`, `constructor`, and `prototype` keys are stripped from parsed JSON.
- **Input Sanitization**: Labels and names are validated for control characters and length limits.
- **Integer Validation**: Monetary amounts are validated as integers within safe bounds.

## API Endpoints Used

| Tool | Method | Endpoint |
|---|---|---|
| `proxied_fetch` | POST | `/api/proxy/fetch` |
| `check_balance` | GET | `/api/wallet` |
| `check_usage` | GET | `/api/usage` |
| `get_proxy_config` | GET | `/api/proxy/config` |
| `list_sessions` | GET | `/api/sessions/active` |
| `create_agentic_wallet` | POST | `/api/agent-wallet` |
| `fund_agentic_wallet` | POST | `/api/agent-wallet/:id/fund` |
| `check_agentic_balance` | GET | `/api/agent-wallet/:id` |
| `list_agentic_wallets` | GET | `/api/agent-wallet` |
| `agentic_transactions` | GET | `/api/agent-wallet/:id/transactions` |
| `create_team` | POST | `/api/teams` |
| `list_teams` | GET | `/api/teams` |
| `team_details` | GET | `/api/teams/:id` |
| `team_fund` | POST | `/api/teams/:id/wallet/fund` |
| `team_create_key` | POST | `/api/teams/:id/keys` |
| `team_usage` | GET | `/api/teams/:id/wallet/transactions` |

## Requirements

- Node.js 18+ (uses native `fetch`)
- OpenClaw runtime with `jiti` support
- Dominus Node API key with funded wallet

## License

MIT
