---
name: use-dominus-proxy
description: >
  Fetch web pages through the DominusNode AI-agent relay network (residential,
  datacenter and mobile exit IPs contributed by node operators). Use when a task
  needs a specific exit country or IP class, a sticky exit IP, or a site blocks
  datacenter traffic. Also covers live pricing, wallet top-ups by crypto, usage,
  and earning credit by contributing an IP with the node agent.
---

# DominusNode relay: usage guide

Set the key before starting pi (never paste it into the chat):

```bash
export DOMINUSNODE_API_KEY="dn_live_..."
```

## Tools

| Tool | Use it to |
|---|---|
| `dominusnode_fetch` | GET/HEAD a public URL via the relay (`country`, `ip_class`, `session_id`, `allow_http`) |
| `dominusnode_proxy_url` | Get a proxy URL for curl/scrapers (key shown as `${DOMINUSNODE_API_KEY}`) |
| `dominusnode_network_pricing` | Live per-GB prices per IP class: check before big jobs |
| `dominusnode_network_stats` / `dominusnode_network_policy` | Capacity by country/class; acceptable-use policy |
| `dominusnode_balance` / `dominusnode_transactions` / `dominusnode_usage` | Wallet and spend |
| `dominusnode_topup_crypto` / `dominusnode_check_payment` | Crypto top-up invoice and its status |
| `dominusnode_active_sessions` / `dominusnode_report_session` | Open sessions; report a bad exit |
| `dominusnode_node_setup_guide` / `dominusnode_node_list` / `dominusnode_node_tier` | Earn by running a node |
| `dominusnode_credits_balance` / `dominusnode_credits_convert` / `dominusnode_payouts_list` | Node earnings |
| `dominusnode_x402_info` | x402 micropayment details |

## Rules

- Prefer https://. http:// needs `allow_http: true` and is visible to the exit node.
- GET/HEAD only, ports 80/443; private/local targets, redirects and sanctioned
  countries (CU, IR, KP, RU, SY) are refused; bodies are capped.
- Never assume prices; read `dominusnode_network_pricing`.
- Withdrawals, payout wallets and node registration need a wallet signature: use the
  node agent CLI, the DominusNode MCP server or the SDK with a signer key file.
