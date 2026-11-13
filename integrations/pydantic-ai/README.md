# dominusnode-pydanticai

DominusNode tools for [Pydantic AI](#usage): 19 tools for the DominusNode **agent relay network**.
Agents fetch the web through exit nodes contributed by other agents, pay per GB from a prepaid
wallet at the live price from `network_pricing`, and can earn credits by contributing their own IP
with the node agent (`node_setup_guide`).

Version 2 is built on the official Python SDK [`dominusnode`](../../sdks/python) (v2). All HTTP,
SSRF and DNS-rebinding checks, proxy tunnelling and credential scrubbing come from the SDK.

## Install

```bash
pip install dominusnode-pydanticai
# from source, with the local SDK
pip install -e ../../sdks/python -e ".[dev]"
```

Defaults: API `https://api.dominusnode.com`, relay gateway `proxy.dominusnode.com`. Override with `DOMINUSNODE_BASE_URL` / `DOMINUSNODE_PROXY_HOST`. Proxy traffic uses TLS to the gateway (HTTPS proxy, port 8443). For a self-hosted coordinator set `DOMINUSNODE_PROXY_URL=https://<proxy-host>:8444`; `DOMINUSNODE_PROXY_INSECURE=1` selects plaintext 8080 for local development only (production gateways refuse it).

Set your key in the environment (it is never a tool argument and never appears in tool output):

```bash
export DOMINUSNODE_API_KEY=dn_live_...
# optional: DOMINUSNODE_BASE_URL, DOMINUSNODE_PROXY_HOST
```

## Usage

```python
from pydantic_ai import Agent
from dominusnode_pydanticai import DominusNodeToolkit

agent = Agent("openai:gpt-4o", toolsets=[DominusNodeToolkit().toolset()])  # key from DOMINUSNODE_API_KEY
print(agent.run_sync("What does residential relay traffic cost per GB?").output)
```

Tools are exposed as `dominusnode_<tool>` Pydantic AI tools in a `FunctionToolset`.

## The 19 tools

| # | Tool | SDK call | What it does |
|---|---|---|---|
| 1 | `fetch` | `proxy.fetch` | GET/HEAD a URL through the relay (country, ip_class, session_id, allow_http) |
| 2 | `proxy_url` | `proxy.build_url` | Proxy URL/username for any client; key shown only as `<DOMINUSNODE_API_KEY>` |
| 3 | `network_policy` | `network.policy` | Allowed ports/methods, blocked targets and countries |
| 4 | `network_pricing` | `network.pricing` | Live per-GB prices by IP class and node earning shares |
| 5 | `network_stats` | `network.stats` | Online nodes by class and country |
| 6 | `balance` | `wallet.get_balance` | Prepaid wallet balance |
| 7 | `transactions` | `wallet.get_transactions` | Prepaid wallet transactions |
| 8 | `topup_crypto` | `wallet.top_up_crypto` | Crypto top-up invoice ($10-$1,000) |
| 9 | `check_payment` | `wallet.get_crypto_status` | Crypto invoice status |
| 10 | `usage` | `usage.get` | Traffic usage summary and records |
| 11 | `active_sessions` | `sessions.get_active` | Active relay sessions |
| 12 | `report_session` | `sessions.report` | Report a bad exit session |
| 13 | `node_list` | `nodes.list` | Your contributed nodes |
| 14 | `node_tier` | `nodes.tier` | Node operator tier and progress |
| 15 | `node_setup_guide` | `(static)` | How to earn by running the node agent |
| 16 | `credits_balance` | `credits.balance` | Earned credits (µUSD) |
| 17 | `credits_convert` | none (signed flow) | Points to the MCP server or SDK (needs a wallet signature) |
| 18 | `payouts_list` | `payouts.list` | Payouts of earned credits |
| 19 | `x402_info` | `x402.get_info` | x402 micropayment info |

## Security

- `fetch` is GET/HEAD only, ports 80/443, no redirects, 10 MB cap, private and internal targets
  refused after DNS resolution (all addresses). `https` by default; plaintext `http://` needs
  `allow_http=true` and is visible to the exit node.
- Sanctioned countries (CU, IR, KP, RU, SY) are refused.
- Every error and result is scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.
- Signing flows (node registration, withdrawals, payout wallet) are not exposed as LLM tools; use the
  DominusNode MCP server or the SDK with a signer key file.

## Tests

```bash
pip install -e ../../sdks/python -e ".[dev]"
pytest
```
