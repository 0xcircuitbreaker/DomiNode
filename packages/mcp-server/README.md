# @dominusnode/mcp-server

MCP (Model Context Protocol) server for the DominusNode relay network: AI agents fetch through IPs that other AI agents contribute, and earn by contributing their own.

Works with any MCP client (Claude Desktop, Claude Code, Gemini CLI, Codex CLI, Cursor, VS Code, elizaOS, LangChain MCP adapters, ...).

## How the network works

- **Requesters** pay per GB relayed, priced by exit IP class (`residential`, `dc`, `mobile`). Prices are admin-set and published at `GET /v1/pricing`; use `dominusnode_network_pricing` for the live numbers (never hardcode them).
- **Node operators** (agents running the node agent) receive their tier's share of each paid GB: Probation 25% up to Partner 50%. Tiers rise with paid tenure, uptime, active IPs and reputation (`dominusnode_node_tier`).
- **Self-dealing earns nothing**: traffic from you, your wallet, your team or your /24 is never routed to your own nodes, and settles with a zero node share if it is.
- **Policy** (`GET /v1/policy`): nodes dial only ports 80/443; private, loopback, metadata and embedded-IPv4 ranges are always blocked; SMTP/SSH/RDP never. Plaintext `http://` is exit-visible and needs the `allowhttp-1` opt-in under the default `opt_in` policy.

## Quick install

```bash
npm install -g @dominusnode/mcp-server   # or run it on demand with npx, as below
```

Registry name: `io.github.0xcircuitbreaker/dominusnode` in the official MCP Registry.

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

## Bootstrap mode (no API key): 12 tools

| Tool | Purpose |
|---|---|
| `dominusnode_bootstrap_help` | How to get started |
| `dominusnode_wallet_challenge` | Get an EIP-191 message to sign with your wallet |
| `dominusnode_register_wallet` | Submit the signature (creates or logs in to a wallet account) |
| `dominusnode_wallet_setup` | Signature + API key in one call; unlocks the authenticated tools in the same session (no restart). With `DOMINUSNODE_WALLET_KEY_FILE` set, omit the signature and the server signs the standard sign-in message |
| `dominusnode_get_account_info` | Account details |
| `dominusnode_create_agent_secret` | Per-agent `das_` secret |
| `dominusnode_pay_crypto` / `dominusnode_check_payment` | Crypto top-up and status (sign in first) |
| `dominusnode_x402_info` | Public: whether x402 pay-per-request is enabled and how to use it |
| `dominusnode_network_policy` / `dominusnode_network_pricing` / `dominusnode_network_stats` | Public network info |

Email/password registration, login and email verification are human flows (admin-only) and are not exposed.

Wallet sign-in is rate limited: 20 challenges and 5 failed verifications per hour per process; successful sign-ins do not count.

## Authenticated mode: 65 tools

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
- `dominusnode_node_update_caps`: lower a node's stream, GB/day or req/s caps (never above policy defaults)

**Earnings and payouts** (shapes: `docs/agent-network/AGENT_API.md`)
- `dominusnode_credits_balance`, `dominusnode_credits_transactions`: pending/available credit, tier hold, tax status, ledger
- `dominusnode_credits_convert`: available credit into your own requester wallet (idempotent)
- `dominusnode_payout_wallet_get`, `dominusnode_payout_wallet_set`: USDC payout address on Base. Signs a server challenge (rebuilt locally first) with the key in `DOMINUSNODE_WALLET_KEY_FILE`; a change also needs the current payout wallet's key in `DOMINUSNODE_PAYOUT_WALLET_KEY_FILE` and starts a 72h cooldown. Keys are never tool arguments.
- `dominusnode_credits_withdraw`: on-demand USDC payout (min $1, tier daily limit, fresh signature); `503 PAYOUTS_DISABLED` while payouts are off
- `dominusnode_payouts_list`: your payouts with status and tx hash
- `dominusnode_session_report`: report a burned exit for one of your relay sessions (5 per node per day)

**Wallet and payments**: `dominusnode_get_balance`, `dominusnode_get_forecast`, `dominusnode_get_transactions`, `dominusnode_pay_crypto`, `dominusnode_check_payment`, `dominusnode_x402_info`

**Agentic wallets**: `dominusnode_agent_wallet_create`, `_balance`, `_fund`, `_list`, `_freeze`, `_unfreeze`, `_delete`, `_transactions`, `dominusnode_update_wallet_policy`

**Usage and keys**: `dominusnode_get_usage`, `dominusnode_get_daily_usage`, `dominusnode_get_top_hosts`, `dominusnode_list_keys`, `dominusnode_create_key`, `dominusnode_revoke_key`

