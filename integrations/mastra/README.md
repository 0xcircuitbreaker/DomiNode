# @dominusnode/mastra-tools

Dominus Node rotating proxy tools for [Mastra AI](https://mastra.ai) agents.

Provides 23 tools for interacting with Dominus Node's rotating proxy-as-a-service platform from Mastra AI workflows and agents.

## Installation

```bash
npm install @dominusnode/mastra-tools
```

## Quick Start

```typescript
import { DominusNodeToolkit } from "@dominusnode/mastra-tools";

const toolkit = new DominusNodeToolkit({
  apiKey: process.env.DOMINUSNODE_API_KEY!, // dn_live_... or dn_test_...
});

// Get all tools for your Mastra agent
const tools = toolkit.getTools();

// Use individually
const balance = await toolkit.checkBalance();
```

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `DOMINUSNODE_API_KEY` | API key (required) | -- |
| `DOMINUSNODE_BASE_URL` | REST API base URL | `https://api.dominusnode.com` |
| `DOMINUSNODE_PROXY_HOST` | Proxy gateway host | `proxy.dominusnode.com` |
| `DOMINUSNODE_PROXY_PORT` | Proxy gateway port | `8080` |

## Available Tools (23)

### Proxy Operations
- `dominusnode_proxied_fetch` - Fetch a URL through the rotating proxy with geo-targeting
- `dominusnode_check_balance` - Check wallet balance and remaining bandwidth
- `dominusnode_check_usage` - View bandwidth usage statistics
- `dominusnode_get_proxy_config` - Get proxy pools, pricing, and endpoints
- `dominusnode_list_sessions` - List active proxy sessions

### Agentic Wallet Management
- `dominusnode_create_agentic_wallet` - Create a custodial sub-wallet
- `dominusnode_fund_agentic_wallet` - Transfer funds to an agentic wallet
- `dominusnode_agentic_wallet_balance` - Check agentic wallet balance
- `dominusnode_list_agentic_wallets` - List all agentic wallets
- `dominusnode_agentic_transactions` - Get agentic wallet transaction history
- `dominusnode_freeze_agentic_wallet` - Freeze an agentic wallet
- `dominusnode_unfreeze_agentic_wallet` - Unfreeze an agentic wallet
- `dominusnode_delete_agentic_wallet` - Delete an agentic wallet

### Team Management
- `dominusnode_create_team` - Create a team with shared wallet
- `dominusnode_list_teams` - List all teams
- `dominusnode_team_details` - Get team details
- `dominusnode_team_fund` - Fund a team wallet
- `dominusnode_team_create_key` - Create a team API key
- `dominusnode_team_usage` - Get team transaction history
- `dominusnode_update_team` - Update team settings
- `dominusnode_update_team_member_role` - Change a member's role

### Payments
- `dominusnode_topup_paypal` - Top up wallet via PayPal
- `dominusnode_x402_info` - Get x402 micropayment protocol info

## Security

- Full SSRF protection (private IP blocking, DNS rebinding, Teredo/6to4, hex/octal/decimal normalization)
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Credential scrubbing in all error messages
- Prototype pollution prevention on all parsed JSON
- HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
- 10 MB response cap, 4000 char truncation, 30s timeout
- Redirect following disabled

## License

MIT
