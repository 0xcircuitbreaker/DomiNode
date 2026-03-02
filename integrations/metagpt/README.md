# dominusnode-metagpt

MetaGPT toolkit for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform. Provides 22 tools with Google-style docstrings for automatic schema extraction by MetaGPT's DataInterpreter and agent system.

## Installation

```bash
pip install dominusnode-metagpt
```

Or install from source:

```bash
cd integrations/metagpt
pip install -e ".[dev]"
```

## Environment Setup

Set your Dominus Node API key as an environment variable:

```bash
export DOMINUSNODE_API_KEY="dn_live_your_api_key_here"
```

Optionally configure the API base URL and proxy host:

```bash
export DOMINUSNODE_BASE_URL="https://api.dominusnode.com"
export DOMINUSNODE_PROXY_HOST="proxy.dominusnode.com"
export DOMINUSNODE_PROXY_PORT="8080"
```

## Quick Start

```python
from dominusnode_metagpt import DominusNodeToolkit

# Create toolkit (picks up DOMINUSNODE_API_KEY from environment)
toolkit = DominusNodeToolkit()

# Or pass the API key explicitly
toolkit = DominusNodeToolkit(api_key="dn_live_...")

# Check wallet balance
print(toolkit.check_balance())

# Fetch a URL through rotating proxies
print(toolkit.proxied_fetch(url="https://example.com", country="US"))

# Get all tool functions for MetaGPT registration
tools = toolkit.get_tool_functions()
for fn in tools:
    print(f"{fn.__name__}: {fn.__doc__.splitlines()[0]}")
```

## MetaGPT Integration

### With DataInterpreter

```python
from metagpt.tools.tool_registry import register_tool
from dominusnode_metagpt import DominusNodeToolkit

toolkit = DominusNodeToolkit(api_key="dn_live_...")

# Register all 22 tools with MetaGPT
for fn in toolkit.get_tool_functions():
    register_tool(fn)
```

### With Custom Agents

```python
from dominusnode_metagpt import DominusNodeToolkit

toolkit = DominusNodeToolkit(api_key="dn_live_...")

# Use tools directly in your agent logic
balance = toolkit.check_balance()
usage = toolkit.check_usage(period="week")
result = toolkit.proxied_fetch(url="https://example.com", proxy_type="dc")
```

## Tools (22 total)

### Proxy Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `proxied_fetch` | Fetch URL through rotating proxy | `url` |
| `get_proxy_config` | Get proxy configuration | - |
| `list_sessions` | List active proxy sessions | - |

### Wallet Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `check_balance` | Check wallet balance | - |
| `check_usage` | Check usage statistics | - |
| `topup_paypal` | Create PayPal top-up order | `amount_cents` |

### Agentic Wallet Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `create_agentic_wallet` | Create sub-wallet with spending limit | `label`, `spending_limit_cents` |
| `fund_agentic_wallet` | Fund agentic wallet from main wallet | `wallet_id`, `amount_cents` |
| `agentic_wallet_balance` | Check agentic wallet balance | `wallet_id` |
| `list_agentic_wallets` | List all agentic wallets | - |
| `agentic_transactions` | Get agentic wallet transactions | `wallet_id` |
| `freeze_agentic_wallet` | Freeze agentic wallet | `wallet_id` |
| `unfreeze_agentic_wallet` | Unfreeze agentic wallet | `wallet_id` |
| `delete_agentic_wallet` | Delete agentic wallet | `wallet_id` |

### Team Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `create_team` | Create team with shared wallet | `name` |
| `list_teams` | List all teams | - |
| `team_details` | Get team details | `team_id` |
| `team_fund` | Fund team wallet | `team_id`, `amount_cents` |
| `team_create_key` | Create team API key | `team_id`, `label` |
| `team_usage` | Get team usage history | `team_id` |
| `update_team` | Update team settings | `team_id` |
| `update_team_member_role` | Change member role | `team_id`, `user_id`, `role` |

### Payment Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `x402_info` | Get x402 micropayment info | - |

## Usage Examples

### Proxied Fetch with Geo-Targeting

```python
# Fetch through a US datacenter proxy ($3/GB)
result = toolkit.proxied_fetch(
    url="https://example.com",
    country="US",
    proxy_type="dc",
)

# Fetch through a German residential proxy ($5/GB)
result = toolkit.proxied_fetch(
    url="https://example.de",
    country="DE",
    proxy_type="residential",
)
```

### Agentic Wallet Management

```python
import json

# Create a sub-wallet for an AI agent with $10 spending limit
wallet = json.loads(toolkit.create_agentic_wallet(
    label="Research Agent",
    spending_limit_cents=1000,
))

# Fund it with $5 from main wallet
toolkit.fund_agentic_wallet(
    wallet_id=wallet["id"],
    amount_cents=500,
)

# Check balance
print(toolkit.agentic_wallet_balance(wallet_id=wallet["id"]))

# Freeze if needed
toolkit.freeze_agentic_wallet(wallet_id=wallet["id"])
```

### Team Management

```python
import json

# Create a team
team = json.loads(toolkit.create_team(name="Research Team", max_members=10))

# Fund the team wallet
toolkit.team_fund(team_id=team["id"], amount_cents=5000)

# Create a team API key
key = json.loads(toolkit.team_create_key(
    team_id=team["id"],
    label="Agent Key",
))
```

## Security

This toolkit includes comprehensive security measures:

- **SSRF Prevention**: Blocks requests to private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 0.0.0.0/8, 169.254.x, 100.64-127.x CGNAT, 224+ multicast), IPv6 loopback/ULA/link-local, IPv4-mapped/compatible IPv6, Teredo (2001:0000::/32), 6to4 (2002::/16), hex/octal/decimal encoded IPs
- **DNS Rebinding Protection**: Resolves hostnames and validates all IP addresses before connecting
- **TLD Blocking**: .localhost, .local, .internal, .arpa
- **Credential Protection**: Embedded URL credentials blocked; API keys scrubbed from all error output
- **OFAC Compliance**: Cuba, Iran, North Korea, Russia, Syria blocked for geo-targeting
- **HTTP Method Restriction**: Only GET, HEAD, OPTIONS allowed through proxy
- **Prototype Pollution Prevention**: Dangerous keys stripped from all JSON responses
- **Response Limits**: 10 MB body cap, 4000 char truncation for LLM context
- **Redirect Disabled**: No redirect following to prevent open redirect abuse

## Running Tests

```bash
cd integrations/metagpt
pip install -e ".[dev]"
pytest tests/ -v
```

## License

MIT
