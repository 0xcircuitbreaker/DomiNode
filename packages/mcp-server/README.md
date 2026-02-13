# @dominode/mcp-server

MCP (Model Context Protocol) server for DomiNode — rotating proxy tools for AI agents.

**One server, every AI platform:** Claude Desktop, Claude Code, Gemini CLI, Codex CLI, Cursor, VS Code, Jan AI, Docker AI, elizaOS, LangChain, and any MCP-compatible client.

## Features

- **24 tools** for proxy access, account management, billing, crypto payments, and usage monitoring
- **dominode_fetch** — fetch any URL through rotating residential/datacenter proxies
- **Geo-targeting** — route requests through specific countries, states, or cities
- **Bootstrap mode** — start with no API key, let the agent create its own account
- **Crypto payments** — pay with BTC, ETH, XMR, SOL, ZEC, USDC, USDT
- **x402 ready** — machine-to-machine USDC micropayments (Coinbase Agentic Wallets)
- **Free tier** — 1GB bandwidth, 10 connections, no payment required

## Quick Install

```bash
npx @dominode/mcp-server
```

No API key? No problem — the server starts in **bootstrap mode** with tools to create an account and start using proxies immediately.

## Setup by Platform

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"],
      "env": {
        "DOMINODE_API_KEY": "dn_live_your_key_here"
      }
    }
  }
}
```

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"],
      "env": {
        "DOMINODE_API_KEY": "dn_live_your_key_here"
      }
    }
  }
}
```

### Gemini CLI

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"],
      "env": {
        "DOMINODE_API_KEY": "dn_live_your_key_here"
      }
    }
  }
}
```

### Codex CLI

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"],
      "env": {
        "DOMINODE_API_KEY": "dn_live_your_key_here"
      }
    }
  }
}
```

### Cursor / VS Code

Add to MCP server settings:

```json
{
  "dominode": {
    "command": "npx",
    "args": ["-y", "@dominode/mcp-server"],
    "env": {
      "DOMINODE_API_KEY": "dn_live_your_key_here"
    }
  }
}
```

### elizaOS

Add to your agent's `character.json`:

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"],
      "env": {
        "DOMINODE_API_KEY": "dn_live_your_key_here"
      }
    }
  }
}
```

### LangChain / LangGraph

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "dominode": {
        "command": "npx",
        "args": ["-y", "@dominode/mcp-server"],
        "env": {"DOMINODE_API_KEY": "dn_live_your_key_here"}
    }
}) as client:
    tools = client.get_tools()
```

### Jan AI / Docker AI

Same MCP config pattern — any client that speaks MCP over stdio works.

## Bootstrap Mode (No API Key)

Start without any configuration — the agent creates its own account:

```json
{
  "mcpServers": {
    "dominode": {
      "command": "npx",
      "args": ["-y", "@dominode/mcp-server"]
    }
  }
}
```

Available bootstrap tools:
- `dominode_setup` — one-shot account creation
- `dominode_register` / `dominode_login` — step-by-step
- `dominode_pay_crypto` — fund with crypto
- `dominode_x402_info` — machine-to-machine payment info
- `dominode_agent_wallet_create` / `dominode_agent_wallet_balance` — Coinbase Agentic Wallet

## Tools Reference (24 total)

### Proxy

| Tool | Description |
|------|-------------|
| `dominode_fetch` | Fetch URL through rotating proxy (HTTP/HTTPS, geo-targeting) |
| `dominode_get_proxy_config` | Proxy endpoints and geo options |
| `dominode_get_proxy_status` | Live status, latency, providers |

### Account (Self-Service)

| Tool | Description |
|------|-------------|
| `dominode_register` | Create a new account (free tier, no payment needed) |
| `dominode_login` | Login with email/password |
| `dominode_setup` | One-shot: register + create API key + get proxy config |
| `dominode_get_account_info` | Account email, status, MFA |

### Billing

