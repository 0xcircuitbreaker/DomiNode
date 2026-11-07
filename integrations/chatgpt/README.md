# @dominusnode/chatgpt

DominusNode for ChatGPT and the OpenAI API. DominusNode is a relay network for AI agents:
requests exit through residential, datacenter and mobile IPs contributed by node operators,
billed per GB from a prepaid wallet; operators earn a share by running the node agent.

Built on [`@dominusnode/sdk`](https://www.npmjs.com/package/@dominusnode/sdk) v2.

## Two ways to use it

### 1. Function-calling handler (all 19 tools)

```bash
npm install @dominusnode/chatgpt
export DOMINUSNODE_API_KEY=dn_live_...
```

Defaults: API `https://api.dominusnode.daedalusdevelopmentgroup.com`, relay gateway `proxy.dominusnode.daedalusdevelopmentgroup.com`. Override with `DOMINUSNODE_BASE_URL` / `DOMINUSNODE_PROXY_HOST`.

```ts
import OpenAI from "openai";
import { createDominusNodeFunctionHandler, openAIFunctions } from "@dominusnode/chatgpt";

const handler = createDominusNodeFunctionHandler(); // reads DOMINUSNODE_API_KEY
const openai = new OpenAI();
const res = await openai.chat.completions.create({ model, messages, tools: openAIFunctions() });
for (const call of res.choices[0].message.tool_calls ?? []) {
  const text = await handler(call.function.name, call.function.arguments); // JSON string or "Error: ..."
}
```

`functions.json` holds the same definitions (`{ name, description, parameters }`) for
Assistants / Responses tool configs; regenerate it with `npm run build && npm run gen:functions`.

### 2. Custom GPT Actions (schema only)

Paste `openapi.yaml` into the GPT's Action schema and set **Authentication: API Key, Bearer**
with a personal `dn_live_` key. The schema covers only routes that accept the raw key:

| operationId | Route |
|---|---|
| `network_policy` | `GET /v1/policy` |
| `network_pricing` | `GET /v1/pricing` |
| `network_stats` | `GET /v1/network/stats` |
| `node_list` | `GET /v1/nodes` |
| `node_tier` | `GET /v1/node/tier` |
| `credits_balance` | `GET /v1/credits` |
| `credits_convert` | `POST /v1/credits/convert` (Idempotency-Key header) |
| `payouts_list` | `GET /v1/payouts` |
| `report_session` | `POST /v1/sessions/{id}/report` |
| `x402_info` | `GET /api/x402/info` |

`fetch` and `proxy_url` go through the proxy gateway, and the wallet/usage/session routes
under `/api` need a JWT, so those tools are only available through the handler (mode 1), for
example behind your own Action server. `ai-plugin.json` is the matching legacy plugin manifest.

## The 19 tools

Function names are `dominusnode_<name>` (the handler also accepts the bare name).

| # | Tool | SDK call | What it does |
|---|---|---|---|
| 1 | `fetch` | `proxy.fetch` | GET/HEAD a public URL through the relay (country, ip_class, session_id, allow_http) |
| 2 | `proxy_url` | `proxy.buildUrl` | Proxy URL for other clients; the key is replaced by `${DOMINUSNODE_API_KEY}` |
| 3 | `network_policy` | `network.policy` | Acceptable-use policy and node floor guarantees (public) |
| 4 | `network_pricing` | `network.pricing` | Live per-GB prices per IP class and node revenue shares (public) |
| 5 | `network_stats` | `network.stats` | Online nodes by class and country (public) |
| 6 | `balance` | `wallet.getBalance` | Prepaid wallet balance |
| 7 | `transactions` | `wallet.getTransactions` | Wallet transaction history |
| 8 | `topup_crypto` | `wallet.topUpCrypto` | Create a crypto top-up invoice |
| 9 | `check_payment` | `wallet.getCryptoStatus` | Crypto invoice status |
| 10 | `usage` | `usage.get` | Bandwidth/cost summary for a date range |
| 11 | `active_sessions` | `sessions.getActive` | Open relay sessions |
| 12 | `report_session` | `sessions.report` | Report a misbehaving exit node |
| 13 | `node_list` | `nodes.list` | Your contributed relay nodes |
| 14 | `node_tier` | `nodes.tier` | Your node-operator tier and progress |
| 15 | `node_setup_guide` | static | How to earn by contributing an IP with the node agent |
| 16 | `credits_balance` | `credits.balance` | Node earnings (pending/available/frozen) |
| 17 | `credits_convert` | `credits.convert` | Convert node credit into wallet balance |
| 18 | `payouts_list` | `payouts.list` | Payout history |
| 19 | `x402_info` | `x402.getInfo` | x402 micropayment info (public) |

## Security

Enforced by the SDK: SSRF and DNS-rebinding checks on every resolved address, GET/HEAD only,
ports 80/443, no redirects, 10 MB cap, OFAC countries (CU, IR, KP, RU, SY) refused, plaintext
`http://` only with `allow_http` (visible to the exit node). Every result and error is scrubbed
of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs; parsed arguments drop
`__proto__`/`constructor`/`prototype`. The key is never a function argument or output.
Prices are never hardcoded: use `network_pricing`. Signed flows (node registration,
withdrawals, payout wallet) are not exposed; use the DominusNode MCP server or the SDK with a
signer key file.

## Upgrading from 1.x

2.0 removes Stripe/PayPal, plans, slots, account/MFA flows, key/team/agentic-wallet tools,
`dc-`/`residential-` prefixes and hardcoded prices. Exit selection is `country` + `ip_class`.
