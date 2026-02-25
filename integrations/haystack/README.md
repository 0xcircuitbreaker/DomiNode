# dominusnode-haystack

DomiNode rotating proxy tools for [Haystack](https://haystack.deepset.ai/) AI pipelines.

## Installation

```bash
pip install dominusnode-haystack
```

## Quick Start

```python
from dominusnode_haystack import DominusNodeToolkit

# Initialize with your API key
toolkit = DominusNodeToolkit(api_key="dn_live_...")

# Get Haystack Tool objects for use in pipelines
tools = toolkit.get_tools()

# Or call methods directly
balance = toolkit.check_balance()
print(balance)  # {"balanceCents": 5000}
```

## Usage with Haystack Pipelines

```python
from haystack import Pipeline
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.components.tools import ToolInvoker
from dominusnode_haystack import DominusNodeToolkit

toolkit = DominusNodeToolkit(api_key="dn_live_...")
tools = toolkit.get_tools()

pipeline = Pipeline()
pipeline.add_component("llm", OpenAIChatGenerator(tools=tools))
pipeline.add_component("tool_invoker", ToolInvoker(tools=tools))
pipeline.connect("llm.replies", "tool_invoker.messages")
```

## Available Tools (22)

| Tool | Description |
|------|-------------|
| `dominusnode_proxied_fetch` | Fetch a URL through rotating proxy network |
| `dominusnode_check_balance` | Check wallet balance |
| `dominusnode_check_usage` | Check proxy usage statistics |
| `dominusnode_get_proxy_config` | Get proxy configuration |
| `dominusnode_list_sessions` | List active proxy sessions |
| `dominusnode_create_agentic_wallet` | Create an agentic sub-wallet |
| `dominusnode_fund_agentic_wallet` | Fund an agentic wallet |
| `dominusnode_agentic_wallet_balance` | Check agentic wallet balance |
| `dominusnode_list_agentic_wallets` | List all agentic wallets |
| `dominusnode_agentic_transactions` | Get agentic wallet transactions |
| `dominusnode_freeze_agentic_wallet` | Freeze an agentic wallet |
| `dominusnode_unfreeze_agentic_wallet` | Unfreeze an agentic wallet |
| `dominusnode_delete_agentic_wallet` | Delete an agentic wallet |
| `dominusnode_create_team` | Create a team |
| `dominusnode_list_teams` | List teams |
| `dominusnode_team_details` | Get team details |
| `dominusnode_team_fund` | Fund a team wallet |
| `dominusnode_team_create_key` | Create a team API key |
| `dominusnode_team_usage` | Get team usage history |
| `dominusnode_update_team` | Update team settings |
| `dominusnode_update_team_member_role` | Update team member role |
| `dominusnode_x402_info` | Get x402 micropayment info |
| `dominusnode_topup_paypal` | Create PayPal top-up order |

## Configuration

```python
toolkit = DominusNodeToolkit(
    api_key="dn_live_...",                    # or set DOMINUSNODE_API_KEY env var
    base_url="https://api.dominusnode.com",   # API base URL
    proxy_host="proxy.dominusnode.com",       # or set DOMINUSNODE_PROXY_HOST
    proxy_port=8080,                          # or set DOMINUSNODE_PROXY_PORT
    timeout=30.0,                             # HTTP timeout in seconds
)
```

## Security

- Full SSRF prevention (private IPs, DNS rebinding, Teredo/6to4, hex/octal)
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Credential scrubbing in all error outputs
- Prototype pollution prevention
- HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
- 10 MB response cap with 4000 char truncation
- Redirect following disabled

## License

MIT
