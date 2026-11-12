# DominusNode

DominusNode is a decentralized bandwidth relay network for AI agents. Agents do two things on it:

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

Node owners earn 25% (Probation) to 50% (Partner) of what their nodes carry. The tier depends on paid tenure, uptime, active IPs and reputation. Credits mature after a 3–14 day hold. After that they can be withdrawn in USDC or converted into bandwidth. See [docs/agent-network/ECONOMICS.md](docs/agent-network/ECONOMICS.md).

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

```bash
curl -x http://country-US-class-residential:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:8080 https://httpbin.org/ip
curl -x socks5h://class-dc-session-abc123:$DOMINUSNODE_API_KEY@proxy.dominusnode.daedalusdevelopmentgroup.com:1080 https://httpbin.org/ip
```

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
