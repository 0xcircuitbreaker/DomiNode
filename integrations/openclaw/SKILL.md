---
name: dominusnode-proxy
version: 1.0.0
description: Route web requests through DomiNode's rotating proxy network with geo-targeting, balance management, and team collaboration
author: DomiNode
tags:
  - proxy
  - web-scraping
  - geo-targeting
  - privacy
  - rotating-proxies
requires:
  env:
    - DOMINUSNODE_API_KEY
    - DOMINUSNODE_BASE_URL
tools:
  - proxied_fetch
  - check_balance
  - check_usage
  - get_proxy_config
  - list_sessions
  - create_agentic_wallet
  - fund_agentic_wallet
  - check_agentic_balance
  - list_agentic_wallets
  - agentic_transactions
  - create_team
  - list_teams
  - team_details
  - team_fund
  - team_create_key
  - team_usage
---

# DomiNode Proxy Skill

Route web requests through DomiNode's rotating proxy network. Supports datacenter ($3/GB) and residential ($5/GB) proxy pools with geo-targeting across 195+ countries.

## Setup

1. Get your API key at [dominusnode.com](https://dominusnode.com)
2. Set environment variable: `DOMINUSNODE_API_KEY=dn_live_YOUR_KEY`
3. Optionally set: `DOMINUSNODE_BASE_URL=https://api.dominusnode.com`

## Available Tools

### Proxy Tools
- **proxied_fetch** - Fetch a URL through the proxy network with optional country targeting
- **get_proxy_config** - View available proxy pools, countries, and targeting options
- **list_sessions** - List active proxy sessions with bandwidth usage

### Wallet Tools
- **check_balance** - Check wallet balance and estimated remaining bandwidth
- **check_usage** - View usage statistics for a time period

### Agentic Wallet Tools
- **create_agentic_wallet** - Create a sub-wallet with spending limits for autonomous agents
- **fund_agentic_wallet** - Transfer funds from main wallet to an agentic wallet
- **check_agentic_balance** - Check an agentic wallet's balance and status
- **list_agentic_wallets** - List all agentic wallets with balances
- **agentic_transactions** - View transaction history for an agentic wallet

### Team Tools
- **create_team** - Create a new team with shared billing
- **list_teams** - List teams you belong to
- **team_details** - Get team details including members and wallet balance
- **team_fund** - Fund a team wallet from your personal wallet
- **team_create_key** - Create an API key billed to the team wallet
- **team_usage** - View team wallet transaction history

## Usage Examples

### Fetch a page through US datacenter proxy
```
Use proxied_fetch to get https://example.com through a US datacenter proxy
```

### Check remaining budget
```
Check my DomiNode balance and tell me how much browsing I have left
```

### Set up a team for shared billing
```
Create a team called "Research Team" and fund it with $50
```

### Create an agentic wallet for autonomous scraping
```
Create an agentic wallet called "scraper-bot" with a $10 spending limit, then fund it with $5
```

### View recent usage breakdown
```
Show my DomiNode usage for the last 7 days
```

## Pricing
- **Datacenter proxies**: $3.00/GB (fastest, best for non-protected targets)
- **Residential proxies**: $5.00/GB (premium, harder to detect, for protected targets)

## Security
- All requests validated against SSRF (private IPs, DNS rebinding, localhost blocked)
- API keys never exposed in tool outputs
- Response bodies truncated to 4000 chars for LLM context efficiency
- OFAC sanctioned countries blocked (CU, IR, KP, RU, SY)
- Embedded credentials in URLs are rejected
- Non-standard IP formats (hex, octal, decimal) normalized and blocked
