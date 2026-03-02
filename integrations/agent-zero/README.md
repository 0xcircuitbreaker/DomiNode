# Dominus Node Agent Zero Integration

22 tools for [Agent Zero](https://github.com/frdel/agent-zero) providing
proxy, wallet, agentic wallet, and team management capabilities through
the Dominus Node rotating proxy network.

## Installation

```bash
pip install dominusnode-agent-zero
```

Or install from source:

```bash
cd integrations/agent-zero
pip install -e ".[dev]"
```

## Configuration

Set the following environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMINUSNODE_API_KEY` | Yes | -- | Your Dominus Node API key (`dn_live_...`) |
| `DOMINUSNODE_BASE_URL` | No | `https://api.dominusnode.com` | REST API base URL |
| `DOMINUSNODE_PROXY_HOST` | No | `proxy.dominusnode.com` | Proxy gateway hostname |
| `DOMINUSNODE_PROXY_PORT` | No | `8080` | Proxy gateway port |

## Tool Modules

### `01_proxy_fetch` -- Proxy & Fetch (3 tools)

| Tool | Description |
|------|-------------|
| `proxied_fetch` | Fetch a URL through the Dominus Node proxy (HTTPS CONNECT tunnel) |
| `get_proxy_config` | Get proxy endpoints, supported countries, geo-targeting |
| `list_sessions` | List active proxy sessions with byte transfer stats |

### `02_wallet` -- Wallet & Billing (3 tools)

| Tool | Description |
|------|-------------|
| `check_balance` | Get current wallet balance in cents and USD |
| `check_usage` | Get bandwidth, cost, and request stats for a time period |
| `topup_paypal` | Create a PayPal checkout session to add wallet funds |

### `03_agentic_wallets` -- Sub-Wallets (8 tools)

| Tool | Description |
|------|-------------|
| `create_agentic_wallet` | Create a sub-wallet with label and spending limit |
| `fund_agentic_wallet` | Transfer funds from main wallet to sub-wallet |
| `agentic_wallet_balance` | Check a sub-wallet's balance and status |
| `list_agentic_wallets` | List all sub-wallets |
| `agentic_transactions` | Get transaction history for a sub-wallet |
| `freeze_agentic_wallet` | Freeze a sub-wallet to pause spending |
| `unfreeze_agentic_wallet` | Unfreeze a frozen sub-wallet |
| `delete_agentic_wallet` | Delete a sub-wallet (refunds remaining balance) |

### `04_teams` -- Team Management (8 tools)

| Tool | Description |
|------|-------------|
| `create_team` | Create a new team with shared wallet |
| `list_teams` | List all teams the user belongs to |
| `team_details` | Get team details including members and wallet |
| `team_fund` | Transfer funds from personal to team wallet |
| `team_create_key` | Create a team API key (bills to team wallet) |
| `team_usage` | Get team wallet transaction history |
| `update_team` | Update team name or member limit |
| `update_team_member_role` | Change a member's role (admin/member) |

## Usage with Agent Zero

Each tool module exports a `TOOLS` dictionary that Agent Zero can load
directly. Tools follow the `(auth, args) -> str` calling convention
where `auth` is a `DominusNodeAuth` instance and `args` is a dictionary
of tool arguments.

```python
from shared.auth import DominusNodeAuth
from tools.01_proxy_fetch import proxied_fetch

auth = DominusNodeAuth(api_key="dn_live_...")
result = proxied_fetch(auth, {
    "url": "https://httpbin.org/ip",
    "proxy_type": "dc",
    "country": "US",
})
print(result)
```

## Security

- **SSRF prevention**: All URLs validated for private IPs, hex/octal encoding,
  DNS rebinding, embedded credentials, and blocked TLDs (.localhost, .local,
  .internal, .arpa).
- **OFAC compliance**: Proxy traffic to Cuba, Iran, North Korea, Russia, and
  Syria is blocked.
- **Read-only HTTP methods**: Only GET, HEAD, and OPTIONS are permitted through
  the proxied fetch tool.
- **Credential scrubbing**: API keys (`dn_live_*`, `dn_test_*`) are removed
  from all error messages.
- **Prototype pollution prevention**: All JSON responses are stripped of
  `__proto__`, `constructor`, and `prototype` keys.
- **No redirect following**: All HTTP clients use `follow_redirects=False` to
  prevent open redirect abuse.
- **Response size limits**: 10 MB max response body, 4000 char truncation for
  AI context.

## Testing

```bash
cd integrations/agent-zero
pip install -e ".[dev]"
pytest tests/ -v
```

## License

MIT -- see [LICENSE](LICENSE).
