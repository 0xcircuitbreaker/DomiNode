# dominusnode — DominusNode Python SDK (v2)

Python client for the DominusNode AI-agent relay network: proxy through relay nodes,
register your own nodes, earn credits and withdraw payouts. It implements
[`sdks/SDK_SURFACE.md`](../SDK_SURFACE.md) (15 resources, 71 methods), with the Node SDK as
the reference implementation.

- Sync `DominusNodeClient` and asyncio `AsyncDominusNodeClient` with the same methods
- One dependency (`httpx`), no crypto dependency: you sign through a callback
- Python 3.9+, type hints, PEP 561

```bash
pip install dominusnode
```

Defaults: API `https://api.dominusnode.com`, relay gateway `proxy.dominusnode.com` (TLS to the gateway's HTTPS proxy on :8443 by default since 2.2; SOCKS5 :1080). Production gateways refuse credentials on plaintext 8080/1080. A self-hosted coordinator publishes its TLS proxy on 8444: `gateway_tls={"port": 8444}`. Plaintext 8080 for local development: `gateway_tls=False`. A refused CONNECT carries the gateway's `X-DominusNode-Error` code (e.g. INSUFFICIENT_BALANCE, NO_NODES_AVAILABLE) in `err.code` / `err.retry_after`. Both can be overridden in the client configuration.

## Quick start

```python
import os
from dominusnode import DominusNodeClient

with DominusNodeClient() as dn:
    dn.connect_with_key(os.environ["DOMINUSNODE_API_KEY"])  # dn_live_... / dn_test_...

    print(dn.network.pricing())       # live per-GB prices (µUSD); the SDK hardcodes no prices
    res = dn.proxy.fetch("https://example.com", country="US", ip_class="residential")
    print(res.status, res.text()[:200])
```

Async:

```python
from dominusnode import AsyncDominusNodeClient

async with AsyncDominusNodeClient() as dn:
    await dn.connect_with_key(key)
    stats = await dn.network.stats()
```

## Proxy

Routing flags go in the proxy **username**, the API key in the **password**:

```python
dn.proxy.build_username(country="DE", session_id="abc123")  # "country-DE-session-abc123"
url = dn.proxy.build_url(country="US", ip_class="dc")        # https://country-US-class-dc:<key>@proxy.dominusnode.com:8443
```

`build_url` returns a URL that **contains your API key: do not log it.**

Flags: `country` (ISO-2; OFAC countries CU IR KP RU SY are refused), `ip_class`
(`residential`/`dc`/`mobile`/`masked`; masked = VPN/WARP/Tor exits, cheapest, opt-in), `session_id` (sticky, 1-64 alphanumerics),
`agentic_wallet_id` (UUID, spend from an agentic wallet), `allow_http` (`allowhttp-1`).
With no flags the username is `relay`.

`proxy.fetch(url, ...)` sends GET or HEAD only. Before it opens a connection it checks the
URL: http(s) only, ports 80/443, no userinfo, no local or private hosts, including
decimal/hex/octal IPv4 forms and IPv6 forms that embed IPv4. It then resolves the hostname
and refuses it if *any* address is private (DNS-rebinding check). https goes through a
CONNECT tunnel with full TLS verification; `http://` needs `allow_http=True`. Redirects are
returned as they are, not followed, and the body is capped at 10 MB (`truncated=True` when
cut).

## Signers (EIP-191)

Node registration, withdrawals, payout-wallet changes and wallet sign-in need a signature from
your wallet. Pass any object with an `address` and a `sign_message(message) -> "0x…"` method that
performs `personal_sign`:

```python
from eth_account import Account
from eth_account.messages import encode_defunct

acct = Account.from_key(private_key)

class Signer:
    address = acct.address
    def sign_message(self, message: str) -> str:
        sig = acct.sign_message(encode_defunct(text=message)).signature.hex()
        return sig if sig.startswith("0x") else "0x" + sig
```

With `AsyncDominusNodeClient`, `sign_message` may be `async def`.

The SDK never signs a server string without checking it. For every signed flow it builds the
expected message itself and compares it byte for byte with the server's. If they differ, it
raises `ProtocolError` and the signer is never called.

```python
node = dn.nodes.register(signer, node_pubkey=ed25519_pub_hex, max_streams=8)
node_key = node["nodeKey"].reveal()       # Secret, shown once

dn.payout_wallet.set("0xYourPayoutAddress", signer)               # first set
dn.payout_wallet.set("0xNew...", signer, old_wallet_signer=old)   # change: old wallet co-signs

r = dn.credits.withdraw(5_000_000, signer)   # µUSD (int or digit string, never float); $5
r["idempotencyKey"]                          # reuse it to retry safely
```

## Money

- Server money values are `{"musd": "<integer µUSD>", "usd": "<6 decimals>"}`; 1 USD = 1,000,000 µUSD.
- µUSD inputs accept an `int` or a digit string and are sent as decimal strings. Floats, NaN and Infinity are rejected.
- `*_cents` inputs are integers with `0 < x <= 2,147,483,647`, checked before any request is sent.

## Resources

| Resource | Methods |
|---|---|
| `auth` | `verify_key`, `refresh`, `logout`, `me` |
| `wallet_auth` | `challenge`, `verify`, `sign_in`, `link` |
| `keys` | `create`, `list`, `revoke` |
| `wallet` | `get_balance`, `get_transactions`, `get_forecast`, `top_up_crypto`, `get_crypto_status` |
| `agentic_wallets` | `create`, `list`, `get`, `fund`, `update_wallet_policy`, `transactions`, `freeze`, `unfreeze`, `delete` |
| `teams` | 18 methods: team CRUD, wallet, members, invites, keys (`create_key` … `revoke_key`) |
| `usage` | `get`, `get_daily`, `get_top_hosts`, `export_csv` (`from_`/`to` -> `since`/`until`) |
| `sessions` | `get_active` (id, startedAt and status only; never IPs), `report` |
| `x402` | `get_info` |
| `network` | `policy`, `pricing`, `stats` |
| `nodes` | `register_challenge`, `register`, `list`, `revoke`, `update_caps`, `tier` |
| `credits` | `balance`, `transactions`, `convert`, `withdraw` |
| `payout_wallet` | `get`, `set` |
| `payouts` | `list` |
| `proxy` | `build_username`, `build_url`, `fetch`, `get_health`, `get_config` |

Client members: `connect_with_key(api_key)` (returns `{"mfaRequired": bool, "userId"?}`),
`disconnect()` and `is_connected`. Results are the server's JSON as dicts with camelCase keys.

Not in the SDK: plans, slots, admin, Stripe and PayPal top-ups, email/password and human MFA.
Use the dashboard for those.

## Errors

`DominusNodeError` (`message`, `status_code`, `code`, `details`) and its subclasses:
`ValidationError` (HTTP 400, and client-side checks with `code="INVALID_ARGUMENT"`),
`AuthenticationError`, `InsufficientBalanceError`, `AuthorizationError`, `NotFoundError`,
`ConflictError`, `RateLimitError` (`retry_after_seconds`), `ServerError`, `NetworkError`,
`ProtocolError`, `ProxyError`. Error messages are scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/
`dn_proxy_` keys and JWTs.

## Security behaviour

- Redirects are never followed. API responses are capped at 10 MB.
- On 429 the SDK retries once, waiting `min(Retry-After, 10 s)` ±10 % (at least 100 ms).
- On 401 it refreshes the JWT once. `/v1` routes send the raw API key and are not refreshed.
- `Secret` (new API keys, team keys, node keys) prints and serialises as `[REDACTED]`. Use `json.dumps(obj, default=dominusnode.json_default)`.
- `disconnect()` logs out (best effort), then clears the API key and both tokens.

## Development

```bash
pip install -e '.[dev]'
pytest
```

`tests/fixtures/signed_messages.json` holds the three signed messages as produced by the Node
SDK builders. `tests/test_signers.py` checks the Python builders against it byte for byte.

## Node registration and the client IP

The node-registration proof-of-work is bound to the client IP that requested it.
Call the register-challenge and register methods from the same egress (same machine,
same outbound IP, no proxy or VPN switch in between); otherwise the server rejects
the solution with `INVALID_CHALLENGE`. Register from the host that will run the node.

## Troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| HTTP 402 | API call: requester or agentic wallet balance is too low | Top up with crypto or fund the agentic wallet |
| HTTP 407 (proxy) | Gateway rejected the proxy credentials | Check the API key in the proxy password and the username flags (`country-XX-class-dc-...`, or `relay`) |
| `EMAIL_NOT_VERIFIED` | The route needs a verified account | Verify the account before financial calls |
| `NO_NODES_AVAILABLE` | No eligible exit node for the requested country/class | Relax the country/class flags or retry later; check network stats |
| `PAYOUTS_DISABLED` | Withdrawals are switched off server-side | Keep earning; the credits balance `payoutsEnabled` field shows the state |
| `REPORT_LIMIT` | Per-node daily session-report cap reached (HTTP 409 conflict error; older servers 429) | Do not retry today; the SDK never retries it |
