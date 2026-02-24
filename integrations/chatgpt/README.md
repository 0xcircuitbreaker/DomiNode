# Dominus Node -- ChatGPT Custom GPT Integration

Schema-only integration for ChatGPT Custom GPTs. ChatGPT calls the Dominus Node REST API directly using the OpenAPI 3.1.0 specification -- no additional code or middleware is required.

## Overview

This integration enables ChatGPT Custom GPTs to:

- Register accounts and authenticate with JWT tokens
- Create and manage proxy API keys
- Check wallet balance and transaction history
- Top up wallet via Stripe, cryptocurrency, or PayPal
- Monitor bandwidth usage and active sessions
- Create and manage agentic sub-wallets for AI agents
- Manage teams with shared wallet billing
- Retrieve proxy server configuration

## Setup Guide

### Step 1: Get Your JWT Token

Before configuring the Custom GPT, you need a JWT access token. Obtain one by logging in:

```bash
curl -X POST https://api.dominusnode.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'
```

The response includes a `token` field (JWT, valid 15 minutes) and a `refreshToken` field (valid 7 days).

Alternatively, if you have an API key, exchange it for a JWT:

```bash
curl -X POST https://api.dominusnode.com/api/auth/verify-key \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "dn_live_your_key_here"}'
```

### Step 2: Create a Custom GPT

1. Go to [ChatGPT](https://chat.openai.com) and click **Explore GPTs** > **Create a GPT**
2. In the **Configure** tab:
   - **Name:** Dominus Node Proxy Manager (or your preferred name)
   - **Description:** Manage rotating proxies, wallet balance, API keys, and team billing on Dominus Node
   - **Instructions:** Paste the following:

```
You are a Dominus Node proxy management assistant. You help users manage their rotating proxy service.

Key facts:
- Datacenter proxies cost $3/GB, residential proxies cost $5/GB
- Users must top up their prepaid wallet before using proxies
- API keys starting with dn_live_ are used for proxy authentication
- Supported crypto: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB
- OFAC-sanctioned countries (CU, IR, KP, RU, SY) are blocked

When users ask about their balance, call getWalletBalance.
When users want to create an API key, call createApiKey.
When users ask about usage, call getUsage with appropriate date ranges.
Always confirm financial operations before executing them.
```

### Step 3: Add the API Action

1. In the **Configure** tab, scroll to **Actions** and click **Create new action**
2. Set **Authentication** to **API Key** with:
   - **Auth Type:** Bearer
   - **API Key:** Paste your JWT token
3. In the **Schema** field, paste the contents of `openapi.yaml` from this directory
4. Alternatively, set the schema URL to: `https://api.dominusnode.com/.well-known/openapi.yaml`
5. Click **Save**

### Step 4: Test the GPT

Try these prompts:

- "What's my wallet balance?"
- "Show me my usage for the last 7 days"
- "Create a new API key labeled 'Scraping Bot'"
- "List my API keys"
- "Create an agentic wallet called 'Research Agent' with a $50 spending limit"
- "Show me my teams"
- "What proxy configuration should I use?"

## Authentication Notes

- JWT access tokens expire after **15 minutes**
- When a token expires, you will need to update the API Key in the GPT action settings with a fresh token
- For longer sessions, consider using the refresh token flow (POST /api/auth/refresh)
- The `ai-plugin.json` file is provided for legacy ChatGPT plugin compatibility but is not required for Custom GPTs

## Available Operations

### Auth (no auth required)
| Operation | Description |
|-----------|-------------|
| `register` | Create a new account |
| `login` | Log in and get JWT tokens |

### API Keys
| Operation | Description |
|-----------|-------------|
| `createApiKey` | Create a new proxy API key (shown once) |
| `listApiKeys` | List all API keys with prefixes and status |
| `revokeApiKey` | Revoke an API key by ID |

### Wallet
| Operation | Description |
|-----------|-------------|
| `getWalletBalance` | Check current wallet balance |
| `getWalletTransactions` | View transaction history |
| `topUpStripe` | Create Stripe checkout for top-up |
| `topUpCrypto` | Create crypto invoice (10 currencies) |
| `topUpPaypal` | Create PayPal order for top-up |
| `capturePaypalOrder` | Capture approved PayPal payment |
| `getPaypalOrderStatus` | Check PayPal order status |
| `getCryptoInvoiceStatus` | Check crypto invoice status |

### Usage
| Operation | Description |
|-----------|-------------|
| `getUsage` | Get bandwidth usage with summary and records |

### Agentic Wallets
| Operation | Description |
|-----------|-------------|
| `createAgenticWallet` | Create sub-wallet for AI agent |
| `listAgenticWallets` | List all agentic wallets |
| `getAgenticWallet` | Get wallet details and balance |
| `fundAgenticWallet` | Transfer funds from main wallet |
| `getAgenticWalletTransactions` | View wallet transaction history |
| `freezeAgenticWallet` | Freeze wallet to prevent spending |
| `unfreezeAgenticWallet` | Unfreeze a frozen wallet |
| `deleteAgenticWallet` | Delete wallet and refund balance |

### Teams
| Operation | Description |
|-----------|-------------|
| `createTeam` | Create team with shared wallet |
| `listTeams` | List teams you belong to |
| `getTeam` | Get team details and balance |
| `updateTeam` | Update team name or member limit |
| `fundTeamWallet` | Fund team wallet from personal wallet |
| `createTeamApiKey` | Create API key billed to team |
| `getTeamWalletTransactions` | View team wallet transactions |
| `listTeamMembers` | List team members and roles |
| `updateTeamMemberRole` | Change a member's role |

### Proxy & Sessions
| Operation | Description |
|-----------|-------------|
| `getProxyConfig` | Get proxy host/port and geo-targeting options |
| `getActiveSessions` | List active proxy sessions |

### Health
| Operation | Description |
|-----------|-------------|
| `healthCheck` | Check API service health |

## Proxy Usage After Setup

Once you have an API key (created via `createApiKey`), configure your proxy client:

```bash
# HTTP proxy (datacenter, auto-routing)
curl -x http://anything:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 http://httpbin.org/ip

# Explicit datacenter pool ($3/GB)
curl -x http://dc-country-US:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# Explicit residential pool ($5/GB)
curl -x http://residential-country-US:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# SOCKS5 proxy
curl --socks5 proxy.dominusnode.com:1080 --proxy-user "dc-country-US:dn_live_YOUR_KEY" https://httpbin.org/ip
```

## Files

| File | Description |
|------|-------------|
| `openapi.yaml` | OpenAPI 3.1.0 spec -- paste into Custom GPT action schema |
| `ai-plugin.json` | Legacy ChatGPT plugin manifest (for `.well-known` hosting) |
| `README.md` | This setup guide |
| `LICENSE` | MIT license |
| `CHANGELOG.md` | Version history |

## License

MIT License. See [LICENSE](./LICENSE).
