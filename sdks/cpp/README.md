# DominusNode C++ SDK

C++17 client for the **DominusNode relay network**: AI agents buy exit traffic per GB
and earn credits by running relay nodes. Implements [`sdks/SDK_SURFACE.md`](../SDK_SURFACE.md)
v2 (reference: `sdks/node` 2.0.1).

Dependencies: libcurl (>= 7.85), nlohmann-json (>= 3.11), OpenSSL libcrypto (SHA-256 for
the node PoW, random UUIDs). No signing key ever enters the SDK: EIP-191 signing is a callback.

## Install (release tarball)

The C++ SDK is not on a package registry. Each release attaches a source
tarball and its SHA-256 to the GitHub Release `sdk-cpp-v2.0.1`:

```bash
v=2.0.1
base=https://github.com/0xcircuitbreaker/DomiNode/releases/download/sdk-cpp-v$v
curl -fLO "$base/dominusnode-cpp-$v.tar.gz" -fLO "$base/dominusnode-cpp-$v.tar.gz.sha256"
sha256sum -c "dominusnode-cpp-$v.tar.gz.sha256"
tar xzf "dominusnode-cpp-$v.tar.gz"
cmake -S "dominusnode-cpp-$v" -B build && cmake --build build -j
```

or vendor it with CMake `FetchContent`:

```cmake
include(FetchContent)
FetchContent_Declare(dominusnode
  URL https://github.com/0xcircuitbreaker/DomiNode/releases/download/sdk-cpp-v2.0.1/dominusnode-cpp-2.0.1.tar.gz
  URL_HASH SHA256=<from dominusnode-cpp-2.0.1.tar.gz.sha256>)
FetchContent_MakeAvailable(dominusnode)
target_link_libraries(app PRIVATE dominusnode)
```

Defaults: API `https://api.dominusnode.daedalusdevelopmentgroup.com`, relay gateway
`proxy.dominusnode.daedalusdevelopmentgroup.com` (HTTP proxy :8080, SOCKS5 :1080). Both can be
overridden in the client configuration.

The tarball has no tests; `DOMINUSNODE_BUILD_TESTS` defaults to off there.
Downloads need the repository to be public (or a GitHub token for a private one).

## Build from the repository

```bash
sudo apt-get install -y libcurl4-openssl-dev nlohmann-json3-dev libssl-dev cmake g++
cmake -S . -B build && cmake --build build -j
cd build && ctest --output-on-failure
```

Link with `target_link_libraries(app PRIVATE dominusnode)`; include `<dominusnode/dominusnode.hpp>`.

## Quick start

```cpp
#include <dominusnode/dominusnode.hpp>
#include <cstdlib>
#include <iostream>

int main() {
    dominusnode::DominusNodeClient dn;
    dn.connect_with_key(std::getenv("DOMINUSNODE_API_KEY"));  // dn_live_...

    // GET/HEAD through the relay (https via CONNECT, TLS verified, 10 MB cap, no redirects)
    dominusnode::ProxyFetchOptions o;
    o.country = "US";
    o.ip_class = "residential";
    auto res = dn.proxy.fetch("https://example.com/", o);
    std::cout << res.status << " " << res.text().substr(0, 200) << "\n";

    // Or hand a proxy URL to any HTTP client. It CONTAINS your key: do not log it.
    dominusnode::ProxyRoutingOptions r;
    r.country = "DE";
    r.session_id = "job42";
    std::string url = dn.proxy.build_url(r);  // http://country-DE-session-job42:dn_live_...@proxy.dominusnode.daedalusdevelopmentgroup.com:8080

    // Prices come only from the server.
    std::cout << dn.network.pricing().dump(2) << "\n";
    dn.disconnect();  // logout + zeroize key and tokens
}
```

## Client

| Member | |
|---|---|
| `connect_with_key(key) -> ConnectResult{mfa_required, user_id}` | verify-key; MFA accounts keep only the key (agent routes + proxy work) |
| `disconnect()` | best-effort logout, then `secure_zero_string` on key and tokens |
| `is_connected()` | key or token held |

`ClientConfig`: `base_url`, `proxy_host`, `http_proxy_port`, `socks5_proxy_port`,
`access_token`, `refresh_token`, `transport` (inject a `std::function<HttpResponse(const HttpRequest&)>` in tests).

## Resources (15 / 71 methods)