| Tool | Description |
|------|-------------|
| `dominode_get_balance` | Wallet balance in USD |
| `dominode_get_forecast` | Spending forecast, days remaining |
| `dominode_get_transactions` | Transaction history (paginated) |

### Crypto Payments

| Tool | Description |
|------|-------------|
| `dominode_pay_crypto` | Create crypto invoice (BTC/ETH/XMR/SOL/ZEC/USDC/USDT) |
| `dominode_check_payment` | Check crypto payment status |

### x402 & Agentic Wallets

| Tool | Description |
|------|-------------|
| `dominode_x402_info` | Get x402 micropayment protocol info |
| `dominode_agent_wallet_create` | Create Coinbase Agentic Wallet with spending limits |
| `dominode_agent_wallet_balance` | Check agentic wallet balance and budget |

### Usage

| Tool | Description |
|------|-------------|
| `dominode_get_usage` | Usage summary (bytes, cost, requests) |
| `dominode_get_daily_usage` | Daily bandwidth breakdown |
| `dominode_get_top_hosts` | Top target hosts by bandwidth |

### API Keys

| Tool | Description |
|------|-------------|
| `dominode_list_keys` | List API keys |
| `dominode_create_key` | Create new API key (shown once) |
| `dominode_revoke_key` | Revoke API key by ID |

### Plans & Sessions

| Tool | Description |
|------|-------------|
| `dominode_get_plan` | Current plan and monthly usage |
| `dominode_list_plans` | Available pricing plans |
| `dominode_get_active_sessions` | Active proxy sessions |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMINODE_API_KEY` | No | — | API key (omit for bootstrap mode) |
| `DOMINODE_API_URL` | No | `https://api.dominode.io` | REST API base URL |
| `DOMINODE_PROXY_HOST` | No | `proxy.dominode.io` | Proxy gateway host |
| `DOMINODE_HTTP_PROXY_PORT` | No | `8080` | HTTP proxy port |
| `DOMINODE_SOCKS5_PROXY_PORT` | No | `1080` | SOCKS5 proxy port |
| `DOMINODE_FETCH_TIMEOUT_MS` | No | `30000` | Proxy fetch timeout (max 120000) |
| `DOMINODE_FETCH_MAX_RESPONSE_BYTES` | No | `5242880` | Max response body (5MB) |

## Pricing

| Tier | Price | Bandwidth |
|------|-------|-----------|
| Free | $0 | 1 GB/month, 10 connections |
| Pay-as-you-go | $5/GB | Unlimited |
| Volume 100GB | $4/GB | 100 GB/month |
| Volume 1TB | $3/GB | 1 TB/month |

Crypto payments: BTC, ETH, XMR (Monero), SOL, ZEC (Zcash), USDC, USDT

## Example: AI Agent Workflow

```
Agent: "I need to scrape product prices from 3 countries"

1. dominode_setup(email, password) → account + API key (if bootstrap mode)
2. dominode_get_balance() → "$0.00 (free tier: 1GB available)"
3. dominode_fetch(url: "https://shop.example.com/prices", country: "US") → US prices
4. dominode_fetch(url: "https://shop.example.com/prices", country: "GB") → UK prices
5. dominode_fetch(url: "https://shop.example.com/prices", country: "DE") → DE prices
6. dominode_get_usage(days: 1) → "0.3 MB, $0.002"
```

```
Agent: "I need anonymous proxy access"

1. dominode_pay_crypto(amount_usd: 10, currency: "XMR") → Monero invoice
2. (agent pays invoice)
3. dominode_check_payment(invoice_id) → "confirmed, $10.00 credited"
4. dominode_fetch(url: "https://target.com", country: "JP") → response
```

## Integration Guides

- [elizaOS Integration](docs/eliza-integration.md)
- [LangChain Integration](docs/langchain-integration.md)

## Development

```bash
cd packages/mcp-server
npm install
npm run build
npm test

# Run locally
DOMINODE_API_KEY=dn_live_xxx node dist/src/index.js

# Run in bootstrap mode (no key)
node dist/src/index.js
```

## License

MIT
