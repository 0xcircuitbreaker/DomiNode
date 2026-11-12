# dominusnode -- Dominus Node Rust SDK (v2)

Async Rust client for the Dominus Node relay network, for AI agents. It
implements the language-neutral contract in `sdks/SDK_SURFACE.md` (reference:
`sdks/node`): 15 resources, 71 methods, plus `connect_with_key`, `disconnect`
and `is_connected`.

```bash
cargo add dominusnode@2
cargo add tokio --features full
```

Defaults: API `https://api.dominusnode.daedalusdevelopmentgroup.com`, relay gateway `proxy.dominusnode.daedalusdevelopmentgroup.com` (HTTP proxy :8080, SOCKS5 :1080). Both can be overridden in the client configuration.

or in `Cargo.toml`:

```toml
[dependencies]
dominusnode = "2"
tokio = { version = "1", features = ["full"] }
```

## Quick start

```rust
use dominusnode::{Config, DominusNodeClient, ProxyFetchOptions, ProxyRoutingOptions};

#[tokio::main]
async fn main() -> dominusnode::Result<()> {
    let dn = DominusNodeClient::new(Config::default())?;
    dn.connect_with_key(&std::env::var("DOMINUSNODE_API_KEY").unwrap()).await?;

    // Live prices come from the server; the SDK hardcodes none.
    let pricing = dn.network.pricing().await?;
    println!("{:?}", pricing.prices);

    // GET through the relay (https, CONNECT tunnel, end-to-end TLS).
    let opts = ProxyFetchOptions {
        routing: ProxyRoutingOptions { country: Some("US".into()), ..Default::default() },
        ..Default::default()
    };
    let res = dn.proxy.fetch("https://example.com", opts).await?;
    println!("{} ({} bytes)", res.status, res.body.len());

    dn.disconnect().await; // logout, then zeroize key + tokens
    Ok(())
}
```

## Resources

| Field | Methods |
|---|---|
| `auth` | `verify_key`, `refresh`, `logout`, `me` |
| `wallet_auth` | `challenge`, `verify`, `sign_in`, `link` |
| `keys` | `create`, `list`, `revoke` |
| `wallet` | `get_balance`, `get_transactions`, `get_forecast`, `top_up_crypto`, `get_crypto_status` |
| `agentic_wallets` | `create`, `list`, `get`, `fund`, `update_wallet_policy`, `transactions`, `freeze`, `unfreeze`, `delete` |
| `teams` | 18 methods: team CRUD, wallet, members, invites, keys |
| `usage` | `get`, `get_daily`, `get_top_hosts`, `export_csv` |
| `sessions` | `get_active`, `report` |
| `x402` | `get_info` |
| `network` | `policy`, `pricing`, `stats` |
| `nodes` | `register_challenge`, `register`, `list`, `revoke`, `update_caps`, `tier` |
| `credits` | `balance`, `transactions`, `convert`, `withdraw` |
| `payout_wallet` | `get`, `set` |
| `payouts` | `list` |
| `proxy` | `build_username`, `build_url`, `fetch`, `get_health`, `get_config` |

## Signers

The SDK has no crypto dependency. Signed flows (`wallet_auth.sign_in`,
`nodes.register`, `credits.withdraw`, `payout_wallet.set`) take a `&dyn Signer`
that performs EIP-191 `personal_sign`:

```rust
use dominusnode::FnSigner;
let signer = FnSigner::new("0xYourAddress…", |message: &str| {
    my_wallet.sign_personal(message).map_err(|e| e.to_string())
});
```

Implement the `Signer` trait directly for async signers (HSMs, remote wallets).
The SDK rebuilds every message it is asked to sign from values it knows and
refuses (`DominusNodeError::Protocol`) if the server's text differs, without
calling the signer.

## Money

- `*_cents` arguments: `i64`, `0 < x <= 2_147_483_647` (or `>= 0` for limits).
- µUSD amounts (`credits.convert`, `credits.withdraw`): anything `Into<Musd>`
  (integers or a digit string); sent as a decimal string.

## Security behaviour

- Redirects are never followed; responses are capped at 10 MB.
- 429: one retry after `min(Retry-After, 10 s)` ±10 %, floor 100 ms; the 429 body is dropped unread.
- 401 with a JWT: one singleton refresh and retry; refresh failure clears both tokens.
- `/v1` agent routes send the raw API key, never the JWT.
- `Secret` (new API/team/node keys), the client, `Config` and the token manager
  print and serialise as `[REDACTED]`; secrets are zeroized on drop.
- Error messages are scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.
- `proxy.build_url` returns a URL that CONTAINS the API key: do not log it.
- `proxy.fetch`: GET/HEAD only, ports 80/443, local names and private addresses
  refused (all IPv4 spellings, IPv6 incl. mapped/compatible/NAT64/Teredo/6to4),
  DNS-rebinding check over every resolved address, `http://` only with
  `allow_http`, OFAC countries (CU IR KP RU SY) refused.

## Errors

`DominusNodeError` variants: `Validation` (400 or client-side, code
`INVALID_ARGUMENT`), `Authentication`, `InsufficientBalance`, `Authorization`,
`NotFound`, `Conflict`, `RateLimit { retry_after_seconds }`, `Server`,
`Network`, `Protocol`, `Proxy`, `Api` (other statuses, e.g. a 3xx). Use
`.code()`, `.status_code()`, `.details()`.

## Testing

```bash
cargo test
cargo clippy --all-targets
```

Signed-message fixtures in `tests/fixtures/signed_messages.json` are generated
from the Node SDK builders by `tests/fixtures/gen_messages.mts`.

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
