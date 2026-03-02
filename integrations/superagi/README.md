# Dominus Node SuperAGI Toolkit

SuperAGI toolkit providing 22 tools for interacting with the Dominus Node rotating proxy-as-a-service platform.

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
| `DOMINUSNODE_API_KEY` | Yes | -- | Your Dominus Node API key (`dn_live_...` or `dn_test_...`) |
| `DOMINUSNODE_BASE_URL` | No | `https://api.dominusnode.com` | Dominus Node REST API base URL |
| `DOMINUSNODE_PROXY_HOST` | No | `proxy.dominusnode.com` | Dominus Node proxy gateway hostname |
| `DOMINUSNODE_PROXY_PORT` | No | `8080` | Dominus Node proxy gateway port |

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
- **Dominus Node Proxied Fetch** -- Fetch a URL through rotating proxies with geo-targeting
- **Dominus Node Proxy Config** -- Get proxy endpoint configuration
- **Dominus Node List Sessions** -- View active proxy sessions

### Wallet
- **Dominus Node Check Balance** -- View wallet balance
- **Dominus Node Check Usage** -- View usage statistics by period
- **Dominus Node TopUp PayPal** -- Create a PayPal wallet top-up order

### Agentic Wallets
- **Dominus Node Create Agentic Wallet** -- Create a sub-wallet with spending limit
- **Dominus Node Fund Agentic Wallet** -- Transfer from main wallet
- **Dominus Node Agentic Wallet Balance** -- Check sub-wallet balance
- **Dominus Node List Agentic Wallets** -- List all sub-wallets
- **Dominus Node Agentic Transactions** -- Transaction history
- **Dominus Node Freeze Agentic Wallet** -- Temporarily halt spending
- **Dominus Node Unfreeze Agentic Wallet** -- Re-enable spending
- **Dominus Node Delete Agentic Wallet** -- Delete and refund balance

### Teams
- **Dominus Node Create Team** -- Create team with shared wallet
- **Dominus Node List Teams** -- List user's teams
- **Dominus Node Team Details** -- Get team info
- **Dominus Node Team Fund** -- Fund team wallet
- **Dominus Node Team Create Key** -- Create team API key
- **Dominus Node Team Usage** -- Team transaction history
- **Dominus Node Update Team** -- Update team settings
- **Dominus Node Update Team Member Role** -- Change member role

### Payments
- **Dominus Node X402 Info** -- x402 micropayment protocol details

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
