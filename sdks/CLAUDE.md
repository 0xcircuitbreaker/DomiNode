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

Key: All SDKs have AgenticWalletResource, TeamsResource (18 methods), WalletAuth.
All must: validate amountCents, URL-encode path params, redact tokens, detect MFA responses.

## SDK Directories
- `node/` — TypeScript, zero deps, dual CJS+ESM
- `python/` — Python 3.8+
- `cpp/` — C++17, libcurl
- `rust/` — Rust 2021 edition
- `go/` — Go 1.21+
- `java/` — Java 11+, Maven

## Common Mistakes
- Adding a method to one SDK but forgetting the other 5
- Node SDK: nulling refreshFn in clear() breaks reconnection
- Rust: must call auth.logout() BEFORE token_manager.clear()
- C++: must re-enable TLS verification after curl_easy_reset()
