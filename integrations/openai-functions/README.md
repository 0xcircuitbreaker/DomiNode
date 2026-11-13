# DominusNode for OpenAI-compatible function calling

Gives agents the DominusNode AI-agent relay network: fetch public web pages through exit IPs contributed by
other agents' nodes, pay per GB from a prepaid crypto wallet, and earn by contributing your own IP with the
node agent. Built on the official DominusNode SDK v2; HTTP, SSRF/DNS-rebinding protection, OFAC refusal and
credential scrubbing all come from the SDK.

## Install

```bash
npm install @dominusnode/openai-functions   # TypeScript
pip install dominusnode-openai-functions    # Python
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DOMINUSNODE_API_KEY` | yes | Your `dn_live_` API key. Read from the environment/config only; never a tool argument, never in tool output. |
| `DOMINUSNODE_BASE_URL` | no | API base URL (default `https://api.dominusnode.com`). |
| `DOMINUSNODE_PROXY_HOST` | no | Gateway host (default `proxy.dominusnode.com`). |
| `DOMINUSNODE_PROXY_URL` | no | `https://host[:port]` of the gateway's TLS proxy (default port 8443; self-hosted coordinators use 8444). |
| `DOMINUSNODE_PROXY_INSECURE` | no | `1` = plaintext gateway on 8080 (local development only; production refuses it). |

## Usage

This package has a TypeScript part (`@dominusnode/openai-functions`, on `@dominusnode/sdk` v2) and a Python part
(`dominusnode-openai-functions`, on the `dominusnode` SDK v2). Both expose the same 19 JSON Schema function
definitions, kept identical to `functions.json` by tests in each language. The definitions work with any
OpenAI-compatible tool-calling API.

### TypeScript (openai, Chat Completions)

```ts
import OpenAI from "openai";
import { chatCompletionTools, createDominusNodeFunctionHandler } from "@dominusnode/openai-functions";

const openai = new OpenAI();
const handle = createDominusNodeFunctionHandler();          // key from DOMINUSNODE_API_KEY
const completion = await openai.chat.completions.create({ model: "gpt-4.1", messages, tools: chatCompletionTools });
for (const call of completion.choices[0].message.tool_calls ?? []) {
  const content = await handle(call.function.name, call.function.arguments);   // raw JSON string accepted
  messages.push({ role: "tool", tool_call_id: call.id, content });
}
```

For the Responses API use `responsesTools`; the plain definitions are `functionDefinitions` / `functions.json`.

### Python (openai)

```python
from openai import OpenAI
from dominusnode_openai_functions import chat_completion_tools, create_dominusnode_function_handler

handle = create_dominusnode_function_handler()      # key from DOMINUSNODE_API_KEY
resp = OpenAI().chat.completions.create(model="gpt-4.1", messages=messages, tools=chat_completion_tools())
for call in resp.choices[0].message.tool_calls or []:
    messages.append({"role": "tool", "tool_call_id": call.id,
                     "content": handle(call.function.name, call.function.arguments)})
```

Handlers return JSON strings; errors are `{"error": "..."}` with credentials scrubbed.

## Tools (v2 standard set, 19)

| # | Tool | What it does |
|---|---|---|
| 1 | `dominusnode_fetch` | Fetch a public URL through the DominusNode relay network (GET or HEAD only, ports 80/443, no redirects followed, 10 MB cap, private/internal targets refused). |
| 2 | `dominusnode_proxy_url` | Build a relay gateway proxy URL for use in other HTTP clients. |
| 3 | `dominusnode_network_policy` | Relay network policy: allowed ports, plaintext (allowhttp) rules, blocked ranges, sanctioned countries and node attestation terms. |
| 4 | `dominusnode_network_pricing` | Live per-GB prices by exit IP class (residential, dc, mobile) and node tier revenue shares. |
| 5 | `dominusnode_network_stats` | Relay network statistics: online nodes, exit countries and IP classes. |
| 6 | `dominusnode_balance` | Prepaid requester wallet balance (cents) used to pay for relayed traffic. |
| 7 | `dominusnode_transactions` | Requester wallet transaction history (top-ups, usage debits, credit conversions). |
| 8 | `dominusnode_topup_crypto` | Create a crypto invoice to top up the requester wallet ($10-$1,000). |
| 9 | `dominusnode_check_payment` | Status of a crypto top-up invoice created by topup_crypto. |
| 10 | `dominusnode_usage` | Relayed traffic usage summary (bytes and cost) for an optional ISO 8601 date range. |
| 11 | `dominusnode_active_sessions` | Your currently active relay sessions (id, start time, status). |
| 12 | `dominusnode_report_session` | Report a burned or bad exit for one of your relay sessions so the network can rotate it. |
| 13 | `dominusnode_node_list` | Relay nodes you contribute (status, observed IP class, last seen). |
| 14 | `dominusnode_node_tier` | Your node-operator tier, revenue share and progress toward the next tier (tenure, uptime, active IPs, reputation). |
| 15 | `dominusnode_node_setup_guide` | Step-by-step instructions to earn by contributing an IP: run the DominusNode node agent, register a node, and how tiers and the self-dealing rule work. |
| 16 | `dominusnode_credits_balance` | Node-operator earnings: pending and available credit (µUSD). |
| 17 | `dominusnode_credits_convert` | Explains how to convert node credits into wallet balance. Conversion needs a wallet signature, so it runs through the DominusNode MCP server or SDK with a signer key file, not through this tool. |
| 18 | `dominusnode_payouts_list` | Your USDC payouts of node earnings with status and transaction hash. |
| 19 | `dominusnode_x402_info` | x402 micropayment info: facilitators, networks and server-reported prices. |

Notes for agents:

- Prices are never hardcoded: call `network_pricing` for the live per-GB price by IP class (residential, dc, mobile).
- `fetch` is GET/HEAD only on ports 80/443, follows no redirects and caps bodies at 10 MB. Plaintext `http://`
  needs `allow_http` and is visible to the exit node.
- Routing: `country` (ISO code; sanctioned countries refused), `ip_class`, `session_id` (sticky exit).
- Signing flows (node register, withdraw, payout wallet) are deliberately not tools here; use the node agent CLI,
  the DominusNode MCP server, or the SDK with a signer key file.

## Development (JS part)

`@dominusnode/sdk` 2.x may not be on npm yet; link the in-repo SDK for local builds and tests:

```bash
(cd ../../sdks/node && npm ci && npm run build)
npm install && npm run link-sdk
npx tsc && npx vitest run
```

`functions.json` is generated from `core.ts`; after changing a spec rebuild and regenerate it
(`node -e 'import("./dist/handler.js").then(m=>require("fs").writeFileSync("functions.json", JSON.stringify(m.functionDefinitions,null,2)+"\n"))'`).
Tests in both languages fail if it is stale.

## Testing

```bash
pip install -e ../../sdks/python -e '.[dev]'   # or npm install for the JS part
python -m pytest -q python_tests
```

## License

MIT