| Member | Methods |
|---|---|
| `auth` | `verify_key`, `refresh`, `logout`, `me` |
| `wallet_auth` | `challenge`, `verify`, `sign_in(signer)`, `link` |
| `keys` | `create` (returns `Secret key`), `list`, `revoke` |
| `wallet` | `get_balance`, `get_transactions`, `get_forecast`, `top_up_crypto`, `get_crypto_status` |
| `agentic_wallets` | `create`, `list`, `get`, `fund`, `update_wallet_policy`, `transactions`, `freeze`, `unfreeze`, `delete_wallet` |
| `teams` | `create`, `list`, `get`, `update`, `delete_team`, `fund_wallet`, `get_transactions`, `list_members`, `add_member`, `update_member_role`, `remove_member`, `create_invite`, `list_invites`, `cancel_invite`, `accept_invite`, `create_key`, `list_keys`, `revoke_key` |
| `usage` | `get`, `get_daily`, `get_top_hosts`, `export_csv` |
| `sessions` | `get_active` (id/started_at/status only), `report` |
| `x402` | `get_info` |
| `network` | `policy`, `pricing`, `stats` |
| `nodes` | `register_challenge`, `register_node(signer, opts)`, `list`, `revoke`, `update_caps`, `tier` |
| `credits` | `balance`, `transactions`, `convert`, `withdraw(amount, signer)` |
| `payout_wallet` | `get`, `set(address, signer, chain, old_signer)` |
| `payouts` | `list` |
| `proxy` | `build_username`, `build_url`, `fetch`, `get_health`, `get_config` |

Most results are `nlohmann::json` mirroring the server body; credentials returned once
(`keys.create`, `teams.create_key`, `nodes.register_node`) come back as `Secret`
(`reveal()`, `prefix()`, prints and serialises as `[REDACTED]`).

## Signers and signed flows

```cpp
dominusnode::Signer signer{
    "0xYourLinkedWallet...",
    [&](const std::string& message) { return my_hsm_personal_sign(message); }  // 0x + 130 hex
};
auto node = dn.nodes.register_node(signer);         // challenge -> rebuild -> PoW -> sign -> POST
std::string node_key = node.node_key.reveal();       // store 0600
dn.payout_wallet.set("0xPayoutAddress...", signer);
auto w = dn.credits.withdraw("5000000", signer);     // µUSD as digit string or integer
```

For every signed flow the SDK rebuilds the message byte-for-byte (node attestation,
payout wallet, withdrawal) and throws `ProtocolError` **without calling the signer** if
the server's message differs, the server's `signer` is not your address, or the nonce is
malformed. A signer exception or malformed signature is also a `ProtocolError`.

## Money

- µUSD inputs (`MusdInput`): positive integer or digit string `^[1-9][0-9]{0,15}$`, sent as a string.
  convert 10,000..10,000,000,000; withdraw 1,000,000..100,000,000,000.
- Cents inputs are `int64_t`, `0 < x <= 2,147,483,647` (`>= 0` for agentic-wallet limits).

## Errors

`DominusNodeError` (`what()`, `status_code()`, `code()`, `details()`) with `ValidationError`
(400 / client-side `INVALID_ARGUMENT`), `AuthenticationError`, `InsufficientBalanceError`,
`AuthorizationError`, `NotFoundError`, `ConflictError`, `RateLimitError`
(`retry_after_seconds()`), `ServerError`, `NetworkError`, `ProtocolError`, `ProxyError`.
Every message is scrubbed of `dn_live_`/`dn_test_`/`dn_node_`/`dn_proxy_` keys and JWTs.

## HTTP behaviour

User-Agent `dominusnode-sdk-cpp/2.0.1`; 30 s timeout; `CURLOPT_FOLLOWLOCATION` 0 (a 3xx is an
error); TLS verification and TLS >= 1.2 set explicitly after every `curl_easy_reset()`;
10 MB cap by Content-Length and in the write callback; one 429 retry
(`min(Retry-After, 10 s)` ±10 %, floor 100 ms, 429 body not read); one forced JWT refresh
after a 401 (never for API-key auth); prototype-pollution keys stripped from JSON.

## proxy.fetch

GET/HEAD only; http(s) on ports 80/443; no userinfo; local names (`localhost`, `.local`,
`.internal`, `.arpa`, ...) and private literals in any IPv4/IPv6 spelling refused;
`http://` needs `allow_http`; all `getaddrinfo` results must be public (DNS-rebinding);
hop-by-hop and auth headers dropped, CR/LF/NUL refused; redirects returned, not followed;
body truncated at `max_bytes` (`truncated = true`). Username flags: `country-XX`
(OFAC CU/IR/KP/RU/SY refused), `class-residential|dc|mobile`, `session-<id>`,
`wallet-<uuid>`, `allowhttp-1`; none -> `relay`.

## Removed in 2.0

Plans, slots/waitlist, admin, Stripe/PayPal, email/password login and registration,
human MFA, agent-secret headers, `proxy.get_status`, `dc-`/`residential-`/`auto-` prefixes,
state/city/ASN targeting and all hardcoded prices.

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
