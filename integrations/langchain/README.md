# dominusnode-langchain

LangChain tools for the **DominusNode AI-agent relay network** (v2). Agents fetch the web through
exit IPs contributed by other operators, pay per GB from a prepaid wallet (live prices from
`dominusnode_network_pricing`, nothing hardcoded), and can earn by contributing their own IP
with the DominusNode node agent.

Built on the official [`dominusnode`](../../sdks/python) Python SDK v2: all HTTP, SSRF and
DNS-rebinding checks, gateway username flags and validation come from the SDK.

```bash
pip install dominusnode-langchain
export DOMINUSNODE_API_KEY=dn_live_...   # read from the environment, never a tool argument
```

Defaults: API `https://api.dominusnode.com`, relay gateway `proxy.dominusnode.com`. Override with `DOMINUSNODE_BASE_URL` / `DOMINUSNODE_PROXY_HOST`.

## Usage

```python
from langchain.agents import create_agent
from dominusnode_langchain import DominusNodeToolkit

tools = DominusNodeToolkit().get_tools()          # 19 StructuredTools
agent = create_agent("anthropic:claude-sonnet-4-5", tools=tools)
agent.invoke({"messages": [{"role": "user", "content": "What does residential traffic cost per GB?"}]})
```

`DominusNodeToolkit` is a LangChain `BaseToolkit`; each tool is a `StructuredTool` with a
pydantic `args_schema`, and errors come back as scrubbed `Error: ...` strings.

## The 19 tools

| # | Tool | What it does | SDK call |
|---|---|---|---|
| 1 | `dominusnode_fetch` | Fetch a public URL through the relay (GET/HEAD; country, ip_class, session_id, allow_http) | `proxy.fetch` |
| 2 | `dominusnode_proxy_url` | Gateway proxy URL/username for your own client (key shown as a placeholder) | `proxy.build_username` |
| 3 | `dominusnode_network_policy` | Relay policy: ports, blocked targets, sanctioned countries | `network.policy` |
| 4 | `dominusnode_network_pricing` | Live per-GB prices by IP class and node earning shares | `network.pricing` |
| 5 | `dominusnode_network_stats` | Online nodes, countries, IP classes | `network.stats` |
| 6 | `dominusnode_balance` | Prepaid wallet balance | `wallet.get_balance` |
| 7 | `dominusnode_transactions` | Wallet transactions | `wallet.get_transactions` |
| 8 | `dominusnode_topup_crypto` | Crypto top-up invoice ($10-$1,000) | `wallet.top_up_crypto` |
| 9 | `dominusnode_check_payment` | Crypto invoice status | `wallet.get_crypto_status` |
| 10 | `dominusnode_usage` | Bandwidth usage and cost | `usage.get` |
| 11 | `dominusnode_active_sessions` | Active sessions (no IPs) | `sessions.get_active` |
| 12 | `dominusnode_report_session` | Report a bad session | `sessions.report` |
| 13 | `dominusnode_node_list` | Your relay nodes | `nodes.list` |
| 14 | `dominusnode_node_tier` | Node-operator tier and share | `nodes.tier` |
| 15 | `dominusnode_node_setup_guide` | Steps to earn by running the node agent | `static text` |
| 16 | `dominusnode_credits_balance` | Earned node credits | `credits.balance` |
| 17 | `dominusnode_credits_convert` | Convert credits into wallet balance | `credits.convert` |
| 18 | `dominusnode_payouts_list` | On-chain payouts | `payouts.list` |
| 19 | `dominusnode_x402_info` | x402 micropayment info | `x402.get_info` |

## Security

- The API key comes from `DOMINUSNODE_API_KEY` (or constructor config). It is never a tool
  argument, never in a tool schema and never in tool output; `dominusnode_proxy_url` returns a
  `<DOMINUSNODE_API_KEY>` placeholder.
- Every result and error is scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.
- `dominusnode_fetch` (via the SDK): GET/HEAD only, ports 80/443, private/local hosts and
  DNS-rebinding refused, redirects not followed, 10 MB cap, sanctioned countries refused.
  Plaintext `http://` needs `allow_http=true` and is visible to the exit node.
- Signed flows (node registration, withdrawals, payout wallet) are not LLM tools: use the
  DominusNode MCP server, the node agent, or the SDK with a signer key file.

Configuration env vars: `DOMINUSNODE_API_KEY`, `DOMINUSNODE_BASE_URL`, `DOMINUSNODE_PROXY_HOST`,
`DOMINUSNODE_PROXY_PORT`.

## Development

```bash
pip install -e ../../sdks/python -e '.[dev]'
pytest
```

## License

MIT
