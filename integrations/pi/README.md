# @dominusnode/pi-extension

[Pi](https://github.com/badlogic/pi-mono) extension providing **26 tools** for the [Dominus Node](https://dominusnode.com) rotating proxy and management platform.

## What is Pi?

Pi (pi-mono) is a TypeScript/Node.js agentic coding framework by Mario Zechner. It powers OpenClaw and supports building AI agent workflows with type-safe tool definitions using `@sinclair/typebox`.

## Installation

### As a Pi Package (recommended)

```bash
npm install @dominusnode/pi-extension
```

Declare in your project's `package.json`:
```json
{
  "pi": {
    "extensions": ["./node_modules/@dominusnode/pi-extension/dist"]
  }
}
```

### Manual Extension

Copy or symlink the `dist/` folder into your Pi extensions directory:
```bash
~/.pi/agent/extensions/dominusnode/   # global
.pi/extensions/dominusnode/           # project-local
```

## Authentication

```bash
export DOMINUSNODE_API_KEY="dn_live_your_key_here"
```

Get your API key at [dominusnode.com](https://dominusnode.com) → Dashboard → API Keys.

## Available Tools (26 total)

| Tool | Description |
|------|-------------|
| `dominusnode_proxied_fetch` | Fetch a URL through rotating IPs (DC or residential) |
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

## Proxy Usage

```bash
# Datacenter pool ($3/GB — fastest)
curl -x "http://dc-country-US:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080" \
  "https://target-site.com/page"

# Residential pool ($5/GB — appears as regular user)
curl -x "http://residential-country-GB:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8080" \
  "https://target-site.com/page"
```

## Agentic Wallet Pattern (for Pi swarms)

Give each sub-agent its own wallet with a spending cap:

```
1. dominusnode_create_agentic_wallet(label="research-agent-1", spendingLimitCents=500)
2. dominusnode_fund_agentic_wallet(walletId=<id>, amountCents=1000)
3. Sub-agent uses its wallet ID for proxy authentication
4. dominusnode_check_agentic_balance(walletId=<id>) — monitor spend
5. dominusnode_freeze_agentic_wallet(walletId=<id>) — suspend if needed
```

## Security

- **SSRF protection**: Private IPs, RFC1918, CGNAT, loopback, link-local, Teredo/6to4, IPv4-mapped IPv6, hex/octal/decimal normalization, zone ID stripping
- **DNS rebinding protection**: Hostname resolved before each request; private IPs in DNS results are blocked
- **.localhost / .local / .internal / .arpa** TLDs blocked
- **OFAC compliance**: Requests to sanctioned countries (CU, IR, KP, RU, SY) are rejected
- **Credential scrubbing**: API keys redacted from all error messages
- **Prototype pollution prevention**: Recursive key stripping on all parsed JSON
- **HTTP method restriction**: Only GET, HEAD, OPTIONS permitted via `proxied_fetch`
- **10 MB response cap** + 4000 character truncation
- **Redirect following disabled** to prevent open redirect abuse

## Pricing

| Pool | Price | Best for |
|------|-------|----------|
| Datacenter | $3.00/GB | Fast scraping, APIs, speed-sensitive tasks |
| Residential | $5.00/GB | Bypassing geo-blocks, appearing as real user |

## License

MIT — see [LICENSE](./LICENSE)
