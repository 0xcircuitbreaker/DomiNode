# Dominus Node -- ChatGPT Integration

Full integration for ChatGPT Custom GPTs and OpenAI Assistants API. Includes both an OpenAPI 3.1.0 spec for direct API actions and a TypeScript function handler with 53 tools, PoW solver, SSRF protection, and credential scrubbing.

## Two Usage Modes

### Mode 1: Custom GPT Actions (Schema-Only)

Paste `openapi.yaml` into your Custom GPT action schema. ChatGPT calls the Dominus Node REST API directly.

### Mode 2: Programmatic Handler (Recommended)

Use the TypeScript handler for full security and PoW support:

```ts
import { createDominusNodeFunctionHandler } from "@dominusnode/chatgpt";

const handler = createDominusNodeFunctionHandler({
  apiKey: "dn_live_...",
  baseUrl: "https://api.dominusnode.com",
});

// Dispatch function calls from ChatGPT
const balance = await handler("dominusnode_check_balance", {});
const usage = await handler("dominusnode_check_usage", { period: "week" });
const fetch = await handler("dominusnode_proxied_fetch", {
  url: "https://httpbin.org/ip",
  country: "US",
  proxy_type: "dc",
});
```

## Installation

```bash
npm install @dominusnode/chatgpt
# or install from GitHub
npm install github:Dominus-Node/dominusnode#main --workspace=integrations/chatgpt
```

## 53 Tools

### Proxy (3)
| Tool | Description |
|------|-------------|
| `dominusnode_proxied_fetch` | Fetch URL through rotating proxy with geo-targeting |
| `dominusnode_get_proxy_config` | Get proxy endpoints and supported countries |
| `dominusnode_get_proxy_status` | Get proxy service status |

### Wallet (7)
| Tool | Description |
|------|-------------|
| `dominusnode_check_balance` | Check wallet balance |
| `dominusnode_get_transactions` | View transaction history |
| `dominusnode_get_forecast` | Get spending forecast |
| `dominusnode_check_payment` | Check crypto invoice status |
| `dominusnode_topup_stripe` | Create Stripe checkout ($5-$1,000) |
| `dominusnode_topup_paypal` | Create PayPal order ($5-$1,000) |
| `dominusnode_topup_crypto` | Create crypto invoice (10 currencies) |

### Usage (3)
| Tool | Description |
|------|-------------|
| `dominusnode_check_usage` | Get usage stats for period |
| `dominusnode_get_daily_usage` | Get daily breakdown (1-90 days) |
| `dominusnode_get_top_hosts` | Get most-accessed domains |

### Sessions (1)
| Tool | Description |
|------|-------------|
| `dominusnode_list_sessions` | List active proxy sessions |

### Account (6)
| Tool | Description |
|------|-------------|
| `dominusnode_register` | Create account (with PoW solver) |
| `dominusnode_login` | Login with email/password |
| `dominusnode_get_account_info` | Get account details |
| `dominusnode_verify_email` | Verify email with token |
| `dominusnode_resend_verification` | Resend verification email |
| `dominusnode_update_password` | Change password |

### API Keys (3)
| Tool | Description |
|------|-------------|
| `dominusnode_list_keys` | List API keys |
| `dominusnode_create_key` | Create API key |
| `dominusnode_revoke_key` | Revoke API key |

### Plans (3)
| Tool | Description |
|------|-------------|
| `dominusnode_get_plan` | Get current plan |
| `dominusnode_list_plans` | List available plans |
| `dominusnode_change_plan` | Switch plan |

### Agentic Wallets (9)
| Tool | Description |
|------|-------------|
| `dominusnode_create_agentic_wallet` | Create sub-wallet for AI agent |
| `dominusnode_fund_agentic_wallet` | Fund from main wallet |
| `dominusnode_agentic_wallet_balance` | Check sub-wallet balance |
| `dominusnode_list_agentic_wallets` | List all sub-wallets |
| `dominusnode_agentic_transactions` | View sub-wallet transactions |
| `dominusnode_freeze_agentic_wallet` | Freeze sub-wallet |
| `dominusnode_unfreeze_agentic_wallet` | Unfreeze sub-wallet |
| `dominusnode_delete_agentic_wallet` | Delete sub-wallet |
| `dominusnode_update_wallet_policy` | Update daily limits/domains |

### Teams (17)
| Tool | Description |
|------|-------------|
| `dominusnode_create_team` | Create team |
| `dominusnode_list_teams` | List teams |
| `dominusnode_team_details` | Get team details |
| `dominusnode_team_fund` | Fund team wallet |
| `dominusnode_team_create_key` | Create team API key |
| `dominusnode_team_usage` | View team transactions |
| `dominusnode_update_team` | Update team settings |
| `dominusnode_update_team_member_role` | Change member role |
| `dominusnode_team_delete` | Delete team |
| `dominusnode_team_revoke_key` | Revoke team API key |
| `dominusnode_team_list_keys` | List team API keys |
| `dominusnode_team_list_members` | List team members |
| `dominusnode_team_add_member` | Add team member |
| `dominusnode_team_remove_member` | Remove team member |
| `dominusnode_team_invite_member` | Invite member by email |
| `dominusnode_team_list_invites` | List pending invites |
| `dominusnode_team_cancel_invite` | Cancel invite |

### x402 (1)
| Tool | Description |
|------|-------------|
| `dominusnode_x402_info` | Get x402 micropayment info |

## Security

- SSRF: DNS rebinding protection, private IP blocking, hex/octal/decimal normalization
- OFAC: Sanctioned countries (CU, IR, KP, RU, SY) blocked
- Credential scrubbing: `dn_live_*`, `dn_test_*`, `dn_proxy_*` redacted from errors
- Prototype pollution: Recursive `stripDangerousKeys` on all JSON parsing
- Response size cap: 10MB max
- HTTP methods: Only GET, HEAD, OPTIONS for proxied fetch
- PoW solver: SHA-256 challenge solver for CAPTCHA-free registration

## Custom GPT Setup (Schema-Only Mode)

1. Go to [ChatGPT](https://chat.openai.com) > **Explore GPTs** > **Create a GPT**
2. In **Actions**, paste the contents of `openapi.yaml`
3. Set auth to **Bearer** and paste your JWT token
4. JWT tokens expire in 15 minutes; refresh via POST `/api/auth/refresh`

## Files

| File | Description |
|------|-------------|
| `handler.ts` | 53-tool function handler with full security |
| `handler.test.ts` | 131 test cases (SSRF, validation, dispatch) |
| `functions.json` | Tool definitions for LLM function calling |
| `openapi.yaml` | OpenAPI 3.1.0 spec for Custom GPT actions |
| `ai-plugin.json` | Legacy ChatGPT plugin manifest |

## License

MIT License. See [LICENSE](./LICENSE).
