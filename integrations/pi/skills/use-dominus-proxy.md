---
name: use-dominus-proxy
description: >
  Route HTTP requests through the Dominus Node rotating proxy service.
  Use when a task requires fetching URLs with IP rotation, bypassing
  geo-restrictions, avoiding rate limiting, or using residential IPs
  to appear as a regular user. Also covers wallet management,
  agentic sub-wallet funding, team billing, and crypto/fiat top-ups.
---

# Dominus Node Rotating Proxy — Usage Guide

## Authentication

Set your API key before running pi:

```bash
export DOMINUSNODE_API_KEY="dn_live_your_key_here"
```

## Available Tools (26 total)

The Dominus Node extension registers these tools automatically:

| Tool | Purpose |
|------|---------|
| `dominusnode_proxied_fetch` | Fetch a URL through rotating IPs |
| `dominusnode_check_balance` | Get wallet balance |
| `dominusnode_check_usage` | Bandwidth usage stats |
| `dominusnode_get_proxy_config` | Proxy endpoint details |
| `dominusnode_list_sessions` | Active proxy sessions |
| `dominusnode_create_agentic_wallet` | Create agent sub-wallet |
| `dominusnode_fund_agentic_wallet` | Fund agent sub-wallet |
| `dominusnode_check_agentic_balance` | Sub-wallet balance |
| `dominusnode_list_agentic_wallets` | All sub-wallets |
| `dominusnode_agentic_transactions` | Sub-wallet transaction history |
| `dominusnode_freeze_agentic_wallet` | Freeze sub-wallet |
| `dominusnode_unfreeze_agentic_wallet` | Unfreeze sub-wallet |
| `dominusnode_delete_agentic_wallet` | Delete sub-wallet |
| `dominusnode_create_team` | Create team with shared wallet |
| `dominusnode_list_teams` | List teams |
| `dominusnode_team_details` | Team details and balance |
| `dominusnode_team_fund` | Fund team wallet |
| `dominusnode_team_create_api_key` | Create team API key |
| `dominusnode_team_usage` | Team bandwidth stats |
| `dominusnode_update_team` | Update team settings |
| `dominusnode_update_team_member_role` | Change member role |
| `dominusnode_topup_paypal` | Top up via PayPal |
| `dominusnode_topup_stripe` | Top up via Stripe |
| `dominusnode_topup_crypto` | Top up via crypto (BTC/ETH/USDC/...) |
| `dominusnode_x402_info` | x402 micropayment config |
| `dominusnode_update_wallet_policy` | Set spending limits/domain restrictions |

## Direct Proxy Usage (via bash tool)

If you prefer to use curl directly through the proxy:

### Datacenter Pool ($3/GB — fastest)
```bash
curl -x "http://dc-country-US:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080" \
  "https://target-site.com/page"
```

### Residential Pool ($5/GB — appears as regular user)
```bash
curl -x "http://residential-country-GB:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080" \
  "https://target-site.com/page"
```

### Auto Pool (system chooses best)
```bash
curl -x "http://auto:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080" \
  "https://target-site.com/page"
```

## SOCKS5 Proxy
```bash
curl --socks5 "socks5://auto:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:1080" \
  "https://target-site.com/page"
```

## Python (requests library)
```python
import os
proxies = {
    "http":  f"http://dc-country-US:{os.environ['DOMINUSNODE_API_KEY']}@proxy.dominusnode.com:8080",
    "https": f"http://dc-country-US:{os.environ['DOMINUSNODE_API_KEY']}@proxy.dominusnode.com:8080",
}
resp = requests.get("https://target-site.com", proxies=proxies, timeout=30)
```

## Agentic Wallet Pattern (for swarm sub-agents)

Give each sub-agent its own wallet with a spending cap:
```
1. dominusnode_create_agentic_wallet(label="agent-1", spendingLimitCents=500)
2. dominusnode_fund_agentic_wallet(walletId=<id>, amountCents=1000)
3. Sub-agent uses its wallet ID for proxy authentication
4. dominusnode_check_agentic_balance(walletId=<id>) — monitor spend
5. dominusnode_freeze_agentic_wallet(walletId=<id>) — suspend if needed
```

## Pricing

| Pool | Price | Best for |
|------|-------|---------|
| Datacenter | $3.00/GB | Fast scraping, APIs, speed-sensitive tasks |
| Residential | $5.00/GB | Bypassing geo-blocks, appearing as real user |

## Security Notes

- Only `GET`, `HEAD`, and `OPTIONS` methods are permitted through `dominusnode_proxied_fetch`
- Private/internal IP ranges are blocked automatically (SSRF protection)
- OFAC sanctioned countries (CU, IR, KP, RU, SY) cannot be used as targets
- API keys are never logged or included in error messages
