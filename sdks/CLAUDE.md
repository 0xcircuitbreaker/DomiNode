# DomiNode SDKs

Team: **SDK**

6 SDKs providing client libraries for DomiNode API: Node.js, Python, C++, Rust, Go, Java.

## Team Responsibilities
- Maintain feature parity across all 6 SDKs
- Every new API endpoint needs SDK methods in ALL languages
- All SDKs must pass their language-specific test suites
- Security patterns (credential cleanup, input validation) must be consistent

## Cross-SDK Requirements
See `.claude/rules/sdk-patterns.md` for full rules.

The contract is `sdks/SDK_SURFACE.md` (v2, reference: `node/` 2.0.0): 15 resources,
71 methods — auth, walletAuth, keys, wallet, agenticWallets, teams (18), usage, sessions
(getActive + report), x402, network, nodes, credits, payoutWallet, payouts, proxy.
No plans, slots, admin, Stripe/PayPal, email/password or human MFA flows.
All must: validate amounts (cents and µUSD), URL-encode path params, redact secrets,
use signer callbacks and refuse mismatched server messages, detect MFA responses.

## SDK Directories
- `node/` — TypeScript, zero deps, dual CJS+ESM
- `python/` — Python 3.8+
- `cpp/` — C++17, libcurl
- `rust/` — Rust 2021 edition
- `go/` — Go 1.21+
- `java/` — Java 11+, Maven

## Common Mistakes
- Adding a method to one SDK but forgetting the other 5
- Signing a server-supplied message without rebuilding and comparing it locally
- Sending the JWT to /v1 routes (they need the raw dn_live_ key)
- Node SDK: nulling refreshFn in clear() breaks reconnection
- Rust: must call auth.logout() BEFORE token_manager.clear()
- C++: must re-enable TLS verification after curl_easy_reset()
