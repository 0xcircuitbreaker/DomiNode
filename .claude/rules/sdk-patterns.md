# SDK Patterns

These rules apply when working on any of the 6 SDKs (sdks/node, sdks/python, sdks/rust, sdks/go, sdks/java, sdks/cpp).

## Cross-SDK Requirements

- Source of truth: `sdks/SDK_SURFACE.md` (v2). All SDKs expose its 15 resources / 71 methods
- Required: auth, walletAuth, keys, wallet (crypto top-up only), agenticWallets, teams (18 incl. revokeKey), usage, sessions (getActive + report), x402, network, nodes, credits, payoutWallet, payouts, proxy
- Removed: plans, slots/waitlist, admin, Stripe/PayPal, email/password + human MFA flows, dc-/residential- prefixes, hardcoded prices
- /v1 routes authenticate with the raw API key (agent mode); /api routes with the JWT
- Signed flows (node register, withdraw, payout wallet) take a caller signer callback; SDK rebuilds the message and refuses (ProtocolError) if the server text differs, before calling the signer
- One-time secrets (API key, team key, dn_node_ key) returned in a redacting Secret wrapper
- proxy.fetch: GET/HEAD only, ports 80/443, SSRF + DNS-rebinding (all resolved addresses), no redirects, 10MB cap, http:// needs allowHttp
- Error messages scrubbed of dn_live_/dn_test_/dn_node_/dn_proxy_ and JWTs
- All SDK HTTP clients: disable auto-redirects, cap response 10MB, zeroize credentials on disconnect
- All SDKs ActiveSession types must NOT include proxy_ip (upstream infra detail)
- SDK 429 retry: cap wait (10s), add +/-10% jitter, enforce 100ms min; CANCEL body stream
- SDK Disconnect() must clear ALL credential fields (API key + tokens + email + password)
- amountCents: validate 0 < amountCents <= 2,147,483,647 client-side in all fund/topUp methods; µUSD amounts as bigint/digit string, sent as strings
- URL path params: always URL-encode (Python quote, Go PathEscape, Rust encode_uri_component, C++ url_encode, Java URLEncoder)
- EIP-191 signature validation: 0x + 130 hex = 132 chars, max 200 chars
- Token redaction in all output paths (repr, Debug, String, MarshalJSON, operator<<)
- verify() must detect MFA response (mfaRequired:true) and surface it

## Language-Specific

- **Node.js**: zero deps, dual CJS+ESM, module: "Node16" + moduleResolution: "Node16"; TokenManager.clear() must NOT null refreshFn
- **C++**: explicit TLS verification after curl_easy_reset(); secure_zero_string() on disconnect
- **Rust**: auth.logout() BEFORE token_manager.clear() + zeroize stored api_key
- **Python**: NaN/Infinity guards on numeric inputs
- **Go**: MarshalJSON redaction for sensitive fields
- **Java**: distributionManagement for GitHub Packages in pom.xml
