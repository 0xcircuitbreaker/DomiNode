# DominusNode

DominusNode is a bandwidth relay network for AI agents: an agent-contributed exit network with an operator-run gateway (federation planned). Agents do two things on it:

- **Buy bandwidth.** They send HTTP, HTTPS or SOCKS5 traffic through the gateway and pay per GB, or per request with x402 or MPP.
- **Contribute IPs.** They run the node agent on a residential, mobile or datacenter connection and earn a share of the paid traffic that exits through it.

The network has no third-party IP upstream. Every exit is a node run by an agent. The gateway alone counts billable bytes, and exit nodes are treated as untrusted. Humans use the platform only as admins.

## How it works

```
requester agent ──HTTP/CONNECT/SOCKS5──▶ gateway ──tunnel (wss, TLS 1.3, pinned)──▶ node-agent ──▶ target
                 (API key or x402/MPP)    meter, select node,                         SSRF floor, port
                                          settle split                                policy, caps
```

- HTTPS stays end-to-end TLS between the requester and the origin. Plain HTTP is refused unless the requester sets `allowhttp-1`, because the exit can read it.
- Node selection excludes self-dealing (same owner, wallet, team or /24) and applies per-IP, per-/24 and per-ASN caps.
- Each settled charge is split between the node owner and the platform in integer micro-USD.

## Pricing and earnings

Prices are per IP class and set by the admin in `network_pricing`. The defaults are:

| Class | Price per GB |
|---|---|
| `residential` / `mobile` | $0.50 |
| `dc` | $0.20 |

Node owners earn 25% (Probation) to 50% (Partner) of what their nodes carry. The tier depends on paid tenure, uptime, active IPs and reputation. Credits mature after a 3–14 day hold. Today you can convert matured credits into bandwidth; USDC withdrawals are built but disabled in alpha (`PAYOUTS_DISABLED`). See [docs/agent-network/ECONOMICS.md](docs/agent-network/ECONOMICS.md).

## Paying

- **x402** and **MPP** (Tempo): pay per request inside the HTTP 402 flow, with no account needed.
- **Tempo** and **NOWPayments** crypto: prepaid wallet top-ups.
- Stripe and PayPal exist only for admin operations. Agents never see them.

See [docs/agent-network/PAYMENTS.md](docs/agent-network/PAYMENTS.md).

## Using the proxy

The API key goes in the password field. The username holds hyphen-joined flags:

| Flag | Meaning |
|---|---|
| `country-XX` | Exit country (OFAC countries CU, IR, KP, RU and SY are refused) |
| `class-residential` / `class-dc` / `class-mobile` | IP class |
| `session-<id>` | Sticky session |
| `allowhttp-1` | Allow plaintext HTTP (the exit can read it) |

With no flags, use `relay`.

Use the TLS proxy on port 8443 so your API key never crosses the network in clear:

```bash
# Recommended: HTTPS proxy (credentials sent over TLS)
curl -x https://country-US-class-residential:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:8443 https://httpbin.org/ip
curl -x https://relay:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:8443 https://httpbin.org/ip
```

Ports 8080 (HTTP proxy) and 1080 (SOCKS5) are **plaintext**: the
`Proxy-Authorization` header, including your API key, is readable on the path to
the gateway. Use them only on trusted networks or for local development:

```bash
# Plaintext listeners (API key sent in clear)
curl -x http://class-dc:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:8080 https://httpbin.org/ip
curl -x socks5h://class-dc-session-abc123:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:1080 https://httpbin.org/ip
```

## Get an API key

Agents sign in with a wallet; there is no email/password signup.

1. `POST https://dominusnode.daedalusdevelopmentgroup.com/api/auth/wallet/challenge` with
   `{"address": "0x…"}` → `{message, nonce, expiresAt}`.
2. Sign `message` exactly as returned with EIP-191 `personal_sign`, then
   `POST /api/auth/wallet/verify` with `{"address", "signature"}` → `{token, refreshToken, user}`.
3. `POST /api/keys` with `Authorization: Bearer <token>` and `{"label": "my-agent"}`
   → the `dn_live_…` key, shown once. Store it in `DOMINUSNODE_API_KEY`.

The SDKs and the MCP server wrap these steps. Or skip the key: pay per request
with x402 or MPP.

## Troubleshooting

| You see | Meaning | Fix |
|---|---|---|
| `407 Proxy Authentication Required` | No or invalid credentials | Put the `dn_live_` key in the proxy **password** field; username is flags or `relay` |
| `402 Payment Required` (`INSUFFICIENT_BALANCE`) | Authenticated, but the wallet cannot cover the reservation | Top up (crypto) or claim starter credits; or pay per request with x402/MPP from the 402 body |
| `503 NO_NODES_AVAILABLE` | No eligible exit node for your flags (country, class, sticky session) | Loosen `country-`/`class-` flags or retry later; `GET /v1/network/stats` shows what is online |
| `503 QUOTE_CLASS_MISMATCH` | An x402/MPP payment was quoted for a class no node could serve | Request a new quote, or drop the class flag |
| `503 PAYOUTS_DISABLED` | USDC withdrawals are disabled in alpha | Convert credits into bandwidth (`POST /v1/credits/convert`) |
| `400 PLAINTEXT_DISABLED` (plain `http://` target) | The exit node could read plaintext HTTP | Use `https://` targets, or add `allowhttp-1` if you accept that |
| Warning about credentials over plaintext | You used port 8080/1080 | Switch to the TLS proxy on 8443 |

## Tooling for agents

- **MCP server** ([packages/mcp-server](packages/mcp-server)): 65 tools, plus 12 bootstrap tools, for relay fetch, nodes, earnings and wallets.
- **SDKs v2** ([sdks/](sdks)): Node.js, Python, Go, Rust, Java and C++. They share one contract in [sdks/SDK_SURFACE.md](sdks/SDK_SURFACE.md).
- **27 framework integrations** ([integrations/](integrations)): LangChain, CrewAI, LlamaIndex, Vercel AI, Mastra, n8n and others. All of them expose the same 19-tool set.
- **Node agent** ([packages/node-agent](packages/node-agent)): the `dominusnode-node` binary for contributing an IP.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/shared` | Types, DB, auth, schema, repositories |
| `packages/proxy-gateway` | Relay gateway and node tunnel coordinator |
| `packages/node-agent` | Exit node agent |
| `packages/metering` | Usage and cost calculation |
| `packages/billing` | Payment rails |
| `packages/dashboard` | REST API (`/v1` agent routes, `/api`, admin) |
| `packages/mcp-server` | MCP server |
| `packages/frontend` | Admin dashboard (React) |
| `packages/extension` | Browser extension |
| `docs/agent-network/` | Design, economics, payments, APIs, abuse controls, deployment |

## Development

```bash
docker compose up -d     # PostgreSQL
npm install
npm run build
npm run db:migrate
npx vitest run
npm run start:api        # :3000
npm run start:proxy      # :8080 HTTP, :1080 SOCKS5, node tunnel
```

For production setup (coordinator signing key, SPKI pins, ASN database and tunnel ingress), see [docs/agent-network/DEPLOYMENT.md](docs/agent-network/DEPLOYMENT.md). For the architecture overview, see [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
