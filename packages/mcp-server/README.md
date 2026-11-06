# @dominusnode/mcp-server

MCP (Model Context Protocol) server for the DominusNode relay network: AI agents fetch through IPs that other AI agents contribute, and earn by contributing their own.

Works with any MCP client (Claude Desktop, Claude Code, Gemini CLI, Codex CLI, Cursor, VS Code, elizaOS, LangChain MCP adapters, ...).

## How the network works

- **Requesters** pay per GB relayed, priced by exit IP class (`residential`, `dc`, `mobile`). Prices are admin-set and published at `GET /v1/pricing`; use `dominusnode_network_pricing` for the live numbers (never hardcode them).
- **Node operators** (agents running the node agent) receive their tier's share of each paid GB: Probation 25% up to Partner 50%. Tiers rise with paid tenure, uptime, active IPs and reputation (`dominusnode_node_tier`).
- **Self-dealing earns nothing**: traffic from you, your wallet, your team or your /24 is never routed to your own nodes, and settles with a zero node share if it is.
- **Policy** (`GET /v1/policy`): nodes dial only ports 80/443; private, loopback, metadata and embedded-IPv4 ranges are always blocked; SMTP/SSH/RDP never. Plaintext `http://` is exit-visible and needs the `allowhttp-1` opt-in under the default `opt_in` policy.

## Quick install

```json
{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"],
      "env": { "DOMINUSNODE_API_KEY": "dn_live_your_key_here" }
    }
  }
}
```

The same block works for Claude Desktop, Claude Code (`.mcp.json`), Gemini CLI, Codex CLI, Cursor and VS Code. Without `DOMINUSNODE_API_KEY` the server starts in **bootstrap mode**.

## Bootstrap mode (no API key): 11 tools

| Tool | Purpose |
|---|---|
| `dominusnode_bootstrap_help` | How to get started |
| `dominusnode_wallet_challenge` | Get an EIP-191 message to sign with your wallet |
| `dominusnode_register_wallet` | Submit the signature (creates or logs in to a wallet account) |
| `dominusnode_wallet_setup` | Signature + API key in one call |
| `dominusnode_get_account_info` | Account details |
| `dominusnode_create_agent_secret` | Per-agent `das_` secret |
| `dominusnode_pay_crypto` / `dominusnode_check_payment` | Crypto top-up and status |
| `dominusnode_network_policy` / `dominusnode_network_pricing` / `dominusnode_network_stats` | Public network info |

Email/password registration, login and email verification are human flows (admin-only) and are not exposed.

## Authenticated mode: 56 tools

**Relay fetch and proxy config**
- `dominusnode_fetch`: GET/HEAD through the HTTP proxy gateway (CONNECT tunnel for https, full-URL request for http). Options: `country` (`country-XX`), `ip_class` (`class-residential|dc|mobile`), `session_id` (`session-<id>`, sticky exit), `allow_http` (`allowhttp-1`). Client-side SSRF checks incl. DNS rebinding (every resolved IP is checked), ports 80/443 only, no redirects, 10MB cap, credentials scrubbed from errors. Responses over plaintext are flagged when the gateway sends `X-DominusNode-Exit-Visible: 1`.
- `dominusnode_get_proxy_config`: endpoints, username flags, live pricing and policy for use with curl/SDKs.
- `dominusnode_get_proxy_status`, `dominusnode_get_active_sessions`

**Network (public)**: `dominusnode_network_policy`, `dominusnode_network_pricing`, `dominusnode_network_stats`

**Nodes (earning)**
- `dominusnode_node_setup_guide`: exact install/run steps for the node agent
- `dominusnode_node_register_challenge`: preview the attestation you will sign and the PoW difficulty
- `dominusnode_node_register`: challenge, attestation (shared builder, must match the server's), PoW, EIP-191 signature with the wallet key read from `DOMINUSNODE_WALLET_KEY_FILE`, then `POST /v1/nodes`. The `dn_node_` key is written to a new 0600 file (`DOMINUSNODE_NODE_KEY_FILE`) and never shown; the tool returns the path.
- `dominusnode_node_list`, `dominusnode_node_revoke`, `dominusnode_node_tier`

**Wallet and payments**: `dominusnode_get_balance`, `dominusnode_get_forecast`, `dominusnode_get_transactions`, `dominusnode_pay_crypto`, `dominusnode_check_payment`, `dominusnode_x402_info`

**Agentic wallets**: `dominusnode_agent_wallet_create`, `_balance`, `_fund`, `_list`, `_freeze`, `_unfreeze`, `_delete`, `_transactions`, `dominusnode_update_wallet_policy`

**Usage and keys**: `dominusnode_get_usage`, `dominusnode_get_daily_usage`, `dominusnode_get_top_hosts`, `dominusnode_list_keys`, `dominusnode_create_key`, `dominusnode_revoke_key`

**Account**: `dominusnode_get_account_info`, `dominusnode_create_agent_secret`, `dominusnode_wallet_challenge`, `dominusnode_register_wallet`, `dominusnode_wallet_setup`

**Teams (17)**: `dominusnode_create_team`, `dominusnode_list_teams`, `dominusnode_team_details`, `dominusnode_team_update`, `dominusnode_team_update_member_role`, `dominusnode_team_add_member`, `dominusnode_team_remove_member`, `dominusnode_team_fund`, `dominusnode_team_create_key`, `dominusnode_team_revoke_key`, `dominusnode_team_usage`, `dominusnode_team_list_members`, `dominusnode_team_invite_member`, `dominusnode_team_list_invites`, `dominusnode_team_cancel_invite`, `dominusnode_team_list_keys`, `dominusnode_team_delete`. Team keys cannot call `/v1` node endpoints.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOMINUSNODE_API_KEY` | (none: bootstrap mode) | `dn_live_` API key |
| `DOMINUSNODE_API_URL` | `https://api.dominusnode.com` | API base URL |
| `DOMINUSNODE_PROXY_HOST` | `proxy.dominusnode.com` | Gateway host |
| `DOMINUSNODE_HTTP_PROXY_PORT` | `8080` | Gateway HTTP/CONNECT port |
| `DOMINUSNODE_SOCKS5_PROXY_PORT` | `1080` | Gateway SOCKS5 port |
| `DOMINUSNODE_FETCH_TIMEOUT_MS` | `30000` | Fetch timeout (max 120000) |
| `DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES` | `10485760` | Fetch body cap (max 10MB) |
| `DOMINUSNODE_WALLET_KEY_FILE` | (none) | chmod-600 file with the owner wallet private key, for `node_register` only |
| `DOMINUSNODE_NODE_KEY_FILE` | `~/.dominusnode/node.json` | Where `node_register` writes the node credential file (never overwritten) |
| `MCP_AGENT_SECRET` | (none) | Shared agent secret (32+ chars) sent as `X-DominusNode-Agent-Secret` |

Every API request carries `X-DominusNode-Agent: mcp`.

## Example: earn by contributing a node

```text
dominusnode_network_policy          # read ports, plaintext and attestation terms
dominusnode_network_pricing         # live price per GB and tier shares
dominusnode_node_register_challenge # preview what you sign
dominusnode_node_register(accept_attestation: true)
# -> Node key file (mode 0600): /home/agent/.dominusnode/node.json
node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json
dominusnode_node_list / dominusnode_node_tier
```

## Development

```bash
npm run build -w @dominusnode/shared -w @dominusnode/mcp-server
npx vitest run packages/mcp-server
```

## License

MIT
