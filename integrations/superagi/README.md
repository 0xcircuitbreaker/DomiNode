# DominusNode for SuperAGI

Gives agents the DominusNode AI-agent relay network: fetch public web pages through exit IPs contributed by
other agents' nodes, pay per GB from a prepaid crypto wallet, and earn by contributing your own IP with the
node agent. Built on the official DominusNode SDK v2; HTTP, SSRF/DNS-rebinding protection, OFAC refusal and
credential scrubbing all come from the SDK.

## Install

```bash
pip install dominusnode-superagi
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DOMINUSNODE_API_KEY` | yes | Your `dn_live_` API key. Read from the environment/config only; never a tool argument, never in tool output. |
| `DOMINUSNODE_BASE_URL` | no | API base URL (default `https://api.dominusnode.com`). |
| `DOMINUSNODE_PROXY_HOST` | no | Gateway host (default `proxy.dominusnode.com`). |

## Usage

Add the toolkit to SuperAGI and set `DOMINUSNODE_API_KEY` in the toolkit configuration (it is a secret
config key). Programmatically:

```python
from dominusnode_superagi import DominusNodeToolkit

tools = DominusNodeToolkit().get_tools()   # 19 BaseTool instances
pricing = next(t for t in tools if t.name == "dominusnode_network_pricing")
print(pricing._execute())
```

Each tool returns a JSON string. Errors come back as `{"error": "..."}` with credentials scrubbed.

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
| 17 | `dominusnode_credits_convert` | Convert available node earnings into your own requester wallet balance (idempotent; returns the idempotency key). |
| 18 | `dominusnode_payouts_list` | Your USDC payouts of node earnings with status and transaction hash. |
| 19 | `dominusnode_x402_info` | x402 micropayment info: facilitators, networks and server-reported prices. |

Notes for agents:

- Prices are never hardcoded: call `network_pricing` for the live per-GB price by IP class (residential, dc, mobile).
- `fetch` is GET/HEAD only on ports 80/443, follows no redirects and caps bodies at 10 MB. Plaintext `http://`
  needs `allow_http` and is visible to the exit node.
- Routing: `country` (ISO code; sanctioned countries refused), `ip_class`, `session_id` (sticky exit).
- Signing flows (node register, withdraw, payout wallet) are deliberately not tools here; use the node agent CLI,
  the DominusNode MCP server, or the SDK with a signer key file.

## Testing

```bash
pip install -e ../../sdks/python -e '.[dev]'   # or npm install for the JS part
python -m pytest -q
```

## License

MIT
