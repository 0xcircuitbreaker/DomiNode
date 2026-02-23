# Dominus Node + Eliza (elizaOS) Integration Guide

Give your Eliza agents autonomous web access through rotating residential proxies.

## Quick Start

### 1. Add Dominus Node MCP Server to your Eliza agent

In your Eliza agent's `character.json`:

```json
{
  "name": "my-agent",
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"],
      "env": {
        "DOMINUSNODE_API_KEY": "dn_live_your_key_here"
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
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"]
    }
  }
}
```

Your agent can then call `dominusnode_setup` to create an account and get proxy access.

### 3. Pay with Crypto (Fully Anonymous)

For agents that need anonymous proxy access:

```typescript
// In your Eliza action handler
const invoice = await callTool("dominusnode_pay_crypto", {
  amount_usd: 10,
  currency: "XMR"  // Monero — untraceable payment
});
```

## Available Tools

| Tool | Description |
|------|-------------|
| `dominusnode_fetch` | Fetch any URL through rotating proxy |
| `dominusnode_setup` | One-shot: create account + API key |
| `dominusnode_pay_crypto` | Pay with BTC/ETH/LTC/XMR/ZEC/USDC/SOL/USDT/DAI/BNB/LINK |
| `dominusnode_get_balance` | Check wallet balance |
| `dominusnode_x402_info` | Get x402 pay-per-request info |
| `dominusnode_get_proxy_config` | Get proxy endpoints |

## Use Cases

### Web Research Agent
```
Agent: "I need to research product prices across 5 countries."
→ Uses dominusnode_fetch with country targeting (US, UK, DE, JP, BR)
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
→ Tracks bandwidth usage via dominusnode_get_usage
```

## x402 Integration (Coming Soon)

For agents with Coinbase Agentic Wallets:

```typescript
// Agent pays per-request with USDC — no account needed
const proxyAccess = await callTool("dominusnode_x402_info");
// Send USDC micropayment → instant proxy access
```

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `DOMINUSNODE_API_KEY` | No (bootstrap mode) | — |
| `DOMINUSNODE_API_URL` | No | `https://api.dominusnode.com` |
| `DOMINUSNODE_PROXY_HOST` | No | `proxy.dominusnode.com` |

## Pricing

- **Free tier**: 1 GB bandwidth, 10 connections — no payment needed
- **Pay-as-you-go**: $5/GB residential proxy bandwidth
- **Crypto accepted**: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK
