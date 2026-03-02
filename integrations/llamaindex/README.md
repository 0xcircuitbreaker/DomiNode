# dominusnode-llamaindex

LlamaIndex integration for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Provides 22 tools covering proxy operations, wallet management, agentic wallets, team management, and PayPal top-ups.

## Installation

```bash
pip install dominusnode-llamaindex
```

## Quick Start

```python
from dominusnode_llamaindex import DominusNodeToolSpec

# Create the tool spec (authenticates via API key)
spec = DominusNodeToolSpec(
    api_key="dn_live_abc123",  # or set DOMINUSNODE_API_KEY env var
    base_url="https://api.dominusnode.com",
)

# Convert to LlamaIndex tools
tools = spec.to_tool_list()

# Use with a LlamaIndex agent
from llama_index.core.agent import ReActAgent
from llama_index.llms.openai import OpenAI

llm = OpenAI(model="gpt-4")
agent = ReActAgent.from_tools(tools, llm=llm, verbose=True)

response = agent.chat("Check my proxy balance and fetch https://example.com through a US datacenter proxy")
print(response)
```

## Available Tools (22)

### Proxy Operations
| Tool | Description |
|------|-------------|
| `proxied_fetch` | Fetch a URL through the Dominus Node proxy (GET/HEAD/OPTIONS, geo-targeting, dc/residential) |
| `check_balance` | Check wallet balance in USD and cents |
| `check_usage` | View bandwidth usage stats for a time period (day/week/month) |
| `get_proxy_config` | Get proxy endpoints, supported countries, and geo-targeting features |
| `list_sessions` | List currently active proxy sessions |

### Agentic Wallets
| Tool | Description |
|------|-------------|
| `create_agentic_wallet` | Create a sub-wallet with a spending limit for AI agents |
| `fund_agentic_wallet` | Transfer funds from main wallet to an agentic wallet |
| `agentic_wallet_balance` | Check an agentic wallet's balance and configuration |
| `list_agentic_wallets` | List all agentic wallets |
| `agentic_transactions` | View transaction history for an agentic wallet |
| `freeze_agentic_wallet` | Freeze a wallet to prevent spending |
| `unfreeze_agentic_wallet` | Unfreeze a wallet to allow spending |
| `delete_agentic_wallet` | Delete a wallet (refunds remaining balance) |

### Team Management
| Tool | Description |
|------|-------------|
| `create_team` | Create a team with a shared billing wallet |
| `list_teams` | List teams you belong to |
| `team_details` | Get full team details (members, wallet, keys) |
| `team_fund` | Fund a team wallet from your personal wallet |
| `team_create_key` | Create an API key scoped to a team |
| `team_usage` | View team wallet transaction history |
| `update_team` | Update team name or member limit |
| `update_team_member_role` | Change a member's role (admin/member) |

### Payments
| Tool | Description |
|------|-------------|
| `topup_paypal` | Create a PayPal order for wallet top-up ($1-$10,000) |

## Configuration

| Parameter | Environment Variable | Default |
|-----------|---------------------|---------|
| `api_key` | `DOMINUSNODE_API_KEY` | (required) |
| `base_url` | `DOMINUSNODE_BASE_URL` | `https://api.dominusnode.com` |
| `proxy_host` | `DOMINUSNODE_PROXY_HOST` | `proxy.dominusnode.com` |
| `proxy_port` | `DOMINUSNODE_PROXY_PORT` | `8080` |

## Security

- **SSRF Prevention**: Blocks private IPs (RFC 1918, CGNAT, multicast), hex/octal/decimal encoding, DNS rebinding, .localhost/.local/.internal/.arpa, embedded credentials, IPv6 zone IDs, IPv4-mapped/compatible IPv6, Teredo, 6to4
- **HTTP Methods**: Only GET, HEAD, OPTIONS allowed for proxied fetch (no mutating requests)
- **OFAC Compliance**: Blocks geo-targeting to CU, IR, KP, RU, SY
- **Credential Scrubbing**: API keys are never exposed in error messages or tool outputs
- **Prototype Pollution**: Strips `__proto__`, `constructor`, `prototype` keys from JSON responses
- **Response Limits**: 4,000 char body truncation, 10 MB size cap, 30s timeout
- **Redirect Following**: Disabled to prevent open redirect abuse

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/ -v
```

## License

MIT
