# DomiNode SuperAGI Toolkit

SuperAGI toolkit providing 22 tools for interacting with the DomiNode rotating proxy-as-a-service platform.

## Installation

```bash
pip install dominusnode-superagi
```

Or install from source:

```bash
cd integrations/superagi
pip install -e ".[dev]"
```

## Configuration

Set the following environment variables (or configure them in SuperAGI's tool configuration):

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOMINUSNODE_API_KEY` | Yes | -- | Your DomiNode API key (`dn_live_...` or `dn_test_...`) |
| `DOMINUSNODE_BASE_URL` | No | `https://api.dominusnode.com` | DomiNode REST API base URL |
| `DOMINUSNODE_PROXY_HOST` | No | `proxy.dominusnode.com` | DomiNode proxy gateway hostname |
| `DOMINUSNODE_PROXY_PORT` | No | `8080` | DomiNode proxy gateway port |

## Usage with SuperAGI

Register the toolkit in your SuperAGI agent:

```python
from dominusnode_superagi.toolkit import DominusNodeToolkit

# The toolkit registers itself with SuperAGI
toolkit = DominusNodeToolkit()
tools = toolkit.get_tools()  # Returns all 22 tool instances
env_keys = toolkit.get_env_keys()  # Config keys needed
```

## Available Tools (22)

### Proxy Operations
- **DomiNode Proxied Fetch** -- Fetch a URL through rotating proxies with geo-targeting
- **DomiNode Proxy Config** -- Get proxy endpoint configuration
- **DomiNode List Sessions** -- View active proxy sessions

### Wallet
- **DomiNode Check Balance** -- View wallet balance
- **DomiNode Check Usage** -- View usage statistics by period
- **DomiNode TopUp PayPal** -- Create a PayPal wallet top-up order

### Agentic Wallets
- **DomiNode Create Agentic Wallet** -- Create a sub-wallet with spending limit
- **DomiNode Fund Agentic Wallet** -- Transfer from main wallet
- **DomiNode Agentic Wallet Balance** -- Check sub-wallet balance
- **DomiNode List Agentic Wallets** -- List all sub-wallets
- **DomiNode Agentic Transactions** -- Transaction history
- **DomiNode Freeze Agentic Wallet** -- Temporarily halt spending
- **DomiNode Unfreeze Agentic Wallet** -- Re-enable spending
- **DomiNode Delete Agentic Wallet** -- Delete and refund balance

### Teams
- **DomiNode Create Team** -- Create team with shared wallet
- **DomiNode List Teams** -- List user's teams
- **DomiNode Team Details** -- Get team info
- **DomiNode Team Fund** -- Fund team wallet
- **DomiNode Team Create Key** -- Create team API key
- **DomiNode Team Usage** -- Team transaction history
- **DomiNode Update Team** -- Update team settings
- **DomiNode Update Team Member Role** -- Change member role

### Payments
- **DomiNode X402 Info** -- x402 micropayment protocol details

## Security

All tools include:
- SSRF prevention (private IP blocking, DNS rebinding protection, Teredo/6to4 IPv6 tunnel detection)
- OFAC sanctioned country blocking (CU, IR, KP, RU, SY)
- Credential scrubbing in error messages
- Prototype pollution prevention
- HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
- 10 MB response cap, redirect following disabled

## Testing

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## License

MIT