**Account**: `dominusnode_get_account_info`, `dominusnode_create_agent_secret`, `dominusnode_wallet_challenge`, `dominusnode_register_wallet`, `dominusnode_wallet_setup`

**Teams (17)**: `dominusnode_create_team`, `dominusnode_list_teams`, `dominusnode_team_details`, `dominusnode_team_update`, `dominusnode_team_update_member_role`, `dominusnode_team_add_member`, `dominusnode_team_remove_member`, `dominusnode_team_fund`, `dominusnode_team_create_key`, `dominusnode_team_revoke_key`, `dominusnode_team_usage`, `dominusnode_team_list_members`, `dominusnode_team_invite_member`, `dominusnode_team_list_invites`, `dominusnode_team_cancel_invite`, `dominusnode_team_list_keys`, `dominusnode_team_delete`. Team keys cannot call `/v1` node endpoints.

## Remote MCP (Streamable HTTP)

Hosted agent platforms that cannot spawn a local process can connect over HTTP. Run the server in
remote mode and point the platform at `https://<your-host>/mcp`; each agent sends its own key:

```bash
DOMINUSNODE_MCP_HTTP_PORT=3333 npx -y @dominusnode/mcp-server   # or: npx -y @dominusnode/mcp-server --http
```

```json
{
  "mcpServers": {
    "dominusnode": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer dn_live_YOUR_KEY" }
    }
  }
}
```

- Every request needs `Authorization: Bearer dn_live_...`. A session is bound to the key that opened
  it; another key gets `404` for that session id. The key is never logged and is scrubbed from every
  response body.
- The tool set is the same 65-tool authenticated set as stdio. `DOMINUSNODE_API_KEY` must be unset in
  remote mode (the operator key never serves remote agents). `DOMINUSNODE_WALLET_KEY_FILE` and
  `DOMINUSNODE_PAYOUT_WALLET_KEY_FILE` are ignored for remote sessions, so the signing tools
  (node register, withdraw, payout wallet) refuse; remote agents sign with their own SDK or stdio server.
- Binds `127.0.0.1` by default. To expose it, set `DOMINUSNODE_MCP_HTTP_HOST=0.0.0.0` behind a TLS
  reverse proxy; Bearer keys must not cross the network in clear.
- Requests carrying an `Origin` header are refused unless listed in `DOMINUSNODE_MCP_ALLOWED_ORIGINS`.
- `GET /healthz` returns `{"ok":true}`.

| Variable | Default | Range / notes |
|---|---|---|
| `DOMINUSNODE_MCP_HTTP_PORT` | unset (stdio) | 1-65535; `--http` uses 3333 |
| `DOMINUSNODE_MCP_HTTP_HOST` | `127.0.0.1` | bind address |
| `DOMINUSNODE_MCP_ALLOWED_ORIGINS` | empty | comma-separated bare origins |
| `DOMINUSNODE_MCP_SESSION_IDLE_MS` | `900000` | 60000-86400000; idle sessions are closed and their credentials cleared |
| `DOMINUSNODE_MCP_MAX_SESSIONS` | `1000` | 1-100000 |
| `DOMINUSNODE_MCP_RATE_LIMIT_PER_MIN` | `120` | 1-10000 requests per key per minute |
| `DOMINUSNODE_MCP_MAX_BODY_BYTES` | `1048576` | 1024-4194304 |

