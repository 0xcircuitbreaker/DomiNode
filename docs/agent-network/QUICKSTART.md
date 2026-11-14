# Five-minute agent quickstart

One path from nothing to a first relayed request. Every step is a plain HTTP
call an AI agent can make on its own; humans are not needed (they are
admin-only on this network).

| What | Host and port |
|---|---|
| API | `https://api.dominusnode.com` |
| HTTPS proxy (TLS, use this) | `proxy.dominusnode.com:8443` |
| SOCKS5 over TLS | `proxy.dominusnode.com:1443` (where the gateway enables it) |
| Node tunnel (node agents only, not for requesters) | `wss://relay.dominusnode.com/v1/tunnel` (gateway port 9443) |
| Plaintext HTTP 8080 / SOCKS5 1080 | local gateways only; production refuses credentials there |

Self-hosted coordinators use the same ports on their own host
(`proxy.example.org:8443`, `proxy.example.org:1443`, tunnel `:9443`).

## Minute 0-1: read policy and prices (no auth)

```bash
curl -s https://api.dominusnode.com/v1/policy | jq .
curl -s https://api.dominusnode.com/v1/pricing
```

Prices are live and admin-tunable: never hardcode them. Check that nodes are
online for the class and country you want:

```bash
curl -s https://api.dominusnode.com/v1/network/stats
```

## Minute 1-3: identity and funds

Pick one:

1. **No signup, pay per request (x402 or MPP).** Send a proxy request without
   credentials to `https://proxy.dominusnode.com:8443`. The gateway answers
   `402 Payment Required` with x402 requirements (and an MPP
   `WWW-Authenticate: Payment` challenge when enabled). Pay with any x402
   client and retry with the `X-PAYMENT` proxy header. Rail details:
   `GET https://api.dominusnode.com/api/x402/info`. Skip to minute 3.
2. **Prepaid wallet with an API key.** Sign in with an EIP-191 wallet
   signature (`POST /api/auth/wallet/challenge`, then `/verify`), create a
   `dn_live_` key, and top up with crypto
   (NOWPayments: `POST /api/wallet/topup/crypto`, minimum $10; Tempo: `POST /api/wallet/topup/tempo`). The SDKs and the
   MCP server (`npx -y @dominusnode/mcp-server`, bootstrap mode without a key)
   do all of this for you. See [AGENT_API.md](AGENT_API.md) and
   [PAYMENTS.md](PAYMENTS.md).

Keep the key in an environment variable, never in a command argument:

```bash
read -rs DOMINUSNODE_API_KEY && export DOMINUSNODE_API_KEY
```

## Minute 3-5: first relayed request

```bash
# The key is the proxy password; the username carries flags (or "relay").
# It reaches curl through a config on a file descriptor, so it never shows in ps.
curl -x https://proxy.dominusnode.com:8443 \
  -K <(printf 'proxy-user = "country-US-class-residential:%s"\n' "$DOMINUSNODE_API_KEY") \
  https://httpbin.org/ip
```

HTTPS stays end-to-end TLS through the exit node. Flags: `country-XX`,
`class-residential|dc|mobile|masked` (masked is opt-in and cheapest),
`session-<id>`, `allowhttp-1`.

## Smoke check in one command

`scripts/quickstart-smoke.sh` runs the whole path and prints the next step on
each failure. The key comes from the environment only:

```bash
export DOMINUSNODE_API_KEY            # already set above
scripts/quickstart-smoke.sh
# Self-host or staging:
DN_API_URL=https://api.example.org DN_PROXY_HOST=proxy.example.org scripts/quickstart-smoke.sh
```

| Step | Checks | On failure |
|---|---|---|
| 1 | `GET /v1/policy` | API unreachable: check `DN_API_URL` and the status page |
| 2 | `GET /v1/pricing` | same |
| 3 | wallet balance (`GET /v1/wallet` with the raw API key; no token is minted) | key rejected: create a new key; zero balance: top up with crypto or use x402 |
| 4 | fetch through `proxy.dominusnode.com:8443` | `402`: fund the wallet or pay per request; no node: see `https://api.dominusnode.com/status` and `/v1/network/wanted` |

Optional variables: `DN_FLAGS` (proxy username, default `relay`),
`DN_TARGET_URL` (default `https://example.com/`), `DN_PROXY_PORT` (default
8443), `DN_CA_BUNDLE`.

## Next

- MCP clients: [packages/mcp-server](../../packages/mcp-server)
- SDKs: [sdks/SDK_SURFACE.md](../../sdks/SDK_SURFACE.md)
- Earn by contributing an IP: run the node agent (`packages/node-agent`)
