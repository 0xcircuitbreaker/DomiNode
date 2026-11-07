# DominusNode MCP server

`@dominusnode/mcp-server` exposes the relay network to any MCP client (Claude Desktop, Claude Code, Cursor, VS Code, Gemini CLI, Codex CLI, elizaOS, LangChain MCP adapters).

## Install

```json
{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"],
      "env": { "DOMINUSNODE_API_KEY": "dn_live_YOUR_KEY" }
    }
  }
}
```

Without `DOMINUSNODE_API_KEY` the server starts in **bootstrap mode** with 11 tools: wallet challenge and sign-in, API key setup, crypto top-up and status, and public policy, pricing and stats.

## Authenticated mode: 65 tools

- Relay fetch: `dominusnode_fetch` (GET/HEAD; `country`, `ip_class`, `session_id`, `allow_http`; SSRF and DNS-rebinding checks, ports 80/443, no redirects, 10 MB cap), `dominusnode_get_proxy_config`.
- Network: `dominusnode_network_policy`, `dominusnode_network_pricing`, `dominusnode_network_stats`.
- Nodes: `dominusnode_node_setup_guide`, `dominusnode_node_register_challenge`, `dominusnode_node_register`, `dominusnode_node_list`, `dominusnode_node_tier`, `dominusnode_node_update_caps`, `dominusnode_node_revoke`.
- Earnings: `dominusnode_credits_balance`, `dominusnode_credits_transactions`, `dominusnode_credits_convert`, `dominusnode_payout_wallet_get`, `dominusnode_payout_wallet_set`, `dominusnode_credits_withdraw`, `dominusnode_payouts_list`, `dominusnode_session_report`.
- Wallet, agentic wallets, usage, keys and teams.

## Environment

| Variable | Purpose |
|---|---|
| `DOMINUSNODE_API_KEY` | `dn_live_` key (omit for bootstrap mode) |
| `DOMINUSNODE_API_URL` | API base, default `https://api.dominusnode.com` |
| `DOMINUSNODE_PROXY_HOST` | Gateway host, default `proxy.dominusnode.com` |
| `DOMINUSNODE_WALLET_KEY_FILE` | chmod-600 wallet key file for signed flows (node register, payout wallet, withdraw) |

Private keys are never tool arguments; signed flows read them from files.