Optional compose service (not shipped in the repo's compose files; add it to your own):

```yaml
  mcp-remote:
    image: node:22-alpine
    command: ["npx", "-y", "@dominusnode/mcp-server", "--http"]
    environment:
      DOMINUSNODE_MCP_HTTP_HOST: 0.0.0.0
      DOMINUSNODE_MCP_HTTP_PORT: "3333"
      DOMINUSNODE_API_URL: https://api.example.com
    expose: ["3333"]   # publish only through your TLS reverse proxy
    restart: unless-stopped
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOMINUSNODE_API_KEY` | (none: bootstrap mode) | `dn_live_` API key |
| `DOMINUSNODE_API_URL` | `https://api.dominusnode.com` | API base URL |
| `DOMINUSNODE_PROXY_HOST` | `proxy.dominusnode.com` | Gateway host |
| `DOMINUSNODE_PROXY_URL` | `https://proxy.dominusnode.com:8443` | TLS gateway (`https://host[:port]`, default port 8443; a self-hosted coordinator publishes 8444, e.g. `https://proxy.example.org:8444`). Proxy fetches always use TLS to the gateway unless `DOMINUSNODE_PROXY_INSECURE=1` |
| `DOMINUSNODE_ALLOW_LOCAL_GATEWAY` | (unset) | `1` = allow a localhost, `.local`/`.internal` or private-IP gateway host (local demo, self-hosted gateway on a LAN). Off by default as an SSRF guard; prints a warning when set |
| `DOMINUSNODE_PROXY_CA_FILE` | (none) | Extra PEM CA for a privately issued gateway certificate (verification stays on) |
| `DOMINUSNODE_PROXY_INSECURE` | (unset) | `1` = use the plaintext HTTP listener (`DOMINUSNODE_HTTP_PROXY_PORT`). The API key is then sent in clear; a warning is printed to stderr. Local development only |
| `DOMINUSNODE_HTTP_PROXY_PORT` | `8080` | Gateway plaintext HTTP/CONNECT port (used only with `DOMINUSNODE_PROXY_INSECURE=1`) |
| `DOMINUSNODE_SOCKS5_PROXY_PORT` | `1080` | Gateway SOCKS5 port |
| `DOMINUSNODE_FETCH_TIMEOUT_MS` | `30000` | Fetch timeout (max 120000) |
| `DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES` | `10485760` | Fetch body cap (max 10MB) |
| `DOMINUSNODE_WALLET_KEY_FILE` | (none) | chmod-600 file with the linked wallet private key, for `node_register`, `payout_wallet_set` and `credits_withdraw` |
| `DOMINUSNODE_PAYOUT_WALLET_KEY_FILE` | (none) | chmod-600 file with the CURRENT payout wallet key, only to co-sign a payout-wallet change when it differs from the linked wallet |
| `DOMINUSNODE_NODE_KEY_FILE` | `~/.dominusnode/node.json` | Where `node_register` writes the node credential file (never overwritten) |
| `DOMINUSNODE_AGENT_SECRET` | (none) | Shared agent secret (32+ chars) sent as `X-DominusNode-Agent-Secret`; `MCP_AGENT_SECRET` is accepted as an alias |

Every API request carries `X-DominusNode-Agent: mcp`.

## Example: earn by contributing a node

```text
dominusnode_network_policy          # read ports, plaintext and attestation terms
dominusnode_network_pricing         # live price per GB and tier shares
dominusnode_node_register_challenge # preview what you sign
dominusnode_node_register(accept_attestation: true)
# -> Node key file (mode 0600): /home/agent/.dominusnode/node.json
# On the node machine (Linux; the image runs as uid 1001):
#   sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode
#   sudo install -o 1001 -g 1001 -m 600 ~/.dominusnode/node.json /etc/dominusnode/node.json
#   docker run -d --name dominusnode-node --restart unless-stopped \
#     -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro ghcr.io/0xcircuitbreaker/dominusnode-node
dominusnode_node_list / dominusnode_node_tier
```

## Directory listings and Docker

The package carries the metadata the MCP directories need. This package is alpha: listings must say so, and must say payouts are not live.

| File | Used by | Notes |
|---|---|---|
| `package.json` `mcpName` | Official MCP Registry | `io.github.0xcircuitbreaker/dominusnode`; must equal `name` in `server.json` |
| `server.json` | Official MCP Registry (`mcp-publisher publish`) | Current registry schema; npm package, stdio transport, env vars (`DOMINUSNODE_API_KEY` is marked secret) |
| `smithery.yaml` | Smithery | Local stdio server launched with `npx -y @dominusnode/mcp-server` |
| `Dockerfile` | Docker MCP Catalog, self-hosting | Multi-stage `node:22-alpine`, runs as the unprivileged `node` user, no secrets in the image |

Publish to the registry (after `npm publish` of the same version):

```bash
cd packages/mcp-server
mcp-publisher login github      # as the 0xcircuitbreaker GitHub account
mcp-publisher publish           # reads server.json
```

Keep `version` in `package.json` and both `version` fields in `server.json` in step on every release.

Docker:

```bash
docker build -t dominusnode-mcp packages/mcp-server
docker run -i --rm -e DOMINUSNODE_API_KEY dominusnode-mcp
# node registration / withdrawals: mount the wallet key read-only
docker run -i --rm -e DOMINUSNODE_API_KEY \
  -e DOMINUSNODE_WALLET_KEY_FILE=/run/secrets/wallet.key \
  -v "$PWD/wallet.key:/run/secrets/wallet.key:ro" dominusnode-mcp
```

The API key is read from the environment at run time and never written to the image or to tool output.

## Development

```bash
npm run build -w @dominusnode/shared -w @dominusnode/mcp-server
npx vitest run packages/mcp-server
```

## License

MIT
