# DomiNode + Eliza (elizaOS) Integration Guide

Give your Eliza agents autonomous web access through rotating residential proxies.

## Quick Start

### 1. Add DomiNode MCP Server to your Eliza agent

In your Eliza agent's `character.json`:

```json
{
  "name": "my-agent",
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

### 2. Bootstrap Mode (No API Key Needed)

Start without an API key — your agent creates its own account:

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

Your agent can then call `dominode_setup` to create an account and get proxy access.

### 3. Pay with Crypto (Fully Anonymous)

For agents that need anonymous proxy access:

```typescript
// In your Eliza action handler
const invoice = await callTool("dominode_pay_crypto", {
  amount_usd: 10,
  currency: "XMR"  // Monero — untraceable payment
});
```

## Available Tools

| Tool | Description |
|------|-------------|
| `dominode_fetch` | Fetch any URL through rotating proxy |
| `dominode_setup` | One-shot: create account + API key |
| `dominode_pay_crypto` | Pay with BTC/ETH/XMR/SOL/ZEC |
| `dominode_get_balance` | Check wallet balance |
| `dominode_x402_info` | Get x402 pay-per-request info |
| `dominode_get_proxy_config` | Get proxy endpoints |

## Use Cases

### Web Research Agent
```
Agent: "I need to research product prices across 5 countries."
→ Uses dominode_fetch with country targeting (US, UK, DE, JP, BR)
→ Each request exits from a different country's IP pool
→ Avoids geo-blocks and rate limits
```

### OSINT Agent
```
Agent: "Gather public data from multiple sources."
→ Pays with Monero (anonymous billing)
→ Rotates IPs automatically per request
→ No traceable connection between queries
```

### Competitive Intelligence Agent
```
Agent: "Monitor competitor pricing daily."
→ Uses sticky sessions for consistent access
→ Geo-targets specific markets
→ Tracks bandwidth usage via dominode_get_usage
```

## x402 Integration (Coming Soon)

For agents with Coinbase Agentic Wallets:

```typescript
// Agent pays per-request with USDC — no account needed
const proxyAccess = await callTool("dominode_x402_info");
// Send USDC micropayment → instant proxy access
```

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `DOMINODE_API_KEY` | No (bootstrap mode) | — |
| `DOMINODE_API_URL` | No | `https://api.dominode.io` |
| `DOMINODE_PROXY_HOST` | No | `proxy.dominode.io` |

## Pricing

- **Free tier**: 1 GB bandwidth, 10 connections — no payment needed
- **Pay-as-you-go**: $5/GB residential proxy bandwidth
- **Crypto accepted**: BTC, ETH, XMR, SOL, ZEC, USDC, USDT
