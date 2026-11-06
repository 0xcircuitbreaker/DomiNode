# @dominusnode/pi-extension

[pi](https://github.com/badlogic/pi-mono) coding-agent extension for the DominusNode relay network: AI agents fetch the web through residential, datacenter and mobile IPs contributed by node operators, pay per GB from a prepaid wallet, and can earn credit by contributing their own IP.

Built on [`@dominusnode/sdk`](https://www.npmjs.com/package/@dominusnode/sdk) v2: the
integration only describes tools for the model and maps arguments to SDK calls.

## Install

```bash
pi install npm:@dominusnode/pi-extension
```

## Configure

```bash
export DOMINUSNODE_API_KEY=dn_live_...          # required for account tools
export DOMINUSNODE_BASE_URL=https://api.dominusnode.com   # optional
export DOMINUSNODE_PROXY_HOST=proxy.dominusnode.com       # optional
```

## Usage

`package.json` declares `pi.extensions` (`./dist/index.js`) and `pi.skills` (`./skills`). The default export `dominusNodeExtension(pi)` calls `pi.registerTool({ name, label, description, parameters, execute })` for each tool, with TypeBox (`typebox` 1.x) schemas. `execute(toolCallId, params, signal, onUpdate, ctx)` returns `{ content: [{ type: "text", text }], details }`.

The skill `skills/use-dominus-proxy.md` tells the agent when and how to use the tools.

## The 19 tools

Tool names are `dominusnode_<name>` (e.g. `dominusnode_fetch`).

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

Security is enforced by `@dominusnode/sdk`: SSRF and DNS-rebinding checks on every
resolved address, GET/HEAD only, ports 80/443, no redirects, 10 MB cap, OFAC countries
(CU, IR, KP, RU, SY) refused, plaintext `http://` only with `allow_http` (visible to the
exit node). Every error and result is scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_`
keys and JWTs. The API key is read from `DOMINUSNODE_API_KEY` (or the framework's
credentials store) and is never a tool argument or part of a tool result.

Prices are never hardcoded: ask the agent to call `network_pricing`.

Signed flows (node registration, withdrawals, payout wallet) are not exposed as LLM tools.
Use the DominusNode MCP server or `@dominusnode/sdk` with a local signer key file.

## Upgrading from 1.x

2.0 is a breaking release. Removed: Stripe/PayPal top-ups, plans, slots, email/password and
MFA flows, API key / team / agentic-wallet management tools, `dc-`/`residential-` pool
prefixes, hardcoded $/GB prices and the integration's own HTTP/SSRF code. Exit selection is
now `country` + `ip_class` (`residential`, `dc`, `mobile`) on the relay network.
