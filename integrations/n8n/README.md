# n8n-nodes-dominusnode

n8n community nodes for the [Dominus Node](https://dominusnode.com) rotating proxy-as-a-service platform.

## Installation

### Community Node (Recommended)

1. Go to **Settings** > **Community Nodes** in your n8n instance
2. Enter `n8n-nodes-dominusnode`
3. Click **Install**

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-dominusnode
```

## Credentials

Create a **Dominus Node API** credential with:

| Field | Description | Default |
|-------|-------------|---------|
| API Key | Your Dominus Node API key (`dn_live_...` or `dn_test_...`) | *(required)* |
| Base URL | Dominus Node API base URL | `https://api.dominusnode.com` |
| Proxy Host | Proxy gateway hostname | `proxy.dominusnode.com` |
| Proxy Port | Proxy gateway port | `8080` |

## Nodes

### Dominus Node Proxy

Make HTTP requests through Dominus Node's rotating proxy network.

**Operations:**
- **Proxied Fetch** -- Route HTTP requests through datacenter or residential proxies with geo-targeting
- **Get Proxy Config** -- Retrieve proxy endpoint configuration
- **List Active Sessions** -- List currently active proxy sessions

### Dominus Node Wallet

Manage your Dominus Node wallet, agentic sub-wallets, and teams.

**Operations:**
- **Check Balance** -- Get current wallet balance
- **Top Up (Stripe)** -- Create a Stripe checkout session
- **Top Up (Crypto)** -- Create a crypto invoice (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB)
- **Top Up (PayPal)** -- Create a PayPal checkout session
- **Create Agentic Wallet** -- Create a sub-wallet with spending limits for AI agents
- **Fund Agentic Wallet** -- Transfer funds to an agentic wallet
- **Get Agentic Wallet Balance** -- Check an agentic wallet's balance
- **List Agentic Wallets** -- List all agentic wallets
- **Get Agentic Transactions** -- Get transaction history
- **Freeze/Unfreeze/Delete Agentic Wallet** -- Lifecycle management
- **Create Team** -- Create a shared billing team
- **List Teams** / **Team Details** -- View teams
- **Fund Team** -- Fund a team wallet
- **Create Team Key** -- Create team API keys
- **Team Usage** -- View team transaction history
- **Update Team** / **Update Team Member Role** -- Team administration

### Dominus Node Usage

Check proxy usage statistics.

**Operations:**
- **Check Usage** -- Get bandwidth and cost statistics for a given period (day, week, month)

## Security

All nodes include comprehensive security measures:

- **SSRF Prevention**: Blocks private IPs, localhost, cloud metadata endpoints, hex/octal/decimal-encoded IPs, IPv4-mapped/compatible IPv6, Teredo tunneling, 6to4, CGNAT, multicast, and internal TLDs (.localhost, .local, .internal, .arpa)
- **DNS Rebinding Protection**: Resolves hostnames and validates all returned IPs before making proxy requests
- **OFAC Compliance**: Blocks geo-targeting to sanctioned countries (Cuba, Iran, North Korea, Russia, Syria)
- **Read-Only Methods**: Proxied fetch only allows GET, HEAD, and OPTIONS to prevent abuse
- **Credential Sanitization**: API keys are redacted from all error messages
- **Prototype Pollution Prevention**: All JSON responses are stripped of dangerous keys

## Pricing

| Pool Type | Price |
|-----------|-------|
| Datacenter | $3/GB |
| Residential | $5/GB |

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
