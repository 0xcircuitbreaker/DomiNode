# DominusNode agent quickstart

DominusNode is a decentralized relay network for AI agents only. Requester agents send HTTP, HTTPS or SOCKS5 traffic through the gateway; it leaves through residential, mobile or datacenter IPs that other agents contribute by running the node agent. There is no third-party IP upstream. Humans use the platform only as admins.

## Endpoints

- Gateway: `https://proxy.dominusnode.com:8443`, the TLS (HTTPS) proxy listener, so proxy credentials never travel in clear text. Production refuses credentials on the plaintext HTTP/CONNECT (8080) and SOCKS5 (1080) listeners; those are for local gateways only. Self-hosted coordinators publish their TLS proxy on 8443 as well.
- API: `https://api.dominusnode.com` (public `/v1/pricing`, `/v1/policy`, `/v1/network/stats`; authenticated `/v1` agent routes).
- Status: `https://api.dominusnode.com/status` (human-readable page), `https://api.dominusnode.com/v1/network/history` (hourly snapshots), `/v1/network/incidents`, `/v1/network/wanted` (where nodes are needed).
- API-hosted discovery: `https://api.dominusnode.com/llms.txt` (live prices) and `https://api.dominusnode.com/.well-known/agent-tool.json`.
- SDKs and the MCP server use this API base by default (override with `baseUrl`, `base_url`, `DOMINUSNODE_API_URL`).

## Two ways to pay

1. **Per request, no signup (x402 or MPP).** Send a request without credentials. The gateway answers `402 Payment Required` with x402 payment requirements and, when MPP is enabled, a `WWW-Authenticate: Payment` challenge (Tempo). Pay, then retry with the proof (`X-PAYMENT` header for x402, `Authorization: Payment` or `Proxy-Authorization: Payment` for MPP). The paid amount caps the bytes of that request. Payers are mapped to a wallet-identity account automatically.
2. **Prepaid wallet.** Sign in with an EIP-191 wallet signature, create a `dn_live_` API key, and top up with crypto (Tempo or NOWPayments). Usage is billed per GB at the live price for the exit's IP class. Agents that own a node pay their tier's buyer discount (0% at Probation up to 25% at Partner by default) on wallet purchases. Card payments are not offered to agents.

## Proxy username flags

The API key goes in the proxy **password**. The username holds hyphen-joined flags:

| Flag | Meaning |
|---|---|
| `country-XX` | Exit country, ISO-3166 alpha-2. OFAC countries CU, IR, KP, RU, SY are refused. |
| `class-residential`, `class-dc`, `class-mobile`, `class-masked` | Exit IP class. `masked` (VPN/WARP/Tor egress) is the cheapest and opt-in: unflagged requests never use it |
| `session-<id>` | Sticky exit (1-64 alphanumerics) |
| `allowhttp-1` | Allow plaintext `http://` (the exit node can read it) |

With no flags, use `relay`.

```bash
export DOMINUSNODE_API_KEY=dn_live_YOUR_KEY
curl -x "https://country-US-class-residential:$DOMINUSNODE_API_KEY@proxy.dominusnode.com:8443" https://httpbin.org/ip
curl -x "https://class-dc-session-job42:$DOMINUSNODE_API_KEY@proxy.dominusnode.com:8443" https://httpbin.org/ip
```

HTTPS stays end-to-end TLS between the requester and the origin. Plain HTTP is refused unless `allowhttp-1` is set.

## SDKs

Six SDKs share one contract (`sdks/SDK_SURFACE.md`, v2): Node.js (`@dominusnode/sdk`), Python (`dominusnode`), Go, Rust, Java and C++. `proxy.fetch` allows GET/HEAD only, ports 80/443, checks SSRF and DNS rebinding on every resolved address, follows no redirects and caps bodies at 10 MB.

```python
import os
from dominusnode import DominusNodeClient

with DominusNodeClient(base_url="https://api.dominusnode.com") as dn:
    dn.connect_with_key(os.environ["DOMINUSNODE_API_KEY"])
    print(dn.network.pricing())
    res = dn.proxy.fetch("https://example.com", country="US", ip_class="residential")
```

```ts
import { DominusNodeClient } from "@dominusnode/sdk";
const dn = new DominusNodeClient({ baseUrl: "https://api.dominusnode.com" });
await dn.connectWithKey(process.env.DOMINUSNODE_API_KEY!);
const res = await dn.proxy.fetch("https://example.com/", { country: "DE", sessionId: "job42" });
```

## Framework integrations

27 integrations (LangChain, CrewAI, LlamaIndex, Vercel AI, Mastra, n8n and others) expose the same 19-tool set: fetch, proxy_url, network_policy, network_pricing, network_stats, balance, transactions, topup_crypto, check_payment, usage, active_sessions, report_session, node_list, node_tier, node_setup_guide, credits_balance, credits_convert, payouts_list, x402_info.

## Burn reports

If an exit is blocked or serves captchas, report it: `POST /v1/sessions/:id/report` with `{"reason": "blocked" | "captcha" | "rate_limited" | "slow" | "bad_content" | "other"}` (at most 5 per node per UTC day). Reports feed node reputation, weighted by your paid spend on that node.

See also: [MCP setup](https://dominusnode.com/docs/mcp.md), [payments and pricing](https://dominusnode.com/docs/payments.md), [policy](https://dominusnode.com/docs/policy.md).
