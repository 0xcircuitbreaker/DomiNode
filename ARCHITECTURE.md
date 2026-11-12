# DominusNode Architecture

DominusNode is a relay network where AI agents both buy bandwidth and supply the exit IPs. This document is an overview. The full specification lives in `docs/agent-network/`:

| Doc | Covers |
|---|---|
| [DESIGN.md](docs/agent-network/DESIGN.md) | Threat model, tunnel protocol, node selection, settlement, schema |
| [ECONOMICS.md](docs/agent-network/ECONOMICS.md) | Pricing, tiers, maturity holds, payouts |
| [PAYMENTS.md](docs/agent-network/PAYMENTS.md) | x402, MPP and Tempo rails |
| [AGENT_API.md](docs/agent-network/AGENT_API.md) | `/v1` agent self-service API (credits, payouts, nodes) |
| [ADMIN_API.md](docs/agent-network/ADMIN_API.md) | Admin controls |
| [ABUSE_CONTROLS.md](docs/agent-network/ABUSE_CONTROLS.md) | Protections for contributors and the network |
| [DEPLOYMENT.md](docs/agent-network/DEPLOYMENT.md) | Coordinator key, SPKI pins, ASN DB, tunnel ingress |

## Components

```
                 ┌───────────────────────── gateway (packages/proxy-gateway) ─────────────────────────┐
requester ──────▶│ HTTP :8080 / SOCKS5 :1080 → auth (API key | x402 | MPP) → policy → node selection │
 (agent)         │ → reserve balance → byte meter → settle split (µUSD)                               │
                 │ tunnel coordinator (wss /v1/tunnel, ed25519-signed CHALLENGE)                      │
                 └──────────────────────────────────────┬─────────────────────────────────────────────┘
                                                        │ outbound tunnel dialled by the node
                                                        ▼
                                          node-agent (packages/node-agent)
                                          SSRF floor, DNS re-check, port policy,
                                          deny lists, rate/GB caps → target
```

| Package | Role |
|---|---|
| `shared` | DB pool, schema, repositories, auth helpers, credential scrubbing |
| `proxy-gateway` | Requester front end, tunnel coordinator, node selection, metering, settlement, background jobs |
| `node-agent` | Exit node. It dials out (no inbound port), keeps a node-side floor that cannot be disabled, and enforces local caps |
| `metering` | Cost calculation and usage records |
| `billing` | x402, MPP, Tempo and NOWPayments rails; admin-only Stripe/PayPal |
| `dashboard` | REST API: `/v1` agent routes (raw API key), `/api` (JWT), admin |
| `mcp-server` | 65 authenticated plus 12 bootstrap MCP tools |
| `frontend`, `extension` | Admin dashboard and browser extension |

## Request lifecycle

1. **Authenticate.** The requester presents a `dn_live_` key in the proxy password, or pays per request with x402 or MPP after a 402 offer.
2. **Parse flags.** The username flags (`country-XX`, `class-…`, `session-…`, `allowhttp-1`) are parsed. Plain HTTP without `allowhttp-1` gets `400 PLAINTEXT_DISABLED`.
3. **Validate the target.** The gateway runs SSRF and DNS-rebinding checks, then applies the port and category policy.
4. **Select a node.** A node is chosen by class, geography, health and reputation. Self-dealing nodes (same owner, wallet, team or egress /24) are excluded. If no node is eligible, the request fails closed with 503.
5. **Start the session.** The price and the node's tier share are snapshotted, and the requester balance is reserved.
6. **Relay.** The stream runs over the node tunnel. The node re-resolves DNS, checks every address and dials the checked IP. TLS stays end to end.
7. **Settle.** Billing uses the gateway byte count. In one transaction the requester is debited in cents and the node and platform credits are recorded in µUSD. Node-reported bytes only feed dispute detection.

## Trust model

- Exit nodes and requesters are both untrusted. Only the gateway counts billable bytes.
- A node never declares its own IP. The coordinator records the tunnel peer address and classifies it with ASN and GeoIP data.
- Sybil resistance comes from wallet signature plus proof-of-work at registration, per-/32, /24 and ASN caps, credit only from other principals' paid traffic, maturity holds with clawback, and reputation that starts at 0.3.
- Everything fails closed: a missing policy, split config or eligible node rejects the request and never sends it out directly.

## Money

- Prices per class live in `network_pricing`. The defaults are $0.50/GB residential/mobile and $0.20/GB dc.
- The node share runs from 25% to 50% by tier and is set per owner by a daily job.
- Split ledger and node credits use `BIGINT` µUSD. Legacy `wallets.balance_cents` stays in cents.
- Payouts go out in USDC to a payout wallet that the account's linked wallet has signed for.

## Security conventions

The repo-wide rules are in `.claude/rules/`. Highlights: no `SELECT *` or `RETURNING *`, every CHECK has a floor and a ceiling, check-then-act runs in transactions with `FOR UPDATE`, in-memory Maps have size caps, `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` and JWTs are scrubbed from errors, and OFAC countries are refused.
